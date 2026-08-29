import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaseFailureStore } from '../src/persistence/case-failure-store.js';

// Generic failure/success/latest-wins semantics are covered once at the
// FailureLedger level (failure-ledger.test.ts); this only checks the
// case-specific wiring - a case number is the key directly (no composition
// needed, unlike documents) and the `ca` token round-trips in `detail`.
describe('CaseFailureStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'case-failure-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records a failed detail fetch and clears it once a retry succeeds', async () => {
    const store = new CaseFailureStore(dir);
    await store.recordFailure({
      caseNumber: 'case-a',
      ca: 'ca-token-abc',
      reason: 'UnexpectedDetailPageError: database error page',
      attempt: 1,
      retryable: true,
    });

    const retryable = await store.listRetryable();
    expect(retryable).toEqual([
      {
        caseNumber: 'case-a',
        ca: 'ca-token-abc',
        reason: 'UnexpectedDetailPageError: database error page',
        attempt: 1,
        retryable: true,
        recordedAt: expect.any(String),
      },
    ]);

    await store.recordSuccess('case-a');
    expect(await store.listRetryable()).toEqual([]);
  });
});
