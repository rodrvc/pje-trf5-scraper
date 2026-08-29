/**
 * Orchestrator tests: scripted fakes for search/detail/downloader (typed
 * against the `DetailFetcher`/`DocumentDownloader` seams, not the concrete
 * `PjeDetail`/`PjeDownloader`), a real temp-dir `PersistenceStore` (same
 * style as `test/persistence-store.test.ts`), no network. One test per row
 * of the module's failure-policy table, plus the happy path, the crash
 * safety around detail-then-downloads, the already-indexed-row resume path,
 * the summary counts, and (9b) resume-across-runs and `retryFailed`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreakerError, ParseError, RateLimitError, RejectedQueryError, UnexpectedDetailPageError } from '../src/domain/errors.js';
import type { CaseDocument, JudicialClass, LegalCase, Query, SearchResponse, SearchResultRow } from '../src/domain/types.js';
import { PersistenceStore } from '../src/persistence/store.js';
import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../src/pipeline/partition.js';
import {
  RunAbortedError,
  Scraper,
  type DetailFetcher,
  type DocumentDownloader,
  type LogSink,
  type OrchestratorLogEvent,
  type RequestCounter,
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

/** A `RequestCounter` a test can bump by hand, standing in for the real `onRequest`-fed one. */
function fakeRequestCounter(): RequestCounter & { bump(n?: number): void } {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    retries429: 0,
    bump(n = 1) {
      requests += n;
    },
  };
}

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

  it('policy: RejectedQueryError from search is logged as a rejected leaf, the run continues (9b)', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => {
      throw new RejectedQueryError('rejected', 'server message');
    };
    const detail = fakeDetail({});
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger });
    const summary = await scraper.run(RANGE);

    // The run itself completes normally (no thrown error, no RunAbortedError).
    expect(summary.windows).toBe(0);
    expect(logger.events.some((e) => e.kind === 'sweep' && e.event.type === 'rejected')).toBe(true);
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
      windowsSkipped: 0,
      windowsRejected: 0,
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

  /** Builds one `Scraper` wired to the shared temp-dir `store`, a fresh logger each time. */
  function makeScraper(overrides: {
    search: (query: Query) => Promise<SearchResponse>;
    detail: DetailFetcher;
    downloader: DocumentDownloader;
  }): { scraper: Scraper; logger: LogSink & { events: OrchestratorLogEvent[] } } {
    const logger = recordingLogger();
    const scraper = new Scraper({ ...overrides, store, chain: noopChain(), logger });
    return { scraper, logger };
  }

  it('resume (9b): a window already recorded as a final event is skipped and not re-listed', async () => {
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', [doc('d1')]) });
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/data/pdfs/case-a/d1.pdf', bytes: 100, skipped: false },
    });

    const search = async (): Promise<SearchResponse> => response([row('case-a')]);
    await makeScraper({ search, detail, downloader }).scraper.run(RANGE);

    // Second run over the same range: search must never be called again for
    // this window, since it is already recorded as a final event.
    const searchCalls: Query[] = [];
    const second = makeScraper({
      search: async (query) => {
        searchCalls.push(query);
        return response([row('case-a')]);
      },
      detail,
      downloader,
    });
    const summary = await second.scraper.run(RANGE);

    expect(searchCalls).toEqual([]);
    expect(summary).toMatchObject({ windows: 0, casesListed: 0 });
    expect(await store.listPendingRows()).toEqual([]);
    expect(second.logger.events.some((e) => e.kind === 'sweep' && e.event.type === 'skipped')).toBe(true);
  });

  it('resume (9b): running the same range twice produces no duplicate cases and no re-downloads', async () => {
    // Simulates a killed-then-restarted run: the same configuration driven
    // twice against the same on-disk store.
    const search = async (): Promise<SearchResponse> => response([row('case-a')]);
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', [doc('d1')]) });
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/data/pdfs/case-a/d1.pdf', bytes: 100, skipped: false },
    });

    await makeScraper({ search, detail, downloader }).scraper.run(RANGE);
    const second = await makeScraper({ search, detail, downloader }).scraper.run(RANGE);

    expect(second.casesDetailed).toBe(0); // no second detail fetch for case-a
    expect(second.documentsDownloaded).toBe(0); // d1 already had a localPath: free skip only
    expect(second.casesOnDisk).toBe(1);
    expect((await store.indexCases()).size).toBe(1);
    // Across both runs, only the first actually "downloaded" d1.
    expect(downloader.calls.filter((id) => id === 'd1')).toHaveLength(1);
  });

  it('retryFailed (9b): re-fetches a previously-failed case and clears it from the retry ledger', async () => {
    const search = async (): Promise<SearchResponse> => response([row('case-bad')]);
    let attempt = 0;
    const detail: DetailFetcher = {
      async fetch(): Promise<LegalCase> {
        attempt += 1;
        if (attempt === 1) throw new ParseError('missing case number', 'missing case number');
        return legalCase('case-bad');
      },
    };
    const { scraper } = makeScraper({ search, detail, downloader: fakeDownloader({}) });
    await scraper.run(RANGE);
    expect(await store.listRetryableCases()).toHaveLength(1);

    const summary = await scraper.retryFailed();

    expect(summary).toMatchObject({ casesDetailed: 1, casesFailed: 0 });
    expect(await store.hasCase('case-bad')).toBe(true);
    expect(await store.listRetryableCases()).toEqual([]);
  });

  it('retryFailed (9b): re-downloads only the one previously-failed document', async () => {
    const search = async (): Promise<SearchResponse> => response([row('case-a')]);
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a', [doc('d1'), doc('d2')]) });
    // First run: d1 fails, d2 succeeds. Then d1 is scripted to succeed, so
    // retryFailed's re-attempt can be told apart from a fresh run's attempt.
    const outcomes: Record<string, DownloadResult> = {
      d1: { ok: false, reason: 'HTTP 429', status: 429, retryable: true, sessionAttempts: 1 },
      d2: { ok: true, path: '/data/pdfs/case-a/d2.pdf', bytes: 50, skipped: false },
    };
    const downloader = fakeDownloader(outcomes);
    await makeScraper({ search, detail, downloader }).scraper.run(RANGE);
    expect(await store.listRetryableDocuments()).toHaveLength(1);

    downloader.calls.length = 0;
    outcomes.d1 = { ok: true, path: '/data/pdfs/case-a/d1.pdf', bytes: 10, skipped: false };
    const { scraper: retryScraper } = makeScraper({ search, detail, downloader });

    const summary = await retryScraper.retryFailed();

    // Only d1 (the failed one) was re-attempted, not d2 (which never failed).
    expect(downloader.calls).toEqual(['d1']);
    expect(summary).toMatchObject({ documentsDownloaded: 1, documentsFailed: 0 });
    expect(await store.listRetryableDocuments()).toEqual([]);
    const stored = await store.indexCases();
    const storedDocs = stored.get('case-a')?.documents ?? [];
    // The stored case still carries BOTH documents, and d2's own localPath -
    // set by the first run, well before this retry ever touched d1 - is
    // untouched: retrying one document must never lose or overwrite another.
    expect(storedDocs).toHaveLength(2);
    const d1 = storedDocs.find((d) => d.download.idProcessoDocumento === 'd1');
    const d2 = storedDocs.find((d) => d.download.idProcessoDocumento === 'd2');
    expect(d1?.localPath).toBe('/data/pdfs/case-a/d1.pdf');
    expect(d2?.localPath).toBe('/data/pdfs/case-a/d2.pdf');
  });

  it('retryFailed (9b): a case failing again increments attempt, and the third failure is no longer retryable', async () => {
    const search = async (): Promise<SearchResponse> => response([row('case-bad')]);
    const detail: DetailFetcher = {
      async fetch(): Promise<LegalCase> {
        throw new ParseError('missing case number', 'missing case number');
      },
    };
    const { scraper } = makeScraper({ search, detail, downloader: fakeDownloader({}) });
    await scraper.run(RANGE);

    let [record] = await store.listRetryableCases();
    expect(record).toMatchObject({ attempt: 1, retryable: true });

    await scraper.retryFailed();
    [record] = await store.listRetryableCases();
    expect(record).toMatchObject({ attempt: 2, retryable: true });

    await scraper.retryFailed();
    const stillRetryable = await store.listRetryableCases();
    // The third failure (attempt 3) is no longer retryable, so it drops out
    // of the retryable list entirely - listRetryable only returns records
    // whose latest attempt is still marked retryable.
    expect(stillRetryable).toEqual([]);
  });

  it('budget: stops at maxRequests, with stoppedBy set, and never searches again after the stop', async () => {
    const requestCounter = fakeRequestCounter();
    let searchCalls = 0;
    const search = async (_query: Query): Promise<SearchResponse> => {
      searchCalls += 1;
      requestCounter.bump(); // mimics HttpClientOptions.onRequest firing per real search
      return response([row(`case-${searchCalls}`)]);
    };
    const detail = fakeDetail({ 'ca-case-1': legalCase('case-1') });
    const downloader = fakeDownloader({});
    const logger = recordingLogger();

    // Always splittable, so only the budget - not an exhausted chain - ends the walk.
    const alwaysSplits: Query[] = [{ from: '2025-03-04', to: '2025-03-04' }];
    const chain = new PartitionChain([{ name: 'never-ending', canSplit: () => true, split: () => alwaysSplits }]);

    const scraper = new Scraper({ search, detail, downloader, store, chain, logger, requestCounter, limits: { maxRequests: 1 } });
    const summary = await scraper.run(RANGE);

    expect(summary.stoppedBy).toBe('maxRequests');
    expect(searchCalls).toBe(1); // the budget check runs before the second search
  });

  it('budget: stops at maxCases after finishing the case already in flight, downloads included', async () => {
    const search = async (_query: Query): Promise<SearchResponse> =>
      response([row('case-a'), row('case-b')]);
    const detail = fakeDetail({
      'ca-case-a': legalCase('case-a', [doc('d1')]),
      'ca-case-b': legalCase('case-b', [doc('d2')]),
    });
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/x/d1.pdf', bytes: 1, skipped: false },
      d2: { ok: true, path: '/x/d2.pdf', bytes: 1, skipped: false },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger, limits: { maxCases: 1 } });
    const summary = await scraper.run(RANGE);

    expect(summary.stoppedBy).toBe('maxCases');
    expect(summary.casesDetailed).toBe(1);
    // The case detailed before the stop still got its documents/row completed.
    const stored = await store.indexCases();
    expect(stored.get('case-a')?.documents[0]?.localPath).toBe('/x/d1.pdf');
    expect(await store.listPendingRows()).toMatchObject([{ number: 'case-b' }]);
  });

  it('stoppedBy: undefined with no limits (walks out naturally); "maxCases" and still returned, not thrown, with limits: { maxCases: 0 }', async () => {
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const detail = fakeDetail({ 'ca-case-a': legalCase('case-a') });
    const downloader = fakeDownloader({});

    const unbounded = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger: recordingLogger() });
    expect((await unbounded.run(RANGE)).stoppedBy).toBeUndefined();

    // A budget stop must resolve normally (never throw RunAbortedError): it
    // is a successful, bounded run, not an abort.
    const bounded = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger: recordingLogger(), limits: { maxCases: 0 } });
    const summary = await bounded.run(RANGE);
    expect(summary.stoppedBy).toBe('maxCases');
    expect(summary.casesDetailed).toBe(0);
  });

  it.each([
    // [classA rows, classB rows, expected ok] - the real acceptance bar is
    // childrenRows >= 30 (ISSUE-4's resolution): the second row is what a
    // silently-missing class from the catalog would look like.
    [20, 15, true],
    [5, 4, false],
  ])(
    'classSplitCheck: a capped day split by judicial-class logs childrenRows summed across its children, ok = sum >= 30 (%i + %i -> ok=%s)',
    async (classARows, classBRows, expectedOk) => {
      const chain = new PartitionChain([
        new DateRangeSplit(),
        new JudicialClassSplit([
          { id: '1', name: 'Class A' } satisfies JudicialClass,
          { id: '2', name: 'Class B' } satisfies JudicialClass,
        ]),
      ]);
      const rows = (n: number, prefix: string): SearchResultRow[] =>
        Array.from({ length: n }, (_, i) => row(`${prefix}-${i}`));

      const search = async (query: Query): Promise<SearchResponse> => {
        if (query.judicialClassId === undefined) return response(rows(30, 'day1'), true);
        if (query.judicialClassId === '1') return response(rows(classARows, 'a'));
        return response(rows(classBRows, 'b'));
      };
      const logger = recordingLogger();
      const scraper = new Scraper({
        search,
        detail: fakeDetail({}), // never consulted: no downloads driven in this test
        downloader: fakeDownloader({}),
        store,
        chain,
        logger,
      });
      await scraper.run(RANGE);

      const check = logger.events.find((e) => e.kind === 'classSplitCheck');
      expect(check).toMatchObject({
        kind: 'classSplitCheck',
        day: '2025-03-05',
        childrenRows: classARows + classBRows,
        ok: expectedOk,
      });
    },
  );

  it('budget: maxRequests gates per document, not just per case - the row stays pending and completeRow is not called', async () => {
    // requestCounter reaches the budget exactly when detail.fetch runs (a
    // stand-in for HttpClientOptions.onRequest firing on the real request
    // detail makes) - i.e. AFTER the sweep's own pre-search check passed,
    // but BEFORE any document download is attempted.
    const requestCounter = fakeRequestCounter();
    const search = async (_query: Query): Promise<SearchResponse> => response([row('case-a')]);
    const documents = [doc('d1'), doc('d2')];
    const detail: DetailFetcher = {
      async fetch(_ca, _expectedNumber) {
        requestCounter.bump(1);
        return legalCase('case-a', documents);
      },
    };
    const downloader = fakeDownloader({
      d1: { ok: true, path: '/x/d1.pdf', bytes: 1, skipped: false },
      d2: { ok: true, path: '/x/d2.pdf', bytes: 1, skipped: false },
    });
    const logger = recordingLogger();

    const scraper = new Scraper({ search, detail, downloader, store, chain: noopChain(), logger, requestCounter, limits: { maxRequests: 1 } });
    const summary = await scraper.run(RANGE);

    expect(summary.stoppedBy).toBe('maxRequests');
    expect(downloader.calls).toEqual([]); // gated before the first document attempt
    // The case was appended (still pending), never completeRow'd: a resumed
    // run re-attempts only the documents that never got tried.
    expect(await store.hasCase('case-a')).toBe(true);
    expect(await store.listPendingRows()).toMatchObject([{ number: 'case-a' }]);
  });

  it('classSplitCheck: a budget stop (interrupted) suppresses the verdict instead of reporting a partial sum as ok: false', async () => {
    const classA: JudicialClass = { id: '1', name: 'Class A' };
    const classB: JudicialClass = { id: '2', name: 'Class B' };
    const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit([classA, classB])]);
    const rows = (n: number, prefix: string): SearchResultRow[] =>
      Array.from({ length: n }, (_, i) => row(`${prefix}-${i}`));

    const requestCounter = fakeRequestCounter();
    let searchCalls = 0;
    const search = async (query: Query): Promise<SearchResponse> => {
      searchCalls += 1;
      requestCounter.bump(1); // one "request" per search, like the real onRequest
      if (query.judicialClassId === undefined) return response(rows(30, 'day1'), true);
      // Only class A's window is ever reached before the budget stops the walk.
      return response(rows(5, 'a'));
    };
    const logger = recordingLogger();
    const scraper = new Scraper({
      search,
      detail: fakeDetail({}),
      downloader: fakeDownloader({}),
      store,
      chain,
      logger,
      requestCounter,
      limits: { maxRequests: 2 }, // the capped day + class A's window, no more
    });
    const summary = await scraper.run(RANGE);

    expect(summary.stoppedBy).toBe('maxRequests');
    expect(searchCalls).toBe(2);
    const check = logger.events.find((e) => e.kind === 'classSplitCheck');
    // A partial sum (5 rows, far short of 30) must NOT be reported as
    // ok: false - the run was interrupted, not a sign of a missing class.
    expect(check).toMatchObject({ kind: 'classSplitCheck', ok: undefined, incomplete: true });
  });

  it('classSplitCheck: a skipped child (resume, 9b) suppresses the verdict instead of reporting a short sum as ok: false', async () => {
    const classA: JudicialClass = { id: '1', name: 'Class A' };
    const classB: JudicialClass = { id: '2', name: 'Class B' };
    const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit([classA, classB])]);
    const rows = (n: number, prefix: string): SearchResultRow[] =>
      Array.from({ length: n }, (_, i) => row(`${prefix}-${i}`));

    // Pre-record class A's window as already covered (as an earlier run
    // would have left it), so this run's sweep skips it via skipWindow.
    const classAQuery: Query = { from: '2025-03-05', to: '2025-03-05', judicialClassId: '1', judicialClassName: 'Class A' };
    await store.recordFinalEvent({ type: 'window', query: classAQuery, rows: rows(25, 'a'), depth: 1 });

    const search = async (query: Query): Promise<SearchResponse> => {
      if (query.judicialClassId === undefined) return response(rows(30, 'day1'), true);
      // Only class B's window is ever actually searched: class A is skipped.
      return response(rows(5, 'b'));
    };
    const logger = recordingLogger();
    const scraper = new Scraper({
      search,
      detail: fakeDetail({}),
      downloader: fakeDownloader({}),
      store,
      chain,
      logger,
    });
    await scraper.run(RANGE);

    expect(logger.events.some((e) => e.kind === 'sweep' && e.event.type === 'skipped')).toBe(true);
    const check = logger.events.find((e) => e.kind === 'classSplitCheck');
    // Only class B's 5 rows were actually summed (class A was skipped, not
    // searched) - far short of 30, but must NOT be reported as ok: false:
    // the skipped child means this run's sum does not tell the whole story.
    expect(check).toMatchObject({ kind: 'classSplitCheck', ok: undefined, incomplete: true });
  });

  it('retryFailed (9b): the budget gates its case/document retry loops too, stopping before the second failed case', async () => {
    const search = async (): Promise<SearchResponse> => response([row('case-bad-1'), row('case-bad-2')]);
    const failing: DetailFetcher = {
      async fetch(): Promise<LegalCase> {
        throw new ParseError('missing case number', 'missing case number');
      },
    };
    const { scraper } = makeScraper({ search, detail: failing, downloader: fakeDownloader({}) });
    await scraper.run(RANGE);
    expect(await store.listRetryableCases()).toHaveLength(2);

    const requestCounter = fakeRequestCounter();
    let retryFetches = 0;
    const detail: DetailFetcher = {
      async fetch(): Promise<LegalCase> {
        retryFetches += 1;
        requestCounter.bump(1);
        return legalCase(`case-bad-${retryFetches}`);
      },
    };
    const bounded = new Scraper({
      search,
      detail,
      downloader: fakeDownloader({}),
      store,
      chain: noopChain(),
      logger: recordingLogger(),
      requestCounter,
      limits: { maxRequests: 1 },
    });

    const summary = await bounded.retryFailed();

    expect(summary.stoppedBy).toBe('maxRequests');
    expect(retryFetches).toBe(1); // only the first failed case was retried
    expect(await store.listRetryableCases()).toHaveLength(1); // the second is still pending retry
  });
});
