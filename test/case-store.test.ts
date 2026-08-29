import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaseStore } from '../src/persistence/case-store.js';
import type { LegalCase } from '../src/domain/types.js';

function makeCase(overrides: Partial<LegalCase> = {}): LegalCase {
  return {
    number: '0000462-42.2023.8.17.3480',
    ca: 'ca-token-abc',
    activeParties: [],
    passiveParties: [],
    movements: [],
    documents: [],
    sealed: false,
    extractedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('CaseStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'case-store-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a case through append and index', async () => {
    const store = new CaseStore(dir);
    const legalCase = makeCase();

    await store.append(legalCase);

    const index = await store.index();
    expect(index.get(legalCase.number)).toEqual(legalCase);
  });

  it('rebuilds the index after a simulated restart (new store instance, same dir)', async () => {
    const first = new CaseStore(dir);
    await first.append(makeCase());

    const second = new CaseStore(dir);
    expect(await second.has('0000462-42.2023.8.17.3480')).toBe(true);
  });

  it('is idempotent at read time when the same case is appended twice: latest wins', async () => {
    const store = new CaseStore(dir);
    await store.append(makeCase({ sealed: false }));
    await store.append(makeCase({ sealed: true })); // e.g. re-fetched with a fix

    const index = await store.index();
    expect(index.size).toBe(1);
    expect(index.get('0000462-42.2023.8.17.3480')?.sealed).toBe(true);
  });

  it('keeps distinct cases separate', async () => {
    const store = new CaseStore(dir);
    await store.append(makeCase({ number: 'case-a' }));
    await store.append(makeCase({ number: 'case-b' }));

    const all = await store.all();
    expect(all.map((c) => c.number).sort()).toEqual(['case-a', 'case-b']);
  });

  it('rebuilds a 10k-line file reasonably fast', async () => {
    const store = new CaseStore(dir);
    for (let i = 0; i < 10_000; i++) {
      await store.append(makeCase({ number: `case-${i}` }));
    }

    const start = Date.now();
    const index = await store.index();
    const elapsed = Date.now() - start;

    expect(index.size).toBe(10_000);
    expect(elapsed).toBeLessThan(2000);
  }, 20_000);
});
