import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FailedDocumentStore } from '../src/persistence/failed-document-store.js';

// Generic failure/success/latest-wins semantics are covered once, at the
// FailureLedger level (failure-ledger.test.ts). This file only checks the
// document-specific wiring on top: the caseNumber::documentId key
// composition (so two documents of the same case don't collide) and that
// `detail` round-trips flattened back into the caller-facing record shape.
function downloadRef(documentId: string) {
  return {
    idBin: 'bin-1',
    numeroDocumento: 'doc-1',
    nomeArqProcDocBin: 'Despacho.pdf',
    idProcessoDocumento: documentId,
    actionMethod: 'cN9ABC',
  };
}

describe('FailedDocumentStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'failed-document-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a failure, flattened with caseNumber/documentId/downloadRef, keyed per document', async () => {
    const store = new FailedDocumentStore(dir);
    await store.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: downloadRef('doc-1'),
      reason: 'HTTP 429',
      httpStatus: 429,
      attempt: 1,
      retryable: true,
    });
    await store.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-2',
      downloadRef: downloadRef('doc-2'),
      reason: 'HTTP 500',
      attempt: 1,
      retryable: true,
    });
    await store.recordSuccess('case-a', 'doc-1');

    const retryable = await store.listRetryable();
    expect(retryable).toEqual([
      {
        caseNumber: 'case-a',
        documentId: 'doc-2',
        downloadRef: downloadRef('doc-2'),
        reason: 'HTTP 500',
        attempt: 1,
        retryable: true,
        recordedAt: expect.any(String),
      },
    ]);
  });
});
