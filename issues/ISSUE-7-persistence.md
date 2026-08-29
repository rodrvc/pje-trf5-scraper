---
id: ISSUE-7
title: Persistence and resuming
status: done
---

## Goal

Make runs interruptible and resumable without repeating work. The brief says
there is no need to download everything in one go, but the scraper must show it
would get there if left running.

Resolves problem 10 in `PROBLEMS.md`.

## Scope

- `data/cases.ndjson`: one record per case, appended incrementally without
  rewriting the whole file
- `data/state.json`: date windows already covered (ISSUE-4), for resuming
- `data/failed.json`: failed documents with reason and attempt count, plus a
  `--retry-failed` mode. The brief asks for this explicitly as part of 429
  handling
- Idempotence: never re-download a PDF already present and valid; deduplicate
  cases by CNJ number
- **Atomic state writes**: temp + rename, like the PDFs. Better still, append-only
  state (NDJSON of completed windows) rebuilt at startup, which removes the whole
  class of corruption bugs
- `ca=` tokens **can** be persisted: they were verified not to expire with the
  session (they work with no cookie at all), so resuming does not require
  re-running the search to reach an already-listed case

## Acceptance

- Killing the process midway and restarting duplicates no records and
  re-downloads no PDFs.

## Resolution

**`src/persistence/`** — five small, single-purpose stores behind one façade,
`PersistenceStore` (`store.ts`), which is the only thing ISSUE-9's orchestrator
needs to import.

### Modules

- `ndjson-log.ts` — the shared primitive: `appendLine(path, record)` (one
  `appendFile` of one complete `\n`-terminated JSON line) and
  `readLines(path, parse)` (missing file reads as empty; a line that fails to
  parse is logged with `console.warn` and dropped rather than crashing
  startup). Every store below is built on these two functions, so "tolerate a
  truncated last line" and "one syscall per write" live in one place instead
  of five near-duplicates.
- `case-store.ts` → `data/cases.ndjson`.
- `pending-store.ts` → `data/pending.ndjson` + `data/dequeued.ndjson`.
- `sweep-progress-store.ts` → `data/sweep-progress.ndjson`. Absorbs
  `src/pipeline/uncoverable.ts` (removed, along with its test): that module
  was an unwired NDJSON sink for `abandoned` events only, written ahead of
  this issue with an explicit note that ISSUE-7 owns general persistence.
  `SweepProgressStore.recordEvent` now handles `abandoned` through the same
  path as `window`/`unsplittable`/`covered`, so there is one format for
  "a final sweep event happened," not two.
- `failed-document-store.ts` → `data/failed-documents.ndjson`.

### File formats (one example line each)

`data/cases.ndjson`:

    {"number":"0000462-42.2023.8.17.3480","ca":"ca-token-abc","activeParties":[...],"passiveParties":[...],"movements":[...],"documents":[...],"sealed":false,"extractedAt":"2026-01-01T00:00:00.000Z"}

`data/pending.ndjson` (a listed row awaiting its detail fetch) and
`data/dequeued.ndjson` (a bare number marking that fetch attempted):

    {"number":"case-a","ca":"ca-abc"}
    {"number":"case-a"}

`data/sweep-progress.ndjson` (a final `SweepEvent`, `rows` reduced to CNJ
numbers):

    {"type":"window","query":{"from":"2025-03-11","to":"2025-03-11"},"depth":0,"cnjNumbers":["a","b"],"recordedAt":"2026-01-01T00:00:00.000Z"}

`data/failed-documents.ndjson` (a failure, and the success that later clears it):

    {"type":"failure","caseNumber":"case-a","documentId":"doc-1","downloadRef":{...},"reason":"HTTP 429","httpStatus":429,"attempt":1,"retryable":true,"recordedAt":"..."}
    {"type":"success","caseNumber":"case-a","documentId":"doc-1","recordedAt":"..."}

### Why NDJSON instead of `state.json`/`failed.json` (temp+rename)

The issue's original scope named single mutable JSON files
(`data/state.json`, `data/failed.json`) with temp+rename atomicity, the same
scheme ISSUE-6 uses for PDF files. A whole-file JSON store has to be read,
mutated and rewritten **in full** on every single event; a process killed
between "read" and "rename" loses nothing (rename is atomic), but the write
itself is O(current file size) on every append, and — more importantly — nothing
about "the whole file" composes well with an append-only design elsewhere in
the run (PDFs, cases). Append-only NDJSON removes the temp+rename dance
entirely: a single `appendFile` of one complete line is already atomic at the
size every record here is (well under a filesystem's atomic write/pipe-buffer
threshold), so there is no whole-file rewrite to protect in the first place.
The tradeoff is that every store needs a "rebuild current state from history"
read (index / latest-wins / set-difference) instead of the file already
being the current state — a trade worth making, since every store here is
read once per run, at startup, not on a hot per-row path.

### Resume semantics

1. **Cases**: `CaseStore.index()` rebuilds a CNJ → `LegalCase` map. The `ca`
   token travels with each row (PROBLEMS.md §6: verified not to expire with
   the session), so a case already in this index needs no re-search to reach
   its detail again — resuming skips straight past it.
2. **Listed-but-not-detailed rows**: `PendingStore.listPending()` is the set
   difference of `pending.ndjson` minus `dequeued.ndjson`, latest-listing-per-
   number. A row is dequeued once its detail fetch is *attempted*, success or
   failure alike — a failed detail fetch is a different retry story
   (ISSUE-9's failure policy) than "never tried," and leaving it forever in
   `listPending()` would stop the queue from ever draining.
3. **Sweep progress**: `SweepProgressStore.rebuildSeenSet()` and
   `rebuildCoveredPredicate()` rebuild from every recorded final event.
   **Depth-first caveat, documented in the module comment**: the predicate
   can only answer "was this *exact* leaf window recorded as final" — it has
   no notion of the `PartitionChain` tree, so it cannot say "is everything
   under this window done" for a window that was `capped` and split (that
   event kind is never persisted here, by design: a capped window's rows are
   informational only, per `sweep.ts`'s own doc comment). A resumed sweep
   still walks into a partially-covered day and re-discovers, leaf by leaf,
   which class splits are already done; it just never re-runs the *query*
   for a leaf already recorded.
4. **Failed documents**: `FailedDocumentStore.listRetryable()` keeps only the
   **latest** record per (case, document) pair. A `success` after a
   `failure` clears it; a `failure` after a `success` re-adds it. Only
   `retryable: true` failures are returned — a permanent outcome (e.g. 404)
   is excluded so `--retry-failed` (ISSUE-8/9) does not waste requests
   reconfirming it.

### Acceptance criterion: "kill midway and restart duplicates nothing"

Evidenced by `test/persistence-store.test.ts`'s `"kill-and-restart"` case:
one `PersistenceStore` writes a sweep event, enqueues two rows, dequeues and
stores one of them, then a **second, independent `PersistenceStore` instance
over the same directory** (simulating a fresh process after a kill) is
asserted to see exactly that state — the stored case present, the un-detailed
row still pending, the seen-set and covered-predicate both rebuilt correctly.
A second test in the same file re-records the identical sweep event and
re-appends the identical case (simulating a crash *after* a write landed but
*before* the run recorded having done it, so the same work is retried) and
asserts the case index still has exactly one entry — append-then-dedup-at-read
absorbs the duplicate rather than needing write-time locking. Every
individual store also has its own idempotent-append test
(`case-store.test.ts`, `pending-store.test.ts`, `failed-document-store.test.ts`).

### `PersistenceStore` façade — method list

    appendCase(legalCase)                    indexCases()                  hasCase(number)
    enqueueRow(row)                          dequeueRow(number)            listPendingRows()
    recordSweepEvent(event)                  rebuildSeenSet()              rebuildCoveredPredicate()
    recordDocumentFailure(record)            recordDocumentSuccess(caseNumber, documentId)
    listRetryableDocuments()

A short usage sketch (sweep → persist → detail → documents → retry) is in the
module's own comment (`src/persistence/store.ts`).

### Verification

`npm test`: **208 tests green** (179 baseline + 32 new across
`ndjson-log.test.ts`, `case-store.test.ts`, `pending-store.test.ts`,
`sweep-progress-store.test.ts`, `failed-document-store.test.ts`,
`persistence-store.test.ts`, minus 3 removed with `uncoverable.test.ts`).
`npm run typecheck` clean. No network was used — every test runs against a
temp directory (`mkdtemp`), removed in `afterEach`. `data/` is confirmed
already gitignored (`.gitignore` line 8).

### Left for ISSUE-9

- Wiring `PersistenceStore` into the actual sweep/detail/download loop (this
  issue only builds and tests the stores themselves).
- The `--retry-failed` CLI flag (ISSUE-8) and the failure-policy decision of
  *when* to call `recordDocumentFailure` vs. retry in-process (ISSUE-9's
  "explicit failure policy").
- Deciding, per detail-fetch failure, whether it belongs in a case-level
  failed-record too (this issue only specified failed *documents*, per the
  brief's explicit ask; a symmetric case-level failure ledger was judged out
  of scope until ISSUE-9 shows it is actually needed, to avoid building a
  second failure format nothing calls yet).
