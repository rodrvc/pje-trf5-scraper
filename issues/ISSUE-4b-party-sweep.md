---
id: ISSUE-4b
title: Party-token sweep
status: todo
---

## Goal

Cover the leaves that ISSUE-4 cannot split any further.

ISSUE-4 partitions by date and then by judicial class. When one day + one class
still returns 30 rows, that leaf is the bottom of the disjoint tree — and part of
the corpus sits behind it. This issue reaches it.

Depends on ISSUE-4 (the `PartitionStrategy` chain).

## The finding this rests on

`Nome da parte` is **not** an exact-name lookup. It is a
`LIKE %token% AND LIKE %token%` substring match:

- Order independent (`ILV OS` matches a "…sILVa…santOS…" party)
- Matches mid-word, not just word starts
- The "at least two names" validation only counts whitespace-separated tokens,
  so **single-character tokens pass**: `A A`, `DA S`, `E S` all run

Because the filter reaches cases the unfiltered query cannot show, unioning
several filters over a saturated leaf yields more than 30 cases. Measured on four
leaves (day + class 202), unioning nine crude filters:

| Leaf | Unfiltered | Union |
|---|---|---|
| 2025-03-12 | 30 | 42 |
| 2025-03-11 | 30 | 41 |
| 2025-03-14 | 30 | 37 |
| 2025-03-19 | 30 | 33 |

Full evidence in `PROBLEMS.md` §5.

## Scope

Implement `PartyTokenSweep` as a third `PartitionStrategy`, chained after
`JudicialClassSplit`.

**It is a cover, not a partition.** This is the design constraint that makes it
different in kind from the other two strategies, and it must be visible in the
code rather than buried:

- `DateRangeSplit` and `JudicialClassSplit` produce **disjoint** subqueries whose
  union is the parent by construction. Recursion terminates when none caps, and
  completeness is *proved*.
- `PartyTokenSweep` produces **overlapping** subqueries with no such guarantee.
  Termination is empirical, and completeness is *measured*.

Requirements:

- Run only on leaves that already saturated under day + class. Never as a first
  resort: it costs several requests per leaf.
- Deduplicate by CNJ number across filters (the union is the result).
- **Stop when the union stops growing**, not after a fixed number of probes. The
  yield varied from 33 to 42 across the four measured leaves, so a fixed count
  would either waste requests or truncate. Suggested rule: stop after N
  consecutive filters that add no new case; make N configurable.
- Cap the per-leaf request budget. A leaf that exhausts its budget while the
  union was still growing is **not** complete and must be recorded as such.
- Choose the token alphabet deliberately and justify it in the resolution.
  Frequent Portuguese digraphs will fragment the set faster than random pairs;
  measure rather than assume.
- Record per leaf: filters tried, union size, whether it plateaued. This is the
  evidence behind the completeness claim, so it has to survive into the output.

### Reporting the residue

A leaf whose union plateaued is covered, with evidence. A leaf abandoned while
still growing goes to `data/uncoverable.ndjson` with its counters, so the
deliverable can state exactly what was and was not exhausted instead of implying
completeness. Coordinate the file format with ISSUE-7.

## Constraints

- **Use the existing `PjeClient` for every request.** It already throttles by
  measuring elapsed time since the previous request and waiting only the
  remainder, and it already handles 429 with `Retry-After`, exponential backoff,
  jitter and a circuit breaker. Do **not** add `sleep()` calls of your own and do
  not bypass it.
- Make the request interval configurable rather than hardcoded. This runs against
  a real court's production server.
- Keep the strategies pure where possible: query generation is testable without a
  network, and should be tested that way.

## Acceptance

- A leaf that saturates under day + class yields **more than 30** unique cases.
- The stop condition is driven by union growth, and is unit-tested with a fake
  search that returns scripted result sets.
- A leaf abandoned before plateau is written to `data/uncoverable.ndjson` and is
  never counted as complete.
- The chosen token alphabet is justified with measured numbers, not asserted.

## Resolution

_(pending)_
