/**
 * The sweep orchestrator: coordinates sweep -> detail -> PDFs -> persistence.
 *
 * Without this piece the business logic ends up living in `main()` - the
 * classic anti-pattern in scrapers (ISSUE-9). The CLI (ISSUE-8) only parses
 * flags and instantiates a `Scraper`; every decision about what to do with a
 * sweep event, a failed detail fetch or a failed download lives here.
 *
 * The loop and its failure policy are part 1; resume/retry (9b) is here too;
 * request/case budgets and the class-split sanity check (9c) round it out.
 *
 * Rows are detailed as soon as their window is recorded (interleaved with the
 * sweep), not after the whole range has been walked: the sweep already walks
 * "from the present backwards" so a short or interrupted run still lands
 * complete, contiguous, *detailed* cases near one end of the range, not just
 * complete search windows with nothing behind them - and a budget (9c) would
 * otherwise be spent entirely on searching before a single case gets
 * detailed. `drainPendingRows` still runs once at the end (unless the budget
 * already stopped the run), for rows a previous run left pending (resume,
 * 9b) or that a `cover`'s dedup left unprocessed mid-walk.
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
 *
 * `retryFailed()` (9b) uses `appendCase` instead of `completeRow` for both
 * retry paths: a retried case/document was never enqueued in `PendingStore`
 * for this attempt, so there is no row to dequeue - `completeRow` would
 * write a meaningless line to `dequeued.ndjson` for a row that was never
 * pending.
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
  | { kind: 'run-aborted'; reason: string }
  | { kind: 'classSplitCheck'; day: string; childrenRows: number; ok: boolean };

/** Log sink the orchestrator reports every event through. Never `console` directly. */
export interface LogSink {
  log(event: OrchestratorLogEvent): void;
}

/** Tallies produced by one run, printed by the CLI (ISSUE-8). */
export interface RunSummary {
  windows: number;
  /** Leaves skipped via `skipWindow` (9b: resume) - already covered by an earlier run. */
  windowsSkipped: number;
  /** Leaves abandoned per-leaf after `search` threw `RejectedQueryError` (9b). */
  windowsRejected: number;
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
  /**
   * Set when `limits` (9c) stopped the run before it walked out naturally -
   * `undefined` means the sweep and drain both ran to completion. A bounded
   * stop is not an abort: it is a clean, successful run that simply chose
   * not to do more work (see `RunLimits`).
   */
  stoppedBy: 'maxRequests' | 'maxCases' | undefined;
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

/**
 * A bounded demo run's request/case budget (9c). `maxRequests` needs
 * `requestCounter` wired in - it is the only thing that knows how many
 * network attempts have actually happened (`HttpClientOptions.onRequest`).
 */
export interface RunLimits {
  /** Stop once `requestCounter.requests` reaches this many network attempts. */
  maxRequests?: number;
  /** Stop once this many cases have had their detail fetched (successfully). */
  maxCases?: number;
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
  requestCounter?: RequestCounter;
  /** Optional request/case budget for a bounded demo run (9c). Omit for an unbounded run. */
  limits?: RunLimits;
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
  private readonly limits: RunLimits | undefined;
  /** Set once a budget is hit; checked before starting any further new work. */
  private stoppedBy: 'maxRequests' | 'maxCases' | undefined;

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
    this.limits = options.limits;
  }

  /** Which budget (9c) has been reached, if any - a clean stop, not an abort. */
  private budgetExceeded(summary: RunSummary): 'maxRequests' | 'maxCases' | undefined {
    const { maxRequests, maxCases } = this.limits ?? {};
    if (maxRequests !== undefined && (this.requestCounter?.requests ?? 0) >= maxRequests) {
      return 'maxRequests';
    }
    if (maxCases !== undefined && summary.casesDetailed >= maxCases) {
      return 'maxCases';
    }
    return undefined;
  }

  /** Runs the full sweep -> detail -> PDFs -> persistence flow for one date range. */
  async run(range: { from: string; to: string }): Promise<RunSummary> {
    const summary = emptySummary();
    this.stoppedBy = undefined;

    try {
      await this.runSweep(range, summary);
      if (this.stoppedBy === undefined) {
        await this.drainPendingRows(summary);
      }
    } catch (error) {
      // Cross-cutting abort: a circuit breaker (or anything else the sweep,
      // detail fetch or download did not itself turn into a recorded
      // failure) stops the run. Whatever persistence writes already
      // happened for earlier rows stand - only the walk itself unwinds.
      summary.stoppedBy = this.stoppedBy;
      await this.finalizeSummary(summary);
      this.logger.log({ kind: 'run-aborted', reason: describeError(error) });
      throw new RunAbortedError(error, summary);
    }

    summary.stoppedBy = this.stoppedBy;
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
    const generator = sweep({
      from: range.from,
      to: range.to,
      search: this.search,
      chain: this.chain,
      ...(this.cover !== undefined ? { cover: this.cover } : {}),
      seen,
      skipWindow,
    });
    const classSplitCheck = new ClassSplitCheck(this.logger);

    try {
      for (;;) {
        // Before every next search: a hit here means no further search runs.
        // `generator.return()` closes the sweep's async generator cleanly.
        const exceeded = this.budgetExceeded(summary);
        if (exceeded !== undefined) {
          this.stoppedBy = exceeded;
          await generator.return(undefined);
          return;
        }

        const step = await generator.next();
        if (step.done === true) return;
        const event = step.value;

        this.logger.log({ kind: 'sweep', event });
        classSplitCheck.observe(event);
        if (isFinalSweepEvent(event)) {
          summary.windows += 1;
          summary.casesListed += event.rows.length;
          await this.store.recordFinalEvent(event);
          for (const row of event.rows) {
            // Before every detail fetch: the rest of this window is left
            // pending (a resumed run, 9b, or `drainPendingRows` picks it up).
            const rowExceeded = this.budgetExceeded(summary);
            if (rowExceeded !== undefined) {
              this.stoppedBy = rowExceeded;
              await generator.return(undefined);
              return;
            }
            await this.processRow(row, summary);
          }
          continue;
        }
        // `skipped`/`rejected` (9b) carry no rows: nothing to persist, just tally.
        if (event.type === 'skipped') summary.windowsSkipped += 1;
        if (event.type === 'rejected') summary.windowsRejected += 1;
      }
    } finally {
      classSplitCheck.finish(this.stoppedBy !== undefined);
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
      // Same budget check as `runSweep`, before any row's detail/re-download.
      const exceeded = this.budgetExceeded(summary);
      if (exceeded !== undefined) {
        this.stoppedBy = exceeded;
        return;
      }

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
      await this.downloadOne(legalCase, doc, summary);
    }
  }

  /**
   * Downloads one document and records the outcome. Factored out of
   * `downloadDocuments` so `retryFailedDocument` (9b) can re-attempt exactly
   * one document by reference, without constructing a partial-case view
   * that would silently drop the case's other documents if `LegalCase` were
   * ever cloned instead of spread.
   *
   * `attemptOverride` lets `retryFailedDocument` supply the failure ledger's
   * own cross-run attempt count and the `MAX_RETRY_ATTEMPTS` cap instead of
   * `attemptDownload`'s per-call `sessionAttempts`/`retryable` (which only
   * knows about this one call, not the document's retry history).
   */
  private async downloadOne(
    legalCase: LegalCase,
    doc: CaseDocument,
    summary: RunSummary,
    attemptOverride?: { attempt: number; retryable: boolean },
  ): Promise<void> {
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
      return;
    }

    await this.store.recordDocumentFailure({
      caseNumber: legalCase.number,
      documentId: doc.download.idProcessoDocumento,
      downloadRef: doc.download,
      reason: result.reason,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      attempt: attemptOverride?.attempt ?? result.sessionAttempts,
      retryable: attemptOverride?.retryable ?? result.retryable,
    });
    summary.documentsFailed += 1;
    this.logger.log({
      kind: 'document-failed',
      caseNumber: legalCase.number,
      documentId: doc.download.idProcessoDocumento,
      reason: result.reason,
    });
  }

  /**
   * `--retry-failed` (9b): re-attempts every case whose detail fetch
   * previously failed and every document whose download previously failed -
   * a second pass over the two failure ledgers, no sweep involved. Wrapped
   * like `run()`: a `CircuitBreakerError` aborts cleanly with the summary
   * accumulated so far, same `RunAbortedError` the sweep path throws.
   *
   * A retried case goes through the same store flow as a fresh row minus
   * the pending queue, which it was never on - `appendCase` (not
   * `completeRow`, which would dequeue a row that was never enqueued and
   * write a meaningless line to `dequeued.ndjson`), download, then
   * `recordCaseSuccess` clears it from the ledger. A retried document
   * re-attempts only that one (see `retryFailedDocument`), and only if its
   * case is still on disk - a missing case would mean the case store was
   * tampered with, not a normal retry scenario, so it is skipped rather than
   * guessed at.
   */
  async retryFailed(): Promise<RunSummary> {
    const summary = emptySummary();

    try {
      for (const failedCase of await this.store.listRetryableCases()) {
        await this.retryFailedCase(failedCase, summary);
      }

      const caseIndex = await this.store.indexCases();
      for (const failedDocument of await this.store.listRetryableDocuments()) {
        await this.retryFailedDocument(failedDocument, caseIndex, summary);
      }
    } catch (error) {
      await this.finalizeSummary(summary);
      this.logger.log({ kind: 'run-aborted', reason: describeError(error) });
      throw new RunAbortedError(error, summary);
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
      const attempt = failed.attempt + 1;
      await this.store.recordCaseFailure({
        caseNumber: failed.caseNumber,
        ca: failed.ca,
        reason,
        attempt,
        retryable: attempt < MAX_RETRY_ATTEMPTS,
      });
      summary.casesFailed += 1;
      this.logger.log({ kind: 'case-failed', number: failed.caseNumber, reason });
      return;
    }

    await this.store.appendCase(legalCase);
    summary.casesDetailed += 1;
    this.logger.log({ kind: 'case-detailed', number: legalCase.number });

    await this.downloadDocuments(legalCase, summary);
    await this.store.appendCase(legalCase);
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

    const attempt = failed.attempt + 1;
    await this.downloadOne(legalCase, doc, summary, { attempt, retryable: attempt < MAX_RETRY_ATTEMPTS });
    await this.store.appendCase(legalCase);
  }
}

/** Cross-run retry cap for both failure ledgers: the third failure stops further retries. */
const MAX_RETRY_ATTEMPTS = 3;

/** A zeroed `RunSummary`, shared by `run()` and `retryFailed()` so their starting tallies never drift apart. */
function emptySummary(): RunSummary {
  return {
    windows: 0,
    windowsSkipped: 0,
    windowsRejected: 0,
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

/**
 * ISSUE-4's known gap: `JudicialClassSplit`'s completeness rests entirely on
 * its catalog being the court's full set of classes - a silently-missing
 * class would make every emitted class-window look uncapped while its cases
 * go unreached. Sanity check ISSUE-4's resolution asks ISSUE-9 to run: when a
 * day is `capped` and split `by: 'judicial-class'`, sum the rows of every
 * child final event in that subtree (the final events at
 * `depth === cappedDepth + 1`, until a shallower event or the sweep's end
 * closes the subtree) and compare against the site's own cap (30). Agreement
 * is not proof the catalog is complete, but a shortfall is strong evidence it
 * is not - and costs nothing beyond arithmetic already in the event log.
 */
const SEARCH_CAP = 30;

class ClassSplitCheck {
  private pending: { day: string; cappedDepth: number; childrenRows: number } | undefined;

  constructor(private readonly logger: LogSink) {}

  /** Feed every `SweepEvent` the walk yields, in order. */
  observe(event: SweepEvent): void {
    if (this.pending !== undefined && event.depth <= this.pending.cappedDepth) {
      this.close();
    }

    if (event.type === 'capped' && event.splitBy === 'judicial-class') {
      this.close(); // a still-open subtree here would mean nested class splits, which cannot happen (split-once)
      this.pending = { day: event.query.from, cappedDepth: event.depth, childrenRows: 0 };
      return;
    }

    if (this.pending !== undefined && isFinalSweepEvent(event) && event.depth === this.pending.cappedDepth + 1) {
      this.pending.childrenRows += event.rows.length;
    }
  }

  /** Call once after the sweep ends, in case its last event left a subtree still open. */
  finish(): void {
    this.close();
  }

  private close(): void {
    if (this.pending === undefined) return;
    const { day, childrenRows } = this.pending;
    this.pending = undefined;
    this.logger.log({ kind: 'classSplitCheck', day, childrenRows, ok: childrenRows >= SEARCH_CAP });
  }
}
