import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PendingStore } from '../src/persistence/pending-store.js';
import type { SearchResultRow } from '../src/domain/types.js';

function row(number: string): SearchResultRow {
  return { number, ca: `ca-${number}` };
}

describe('PendingStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pending-store-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips an enqueued row', async () => {
    const store = new PendingStore(dir);
    await store.enqueue(row('case-a'));

    const pending = await store.listPending();
    expect(pending).toEqual([row('case-a')]);
  });

  it('removes a row from the pending list once dequeued', async () => {
    const store = new PendingStore(dir);
    await store.enqueue(row('case-a'));
    await store.enqueue(row('case-b'));
    await store.dequeue('case-a');

    const pending = await store.listPending();
    expect(pending.map((r) => r.number)).toEqual(['case-b']);
  });

  it('survives a simulated restart: pending state rebuilt from disk', async () => {
    const first = new PendingStore(dir);
    await first.enqueue(row('case-a'));
    await first.enqueue(row('case-b'));
    await first.dequeue('case-a');

    const second = new PendingStore(dir);
    const pending = await second.listPending();
    expect(pending.map((r) => r.number)).toEqual(['case-b']);
  });

  it('is idempotent: enqueuing the same row twice does not duplicate it, latest wins', async () => {
    const store = new PendingStore(dir);
    await store.enqueue({ number: 'case-a', ca: 'ca-old' });
    await store.enqueue({ number: 'case-a', ca: 'ca-fresh' });

    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ca).toBe('ca-fresh');
  });

  it('is idempotent: dequeuing the same number twice is harmless', async () => {
    const store = new PendingStore(dir);
    await store.enqueue(row('case-a'));
    await store.dequeue('case-a');
    await store.dequeue('case-a');

    expect(await store.listPending()).toEqual([]);
  });

  it('leaves other rows pending when only one is dequeued after a kill-and-restart', async () => {
    // Simulates the acceptance criterion: kill between "listed" and
    // "detailed" for one row must not lose or duplicate any other row.
    const first = new PendingStore(dir);
    await first.enqueue(row('a'));
    await first.enqueue(row('b'));
    await first.enqueue(row('c'));
    await first.dequeue('b'); // 'b' got detailed before the kill

    const second = new PendingStore(dir);
    const pending = (await second.listPending()).map((r) => r.number).sort();
    expect(pending).toEqual(['a', 'c']);
  });
});
