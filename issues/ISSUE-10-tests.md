---
id: ISSUE-10
title: Test suite with fixtures
status: done
---

## Goal

"Handling 429 errors" is an explicit grading criterion, and the decision was
**not to demonstrate it against the live server** of a real court. The tests are
therefore the evidence, not an afterthought.

## Scope

- Retry/backoff tests with a mock HTTP server (`nock`): 429 with and without
  `Retry-After`, 503, network errors, attempt exhaustion
- Parser tests as **pure functions** `(html: string) => T`, with no network
- **Real HTML fixtures** in `test/fixtures/`, captured from the site:
  - capped results (30 + warning)
  - uncapped results
  - server rejection panel
  - detail view with internal pagination
  - an HTML response where a PDF was expected (dropped session)
  - a case under segredo de justiça, if one can be found

The fixtures pay off twice: they test the parsers without a network and they
document the site.

## Acceptance

- `npm test` passes with no internet connection.
- Behaviour under 429 is demonstrated reproducibly.

## Resolution

243 tests across 24 files, all offline: network only ever goes through `nock`
intercepts, and `pjett.trf5.jus.br` appears only inside `test/fixtures/`, never
as a live target. 429 handling is covered with and without `Retry-After`,
retry exhaustion, and the circuit breaker tripping and resetting
(`test/client.test.ts`, `test/download.test.ts`, `test/backoff.test.ts`).
Parsers are tested as pure `(html) => T` functions, no network involved.

Fixtures: `results-capped.html`, `results-uncapped.html`,
`rejection-response.html`, `class-catalog.html`, `detail-with-pagination.html`,
`detail-slider-page1.html`, `detail-slider-page2-ajax.html` and
`detail-page2-ajax.html` are real captures from the live site.
`detail-sealed.html` and `detail-server-error.html` are hand-derived: no
sealed case turned up among 17 live cases sampled looking for one, while the
server-error fixture reproduces a genuine captured exception page.

The ISSUE-5 prune (74 → 46 detail tests) held: a final pass over the suite
found nothing tautological left to remove, so it was left as is.

`npm test`: 243/243 green, no internet connection required. `npm run
typecheck`: clean.
