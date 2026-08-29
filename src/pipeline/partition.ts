/**
 * Partition strategies for the date-window sweep.
 *
 * PROBLEMS.md §5: a broad "Data de Autuação" range caps at 30 rows with no
 * pagination. Narrowing the range lifts the cap, but not always: a single day
 * can still saturate (verified on 6 of 13 probed days in March 2025). So
 * splitting cascades across dimensions instead of being a single halving loop.
 *
 * Each dimension is a `PartitionStrategy`: something that knows whether a query
 * can still be narrowed along its axis, and how to narrow it. They are chained
 * so the sweep does not need to know how many dimensions exist or in what order
 * they apply - it just asks the chain "can anyone split this?" and, if so,
 * "split it".
 *
 * `DateRangeSplit` and `JudicialClassSplit` both produce **disjoint** subqueries
 * whose union is exactly the parent query, by construction:
 *
 *   - Halving `[from, to]` at the midpoint yields `[from, mid]` and
 *     `[mid+1, to]`, which do not overlap and together cover the whole range.
 *   - Splitting a day by judicial class yields one subquery per class in the
 *     catalog; every case has exactly one class, so the classes partition the
 *     day's cases exactly.
 *
 * That disjointness is what lets recursion terminate with completeness
 * *proved* rather than measured: once every leaf is uncapped, nothing has been
 * lost, because the leaves tile the original range without gaps or overlap.
 * ISSUE-4b's `PartyTokenSweep` is deliberately not like this - it is a cover,
 * not a partition - which is why it is documented as a separate kind of link in
 * the chain rather than folded in here.
 */

import type { JudicialClass, Query } from '../domain/types.js';

/**
 * One axis along which a saturated query can be narrowed.
 *
 * `canSplit` must be cheap and synchronous: the chain calls it on every
 * candidate strategy to find the first applicable one, so it should not do
 * I/O. Strategies that need external data (the class catalog) receive it
 * through their constructor instead, once, up front.
 */
export interface PartitionStrategy {
  /** Name for logging and events, e.g. "date-range", "judicial-class". */
  readonly name: string;
  /** Whether this strategy can still narrow the given query. */
  canSplit(query: Query): boolean;
  /**
   * Narrows the query into subqueries whose union is the parent.
   *
   * Only called when `canSplit` returned true; implementations may assume the
   * precondition holds and throw if called on a query they cannot split.
   */
  split(query: Query): Query[];
}

/** Parses an ISO date (`2025-03-11`) into a UTC day count, for pure arithmetic. */
function toEpochDay(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid ISO date: "${iso}"`);
  }
  return Math.floor(ms / 86_400_000);
}

/** Formats a UTC day count back into an ISO date. */
function fromEpochDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Halves a date range in two, recursively.
 *
 * Arithmetic runs entirely over epoch-day integers derived from ISO strings:
 * never `new Date()` in the local timezone, which would shift the boundary by
 * hours depending on where the process runs and silently drop or duplicate a
 * day at the edges.
 *
 * Not splittable once the range is a single day (`from === to`): there is
 * nothing left to halve along this axis, and the next strategy in the chain
 * must take over.
 */
export class DateRangeSplit implements PartitionStrategy {
  readonly name = 'date-range';

  canSplit(query: Query): boolean {
    return toEpochDay(query.from) < toEpochDay(query.to);
  }

  split(query: Query): Query[] {
    const from = toEpochDay(query.from);
    const to = toEpochDay(query.to);
    if (from >= to) {
      throw new RangeError(
        `DateRangeSplit.split called on an unsplittable range: ${query.from}..${query.to}`,
      );
    }

    // Integer midpoint: with an odd number of days the extra day goes to the
    // first half, which keeps both halves within one day of each other and
    // never produces an empty half.
    const mid = from + Math.floor((to - from) / 2);

    return [
      { ...query, from: fromEpochDay(from), to: fromEpochDay(mid) },
      { ...query, from: fromEpochDay(mid + 1), to: fromEpochDay(to) },
    ];
  }
}

/**
 * Splits a single day into one subquery per judicial class.
 *
 * Only applicable to a query that is already a single day (the date axis is
 * exhausted first - splitting a wide range by class would multiply requests
 * for no benefit, since narrowing dates alone resolves most saturation) and
 * that has no class filter yet (a class can only be split once: applying it
 * twice would just re-run the same query).
 *
 * The catalog is fetched once by the caller (`PjeSearch.classCatalog()`) and
 * handed in here, so this strategy stays synchronous and side-effect free like
 * the rest of the chain.
 */
export class JudicialClassSplit implements PartitionStrategy {
  readonly name = 'judicial-class';

  constructor(private readonly catalog: readonly JudicialClass[]) {}

  canSplit(query: Query): boolean {
    return query.from === query.to && query.judicialClassId === undefined;
  }

  split(query: Query): Query[] {
    if (!this.canSplit(query)) {
      throw new RangeError(
        `JudicialClassSplit.split called on a query it cannot split: ${JSON.stringify(query)}`,
      );
    }

    return this.catalog.map((judicialClass) => ({
      ...query,
      judicialClassId: judicialClass.id,
      judicialClassName: judicialClass.name,
    }));
  }
}

/**
 * Chain of partition strategies, tried in order.
 *
 * The chain itself carries no partitioning logic: it only picks the first
 * strategy that applies. That is what lets a third link (`PartyTokenSweep`,
 * ISSUE-4b) plug in later with zero changes here - it is appended to the list
 * passed to the constructor, nothing in this class needs to know it exists.
 */
export class PartitionChain {
  constructor(private readonly strategies: readonly PartitionStrategy[]) {}

  /** The first strategy able to split this query, if any. */
  applicable(query: Query): PartitionStrategy | undefined {
    return this.strategies.find((strategy) => strategy.canSplit(query));
  }
}
