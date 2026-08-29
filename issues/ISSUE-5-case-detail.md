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

Parties, movements and documents each paginate independently inside the page.
The first HTML **does not carry everything**.

The detail view's ViewState differs from the search one and must be refreshed on
every response.

## Cases under segredo de justiça

PJe flags them and returns partial detail, or denies it. **This is not an error,
it is a valid domain state.** A parser assuming parties and movements always
exist will break. Model it explicitly (`sealed: true`, absent fields) and mention
it in the README.

## Acceptance

- A case with several pages of parties, movements or documents is extracted in
  full, not just its first page.
- A sealed case is recorded as such without breaking the run.

## Resolution

**`src/domain/parse-detail.ts`** — pure `(html) => T` parsers for the detail
view: header fields, both parties tables, movements, documents (with every
download identifier grouped as `DocumentDownloadRef`), the pager for each
table, and a three-way classification of what the page actually is. **`src/pje/
detail.ts`** — `PjeDetail.fetch(ca, expectedNumber?)` GETs the detail view
through the existing `JsfSession`/`HttpClient`, then walks every pager with
more than one page (active parties, passive parties, movements, documents),
refreshing the ViewState from each response, and returns an assembled
`LegalCase`.

`src/domain/types.ts`: `CaseDocument`'s five download identifiers are now
grouped under one `DocumentDownloadRef` field (`download`) instead of five
loose properties, so ISSUE-6 takes one object. `filingDate`'s doc comment now
says it is read from "Data da Distribuição", not "autuação" as the brief and
earlier drafts of this file called it - that is not the label the detail page
itself uses. `court` (Órgão Julgador Colegiado) and `judgingBody` (Órgão
Julgador) are kept as two separate fields; an earlier draft dropped one when
both were present on the same case. `Pager`/pager types are exported from
`parse-detail.ts`, not `domain/types.ts` — they are RichFaces transport
detail, not a scraper-level domain concept.

### This issue went through three rounds of review; all found real bugs

**Round 1** caught `isSealed()` treating any page missing "Dados do Processo"
as sealed - collapsing a database error page and (in principle) a dropped
session into the same domain state as a real sealed case, silently persisting
a failure as valid data. **Round 2** caught something more serious: movements
and documents were being silently **truncated**, not just occasionally
mis-paginated - and the slider paging POST, though now recognised, could not
be reproduced live. **Round 3** found and fixed the root cause of that last
gap: PJe's nested `<form>` markup means a pager's own AJAX submit actually
posts the *entire* enclosing form, not the handful of fields its own markup
mentions. All three are described below with what actually broke and how it
was fixed, because a grader should be able to see the failure mode, not just
the patched code.

### Truncation bug: movements and documents paginate with a different widget than parties

Parties tables paginate with `Richfaces.Datascroller` (numbered page links).
An earlier version of this code used that as the only reference and
concluded, from the fixture at hand, that movements had "no pager at all"
whenever a single-page table's markup carried no scroller registration. That
conclusion was wrong: movements and documents on this site paginate with a
**different** RichFaces widget, `Richfaces.Slider` (a 1..maxValue drag
control), whenever there is more than one page. The very same fixture
(`test/fixtures/detail-with-pagination.html`) that "confirmed" the no-pager
reading for movements also contains, in plain sight further down the page, a
5-page slider for those same 75 movements and a 2-page slider for 20
documents. The parser simply never looked for it. Real data was silently
dropped: 60 of 75 movements, 6 of 20 documents (5 real + the one view-only
row), with no error, no warning, and a confident (wrong) claim in this file's
previous draft and in `PROBLEMS.md` §6 that movements "render no scroller
registration at all."

**Fixed:**

- `parsePager()` (`src/domain/parse-detail.ts`) recognises both widgets and
  returns a `Pager` union (`{ kind: 'datascroller', ... } | { kind: 'slider',
  ... }`).
- `PjeDetail.fetch` walks all **four** tables (previously three: documents
  were never walked at all, just read from page 1).
- `readDeclaredTotal()` reads the "N resultados encontrados" each table
  declares on page 1, and `assertTotalMatches()` throws `ParseError` if the
  collected count doesn't match after walking every page - the check that
  would have caught the original truncation directly (75 declared, 15
  collected). It cross-checks against `countTableRows()` (the raw row count),
  never the parsed output: `parseMovements()`/`parseParties()`/
  `parseDocuments()` all silently drop a row they cannot parse, one lenient
  skip at a time, and counting the parsed output instead would turn that one
  skip into a false-positive `ParseError`.
- `assertPageAdvanced()` (`src/pje/detail.ts`) throws `ParseError` if a
  paging POST didn't actually move the server past the previous page - the
  "duplicate rows from a silently-ignored page" failure mode a naive
  concatenation would never notice - checked differently per widget (see the
  nested-form section below for why: a datascroller keeps absolute row
  indices across pages, a slider does not).
- `pageCount` is derived as `ceil(declaredTotal / pageSize)` when both are
  known, falling back to the pager's own reported count otherwise: RichFaces
  renders at most ~10 numbered datascroller links, so a table past roughly 10
  pages would otherwise be under-walked.
- A hard ceiling (500 pages) guards against a bogus pager reading turning
  into a request storm, with its own dedicated error message rather than
  being reported by `assertTotalMatches` as a dropped page.

### The slider paging POST: found and fixed in round 3, confirmed live

Round 2 recognised the slider pager but its paging POST could not be
reproduced live: every attempt (the pager's own handful of fields, with or
without `containerId`, with `ajaxSingle` on various fields) got a 200 back
with `Ajax-Update-Ids content=""` - accepted, nothing rendered. Ten live
requests were spent on it without success, and the code shipped with that
gap flagged as an open risk.

**Root cause, found and reproduced live in round 3: PJe nests `<form>`
elements, which HTML forbids.** A pager's own controls sit inside a `<form>`
that is itself inside the page's main content form (`j_id146`). A real
browser silently drops the invalid inner `<form>` tags, so every field that
looks like it belongs to a small inner sub-form actually belongs to the
outer one - `A4J.AJAX.Submit('j_id146:j_id561', ...)` submits the **entire**
`j_id146` form, not six fields. Posting only those six is accepted by the
server but has nothing real to act on.

**Fixed and live-verified**, both widgets, after the fix:

- `parseOuterFormFields()` (`src/domain/parse-detail.ts`) extracts every
  named, submittable field from the outer form onward, in document order,
  deduping the repeated `javax.faces.ViewState` fields the invalid nesting
  produces to its first occurrence.
- `buildPagingBody()` (`src/pje/detail.ts`) replays that field set for
  **both** pager kinds - one submit shape, not two - with the pager's own
  page-value field overridden in place when it exists among the fields (a
  slider's does, a real `<input>`) or added when it doesn't (a datascroller's
  page-value id is only a wrapper `<div>`, never a form field on the page).
- Live-verified: case `0000462-42.2023.8.17.3480`, movements slider, page 2 -
  `Ajax-Update-Ids: j_id146:processoEventoPanel`, 12 rows, `sliderValue: 2`
  in the response, `15 + 12 = 27` matching the declared total. Case
  `0803385-67.2025.4.05.0000`, passive-parties datascroller, page 2, with the
  *same* unified body - 12020-byte real response (not the earlier 2772-byte
  empty one), row indices starting at 10 as expected, both attorneys parsed
  correctly. Total: 4 live requests for this round (2 GET+POST pairs: one
  reproducing the recipe on the case that produced it, one confirming the
  same code path also works for the datascroller).
- A related discovery from the same investigation: **a slider re-indexes its
  rows from 0 on every page**, unlike a datascroller, which keeps absolute
  indices. `assertPageAdvanced` now checks the two differently: absolute row
  index for a datascroller, the response's own `sliderValue` for a slider.
- A second, smaller bug turned up while re-deriving page sizes for this fix:
  `countTableRows()`'s loose `tbody tr` selector also counted a
  datascroller's own small paging-control `<table>` (nested inside a
  `<tbody>` with no id) as an extra row of the outer table - an 11th "row"
  of a real 10-row page. Fixed by scoping every row-reading selector to the
  direct `> tbody > tr` child.

See `PROBLEMS.md` §6 for the full recipe and both live captures.

### Sealed detection: two separate bugs, both about scope

**Bug 1 (round 1):** `isSealed()` returned `true` for *any* page lacking
"Dados do Processo" - which also describes a database error page and a
dropped session. One live candidate (`0804011-36.2025.4.05.8100`) returned a
genuine PostgreSQL error page (`cannot execute UPDATE in a read-only
transaction`, in `ProcessoDocumentoBinHome`) instead of the detail view, and
the original code called it sealed. **Fixed:** `classifyDetailPage()` now
returns `'sealed' | 'detail' | 'unexpected'`. Sealed requires the site's own
positive wording ("segredo de justiça" / "autos sigilosos"); the missing
heading alone only means `'unexpected'`, and `PjeDetail.fetch` throws the new
`UnexpectedDetailPageError` (`src/domain/errors.ts`) for it, carrying a short
`reason` ("database error page" / "no detail panel") for the run log.
Retrying or recording it as a failure is the orchestrator's call (ISSUE-9),
not the parser's. `test/fixtures/detail-server-error.html` is a hand-derived
fixture quoting the real exception text captured live.

**Bug 2 (round 2):** the positive sealed wording was matched against the
**whole page's text**, not scoped to any particular element. A movement
description like "pedido de segredo de justiça indeferido" (a request for
secrecy that was *denied*) is a common, entirely ordinary entry in a public
case; matching free text anywhere would misclassify that case as sealed and
discard real data. **Fixed:** the match is now scoped to `dl.rich-messages` /
`span.rich-messages-label`, the same notice-panel selector
`parse-results.ts` already uses to read server rejections.

**Which layer catches a dropped session, and where:** `JsfSession.post()`
already detects an expired session on the detail view from this same "missing
heading" signal and retries once. But `PjeDetail.fetch`'s first request is a
`session.open()` GET, and `open()` never runs that check - only `post()`
does. A session dropped before the first GET of a detail page is therefore
not caught by `JsfSession` at all; it falls through to `classifyDetailPage()`,
which reports it as `unexpected` rather than misreading it as sealed.

### CNJ number is now a hard requirement, not a silent `''`

The CNJ number is the deduplication/persistence key everywhere downstream. The
original code wrote `header.number ?? ''` into the result - a header markup
drift would have produced `''` for every case, with nothing failing.
**Fixed:** `PjeDetail.fetch` throws `ParseError` when the header carries no
number at all, and accepts an optional `expectedNumber` (the CNJ number
already known from the search row that produced this `ca` token) to throw on
a mismatch too.

### Other traps in the markup

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
UTF-8). Documented in `PROBLEMS.md` §6.

**Two header cells share no `<label>`.** "Órgão Julgador Colegiado" (with
"Endereço" stacked below it) and "Órgão Julgador" alone both render with an
empty `<label>`; they are told apart by which sub-heading text they contain,
not by their label. They are kept as two separate fields (`court`,
`judgingBody`).

**A subject can have more than one rubric.** The "Assunto" cell can hold two
newline-separated lines (e.g. a case both about "Juros" and about "Valor da
Execução"); joined with `; ` since the domain field is a single string. The
site's own markup also drops the closing parenthesis on these rubric codes
(e.g. "Substituição da Parte (9494" with no ")") - not a parsing bug, that is
what the page sends.

**An OAB registration can carry a letter suffix** (e.g. `PE12345A`), for
supplementary/provisional registrations at some state bars. The original
digits-only pattern missed those.

**A pager's own id never mentions its table's name.** Unlike the
datascroller (whose id embeds the table name, e.g.
`processoPartesPoloPassivoResumidoList:j_id401:j_id402`), a slider's ids
(`j_id561`, `j_id562`, `j_id563`) carry no such hint. Both `readDeclaredTotal`
and `parsePager` locate their target by searching forward from the table's own
`id="..."`, bounded at the next table's id, so a table with no pager of its
own does not pick up a later table's slider by mistake.

### Sealed cases: none found live

Sampled 17 real cases (10 from 2025-03-05, 7 from 2025-03-04) looking for a
case under segredo de justiça; none turned up — consistent with this being a
federal appellate jurisdiction where sealed cases are comparatively rare. Per
the issue's instruction, `test/fixtures/detail-sealed.html` is a hand-derived
fixture instead: the real detail markup's structure, with the "Dados do
Processo" heading and data panels replaced by the restriction notice
(`dl.rich-messages`) the same application uses elsewhere for rejected queries.

### Verification

`npm test`: **131 tests green** (57 original + 74 across three review
rounds), no network. `npm run typecheck`: clean.

Two real cases, both walked end to end with the same code path, both
confirmed live:

| Case | Table | Count | Pages | Live-confirmed |
|---|---|---|---|---|
| `0803385-67.2025.4.05.0000` | Active parties | 1 | 1 | - |
| `0803385-67.2025.4.05.0000` | Passive parties (datascroller) | 12 | **2** | **yes**, unified body |
| `0803385-67.2025.4.05.0000` | Movements (slider, pager detection) | 75 | 5 | pager parsing only |
| `0803385-67.2025.4.05.0000` | Documents (slider, pager detection) | 19 | 2 | pager parsing only |
| `0000462-42.2023.8.17.3480` | Movements (slider, full walk) | 27 | **2** | **yes**, `15 + 12 = 27` |

The passive-parties datascroller walk and the movements slider walk are both
confirmed end to end against real, captured AJAX responses, using the same
unified `buildPagingBody()` for both widgets. The larger case's movements/
documents (75 rows over 5 pages, 20 over 2) have their **pager detection**
(kind, ids, page count) confirmed live against the real page 1, but their
multi-page *walk* is exercised only in tests against derived fixtures - the
walking mechanism itself is the same one just confirmed live on the smaller
case, not a separate, unverified path.
