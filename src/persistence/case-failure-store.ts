/**
 * Records case-detail fetches that failed, so they can be retried later.
 *
 * `PendingStore.dequeue()` is called once a case's detail fetch has been
 * *attempted*, success or failure alike (see that module's comment) - a row
 * whose fetch threw (e.g. `UnexpectedDetailPageError`, PROBLEMS.md §6's
 * "server error looks like a sealed case" finding, or a `RateLimitError`
 * that exhausted its retries) would otherwise leave the case with **no**
 * record anywhere: not in `CaseStore` (nothing to store, the fetch failed),
 * not in `PendingStore` (already dequeued, so it never resurfaces on
 * resume), and not in any failure ledger either, since only document
 * downloads had one before this store existed. This closes that gap with
 * the same failure/success/latest-wins semantics `FailedDocumentStore`
 * already has for documents, both built on the shared `FailureLedger`.
 *
 * Written to `data/failed-cases.ndjson`.
 */

import { join } from 'node:path';

import { FailureLedger, type FailureRecord } from './failure-ledger.js';

export const FAILED_CASES_FILE = 'failed-cases.ndjson';

/** Everything a retry needs: the `ca` detail token (PROBLEMS.md §6: does not expire). */
export interface CaseFailureDetail {
  caseNumber: string;
  ca: string;
}

/** One failed case-detail fetch attempt, flattened for callers (mirrors `FailedDocumentRecord`). */
export interface CaseFailureRecord {
  caseNumber: string;
  ca: string;
  reason: string;
  httpStatus?: number;
  attempt: number;
  retryable: boolean;
  recordedAt: string;
}

function toCaseFailureRecord(record: FailureRecord<CaseFailureDetail>): CaseFailureRecord {
  return {
    caseNumber: record.detail.caseNumber,
    ca: record.detail.ca,
    reason: record.reason,
    ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
    attempt: record.attempt,
    retryable: record.retryable,
    recordedAt: record.recordedAt,
  };
}

export class CaseFailureStore {
  private readonly ledger: FailureLedger<CaseFailureDetail>;

  constructor(dataDir: string) {
    this.ledger = new FailureLedger(join(dataDir, FAILED_CASES_FILE));
  }

  /** Records one failed detail-fetch attempt for later retry. */
  async recordFailure(input: {
    caseNumber: string;
    ca: string;
    reason: string;
    httpStatus?: number;
    attempt: number;
    retryable: boolean;
  }): Promise<void> {
    await this.ledger.recordFailure({
      key: input.caseNumber,
      reason: input.reason,
      ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
      attempt: input.attempt,
      retryable: input.retryable,
      detail: { caseNumber: input.caseNumber, ca: input.ca },
    });
  }

  /** Records that a previously-failed case's detail has since been fetched successfully. */
  async recordSuccess(caseNumber: string): Promise<void> {
    await this.ledger.recordSuccess(caseNumber);
  }

  /** Cases currently worth retrying (latest record per case, only if still `retryable`). */
  async listRetryable(): Promise<CaseFailureRecord[]> {
    const records = await this.ledger.listRetryable();
    return records.map(toCaseFailureRecord);
  }
}
