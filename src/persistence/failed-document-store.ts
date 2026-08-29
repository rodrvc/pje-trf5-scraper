/**
 * Records document downloads that failed, so they can be retried later - the
 * brief asks for this explicitly as part of 429 handling.
 *
 * Written to `data/failed-documents.ndjson`. The issue text names
 * `failed.json` (a single mutable JSON file); NDJSON is used instead for the
 * same reason every other store in this module is append-only - see
 * `ndjson-log.ts`'s module comment.
 *
 * A thin, document-shaped façade over the generic `FailureLedger`
 * (`failure-ledger.ts`), keyed by `caseNumber::documentId` so a document
 * failure and a case-detail failure (`case-failure-store.ts`) share the same
 * failure/success/latest-wins machinery without duplicating it.
 *
 * ISSUE-6 owns `src/pje/download.ts` and never writes failure files itself
 * (its download function just returns a discriminated result); ISSUE-9 (the
 * orchestrator) is the caller that turns a `{ ok: false, ... }` result into
 * a call to `recordFailure`, and a later successful retry into a call to
 * `recordSuccess`.
 */

import { join } from 'node:path';

import { FailureLedger, type FailureRecord } from './failure-ledger.js';

export const FAILED_DOCUMENTS_FILE = 'failed-documents.ndjson';

/** Everything ISSUE-6's download GET needs to retry, carried alongside the failure reason. */
export interface DocumentFailureDetail {
  caseNumber: string;
  /** The document's `idProcessoDocumento`: stable and unique per document (see `types.ts`). */
  documentId: string;
  /** `numeroDocumento` etc., kept alongside `documentId` since the download GET needs all five. */
  downloadRef: {
    idBin: string;
    numeroDocumento: string;
    nomeArqProcDocBin: string;
    idProcessoDocumento: string;
    actionMethod: string;
  };
}

/** One failed document-download attempt, flattened back to the shape callers had before. */
export interface FailedDocumentRecord {
  caseNumber: string;
  documentId: string;
  downloadRef: DocumentFailureDetail['downloadRef'];
  reason: string;
  httpStatus?: number;
  attempt: number;
  retryable: boolean;
  recordedAt: string;
}

function key(caseNumber: string, documentId: string): string {
  return `${caseNumber}::${documentId}`;
}

/** Flattens a ledger record's `detail` back up alongside the failure fields. */
function toFailedDocumentRecord(record: FailureRecord<DocumentFailureDetail>): FailedDocumentRecord {
  return {
    caseNumber: record.detail.caseNumber,
    documentId: record.detail.documentId,
    downloadRef: record.detail.downloadRef,
    reason: record.reason,
    ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
    attempt: record.attempt,
    retryable: record.retryable,
    recordedAt: record.recordedAt,
  };
}

export class FailedDocumentStore {
  private readonly ledger: FailureLedger<DocumentFailureDetail>;

  constructor(dataDir: string) {
    this.ledger = new FailureLedger(join(dataDir, FAILED_DOCUMENTS_FILE));
  }

  /** Records one failed download attempt for later retry. */
  async recordFailure(input: {
    caseNumber: string;
    documentId: string;
    downloadRef: DocumentFailureDetail['downloadRef'];
    reason: string;
    httpStatus?: number;
    attempt: number;
    retryable: boolean;
  }): Promise<void> {
    await this.ledger.recordFailure({
      key: key(input.caseNumber, input.documentId),
      reason: input.reason,
      ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
      attempt: input.attempt,
      retryable: input.retryable,
      detail: { caseNumber: input.caseNumber, documentId: input.documentId, downloadRef: input.downloadRef },
    });
  }

  /** Records that a previously-failed document has since been downloaded successfully. */
  async recordSuccess(caseNumber: string, documentId: string): Promise<void> {
    await this.ledger.recordSuccess(key(caseNumber, documentId));
  }

  /** Documents currently worth retrying (latest record per document, only if still `retryable`). */
  async listRetryable(): Promise<FailedDocumentRecord[]> {
    const records = await this.ledger.listRetryable();
    return records.map(toFailedDocumentRecord);
  }
}
