# PJe Scraper — TRF5 Public Case Search

A TypeScript scraper for the
[TRF5 PJe public case search](https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam),
built on **plain HTTP requests**: no Puppeteer, Playwright or Selenium.

---

## About the documentation in this repository

This repository deliberately includes the research that preceded the code. These
are not stray notes or leftovers — they are part of the deliverable.

| Document | Contents |
|---|---|
| [`PROBLEMS.md`](PROBLEMS.md) | The 10 obstacles the site presents, with the evidence behind each finding and how it was resolved |
| [`issues/`](issues/) | One issue per module, each with its resolution written on close |
| [`docs/`](docs/) | Scripts that reproduce the probes against the live site |

**Why they are here.** The brief states that *"discovering the site structure, how
pagination works and what information is available"* is part of the challenge. Most
of the real work was not writing the scraper but working out how a 2010-era JSF/Seam
system behaves when it has no API, fails silently, and serves PDFs through single-use
links.

Documenting those findings — including the assumptions that turned out to be **wrong**
and the approaches that were **ruled out** — makes the reasoning behind each design
decision explicit. The clearest case is `PROBLEMS.md` §5.

---

## The central finding: the site has no pagination

The brief asks to "navigate through all pages". **There are no result pages.** Faced
with a broad query the site answers:

> *"Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos.
> Por favor, refine sua pesquisa."*

It cuts off at 30 and offers no way to request the next batch: no `?page=N`, no
pagination control, no offset parameter.

This is verifiable, not a judgement call:

| Query | Rows | Cap warning? |
|---|---|---|
| All of 2025 | 30 | yes |
| One week | 30 | yes |
| One day (2025-03-05) | 10 | no |
| One day (2025-03-08) | 18 | no |

And the contrast that confirms it: the results panel has **zero** pagination controls,
while a case detail page **does** have them (`Richfaces.Datascroller`, which the
scraper walks in ISSUE-5). It is not that paginators are beyond us — there simply
is none on the results.

**The solution** is to cover the corpus with many narrow queries instead of one broad
one, splitting along three dimensions in cascade:

1. **Filing date range (autuação)** — halve the range when it saturates
2. **Judicial class** — when a single day still saturates
3. **Party-name substring tokens** — when a single day + class leaf *still* saturates

The second dimension proved essential: probing March 2025, **6 out of 13 days hit the
cap on their own** (`docs/probe-pagination.sh` reproduces the measurement). The third
dimension is different in kind from the first two: date and class splits are disjoint
partitions whose completeness is proved by construction (recursion stops when no half
saturates), while "Nome da parte" is a `LIKE %token%`
substring match, so filters *overlap* and the resulting subsets are a **cover, not a
partition**. Completeness there is measured, not proved: a leaf is accepted once the
union of cases found across filters stops growing for several filters in a row, and a
leaf whose budget runs out before that point is recorded as incomplete rather than
silently dropped. Full tables and details in `PROBLEMS.md` §5.

---

## Installation

Requires Node.js 20 or newer.

```bash
npm install
npm test   # 243 tests, no network needed
```

## Quick start

A short, bounded run against the real site:

```bash
npm run scrape -- --from=2025-03-05 --to=2025-03-05
```

This prints the range and limits, one line per event as the run progresses, and a
summary block at the end. The capture below is a real run from a clean clone
(abridged: most of the 17 `pdf ... saved` lines collapsed). It happened to hit a genuine burst of
`429`s on the very first request, which is the retry loop doing its job — five
backoff waits, then the search went through:

```
range: 2025-03-05..2025-03-05
limits: maxRequests=40, maxCases=3, delayMs=1500, retryFailed=false
01:03:16 429 -> waiting 1.1s (attempt 1)
01:03:18 429 -> waiting 2.4s (attempt 2)
01:03:22 429 -> waiting 5.1s (attempt 3)
01:03:27 429 -> waiting 8.4s (attempt 4)
01:03:36 429 -> waiting 20.3s (attempt 5)
01:04:04 search 2025-03-05 -> 10 rows
01:04:07 case 0000462-42.2023.8.17.3480 detailed
01:04:09 pdf 0000462-42.2023.8.17.3480 doc 2268615 saved
01:04:10 pdf 0000462-42.2023.8.17.3480 doc 2268614 saved
01:04:12 pdf 0000462-42.2023.8.17.3480 doc 2268705 saved
01:04:19 case 0800577-15.2025.4.05.8302 detailed
...
01:04:53 pdf 0803385-67.2025.4.05.0000 doc 2683265 saved
--- run summary ---
windows: 1
cases listed: 10
cases detailed: 3
cases failed: 0
documents downloaded: 17
documents skipped: 0
documents failed: 0
requests: 40
429 retries: 5
cases on disk: 3
pending rows: 8
retryable cases: 0
retryable documents: 0
stopped by: maxRequests
```

Re-running the same command picks up the 8 pending rows (see "Resuming" below).

By default a run is **bounded**: `--max-requests` (default 40) and `--max-cases`
(default 3) stop it well short of a full crawl, so it is safe to run repeatedly
against the real court server. Pass `--unbounded` to remove both limits for a full
crawl instead (use with care — this is a real court's production service).

What lands on disk:

- `data/*.ndjson` — one append-only file per record kind: `cases.ndjson` (one line
  per scraped case), `pending.ndjson`/`dequeued.ndjson` (the listed-but-not-yet-
  detailed queue), `sweep-progress.ndjson` (which search windows are already
  covered), `failed-documents.ndjson` and `failed-cases.ndjson` (failure ledgers,
  see below). Full schemas in [ISSUE-7](issues/ISSUE-7-persistence.md)'s Resolution.
- `pdfs/<CNJ number>/<date>_<kind>_<documentId>.pdf` — one directory per case, one
  file per document, named from the document's own date and kind so the files are
  identifiable without opening them (`src/pje/pdf-naming.ts`).

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--from=YYYY-MM-DD` | yesterday, UTC | Start of the date range |
| `--to=YYYY-MM-DD` | same as `--from` | End of the date range |
| `--max-requests=N` | 40 | Stop after N network requests |
| `--max-cases=N` | 3 | Stop after N cases detailed |
| `--delay-ms=N` | 1500 | Minimum delay between requests (floor: 500) |
| `--retry-failed` | off | Re-attempt previously failed cases/documents instead of a fresh sweep |
| `--data-dir=PATH` | `data` | Where case/progress data is written |
| `--pdf-dir=PATH` | `pdfs` | Where downloaded PDFs are written |
| `--unbounded` | off | No request/case budget at all — a long-running full crawl |
| `-h`, `--help` | — | Show usage and exit |

## Resuming and retrying

Re-running the same command is safe: `data/*.ndjson` is append-only and rebuilt into
in-memory indexes at startup, so a resumed run skips search windows already recorded
in `data/sweep-progress.ndjson` and skips cases already indexed in
`data/cases.ndjson` — it does not re-search or re-detail what a previous run already
covered, and `PjeDownloader` skips any PDF already valid on disk before re-downloading
it.

A case or document that failed is not retried automatically on the next plain run —
it sits in `data/failed-cases.ndjson` / `data/failed-documents.ndjson` (latest record
per case/document wins; a later success clears an earlier failure). Pass
`--retry-failed` to make a run re-attempt exactly those, instead of sweeping a date
range:

```bash
npm run scrape -- --retry-failed
```

## Rate limiting (429)

A `429` response is detected on any request, retried with exponential backoff and
jitter, honouring the server's `Retry-After` header when present. If retries are
exhausted, the failing case or document is recorded in the relevant failure ledger
and the run continues with the next one rather than stopping. If 429s keep arriving
back to back, a circuit breaker trips and the run aborts cleanly, still printing the
summary collected so far.

No 429 was ever triggered against the real TRF5 server during development — this is
demonstrated instead by tests against a simulated HTTP server (`test/client.test.ts`,
`test/download.test.ts`, `test/backoff.test.ts`), covering a 429 with and without
`Retry-After`, retry exhaustion, and the circuit breaker tripping and resetting.

TRF5's PJe is a real court's public production service. The scraper uses
**concurrency 1** and a configurable delay between requests (`--delay-ms`, floor
500ms) on top of the 429 handling above, so a bounded demo run stays well behaved
even before any rate limit is ever hit.

## Plain HTTP, no browser

The site is 2010s-era JSF/Seam with RichFaces: there is no API, only stateful form
POSTs carrying a `javax.faces.ViewState` tied to a session cookie, the search itself
is triggered by a hidden component (`fPP:j_id244`) rather than the visible button,
and the page's reCAPTCHA is disabled server-side. Mixed encoding (UTF-8 on AJAX
responses, ISO-8859-1 on page loads, with one query parameter that is latin-1 even
inside a UTF-8 response) is handled by inspecting the raw bytes rather than trusting
headers that never arrive. Details and evidence for each of these in
[`PROBLEMS.md`](PROBLEMS.md) §1, §2, §3 and §8.

## Sealed cases (segredo de justiça)

The detail parser (`classifyDetailPage()` in `src/domain/parse-detail.ts`) only
classifies a case as sealed when the page's own notice panel contains the site's
wording ("segredo de justiça" / "autos sigilosos") — never from the mere absence of
the usual case-data heading. A sealed case is stored as a `sealed: true` record with
no parties, movements or documents, and no further requests are made for it.

This is deliberately not the same code path as a broken response: a database error
page or a dropped session also lacks the usual heading but carries none of that
wording, and is classified `unexpected` instead: the orchestrator records it as a
retryable failure (re-attempted with `--retry-failed`) rather than silently treating
it as a real sealed case. See
`PROBLEMS.md` §6 for the live case that motivated the distinction.

## Output format

See [ISSUE-7](issues/ISSUE-7-persistence.md)'s Resolution for the full record
schemas of every file under `data/`.

## Architecture

Layers with dependencies flowing one way:

```
src/http/         transport only: cookies, redirects, encoding, pacing, retries
src/pje/          JSF protocol: session, ViewState, form POSTs
src/domain/       types and pure parsers
src/pipeline/     sweep orchestration
src/persistence/  append-only NDJSON stores and resume/retry state
src/cli/          flags, progress lines, summary
```

The transport layer knows nothing about JSF, and the parsers are pure
`(html: string) => T` functions, which makes them testable without a network.

## Tests

```bash
npm test           # 243 tests, offline
npm run typecheck  # type checking
```

Every test runs offline: parsers are tested as pure functions against real HTML
fixtures captured from the site (`test/fixtures/`), and HTTP behaviour (429, retries,
the circuit breaker) is tested against a simulated server via `nock`, never the live
court.

## License

MIT
