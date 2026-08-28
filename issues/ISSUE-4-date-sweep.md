---
id: ISSUE-4
title: Date-window sweep
status: todo
---

## Goal

Cover the whole corpus even though the site caps at 30 and has no pagination.

Resolves problem 5 in `PROBLEMS.md`, already investigated: the "Data de Autuação"
filter works on its own and caps at 30 on broad ranges, but returns the real
total on narrow ones.

## Scope

Verified that **a single day does NOT always fit under 30**: probing March 2025,
6 of 13 days saturate. And a day + a class still saturates in some cases. So
splitting cascades across **three dimensions**:

1. **Dates**: halve the range, recursively
2. **Judicial class**: when a single day still saturates, split that day by
   class. Verified: 2025-03-11 caps at 30 but drops to 19 under class 202
3. **Party-name tokens**: when day + class still saturates, sweep the
   "Nome da parte" field, which is a substring filter (see below)

Design it as an interchangeable strategy, not nested `if`s:

    interface PartitionStrategy {
      canSplit(q: Query): boolean;
      split(q: Query): Query[];
    }

with `DateRangeSplit`, `JudicialClassSplit` and `PartyTokenSweep`, chained: when
one runs out, the next takes over.

### The third dimension is a cover, not a partition

`Nome da parte` is a `LIKE %token% AND LIKE %token%` substring match: order
independent, matching mid-word, and its "at least two names" validation only
counts whitespace-separated tokens — **single-character tokens pass** (`A A`,
`DA S`, `E S` all run). Full evidence in `PROBLEMS.md` §5.

This matters for the design: the resulting subsets **overlap**, so the two
strategies above and this one are not interchangeable in kind.

- `DateRangeSplit` / `JudicialClassSplit` produce **disjoint** subqueries whose
  union is the parent by construction. Recursion terminates when none caps.
- `PartyTokenSweep` produces **overlapping** subqueries with no completeness
  guarantee. Termination is empirical: keep adding filters while the deduplicated
  union keeps growing, stop when it plateaus.

Measured on four saturating leaves, unioning nine crude filters:

| Leaf | Unfiltered | Union |
|---|---|---|
| 2025-03-12 + class 202 | 30 | 42 |
| 2025-03-11 + class 202 | 30 | 41 |
| 2025-03-14 + class 202 | 30 | 37 |
| 2025-03-19 + class 202 | 30 | 33 |

The yield varies, which is why the stop condition must be "the union stopped
growing", not a fixed probe count.

Two consequences for the implementation:

- **The sweep only runs on leaves that saturate** (~1 in 8 day+class leaves), so
  its cost stays bounded even though each sweep is several requests.
- **Completeness becomes measured, not proved.** A leaf where the union plateaued
  is reported as covered-with-evidence (filters tried, union size, last CNJ seen);
  one still growing when the budget ran out goes to `data/uncoverable.ndjson`
  rather than being silently called complete.

### Ordering is by CNJ ascending

Results come back ordered by case number ascending, truncated at 30 — so what is
lost always sits *above* the last row shown. The last row is therefore a useful
progress signal: a filter whose last row exceeds the unfiltered leaf's last row is
demonstrably reaching new territory. Row ids in the markup are entity keys, not
indices, so there is no offset to exploit.

- **Cap condition: `rows >= 30 || warning present`** (defensive; across every
  probe so far the two signals agreed — including six re-probed saturating leaves
  that all carried the warning — but a silent cap would create exactly the gap
  this is meant to prevent)
- Class catalog: fetched with a POST to the autocomplete, which returns all 132
  classes with their internal ids
- Deduplicate by CNJ number: different windows can surface the same case
- Walk **from the present backwards**, so a short run shows recent cases
- Determine the lower bound of the history empirically (binary search on the
  start year) rather than starting from an arbitrary date
- Date arithmetic in UTC or over ISO strings, never with local `new Date()`
- Log every window covered, so progress is auditable

## Acceptance

- A broad range splits itself until no query caps.
- A saturating day is split by judicial class rather than recorded as lost.
- A saturating day+class is swept by party token rather than recorded as lost,
  and yields more than 30 cases where the unfiltered leaf yielded exactly 30.
- No cases are lost to silent truncation.
- A leaf abandoned before its union plateaued is written to
  `data/uncoverable.ndjson` with the evidence, never counted as complete.
- Covered windows are recorded so runs can resume (ISSUE-7).

## Resolution

_(pending)_
