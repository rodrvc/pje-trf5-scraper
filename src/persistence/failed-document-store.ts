/**
 * Records document downloads that failed, so they can be retried later - the
 * brief asks for this explicitly as part of 429 handling.
 *
 * Written to `data/failed-documents.ndjson`. The issue text names
 * `failed.json` (a single mutable JSON file); NDJSON is used instead for the
 * same reason every other store in this module is append-only: a single
 * JSON file has to be read whole, mutated, and rewritten whole on every
 * failure, which means a process killed mid-rewrite can corrupt the entire
 * file, not just lose the one record being added. Appending one line per
 * event sidesteps that failure mode entirely (see `ndjson-log.ts`'s module
 * comment) at the cost of needing a "latest record wins" read (below)
 * instead of the file already being the current state - a trade this module
 * makes gladly, since ISSUE-6 (the PDF downloader) is running in parallel
 * and this store's write path must never be able to corrupt a `success`
 * record it wrote moments earlier.
 *
 * ISSUE-6 owns `src/pje/download.ts` and never writes failure files itself
 * (its download function just returns a discriminated result); ISSUE-9 (the
 * orchestrator) is the caller that turns a `{ ok: false, ... }` result into
 * a call to `recordFailure`, and a later successful retry into a call to
 * `recordSuccess`.
 */

import { join } from 'node:path';

import { appendLine, readLines } from './ndjson-log.js';

export const FAILED_DOCUMENTS_FILE = 'failed-documents.ndjson';

/** One failed-download attempt. */
export interface FailedDocumentRecord {
  type: 'failure';
  caseNumber: string;
  /** The document's `idProcessoDocumento`: stable and unique per document (see `types.ts`). */
  documentId: string;
  /** `numeroDocumento`, kept alongside `documentId` since ISSUE-6's download GET needs both. */
  downloadRef: {
    idBin: string;
    numeroDocumento: string;
    nomeArqProcDocBin: string;
    idProcessoDocumento: string;
    actionMethod: string;
  };
  reason: string;
  httpStatus?: number;
  attempt: number;
  retryable: boolean;
  recordedAt: string;
}

/** A later record marking a previously-failed document as since downloaded successfully. */
export interface SuccessDocumentRecord {
  type: 'success';
  caseNumber: string;
  documentId: string;
  recordedAt: string;
}

type DocumentRecord = FailedDocumentRecord | SuccessDocumentRecord;

export class FailedDocumentStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, FAILED_DOCUMENTS_FILE);
  }

  /**
   * Records one failed attempt. `attempt` is the caller's own count (this
   * store does not track it itself, so the orchestrator stays the single
   * source of truth for how many times a document has been tried).
   */
  async recordFailure(record: Omit<FailedDocumentRecord, 'type' | 'recordedAt'>): Promise<void> {
    const full: FailedDocumentRecord = {
      ...record,
      type: 'failure',
      recordedAt: new Date().toISOString(),
    };
    await appendLine(this.path, full);
  }

  /** Records that a previously-failed document has since been downloaded successfully. */
  async recordSuccess(caseNumber: string, documentId: string): Promise<void> {
    const record: SuccessDocumentRecord = {
      type: 'success',
      caseNumber,
      documentId,
      recordedAt: new Date().toISOString(),
    };
    await appendLine(this.path, record);
  }

  /**
   * The documents currently worth retrying: for each (case, document) pair,
   * only its **latest** record matters - a `failure` after an earlier
   * `success` means it broke again and should retry; a `success` after a
   * `failure` clears it. A document with only `failure` records but marked
   * `retryable: false` on its latest one (e.g. a 404 that will never
   * resolve itself) is excluded: retrying it would just spend requests
   * confirming the same permanent outcome.
   */
  async listRetryable(): Promise<FailedDocumentRecord[]> {
    const records = await readLines(this.path, (line) => JSON.parse(line) as DocumentRecord);

    const latestByKey = new Map<string, DocumentRecord>();
    for (const record of records) {
      latestByKey.set(key(record), record);
    }

    const retryable: FailedDocumentRecord[] = [];
    for (const record of latestByKey.values()) {
      if (record.type === 'failure' && record.retryable) {
        retryable.push(record);
      }
    }
    return retryable;
  }
}

function key(record: DocumentRecord): string {
  return `${record.caseNumber}::${record.documentId}`;
}
