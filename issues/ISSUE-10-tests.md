---
id: ISSUE-10
title: Test suite with fixtures
status: todo
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

_(pending)_
