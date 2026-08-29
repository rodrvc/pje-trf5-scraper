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
    const alphabet = ['T1', 'T2', 'T3'];
    let counter = 0;
    const search = async (): Promise<SearchResponse> => {
      counter += 1;
      return response([row(`case-${counter}`)]);
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 5 });
    const events = [];
    for await (const event of cover(leaf, response([]), search)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('abandoned');
    if (events[0]?.type === 'abandoned') {
      expect(events[0].filtersTried).toBe(3);
      expect(events[0].unionSize).toBe(3);
    }
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

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 5 });
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

  it('deduplicates the union across filters, including cases seen by more than one token', async () => {
    const alphabet = ['T1', 'T2', 'T3'];
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.partyName === 'T1') return response([row('a'), row('b')]);
      if (query.partyName === 'T2') return response([row('b'), row('c')]); // 'b' overlaps
      return response([row('c'), row('d')]); // 'c' overlaps
    };

    const cover = createPartyTokenSweep({ alphabet, plateauAfter: 5 });
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
