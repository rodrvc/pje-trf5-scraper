import { describe, expect, it } from 'vitest';

import { createPartyTokenSweep } from '../src/pipeline/party-sweep.js';
import { RejectedQueryError } from '../src/domain/errors.js';
import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../src/pipeline/partition.js';
import { sweep, type SweepEvent } from '../src/pipeline/sweep.js';
import type { JudicialClass, Query, SearchResponse, SearchResultRow } from '../src/domain/types.js';

/** Builds a row with a given CNJ-shaped number, the only field the cover inspects. */
function row(number: string): SearchResultRow {
  return { number, ca: `ca-${number}` };
}

/** Wraps rows into a SearchResponse, capped when it hits (or exceeds) the site's cap. */
function response(rows: SearchResultRow[], capped = false): SearchResponse {
  return {
    rows,
    capped,
    capSignal: { capped, byText: capped, byCount: capped, disagree: false },
  };
}

const leaf: Query = {
  from: '2025-03-12',
  to: '2025-03-12',
  judicialClassId: '202',
  judicialClassName: 'Agravo de Instrumento',
};

describe('createPartyTokenSweep', () => {
  it('plateaus after N consecutive filters add nothing, and reports covered', async () => {
    // Alphabet of 6 tokens: the first two grow the union, the rest add
    // nothing. With plateauAfter: 3, the cover should stop right after the
    // third consecutive flat filter (index 4, 0-based: tokens 2,3,4 flat).
    const alphabet = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const responsesByToken: Record<string, SearchResultRow[]> = {
      T1: [row('a'), row('b')],
      T2: [row('c')],
      T3: [row('a')], // already in the union: flat
      T4: [row('b')], // already in the union: flat
      T5: [row('c')], // already in the union: flat -> plateau reached here
      T6: [row('z')], // must never be tried
    };
    const calls: string[] = [];
    const search = async (query: Query): Promise<SearchResponse> => {
      const token = query.partyName ?? '';
      calls.push(token);
      return response(responsesByToken[token] ?? []);
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 3 });
    const events = [];
    for await (const event of cover(leaf, response([]), search)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'covered', plateaued: true, unionSize: 3 });
    if (events[0]?.type === 'covered') {
      expect(events[0].filtersTried).toBe(5);
      expect(events[0].rows.map((r) => r.number).sort()).toEqual(['a', 'b', 'c']);
    }
    // T6 was never reached: the plateau stopped the loop before it.
    expect(calls).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('does not let a capped filter satisfy the plateau, even when it adds nothing new', async () => {
    // T1 grows the union. T2 and T3 are capped and add nothing new - per the
    // coordinator's explicit rule, a capped filter's silence is not trusted
    // evidence of a plateau, so they must not count toward flatStreak. T4 is
    // uncapped and flat, genuinely starting the streak. With plateauAfter:
    // 2, the plateau should only fire after T4 AND T5 (both uncapped, both
    // flat) - not after T2/T3 alone, which a buggy implementation ignoring
    // `capped` would wrongly treat as two flat filters.
    const alphabet = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const search = async (query: Query): Promise<SearchResponse> => {
      switch (query.partyName) {
        case 'T1':
          return response([row('a'), row('b')]);
        case 'T2':
          // Capped and adds nothing: must not count as a flat filter.
          return response([row('a')], true);
        case 'T3':
          // Also capped, also flat: still must not count.
          return response([row('b')], true);
        case 'T4':
          // Uncapped and flat: the real streak starts here.
          return response([row('a')]);
        case 'T5':
          // Uncapped and flat again: plateau reached here (streak of 2).
          return response([row('b')]);
        default:
          // T6 must never be tried.
          return response([row('z')]);
      }
    };

    const calls: string[] = [];
    const wrappedSearch = async (query: Query): Promise<SearchResponse> => {
      calls.push(query.partyName ?? '');
      return search(query);
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 2 });
    const events = [];
    for await (const event of cover(leaf, response([]), wrappedSearch)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('covered');
    if (events[0]?.type === 'covered') {
      expect(events[0].filtersTried).toBe(5);
    }
    expect(calls).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('reports abandoned when the budget runs out while the union is still growing', async () => {
    // Every filter keeps adding a new case, so the plateau condition never
    // fires; the alphabet (acting as the budget here) runs out first.
    // plateauAfter must be <= the alphabet length (the factory guard rejects
    // otherwise - see the dedicated guard tests below), so this uses 3.
    const alphabet = ['T1', 'T2', 'T3'];
    let counter = 0;
    const search = async (): Promise<SearchResponse> => {
      counter += 1;
      return response([row(`case-${counter}`)]);
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 3 });
    const events = [];
    for await (const event of cover(leaf, response([]), search)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('abandoned');
    if (events[0]?.type === 'abandoned') {
      expect(events[0].filtersTried).toBe(3);
      expect(events[0].unionSize).toBe(3);
    }
  });

  it('a capped filter that adds new cases still resets the streak', async () => {
    // Mirrors the capped-silence test above, but for the opposite case: T1
    // starts a flat streak (uncapped, adds nothing new relative to the
    // seed), T2 is CAPPED but genuinely grows the union - that growth is
    // real, verified evidence and must reset the streak just like an
    // uncapped grower would, even though T2's own silence (had it had any)
    // would not have been trusted. T3/T4 are uncapped and flat, completing
    // the plateau at exactly 2 - proving the streak restarted at T2 rather
    // than continuing from T1.
    const alphabet = ['T1', 'T2', 'T3', 'T4', 'T5'];
    const search = async (query: Query): Promise<SearchResponse> => {
      switch (query.partyName) {
        case 'T1':
          // Uncapped, flat against the seed: starts a streak of 1.
          return response([row('seed')]);
        case 'T2':
          // Capped, but adds a genuinely new case: must reset the streak to 0.
          return response([row('seed'), row('new-from-capped')], true);
        case 'T3':
          // Uncapped, flat: streak = 1 (restarted after T2, not continuing
          // from T1's streak of 1 - a buggy implementation that never resets
          // on a capped-but-growing filter would already be at streak 2 here
          // and plateau one filter too early).
          return response([row('seed')]);
        case 'T4':
          // Uncapped, flat: streak = 2, plateau reached here.
          return response([row('seed')]);
        default:
          // T5 must never be tried.
          return response([row('z')]);
      }
    };

    const calls: string[] = [];
    const wrappedSearch = async (query: Query): Promise<SearchResponse> => {
      calls.push(query.partyName ?? '');
      return search(query);
    };

    const first = response([row('seed')]);
    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 2 });
    const events = [];
    for await (const event of cover(leaf, first, wrappedSearch)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('covered');
    if (events[0]?.type === 'covered') {
      expect(events[0].filtersTried).toBe(4);
      expect(events[0].rows.map((r) => r.number).sort()).toEqual(['new-from-capped', 'seed']);
    }
    expect(calls).toEqual(['T1', 'T2', 'T3', 'T4']);
  });

  it('counts rows from the first (already-fetched) response toward the union', async () => {
    // The leaf's first response already carries 'seed'; the one filter tried
    // repeats a row plus a genuinely new one. 'seed' must appear in the
    // final union even though no filter ever returned it - it came from the
    // response the walk had already fetched before invoking the cover.
    const alphabet = ['T1'];
    const first = response([row('seed')]);
    const search = async (): Promise<SearchResponse> =>
      response([row('already-there'), row('fresh')]);

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 1 });
    const events = [];
    for await (const event of cover(leaf, first, search)) events.push(event);

    const final = events.at(-1);
    expect(final?.type === 'covered' || final?.type === 'abandoned').toBe(true);
    expect(final?.rows.map((r) => r.number).sort()).toEqual(['already-there', 'fresh', 'seed']);
  });

  it('skips a token rejected by the server without failing the leaf', async () => {
    const alphabet = ['BAD', 'GOOD1', 'GOOD2'];
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.partyName === 'BAD') {
        throw new RejectedQueryError('rejected', 'informe pelo menos dois nomes');
      }
      if (query.partyName === 'GOOD1') return response([row('x')]);
      return response([row('y')]);
    };

    // plateauAfter must be <= the alphabet length (3 here) or the factory
    // guard rejects it - see the dedicated guard tests below.
    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 3 });
    const events = [];
    for await (const event of cover(leaf, response([]), search)) events.push(event);

    // Budget (3 tokens) exhausted before a 5-flat plateau: abandoned, but
    // crucially the rejected token did not throw out of the generator, and
    // it still counts against the per-leaf filter budget.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('abandoned');
    if (events[0]?.type === 'abandoned') {
      expect(events[0].filtersTried).toBe(3);
      expect(events[0].rows.map((r) => r.number).sort()).toEqual(['x', 'y']);
    }
  });

  it('propagates an error that is not a RejectedQueryError', async () => {
    const alphabet = ['T1'];
    const search = async (): Promise<SearchResponse> => {
      throw new Error('network exploded');
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 1 });
    const iterator = cover(leaf, response([]), search);

    await expect(iterator.next()).rejects.toThrow('network exploded');
  });

  it('stops at maxFiltersPerLeaf even when the union is still growing and no plateau was reached', async () => {
    // Every filter keeps growing the union (never triggers plateauAfter),
    // but maxFiltersPerLeaf caps the run at 2 filters out of a 5-token
    // alphabet - the budget, not the plateau, must be what ends this leaf.
    const alphabet = ['T1', 'T2', 'T3', 'T4', 'T5'];
    let counter = 0;
    const search = async (): Promise<SearchResponse> => {
      counter += 1;
      return response([row(`case-${counter}`)]);
    };

    const calls: string[] = [];
    const wrappedSearch = async (query: Query): Promise<SearchResponse> => {
      calls.push(query.partyName ?? '');
      return search();
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 2, maxFiltersPerLeaf: 2 });
    const events = [];
    for await (const event of cover(leaf, response([]), wrappedSearch)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('abandoned');
    if (events[0]?.type === 'abandoned') {
      expect(events[0].filtersTried).toBe(2);
      expect(events[0].unionSize).toBe(2);
    }
    // Only T1 and T2 ran: T3-T5 were never reached once the budget was hit.
    expect(calls).toEqual(['T1', 'T2']);
  });

  it('rejects a plateauAfter below 1', () => {
    expect(() => createPartyTokenSweep({ plateauAfter: 0 })).toThrow(RangeError);
    expect(() => createPartyTokenSweep({ plateauAfter: -1 })).toThrow(RangeError);
  });

  it('rejects a maxFiltersPerLeaf smaller than plateauAfter', () => {
    // A budget smaller than the plateau threshold could never observe enough
    // consecutive flat filters to plateau, which would silently guarantee
    // every leaf ends abandoned - this must fail loudly instead, at
    // construction time.
    expect(() =>
      createPartyTokenSweep({ alphabet: ['T1', 'T2'], plateauAfter: 3, maxFiltersPerLeaf: 2 }),
    ).toThrow(RangeError);
  });

  it('accepts maxFiltersPerLeaf exactly equal to plateauAfter', () => {
    // The boundary case: equal is allowed, only strictly smaller is rejected.
    expect(() =>
      createPartyTokenSweep({ alphabet: ['T1', 'T2'], plateauAfter: 2, maxFiltersPerLeaf: 2 }),
    ).not.toThrow();
  });

  it('deduplicates the union across filters, including cases seen by more than one token', async () => {
    const alphabet = ['T1', 'T2', 'T3'];
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.partyName === 'T1') return response([row('a'), row('b')]);
      if (query.partyName === 'T2') return response([row('b'), row('c')]); // 'b' overlaps
      return response([row('c'), row('d')]); // 'c' overlaps
    };

    // plateauAfter must be <= the alphabet length (3 here) or the factory
    // guard rejects it - see the dedicated guard tests below.
    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 3 });
    const events = [];
    for await (const event of cover(leaf, response([]), search)) events.push(event);

    const final = events.at(-1);
    expect(final?.rows.map((r) => r.number).sort()).toEqual(['a', 'b', 'c', 'd']);
    // 4 unique rows from 3 filters that returned 6 rows total (2 overlaps).
    expect(final?.unionSize).toBe(4);
  });
});

describe('sweep integration with the party-token cover', () => {
  const catalog: JudicialClass[] = [{ id: '202', name: 'Agravo de Instrumento' }];

  function makeChain(): PartitionChain {
    return new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);
  }

  it('a leaf that day+class cannot split gets covered instead of unsplittable', async () => {
    // Single day, single class in the catalog: DateRangeSplit and
    // JudicialClassSplit both run out after one level, landing on exactly
    // the leaf the cover is for.
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.partyName === undefined) {
        // The bare day+class leaf itself saturates.
        return response([row('a'), row('b')], true);
      }
      // Every party-token filter narrows it enough on its own, but adds
      // nothing new to the union - the plateau condition is what ends this
      // leaf, not the alphabet running out.
      return response([row('a'), row('extra')]);
    };

    const cover = createPartyTokenSweep({ alphabet: ['T1', 'T2'], plateauAfter: 1 });

    const events: SweepEvent[] = [];
    for await (const event of sweep({
      from: '2025-03-12',
      to: '2025-03-12',
      search,
      chain: makeChain(),
      cover,
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'unsplittable')).toBe(false);
    const covered = events.find((e) => e.type === 'covered');
    expect(covered).toBeDefined();
    expect(covered?.query).toEqual({
      from: '2025-03-12',
      to: '2025-03-12',
      judicialClassId: '202',
      judicialClassName: 'Agravo de Instrumento',
    });
  });
});
