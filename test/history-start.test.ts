import { describe, expect, it } from 'vitest';

import { findHistoryStart } from '../src/pipeline/history-start.js';
import type { Query, SearchResponse } from '../src/domain/types.js';

/** A scripted fake: filings only exist from `startYear` onward. */
function fakeSearchStartingAt(startYear: number) {
  return async (query: Query): Promise<SearchResponse> => {
    const probedYear = Number(query.from.slice(0, 4));
    const rows = probedYear >= startYear ? [{ number: 'case-1', ca: 'ca-1' }] : [];
    return {
      rows,
      capped: false,
      capSignal: { capped: false, byText: false, byCount: false, disagree: false },
    };
  };
}

describe('findHistoryStart', () => {
  it('finds the exact boundary year via binary search', async () => {
    const result = await findHistoryStart({
      today: '2026-08-28',
      search: fakeSearchStartingAt(2010),
      earliestPlausibleYear: 1990,
    });

    expect(result.firstYear).toBe(2010);
  });

  it('records every probe made, for the resolution audit trail', async () => {
    const result = await findHistoryStart({
      today: '2026-08-28',
      search: fakeSearchStartingAt(2010),
      earliestPlausibleYear: 1990,
    });

    // O(log years): the (1990..2026) window is 36 years, so at most ~6 probes.
    expect(result.probes.length).toBeGreaterThan(0);
    expect(result.probes.length).toBeLessThanOrEqual(6);

    // Every recorded probe's row count matches what the fake would return for
    // that year, so the audit trail is trustworthy on its own.
    for (const probe of result.probes) {
      expect(probe.rows).toBe(probe.year >= 2010 ? 1 : 0);
    }
  });

  it('honours a custom earliestPlausibleYear as the search floor', async () => {
    // Filings actually start in 1985, but the floor is set to 2000: the
    // search must not probe below 2000, so it reports 2000 as the boundary
    // even though the true start is earlier - the floor is a deliberate
    // request-saving assumption, not a discovered fact.
    const result = await findHistoryStart({
      today: '2026-08-28',
      search: fakeSearchStartingAt(1985),
      earliestPlausibleYear: 2000,
    });

    expect(result.firstYear).toBe(2000);
    expect(result.probes.every((p) => p.year >= 2000)).toBe(true);
  });

  it('defaults the floor to 50 years before today when not given', async () => {
    const result = await findHistoryStart({
      today: '2026-08-28',
      search: fakeSearchStartingAt(2015),
    });

    expect(result.firstYear).toBe(2015);
    expect(result.probes.every((p) => p.year >= 2026 - 50)).toBe(true);
  });

  it('reports today\'s year itself when filings start exactly then', async () => {
    const result = await findHistoryStart({
      today: '2026-08-28',
      search: fakeSearchStartingAt(2026),
      earliestPlausibleYear: 2020,
    });

    expect(result.firstYear).toBe(2026);
  });
});
