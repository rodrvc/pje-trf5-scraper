import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FailedDocumentStore } from '../src/persistence/failed-document-store.js';

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

  it('round-trips a failure record into listRetryable', async () => {
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

    const retryable = await store.listRetryable();
    expect(retryable).toHaveLength(1);
    expect(retryable[0]).toMatchObject({ caseNumber: 'case-a', documentId: 'doc-1', attempt: 1 });
  });

  it('excludes a failure marked non-retryable (e.g. a permanent 404)', async () => {
    const store = new FailedDocumentStore(dir);
    await store.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: downloadRef('doc-1'),
      reason: 'HTTP 404',
      httpStatus: 404,
      attempt: 1,
      retryable: false,
    });

    expect(await store.listRetryable()).toEqual([]);
  });

  it('a later success record clears a document from the retryable list', async () => {
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
    await store.recordSuccess('case-a', 'doc-1');

    expect(await store.listRetryable()).toEqual([]);
  });

  it('a failure after a success re-adds the document to the retryable list', async () => {
    const store = new FailedDocumentStore(dir);
    await store.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: downloadRef('doc-1'),
      reason: 'HTTP 429',
      attempt: 1,
      retryable: true,
    });
    await store.recordSuccess('case-a', 'doc-1');
    await store.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: downloadRef('doc-1'),
      reason: 'HTTP 429 again',
      attempt: 2,
      retryable: true,
    });

    const retryable = await store.listRetryable();
    expect(retryable).toHaveLength(1);
    expect(retryable[0]?.attempt).toBe(2);
  });

  it('keeps distinct documents of the same case independent', async () => {
    const store = new FailedDocumentStore(dir);
    await store.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: downloadRef('doc-1'),
      reason: 'HTTP 429',
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
    expect(retryable.map((r) => r.documentId)).toEqual(['doc-2']);
  });

  it('survives a simulated restart (new store instance, same dir)', async () => {
    const first = new FailedDocumentStore(dir);
    await first.recordFailure({
      caseNumber: 'case-a',
      documentId: 'doc-1',
      downloadRef: downloadRef('doc-1'),
      reason: 'HTTP 429',
      attempt: 1,
      retryable: true,
    });

    const second = new FailedDocumentStore(dir);
    expect(await second.listRetryable()).toHaveLength(1);
  });
});
