import { describe, expect, it } from 'vitest';

import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../src/pipeline/partition.js';
import { sweep, type SweepEvent } from '../src/pipeline/sweep.js';
import type { JudicialClass, Query, SearchResponse, SearchResultRow } from '../src/domain/types.js';

/** Builds a row with a given CNJ-shaped number, the only field the sweep inspects. */
function row(number: string): SearchResultRow {
  return { number, ca: `ca-${number}` };
}

/** Wraps rows into a SearchResponse, capped when it hits (or exceeds) the site's cap. */
function response(rows: SearchResultRow[], capped: boolean): SearchResponse {
  return {
    rows,
    capped,
    capSignal: { capped, byText: capped, byCount: capped, disagree: false },
  };
}

const catalog: JudicialClass[] = [
  { id: '202', name: 'Agravo de Instrumento' },
  { id: '283', name: 'Apelação Cível' },
];

function chain(): PartitionChain {
  return new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);
}

async function collect(events: AsyncGenerator<SweepEvent>): Promise<SweepEvent[]> {
  const out: SweepEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('sweep', () => {
  it('splits a capped range by date until nothing caps', async () => {
    // 2025-03-11..2025-03-12: whole range caps, each single day does not.
    const calls: Query[] = [];
    const search = async (query: Query): Promise<SearchResponse> => {
      calls.push(query);
      if (query.from === query.to) {
        return response([row(`case-${query.from}-a`)], false);
      }
      return response([row('case-range-1')], true);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-12', search, chain: chain() }),
    );

    expect(calls).toEqual([
      { from: '2025-03-11', to: '2025-03-12' },
      { from: '2025-03-12', to: '2025-03-12' },
      { from: '2025-03-11', to: '2025-03-11' },
    ]);

    const leafEvents = events.filter((e) => e.type === 'window' && !e.capped);
    expect(leafEvents).toHaveLength(2);
    expect(events.some((e) => e.type === 'window' && e.capped)).toBe(true);
  });

  it('covers the most recent day first, not the earliest, for a multi-day range', async () => {
    // The requirement is "walk from the present backwards": a short or
    // interrupted run should still have covered the latest slice of the
    // range. Assert directly on event order, not just on which queries ran.
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.from === query.to) return response([row(`case-${query.from}`)], false);
      return response([row('case-range')], true);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-12', search, chain: chain() }),
    );

    const finalWindows = events.filter(
      (e) => e.type === 'window' && !e.capped,
    ) as Extract<SweepEvent, { type: 'window'; capped: false }>[];

    expect(finalWindows[0]?.query).toEqual({ from: '2025-03-12', to: '2025-03-12' });
    expect(finalWindows[1]?.query).toEqual({ from: '2025-03-11', to: '2025-03-11' });
  });

  it('splits by class when a single day caps under dates alone', async () => {
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.judicialClassId === undefined) {
        // The bare day caps: date axis is exhausted (from === to).
        return response([row('a'), row('b')], true);
      }
      // Any class narrows it enough.
      return response([row(`class-${query.judicialClassId}`)], false);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-11', search, chain: chain() }),
    );

    const cappedDayEvent = events.find((e) => e.type === 'window' && e.capped);
    expect(cappedDayEvent).toMatchObject({ splitBy: 'judicial-class' });

    const classLeaves = events.filter(
      (e) => e.type === 'window' && !e.capped,
    ) as Extract<SweepEvent, { type: 'window'; capped: false }>[];
    expect(classLeaves).toHaveLength(catalog.length);
  });

  it('emits an unsplittable event, not a swallowed result, when day+class still caps', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => {
      // Everything caps: the day, and every class within it.
      return response([row('x'), row('y')], true);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-11', search, chain: chain() }),
    );

    const unsplittable = events.filter((e) => e.type === 'unsplittable');
    // One per class leaf that still caps with no strategy left.
    expect(unsplittable).toHaveLength(catalog.length);
    for (const event of unsplittable) {
      expect(event.query.judicialClassId).toBeDefined();
      expect(event.query.from).toBe('2025-03-11');
    }
  });

  it('deduplicates rows by CNJ number across final events only', async () => {
    // Same case surfaces both under the bare (capped) day and under one of its
    // class splits, which is the realistic scenario the cap-then-split walk
    // produces: the capped-day event and a class window can share rows.
    //
    // Only final events (window/capped:false, unsplittable) count for
    // deduplication and for "what the run actually found" - a capped window's
    // rows are informational only (see SweepEvent's doc comment), so
    // `day-only`, which this fake never returns again once it is split, is
    // legitimately absent from the final output: that gap is exactly what the
    // further splits (or, if none applied, the `unsplittable` event) exist to
    // surface, not something this test should paper over.
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.judicialClassId === undefined) {
        return response([row('shared'), row('day-only')], true);
      }
      if (query.judicialClassId === '202') {
        return response([row('shared'), row('class-202-only')], false);
      }
      return response([row('class-283-only')], false);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-11', search, chain: chain() }),
    );

    const finalEvents = events.filter((e) => e.type === 'unsplittable' || !e.capped);
    const finalNumbers = finalEvents.flatMap((e) => e.rows.map((r) => r.number));
    const counts = new Map<string, number>();
    for (const n of finalNumbers) counts.set(n, (counts.get(n) ?? 0) + 1);

    expect(counts.get('shared')).toBe(1);
    expect(counts.get('day-only')).toBeUndefined();
    expect(counts.get('class-202-only')).toBe(1);
    expect(counts.get('class-283-only')).toBe(1);

    // The capped (non-final) window still carries its raw rows, unaffected by
    // dedup against later final events - it is informational, not truncated.
    const cappedEvent = events.find((e) => e.type === 'window' && e.capped);
    expect(cappedEvent?.rows.map((r) => r.number).sort()).toEqual(['day-only', 'shared']);
  });

  it('does not treat a capped window as final: its rows still reach the child final event', async () => {
    // A capped window's rows must be informational only, not "seen". If the
    // walk registered them as seen at the capped event, the child's identical
    // rows would look like duplicates and get silently dropped - exactly the
    // trap the issue's own framing warns about ("a capped query is a signal
    // to narrow, not a result").
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.judicialClassId === undefined) {
        // The bare day caps, and (unrealistically, but this is the point)
        // returns exactly the same rows every child will also return.
        return response([row('shared-a'), row('shared-b')], true);
      }
      if (query.judicialClassId === '202') {
        return response([row('shared-a'), row('shared-b')], false);
      }
      return response([], false);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-11', search, chain: chain() }),
    );

    const cappedEvent = events.find((e) => e.type === 'window' && e.capped);
    expect(cappedEvent?.rows.map((r) => r.number).sort()).toEqual(['shared-a', 'shared-b']);

    const class202Event = events.find(
      (e) => e.type === 'window' && !e.capped && e.query.judicialClassId === '202',
    );
    // The child's final event still carries both rows: they were not marked
    // "seen" by the parent's (non-final) capped event.
    expect(class202Event?.rows.map((r) => r.number).sort()).toEqual(['shared-a', 'shared-b']);
  });

  it('logs an event for every window covered, including capped intermediate ones', async () => {
    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.from !== query.to) return response([row('r')], true);
      if (query.judicialClassId === undefined) return response([row('a'), row('b')], true);
      return response([row(`c-${query.judicialClassId}`)], false);
    };

    const events = await collect(
      sweep({ from: '2025-03-11', to: '2025-03-12', search, chain: chain() }),
    );

    // Root range (capped) + 2 days (each capped, split by class) + 2 classes
    // per day (uncapped leaves) = 1 + 2 + 4 = 7 windows.
    expect(events).toHaveLength(7);
    expect(events.filter((e) => e.type === 'window' && e.capped)).toHaveLength(3);
    expect(events.filter((e) => e.type === 'window' && !e.capped)).toHaveLength(4);

    // depth increases with each split: root=0, day=1, class=2.
    const byDepth = new Map<number, number>();
    for (const e of events) byDepth.set(e.depth, (byDepth.get(e.depth) ?? 0) + 1);
    expect(byDepth.get(0)).toBe(1);
    expect(byDepth.get(1)).toBe(2);
    expect(byDepth.get(2)).toBe(4);
  });
});
