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

  it('wires the listed -> detailed -> stored flow, idempotently on a repeated run', async () => {
    const store = new PersistenceStore({ dataDir: dir });
    const event: SweepEvent = { type: 'window', query: dayQuery, rows: [row('case-a')], depth: 0 };
    expect(isFinalSweepEvent(event)).toBe(true);

    await store.recordFinalEvent(event);
    expect(await store.listPendingRows()).toEqual([row('case-a')]);

    await store.completeRow(makeCase('case-a'));
    expect(await store.listPendingRows()).toEqual([]);
    expect(await store.hasCase('case-a')).toBe(true);

    // Simulate a crash right after this work landed but before the run
    // recorded having done it, so the same event and case repeat: neither
    // duplicates at read time.
    await store.recordFinalEvent(event);
    await store.completeRow(makeCase('case-a'));

    expect((await store.indexCases()).size).toBe(1);
    expect((await store.rebuildSeenSet()).has('case-a')).toBe(true);
  });

  // B3: a kill between "window recorded covered" and "rows enqueued" must
  // not lose the rows - recordFinalEvent enqueues first, so even a state
  // that only got half-applied still has every row reachable.
  it('recordFinalEvent enqueues every row before recording the event itself', async () => {
    const store = new PersistenceStore({ dataDir: dir });
    await store.recordFinalEvent({ type: 'window', query: dayQuery, rows: [row('a'), row('b')], depth: 0 });

    // Both rows are reachable via the pending queue regardless of when a
    // kill could have landed - there is no window where the event is
    // recorded (seen-set covers the case) but the row is not enqueued.
    expect((await store.listPendingRows()).map((r) => r.number).sort()).toEqual(['a', 'b']);
    expect((await store.rebuildSeenSet()).has('a')).toBe(true);
  });

  it('supports the failed-document and failed-case retry cycles end to end', async () => {
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

    // B4: a case whose detail fetch itself failed (not a document download)
    // needs its own retryable record - this was the gap with no ledger at
    // all before the case-failure store existed.
    await store.recordCaseFailure({
      caseNumber: 'case-b',
      ca: 'ca-case-b',
      reason: 'UnexpectedDetailPageError',
      attempt: 1,
      retryable: true,
    });
    expect(await store.listRetryableCases()).toHaveLength(1);
    await store.recordCaseSuccess('case-b');
    expect(await store.listRetryableCases()).toEqual([]);
  });

  it('kill-and-restart: a fresh PersistenceStore over the same dir sees everything written before the kill', async () => {
    const before = new PersistenceStore({ dataDir: dir });
    await before.recordFinalEvent({ type: 'window', query: dayQuery, rows: [row('a'), row('b')], depth: 0 });
    await before.completeRow(makeCase('a'));
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
});
