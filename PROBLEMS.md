# Problems to solve

Challenge: scrape the TRF5 PJe public case search in TypeScript, without browser
automation (plain HTTP + parsing only).

Site: https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam

A list of the obstacles found while exploring the site. They are worked through one
at a time; each resolution is written under its problem as the investigation lands.

---

## 1. Search is not a URL, it is a stateful POST

The site is built on JSF/Seam with RichFaces. There are no search URLs and no API:
everything goes through a POST carrying a `javax.faces.ViewState` token tied to the
session cookie. Without a valid pair the server answers 200 with valid HTML but
**no results**, and no error message of any kind.

**Status:** resolved during initial exploration — implemented in ISSUE-2.

---

## 2. The visible "Pesquisar" button does not run the search

The form's button is called `fPP:searchProcessos`. Submitting it does nothing: the
response only refreshes the message panel, with no table. The component that
actually runs the query is a different one (`fPP:j_id244`), invoked from the page's
JavaScript.

**Status:** resolved during initial exploration — implemented in ISSUE-3.

---

## 3. The form carries a reCAPTCHA

The page loads Google's reCAPTCHA script and the search button invokes it. An active
captcha would make the challenge unworkable without a browser.

**Status:** ruled out as a risk — it is disabled server-side (`if (false)`).

---

## 4. The server rejects queries without saying so clearly

Searching by party name with a single term returns zero results. The reason arrives
in a separate message panel rather than as an HTTP error: at least two names are
required. Without parsing that panel, the scraper would report "no results" when the
query was in fact rejected.

**Status:** resolved — implemented in ISSUE-3.

---

## 5. The site caps at 30 results and has no pagination

**The most consequential design problem of the challenge.**

The brief asks to walk through every page, but there are no result pages. Faced with
a broad query the site answers *"somente os 30 primeiros serão exibidos"* and offers
no way to ask for the next batch: no `?page=N`, no pagination control.

Verified live: a broad search returns 30 rows with the warning; a narrow one returns
the real total with no warning.

**Resolution:** the "Data de Autuação" filter serves this purpose. It works on its
own, without combining it with other fields, and confirms the expected behaviour:

| Range queried | Rows | Capped? |
|---|---|---|
| 2025-01-01 – 2025-12-31 | 30 | yes |
| 2025-03-01 – 2025-03-07 | 30 | yes |
| 2025-03-05 (single day) | 10 | no |
| 2025-03-08 (single day) | 18 | no |

Narrowing the range stops the truncation and returns the real total. So the sweep is:
walk the history in date windows and, when a window hits 30, split it in two and
retry each half until none saturates.

Implementation note: the date query is the same POST as problem 1, filling
`dataAutuacaoInicioInputDate` and `dataAutuacaoFimInputDate` in `dd/MM/yyyy` format.

### Correction: a single day does NOT always fit under 30

The first version of this resolution assumed one day always stays below the cap.
**That is false.** Probing March 2025 day by day:

| Day | Rows | Capped? |
|---|---|---|
| 2025-03-03 | 4 | no |
| 2025-03-04 | 7 | no |
| 2025-03-05 | 10 | no |
| 2025-03-06 | 16 | no |
| 2025-03-07 | 25 | no |
| 2025-03-10 | 23 | no |
| 2025-03-11 | **30** | **yes** |
| 2025-03-12 | **30** | **yes** |
| 2025-03-13 | **30** | **yes** |
| 2025-03-14 | **30** | **yes** |
| 2025-03-17 | 22 | no |
| 2025-03-18 | **30** | **yes** |
| 2025-03-19 | **30** | **yes** |

6 of 13 days saturate. With the date axis alone, cases would be lost on half the days.

**Solution: a second partition dimension, the judicial class.**

The "Classe judicial" field is a `RichFaces.Suggestion`. Free text does not filter:
the **internal id** must be sent in `fPP:j_id189:sgbClasseJudicial_selection`. The
full catalog (132 classes with their ids) comes from a POST to the autocomplete
itself, which returns every entry.

Verified: 2025-03-11 saturates at 30, but filtering by class 202 (Agravo de
Instrumento) returns **19 rows, uncapped**.

So splitting cascades: first halve the date range; when a single day still saturates,
split that day by judicial class.

### Cap detection

Across 14 probes, `rows == 30` always came with the warning, and `< 30` never did.
The defensive condition **`rows >= 30 || warning present`** is used regardless:
warning present means truncated for certain; exactly 30 rows with no warning means
possibly complete (see "The warning means more-than-30, not exactly-30" below) but
is still treated as capped, a cheap false positive traded against the alternative
of losing cases silently if the warning ever failed to appear on a real cap.

### Approaches ruled out

The "Processo" and "Processo referência" fields **do not accept partial matches**.
A partial value returns **zero rows**: the filter is applied, it simply requires the
full number. Probed on 2025-03-12 + class 202 (30 rows unfiltered):

| Field | Value | Rows |
|---|---|---|
| Processo | `0803` | 0 |
| Processo | `08001` | 0 |
| Processo | `8100` | 0 |
| Processo referência | `0803` | 0 |
| Processo referência | `%` | 0 |

The "Livre" radio next to "Processo referência" does not change this: it only unmasks
the input client-side (`mascaraDocumento(..., 'LIV')`), the server still demands an
exact number. So neither field can partition.

### The result ordering, and why it matters

The results come back **ordered by CNJ number ascending**, strictly monotonic across
all 30 rows. The row ids in the markup (`fPP:processosTable:36263:j_id255`) are
**entity keys, not indices** — they are neither sequential nor ascending — so there is
no offset to manipulate.

That means the query is effectively `ORDER BY <case number> ASC LIMIT 30`: the 30 rows
shown are always the lexicographically smallest, and everything truncated sits *above*
the last row displayed. Useful because the last row tells you exactly where the cut
fell.

### The third dimension: party name is a substring filter

**The saturating leaf (one day + one class) is not the bottom of the tree.** The
"Nome da parte" field is not an exact-name lookup: it is a
`LIKE %token% AND LIKE %token%` substring match, order-independent and matching
mid-word. The only guard is the "at least two names" validation, which merely counts
whitespace-separated tokens — **and the tokens may be a single character each**.

Verified on 2025-03-12 + class 202:

| Party filter | Rows | Capped? | Last row |
|---|---|---|---|
| _(none)_ | 30 | yes | `0803807-42.2025.4.05.0000` |
| `DA S` | 12 | no | `0804720-53.2025.4.05.8300` |
| `DE A` | 30 | yes | `0803845-54.2025.4.05.0000` |
| `A A` | 30 | yes | `0803818-71.2025.4.05.0000` |
| `E S` | 30 | yes | `0803825-63.2025.4.05.0000` |
| `ILV OS` | 1 | no | matches a "…sILVa…santOS…" party |
| `XX YY` | 0 | no | — |

Several of those last rows are **beyond** the unfiltered cap of `0803807-42`, which is
the point: the filter reaches cases the unfiltered query cannot show.

Unioning nine crude party filters over a saturating leaf and deduplicating by CNJ:

| Leaf | Unfiltered | Union of 9 filters |
|---|---|---|
| 2025-03-12 + class 202 | 30 | **42** |
| 2025-03-11 + class 202 | 30 | **41** |
| 2025-03-14 + class 202 | 30 | **37** |
| 2025-03-19 + class 202 | 30 | **33** |

So the corpus **is** reachable past the cap. The yield varies (33 to 42 from the same
nine filters), which is why termination must be driven by the union ceasing to grow
rather than by a fixed number of probes. Note this axis is a **cover, not a
partition**: the subsets overlap, so termination comes from the union ceasing to grow,
not from disjointness. Deduplication by CNJ (already required) absorbs the overlap.

### Correction: the judicial-class filter needs both the id AND the display name

While re-measuring for ISSUE-4b, a raw curl probe sending only
`fPP:j_id189:sgbClasseJudicial_selection=202` (the internal class id) with
`fPP:j_id189:classeJudicial` left **empty** returned the day's bare (unfiltered)
result set instead of a class-202 one — i.e. the class filter was **silently
ignored** when the id is sent without the display name. Every "day + class
202" figure this section originally recorded from that probe was actually a
day-only figure; the mistake reproduced identically three times before its
cause was found.

Re-probed sending **both** fields together
(`sgbClasseJudicial_selection=202` and `classeJudicial=AGRAVO DE INSTRUMENTO`,
exactly what `PjeSearch.buildFormBody` already sends — see `src/pje/search.ts`,
which was never affected by this bug, since it always sets both fields):

| Query | Rows | Capped? | Warning text? | Last row |
|---|---|---|---|---|
| 2025-03-12, no class | 30 | yes | **yes** | `0803807-42.2025.4.05.0000` |
| 2025-03-12 + class 202 | 30 | yes | **no** | `0803864-60.2025.4.05.0000` |
| 2025-03-11 + class 202 | 19 | no | — | — |

The class filter is doing real work here: of the 30 rows returned for
2025-03-12 + class 202, 12 do not appear at all in the 30 rows returned for
2025-03-12 with no class filter — two genuinely different result sets, not a
silently-dropped filter producing the same output twice. This is why
`JudicialClassSplit` (`src/pipeline/partition.ts`) always sends both the id
and the display name from the catalog entry: sending the id alone, which
reads as "more specific," actually degrades silently into an unfiltered day
query, which would make the sweep think a day was covered by class splits
when the class dimension was never applied at all.

**The third-dimension evidence above (2025-03-12 + class 202, the `DA
S`/`DE A`/etc. table and the nine-filter union of 42) was measured correctly**
and is unaffected by this bug — `PjeSearch.buildFormBody` sends both class
fields, and only a hand-rolled curl probe missing the name field ever showed
the wrong numbers. Re-confirmed live during ISSUE-4b (see its Resolution for
the full digraph/trigram measurement built on this same leaf, reaching 46
unique cases past the 30-row cap).

### The warning means more-than-30, not exactly-30

An earlier probe pass claimed the truncation warning is never absent from a
30-row response: re-probing six leaves (2025-03-11, 12, 13, 14, 18, 19, all
day-level, no class filter) always returned 30 rows **with** the warning
present. That held because every one of those probes was day-level, and a
day always has well over 30 cases behind it — those leaves were never at
exactly 30.

With the class filter actually applied, a different case shows up:
2025-03-12 + class 202 hits exactly 30 rows **without** the warning, confirmed
independently across multiple live probes (both raw curl and `PjeSearch`,
see the class-filter correction above for the full table). The two
observations are not in tension once read together: the warning text fires
only when *more than* 30 rows would otherwise be returned, not whenever the
30-row limit is hit. A leaf whose true total is exactly 30 saturates the
display limit without ever crossing into "too many to show" territory
server-side, so no warning appears — it is not "saturated" in the sense the
rest of this section uses the word (there is nothing beyond the 30 shown),
just exactly at the boundary.

This means `rows >= 30 || warning present` has two distinct readings:
warning present ⇒ truncated for sure, more cases exist beyond the 30 shown;
30 rows with no warning ⇒ possibly complete, but still treated as capped by
the rule. That is a cheap false positive: a leaf like this gets handed to
`JudicialClassSplit`/`PartyTokenSweep` for nothing, costing a few wasted
requests (the party-token cover plateaus almost immediately, `unionSize`
barely moving past the seed), but it never drops a case. The rule stays
exactly as specified — undercounting a real cap would be the opposite, and
much worse, mistake.

---

## 6. The case detail paginates internally

The detail view opens with a GET using a `ca=` token carried by each result row. It
returns case data, parties with CPF/CNPJ/OAB, movements and attached documents.

But all four of those tables (active parties, passive parties, movements,
documents) can each be paginated **within** the page (75 movements and 20
documents in one test case, both split across several pages). The first HTML
does not carry everything; those paginators must be walked.

**Correction: two different RichFaces widgets do the paging, not one.**

An earlier pass of this work read only the parties tables as the reference and
concluded movements had "no pager at all" when a case's movements fit on one
page — true for the parties tables' `Richfaces.Datascroller`, but movements
and documents on this site paginate with a **different** component,
`Richfaces.Slider` (a 1..maxValue drag control), whenever there is more than
one page. A single fixture (`test/fixtures/detail-with-pagination.html`) shows
both side by side: 12 passive parties across 2 datascroller pages, 75
movements across 5 slider pages, 20 documents across 2 more. The first
implementation only recognised the datascroller, which silently truncated
movements and documents down to whatever fit on page 1 — a real data-loss bug,
not a documented behaviour, caught in review.

### Both pagers really submit the whole outer form, not their own small one — solved

The slider's registration looks like:

    new Richfaces.Slider("j_id146:j_id561:j_id562",
      {'minValue':'1','maxValue':'5', ...,
       'onchange':'A4J.AJAX.Submit(\'j_id146:j_id561\', event,
         {..., parameters:{\'j_id146:j_id561:j_id563\':\'j_id146:j_id561:j_id563\'} ...})' })

`j_id562` (the slider's own id) is a real, named `<input>` field whose value is
the current page; `j_id563` is a separate, self-referential id the `onchange`
event names. A first attempt built the paging POST from exactly these pieces
plus the datascroller's own analogous small set (`AJAXREQUEST=_viewRoot`, the
form/base id, `<pageId>=<page>`, `ajaxSingle=<pageId>` or the slider's event
field, `AJAX:EVENTS_COUNT=1`). Both got a 200 every time but with
`Ajax-Update-Ids content=""`: accepted, nothing rendered. Ten live requests
were spent on the slider case alone without success.

**Root cause, found and reproduced live: PJe nests `<form>` elements, which
HTML forbids.** Each pager's own controls sit inside a `<form>` (e.g.
`j_id146:j_id561`) that is itself inside the page's main content form
(`j_id146`). A real browser parsing this markup silently drops the *inner*
`<form>` open/close tags — nested forms are invalid HTML and get corrected the
same way a stray unclosed tag would — so every field that looks like it
belongs to the small inner "form" actually belongs to the outer one. When
`A4J.AJAX.Submit('j_id146:j_id561', ...)` fires, it does not serialise some
six-field sub-form; it serialises the **entire** `j_id146` form, all ~75
fields of it (13 tables' worth of scroller/slider/sort-header hidden state).
Posting only the inner six is a well-formed, plausible-looking request the
server nonetheless has nothing to act on — which is exactly the silent,
misleading failure mode `Ajax-Update-Ids content=""` describes.

**Working recipe, live-verified** (case `0000462-42.2023.8.17.3480`, 27
movements over 2 slider pages: 15 + 12 = 27):

- Collect every named, submittable `<input>` (skip `submit`/`button`/
  `image`/`checkbox`/`radio`) from `<form id="j_id146"` to the end of the
  document, in order; `javax.faces.ViewState` sent once, not once per
  visually-nested form.
- Override the slider's own value field (`j_id146:j_id561:j_id562`) with the
  target page number, in place.
- Prepend `AJAXREQUEST=_viewRoot`; append the slider's distinct event field
  (`j_id146:j_id561:j_id563=j_id146:j_id561:j_id563`) and
  `AJAX:EVENTS_COUNT=1`.
- Result: 200, `Ajax-Update-Ids: j_id146:processoEventoPanel`, 12 rows,
  `'sliderValue':'2'` in the response.

The same recipe, re-verified live against the datascroller (case
`0803385-67.2025.4.05.0000`, passive parties, page 2): identical, **except**
the datascroller's own page-value id (`...j_id401:j_id402`) is not a real
`<input>` anywhere on the page — only a wrapper `<div>` — so it must be
**added**, not overridden in place, alongside `ajaxSingle` set to that same
id. One submit shape now covers both widgets
(`buildPagingBody()`/`parseOuterFormFields()` in `src/pje/detail.ts` /
`src/domain/parse-detail.ts`): result `Ajax-Update-Ids` non-empty, 12 real
rows, row indices starting at 10 as expected for a datascroller page 2.

**A second finding from this same investigation: a slider re-indexes its rows
from 0 on every page.** A datascroller keeps a table's rows numbered by their
*absolute* position (page 2 of a 12-row passive-parties table starts at index
10). A slider's page 2 response instead restarts at index 0
(`processoEvento:0:` .. `processoEvento:11:` for a 12-row second page) - live
capture confirms this. `assertPageAdvanced` (`src/pje/detail.ts`) therefore
checks the two widgets differently: absolute row index for a datascroller,
the response's own `'sliderValue':'N'` for a slider.

Neither the "N resultados encontrados" total the page declares for each
table, nor the requirement that a page actually moved (both enforced now, see
below), were caught by an earlier version of this code — a data-loss bug like
the original truncation would have passed silently.

The pager ids (one per table: active parties, passive parties, movements,
documents) are read from the detail markup, and the page count is derived
from the table's own declared total divided by its page size when both are
known (RichFaces renders at most ~10 numbered datascroller links, so beyond
roughly 10 pages the pager's own count under-counts), falling back to
`maxValue` (slider) or the paginator's own numbered links (datascroller,
`«« « 1 2 3 ... » »»`) otherwise.

Note: the detail page's ViewState differs from the search one and must be refreshed
with every response.

### The `ca=` token does not expire with the session

Checked in three scenarios with the same token: the session that produced it, a fresh
clean session, and **sending no cookie at all**. All three return 200 with the same
case detail.

So `ca=` is a stable case identifier, not a conversation token like the PDF `cid`
(problem 7). **It can be persisted for resuming**: picking up a run does not require
re-running the search to reach an already-listed case.

**Status:** implemented and live-verified in ISSUE-5 (`src/pje/detail.ts`,
`src/domain/parse-detail.ts`) — both the datascroller and the slider paging
POST, using the unified outer-form submit body above.

### A single-page table's pager markup is not always the same shape

Confirmed while implementing ISSUE-5: parties tables always render a
`<div class="rich-datascr">` for their scroller, hidden and with no page links
when there is only one page. Movements and documents, in every single-page
case sampled, rendered **no pager registration at all** — not even a hidden
one. Both must be read as "one page, nothing to walk", but the second case has
no pager id to name at all, unlike the first.

### A nested sub-table can silently miscount a row-counting selector too

While cross-checking the fixes above, a related bug turned up:
`countTableRows()` used a loose `tbody tr` descendant selector, which also
picked up the datascroller's own small paging-control `<table>` — nested
inside a `<tbody>` with no id, itself inside the outer table — as an extra
row of the outer table. A 10-row passive-parties page 1 counted as 11,
shrinking the inferred page size and making every subsequent page's expected
row index wrong. Fixed by scoping to the direct `> tbody > tr` child
everywhere a table's own rows are read (`parseParties`, `parseMovements`,
`parseDocuments`, `countTableRows`).

### Every table's declared total and every paging response are now cross-checked

Two defensive checks added after the truncation bug above, both in
`src/domain/parse-detail.ts` / `src/pje/detail.ts`:

- The page itself declares a total ("N resultados encontrados") for each
  table; after walking every page, the collected row count must equal it
  (`assertTotalMatches`), or `ParseError` is thrown. This is what would have
  caught the original truncation directly (75 declared, 15 collected). Row
  counting for this check always uses the raw row count
  (`countTableRows()`), not the parsed-output count: a parser that silently
  skips one unparsable row (as all four do, by design) would otherwise turn
  that one lenient skip into a false-positive `ParseError` against the
  declared total.
- A paging POST that is silently ignored by the server (stale ViewState, a
  wrong field id after a redeploy) can return the previous page again with a
  200 and no error of its own. `assertPageAdvanced` (`src/pje/detail.ts`)
  catches this, checked differently per widget since they behave differently
  under paging: a datascroller's absolute row index (page 2 of a 12-row
  passive-parties table starts at index 10, not 0) against a datascroller
  page, the response's own `sliderValue` against a slider page (see above -
  a slider's rows are re-indexed from 0 on every page, so the absolute-index
  check does not apply to it). Either way, `ParseError` is thrown rather than
  silently duplicating rows.

A hard ceiling (500 pages) also guards against a bogus pager read turning into
a request storm, with its own dedicated error rather than being reported as a
dropped page by `assertTotalMatches`.

### `nomeArqProcDocBin` is percent-encoded in latin-1, not UTF-8

Found while parsing document download links for ISSUE-5. The rest of the site
decides UTF-8 vs. latin-1 from the bytes per request (problem 8), but this one
query-string parameter is an exception within an otherwise-UTF-8 AJAX/GET
response: `Despacho+Inspe%E7%E3o+-+1141+-+INSPE%C7%C3O` only decodes correctly
as latin-1 (`%E7` = ç, `%C7` = Ç). Decoding it as UTF-8 (what `URLSearchParams`
does) silently corrupts every accented file name. Handled explicitly in
`decodeLatin1QueryValue()`, reading the raw query string instead of relying on
`URLSearchParams` for that one field.

### A server error looks exactly like a sealed case unless told apart on purpose

While sampling live cases for a segredo de justiça example (17 candidates,
none sealed), one (`0804011-36.2025.4.05.8100`) returned a genuine
PostgreSQL error page — `cannot execute UPDATE in a read-only transaction`,
raised from `ProcessoDocumentoBinHome` while rendering the document panel —
instead of the detail view. It is a real server bug, not a sealed case, and
the first version of this code read both the same way, since both lack the
"Dados do Processo" heading. That silently turned a failure into what looked
like valid, sealed-case data — never retried, never logged as broken.

**Fixed:** `classifyDetailPage()` (`src/domain/parse-detail.ts`) is now
three-way, not a boolean. Sealed requires the site's own positive wording
("segredo de justiça" / "autos sigilosos") — the missing heading alone is not
enough. Anything else missing the heading (a database error page, a changed
layout) is classified `unexpected` with a short reason, and `PjeDetail.fetch`
throws `UnexpectedDetailPageError` for it instead of returning a fabricated
`sealed: true`. The orchestrator (ISSUE-9) decides whether to retry or record
it as a failure; that decision does not belong in the parser.

A second, separate bug in the same function: the sealed wording was originally
matched against the **whole page's text**, not just the notice panel. A
movement description like "pedido de segredo de justiça indeferido" (a request
for secrecy that was *denied*) is a common, entirely ordinary entry in a
public case; matching free text anywhere would have misread that case as
sealed and discarded real data. Fixed by scoping the match to
`dl.rich-messages` / `span.rich-messages-label`, the same notice block
`parse-results.ts` already reads server rejections from.

**Which layer catches a dropped session, and where:** `JsfSession.post()`
already detects an expired session on the detail view using this same
"missing heading" signal (`looksLikeExpiredSession`, `src/pje/session.ts`) and
retries once by re-establishing the session before giving up. But
`PjeDetail.fetch`'s very first request is a `session.open()` **GET**, and
`open()` never runs that check — only `post()` does. So a session dropped
before the first GET of a detail page is not caught by `JsfSession` at all; it
falls through to `classifyDetailPage()`, which (correctly, now) reports it as
`unexpected` rather than misreading it as sealed. The distinction matters for
ISSUE-9: this specific failure mode needs a fresh session and a retried
`fetch()`, not a "give up, it's sealed" outcome.

---

## 7. PDFs are served through single-use links

A document link does not point at a `.pdf`. It is a GET that redirects to
`download.seam?cid=<N>`, and that `cid` is ephemeral, single-use and session-bound:
reusing it returns 404 even with the right cookie.

This rules out the usual pattern of collecting every link and downloading them later
in bulk: the redirect has to be followed there and then, with the session alive.

**Status:** mechanism verified (a real PDF was downloaded) — pending ISSUE-6.

---

## 8. The site's encoding is not uniform

Initially the page was found to answer in ISO-8859-1 rather than UTF-8: decoded
with the default, accents corrupt ("APELAÇÃO" becomes "APELAÃÃO").

**But the site does not use a single encoding.** Inspecting the raw bytes showed:

| Request | Actual encoding | Declares charset? |
|---|---|---|
| Page load (GET) | ISO-8859-1 | no |
| AJAX response (POST) | **UTF-8** | no |

Since search replies over AJAX, assuming latin-1 throughout would have corrupted
**every** extracted field.

**Resolution:** decide from the bytes, not the header (which never comes). UTF-8 is
attempted first; if the result contains the replacement character, the bytes were not
valid UTF-8 and latin-1 is used. Accented latin-1 text is almost never valid UTF-8 by
accident, so the distinction is reliable.

Implemented in `decodeByBytes()` (`src/http/client.ts`), with tests covering both.

---

## 9. Handling 429 errors

An explicit requirement of the brief. It must: detect the 429, retry with exponential
backoff, move on to the next document if it persists, and **record what failed** so it
can be retried later.

**No 429 was ever triggered during exploration**, so it cannot be demonstrated by
provoking one against a real court's live site. The behaviour is verified with tests
against a mock HTTP server instead.

A related case: an expired session can return 200 with HTML where a PDF was expected.
That is not a 429, but it is a failure that must be detected so garbage is not written
to disk.

**Status:** implemented in ISSUE-2 (backoff, circuit breaker, expired-session
detection). Failure recording is pending ISSUE-7.

---

## 10. Runs must be resumable

The brief says there is no need to download everything in one go — it is enough to
show the scraper would get there if left running. That means being able to stop and
pick up without repeating work: persisting progress, not re-downloading PDFs already
fetched, and deduplicating cases that appear in more than one query.

**Status:** pending ISSUE-7.
