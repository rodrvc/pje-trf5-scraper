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
runs out the next takes over.

**Correction from an earlier draft of this section:** `PartyTokenSweep`
(ISSUE-4b) does *not* join this chain as a third `PartitionStrategy`. It needs
feedback from each response to choose its next filter and to decide when its
union has plateaued, which a synchronous `split(query): Query[]` cannot
express - and the sweep would have no way to tell a cover's children (which
are not guaranteed complete on their own) from a partition's (which are, by
construction). It plugs into `sweep()` through a separate seam, the `cover`
hook, described below.

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
- A day+class leaf that still saturates is handed to the `cover` seam (ISSUE-4b
  implements it) rather than silently accepted as complete.
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
  most saturation. The constructor throws on an empty catalog (see the
  "empty split" correction below).
- `PartitionChain` — an ordered list of strategies; `applicable(query)` returns
  the first whose `canSplit` is true. It is closed over `PartitionStrategy`
  specifically - a provable, disjoint partition - **not** a general extension
  point for any kind of narrowing; ISSUE-4b's `PartyTokenSweep` does not join
  it (see the "hand-off seam" correction below). `test/partition.test.ts`,
  "picks a later link when the earlier ones are exhausted", only checks that
  the chain itself has no hardcoded notion of "two links" - not that any
  strategy-shaped object is an appropriate thing to add to it.

**`src/pipeline/sweep.ts`** — the walk itself: `sweep({ from, to, search,
chain, cover?, seen? })`, an **async generator** yielding `SweepEvent`s
(`'window'` for a completed, uncapped window; `'capped'` for one that was
narrowed further; `'unsplittable'` for a leaf with nothing left in the chain
and no `cover` supplied; `'covered'`/`'abandoned'`, emitted only by a `cover`).
Depth-first, so a short or interrupted run finishes a contiguous block of
windows rather than a scattering of half-finished ones; recursion is expressed
as `yield*` delegation into `walk(subquery, depth + 1)`, which reads as the
same tree it describes. Deduplicates by CNJ number across the whole run
through an injectable `SeenSet` (in-memory `Set` by default), so a case
surfacing in both a capped day-level window and one of its class-split
children is only emitted once.

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

### Correction: an empty `split()` result would silently drop a saturated leaf

Caught in architecture review. `JudicialClassSplit.canSplit` returns `true` for
any single day with no class set, regardless of the catalog's size - it has no
way to see that the catalog is empty. If the catalog were ever empty (and
`parseClassCatalog` has already once returned `[]` on a markup change without
throwing - its own doc comment says so), `split()` would return `[]`: the walk
would emit the `capped` event for that day and then iterate over zero
subqueries, ending the branch with no further event at all. The leaf would
vanish from the run with nothing to show for it - worse than `unsplittable`,
which at least says "here is what was lost and why".

Fixed at both layers, per the review's request:

- `JudicialClassSplit`'s constructor now throws on an empty catalog, so the
  problem surfaces at catalog-fetch time, where an operator is watching,
  rather than silently during a sweep that may run unattended.
- `sweep()`'s `walk` now computes `strategy.split(query)` into a local before
  emitting anything; if that array is empty, it yields `unsplittable` directly
  and never emits the `capped` event at all - a strategy that says yes and
  produces nothing is, by definition, not actually splittable. This is a
  backstop independent of the specific `JudicialClassSplit` guard, for any
  future strategy that might make the same mistake.

Tests: `test/partition.test.ts`, "refuses to be built with an empty catalog"
(constructor throws); `test/sweep.test.ts`, "treats a strategy that applies
but produces no subqueries as unsplittable, not as a dropped leaf" (a stub
strategy with `canSplit: () => true, split: () => []` produces exactly one
`unsplittable` event and no `capped` event, where the un-fixed code would have
produced a `capped` event and then nothing).

### Correction: the hand-off seam for ISSUE-4b is not the partition chain

Also caught in architecture review, and the most significant structural change
in this round. The original design (see the Scope correction above) proposed
that `PartyTokenSweep` (ISSUE-4b) would join `PartitionChain` as a third
`PartitionStrategy`. That does not work: a party-token cover needs the
response from each filter it tries to decide the next filter and to know when
its union has plateaued, and `PartitionStrategy.split(query): Query[]` is
synchronous with no way to see those responses. Worse, the sweep would have
treated every uncapped child the cover produced as an unconditionally final
`window` event - which is wrong for a cover's children, since a cover's
completeness is *measured*, not proved, and a leaf can be abandoned mid-way
through its budget.

`PartitionStrategy` and `PartitionChain` are unchanged in shape - they are the
right abstraction for what they model, a provable partition - but every claim
that a third link plugs into them was wrong and has been corrected: in
`partition.ts`'s module comment and `PartitionChain`'s doc comment, in this
issue's Scope, and in `issues/ISSUE-4b-party-sweep.md`'s Scope, which now
describes the actual `cover` hook instead of a `PartitionStrategy`.
`test/partition.test.ts`'s "accepts a third link without any change to its own
code" test was renamed to "picks a later link when the earlier ones are
exhausted" and its comment now says explicitly that this checks the chain has
no hardcoded link count, not that any strategy-shaped object belongs in it.

The real seam is a new, minimal hook on `sweep()`:

    cover?: (leaf: Query, first: SearchResponse, search: SearchFn) => AsyncGenerator<SweepEvent>

Invoked in `walk` exactly where `unsplittable` would otherwise be yielded,
passed the leaf query, the response already fetched for it (so the cover does
not repeat that request), and the `search` function to run its own probes.
When `cover` is absent, behavior is byte-for-byte what it was before this
option existed. Two new `SweepEvent` kinds exist for it: `covered` (`{ query,
rows, depth, filtersTried, unionSize, plateaued: true }`, the union stopped
growing) and `abandoned` (`{ query, rows, depth, filtersTried, unionSize }`,
the per-leaf request budget ran out before plateau - never counted as
complete). Both are **final** events for dedup purposes, exactly like `window`
and `unsplittable`.

Test: `test/sweep.test.ts`, "hands an unsplittable leaf to the injected cover
instead of emitting unsplittable" (a fake cover wired in place of ISSUE-4b's
real one proves the seam invokes correctly and that no `unsplittable` events
occur once a cover is present) and "deduplicates a cover event rows against
the run-wide seen set, like any other final event" (a row already seen by an
earlier final event does not reappear in the cover's `covered` event).

### N1: distinct event `type`s instead of a shared `'window'` + `capped` flag

Also from review. `'window'` used to cover both the final, uncapped case and
the informational, capped one, distinguished only by a `capped: boolean`
field - which forced every test and any future consumer to narrow with a cast
or a `capped` check before TypeScript would let them read the type-specific
fields (`splitBy` only exists on the capped variant). Split into five
distinct `type` values instead: `'window'` (final, uncapped), `'capped'`
(informational, narrowed further), `'unsplittable'`, `'covered'`, `'abandoned'`
- each a plain discriminated union member, no compound discriminant. All casts
were removed from `test/sweep.test.ts` as part of this change.

### N2: injectable `seen` set

The `Set` backing dedup was hardcoded inside `sweep()`, which does not survive
a process restart - exactly the case ISSUE-7 is built around. `SweepOptions`
now accepts an optional `seen?: SeenSet` (`{ has(n), add(n) }`), defaulting to
an in-memory `Set` when omitted, so ISSUE-7's runner can back it with
persisted state instead. Noted in the doc comment: for `DateRangeSplit` and
`JudicialClassSplit`, whose subqueries are disjoint by construction, dedup is
a no-op in practice - it only starts doing real work once a `cover` (whose
subqueries can genuinely overlap) is plugged in.

### N4: `history-start.ts` had no tests

Added `test/history-start.test.ts` (5 tests) with a scripted fake search
parameterized by the year filings "start" in: exact boundary found by binary
search, every probe recorded with its actual row count (the audit trail is
independently checked, not just the final answer), `earliestPlausibleYear`
honored as a hard floor even when it is wrong about the true start, the
default 50-year floor applied when the option is omitted, and the edge case
of filings starting in the current year itself.

### An assumption worth stating outright: the class split's completeness rests on the catalog being complete

`JudicialClassSplit` assumes the class catalog fetched via the autocomplete
(`PjeSearch.classCatalog()`) is the **entire** set of judicial classes the
court uses. If the autocomplete ever omitted a class - through a markup change,
a server-side filter, or simply a class introduced after this catalog was
fetched - cases filed under that missing class would never be reached by any
subquery `JudicialClassSplit` produces, and the day would look completely
covered (every emitted class-window uncapped) while silently missing an entire
class's worth of cases. Nothing in this issue's code can detect that on its
own: the catalog is trusted as given.

This is why ISSUE-9's live run should include a cheap sanity check on at least
one class-split day: `sum(rows across every emitted class-window for that day)
>= 30` (the day's own capped count before the split). Agreement does not prove
the catalog is complete, but disagreement would be strong evidence that it is
not, and costs nothing beyond arithmetic already available in the event log.

### Verification

`npm test`: **89 tests green** (57 pre-existing + 17 in `test/partition.test.ts`
+ 10 in `test/sweep.test.ts` + 5 in `test/history-start.test.ts`), no network.
`npm run typecheck`: clean.

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

(Independently reconfirmed during ISSUE-4b: 2025-03-11 + class 202 still
returns 19, uncapped, when both `sgbClasseJudicial_selection` (the id) and
`classeJudicial` (the display name) are sent together - the server silently
ignores the class filter if the id is sent without the name, which is why
`buildFormBody`/`JudicialClassSplit` must always send both. See ISSUE-4b's
Resolution for the full account of that bug.)

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
