/**
 * The date-window sweep: walks the whole corpus around the 30-result cap.
 *
 * PROBLEMS.md §5. A query that saturates (`capped: true`) is not a result, it
 * is a signal to narrow further. This walks the query space depth-first,
 * narrowing with the `PartitionChain` (ISSUE-4's `DateRangeSplit` and
 * `JudicialClassSplit`) whenever a window caps, and emitting the rows of every
 * window that does not.
 *
 * Kept pure with respect to I/O: `search` is injected, so the whole walk is
 * testable with a scripted fake and no network (see test/sweep.test.ts).
 */

import type { Query, SearchResponse, SearchResultRow } from '../domain/types.js';
import type { PartitionChain } from './partition.js';

/**
 * One step of the walk: either a completed window, or a warning about one.
 *
 * Only two variants are **final**: `window` with `capped: false`, and
 * `unsplittable`. Their `rows` are deduplicated against every other final
 * event in the run and are the actual answer for that slice of the query
 * space.
 *
 * `window` with `capped: true` is **not final** - the issue's own framing is
 * that "a capped query is a signal to narrow, not a result". Its `rows` are
 * carried only for auditability (e.g. to show what the last row was before
 * the split, per PROBLEMS.md §5's ordering note) and are deliberately **not**
 * deduplicated against: the same cases will reappear in the children's final
 * events, and a consumer that materializes results must not treat a capped
 * window's rows as part of the output, or it will double-count and could
 * even (if it also marked them "seen") make the real, final sighting of those
 * cases look like a duplicate to be dropped.
 */
export type SweepEvent =
  | {
      /** A window ran and did not saturate: its rows are the final answer for it. */
      type: 'window';
      query: Query;
      rows: SearchResultRow[];
      capped: false;
      depth: number;
    }
  | {
      /**
       * A window saturated and was narrowed further. `rows` here are
       * informational only (see the type-level doc above): the same cases are
       * re-emitted, deduplicated, by this window's children.
       */
      type: 'window';
      query: Query;
      rows: SearchResultRow[];
      capped: true;
      depth: number;
      splitBy: string;
    }
  | {
      /**
       * A window saturated and **no strategy in the chain could split it
       * further**. This is the hand-off point to ISSUE-4b: without this event,
       * the sweep would either throw (stopping the whole run over one leaf) or
       * silently drop the tail of that leaf, which is exactly the gap the
       * cap-detection work in ISSUE-3/PROBLEMS.md §5 was meant to prevent.
       */
      type: 'unsplittable';
      query: Query;
      rows: SearchResultRow[];
      depth: number;
    };

export interface SweepOptions {
  /** Root date range to walk, ISO 8601. */
  from: string;
  to: string;
  search: (query: Query) => Promise<SearchResponse>;
  chain: PartitionChain;
}

/**
 * Walks the query space depth-first from the present backwards.
 *
 * Depth-first (rather than breadth-first) means a short or interrupted run
 * still produces a run of complete, contiguous windows near one end of the
 * range instead of a scattering of half-finished ones. The walk here simply
 * consumes each strategy's subqueries in the order `split()` returns them -
 * it does not itself reorder anything - so "from the present backwards" is
 * guaranteed by `DateRangeSplit.split()` returning the later half first (see
 * its doc comment), not by this function.
 *
 * Deduplicates by CNJ number across the whole run, but only at **final**
 * events (`window` with `capped: false`, and `unsplittable` - see
 * `SweepEvent`'s doc comment for why a capped window's rows must not be
 * registered as seen): different windows (in particular, class-split windows
 * over the same day) can surface the same case, and the acceptance criteria
 * call for one entry per case, not per window it appeared in.
 *
 * An async generator was chosen over an event callback for three reasons:
 *
 *   1. The walk is naturally recursive and depth-first; `yield*` delegation
 *      into recursive calls reads exactly like the tree it is describing,
 *      whereas a callback needs an explicit stack or continuation-passing to
 *      get the same shape.
 *   2. Backpressure is free: the generator does not run ahead of the consumer,
 *      which matters here because every yielded window has already spent a
 *      live HTTP request - a callback-based emitter would need its own pause
 *      mechanism to get the same throttling-friendly property.
 *   3. Testing is a plain `for await` collecting events into an array (see
 *      test/sweep.test.ts), with no fake event bus to wire up.
 *
 * The cost is that a consumer wanting fire-and-forget behavior must drive the
 * generator itself (`for await (const _ of sweep(...))`), but ISSUE-7's
 * resumable runner wants to persist after every event anyway, which a `for
 * await` loop does naturally.
 */
export async function* sweep(options: SweepOptions): AsyncGenerator<SweepEvent> {
  const { search, chain } = options;
  const seen = new Set<string>();

  yield* walk({ from: options.from, to: options.to }, 0);

  async function* walk(query: Query, depth: number): AsyncGenerator<SweepEvent> {
    const response = await search(query);

    if (!response.capped) {
      // Final event: dedupe against, and register into, the run-wide seen set.
      yield { type: 'window', query, rows: deduplicate(response.rows, seen), capped: false, depth };
      return;
    }

    const strategy = chain.applicable(query);
    if (strategy === undefined) {
      // Also final: this leaf's rows are the actual (incomplete-by-chain)
      // answer for it, so they must be deduplicated and registered too.
      yield { type: 'unsplittable', query, rows: deduplicate(response.rows, seen), depth };
      return;
    }

    // Not final: rows are carried raw, informational only, and deliberately
    // NOT registered into `seen` - the same cases resurface, deduplicated, in
    // the children below. Registering them here would make those children's
    // genuine (final) sightings look like duplicates and drop them silently.
    yield {
      type: 'window',
      query,
      rows: response.rows,
      capped: true,
      depth,
      splitBy: strategy.name,
    };

    for (const subquery of strategy.split(query)) {
      yield* walk(subquery, depth + 1);
    }
  }
}

/** Keeps only rows whose CNJ number has not been yielded by an earlier final event. */
function deduplicate(rows: SearchResultRow[], seen: Set<string>): SearchResultRow[] {
  const fresh: SearchResultRow[] = [];
  for (const row of rows) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    fresh.push(row);
  }
  return fresh;
}
