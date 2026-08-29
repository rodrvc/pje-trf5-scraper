---
id: ISSUE-8
title: CLI, logging and README
status: done
---

## Goal

Make the project deliverable. Covers the documentation and code-quality grading
criteria.

## Scope

- CLI options: date range, case limit, request delay, `--retry-failed`
- Progress logging: current window, cases found, PDFs downloaded, 429 retries
  (the brief suggests this)
- `README.md` with:
  - step-by-step install and run instructions
  - an explanation of how coverage was solved given that **the site has no
    pagination** and caps at 30 (this is what demonstrates understanding the site)
  - a note that the scraper is plain HTTP, with no browser automation
- A real sample run leaving data and a few PDFs as evidence

## Pending decision

Publishing the public GitHub repo: whether the user creates it or it is published
with `gh`. By default nothing is published without their go-ahead.

## Acceptance

- Someone cloning the repo can run it following the README alone.

## Resolution

Landed in two PRs. PR #18 (`src/cli/`) added the actual CLI: `args.ts` (flag
parsing, defaults, `usage()`), `logger.ts` (pure event-to-line formatting plus
`ConsoleLogger`) and `index.ts` (wires flags to a `Scraper`, prints the
progress lines and the summary block — no business logic in `main()`, per
ISSUE-9's own framing). This PR wrote `README.md` against that CLI: install,
quick start with real output, the flags table, resuming/retrying, the 429
section, and pointers into `PROBLEMS.md`/`ISSUE-7` instead of duplicating
them.

Live check run with the merged CLI (`2025-03-05..2025-03-05`,
`--max-requests=25 --max-cases=1`): 1 window, 10 listed, 1 detailed, 3 PDFs,
9 requests, 0 429s, stopped by `maxCases`.

The "Pending decision" above is resolved: the repository is public at
https://github.com/rodrvc/pje-trf5-scraper.
