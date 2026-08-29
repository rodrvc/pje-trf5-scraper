---
id: ISSUE-9
title: Sweep orchestrator
status: todo
---

## Goal

Coordinate the full flow: sweep → detail → PDFs → persistence.

Without this piece the business logic ends up living in `main()`, the classic
anti-pattern in scrapers. The CLI should be a flag parser that instantiates and
starts the orchestrator, nothing more.

## Scope

- State machine for the walk
- **Explicit failure policy**: does a broken detail abort the run or just get
  recorded? (the brief asks to continue and record)
- Injection point for persistence (ISSUE-7)
- Expired-session handling as a cross-cutting concern (ISSUE-2)

## Acceptance

- The CLI contains no business logic.
- An isolated failure does not bring down the whole run.

## Resolution (part 1 of 3: the loop)

Status stays `todo`: this closes only the walk and its failure policy;
resume/retry (9b) and request budgets/limits (9c) are separate PRs still to
come.

Built `src/pipeline/orchestrator.ts`: a `Scraper` class whose collaborators
(`search`, `detail`, `downloader`, `store`, `chain`, an optional `cover`, and
a `logger` event sink) are all injected. `run({ from, to })` drives the
sweep-then-detail-then-download loop for one date range and returns a
`RunSummary` (windows, cases listed/detailed/failed, documents
downloaded/skipped/failed, 429 retries observed via an injected
`RetryCounter`). Every step - each `SweepEvent`, each case detailed or
failed, each document outcome, and a clean run abort - goes through the
`LogSink`, never `console` directly, so a CLI (ISSUE-8) can render it
however it likes.

`seen` can be injected (typically `store.rebuildSeenSet()`); `isCovered`
(9b) and `maxRequests` (9c) are deliberately left as TODOs in the options
type rather than half-built, so this PR does not paint the next two into a
corner.

**Failure policy:**

| Failure | Action |
|---|---|
| `detail.fetch` throws anything except `CircuitBreakerError` (`ParseError`, `UnexpectedDetailPageError`, a `RateLimitError` that exhausted its retries, a raw network error, ...) | `store.recordCaseFailure({ retryable: true, reason: "<ErrorName>: <message>" })`, dequeue the row, continue with the next row |
| `search` throws `RejectedQueryError` | logged through the sink as a sweep-level failure, run continues |
| a document download returns `{ ok: false }`, or `downloader.download` itself throws anything except `CircuitBreakerError` | `store.recordDocumentFailure(...)`, continue with the next document |
| `CircuitBreakerError`, from detail, download or the sweep | finish the persistence writes already in flight, then rethrow - the run aborts cleanly |

The brief's "continue with the next document/case if the error persists
after several attempts" is exactly what `PjeDownloader`'s retry/session
recovery and `HttpClient`'s own 429 retry loop already do before an error
ever reaches this module - by the time `detail.fetch` or
`downloader.download` throws, that retrying has already happened and given
up, so this loop never retries either of them itself, it only decides what
to do once they have given up. Only `CircuitBreakerError` overrides
"continue" with "stop hammering the server altogether" - a review pass
caught an earlier version of this policy conflating "unknown error" with
"unrecoverable", which would have aborted the whole run on an ordinary
exhausted retry.

**Tests**: `test/orchestrator.test.ts`, 9 tests with scripted fakes for
`search`/`detail`/`downloader` and a real temp-dir `PersistenceStore` (same
style as `test/persistence-store.test.ts`): the happy path (persists the
case, then re-persists with `localPath`s filled in), a row already in the
case index being dequeued without a detail fetch, one test per row of the
policy table above (including a `RateLimitError` from `detail.fetch` being
recorded as a retryable case failure while the next row still gets
detailed), and the summary counts. `npm test`: 216/216 green. `npm run
typecheck`: clean.

**Live smoke**: run once during development against `from = to = 2025-03-05`
(10 cases, no class split needed - the day did not saturate), downloading
documents for real only for the first case detailed to keep the live request
count small, while every other case still got a real detail fetch so the
loop itself was exercised end to end, not just the search.

Results: 1 window, 10 cases listed, 9 detailed, 1 failed (a genuine live
`UnexpectedDetailPageError` - a database error page from the real site -
recorded via `recordCaseFailure`, exercising that policy row against the
real site rather than a fake); 3 documents downloaded, 33 skipped by the
run's own cap, 0 failed; 0 retries observed. `data/`/`pdfs/` used temp
directories, removed afterwards, and are gitignored regardless.

The smoke script itself (`scripts/smoke-orchestrator.ts`) is not part of this
PR - moved out during review to stay within the diff-size target - and will
land with 9c, which does the equivalent demo run for budgets/limits.

**Deferred to 9b**: resume across runs (skipping already-covered windows via
`isCovered`, retrying previously-failed cases/documents via
`listRetryableCases`/`listRetryableDocuments`).
**Deferred to 9c**: request budgets (`maxRequests`) and any other run-limit
policy.
