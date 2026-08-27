---
id: ISSUE-1
title: Project setup
status: done
---

## Goal

Get the project ready for writing TypeScript.

## Scope

- `package.json` with dependencies and run scripts
- `tsconfig.json`
- `.gitignore`: `node_modules/`, `dist/`, `data/`, `pdfs/`, `*.log`
- `src/` folder structure

Planned dependencies: `axios`, `cheerio`, `iconv-lite`, `tough-cookie`,
`axios-cookiejar-support`. Dev: `typescript`, `@types/node`, `tsx`.

**Brief constraint:** Puppeteer, Playwright and Selenium are not allowed.

## Acceptance

- `npm install` runs and the project compiles.
- Scraped data is not versioned.

## Resolution

Project set up and verified: `npm install` runs clean (0 vulnerabilities),
`npm run typecheck` passes and `npm test` runs 4 tests green.

**Layered structure**, with dependencies flowing one way:

    src/http/      transport only (knows nothing about JSF)
    src/pje/       JSF protocol: session, ViewState, POSTs
    src/domain/    types and pure parsers
    src/pipeline/  orchestration
    src/cli/       flag parsing

**Already written:**

- `src/domain/types.ts` — `LegalCase`, `Party`, `Movement`, `CaseDocument`,
  `Query`, `SearchResponse`, `JudicialClass`. Includes `sealed` for segredo de
  justiça and `capped` for the 30-result cap.
- `src/domain/errors.ts` — typed errors (`RateLimitError`,
  `SessionExpiredError`, `RejectedQueryError`, `ParseError`, `DownloadError`,
  `CircuitBreakerError`), so retry policy can key off the class instead of
  inspecting message text.
- `test/errors.test.ts` — keeps the suite live from the first commit.

**Decisions:**

- Strict TypeScript with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`: when parsing unpredictable HTML, the compiler
  should force absent fields to be handled.
- Native ESM (`"type": "module"`), Node >= 20.
- `tsx` to run without a build step; `vitest` + `nock` for tests.
- Domain names stay in Portuguese where they are terms specific to the Brazilian
  court system (autuação, polo ativo, movimentação).

**Dependencies:** axios, axios-cookiejar-support, cheerio, iconv-lite,
tough-cookie. None browser-based, as the brief requires.
