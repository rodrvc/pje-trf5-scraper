# PJe Scraper — TRF5 Public Case Search

A TypeScript scraper for the
[TRF5 PJe public case search](https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam),
built on **plain HTTP requests**: no Puppeteer, Playwright or Selenium.

> **Status: work in progress.** See the [issue board](issues/) for current state.

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
one, splitting along two dimensions in cascade:

1. **Filing date range (autuação)** — halve the range when it saturates
2. **Judicial class** — when a single day still saturates

The second dimension proved essential: probing March 2025, **6 out of 13 days hit the
cap on their own**. Full tables and details in `PROBLEMS.md` §5.

---

## Installation

```bash
npm install
```

Requires Node.js 20 or newer.

## Usage

```bash
npm run scrape     # run the scraper
npm test           # test suite (no network required)
npm run typecheck  # type checking
```

> Detailed run instructions land with ISSUE-8.

## Architecture

Layers with dependencies flowing one way:

```
src/http/      transport only: cookies, redirects, encoding, pacing, retries
src/pje/       JSF protocol: session, ViewState, form POSTs
src/domain/    types and pure parsers
src/pipeline/  sweep orchestration
src/cli/       flag parsing
```

The transport layer knows nothing about JSF, and the parsers are pure
`(html: string) => T` functions, which makes them testable without a network.

## Consideration for the server

TRF5's PJe is a real court's public production service. The scraper uses
**concurrency 1** and a configurable delay between requests, and it aborts the run if
consecutive 429s pile up rather than pressing on.

No 429 was ever triggered during the research. Rate-limit handling is implemented
regardless — the brief requires it — and is demonstrated through **tests against a
simulated server**, not by hammering the live site.

## License

MIT
