/**
 * A generic append-only failure/success ledger, keyed by an arbitrary string.
 *
 * Originally written as `FailedDocumentStore` for document downloads only
 * (the brief's explicit ask). Generalised after review found a second,
 * silent gap: a case whose *detail fetch itself* fails (e.g.
 * `UnexpectedDetailPageError` - PROBLEMS.md §6) was dequeued from
 * `PendingStore` on the attempt (by design - see that module's comment) but
 * had nowhere to land, since only document downloads had a failure record.
 * A case detail failure and a document download failure are the same shape
 * of problem - "this thing was tried, it broke, here is why, can it be
 * retried" - keyed by a different kind of string (a bare case number vs.
 * `caseNumber::documentId`), so one generic ledger now backs both instead of
 * duplicating the failure/success/latest-wins logic a second time.
 *
 * Same append-only rationale as every other store here (see
 * `ndjson-log.ts`): a `failure` and the `success` that later clears it must
 * never be able to corrupt each other by landing in the same whole-file
 * rewrite.
 */

import { appendLine, readLines } from './ndjson-log.js';

/** One failed attempt at whatever this ledger's key identifies. */
export interface FailureRecord<TDetail> {
  type: 'failure';
  key: string;
  reason: string;
  httpStatus?: number;
  attempt: number;
  retryable: boolean;
  detail: TDetail;
  recordedAt: string;
}

/** A later record marking a previously-failed key as since resolved. */
export interface SuccessRecord {
  type: 'success';
  key: string;
  recordedAt: string;
}

type LedgerRecord<TDetail> = FailureRecord<TDetail> | SuccessRecord;

export class FailureLedger<TDetail> {
  constructor(private readonly path: string) {}

  /**
   * Records one failed attempt. `attempt` is the caller's own count (this
   * ledger does not track it itself, so the orchestrator stays the single
   * source of truth for how many times something has been tried).
   */
  async recordFailure(
    record: Omit<FailureRecord<TDetail>, 'type' | 'recordedAt'>,
  ): Promise<void> {
    const full: FailureRecord<TDetail> = {
      ...record,
      type: 'failure',
      recordedAt: new Date().toISOString(),
    };
    await appendLine(this.path, full);
  }

  /** Records that a previously-failed key has since succeeded. */
  async recordSuccess(key: string): Promise<void> {
    const record: SuccessRecord = { type: 'success', key, recordedAt: new Date().toISOString() };
    await appendLine(this.path, record);
  }

  /**
   * Keys currently worth retrying: for each key, only its **latest** record
   * matters - a `failure` after an earlier `success` means it broke again
   * and should retry; a `success` after a `failure` clears it. A key whose
   * latest record is a `failure` marked `retryable: false` (e.g. a
   * permanent 404, or a case positively identified as sealed) is excluded:
   * retrying it would just spend a request reconfirming the same outcome.
   */
  async listRetryable(): Promise<FailureRecord<TDetail>[]> {
    const records = await readLines(
      this.path,
      (line) => JSON.parse(line) as LedgerRecord<TDetail>,
    );

    const latestByKey = new Map<string, LedgerRecord<TDetail>>();
    for (const record of records) {
      latestByKey.set(record.key, record);
    }

    const retryable: FailureRecord<TDetail>[] = [];
    for (const record of latestByKey.values()) {
      if (record.type === 'failure' && record.retryable) {
        retryable.push(record);
      }
    }
    return retryable;
  }
}
