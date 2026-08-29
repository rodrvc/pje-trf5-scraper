/**
 * Orchestrator tests: scripted fakes for search/detail/downloader, a real
 * temp-dir `PersistenceStore` (same style as `test/persistence-store.test.ts`),
 * no network. One test per row of the module's failure-policy table, plus
 * the happy path, the already-indexed-row dequeue, and the summary counts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreakerError, ParseError, RateLimitError, RejectedQueryError, UnexpectedDetailPageError } from '../src/domain/errors.js';
import type { CaseDocument, LegalCase, Query, SearchResponse, SearchResultRow } from '../src/domain/types.js';
import { PersistenceStore } from '../src/persistence/store.js';
import { DateRangeSplit, PartitionChain } from '../src/pipeline/partition.js';
import { Scraper, type LogSink, type OrchestratorLogEvent } from '../src/pipeline/orchestrator.js';
import type { PjeDetail } from '../src/pje/detail.js';
import type { DownloadResult, PjeDownloader } from '../src/pje/download.js';

function row(number: string): SearchResultRow {
  return { number, ca: `ca-${number}` };
}

function response(rows: SearchResultRow[], capped = false): SearchResponse {
  return { rows, capped, capSignal: { capped, byText: capped, byCount: capped, disagree: false } };
}

function doc(id: string, overrides: Partial<CaseDocument> = {}): CaseDocument {
  return {
    date: '2025-03-05',
    name: 'Despacho',
    kind: 'Decisão',
    download: {
      idBin: `bin-${id}`,
      numeroDocumento: `num-${id}`,
      nomeArqProcDocBin: `file-${id}.pdf`,
      idProcessoDocumento: id,
      actionMethod: 'method',
    },
    ...overrides,
  };
}

function legalCase(number: string, documents: CaseDocument[] = []): LegalCase {
  return {
    number,
    ca: `ca-${number}`,
    activeParties: [],
    passiveParties: [],
    movements: [],
    documents,
    sealed: false,
    extractedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A chain that never splits: every window in these tests is a single day, uncapped. */
function noopChain(): PartitionChain {
  return new PartitionChain([new DateRangeSplit()]);
}

/** Collects every logged event for assertions. */
function recordingLogger(): LogSink & { events: OrchestratorLogEvent[] } {
  const events: OrchestratorLogEvent[] = [];
  return {
    events,
    log(event) {
      events.push(event);
    },
  };
}

/** Fakes `PjeDetail.fetch` with a scripted map keyed by `ca`, or a thrown error. */
function fakeDetail(byCa: Record<string, LegalCase | Error>): PjeDetail {
  return {
    async fetch(ca: string, _expectedNumber?: string): Promise<LegalCase> {
      const outcome = byCa[ca];
      if (outcome === undefined) throw new Error(`fakeDetail: no script for ca="${ca}"`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as PjeDetail;
}

/** Fakes `PjeDownloader.download` with a scripted map keyed by document id. */
function fakeDownloader(byDocId: Record<string, DownloadResult>): PjeDownloader {
  return {
    async download(_caseNumber: string, document: CaseDocument, _ca?: string): Promise<DownloadResult> {
      const id = document.download.idProcessoDocumento;
      const outcome = byDocId[id];
      if (outcome === undefined) throw new Error(`fakeDownloader: no script for document="${id}"`);
      return outcome;
    },
  } as unknown as PjeDownloader;
}

const RANGE = { from: '2025-03-05', to: '2025-03-05' };

describe('Scraper (orchestrator)', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
    store = new PersistenceStore({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('happy path: persists the case, downloads its documents, then re-persists with localPath', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const documents = [doc('d1')];
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', documents) });
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/data/pdfs/case-a/d1.pdf', bytes: 100, skipped: false },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary).toMatchObject({
      windows: 1,
      casesListed: 1,
      casesDetailed: 1,
      casesFailed: 0,
      documentsDownloaded: 1,
      documentsFailed: 0,
    });

    const stored = await store.indexCases();
    expect(stored.get('case-a')?.documents[0]?.localPath).toBe('/data/pdfs/case-a/d1.pdf');
    expect(await store.listPendingRows()).toEqual([]);
    expect(logger.events.some((e) => e.kind === 'case-detailed')).toBe(true);
    expect(logger.events.some((e) => e.kind === 'document-downloaded')).toBe(true);
  });

  it('dequeues a row already in the case index without a detail fetch', async () => {
    // Pre-populate the case index as if an earlier pass in this same run
    // already fetched it (e.g. a re-listed window).
    await store.completeRow(legalCase('case-a'));
    await store.enqueueRow(row('case-a'));

    const search = async (_query: Query): Promise<SearchResponse> => response([]);
    const detail = fakeDetail({}); // no script: a call would throw and fail the test
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.casesDetailed).toBe(0);
    expect(await store.listPendingRows()).toEqual([]);
  });

  it('policy: detail throws ParseError -> recordCaseFailure(retryable: true), continues to the next row', async () => {
    const search = async (_query: Query): Promise<SearchResponse> =>
      response([row('case-bad'), row('case-good')]);
    const detail = fakeDetail({
      'ca-case-bad': new ParseError('missing case number', 'missing case number'),
      'ca-case-good': legalCase('case-good'),
    });
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.casesFailed).toBe(1);
    expect(summary.casesDetailed).toBe(1);
    expect(await store.listRetryableCases()).toMatchObject([{ caseNumber: 'case-bad', retryable: true }]);
    expect(await store.hasCase('case-good')).toBe(true);
    expect(logger.events.some((e) => e.kind === 'case-failed' && e.number === 'case-bad')).toBe(true);
  });

  it('policy: detail throws UnexpectedDetailPageError -> recordCaseFailure(retryable: true), continues', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-bad')]);
    const detail = fakeDetail({
      'ca-case-bad': new UnexpectedDetailPageError('neither ordinary nor sealed', 'db error page'),
    });
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.casesFailed).toBe(1);
    expect(await store.listRetryableCases()).toMatchObject([{ caseNumber: 'case-bad', retryable: true }]);
  });

  it('policy: an unknown error from detail (e.g. RateLimitError exhausted) is recorded, not aborted, and the next row still runs', async () => {
    const search = async (_query: Query): Promise<SearchResponse> =>
      response([row('case-bad'), row('case-good')]);
    const detail = fakeDetail({
      'ca-case-bad': new RateLimitError('429 after 5 retries'),
      'ca-case-good': legalCase('case-good'),
    });
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.casesFailed).toBe(1);
    expect(summary.casesDetailed).toBe(1);
    expect(await store.listRetryableCases()).toMatchObject([
      { caseNumber: 'case-bad', retryable: true, reason: expect.stringContaining('RateLimitError') },
    ]);
    expect(await store.hasCase('case-good')).toBe(true);
  });

  it('policy: RejectedQueryError from search is recorded as a sweep failure, run continues', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => {
      throw new RejectedQueryError('rejected', 'server message');
    };
    const detail = fakeDetail({});
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.windows).toBe(0);
    expect(logger.events.some((e) => e.kind === 'sweep-rejected')).toBe(true);
  });

  it('policy: a document failure is recorded and the run continues to the next document', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const documents = [doc('d1'), doc('d2')];
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', documents) });
    const downloader = fakeDownloader({
      d1: { ok: false, reason: 'HTTP 429', status: 429, retryable: true, sessionAttempts: 1 },
      d2: { ok: true, path: '/data/pdfs/case-a/d2.pdf', bytes: 50, skipped: false },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.documentsFailed).toBe(1);
    expect(summary.documentsDownloaded).toBe(1);
    expect(await store.listRetryableDocuments()).toMatchObject([
      { caseNumber: 'case-a', documentId: 'd1', retryable: true },
    ]);
  });

  it('policy: CircuitBreakerError aborts the run cleanly, rethrowing after finishing in-flight writes', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', [doc('d1')]) });
    const downloader = {
      async download(): Promise<DownloadResult> {
        throw new CircuitBreakerError('too many 429s');
      },
    } as unknown as PjeDownloader;
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });

    await expect(scraper.run(RANGE)).rejects.toBeInstanceOf(CircuitBreakerError);
    // The case detail itself was already persisted before the download step ran.
    expect(await store.hasCase('case-a')).toBe(true);
    expect(logger.events.some((e) => e.kind === 'run-aborted')).toBe(true);
  });

  it('summary: counts windows, listed/detailed/failed cases and downloaded/skipped/failed documents', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a'), row('case-b')]);
    const detail = fakeDetail({
      'ca-case-a': legalCase('case-a', [doc('d1')]),
      'ca-case-b': new ParseError('bad', 'bad'),
    });
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/x/d1.pdf', bytes: 1, skipped: true },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary).toEqual({
      windows: 1,
      casesListed: 2,
      casesDetailed: 1,
      casesFailed: 1,
      documentsDownloaded: 0,
      documentsSkipped: 1,
      documentsFailed: 0,
      retries429: 0,
    });
  });
});
