---
id: ISSUE-7
title: Persistence and resuming
status: todo
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

_(pending)_
