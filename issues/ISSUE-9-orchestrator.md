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
a `logger` event sink) are all injected, against one-method seams
(`DetailFetcher`, `DocumentDownloader`) rather than the concrete
`PjeDetail`/`PjeDownloader` classes, so tests fake them without a cast.
`run({ from, to })` drives the loop for one date range and returns a
`RunSummary`: windows, cases listed/detailed/failed, documents
downloaded/skipped/failed, network activity via an injected
`RequestCounter` (`requests`, `retries429`), and a snapshot read from the
store after the run (`casesOnDisk`, `pendingRows`, `retryableCases`,
`retryableDocuments`) - so a CLI prints facts read from disk, not just
tallies kept in memory during the loop. Every step goes through the
`LogSink`, never `console` directly.

Rows are detailed and downloaded **interleaved with the sweep** - right
after each window's `recordFinalEvent`, not in one pass after the whole
range has been walked - so a short or interrupted run still yields complete,
*detailed* cases near the present, matching the sweep's own "from the
present backwards" framing, and so 9c's future request budget cannot be
spent entirely on searching before a single case is ever detailed. One final
`drainPendingRows()` still runs after, for rows left over from an earlier
run (resume, 9b).

`seen` can be injected (typically `store.rebuildSeenSet()`); `isCovered`
(9b) and `maxRequests` (9c) are deliberately left as TODOs in the options
type rather than half-built - the `isCovered` TODO now names the actual seam
9b needs (`SweepOptions.skipWindow?(query)` inside `sweep.ts`, which does
not exist today; `seen` alone only dedupes after the fact) - so this PR does
not paint the next two into a corner.

**Crash safety fix** (caught in architecture review): the first version of
this PR called `store.completeRow` (append + dequeue) *before* downloading a
case's documents, so a kill mid-download left the row dequeued with no
`localPath`s ever recorded, and a resumed run would see the case as already
indexed and skip it - silently losing those PDFs for good. Fixed: detail now
goes through `store.appendCase` (stored, still pending), documents download,
and only then one `completeRow` (append with `localPath`s, dequeue). A row
resume finds already indexed is no longer just dequeued either - its stored
case is re-run through `downloadDocuments` first (free for whatever already
downloaded, thanks to `PjeDownloader`'s own valid-file check) and only then
`completeRow`'d.

**Failure policy:**

| Failure | Action |
|---|---|
| `detail.fetch` throws anything except `CircuitBreakerError` (`ParseError`, `UnexpectedDetailPageError`, an exhausted `RateLimitError`, a raw network error, ...) | `store.recordCaseFailure({ retryable: true, reason: "<ErrorName>: <message>" })`, dequeue the row, continue with the next row |
| `search` throws `RejectedQueryError` | **ends the whole `sweep()` walk** - it catches nothing of its own, see `sweep.ts` - logged against the run's root query as a sweep-level failure; remaining windows are simply never listed this run (not lost forever - a resumed run, 9b, re-walks them). Per-leaf catching inside `sweep()` is a noted 9b follow-up |
| a document download returns `{ ok: false }`, or `downloader.download` itself throws anything except `CircuitBreakerError` | `store.recordDocumentFailure(...)`, continue with the next document |
| `CircuitBreakerError`, from detail, download or the sweep | finish the persistence writes already in flight, then throw `RunAbortedError { cause, summary }` - the run aborts cleanly, carrying the summary so far |

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
exhausted retry. A second review pass caught the `RejectedQueryError` row
overstating what actually happens (it does not "let the run continue" past
that leaf - the whole walk ends) and flagged the crash-safety and
interleaving issues above.

**Tests**: `test/orchestrator.test.ts`, 10 tests with scripted fakes for
`search`/`detail`/`downloader` (typed against `DetailFetcher`/
`DocumentDownloader`) and a real temp-dir `PersistenceStore` (same style as
`test/persistence-store.test.ts`): the happy path, the crash-safety ordering
(`appendCase` writes no `localPath` before downloads, `completeRow` writes
it after), the already-indexed-row resume path (only the missing document
is really downloaded, the present one resolves free), one test per row of
the policy table above (including a `RateLimitError` from `detail.fetch`
being recorded as a retryable case failure while the next row still gets
detailed), and the summary counts, including the on-disk snapshot fields.
`npm test`: 217/217 green. `npm run typecheck`: clean.

Also touched: `src/http/client.ts` gains `HttpClientOptions.onRequest`
(fired once per network attempt, alongside the existing `onRetry`), so a
`RequestCounter` fed from both can report `requests`/`retries429` without
the orchestrator knowing anything about `HttpClient` - a seam 9c's
`maxRequests` budget will read from directly.

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

**Deferred to 9c**: request budgets (`maxRequests`) and any other run-limit
policy.

## Resolution (part 2 of 3: resume and retry)

Status stays `todo`: this closes resume-across-runs and `--retry-failed`;
request budgets/limits (9c) are still to come and will close the issue.

**`sweep.ts`**: added `SweepOptions.skipWindow?(query): boolean`, checked
before `search(query)` for every leaf the walk visits. A match yields a new,
non-final `skipped` event and the leaf does not recurse - `search` is never
called for it at all. Typically wired to `store.rebuildCoveredPredicate()`,
so a resumed run never re-requests a window an earlier run already recorded
as a final event. Matching is exact-leaf only: a capped ancestor of an
already-covered subtree was never itself a final event (it was split), so it
does not match and gets re-requested on resume - one extra search per
internal node on the covered path, documented as acceptable rather than
taught to reason about whole subtrees (which would mean reimplementing
`PartitionChain`'s own splitting logic).

Also in `sweep.ts`: `RejectedQueryError` is now caught **per leaf**, inside
`walk`, instead of propagating out of the whole generator. A rejected leaf
yields a new, non-final `rejected` event and the walk continues with that
leaf's siblings - the part 1 policy table's worst gap (one malformed query
ending the entire run) is closed. Both `skipped` and `rejected` carry no
`rows` and are never deduplicated or recorded as covered - they are purely
informational for a log sink.

**`orchestrator.ts`**:

- `runSweep` now builds `seen` from `store.rebuildSeenSet()` and `skipWindow`
  from `store.rebuildCoveredPredicate()` (unless `seen` was injected) and
  passes both into `sweep()`. The failure-policy table's `RejectedQueryError`
  row is updated: the leaf is skipped and logged, the walk continues, no
  `RunAbortedError`. The now-obsolete `sweep-rejected` log kind is removed -
  a rejected leaf is just another `SweepEvent` logged through the existing
  `{ kind: 'sweep' }` case.
- New `retryFailed()`: a second pass over `store.listRetryableCases()` and
  `store.listRetryableDocuments()`, independent of any sweep. A retried case
  goes through the same store flow as a fresh row (`appendCase` pending,
  download its documents, `completeRow`), then `recordCaseSuccess` clears it
  from the ledger. A retried document re-attempts only that one document (by
  handing `downloadDocuments` a single-document view of its case, so the
  case's other documents are left untouched) and only if its case is still
  on disk. Returns the same `RunSummary` type as `run()`.
- `emptySummary()` factors out the zeroed-tally literal `run()` and
  `retryFailed()` both start from, so their thirteen fields cannot drift out
  of sync with each other.

**Tests**: two new `test/sweep.test.ts` cases (a skipped window is never
searched; a rejected leaf is logged and the walk continues with its
siblings) and five new `test/orchestrator.test.ts` cases - a window already
recorded as final is skipped on a second run and never re-listed; running
the same range twice (simulating a kill-and-restart) produces no duplicate
cases and no re-downloads; `retryFailed` re-fetches a failed case and clears
it from the ledger; `retryFailed` re-downloads only the one previously-failed
document, leaving its case's other documents untouched; and the existing
`RejectedQueryError` policy test is updated for the new continue-not-abort
behaviour. `npm test`: 223/223 green. `npm run typecheck` (`tsc --noEmit`):
clean.

**Deferred to 9c**: request budgets (`maxRequests`) and any other run-limit
policy, and `scripts/smoke-orchestrator.ts`.
