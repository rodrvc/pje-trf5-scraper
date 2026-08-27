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
Even so the defensive condition **`rows >= 30 || warning present`** is used: if the
cap ever arrived without a warning, the alternative is losing cases silently.

### Approaches ruled out

The "Processo" and "Processo referência" fields **do not accept partial matches**:
passing `8100` (an originating-court code) returns exactly the same results as no
filter at all. They are silently ignored and only serve exact lookups, so they cannot
be used for partitioning.

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
