import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFinalSweepEvent, SweepProgressStore } from '../src/persistence/sweep-progress-store.js';
import type { SweepEvent } from '../src/pipeline/sweep.js';
import type { Query, SearchResultRow } from '../src/domain/types.js';

function row(number: string): SearchResultRow {
  return { number, ca: `ca-${number}` };
}

const dayQuery: Query = { from: '2025-03-11', to: '2025-03-11' };
const classQuery: Query = { ...dayQuery, judicialClassId: '202', judicialClassName: 'Agravo' };

describe('isFinalSweepEvent', () => {
  it('accepts window/unsplittable/covered/abandoned and rejects capped', () => {
    const capped: SweepEvent = { type: 'capped', query: dayQuery, rows: [], depth: 0, splitBy: 'x' };
    const win: SweepEvent = { type: 'window', query: dayQuery, rows: [], depth: 0 };
    expect(isFinalSweepEvent(capped)).toBe(false);
    expect(isFinalSweepEvent(win)).toBe(true);
  });
});

describe('SweepProgressStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweep-progress-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects recording a non-final (capped) event', async () => {
    const store = new SweepProgressStore(dir);
    const capped: SweepEvent = {
      type: 'capped',
      query: dayQuery,
      rows: [row('a')],
      depth: 0,
      splitBy: 'judicial-class',
    };
    await expect(store.recordEvent(capped)).rejects.toThrow();
  });

  it('round-trips a window event, reducing rows to CNJ numbers', async () => {
    const store = new SweepProgressStore(dir);
    const event: SweepEvent = {
      type: 'window',
      query: dayQuery,
      rows: [row('a'), row('b')],
      depth: 0,
    };
    await store.recordEvent(event);

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: 'window', query: dayQuery, depth: 0, cnjNumbers: ['a', 'b'] });
    expect(typeof all[0]?.recordedAt).toBe('string');
  });

  it('persists filtersTried/unionSize for covered and abandoned events', async () => {
    const store = new SweepProgressStore(dir);
    const covered: SweepEvent = {
      type: 'covered',
      query: classQuery,
      rows: [row('a')],
      depth: 1,
      filtersTried: 3,
      unionSize: 1,
      plateaued: true,
    };
    await store.recordEvent(covered);

    const all = await store.all();
    expect(all[0]).toMatchObject({ type: 'covered', filtersTried: 3, unionSize: 1 });
  });

  it('rebuilds a SeenSet from every final event recorded so far (survives a restart)', async () => {
    const first = new SweepProgressStore(dir);
    await first.recordEvent({ type: 'window', query: dayQuery, rows: [row('a'), row('b')], depth: 0 });

    const second = new SweepProgressStore(dir);
    const seen = await second.rebuildSeenSet();
    expect(seen.has('a')).toBe(true);
    expect(seen.has('b')).toBe(true);
    expect(seen.has('c')).toBe(false);

    seen.add('c');
    expect(seen.has('c')).toBe(true);
  });

  it('rebuilds a window-covered predicate that matches only exact recorded windows', async () => {
    const store = new SweepProgressStore(dir);
    await store.recordEvent({ type: 'window', query: classQuery, rows: [row('a')], depth: 1 });

    const isCovered = await store.rebuildCoveredPredicate();
    expect(isCovered(classQuery)).toBe(true);
    // The bare day query was never itself a final event (it was capped and
    // split) - the predicate must not claim it is covered too.
    expect(isCovered(dayQuery)).toBe(false);
    expect(isCovered({ ...classQuery, judicialClassId: '283' })).toBe(false);
  });

  it('excludes abandoned leaves from the covered predicate, so they are re-attempted on the next run (9b)', async () => {
    const store = new SweepProgressStore(dir);
    await store.recordEvent({
      type: 'abandoned',
      query: classQuery,
      rows: [row('a')],
      depth: 1,
      filtersTried: 26,
      unionSize: 1,
    });

    const isCovered = await store.rebuildCoveredPredicate();
    // Unlike window/unsplittable/covered, an abandoned leaf is known
    // incomplete: a later run (possibly with a bigger cover budget) must
    // still walk into it rather than skip it forever.
    expect(isCovered(classQuery)).toBe(false);

    // Its rows are still registered as seen, so dedup is unaffected.
    const seen = await store.rebuildSeenSet();
    expect(seen.has('a')).toBe(true);
  });

  it('absorbs the abandoned-leaf record format previously covered by pipeline/uncoverable.ts', async () => {
    const store = new SweepProgressStore(dir);
    const abandoned: SweepEvent = {
      type: 'abandoned',
      query: classQuery,
      rows: [row('a'), row('b')],
      depth: 1,
      filtersTried: 26,
      unionSize: 2,
    };
    await store.recordEvent(abandoned);

    const all = await store.all();
    expect(all[0]).toMatchObject({
      type: 'abandoned',
      query: classQuery,
      depth: 1,
      filtersTried: 26,
      unionSize: 2,
      cnjNumbers: ['a', 'b'],
    });
  });
});
