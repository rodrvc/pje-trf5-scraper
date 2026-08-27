---
id: ISSUE-5
title: Case detail
status: todo
---

## Goal

Extract all information for each case, which is requirement 1 of the brief.

Resolves problem 6 in `PROBLEMS.md`, already investigated.

## Scope

- GET the detail view using each row's `ca=` token
- Parse: number, filing date, judicial class, subject, jurisdiction, court,
  address, reference case
- Active and passive parties, with CPF/CNPJ, OAB and status
- Movements (date and description)
- Attached document list, with the data needed to download them (ISSUE-6)

## Sub-problem: internal pagination

Parties and movements are paginated inside the page by `Richfaces.Datascroller`.
The first HTML **does not carry everything**. Paging is another POST:

    AJAXREQUEST=_viewRoot
    <baseId>=<baseId>
    javax.faces.ViewState=<current>
    <scrollerId>=<n>
    ajaxSingle=<scrollerId>
    AJAX:EVENTS_COUNT=1

The detail view's ViewState differs from the search one and must be refreshed on
every response.

## Cases under segredo de justiça

PJe flags them and returns partial detail, or denies it. **This is not an error,
it is a valid domain state.** A parser assuming parties and movements always
exist will break. Model it explicitly (`sealed: true`, absent fields) and mention
it in the README.

## Acceptance

- A case with several pages of parties and movements is extracted in full, not
  just its first page.
- A sealed case is recorded as such without breaking the run.

## Resolution

_(pending)_
