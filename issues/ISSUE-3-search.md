---
id: ISSUE-3
title: Case search
status: done
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

**`src/pje/search.ts`** — runs the POST reproducing the entire `fPP` form (empty
fields travel too; omitting any of them makes the server answer 200 with no
results and no explanation). The search component id is discovered from the
markup on the first query, with the constant as a fallback.

It also fetches the **judicial class catalog** (132 entries with internal ids),
needed for the second partition dimension in ISSUE-4.

**`src/domain/parse-results.ts`** — pure `(html) => T` parsers, tested against
real fixtures.

### Two markup traps that cost time

**The results cell has no line breaks.** Class, number, subject and parties share
one cell where cheerio's `.text()` collapses everything onto a single line. The
first attempt split on non-existent lines and never extracted the parties.
Parsing now keys off the inner `<b>`, which delimits "abbreviation + number -
subject".

**The autocomplete returns four cells, not two.** RichFaces interleaves empty
padding cells between id and name. The parser read the first (empty) cell as the
id and returned zero classes. Empty cells are now dropped before pairing.

### Finding: the site's encoding is not uniform

While capturing fixtures it emerged that **full page loads arrive as ISO-8859-1
but the AJAX responses to POSTs arrive as UTF-8**, and neither declares a
`charset` in the body.

The client assumed latin-1 throughout, which would have corrupted **every**
extracted field, since search replies over AJAX. Fixed by deciding from the
bytes: attempt UTF-8, fall back to latin-1 when invalid. Documented in
`PROBLEMS.md` §8.

### Verification

`npm test`: **55 tests green**, no network.

Smoke test against the live site:

| Query | Rows | Capped |
|---|---|---|
| 2025-03-05 | 10 | no |
| 2025-03-11 | 30 | **yes** |
| 2025-03-11 + class 202 | 19 | no |

Data comes out complete and correctly accented (`APELAÇÃO CÍVEL`, subject
`Juros`, parties with the ` X ` separator). The third row confirms the second
partition dimension works: a day that saturated stops doing so once filtered by
class.
