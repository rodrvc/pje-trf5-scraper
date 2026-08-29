/**
 * The sweep orchestrator: coordinates sweep -> detail -> PDFs -> persistence.
 *
 * Without this piece the business logic ends up living in `main()` - the
 * classic anti-pattern in scrapers (ISSUE-9). The CLI (ISSUE-8) only parses
 * flags and instantiates a `Scraper`; every decision about what to do with a
 * sweep event, a failed detail fetch or a failed download lives here.
 *
 * This PR builds only the loop and its failure policy. Resume/retry
 * (`--retry-failed`, skipping already-covered windows across runs) is 9b;
 * request budgets and rate limits are 9c. `seen`, `isCovered` and
 * `maxRequests` are accepted as options so this run can already be pointed at
 * a `PersistenceStore`-backed dedup/coverage state, but this PR does not add
 * any behavior around request budgets - see the TODOs below.
 *
 * ## Failure policy
 *
 * | Failure                                          | Action                                          |
 * |---------------------------------------------------|--------------------------------------------------|
 * | `detail.fetch` throws anything **except** `CircuitBreakerError` (`ParseError`, `UnexpectedDetailPageError`, a `RateLimitError` that exhausted its retries, a raw network error, ...) | `store.recordCaseFailure({ retryable: true, reason: "<ErrorName>: <message>" })`, dequeue the row, continue with the next row |
 * | `search` throws `RejectedQueryError` (surfaced as a sweep-level failure) | logged through the sink as a sweep failure, continue the run |
 * | a document download fails - `DownloadResult` with `ok: false`, or `downloader.download` itself throwing anything **except** `CircuitBreakerError` | `store.recordDocumentFailure(...)`, continue with the next document |
 * | `CircuitBreakerError`, from detail, download or the sweep | finish the writes already in flight for the current row, then rethrow - abort the run cleanly |
 *
 * The brief's "continue with the next document/case if the error persists
 * after several attempts" is exactly what `PjeDownloader`'s own retry/session
 * recovery, and `HttpClient`'s own 429 retry loop, already do before an error
 * ever reaches this module: by the time `detail.fetch` or `downloader.download`
 * throws, that retrying has already happened and given up. This module never
 * retries either of them itself - it only decides what to do once they have.
 * The circuit breaker is the one exception, at every one of those call sites:
 * "stop hammering the server altogether" overrides "continue on this row",
 * which is why it is the only error kind this loop does not turn into a
 * recorded, continued-past failure.
 */

import type { CaseDocument, LegalCase, Query, SearchResultRow } from '../domain/types.js';
import { CircuitBreakerError, RejectedQueryError } from '../domain/errors.js';
import type { PjeDetail } from '../pje/detail.js';
import type { DownloadResult, PjeDownloader } from '../pje/download.js';
import type { PersistenceStore } from '../persistence/store.js';
import { isFinalSweepEvent } from '../persistence/store.js';
import { sweep, type CoverFn, type SeenSet, type SearchFn, type SweepEvent } from './sweep.js';
import type { PartitionChain } from './partition.js';

/** Everything the orchestrator logs, so a CLI (or a test) can render it however it likes. */
export type OrchestratorLogEvent =
  | { kind: 'sweep'; event: SweepEvent }
  | { kind: 'sweep-rejected'; query: Query; message: string }
  | { kind: 'case-detailed'; number: string }
  | { kind: 'case-failed'; number: string; reason: string }
  | { kind: 'document-downloaded'; caseNumber: string; documentId: string; skipped: boolean }
  | { kind: 'document-failed'; caseNumber: string; documentId: string; reason: string }
  | { kind: 'run-aborted'; reason: string };

/** Log sink the orchestrator reports every event through. Never `console` directly. */
export interface LogSink {
  log(event: OrchestratorLogEvent): void;
}

/** Tallies produced by one run, printed by the CLI (ISSUE-8). */
export interface RunSummary {
  windows: number;
  casesListed: number;
  casesDetailed: number;
  casesFailed: number;
  documentsDownloaded: number;
  documentsSkipped: number;
  documentsFailed: number;
  /** 429 retries observed via `HttpClientOptions.onRetry`, when wired in - see `RetryCounter`. */
  retries429: number;
}

/**
 * A counter the caller wires into `HttpClientOptions.onRetry` so this run's
 * summary can report how many 429 retries it saw, without the orchestrator
 * needing to know anything about `HttpClient` itself.
 */
export interface RetryCounter {
  readonly count: number;
}

export interface ScraperOptions {
  search: SearchFn;
  detail: PjeDetail;
  downloader: PjeDownloader;
  store: PersistenceStore;
  chain: PartitionChain;
  cover?: CoverFn;
  logger: LogSink;
  /** Dedup state across the run. Defaults to the store's own rebuilt seen-set when omitted. */
  seen?: SeenSet;
  // TODO(9b): accept an `isCovered` predicate (from `store.rebuildCoveredPredicate()`)
  // to skip windows a previous run already recorded as final, instead of re-walking them.
  // TODO(9c): accept a `maxRequests` budget and stop the walk once it is spent.
  retries429?: RetryCounter;
}

export class Scraper {
  private readonly search: SearchFn;
  private readonly detail: PjeDetail;
  private readonly downloader: PjeDownloader;
  private readonly store: PersistenceStore;
  private readonly chain: PartitionChain;
  private readonly cover: CoverFn | undefined;
  private readonly logger: LogSink;
  private readonly seen: SeenSet | undefined;
  private readonly retries429: RetryCounter | undefined;

  constructor(options: ScraperOptions) {
    this.search = options.search;
    this.detail = options.detail;
    this.downloader = options.downloader;
    this.store = options.store;
    this.chain = options.chain;
    this.cover = options.cover;
    this.logger = options.logger;
    this.seen = options.seen;
    this.retries429 = options.retries429;
  }

  /** Runs the full sweep -> detail -> PDFs -> persistence flow for one date range. */
  async run(range: { from: string; to: string }): Promise<RunSummary> {
    const summary: RunSummary = {
      windows: 0,
      casesListed: 0,
      casesDetailed: 0,
      casesFailed: 0,
      documentsDownloaded: 0,
      documentsSkipped: 0,
      documentsFailed: 0,
      retries429: 0,
    };

    try {
      await this.runSweep(range, summary);
      await this.drainPendingRows(summary);
    } catch (error) {
      // Cross-cutting abort: a circuit breaker (or anything else the sweep,
      // detail fetch or download did not itself turn into a recorded
      // failure) stops the run. Whatever persistence writes already
      // happened for earlier rows stand - only the walk itself unwinds.
      this.logger.log({ kind: 'run-aborted', reason: describeError(error) });
      summary.retries429 = this.retries429?.count ?? 0;
      throw error;
    }

    summary.retries429 = this.retries429?.count ?? 0;
    return summary;
  }

  /** Step 1: walks the sweep, persisting every final event and logging every step. */
  private async runSweep(range: { from: string; to: string }, summary: RunSummary): Promise<void> {
    const seen = this.seen ?? (await this.store.rebuildSeenSet());

    try {
      for await (const event of sweep({
        from: range.from,
        to: range.to,
        search: this.search,
        chain: this.chain,
        ...(this.cover !== undefined ? { cover: this.cover } : {}),
        seen,
      })) {
        this.logger.log({ kind: 'sweep', event });
        if (isFinalSweepEvent(event)) {
          summary.windows += 1;
          summary.casesListed += event.rows.length;
          await this.store.recordFinalEvent(event);
        }
      }
    } catch (error) {
      // A rejected query is a sweep-level failure worth recording and
      // continuing past, not a reason to abort the whole run - the leaf that
      // rejected simply contributes nothing. Anything else (a
      // `CircuitBreakerError` in particular) is left to propagate: see the
      // module comment's policy table.
      if (error instanceof RejectedQueryError) {
        this.logger.log({ kind: 'sweep-rejected', query: range, message: error.message });
        return;
      }
      throw error;
    }
  }

  /** Step 2+3: fetches detail and downloads documents for every row still pending. */
  private async drainPendingRows(summary: RunSummary): Promise<void> {
    const caseIndex = await this.store.indexCases();

    for (const row of await this.store.listPendingRows()) {
      if (caseIndex.has(row.number)) {
        // Already detailed by an earlier pass over this same run (a
        // re-listed window, e.g. a class-split re-covering a day). Dequeue
        // without spending a detail fetch on it - see the store's own module
        // comment for why `recordFinalEvent` cannot know this on its own.
        await this.store.dequeueRow(row.number);
        continue;
      }

      await this.processRow(row, summary);
    }
  }

  /** Fetches one row's detail, then downloads its documents, recording failures as it goes. */
  private async processRow(row: SearchResultRow, summary: RunSummary): Promise<void> {
    let legalCase: LegalCase;
    try {
      legalCase = await this.detail.fetch(row.ca, row.number);
    } catch (error) {
      // Only the circuit breaker aborts the run - see the module comment's
      // policy table. Everything else (ParseError, UnexpectedDetailPageError,
      // a RateLimitError that exhausted HttpClient's own retries, a raw
      // network error) is "the error persisted after several attempts": it
      // is this row's problem, not the run's, so it is recorded and the walk
      // continues to the next one.
      if (error instanceof CircuitBreakerError) {
        throw error;
      }
      const reason = describeError(error);
      await this.store.recordCaseFailure({
        caseNumber: row.number,
        ca: row.ca,
        reason,
        attempt: 1,
        retryable: true,
      });
      await this.store.dequeueRow(row.number);
      summary.casesFailed += 1;
      this.logger.log({ kind: 'case-failed', number: row.number, reason });
      return;
    }

    await this.store.completeRow(legalCase);
    summary.casesDetailed += 1;
    this.logger.log({ kind: 'case-detailed', number: legalCase.number });

    await this.downloadDocuments(legalCase, summary);

    // Re-persist the case so its documents' now-filled `localPath`s land -
    // see the store's module comment on why `completeRow` is called twice.
    await this.store.completeRow(legalCase);
  }

  /**
   * Calls `downloader.download`, turning a thrown error into a failed
   * `DownloadResult` instead of letting it escape - `PjeDownloader.download`
   * never throws for HTTP-level failures by contract (see that module), but
   * a thrown filesystem error (a full disk, a permissions problem) must fail
   * this one document, not the run, same as every other detail/download
   * failure. Only `CircuitBreakerError` is left to propagate and abort.
   */
  private async attemptDownload(legalCase: LegalCase, doc: CaseDocument): Promise<DownloadResult> {
    try {
      return await this.downloader.download(legalCase.number, doc, legalCase.ca);
    } catch (error) {
      if (error instanceof CircuitBreakerError) throw error;
      return { ok: false, reason: describeError(error), retryable: true, sessionAttempts: 1 };
    }
  }

  /** Downloads every document of one case, recording each outcome. */
  private async downloadDocuments(legalCase: LegalCase, summary: RunSummary): Promise<void> {
    for (const doc of legalCase.documents) {
      const result = await this.attemptDownload(legalCase, doc);

      if (result.ok) {
        doc.localPath = result.path;
        await this.store.recordDocumentSuccess(legalCase.number, doc.download.idProcessoDocumento);
        if (result.skipped) {
          summary.documentsSkipped += 1;
        } else {
          summary.documentsDownloaded += 1;
        }
        this.logger.log({
          kind: 'document-downloaded',
          caseNumber: legalCase.number,
          documentId: doc.download.idProcessoDocumento,
          skipped: result.skipped,
        });
        continue;
      }

      await this.store.recordDocumentFailure({
        caseNumber: legalCase.number,
        documentId: doc.download.idProcessoDocumento,
        downloadRef: doc.download,
        reason: result.reason,
        ...(result.status !== undefined ? { httpStatus: result.status } : {}),
        attempt: result.sessionAttempts,
        retryable: result.retryable,
      });
      summary.documentsFailed += 1;
      this.logger.log({
        kind: 'document-failed',
        caseNumber: legalCase.number,
        documentId: doc.download.idProcessoDocumento,
        reason: result.reason,
      });
    }
  }
}

/** `"ErrorName: message"`, so a recorded failure's reason names the error kind, not just its text. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
