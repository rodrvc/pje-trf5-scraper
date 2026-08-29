/**
 * Persists the sweep's final `SweepEvent`s (`window`, `unsplittable`,
 * `covered`, `abandoned` - see `src/pipeline/sweep.ts`) to
 * `data/sweep-progress.ndjson`, and rebuilds two things from it at startup:
 *
 * - a `SeenSet` implementation, so a resumed run's dedup state picks up
 *   exactly where an earlier run left off instead of re-registering (and
 *   re-listing) cases already found;
 * - a "window already covered" predicate, so the orchestrator (ISSUE-9) can
 *   skip re-running a query whose window was already walked to completion.
 *
 * `rows` are stored reduced to bare CNJ numbers, not full `SearchResultRow`s:
 * the row payload for a case that reached a final event is the sweep's
 * signal to move it into the pending queue (`PendingStore`) for detail
 * fetching, which happens once, at the moment the event is first observed.
 * Keeping the full rows here too would let a resumed run re-enqueue the same
 * rows from this log in addition to whatever the (separate) pending queue
 * already has for them - the two would drift out of sync over which one is
 * authoritative. This store's only job is "was this window's search work
 * already done", which needs just the numbers.
 *
 * This module absorbs `src/pipeline/uncoverable.ts`: that module was a
 * minimal, callerless NDJSON sink for `abandoned` events specifically,
 * written ahead of this issue with an explicit note that ISSUE-7 owns
 * general persistence. Duplicating a second "write one JSON line per
 * abandoned leaf" module here would leave two slightly different formats for
 * the same event kind; instead, `recordEvent` below handles `abandoned`
 * (and every other final kind) through the one shared log, and
 * `uncoverable.ts`/`uncoverable.test.ts` are removed (see the issue
 * resolution for the exact diff).
 *
 * ### The predicate's depth-first caveat
 *
 * `isWindowCovered(query)` can only ever tell the orchestrator "this exact
 * window was recorded as a final event" - it has no notion of the
 * `PartitionChain` tree the sweep walks, so it cannot answer "has everything
 * under this window been covered" for a window that was *split* (a `capped`
 * event, which this store never persists - see below). Concretely: if a run
 * is killed after finishing the '202' class leaf under 2025-03-11 but before
 * reaching the '283' leaf, `isWindowCovered` will correctly say yes for the
 * `{from: '2025-03-11', to: '2025-03-11', judicialClassId: '202'}' query and
 * (correctly) no for the bare `{from: '2025-03-11', to: '2025-03-11'}` query
 * (which was never itself a *final* event - it was capped and split). A
 * resumed sweep still has to walk into that day and re-discover that '202'
 * is covered leaf-by-leaf; this predicate only lets it skip the leaf itself
 * once reached; it does not let the orchestrator skip a whole subtree from
 * the root down. That match with the sweep's own depth-first, leaf-final
 * event model is intentional: teaching this predicate to reason about
 * partially-split subtrees would require it to reimplement
 * `PartitionChain`'s splitting logic just to answer "is everything under
 * here done", which belongs to the sweep, not to persistence.
 */

import { join } from 'node:path';

import type { Query } from '../domain/types.js';
import type { SeenSet, SweepEvent } from '../pipeline/sweep.js';
import { appendLine, readLines } from './ndjson-log.js';

export const SWEEP_PROGRESS_FILE = 'sweep-progress.ndjson';

/** A final SweepEvent kind, reduced to what this store persists. */
export type FinalSweepEventKind = Extract<
  SweepEvent['type'],
  'window' | 'unsplittable' | 'covered' | 'abandoned'
>;

/** One line of `sweep-progress.ndjson`: a final event, rows reduced to CNJ numbers. */
export interface SweepProgressRecord {
  type: FinalSweepEventKind;
  query: Query;
  depth: number;
  cnjNumbers: string[];
  /** Present only for `covered`/`abandoned` (see `CoverEvent` in sweep.ts). */
  filtersTried?: number;
  unionSize?: number;
  recordedAt: string;
}

const FINAL_KINDS: ReadonlySet<string> = new Set(['window', 'unsplittable', 'covered', 'abandoned']);

/** Whether a `SweepEvent` is one of the four final kinds this store persists. */
export function isFinalSweepEvent(
  event: SweepEvent,
): event is Extract<SweepEvent, { type: FinalSweepEventKind }> {
  return FINAL_KINDS.has(event.type);
}

/**
 * Stable key for a query's window, used for the covered-set predicate.
 *
 * `judicialClassName` is deliberately excluded: it is display text that
 * travels alongside `judicialClassId` purely because the search form
 * requires both (see `Query`'s own doc comment) - the id alone already
 * identifies the class uniquely, so including the name too would risk two
 * keys for what is really the same window if the name's exact string ever
 * changed (a catalog re-fetch, a site copy edit) between runs.
 */
function windowKey(query: Query): string {
  return JSON.stringify({
    from: query.from,
    to: query.to,
    judicialClassId: query.judicialClassId ?? null,
    partyName: query.partyName ?? null,
  });
}

export class SweepProgressStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, SWEEP_PROGRESS_FILE);
  }

  /**
   * Appends a final `SweepEvent` as one `SweepProgressRecord` line.
   *
   * Throws if handed a non-final event (`capped`): callers should filter
   * with `isFinalSweepEvent` first, same as the deduplication rule the sweep
   * itself documents - a capped window's rows are informational only and
   * must never be treated as "this window is done".
   */
  async recordEvent(event: SweepEvent): Promise<void> {
    if (!isFinalSweepEvent(event)) {
      throw new Error(`SweepProgressStore.recordEvent: '${event.type}' is not a final event`);
    }
    const record: SweepProgressRecord = {
      type: event.type,
      query: event.query,
      depth: event.depth,
      cnjNumbers: event.rows.map((row) => row.number),
      ...('filtersTried' in event ? { filtersTried: event.filtersTried } : {}),
      ...('unionSize' in event ? { unionSize: event.unionSize } : {}),
      recordedAt: new Date().toISOString(),
    };
    await appendLine(this.path, record);
  }

  /** All recorded final events, in the order they were written. */
  async all(): Promise<SweepProgressRecord[]> {
    return readLines(this.path, (line) => JSON.parse(line) as SweepProgressRecord);
  }

  /**
   * Rebuilds a `SeenSet` from every CNJ number across every recorded final
   * event, so a resumed sweep's dedup starts exactly where the last run's
   * left off instead of re-registering cases the sweep would then re-list
   * (harmlessly for the sweep itself, since it dedupes - but wastefully,
   * since a case already stored does not need to be walked into again by
   * the orchestrator's pending-queue logic).
   */
  async rebuildSeenSet(): Promise<SeenSet> {
    const records = await this.all();
    const numbers = new Set<string>();
    for (const record of records) {
      for (const number of record.cnjNumbers) numbers.add(number);
    }
    return {
      has: (number: string) => numbers.has(number),
      add: (number: string) => {
        numbers.add(number);
      },
    };
  }

  /**
   * Rebuilds the set of windows already recorded as a final event, and
   * returns a predicate over it. See the module comment for the exact
   * (leaf-only, non-recursive) semantics this predicate has.
   */
  async rebuildCoveredPredicate(): Promise<(query: Query) => boolean> {
    const records = await this.all();
    const covered = new Set(records.map((record) => windowKey(record.query)));
    return (query: Query) => covered.has(windowKey(query));
  }
}
