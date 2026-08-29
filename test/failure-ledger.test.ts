import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FailureLedger } from '../src/persistence/failure-ledger.js';

describe('FailureLedger', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'failure-ledger-test-'));
    path = join(dir, 'ledger.ndjson');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a retryable failure, clears it on success, and re-adds it on a later failure', async () => {
    const ledger = new FailureLedger<{ note: string }>(path);
    await ledger.recordFailure({
      key: 'k',
      reason: 'HTTP 429',
      attempt: 1,
      retryable: true,
      detail: { note: 'first' },
    });
    expect(await ledger.listRetryable()).toMatchObject([{ key: 'k', attempt: 1 }]);

    await ledger.recordSuccess('k');
    expect(await ledger.listRetryable()).toEqual([]);

    await ledger.recordFailure({
      key: 'k',
      reason: 'HTTP 429 again',
      attempt: 2,
      retryable: true,
      detail: { note: 'second' },
    });
    const retryable = await ledger.listRetryable();
    expect(retryable).toHaveLength(1);
    expect(retryable[0]?.attempt).toBe(2);
  });

  it('excludes a non-retryable failure and keeps distinct keys independent, surviving a restart', async () => {
    const first = new FailureLedger<{ note: string }>(path);
    await first.recordFailure({
      key: 'permanent',
      reason: 'HTTP 404',
      attempt: 1,
      retryable: false,
      detail: { note: 'x' },
    });
    await first.recordFailure({
      key: 'retryable',
      reason: 'HTTP 500',
      attempt: 1,
      retryable: true,
      detail: { note: 'y' },
    });

    // New instance over the same path simulates a restart.
    const second = new FailureLedger<{ note: string }>(path);
    const retryable = await second.listRetryable();
    expect(retryable.map((r) => r.key)).toEqual(['retryable']);
  });
});
