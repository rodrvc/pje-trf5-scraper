---
id: ISSUE-9
title: Sweep orchestrator
status: todo
---

## Goal

Coordinate the full flow: sweep → detail → PDFs → persistence.

Without this piece the business logic ends up living in `main()`, the classic
anti-pattern in scrapers. The CLI should be a flag parser that instantiates and
starts the orchestrator, nothing more.

## Scope

- State machine for the walk
- **Explicit failure policy**: does a broken detail abort the run or just get
  recorded? (the brief asks to continue and record)
- Injection point for persistence (ISSUE-7)
- Expired-session handling as a cross-cutting concern (ISSUE-2)

## Acceptance

- The CLI contains no business logic.
- An isolated failure does not bring down the whole run.

## Resolution

_(pending)_
