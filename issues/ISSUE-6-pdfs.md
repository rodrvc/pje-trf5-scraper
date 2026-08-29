---
id: ISSUE-6
title: PDF downloads
status: done
---

## Goal

Download attached documents with descriptive names. Requirement 2 of the brief.

Resolves problem 7 in `PROBLEMS.md`. The mechanism is already verified by hand:
a real 19 KB PDF was downloaded.

## Scope

- Build the document GET with `idBin`, `numeroDocumento`, `nomeArqProcDocBin`,
  `idProcessoDocumento` and `actionMethod`
- **Follow the redirect right away**: it leads to `download.seam?cid=<N>`, where
  the `cid` is ephemeral, single-use and session-bound. Reusing it returns 404,
  so links cannot be collected for later bulk download
- Store organised by case:

      pdfs/<CNJ-number>/<date>_<kind>_<documentId>.pdf

- Sanitise the filename **after** decoding. The `documentId` is what guarantees
  uniqueness: sanitising can collapse two distinct readable names into one, so
  the readable part is decorative and the id always travels
- Write to a temp file and rename on completion, so an interrupted run does not
  leave a truncated PDF that later looks valid

## Validation

- Check `Content-Type: application/pdf` before writing. An HTML response means a
  dropped session or an error: treat as failure and re-establish
- Verify the written file's `%PDF` magic header

## Acceptance

- Downloaded PDFs open correctly.
- Failures are recorded for later retry (ISSUE-7).

## Resolution

Built in two pieces, HTTP mechanism separated from file naming, same split as
the client/session layering in ISSUE-2:

**`src/pje/pdf-naming.ts`** - pure, synchronous path logic:
- `pdfPath(rootDir, caseNumber, doc)` builds `pdfs/<CNJ-number>/<date>_<kind>_<documentId>.pdf`
- `sanitiseSegment()` strips anything that is not a letter, digit, dot, dash or
  underscore, collapses runs of `_`, and never returns an empty string.
  Applied **after** decoding (the fields on `CaseDocument` already arrive
  decoded via `nomeArqProcDocBin`/`parseDocuments()`), and applied per-segment
  rather than to a whole path, so a hostile value cannot inject a path
  separator into the result
- `idProcessoDocumento` is embedded unsanitised (it is always a bare numeric
  id straight from the query string) so two documents whose decorative
  name/kind sanitise to the same string still never collide on disk - tested
  directly in `test/pdf-naming.test.ts`

**`src/pje/download.ts`** - the HTTP mechanism, `PjeDownloader`:
- `buildDownloadUrl()` reconstructs the exact GET a real detail page link
  performs: the target is not a distinct download endpoint, it is the same
  `listView.seam` the case detail lives at, with the five `DocumentDownloadRef`
  fields as query params. Verified against `test/fixtures/detail-with-pagination.html`,
  which carries 19 real document links of this exact shape (confirmed by
  `grep -o 'href="[^"]*idBin=[^"]*"'`), e.g.:

      .../DetalheProcessoConsultaPublica/listView.seam?idBin=2674336&numeroDocumento=b4228890...
        &nomeArqProcDocBin=Inteiro+Teor&idProcessoDocumento=2683486
        &actionMethod=ConsultaPublica%2FDetalheProcessoConsultaPublica%2FlistView.xhtml%3AprocessoDocumentoBinHome.setDownloadInstance%28row%29

- The GET is issued through `HttpClient.getBinary()`, which already follows
  the 302 to `download.seam?cid=<N>` (axios `maxRedirects: 5`) with the
  cookie jar intact - the redirect is followed immediately, in the same
  request, so the ephemeral `cid` is never persisted or reused
- **429 is not reimplemented.** `HttpClient`'s existing backoff/`Retry-After`/
  circuit breaker (ISSUE-2) already sees a 429 as the final status of the
  whole request and retries by re-issuing it from the *original* document
  URL - which mints a fresh `cid` on the next 302, so a retry never touches a
  stale one. A 429 landing specifically on the redirect target
  (`download.seam?cid=N`, not the document URL) was verified by hand with a
  throwaway nock chain (302 -> 429 -> 302 -> 200 through two distinct `cid`s)
  before writing the permanent test; `test/download.test.ts`'s "429 handling
  on downloads" suite keeps that proof: a 429-then-success case (evidence the
  backoff runs on this path), a retries-exhausted case asserting
  `retryable: true` and the attempt count, and a circuit-breaker case
- Content-Type is checked before anything is written: an HTML response (the
  session dropped, or an error page rendered with 200) triggers
  `JsfSession.reestablish()` and one retry - the same "one retry is enough"
  discipline `JsfSession.post` already uses. A second HTML response propagates
  as a `retryable: true` failure rather than looping
- The written bytes are checked for the `%PDF` magic header even when
  Content-Type claimed `application/pdf`, since a mislabelled error page is
  not ruled out
- Writes go to `<path>.tmp` and are `rename()`d on completion - the rename is
  the only atomic step, so a process killed mid-write (or a write that throws)
  never leaves a `.pdf` that later looks valid, only a `.tmp` or nothing
- Idempotence: before any request, if `<path>` exists and its first bytes are
  `%PDF`, `download()` returns `{ ok: true, skipped: true, path, bytes }`
  immediately - no request is made. This is what ISSUE-7's resume relies on.
  A file that exists but fails the magic check (leftover garbage from an
  earlier bug, say) is *not* trusted and gets re-downloaded
- `CaseDocument.localPath` is set on both the fresh-download and the
  already-valid path

**Never writes `data/failed.json`.** `download()` returns a discriminated
`DownloadResult` (`{ ok: true, path, bytes, skipped }` |
`{ ok: false, reason, status?, retryable, attempts }`); ISSUE-7/9 own
recording failures from it.

### Traps found while building this

- The detail page also renders a second, unrelated document link shape -
  `documentoSemLoginHTML.seam?ca=...` behind an `openPopUp(...)` JS call, used
  for a different in-page viewer. It is **not** what `parseDocuments()`
  extracts and is not what this module downloads; only the `idBin=`-bearing
  `href` matters. Worth noting because grepping the fixture for `.seam?ca=`
  alone would have pointed at the wrong link.
- `JsfSession.http` is private, by design (transport is not meant to leak past
  the protocol layer). `PjeDownloader` takes `HttpClient` as its own
  constructor dependency instead of reaching through `session` - keeps the
  dependency explicit and avoids widening `JsfSession`'s public surface for
  one caller.

### Verification

`npm test`: **197 tests green** (18 new: 10 in `test/download.test.ts`, 8 in
`test/pdf-naming.test.ts`), no network. `npm run typecheck`: clean.

**Live smoke** (`scripts/smoke-download.ts`, `delayMs: 1500`): searched
2026-01-05..2026-01-06 (30 rows, capped), opened the first case with
documents - **0813029-18.2024.4.05.8100** - and downloaded its first document,
a **Despacho dated 2025-07-25**. Result:

    { "ok": true, "path": "pdfs/0813029-18.2024.4.05.8100/2025-07-25_Despacho_5786294.pdf",
      "bytes": 20872, "skipped": false }

Confirmed with `file`: "PDF document, version 1.4, 2 pages". 5 live requests
total (search open, search post, detail open, download GET, redirect-follow
GET), within the 6-request budget. The file was deleted after verification;
`pdfs/` is gitignored (confirmed in `.gitignore`).
