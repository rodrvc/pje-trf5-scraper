/**
 * Orchestrator tests: scripted fakes for search/detail/downloader (typed
 * against the `DetailFetcher`/`DocumentDownloader` seams, not the concrete
 * `PjeDetail`/`PjeDownloader`), a real temp-dir `PersistenceStore` (same
 * style as `test/persistence-store.test.ts`), no network. One test per row
 * of the module's failure-policy table, plus the happy path, the crash
 * safety around detail-then-downloads, the already-indexed-row resume path,
 * and the summary counts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreakerError, ParseError, RateLimitError, RejectedQueryError, UnexpectedDetailPageError } from '../src/domain/errors.js';
import type { CaseDocument, LegalCase, Query, SearchResponse, SearchResultRow } from '../src/domain/types.js';
import { PersistenceStore } from '../src/persistence/store.js';
import { DateRangeSplit, PartitionChain } from '../src/pipeline/partition.js';
import {
  RunAbortedError,
  Scraper,
  type DetailFetcher,
  type DocumentDownloader,
  type LogSink,
  type OrchestratorLogEvent,
} from '../src/pipeline/orchestrator.js';
import type { DownloadResult } from '../src/pje/download.js';

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

/** Fakes `DetailFetcher.fetch` with a scripted map keyed by `ca`, or a thrown error. */
function fakeDetail(byCa: Record<string, LegalCase | Error>): DetailFetcher {
  return {
    async fetch(ca: string, _expectedNumber?: string): Promise<LegalCase> {
      const outcome = byCa[ca];
      if (outcome === undefined) throw new Error(`fakeDetail: no script for ca="${ca}"`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

/**
 * Fakes `DocumentDownloader.download` with a scripted map keyed by document
 * id. Records every call so a test can assert a document was (or was not)
 * re-attempted. Mimics `PjeDownloader.download`'s own "already a valid file
 * on disk" branch: a document that already carries a `localPath` is
 * reported as a free, skipped success without consuming a script entry -
 * exactly what makes re-running `downloadDocuments` over an already-indexed
 * case cheap for its already-downloaded documents (see the module comment).
 */
function fakeDownloader(byDocId: Record<string, DownloadResult>): DocumentDownloader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async download(_caseNumber: string, document: CaseDocument, _ca?: string): Promise<DownloadResult> {
      const id = document.download.idProcessoDocumento;
      calls.push(id);
      if (document.localPath !== undefined) {
        return { ok: true, path: document.localPath, bytes: 0, skipped: true };
      }
      const outcome = byDocId[id];
      if (outcome === undefined) throw new Error(`fakeDownloader: no script for document="${id}"`);
      return outcome;
    },
  };
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

  it('happy path: persists the case, downloads its documents, then completes the row with localPath filled in', async () => {
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
      casesOnDisk: 1,
      pendingRows: 0,
    });

    const stored = await store.indexCases();
    expect(stored.get('case-a')?.documents[0]?.localPath).toBe('/data/pdfs/case-a/d1.pdf');
    expect(await store.listPendingRows()).toEqual([]);
    expect(logger.events.some((e) => e.kind === 'case-detailed')).toBe(true);
    expect(logger.events.some((e) => e.kind === 'document-downloaded')).toBe(true);
  });

  it('crash safety: the case is stored (still pending) before downloads, and dequeued only once after', async () => {
    // A store wrapper that snapshots the case's own localPath at each call
    // that writes it - appendCase (pre-download) and completeRow
    // (post-download) - so the test can assert the ORDER: the first stored
    // record has no localPath, the second (the one that also dequeues) does.
    const localPathSnapshots: (string | undefined)[] = [];
    const originalAppendCase = store.appendCase.bind(store);
    const originalCompleteRow = store.completeRow.bind(store);
    store.appendCase = async (legalCase: LegalCase) => {
      localPathSnapshots.push(legalCase.documents[0]?.localPath);
      return originalAppendCase(legalCase);
    };
    store.completeRow = async (legalCase: LegalCase) => {
      localPathSnapshots.push(legalCase.documents[0]?.localPath);
      return originalCompleteRow(legalCase);
    };

    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', [doc('d1')]) });
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/data/pdfs/case-a/d1.pdf', bytes: 100, skipped: false },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    await scraper.run(RANGE);

    // The first write (appendCase, pre-download) carries no localPath yet;
    // the second (completeRow, post-download, which also dequeues) does.
    expect(localPathSnapshots).toEqual([undefined, '/data/pdfs/case-a/d1.pdf']);
    expect(await store.listPendingRows()).toEqual([]);
  });

  it('resume: a row already in the case index re-attempts only its missing document, then dequeues', async () => {
    // Simulate a case whose detail was already stored (with one document
    // already downloaded) but whose row is still pending - the exact state
    // a kill between "documents downloaded" and "final completeRow" would
    // leave behind before this PR's fix, and the exact state a resumed run
    // (9b) finds for a row an earlier run left mid-flight.
    const documents = [
      doc('d1', { localPath: '/data/pdfs/case-a/d1.pdf' }),
      doc('d2'),
    ];
    await store.appendCase(legalCase('case-a', documents));
    await store.enqueueRow(row('case-a'));

    const search = async (_query: Query): Promise<SearchResponse> => response([]);
    const detail = fakeDetail({}); // no script: a call would throw and fail the test
    const downloader = fakeDownloader({
      // d1 needs no script entry: fakeDownloader resolves it for free via
      // its own localPath (mirroring PjeDownloader's real valid-file check)
      // without ever consulting this map - so a passing test proves d1's
      // "download" cost nothing beyond the check, matching the real one.
      d2: { ok: true, path: '/data/pdfs/case-a/d2.pdf', bytes: 50, skipped: false },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    expect(summary.casesDetailed).toBe(0); // no detail fetch: the case was already indexed
    // Both documents are visited (d1's cheap, already-there skip included),
    // but only d2 needed a real script entry to resolve.
    expect(downloader.calls).toEqual(['d1', 'd2']);
    expect(summary.documentsSkipped).toBe(1);
    expect(summary.documentsDownloaded).toBe(1);
    expect(await store.listPendingRows()).toEqual([]);
    const stored = await store.indexCases();
    expect(stored.get('case-a')?.documents[1]?.localPath).toBe('/data/pdfs/case-a/d2.pdf');
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

  it('policy: RejectedQueryError from search ends the sweep, logged as a sweep-level failure', async () => {
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

  it('policy: CircuitBreakerError aborts the run cleanly, throwing RunAbortedError with the summary so far', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', [doc('d1')]) });
    const downloader: DocumentDownloader = {
      async download(): Promise<DownloadResult> {
        throw new CircuitBreakerError('too many 429s');
      },
    };
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });

    const error = await scraper.run(RANGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunAbortedError);
    expect((error as RunAbortedError).cause).toBeInstanceOf(CircuitBreakerError);
    expect((error as RunAbortedError).summary.casesDetailed).toBe(1);
    // The case detail itself was already persisted before the download step ran.
    expect(await store.hasCase('case-a')).toBe(true);
    expect(logger.events.some((e) => e.kind === 'run-aborted')).toBe(true);
  });

  it('summary: counts windows, listed/detailed/failed cases, downloaded/skipped/failed documents, and the on-disk snapshot', async () => {
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
      requests: 0,
      retries429: 0,
      casesOnDisk: 1,
      pendingRows: 0,
      retryableCases: 1,
      retryableDocuments: 0,
    });
  });
});
