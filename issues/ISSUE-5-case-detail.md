---
id: ISSUE-5
title: Case detail
status: done
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

**`src/domain/parse-detail.ts`** — pure `(html) => T` parsers for the detail
view: header fields, both parties tables, movements, documents (with every
identifier ISSUE-6 needs), the datascroller ids/base-ids/page counts, and
sealed-case detection. **`src/pje/detail.ts`** — `PjeDetail.fetch(ca)` GETs the
detail view through the existing `JsfSession`/`HttpClient`, then walks every
scroller with more than one page (active parties, passive parties, movements),
refreshing the ViewState from each response, and returns an assembled
`LegalCase`.

`src/domain/types.ts` gained `nomeArqProcDocBin` and `actionMethod` on
`CaseDocument` (ISSUE-6 needs both to build the download link), and two new
types: `DatascrollerInfo` and `DetailScrollers`.

### Traps in the markup

**A party row's other `<span>`s are not other parties.** Each participant sits
in its own table row, one span holding "Name - OAB ... - CPF/CNPJ: ... (ROLE)".
But that span has siblings: a `<ul>` of representation metadata containing
`<span title="Procuradoria">Procuradoria Geral Federal (PGF/AGU)</span>`. A
first attempt selected every class-less/`text-bold` span in the cell and read
that representation line as a second, bogus party. Fixed by taking only the
span that is the **first child** of the outer `.col-sm-12` div — the deeper
one lives inside a `<ul>`, several levels down.

**`nomeArqProcDocBin` is percent-encoded in latin-1, not UTF-8.** Every other
AJAX/GET field decides its encoding from the bytes (`PROBLEMS.md` §8), but this
one query-string parameter on document download links is the one exception
found so far: `Despacho+Inspe%E7%E3o` decodes correctly only as latin-1
(`%E7` = ç). Decoding it with the rest of the page's assumed UTF-8 corrupts
every accented file name. `decodeLatin1QueryValue()` handles it explicitly,
reading the raw query string instead of `URLSearchParams` (which assumes
UTF-8). Documented in `PROBLEMS.md` §6 as a new sub-finding.

**Two header cells share no `<label>`.** "Órgão Julgador Colegiado" (with
"Endereço" stacked below it) and "Órgão Julgador" alone both render with an
empty `<label>`; they are told apart by which sub-heading text they contain,
not by their label.

**A subject can have more than one rubric.** The "Assunto" cell can hold two
newline-separated lines (e.g. a case both about "Juros" and about "Valor da
Execução"); joined with `; ` since the domain field is a single string.

### Datascroller behavior, confirmed live

Paged a real two-page scroller (passive parties, case
`0803385-67.2025.4.05.0000`, 10 rows on page 1 + 2 on page 2 = 12 "resultados
encontrados"). The AJAX response only carries that page's rows (indices 10-11
here, not 0-11), confirming the merge in `PjeDetail` must accumulate across
pages rather than replace. A single-page table renders its scroller two
different ways depending on which table it is: parties always render a
hidden, page-link-less `<div class="rich-datascr">`, while a single-page
movements table renders **no scroller markup at all** — not even a hidden one.
Both are read as one page (`DatascrollerInfo | undefined`, `pageCount: 1`).

### Sealed cases: none found live

Sampled 17 real cases (10 from 2025-03-05, 7 from 2025-03-04) looking for a
case under segredo de justiça; none turned up — consistent with this being a
federal appellate jurisdiction where sealed cases are comparatively rare. Per
the issue's instruction, `test/fixtures/detail-sealed.html` is a hand-derived
fixture instead: the real detail markup's structure, with the "Dados do
Processo" heading and data panels replaced by the restriction notice
(`dl.rich-messages`) the same application uses elsewhere for rejected queries.
`isSealed()` is tested against it and against a real ordinary detail page (not
sealed).

One real, useful side-finding while probing for sealed cases: one candidate
(`0804011-36.2025.4.05.8100`) returned a **PostgreSQL error page**
(`cannot execute UPDATE in a read-only transaction`, in
`ProcessoDocumentoBinHome`) instead of the detail view — a genuine server bug
triggered by rendering the document panel, not a sealed case. `isSealed()`
also flags it as sealed, since it likewise lacks "Dados do Processo": both are
read as "detail unavailable, not an error" by design (see the issue's own
guidance), but it is worth knowing that signal covers two distinct causes.
Noted in `PROBLEMS.md` §6.

### Verification

`npm test`: **89 tests green** (57 existing + 32 new), no network.
`npm run typecheck`: clean.

Real case fully extracted (`0803385-67.2025.4.05.0000`, AGRAVO DE INSTRUMENTO):

| | Count | Pages walked |
|---|---|---|
| Active parties | 1 | 1 |
| Passive parties | 12 | **2** |
| Movements | 15 | 1 |
| Documents (downloadable) | 14 | 1 |

The passive-parties scroller is the one genuinely exercised across two live
pages; movements and documents were not observed to paginate in any of the
~20 live cases sampled while building this issue, so their multi-page path
runs through the same generic `collectAllPages()` mechanism proven against
parties, but was not itself demonstrated live with >1 page.
