/**
 * The date-window sweep: walks the whole corpus around the 30-result cap.
 *
 * PROBLEMS.md §5. A query that saturates is not a result, it is a signal to
 * narrow further. This walks the query space depth-first, narrowing with the
 * `PartitionChain` (ISSUE-4's `DateRangeSplit` and `JudicialClassSplit`)
 * whenever a window caps, and emitting a `SweepEvent` for every window
 * covered - a final one for a window that did not saturate, an informational
 * one for a window that was narrowed further, and (via the optional `cover`
 * hook) an event for a leaf reached by ISSUE-4b's cover instead.
 *
 * Kept pure with respect to I/O: `search` is injected, so the whole walk is
 * testable with a scripted fake and no network (see test/sweep.test.ts).
 *
 * Error policy: this generator does not catch anything from `search`, with
 * one exception (9b): `RejectedQueryError` is caught per leaf and turned into
 * a `rejected` event, so the walk continues with that leaf's siblings - the
 * server has already told us the query is malformed, so retrying it
 * unchanged would just repeat the rejection. Every other error still
 * propagates out of the `for await` loop the caller is driving, aborting the
 * walk (every event already yielded still stands). Deciding what to do about
 * those is the runner's job (ISSUE-9), not this function's.
 */

import type { Query, SearchResponse, SearchResultRow } from '../domain/types.js';
import { RejectedQueryError } from '../domain/errors.js';
import type { PartitionChain } from './partition.js';

/** Signature every search function passed to the sweep (and the cover hook) must satisfy. */
export type SearchFn = (query: Query) => Promise<SearchResponse>;

/**
 * A minimal seen-set contract, so dedup state can be backed by something other
 * than an in-memory `Set` (e.g. a store ISSUE-7 persists to disk, letting a
 * resumed run pick up the dedup state from where an earlier one left off).
 *
 * For the two partition strategies in this issue, which produce disjoint
 * subqueries by construction, dedup is a no-op in practice - it only starts
 * doing real work once a `cover` (ISSUE-4b) is plugged in, since a cover's
 * subqueries can genuinely overlap.
 */
export interface SeenSet {
  has(number: string): boolean;
  add(number: string): void;
}

/**
 * One step of the walk: either a completed window, or a warning about one.
 *
 * Four variants are **final**: `window`, `unsplittable`, `covered`, and
 * `abandoned` (the last two only ever come from an injected `cover`). Their
 * `rows` are deduplicated against every other final event in the run and are
 * the actual answer for that slice of the query space.
 *
 * `capped` is **not final** - the issue's own framing is that "a capped query
 * is a signal to narrow, not a result". Its `rows` are carried only for
 * auditability (e.g. to show what the last row was before the split, per
 * PROBLEMS.md §5's ordering note) and are deliberately **not** deduplicated
 * against: the same cases will reappear in the children's final events, and a
 * consumer that materializes results must not treat a capped window's rows as
 * part of the output, or it will double-count and could even (if it also
 * marked them "seen") make the real, final sighting of those cases look like
 * a duplicate to be dropped.
 *
 * `skipped` and `rejected` (9b) are neither final nor carry `rows`: `skipped`
 * means `search` was never called for this leaf (see `SweepOptions.skipWindow`),
 * `rejected` means it threw `RejectedQueryError` and the leaf was abandoned.
 * Both are purely informational - nothing to dedupe or record as covered.
 */
export type SweepEvent =
  | {
      /** A window ran and did not saturate: its rows are the final answer for it. */
      type: 'window';
      query: Query;
      rows: SearchResultRow[];
      depth: number;
    }
  | {
      /**
       * A window saturated and was narrowed further. `rows` are informational
       * only (see the type-level doc above): the same cases are re-emitted,
       * deduplicated, by this window's children.
       */
      type: 'capped';
      query: Query;
      rows: SearchResultRow[];
      depth: number;
      splitBy: string;
    }
  | {
      /**
       * A window saturated and **no strategy in the chain could split it
       * further** (and no `cover` was supplied, or it too gave up before
       * plateau - see `abandoned`). This is the hand-off point to ISSUE-4b:
       * without this event, the sweep would either throw (stopping the whole
       * run over one leaf) or silently drop the tail of that leaf, which is
       * exactly the gap the cap-detection work in ISSUE-3/PROBLEMS.md §5 was
       * meant to prevent.
       */
      type: 'unsplittable';
      query: Query;
      rows: SearchResultRow[];
      depth: number;
    }
  | {
      /**
       * Emitted by an injected `cover` (ISSUE-4b's `PartyTokenSweep`) when its
       * union of filters stopped growing: the leaf is complete, with evidence.
       */
      type: 'covered';
      query: Query;
      rows: SearchResultRow[];
      depth: number;
      filtersTried: number;
      unionSize: number;
      plateaued: true;
    }
  | {
      /**
       * Emitted by an injected `cover` when its request budget ran out before
       * the union plateaued. Not final in the completeness sense - the leaf is
       * known-incomplete - but still a terminal event for the walk: nothing
       * else will be tried on it.
       */
      type: 'abandoned';
      query: Query;
      rows: SearchResultRow[];
      depth: number;
      filtersTried: number;
      unionSize: number;
    }
  | {
      /**
       * A leaf matched `SweepOptions.skipWindow` (9b: resume) and `search`
       * was never called for it. See that option's doc comment for the
       * exact, leaf-only matching semantics.
       */
      type: 'skipped';
      query: Query;
      depth: number;
    }
  | {
      /**
       * `search` threw `RejectedQueryError` for this leaf (9b): the walk
       * catches this one itself, abandoning the leaf while its siblings
       * still run, instead of ending the whole generator.
       */
      type: 'rejected';
      query: Query;
      depth: number;
      message: string;
    };

/**
 * What a cover reports for one leaf, minus the fields the walk itself owns.
 *
 * A cover has no notion of `depth` - it is not part of the recursive
 * `PartitionChain` tree, it is only ever invoked once per leaf - and `query`
 * is simply the `leaf` the walk already passed in. Requiring the cover to
 * echo both back was redundant and, worse, gave it a chance to get them
 * wrong (see the architecture-review nit this type resolves: the walk, not
 * the cover, is the single owner of `depth` and `query` for every event kind).
 */
export type CoverEvent =
  | {
      type: 'covered';
      rows: SearchResultRow[];
      filtersTried: number;
      unionSize: number;
      plateaued: true;
    }
  | {
      type: 'abandoned';
      rows: SearchResultRow[];
      filtersTried: number;
      unionSize: number;
    };

/**
 * A cover hook: the seam ISSUE-4b plugs into, invoked on a leaf that
 * saturated and that the `PartitionChain` cannot narrow any further.
 *
 * Unlike a `PartitionStrategy`, a cover needs feedback from each response it
 * gets back (to choose the next filter and to decide when its union has
 * plateaued), which a synchronous `split(): Query[]` cannot express - that is
 * why this is a separate seam rather than a fourth kind of chain link. It
 * receives the `search` function directly so it can run its own probes, and
 * the leaf's already-fetched first response so it does not have to repeat
 * that request.
 *
 * Must end with exactly one `covered` or `abandoned` event; the walk does not
 * yield an `unsplittable` for a leaf handed to a cover. The cover yields
 * `CoverEvent`s, not full `SweepEvent`s: it does not know its own `depth` in
 * the walk and `query` is just the `leaf` it was handed, so the call site
 * (`dedupeCoverEvent`) stamps both on before the event reaches the consumer -
 * see that function's comment.
 */
export type CoverFn = (
  leaf: Query,
  first: SearchResponse,
  search: SearchFn,
) => AsyncGenerator<CoverEvent>;

export interface SweepOptions {
  /** Root date range to walk, ISO 8601. */
  from: string;
  to: string;
  search: SearchFn;
  chain: PartitionChain;
  /**
   * Optional hand-off for leaves the chain cannot split further (ISSUE-4b).
   * When absent, such a leaf is emitted as `unsplittable`, unchanged from
   * before this option existed.
   */
  cover?: CoverFn;
  /** Dedup state across the run. Defaults to an in-memory `Set`. */
  seen?: SeenSet;
  /**
   * Optional pre-search hook (9b: resume), checked **before** `search(query)`
   * for a leaf. Typically `store.rebuildCoveredPredicate()`: a window
   * already recorded as a final event in an earlier run is skipped outright,
   * yielding a `skipped` event and never recursing into it.
   *
   * Matching is exact-leaf only (same caveat `rebuildCoveredPredicate`
   * documents): it can only say yes for a query that was itself recorded as
   * *final*. A capped ancestor of an already-covered subtree was never final
   * (it was split), so it still gets re-requested on resume - one extra
   * search per internal node on the covered path. Acceptable: reasoning
   * about whole subtrees here would mean reimplementing `PartitionChain`'s
   * splitting logic, for the cost of one search, not a detail fetch or download.
   */
  skipWindow?: (query: Query) => boolean;
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
 * events (`window`, `unsplittable`, `covered`, `abandoned` - see
 * `SweepEvent`'s doc comment for why a capped window's rows must not be
 * registered as seen): different windows (in particular, class-split windows
 * over the same day) can surface the same case, and the acceptance criteria
 * call for one entry per case, not per window it appeared in.
 *
 * An async generator was chosen over an event callback: the walk is naturally
 * recursive, so `yield*` delegation into child calls mirrors the tree it
 * describes and gets free backpressure against the live HTTP throttle (each
 * yielded window has already spent a request); see the issue resolution for
 * the fuller comparison against a callback-based emitter.
 */
export async function* sweep(options: SweepOptions): AsyncGenerator<SweepEvent> {
  const { search, chain, cover, skipWindow } = options;
  const seen: SeenSet = options.seen ?? new Set<string>();

  yield* walk({ from: options.from, to: options.to }, 0);

  async function* walk(query: Query, depth: number): AsyncGenerator<SweepEvent> {
    if (skipWindow?.(query) === true) {
      yield { type: 'skipped', query, depth };
      return;
    }

    let response: SearchResponse;
    try {
      response = await search(query);
    } catch (error) {
      if (error instanceof RejectedQueryError) {
        yield { type: 'rejected', query, depth, message: error.message };
        return;
      }
      throw error;
    }

    if (!response.capped) {
      // Final event: dedupe against, and register into, the run-wide seen set.
      yield { type: 'window', query, rows: deduplicate(response.rows, seen), depth };
      return;
    }

    const strategy = chain.applicable(query);
    if (strategy === undefined) {
      if (cover !== undefined) {
        // The cover owns its own probing and union-growth logic; the walk's
        // job is to stamp `depth`/`query` (the cover has no notion of either -
        // see CoverEvent's doc comment) and apply the same run-wide dedup to
        // whatever final rows it reports, exactly as for every other final
        // event kind.
        for await (const event of cover(query, response, search)) {
          yield toSweepEvent(event, query, depth);
        }
        return;
      }
      // Also final: this leaf's rows are the actual (incomplete-by-chain)
      // answer for it, so they must be deduplicated and registered too.
      yield { type: 'unsplittable', query, rows: deduplicate(response.rows, seen), depth };
      return;
    }

    // A strategy that says yes and produces nothing is, by definition, not
    // actually splittable: computing subqueries BEFORE emitting the capped
    // event lets an empty result fall through to `unsplittable` instead of
    // silently dropping the leaf (e.g. JudicialClassSplit with an empty
    // catalog, which is guarded against separately - see partition.ts - but
    // this check is the walk's own backstop against any strategy doing this).
    const subqueries = strategy.split(query);
    if (subqueries.length === 0) {
      yield { type: 'unsplittable', query, rows: deduplicate(response.rows, seen), depth };
      return;
    }

    // Not final: rows are carried raw, informational only, and deliberately
    // NOT registered into `seen` - the same cases resurface, deduplicated, in
    // the children below. Registering them here would make those children's
    // genuine (final) sightings look like duplicates and drop them silently.
    yield {
      type: 'capped',
      query,
      rows: response.rows,
      depth,
      splitBy: strategy.name,
    };

    for (const subquery of subqueries) {
      yield* walk(subquery, depth + 1);
    }
  }

  /**
   * Turns a `CoverEvent` into a full `SweepEvent`: stamps `depth` and `query`
   * (the walk is the single owner of both - the cover neither tracks its own
   * recursion depth nor needs to echo back the leaf it was handed) and
   * deduplicates the rows the same way every other final event is.
   */
  function toSweepEvent(event: CoverEvent, query: Query, depth: number): SweepEvent {
    return { ...event, query, depth, rows: deduplicate(event.rows, seen) };
  }
}

/** Keeps only rows whose CNJ number has not been yielded by an earlier final event. */
function deduplicate(rows: SearchResultRow[], seen: SeenSet): SearchResultRow[] {
  const fresh: SearchResultRow[] = [];
  for (const row of rows) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    fresh.push(row);
  }
  return fresh;
}
