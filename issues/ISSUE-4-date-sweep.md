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
   "Nome da parte" field — **split out into ISSUE-4b**, because it is a cover
   rather than a partition and terminates on measured evidence, not by
   construction

Design it as an interchangeable strategy, not nested `if`s:

    interface PartitionStrategy {
      canSplit(q: Query): boolean;
      split(q: Query): Query[];
    }

with `DateRangeSplit` and `JudicialClassSplit` here, chained so that when one
runs out the next takes over. The chain must accept a third link without being
rewritten: ISSUE-4b plugs `PartyTokenSweep` into it.

Both strategies in this issue produce **disjoint** subqueries whose union is the
parent by construction, so recursion terminates when none caps and completeness
is proved rather than measured. ISSUE-4b is deliberately not like that, which is
why it is a separate issue.

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
- No cases are lost to silent truncation.
- A day+class leaf that still saturates is handed to the next strategy in the
  chain rather than silently accepted as complete (ISSUE-4b implements it).
- Covered windows are recorded so runs can resume (ISSUE-7).

## Resolution

_(pending)_
