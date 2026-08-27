---
id: ISSUE-8
title: CLI, logging and README
status: todo
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

_(pending)_
