import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFinalSweepEvent, PersistenceStore } from '../src/persistence/store.js';
import type { SweepEvent } from '../src/pipeline/sweep.js';
import type { LegalCase, Query, SearchResultRow } from '../src/domain/types.js';

function row(number: string): SearchResultRow {
  return { number, ca: `ca-${number}` };
}

function makeCase(number: string): LegalCase {
  return {
    number,
    ca: `ca-${number}`,
    activeParties: [],
    passiveParties: [],
    movements: [],
    documents: [],
    sealed: false,
    extractedAt: '2026-01-01T00:00:00.000Z',
  };
}

const dayQuery: Query = { from: '2025-03-11', to: '2025-03-11' };

describe('PersistenceStore (façade)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'persistence-store-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('wires the full listed -> detailed -> stored flow', async () => {
    const store = new PersistenceStore({ dataDir: dir });

    const event: SweepEvent = { type: 'window', query: dayQuery, rows: [row('case-a')], depth: 0 };
    expect(isFinalSweepEvent(event)).toBe(true);
    await store.recordSweepEvent(event);

    for (const r of event.rows) {
      if (!(await store.hasCase(r.number))) await store.enqueueRow(r);
    }
    expect(await store.listPendingRows()).toEqual([row('case-a')]);

    // Simulate fetching detail and storing it.
    await store.appendCase(makeCase('case-a'));
    await store.dequeueRow('case-a');

    expect(await store.listPendingRows()).toEqual([]);
    expect(await store.hasCase('case-a')).toBe(true);
  });

  it('supports the failed-document retry cycle end to end', async () => {
    const store = new PersistenceStore({ dataDir: dir });

    await store.recordDocumentFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: {
        idBin: 'bin',
        numeroDocumento: 'doc',
        nomeArqProcDocBin: 'file.pdf',
        idProcessoDocumento: 'doc-1',
        actionMethod: 'method',
      },
      reason: 'HTTP 429',
      httpStatus: 429,
      attempt: 1,
      retryable: true,
    });

    expect(await store.listRetryableDocuments()).toHaveLength(1);

    await store.recordDocumentSuccess('case-a', 'doc-1');
    expect(await store.listRetryableDocuments()).toEqual([]);
  });

  it('kill-and-restart: a fresh PersistenceStore over the same dir sees everything written before the kill', async () => {
    const before = new PersistenceStore({ dataDir: dir });
    await before.recordSweepEvent({ type: 'window', query: dayQuery, rows: [row('a'), row('b')], depth: 0 });
    await before.enqueueRow(row('a'));
    await before.enqueueRow(row('b'));
    await before.dequeueRow('a');
    await before.appendCase(makeCase('a'));
    // 'b' never got its detail fetched before the simulated kill.

    const after = new PersistenceStore({ dataDir: dir });
    expect(await after.hasCase('a')).toBe(true);
    expect(await after.hasCase('b')).toBe(false);
    expect((await after.listPendingRows()).map((r) => r.number)).toEqual(['b']);

    const seen = await after.rebuildSeenSet();
    expect(seen.has('a')).toBe(true);
    expect(seen.has('b')).toBe(true);

    const isCovered = await after.rebuildCoveredPredicate();
    expect(isCovered(dayQuery)).toBe(true);
  });

  it('re-recording the same sweep event and re-appending the same case duplicates nothing at read time', async () => {
    const store = new PersistenceStore({ dataDir: dir });
    const event: SweepEvent = { type: 'window', query: dayQuery, rows: [row('a')], depth: 0 };

    // Simulate a crash right after the sweep event and case were persisted,
    // but before the run recorded that it had - so the same work repeats.
    await store.recordSweepEvent(event);
    await store.appendCase(makeCase('a'));
    await store.recordSweepEvent(event);
    await store.appendCase(makeCase('a'));

    const cases = await store.indexCases();
    expect(cases.size).toBe(1);

    const seen = await store.rebuildSeenSet();
    expect(seen.has('a')).toBe(true);
  });
});
