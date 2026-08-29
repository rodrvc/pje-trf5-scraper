/**
 * `PersistenceStore`: the one thing ISSUE-9's orchestrator imports from this
 * module.
 *
 * Each concern (`cases.ndjson`, `pending.ndjson`/`dequeued.ndjson`,
 * `sweep-progress.ndjson`, `failed-documents.ndjson`, `failed-cases.ndjson`)
 * is its own small, single-purpose store class, unit-tested on its own;
 * this façade just wires them to one shared data directory and exposes
 * exactly the operations the orchestrator needs.
 *
 * Two of its methods compose two stores in a fixed, crash-safe order rather
 * than leaving that order to the caller (an architecture-review finding on
 * the first version of this façade, which documented the two calls
 * separately and let a kill land between them):
 *
 * - `recordFinalEvent(event)` enqueues every one of the event's rows into
 *   `PendingStore` **before** recording the event itself into
 *   `SweepProgressStore`. A kill between the two calls used to be able to
 *   mark a window covered (and its cases "seen") with the rows never
 *   enqueued - on resume they would never be re-listed (the window is done)
 *   and never get a detail fetch either. Enqueuing first means the worst a
 *   kill can do is re-run this method on restart, which just re-enqueues
 *   already-pending rows and re-records an already-recorded event - both
 *   idempotent at read time (see `PendingStore`/`SweepProgressStore`).
 * - `completeRow(legalCase)` appends the case **before** dequeuing its row.
 *   A kill between the two used to be able to leave a row dequeued with no
 *   case ever stored for it. Appending first means the worst a kill can do
 *   is re-append the same case (idempotent, latest wins) and then dequeue -
 *   never the reverse.
 *
 * A case is expected to be `completeRow`'d again, later, once its documents
 * finish downloading (whether that means immediately or - if downloads are
 * pending - only after they resolve is an ISSUE-9 policy choice): the second
 * `appendCase` call carries the same case with `documents[].localPath` now
 * filled in, and the append-then-latest-wins semantics mean the row's own
 * `dequeueRow` only needs to happen once the row is not going to be
 * revisited again by this run.
 *
 * ### Usage sketch (ISSUE-9)
 *
 *     const store = new PersistenceStore({ dataDir: 'data' });
 *     const seen = await store.rebuildSeenSet();          // inject into sweep()
 *     const isCovered = await store.rebuildCoveredPredicate(); // skip done windows
 *     const caseIndex = await store.indexCases();          // skip already-detailed cases
 *
 *     for await (const event of sweep({ seen, ... })) {
 *       if (isFinalSweepEvent(event)) await store.recordFinalEvent(event);
 *     }
 *
 *     for (const row of await store.listPendingRows()) {
 *       // fetch detail, then, once downloads for it are done (or skipped):
 *       await store.completeRow(legalCase);
 *       // a detail fetch that throws instead:
 *       //   await store.recordCaseFailure({ ... }); await store.dequeueRow(row.number);
 *       // for each document download:
 *       //   ok   -> nothing to do here, ISSUE-6 already wrote the PDF
 *       //   fail -> await store.recordDocumentFailure({ ... })
 *     }
 *
 *     // --retry-failed mode:
 *     for (const failed of await store.listRetryableDocuments()) { ... }
 *     for (const failed of await store.listRetryableCases()) { ... }
 *
 * All reads rebuild their in-memory view from disk on demand (`CaseStore`
 * caches its index in memory after the first read - see that module); for a
 * 10k-line file this is still comfortably sub-second (see
 * `case-store.test.ts`'s large-file benchmark), and a scraper run reads
 * each store's full history exactly once, at startup, not per row.
 */

import type { LegalCase, Query, SearchResultRow } from '../domain/types.js';
import type { SeenSet, SweepEvent } from '../pipeline/sweep.js';
import { CaseFailureStore, type CaseFailureRecord } from './case-failure-store.js';
import { CaseStore } from './case-store.js';
import { FailedDocumentStore, type FailedDocumentRecord } from './failed-document-store.js';
import { PendingStore } from './pending-store.js';
import { isFinalSweepEvent, SweepProgressStore } from './sweep-progress-store.js';

export interface PersistenceStoreOptions {
  /** Directory all NDJSON files live under. Injectable so tests use a temp dir. */
  dataDir: string;
}

export class PersistenceStore {
  private readonly cases: CaseStore;
  private readonly pending: PendingStore;
  private readonly sweepProgress: SweepProgressStore;
  private readonly failedDocuments: FailedDocumentStore;
  private readonly failedCases: CaseFailureStore;

  constructor(options: PersistenceStoreOptions) {
    this.cases = new CaseStore(options.dataDir);
    this.pending = new PendingStore(options.dataDir);
    this.sweepProgress = new SweepProgressStore(options.dataDir);
    this.failedDocuments = new FailedDocumentStore(options.dataDir);
    this.failedCases = new CaseFailureStore(options.dataDir);
  }

  // --- cases ---------------------------------------------------------

  /**
   * Appends a fetched case's detail. Safe to call again for the same case
   * number (e.g. once more after its documents finish downloading, to
   * persist their `localPath`s - see the module comment).
   */
  async appendCase(legalCase: LegalCase): Promise<void> {
    await this.cases.append(legalCase);
  }

  /** CNJ number -> latest `LegalCase` on record. */
  async indexCases(): Promise<Map<string, LegalCase>> {
    return this.cases.index();
  }

  /** Whether a case's detail has already been fetched and stored. */
  async hasCase(number: string): Promise<boolean> {
    return this.cases.has(number);
  }

  /**
   * Appends the case, then dequeues its row - in that order, so a kill
   * between the two can only leave a row dequeued once its case is already
   * safely stored, never the other way around. See the module comment.
   */
  async completeRow(legalCase: LegalCase): Promise<void> {
    await this.cases.append(legalCase);
    await this.pending.dequeue(legalCase.number);
  }

  // --- pending (listed, not yet detailed) -----------------------------

  /** Enqueues a row the sweep listed, awaiting its detail fetch. */
  async enqueueRow(row: SearchResultRow): Promise<void> {
    await this.pending.enqueue(row);
  }

  /** Marks a row's detail fetch as attempted (success or failure alike). */
  async dequeueRow(number: string): Promise<void> {
    await this.pending.dequeue(number);
  }

  /** Rows still awaiting a detail fetch. */
  async listPendingRows(): Promise<SearchResultRow[]> {
    return this.pending.listPending();
  }

  // --- sweep progress --------------------------------------------------

  /**
   * Records a final `SweepEvent` (`window`/`unsplittable`/`covered`/
   * `abandoned`): enqueues every row it carries, then records the event
   * itself - in that order, so a kill in between never leaves a row
   * unreachable (see the module comment). Throws if handed the non-final
   * `capped` kind - filter with `isFinalSweepEvent` first, or just check
   * before calling.
   */
  async recordFinalEvent(event: SweepEvent): Promise<void> {
    if (!isFinalSweepEvent(event)) {
      throw new Error(`PersistenceStore.recordFinalEvent: '${event.type}' is not a final event`);
    }
    for (const row of event.rows) {
      await this.pending.enqueue(row);
    }
    await this.sweepProgress.recordEvent(event);
  }

  /** Rebuilds a `SeenSet` from every final event recorded so far. Inject into `sweep()`. */
  async rebuildSeenSet(): Promise<SeenSet> {
    return this.sweepProgress.rebuildSeenSet();
  }

  /**
   * Rebuilds a predicate for "was this exact window already recorded as a
   * final event". See `sweep-progress-store.ts` for the depth-first caveat:
   * it only ever answers for the exact leaf query, not a whole subtree.
   */
  async rebuildCoveredPredicate(): Promise<(query: Query) => boolean> {
    return this.sweepProgress.rebuildCoveredPredicate();
  }

  // --- failed documents ------------------------------------------------

  /** Records a failed document download attempt for later retry. */
  async recordDocumentFailure(
    record: Omit<FailedDocumentRecord, 'recordedAt'>,
  ): Promise<void> {
    await this.failedDocuments.recordFailure(record);
  }

  /** Records that a previously-failed document has since succeeded, clearing it from retry. */
  async recordDocumentSuccess(caseNumber: string, documentId: string): Promise<void> {
    await this.failedDocuments.recordSuccess(caseNumber, documentId);
  }

  /** Documents currently worth retrying (latest record per document, only if still `retryable`). */
  async listRetryableDocuments(): Promise<FailedDocumentRecord[]> {
    return this.failedDocuments.listRetryable();
  }

  // --- failed cases (detail fetch itself failed) ------------------------

  /** Records a failed case-detail fetch attempt for later retry. */
  async recordCaseFailure(record: Omit<CaseFailureRecord, 'recordedAt'>): Promise<void> {
    await this.failedCases.recordFailure(record);
  }

  /** Records that a previously-failed case's detail has since been fetched successfully. */
  async recordCaseSuccess(caseNumber: string): Promise<void> {
    await this.failedCases.recordSuccess(caseNumber);
  }

  /** Cases currently worth retrying (latest record per case, only if still `retryable`). */
  async listRetryableCases(): Promise<CaseFailureRecord[]> {
    return this.failedCases.listRetryable();
  }
}

export { isFinalSweepEvent } from './sweep-progress-store.js';
export type { SweepProgressRecord } from './sweep-progress-store.js';
export type { FailedDocumentRecord } from './failed-document-store.js';
export type { CaseFailureRecord } from './case-failure-store.js';
