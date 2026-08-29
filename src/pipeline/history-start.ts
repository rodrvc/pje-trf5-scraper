/**
 * Finds the earliest year the corpus has filings for, empirically.
 *
 * Optional and separate from `sweep.ts` on purpose: the sweep only needs an
 * explicit `from`/`to` and does not care where that lower bound came from. This
 * is a convenience for callers (the future CLI/orchestrator, ISSUE-9) who would
 * otherwise have to guess or hardcode a start year.
 *
 * Binary search over years rather than probing every year one by one: a court
 * with decades of history would otherwise cost one request per year checked.
 * The probe query is "everything from Jan 1 of that year to today" - if it
 * returns zero rows, the corpus has not started yet by that year; if it
 * returns any rows (capped or not, it does not matter which), the corpus has
 * already started by then.
 */

import type { Query, SearchResponse } from '../domain/types.js';

export interface HistoryStartOptions {
  /** Reference "today" as an ISO date, used as the upper bound of every probe. */
  today: string;
  search: (query: Query) => Promise<SearchResponse>;
  /**
   * Years before this one are assumed empty without probing. Keeps the search
   * from wasting requests descending into centuries with obviously no PJe
   * filings; the binary search still verifies the actual boundary above it.
   */
  earliestPlausibleYear?: number;
}

/** One probe the search performed, kept for the resolution's audit trail. */
export interface HistoryStartProbe {
  year: number;
  rows: number;
}

export interface HistoryStartResult {
  /** First year with at least one filing, as far as probing could tell. */
  firstYear: number;
  probes: HistoryStartProbe[];
}

/**
 * Binary-searches the first year with any filings, probing `[Jan 1 of year, today]`.
 *
 * A handful of probes (`O(log years)`) rather than a linear scan: for a
 * plausible range of, say, 1990-2026, that is at most ~6 requests instead of up
 * to 36.
 */
export async function findHistoryStart(
  options: HistoryStartOptions,
): Promise<HistoryStartResult> {
  const { search, today } = options;
  const todayYear = Number(today.slice(0, 4));
  const probes: HistoryStartProbe[] = [];

  const probe = async (year: number): Promise<number> => {
    const response = await search({ from: `${year}-01-01`, to: today });
    probes.push({ year, rows: response.rows.length });
    return response.rows.length;
  };

  let low = options.earliestPlausibleYear ?? todayYear - 50;
  let high = todayYear;

  // Invariant: probing `low` always finds filings (or `low` is the assumed
  // floor); probing `high + 1` would find none. The search narrows that gap
  // until `low === high`, which is then the answer.
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const rows = await probe(mid);
    if (rows > 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return { firstYear: low, probes };
}
