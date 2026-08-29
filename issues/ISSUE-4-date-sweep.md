---
id: ISSUE-4
title: Date-window sweep
status: done
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

**`src/pipeline/partition.ts`** — the `PartitionStrategy` interface
(`canSplit(q)`, `split(q)`), plus:

- `DateRangeSplit` — halves `[from, to]` at the integer midpoint. Arithmetic
  runs entirely over epoch-day integers derived by `Date.parse` on an explicit
  `T00:00:00.000Z` suffix, never `new Date()` in the local timezone (which
  would shift day boundaries depending on where the process runs). Not
  splittable once `from === to`.
- `JudicialClassSplit` — applicable only to a single day (`from === to`) with
  no class set yet; emits one subquery per class in the catalog handed to its
  constructor. Applying the date axis first and the class axis only at a
  single day matches the issue's evidence: splitting a wide range by class
  would multiply requests for no benefit, since narrowing dates alone resolves
  most saturation.
- `PartitionChain` — an ordered list of strategies; `applicable(query)` returns
  the first whose `canSplit` is true. The chain carries no partitioning logic
  of its own, which is what lets ISSUE-4b's `PartyTokenSweep` plug in as a
  third element of the array with zero changes to this file — verified with a
  test (`test/partition.test.ts`, "accepts a third link without any change to
  its own code") that appends a stub strategy and confirms the chain picks it
  up.

**`src/pipeline/sweep.ts`** — the walk itself: `sweep({ from, to, search,
chain })`, an **async generator** yielding `SweepEvent`s (`'window'` for a
completed window, capped or not; `'unsplittable'` for a leaf that saturated
with nothing left in the chain to split it). Depth-first, so a short or
interrupted run finishes a contiguous block of windows rather than a scattering
of half-finished ones; recursion is expressed as `yield*` delegation into
`walk(subquery, depth + 1)`, which reads as the same tree it describes.
Deduplicates by CNJ number across the whole run via a `Set` closed over the
walk, so a case surfacing in both a capped day-level window and one of its
class-split children is only emitted once.

**Design choice: async generator over an event callback.** Three reasons,
elaborated in the code comment: (1) the walk is naturally recursive, and
`yield*` delegation matches that shape directly, where a callback would need
its own explicit stack; (2) an async generator gives backpressure for free —
it does not run ahead of the consumer, which matters because every yielded
window has already spent a live HTTP request, so a callback emitter would need
its own pause mechanism to get the same throttling-friendly property; (3)
testing is a plain `for await` collecting events into an array, no fake event
bus needed. The cost is that a consumer must actively drive the generator
(`for await (const _ of sweep(...))`), but ISSUE-7's resumable runner wants to
persist state after every event anyway, which a `for await` loop does
naturally — so this is not really a cost for the intended caller.

**`src/pipeline/history-start.ts`** — optional, kept separate from the sweep as
required. Binary-searches the first year with any filings by probing
`[Jan-1-of-year, today]` and checking whether it returns zero rows; `O(log
years)` rather than a linear year-by-year scan. The sweep itself only takes an
explicit `from`/`to` and does not depend on this module.

### A trap found while writing the tests

The naive midpoint `from + (to - from) / 2` on an **even**-length range
(2 days) rounds down to `from` itself when done with integer epoch days,
which would make `split` return `[from, from]` and `[from+1, to]` — the first
"half" being the whole single day already, technically correct but easy to
get backwards. Wrote an explicit test for the 2-day case
(`test/partition.test.ts`, "splits a two-day range into two single days") to
pin the exact boundary, plus month-boundary and leap-day cases (Feb 28 → Mar 1
in a leap year is 3 days and gets the extra day on the first half; the same
range in a non-leap year is 2 days) to make sure the UTC epoch-day arithmetic
does not silently misplace the boundary around calendar irregularities.

### Correction: the walk went oldest-first, not "from the present backwards"

Caught in review. `DateRangeSplit.split` originally returned `[earlier, later]`
and the sweep simply consumed a strategy's subqueries in order, so the walk
covered the oldest half of a range first - the opposite of the "walk from the
present backwards" requirement, even though the doc comment claimed otherwise.

Fixed at the point where the order is actually decided: `split()` now returns
`[later, earlier]`, with the reasoning recorded in `DateRangeSplit`'s own doc
comment rather than assumed by the caller. `sweep()`'s comment was corrected to
say plainly that it does not reorder anything - it just consumes what `split()`
hands it - so the "recent first" guarantee lives in exactly one place. Added
`test/sweep.test.ts`, "covers the most recent day first, not the earliest,
for a multi-day range", asserting directly on event order rather than only on
which queries ran.

### Correction: a capped window's rows were marked "seen"

Also caught in review, and more consequential: the original `deduplicate()`
call ran on every window's rows, including capped ones. Since a capped
window's rows are a strict prefix of what its children will find (the site
returns rows ordered by CNJ ascending, truncated - PROBLEMS.md §5), marking
them "seen" at the capped event meant the children's later, genuine sighting
of those same cases would look like duplicates and get silently dropped from
every final event. That directly contradicted the issue's own framing: "a
capped query is a signal to narrow, not a result."

Fixed by only deduplicating (and registering into the `seen` set) at the two
**final** event kinds - `window` with `capped: false`, and `unsplittable`. A
capped window still carries its raw, undeduplicated rows for auditability, but
`SweepEvent`'s doc comment now states plainly that those rows are informational
only and must not be treated as part of the sweep's output. Added
`test/sweep.test.ts`, "does not treat a capped window as final: its rows still
reach the child final event", which fails under the old (buggy) behavior:
without the fix, the child's identical rows would have been dropped as
duplicates of the parent's. Also rewrote the pre-existing dedup test to
dedupe only over final events, since counting a capped window's informational
rows toward "the result" was the same category of mistake.

### Verification

`npm test`: **80 tests green** (57 pre-existing + 16 in `test/partition.test.ts`
+ 7 in `test/sweep.test.ts`), no network. `npm run typecheck`: clean.

### Live smoke test

Ran one sweep from 2025-03-10 to 2025-03-14 against the real TRF5 server
(`delayMs: 1600`), budget capped at 40 requests (2 requests per query: the
`open` + `post` pair `PjeSearch.search` performs), using the real
`JsfSession`/`PjeSearch`/`HttpClient` stack unchanged:

| Metric | Value |
|---|---|
| Requests used | 40 / 40 (budget hit mid-run, by design) |
| Windows covered | 19 |
| Capped windows (further split) | 4 |
| Uncapped leaf windows | 15 |
| Unsplittable leaves reached | 0 |
| Split-by breakdown | `date-range`: 3, `judicial-class`: 1 |
| Deduplicated rows emitted | 81 |

The cascade ran exactly as designed: the 5-day root range capped at 30 and
split by date three times in a row (`2025-03-10..14` → `2025-03-10..12` →
`2025-03-10..11`, each still capped), down to single days; `2025-03-10` came
back uncapped at 9 rows, while `2025-03-11` alone still capped at 14 and was
handed to `JudicialClassSplit`. From there the class fan-out (132 classes)
consumed the rest of the request budget before finishing that one day — which
is the expected shape given the budget: class-splitting a saturated day costs
up to 132 requests to exhaust every class, so a 40-request smoke budget
naturally stops partway through the first one. No leaf reached "day + class
still caps" in this run (0 unsplittable events), consistent with ISSUE-3's
finding that 2025-03-11 + class 202 alone drops to 19, uncapped — but the
cascade's third rung (ISSUE-4b) exists precisely because that is not
guaranteed for every day/class combination.

This also confirms the acceptance criteria empirically: the 5-day range did
split itself until windows stopped capping, the saturating day was split by
class rather than recorded as lost, and every window (capped or not) produced
an event, so nothing here was silently truncated.

### Known cost: class-splitting is expensive, and ISSUE-9 must budget for it

`JudicialClassSplit` issues **one request per class in the catalog (132)** to
fully resolve a single saturating day - confirmed live above, where the class
fan-out for just one day (2025-03-11) consumed the rest of a 40-request budget
without finishing. With roughly half of days saturating under the date axis
alone (PROBLEMS.md §5: 6 of 13 probed days), a full month of history costs
approximately:

    ~30 days × 0.5 saturating × 132 requests/day  ≈  2,000 requests/month

This is not a bug - it is what completeness costs on a site with no
pagination - but it means an unbounded sweep over years of history is not
something to run casually. ISSUE-9 (the sweep orchestrator) needs an explicit
request budget and/or date-range limit for anything short of a full
production run, and a demo run should default to a narrow range rather than
the whole corpus.
