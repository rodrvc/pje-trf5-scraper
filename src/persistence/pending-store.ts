/**
 * Ledger of `SearchResultRow`s the sweep has listed but whose detail has not
 * been fetched yet - the gap between "listed" and "detailed" a kill can land
 * in without this store would silently lose the row: the sweep's own
 * `SeenSet` (backed by `SweepProgressStore`) marks a case seen the moment its
 * *search* row is final, not once its *detail* has actually been persisted,
 * so without a separate ledger a case listed just before a kill would never
 * be re-listed (the sweep thinks it is done) and never get its detail
 * fetched either.
 *
 * Append-only, like every store here, but a queue needs a way to shrink:
 * this is modeled as two NDJSON logs rather than one mutable file -
 * `pending.ndjson` (one line per listed row) and `dequeued.ndjson` (one line
 * per CNJ number whose detail fetch has completed, successfully or not - see
 * below). `listPending()` computes the current queue as the set difference,
 * so "removing" an item is just appending its number to the second log,
 * with the same atomicity guarantee as every other write in this module.
 *
 * A row is dequeued once the orchestrator has *attempted* its detail fetch,
 * not only on success: a case whose detail fetch failed belongs to a
 * different retry story than "not yet tried" (ISSUE-9's failure policy, not
 * this queue's), and leaving it in `listPending()` forever would make the
 * queue never drain on a site that has even one broken case. The
 * orchestrator is expected to consult `CaseStore.has()` (success) or a
 * failed-document/case record (failure) to tell the two apart if it needs
 * to; this store only tracks "still to be attempted" vs. "already attempted".
 */

import { join } from 'node:path';

import type { SearchResultRow } from '../domain/types.js';
import { appendLine, readLines } from './ndjson-log.js';

export const PENDING_FILE = 'pending.ndjson';
export const DEQUEUED_FILE = 'dequeued.ndjson';

interface DequeuedRecord {
  number: string;
}

export class PendingStore {
  private readonly pendingPath: string;
  private readonly dequeuedPath: string;

  constructor(dataDir: string) {
    this.pendingPath = join(dataDir, PENDING_FILE);
    this.dequeuedPath = join(dataDir, DEQUEUED_FILE);
  }

  /** Appends one listed row. Safe to call more than once for the same case. */
  async enqueue(row: SearchResultRow): Promise<void> {
    await appendLine(this.pendingPath, row);
  }

  /**
   * Marks a case's detail fetch as attempted, whatever the outcome.
   *
   * Idempotent by construction: appending the same number twice just means
   * it appears twice in `dequeued.ndjson`, which `listPending()`'s set
   * difference already treats the same as appearing once.
   */
  async dequeue(number: string): Promise<void> {
    await appendLine(this.dequeuedPath, { number } satisfies DequeuedRecord);
  }

  /**
   * Rows still awaiting a detail fetch: every enqueued row whose CNJ number
   * has not been dequeued, latest-listing-per-number (a row can legitimately
   * be enqueued again with a fresher `ca` if the sweep re-lists it; the most
   * recent listing wins, same idempotence-at-read stance as `CaseStore`).
   */
  async listPending(): Promise<SearchResultRow[]> {
    const [listed, dequeued] = await Promise.all([
      readLines(this.pendingPath, (line) => JSON.parse(line) as SearchResultRow),
      readLines(this.dequeuedPath, (line) => JSON.parse(line) as DequeuedRecord),
    ]);

    const dequeuedNumbers = new Set(dequeued.map((record) => record.number));
    const latestByNumber = new Map<string, SearchResultRow>();
    for (const row of listed) {
      latestByNumber.set(row.number, row);
    }

    return [...latestByNumber.values()].filter((row) => !dequeuedNumbers.has(row.number));
  }
}
