/**
 * The sweep orchestrator: coordinates sweep -> detail -> PDFs -> persistence.
 *
 * Without this piece the business logic ends up living in `main()` - the
 * classic anti-pattern in scrapers (ISSUE-9). The CLI (ISSUE-8) only parses
 * flags and instantiates a `Scraper`; every decision about what to do with a
 * sweep event, a failed detail fetch or a failed download lives here.
 *
 * The loop and its failure policy are part 1; resume/retry (9b) is now here
 * too. Request budgets and rate limits (9c) remain a TODO on `ScraperOptions`.
 *
 * Rows are detailed as soon as their window is recorded (interleaved with the
 * sweep), not after the whole range has been walked: the sweep already walks
 * "from the present backwards" so a short or interrupted run still lands
 * complete, contiguous, *detailed* cases near one end of the range, not just
 * complete search windows with nothing behind them - and a future budget
 * (9c) would otherwise be spent entirely on searching before a single case
 * gets detailed. `drainPendingRows` still runs once at the end, for rows a
 * previous run left pending (resume, 9b) or that a `cover`'s dedup left
 * unprocessed mid-walk.
 *
 * ## Failure policy
 *
 * | Failure | Action |
 * |---|---|
 * | `detail.fetch` throws anything **except** `CircuitBreakerError` (`ParseError`, `UnexpectedDetailPageError`, an exhausted `RateLimitError`, a raw network error, ...) | `store.recordCaseFailure({ retryable: true, reason: "<ErrorName>: <message>" })`, dequeue the row, continue with the next row |
 * | `search` throws `RejectedQueryError` for one leaf | (9b) `sweep()` catches this per leaf, yielding a `rejected` event: the walk continues with that leaf's siblings, no `RunAbortedError` |
 * | a document download fails - `DownloadResult` with `ok: false`, or `downloader.download` itself throwing anything **except** `CircuitBreakerError` | `store.recordDocumentFailure(...)`, continue with the next document |
 * | `CircuitBreakerError`, from detail, download or the sweep | finish the writes already in flight for the current row, then throw `RunAbortedError` carrying the summary so far - abort the run cleanly |
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
 *
 * ## Crash safety across detail and downloads
 *
 * A case's detail is stored (`store.appendCase`, still pending) *before* its
 * documents are downloaded, and dequeued only once, in one `completeRow`
 * call *after* the downloads - never `completeRow` before downloads, which
 * would dequeue the row while its PDFs are still in flight: a kill in
 * between would leave the case indexed with no `localPath`s and the row no
 * longer pending, so a resumed run would skip it as "already detailed" and
 * its documents would never be fetched. A row that resume (9b) finds already
 * indexed is therefore not just dequeued: its stored case is re-run through
 * `downloadDocuments` first (cheap for whatever already downloaded - see
 * `PjeDownloader.download`'s own valid-file check - and real work for
 * whatever did not) and only then `completeRow`'d.
 */

import type { CaseDocument, LegalCase, SearchResultRow } from '../domain/types.js';
import { CircuitBreakerError } from '../domain/errors.js';
import type { DownloadResult } from '../pje/download.js';
import type { CaseFailureRecord, FailedDocumentRecord, PersistenceStore } from '../persistence/store.js';
import { isFinalSweepEvent } from '../persistence/store.js';
import { sweep, type CoverFn, type SeenSet, type SearchFn, type SweepEvent } from './sweep.js';
import type { PartitionChain } from './partition.js';

/** Everything `detail.fetch` needs to expose - a one-method seam so tests fake it without `PjeDetail`. */
export interface DetailFetcher {
  fetch(ca: string, expectedNumber?: string): Promise<LegalCase>;
}

/** Everything `downloader.download` needs to expose - a one-method seam so tests fake it without `PjeDownloader`. */
export interface DocumentDownloader {
  download(caseNumber: string, doc: CaseDocument, ca?: string): Promise<DownloadResult>;
}

/** Everything the orchestrator logs, so a CLI (or a test) can render it however it likes. */
export type OrchestratorLogEvent =
  | { kind: 'sweep'; event: SweepEvent }
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
  /** Network attempts and 429 retries observed via an injected `RequestCounter`. */
  requests: number;
  retries429: number;
  /**
   * A snapshot read from `store` after the run, not a tally kept during it:
   * the CLI should print what is actually on disk (including whatever
   * earlier runs left there), not just what this run's own loop touched.
   */
  casesOnDisk: number;
  pendingRows: number;
  retryableCases: number;
  retryableDocuments: number;
}

/**
 * Thrown when a `CircuitBreakerError` aborts a run. Carries the `RunSummary`
 * accumulated up to the abort point (see the `RunSummary.casesOnDisk`-style
 * snapshot fields above) alongside the `cause`, so a caller can report exact
 * numbers on an aborted run instead of only "it threw".
 */
export class RunAbortedError extends Error {
  readonly summary: RunSummary;

  constructor(cause: unknown, summary: RunSummary) {
    super(`Run aborted: ${describeError(cause)}`, { cause });
    this.name = 'RunAbortedError';
    this.summary = summary;
  }
}

/**
 * Counter the caller wires into `HttpClientOptions.onRequest`/`onRetry` so
 * this run's summary can report network activity without the orchestrator
 * needing to know anything about `HttpClient` itself.
 */
export interface RequestCounter {
  readonly requests: number;
  readonly retries429: number;
}

export interface ScraperOptions {
  search: SearchFn;
  detail: DetailFetcher;
  downloader: DocumentDownloader;
  store: PersistenceStore;
  chain: PartitionChain;
  cover?: CoverFn;
  logger: LogSink;
  /**
   * Dedup state across the run. Defaults to `store.rebuildSeenSet()` when
   * omitted, so a resumed run's dedup picks up exactly where an earlier run
   * left off instead of re-registering (and re-listing) cases already found.
   */
  seen?: SeenSet;
  // TODO(9c): accept a `maxRequests` budget and stop the walk once
  // `requestCounter.requests` reaches it.
  requestCounter?: RequestCounter;
}

export class Scraper {
  private readonly search: SearchFn;
  private readonly detail: DetailFetcher;
  private readonly downloader: DocumentDownloader;
  private readonly store: PersistenceStore;
  private readonly chain: PartitionChain;
  private readonly cover: CoverFn | undefined;
  private readonly logger: LogSink;
  private readonly seen: SeenSet | undefined;
  private readonly requestCounter: RequestCounter | undefined;

  constructor(options: ScraperOptions) {
    this.search = options.search;
    this.detail = options.detail;
    this.downloader = options.downloader;
    this.store = options.store;
    this.chain = options.chain;
    this.cover = options.cover;
    this.logger = options.logger;
    this.seen = options.seen;
    this.requestCounter = options.requestCounter;
  }

  /** Runs the full sweep -> detail -> PDFs -> persistence flow for one date range. */
  async run(range: { from: string; to: string }): Promise<RunSummary> {
    const summary = emptySummary();

    try {
      await this.runSweep(range, summary);
      await this.drainPendingRows(summary);
    } catch (error) {
      // Cross-cutting abort: a circuit breaker (or anything else the sweep,
      // detail fetch or download did not itself turn into a recorded
      // failure) stops the run. Whatever persistence writes already
      // happened for earlier rows stand - only the walk itself unwinds.
      await this.finalizeSummary(summary);
      this.logger.log({ kind: 'run-aborted', reason: describeError(error) });
      throw new RunAbortedError(error, summary);
    }

    await this.finalizeSummary(summary);
    return summary;
  }

  /** Fills in the request counters and the store-snapshot fields, success or abort alike. */
  private async finalizeSummary(summary: RunSummary): Promise<void> {
    summary.requests = this.requestCounter?.requests ?? 0;
    summary.retries429 = this.requestCounter?.retries429 ?? 0;
    summary.casesOnDisk = (await this.store.indexCases()).size;
    summary.pendingRows = (await this.store.listPendingRows()).length;
    summary.retryableCases = (await this.store.listRetryableCases()).length;
    summary.retryableDocuments = (await this.store.listRetryableDocuments()).length;
  }

  /**
   * Walks the sweep, persisting and detailing each final event's rows as
   * they arrive - see the module comment on why detailing is interleaved
   * with the walk rather than deferred to one pass at the end.
   *
   * `seen` and `skipWindow` (9b) both default to a rebuild from `store` when
   * not explicitly injected - see `SweepOptions.skipWindow` for the exact
   * (leaf-only) matching semantics `rebuildCoveredPredicate` has.
   */
  private async runSweep(range: { from: string; to: string }, summary: RunSummary): Promise<void> {
    const seen = this.seen ?? (await this.store.rebuildSeenSet());
    const skipWindow = await this.store.rebuildCoveredPredicate();

    for await (const event of sweep({
      from: range.from,
      to: range.to,
      search: this.search,
      chain: this.chain,
      ...(this.cover !== undefined ? { cover: this.cover } : {}),
      seen,
      skipWindow,
    })) {
      this.logger.log({ kind: 'sweep', event });
      if (isFinalSweepEvent(event)) {
        summary.windows += 1;
        summary.casesListed += event.rows.length;
        await this.store.recordFinalEvent(event);
        for (const row of event.rows) {
          await this.processRow(row, summary);
        }
      }
      // `skipped`/`rejected` (9b) carry no rows: nothing further to persist.
    }
  }

  /**
   * Processes every row still pending after the sweep: leftovers from an
   * earlier run (resume, 9b), or from a `cover`'s own dedup. A row already
   * in the case index still needs its documents re-attempted (see the
   * module comment) before it can be safely dequeued.
   */
  private async drainPendingRows(summary: RunSummary): Promise<void> {
    const caseIndex = await this.store.indexCases();

    for (const row of await this.store.listPendingRows()) {
      const stored = caseIndex.get(row.number);
      if (stored !== undefined) {
        await this.downloadDocuments(stored, summary);
        await this.store.completeRow(stored);
        continue;
      }

      await this.processRow(row, summary);
    }
  }

  /**
   * Fetches one row's detail, stores it (still pending), downloads its
   * documents, then dequeues it with one final `completeRow` carrying the
   * filled-in `localPath`s - see the module comment for why detail and the
   * dequeue must not land in the same call.
   */
  private async processRow(row: SearchResultRow, summary: RunSummary): Promise<void> {
    let legalCase: LegalCase;
    try {
      legalCase = await this.detail.fetch(row.ca, row.number);
    } catch (error) {
      // Only the circuit breaker aborts the run - see the module comment's
      // policy table. Everything else (ParseError, UnexpectedDetailPageError,
      // an exhausted RateLimitError, a raw network error) is "the error
      // persisted after several attempts": it is this row's problem, not the
      // run's, so it is recorded and the walk continues to the next one.
      if (error instanceof CircuitBreakerError) throw error;

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

    await this.store.appendCase(legalCase);
    summary.casesDetailed += 1;
    this.logger.log({ kind: 'case-detailed', number: legalCase.number });

    await this.downloadDocuments(legalCase, summary);
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

  /**
   * `--retry-failed` (9b): re-attempts every case whose detail fetch
   * previously failed and every document whose download previously failed -
   * a second pass over the two failure ledgers, no sweep involved.
   *
   * A retried case goes through the same store flow as a fresh row
   * (`appendCase` pending, download, `completeRow`), then `recordCaseSuccess`
   * clears it from the ledger. A retried document re-attempts only that one
   * (see `retryFailedDocument`), and only if its case is still on disk - a
   * missing case would mean the case store was tampered with, not a normal
   * retry scenario, so it is skipped rather than guessed at.
   */
  async retryFailed(): Promise<RunSummary> {
    const summary = emptySummary();

    for (const failedCase of await this.store.listRetryableCases()) {
      await this.retryFailedCase(failedCase, summary);
    }

    const caseIndex = await this.store.indexCases();
    for (const failedDocument of await this.store.listRetryableDocuments()) {
      await this.retryFailedDocument(failedDocument, caseIndex, summary);
    }

    await this.finalizeSummary(summary);
    return summary;
  }

  /** Re-fetches one previously-failed case's detail, same store flow as a fresh row. */
  private async retryFailedCase(failed: CaseFailureRecord, summary: RunSummary): Promise<void> {
    let legalCase: LegalCase;
    try {
      legalCase = await this.detail.fetch(failed.ca, failed.caseNumber);
    } catch (error) {
      if (error instanceof CircuitBreakerError) throw error;

      const reason = describeError(error);
      await this.store.recordCaseFailure({
        caseNumber: failed.caseNumber,
        ca: failed.ca,
        reason,
        attempt: failed.attempt + 1,
        retryable: true,
      });
      summary.casesFailed += 1;
      this.logger.log({ kind: 'case-failed', number: failed.caseNumber, reason });
      return;
    }

    await this.store.appendCase(legalCase);
    summary.casesDetailed += 1;
    this.logger.log({ kind: 'case-detailed', number: legalCase.number });

    await this.downloadDocuments(legalCase, summary);
    await this.store.completeRow(legalCase);
    await this.store.recordCaseSuccess(legalCase.number);
  }

  /** Re-attempts one previously-failed document, only if its case is still on disk. */
  private async retryFailedDocument(
    failed: FailedDocumentRecord,
    caseIndex: Map<string, LegalCase>,
    summary: RunSummary,
  ): Promise<void> {
    const legalCase = caseIndex.get(failed.caseNumber);
    const doc = legalCase?.documents.find((d) => d.download.idProcessoDocumento === failed.documentId);
    if (legalCase === undefined || doc === undefined) return;

    // A single-document view: downloadDocuments iterates `.documents`, so
    // narrowing it here re-attempts only this document, not the case's others.
    await this.downloadDocuments({ ...legalCase, documents: [doc] }, summary);
    await this.store.completeRow(legalCase);
  }
}

/** A zeroed `RunSummary`, shared by `run()` and `retryFailed()` so their starting tallies never drift apart. */
function emptySummary(): RunSummary {
  return {
    windows: 0,
    casesListed: 0,
    casesDetailed: 0,
    casesFailed: 0,
    documentsDownloaded: 0,
    documentsSkipped: 0,
    documentsFailed: 0,
    requests: 0,
    retries429: 0,
    casesOnDisk: 0,
    pendingRows: 0,
    retryableCases: 0,
    retryableDocuments: 0,
  };
}

/** `"ErrorName: message"`, so a recorded failure's reason names the error kind, not just its text. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
