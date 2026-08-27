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
6 of 13 days saturate. So splitting cascades across **two dimensions**:

1. **Dates**: halve the range, recursively
2. **Judicial class**: when a single day still saturates, split that day by
   class. Verified: 2025-03-11 caps at 30 but drops to 19 under class 202

Design it as an interchangeable strategy, not nested `if`s:

    interface PartitionStrategy {
      canSplit(q: Query): boolean;
      split(q: Query): Query[];
    }

with `DateRangeSplit` and `JudicialClassSplit`, chained: when the first runs out,
the next takes over.

- **Cap condition: `rows >= 30 || warning present`** (defensive; across 14 probes
  they always agreed, but a silent cap would create exactly the gap this is meant
  to prevent)
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
- Covered windows are recorded so runs can resume (ISSUE-7).

## Resolution

_(pending)_
