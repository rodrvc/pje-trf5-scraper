---
id: ISSUE-3
title: Case search
status: todo
---

## Goal

Run the search POST and parse the results table.

Resolves problems 2 and 4 in `PROBLEMS.md`.

## Scope

- Build the POST with every field of the `fPP` form
- **Send `fPP:j_id244`**, not the visible `fPP:searchProcessos` button (the
  visible one does not trigger the query)
- Parse each row: CNJ number, judicial class, subject, parties, last movement
  and the `ca=` detail token
- Detect the cap warning ("somente os 30 primeiros") and surface it to the
  caller, which is what triggers the splitting in ISSUE-4
- Parse the `dl.rich-messages` panel and propagate server rejections (e.g.
  "É necessário informar ao menos dois nomes") instead of reporting "no results"

## Acceptance

- A known search returns the expected rows with correct accents.
- A broad range raises the cap flag; a narrow one does not.

## Resolution

_(pending)_
