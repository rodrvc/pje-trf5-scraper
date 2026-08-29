/**
 * `PersistenceStore`: the one thing ISSUE-9's orchestrator imports from this
 * module.
 *
 * Each concern (`cases.ndjson`, `pending.ndjson`/`dequeued.ndjson`,
 * `sweep-progress.ndjson`, `failed-documents.ndjson`) is its own small,
 * single-purpose store class, unit-tested on its own; this façade just wires
 * them to one shared data directory and exposes exactly the operations the
 * orchestrator needs, so it does not have to import five modules and know
 * their file names.
 *
 * ### Usage sketch (ISSUE-9)
 *
 *     const store = new PersistenceStore({ dataDir: 'data' });
 *     const seen = await store.rebuildSeenSet();          // inject into sweep()
 *     const isCovered = await store.rebuildCoveredPredicate(); // skip done windows
 *     const caseIndex = await store.indexCases();          // skip already-detailed cases
 *
 *     for await (const event of sweep({ seen, ... })) {
 *       if (isFinalSweepEvent(event)) {
 *         await store.recordSweepEvent(event);
 *         for (const row of event.rows) {
 *           if (!caseIndex.has(row.number)) await store.enqueueRow(row);
 *         }
 *       }
 *     }
 *
 *     for (const row of await store.listPendingRows()) {
 *       // fetch detail, then:
 *       await store.appendCase(legalCase);
 *       await store.dequeueRow(row.number);
 *       // for each document download:
 *       //   ok   -> nothing to do here, ISSUE-6 already wrote the PDF
 *       //   fail -> await store.recordDocumentFailure({ ... })
 *     }
 *
 *     // --retry-failed mode:
 *     for (const failed of await store.listRetryableDocuments()) {
 *       // retry download, then recordDocumentSuccess or recordDocumentFailure again
 *     }
 *
 * All reads rebuild their in-memory view from disk on demand (no long-lived
 * cache invalidation to get wrong); for a 10k-line file this is still
 * comfortably sub-second (see `case-store.test.ts`'s large-file benchmark),
 * and a scraper run reads each store's full history exactly once, at
 * startup, not per row.
 */

import type { LegalCase, Query, SearchResultRow } from '../domain/types.js';
import type { SeenSet, SweepEvent } from '../pipeline/sweep.js';
import { CaseStore } from './case-store.js';
import type { FailedDocumentRecord } from './failed-document-store.js';
import { FailedDocumentStore } from './failed-document-store.js';
import { PendingStore } from './pending-store.js';
import { SweepProgressStore } from './sweep-progress-store.js';

export interface PersistenceStoreOptions {
  /** Directory all NDJSON files live under. Injectable so tests use a temp dir. */
  dataDir: string;
}

export class PersistenceStore {
  private readonly cases: CaseStore;
  private readonly pending: PendingStore;
  private readonly sweepProgress: SweepProgressStore;
  private readonly failedDocuments: FailedDocumentStore;

  constructor(options: PersistenceStoreOptions) {
    this.cases = new CaseStore(options.dataDir);
    this.pending = new PendingStore(options.dataDir);
    this.sweepProgress = new SweepProgressStore(options.dataDir);
    this.failedDocuments = new FailedDocumentStore(options.dataDir);
  }

  // --- cases ---------------------------------------------------------

  /** Appends a fetched case's detail. Safe to call again for the same case number. */
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
   * `abandoned`). Throws if handed the non-final `capped` kind - filter with
   * `isFinalSweepEvent` first, or just check before calling.
   */
  async recordSweepEvent(event: SweepEvent): Promise<void> {
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
    record: Omit<FailedDocumentRecord, 'type' | 'recordedAt'>,
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
}

export { isFinalSweepEvent } from './sweep-progress-store.js';
export type { FailedDocumentRecord, SuccessDocumentRecord } from './failed-document-store.js';
export type { SweepProgressRecord } from './sweep-progress-store.js';
