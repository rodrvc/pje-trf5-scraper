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

But parties and movements are paginated **within** the page (65 movements in one test
case). The first HTML does not carry everything; those paginators must be walked.

**Resolution:** they are `Richfaces.Datascroller` components. Changing page is
another AJAX POST shaped like this:

    AJAXREQUEST=_viewRoot
    <baseId>=<baseId>                 # scroller id without the trailing suffix
    javax.faces.ViewState=<current>
    <scrollerId>=2                    # target page number
    ajaxSingle=<scrollerId>
    AJAX:EVENTS_COUNT=1

Verified: moving to page 2 of the active parties does change the participant list.
The scroller ids (one per table: active parties, passive parties, movements) are read
from the detail markup, and the page count comes from the paginator itself
(`«« « 1 2 3 ... » »»`).

Note: the detail page's ViewState differs from the search one and must be refreshed
with every response.

### The `ca=` token does not expire with the session

Checked in three scenarios with the same token: the session that produced it, a fresh
clean session, and **sending no cookie at all**. All three return 200 with the same
case detail.

So `ca=` is a stable case identifier, not a conversation token like the PDF `cid`
(problem 7). **It can be persisted for resuming**: picking up a run does not require
re-running the search to reach an already-listed case.

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
