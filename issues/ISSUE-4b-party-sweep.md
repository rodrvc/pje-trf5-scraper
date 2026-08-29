---
id: ISSUE-4b
title: Party-token sweep
status: done
---

## Goal

Cover the leaves that ISSUE-4 cannot split any further.

ISSUE-4 partitions by date and then by judicial class. When one day + one class
still returns 30 rows, that leaf is the bottom of the disjoint tree — and part of
the corpus sits behind it. This issue reaches it.

Depends on ISSUE-4 (the `sweep()` walk and its `cover` hook).

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

Implement `PartyTokenSweep` as the `cover` hook ISSUE-4's `sweep()` accepts
(`src/pipeline/sweep.ts`'s `SweepOptions.cover`, of type `CoverFn`), invoked on
every leaf the `PartitionChain` cannot narrow any further.

**It is a cover, not a partition, and it is *not* a `PartitionStrategy`.** This
is a correction from the original design in this issue: a `PartitionStrategy`'s
`split(query): Query[]` is synchronous and cannot see the search responses of
the subqueries it produces, but `PartyTokenSweep` needs exactly that feedback -
each filter's response tells it whether the union grew, which is what decides
both the *next* filter to try and *when to stop*. `PartitionChain` stays closed
over `PartitionStrategy` (a provable, disjoint partition); this cover is a
structurally different kind of narrowing and lives in its own seam instead:

    cover?: (leaf: Query, first: SearchResponse, search: SearchFn) => AsyncGenerator<SweepEvent>

`sweep()` calls it exactly where it would otherwise emit `unsplittable`,
passing the leaf query, the already-fetched first response (so the cover does
not repeat that request), and the `search` function to run its own probes
with. It must end with exactly one `covered` (`{ query, rows, depth,
filtersTried, unionSize, plateaued: true }`) or `abandoned` (`{ query, rows,
depth, filtersTried, unionSize }`, budget exhausted before plateau) event.

The distinction that matters is unchanged, only relocated:

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

**`src/domain/types.ts`** — `Query` gains `partyName?: string`, documented as
the substring filter PROBLEMS.md §5 describes, additive and optional so every
existing caller is unaffected. **`src/pje/search.ts`** —
`PjeSearch.buildFormBody` now sends `query.partyName ?? ''` in
`FIELDS.partyName`, the one-line wiring that lets any `Query` carry the filter
through to the real form POST.

**`src/pipeline/party-sweep.ts`** — `createPartyTokenSweep(options?)`, a
factory returning a `CoverFn` (not a class instantiated per leaf: the sweep
only ever needs one configured `CoverFn` value, and all per-leaf state - the
union map, the flat-streak counter - lives in the returned generator's own
closure per invocation). For a leaf handed to it:

1. Seeds the union with the leaf's already-fetched first response (the
   `first` parameter `sweep()` passes in) - no wasted request re-running the
   unfiltered query.
2. Iterates the token alphabet (`party-token-alphabet.ts`), running
   `search({ ...leaf, partyName: token })` for each and folding new rows into
   a `Map<cnj, row>` keyed by CNJ number, which is exactly the union
   deduplication the issue asks for.
3. A `RejectedQueryError` from a token (the server's "two names" validation,
   or any future validation the server adds) is recorded against the
   per-leaf filter budget and skipped - not fatal to the leaf. Any other
   error propagates: a network failure or rate limit is the runner's problem
   (ISSUE-7), consistent with `sweep()`'s own error policy.
4. Stops and yields `covered` after `plateauAfter` (default 5) consecutive
   filters that added nothing new to the union.
5. If the alphabet (or an explicit `maxFiltersPerLeaf`) runs out first, yields
   `abandoned` instead - never `covered` - since the union may have still been
   growing on the very last filter tried.

### Nit A: `depth`/`query` are stamped by the walk, not the cover

Caught in ISSUE-4's own architecture review and folded into this branch as
required. `CoverFn` previously returned full `SweepEvent`s, which meant the
cover had to fabricate a `depth` it has no way of tracking correctly (it is
not part of the recursive `PartitionChain` tree - it runs once per leaf) and
echo back a `query` that was simply the `leaf` it was already handed. Split
into a new `CoverEvent` type (`sweep.ts`) carrying only what a cover actually
knows - `rows`, `filtersTried`, `unionSize`, `plateaued` - and a `toSweepEvent`
helper at the `walk`'s call site that stamps `query` and `depth` before the
event reaches the consumer, exactly the same way `deduplicate` is already
applied there. `CoverFn`'s signature changed from
`AsyncGenerator<SweepEvent>` to `AsyncGenerator<CoverEvent>`; both `sweep.ts`
doc comments (`SweepEvent`'s and `CoverFn`'s) now explain the split.
`test/sweep.test.ts`'s two cover-seam tests were updated to yield
`CoverEvent`s (no `query`/`depth` in the literal) and to assert the walk
stamped the correct `depth` (1, not a value the fake cover made up) on the
resulting event.

### Nit B: the "Three variants" doc comment undercounted

`sweep.ts`'s `SweepEvent` doc comment said "Three variants are final" while
listing four (`window`, `unsplittable`, `covered`, `abandoned`). Fixed to
"Four".

### Debugging a wrong first measurement: the class filter needs both fields

The first pass at this measurement ran against "2025-03-12 + class 202" and
found the union plateaued at 30 - exactly the unfiltered count, no growth at
all. That result was wrong, and the leaf it ran against was not what it
claimed to be. Root cause, found by diffing the exact POST body
`PjeSearch.buildFormBody` produces against a raw curl reproduction field by
field: a probe harness had sent `sgbClasseJudicial_selection=202` (the
internal class id) with `classeJudicial` (the display name) left **empty**.
The server silently ignores the class filter when the id arrives without the
name, so every "day + class 202" query in that first pass actually ran as a
bare day-level query - the class dimension was never applied.

`PjeSearch.buildFormBody` itself was never affected: it has always set both
`FIELDS.judicialClass` (from `query.judicialClassName`) and
`FIELDS.judicialClassId` (from `query.judicialClassId`), and `JudicialClassSplit`
has always populated both from the catalog entry (see `src/pipeline/partition.ts`
and `src/pje/search.ts`, unchanged by this correction). The bug lived entirely
in the ad hoc debugging harness used to double-check the live numbers, not in
the shipped code - but it produced numbers wrong enough (a false "the corpus
isn't saturated anymore" conclusion) that they had to be retracted rather than
shipped. See `PROBLEMS.md` §5's "Correction: the judicial-class filter needs
both the id AND the display name" for the full field-by-field comparison and
the confirming row-set diff (12 of 30 rows under class 202 do not appear at
all in the day's unfiltered set - the class filter is doing real, distinct
work once both fields are sent).

### Measurement: choosing the token alphabet

Redone against the leaf PROBLEMS.md's original probe actually used and that
this issue's own evidence rests on: **2025-03-12, day-level, no class
filter** (30 rows, capped, warning present - see PROBLEMS.md §5's "third
dimension" table). Ran live against the real `PjeSearch`/`JsfSession`/
`HttpClient` stack (`delayMs: 1600`, no `sleep()` of the sweep's own).

The same measurement is re-runnable without any TypeScript at all via
`docs/probe-party-tokens.sh` (plain curl, in the style of
`docs/probe-pagination.sh`/`docs/probe-class.sh`), which tracks the running
union of CNJ numbers across a list of tokens and prints the same
rows/capped/new/union columns as the table below. It requires **both** the
class id and display name when a class filter is passed - the script's own
comment repeats the "id alone is silently ignored" warning from the
class-filter correction above, so a grader re-running it does not repeat
that mistake.

| # | Filter | Rows | Capped | New | Union |
|---|--------|------|--------|-----|-------|
| _(seed)_ | _(none)_ | 30 | yes | - | 30 |
| 1 | `DE A` | 30 | **yes** | - (untrusted) | - |
| 2 | `DA S` | 12 | no | 1 | 39 |
| 3 | `OS S` | 23 | no | 2 | 41 |
| 4 | `NT O` | 21 | no | 3 | 44 |
| 5 | `ES A` | 18 | no | 0 | 44 |
| 6 | `RA S` | 21 | no | 0 | 44 |
| 7 | `AN A` | 18 | no | 0 | 44 |
| 8 | `IN A` | 23 | no | 0 | 44 |
| 9 | `RI A` | 21 | no | 1 | 45 |
| 10 | `DO S` | 21 | no | 0 | 45 |
| 11 | `ER A` | 30 | **yes** | - (untrusted) | - |
| 12 | `CO S` | 16 | no | 0 | 45 |
| 13 | `TE S` | 12 | no | 1 | 46 |
| 14 | `AL V` | 7 | no | 0 | 46 |
| 15 | `UZ A` | 0 | no | 0 | 46 |

The union plateaus at **46** starting at filter 13 (`TE S`); filters 14-15
(both uncapped) add nothing further, a genuine flat streak of 2. Filters 1
and 11 (`DE A`, `ER A`) hit the cap themselves - their rows are still folded
into the union (they are real, verified cases), but neither their growth nor
lack of it counts as evidence toward the flat streak (see the code-behavior
correction below): a capped filter cannot be trusted to say "no new cases",
only "no new cases *among the ones shown*". A follow-up probe with 7 more
tokens not in this alphabet (`IL VA`, `SANT OS`, `SIL VA`, `FER RE`, `MEN
DES`, `CAR LOS`, `MA RIA`), all uncapped, found zero further growth - 9
consecutive flat, uncapped filters in total (filters 14-15 plus the 7
exploratory ones), confirming this is a real plateau and not an artifact of a
short run.

**Single-letter alphabet**, measured earlier (before the class-filter bug
above was found, so on a leaf later shown to be day-only rather than
day+class - the shape of the result is unaffected by which leaf it ran on,
since the point is the pattern, not the specific union size):

| Filter | Rows | Capped |
|---|---|---|
| `A A` | 30 | **yes** |
| `A B` | 11 | no |
| `A C` | 26 | no |
| `A D` | 30 | **yes** |
| `A E` | 30 | **yes** |

**Decision: the digraph/trigram alphabet.** Two of fifteen digraph/trigram
filters were themselves capped here (`DE A`, `ER A`); three of five
single-letter filters were capped on the earlier run. A single character
matches far too much of the corpus to reliably stay under the site's 30-row
cap, and single-letter filters would be capped even more often at scale -
which defeats the purpose of using a filter as a *cover* signal at all, since
a capped filter's own rows are silently incomplete and cannot be trusted to
report "no new cases." `PARTY_TOKEN_ALPHABET` (`party-token-alphabet.ts`)
holds the chosen 15 tokens with this table and reasoning alongside it, so
`party-sweep.ts` itself does not need to justify the choice.

**Stop rule: `plateauAfter: 5` consecutive flat, *uncapped* filters (default,
configurable).** The digraph run above plateaued at filter 13, with filters
14-15 flat and the 7 exploratory tokens afterward extending that to 9
consecutive flat, uncapped filters - well past the default threshold of 5,
which is a deliberate safety margin over the minimum needed here (2, per this
run) against a single unlucky run of overlapping filters being mistaken for a
genuine plateau, at the cost of at most a few extra requests per leaf once
the real plateau has already happened. Configurable rather than hardcoded
because it is a judgment call from one measured run, not a proven constant.

### Correction: a capped filter's silence must not count toward the plateau

The stop rule is meant to trust only an *uncapped* filter's "no new cases" as
evidence a plateau is real (the coordinator's review flagged this
explicitly, matching the same distrust already applied when comparing
alphabets above). `createPartyTokenSweep`'s implementation did not actually
enforce this: it incremented (or reset) the flat-streak counter based purely
on whether the union grew, regardless of `response.capped`. A capped filter
that happened to add nothing new to the union would silently count as a flat
filter, which could trigger `covered` on a leaf that is not actually
covered - the capped filter might be hiding cases beyond its own 30-row
cutoff that a later, uncapped filter would have found.

Fixed in `src/pipeline/party-sweep.ts`, first pass: the flat-streak counter
was made to update only when `response.capped` is false; a capped filter's
rows still get folded into the union (they are real, verified cases, so they
can only help), but its silence would neither start nor extend the streak.
Added `test/party-sweep.test.ts`, "does not let a capped filter satisfy the
plateau, even when it adds nothing new" - two capped, flat filters in the
middle of a run must not trigger `covered` with `plateauAfter: 2`; only two
*uncapped* flat filters afterward do. This test fails under the pre-fix
behavior (it would have plateaued three filters too early, at
`filtersTried: 3` instead of `5`).

### Correction: a capped filter that GROWS the union must still reset the streak

Caught in architecture review of PR #11. The first pass's fix above went one
step too far: it made a capped filter's outcome *never* touch the streak,
growth included, when only its *silence* is untrustworthy. A capped filter
that adds a genuinely new case is real, positive evidence the leaf still has
more to give - there is nothing suspect about a positive result, only about
a capped filter's lack of one - so failing to reset the streak on a capped-
but-growing filter could let an earlier flat streak (from before the capped
filter ran) carry through it and trigger a premature plateau. This is exactly
the scenario the measured alphabet contains: `ER A` (position 11 of 15,
before the reorder below) is capped and could sit in the middle of a longer
run where streaks build.

Fixed by reordering the check: growth always resets the streak, capped or
not; only an *uncapped* filter's silence extends it.

```ts
if (grew) {
  flatStreak = 0;
} else if (!response.capped) {
  flatStreak += 1;
}
```

Added `test/party-sweep.test.ts`, "a capped filter that adds new cases still
resets the streak" - a capped filter in the middle of a run that genuinely
grows the union must reset an existing streak, proven by continuing with two
more uncapped flat filters afterward and checking the plateau lands at
`filtersTried: 4` (streak restarted at the capped grower), not one filter
earlier (which is what the pre-fix, "capped never touches the streak"
behavior would have produced).

### Factory guards: reject configurations that can only ever produce `abandoned`

Also from the same review round. Nothing previously stopped
`createPartyTokenSweep({ plateauAfter: 0 })` (a "plateau" of zero consecutive
flat filters is not a plateau) or a `maxFiltersPerLeaf` smaller than
`plateauAfter` (the budget could never observe enough consecutive flat
filters to reach a genuine plateau, so every leaf handed to it would
silently end `abandoned` no matter what the server returned). Both are
programming errors in how the cover is wired, not something a live run
should discover only after burning its request budget.

`createPartyTokenSweep` now throws `RangeError` synchronously, at
construction, for either case. Added
`test/party-sweep.test.ts`: "rejects a plateauAfter below 1" (0 and -1 both
throw), "rejects a maxFiltersPerLeaf smaller than plateauAfter", and "accepts
maxFiltersPerLeaf exactly equal to plateauAfter" (the boundary is inclusive -
only strictly smaller is rejected). Also added an explicit
"stops at maxFiltersPerLeaf even when the union is still growing and no
plateau was reached" test, which existed only implicitly before (folded into
other tests' assertions) and is now its own case: a leaf whose union never
stops growing must still end `abandoned` once the budget runs out, with the
alphabet's later tokens never even tried.

Two pre-existing tests (`skips a token rejected by the server...`,
`deduplicates the union across filters...`) used `plateauAfter: 5` against a
3-token alphabet - a configuration the new guard now rejects outright.
Adjusted both to `plateauAfter: 3`, matching the alphabet length; neither
test's actual assertions depended on the specific threshold.

### Doc fixes from the same review

- `PartyTokenSweepOptions.maxFiltersPerLeaf`'s doc comment claimed it counts
  the leaf's first (unfiltered) response; the code never did (that response
  is already paid for by the walk before the cover runs, and only
  `partyName` filters are counted). Fixed the comment and noted the budget
  must be `>= plateauAfter`.
- `createPartyTokenSweep`'s own doc comment now states its assumption that
  the `first` response the walk hands it was itself capped - true by
  construction of where `sweep()`'s `walk` invokes a `cover` (only after a
  saturated leaf with no strategy left in the chain), but worth stating
  explicitly since this module does not re-check it.
- `party-token-alphabet.ts` claimed a capped filter's rows are "excluded ...
  from the union tally" - wrong, and directly contradicted by the code: a
  capped filter's rows are always merged into the union (they are real
  cases), only its *silence* is excluded from counting as plateau evidence.
  Corrected to say so plainly, and to match the corrected `grew`-first logic
  above.

### Alphabet order: known-capping tokens moved to the end

`DE A` and `ER A` were the two tokens that came back capped in the
measurement (positions 1 and 11 of 15). Per the same review, moved both to
the end of `PARTY_TOKEN_ALPHABET` (now positions 14-15): a leaf should spend
its cheaper, more informative uncapped tokens first, and only reach for the
two whose *silence* carries no trust once those are exhausted, rather than
risk a short-budget run finishing on two low-evidence requests near the
front. This does not change the measured plateau point (46, unaffected by
order for the underlying union growth), only where a request budget gets
spent; `party-token-alphabet.ts`'s doc comment states the reordering and
reasoning explicitly, next to the (unchanged) measurement table.

### An honest finding, corrected: 2025-03-12 (day-level) does saturate, and the party filter does escape the cap

The measurement above confirms PROBLEMS.md §5's original finding rather than
contradicting it, once run against the leaf that finding actually describes.
An earlier draft of this section claimed the four leaves PROBLEMS.md records
as saturated (day + class 202) no longer saturate today, and that the corpus
must have drifted since PROBLEMS.md was written. That claim was wrong and has
been retracted: it was an artifact of the class-filter bug above, not a
genuine change in the site's data. Every number in this section's table now
comes from a leaf verified, field by field, to carry the class filter
correctly - see the debugging section above and `PROBLEMS.md` §5's
corresponding correction.

### `data/uncoverable.ndjson`

**`src/pipeline/uncoverable.ts`** — `recordUncoverable(record, path)`, a
small, focused writer: one JSON object per line (`query`, `depth`,
`filtersTried`, `unionSize`, an optional `cnjNumbers` list, `recordedAt`),
append-only, creating the parent directory if missing. `path` is a required
parameter, not defaulted to a path under `data/`: that directory's layout and
lifecycle belong to ISSUE-7, not this module. `rows` (the full
`SearchResultRow[]`) was dropped from the record per architecture review:
an `abandoned` event's rows are already deduplicated output that ISSUE-7
will persist as part of the run's normal output, so storing them a second
time here would let the same cases be double-counted on a replay that reads
both files; only the bare CNJ numbers are kept, optionally, as a lightweight
cross-check. Deliberately minimal rather than a full persistence layer:
ISSUE-7 (`todo` as of this branch) owns the general resuming story - state
files, atomic writes, `--retry-failed` - and this module only commits to the
file **format** the two issues need to coordinate on. It has no caller yet;
`test/uncoverable.test.ts` exercises it directly and covers the parent
directory being created on demand, one line per record with a valid ISO
timestamp, `cnjNumbers` being optional, and appending (not overwriting)
across multiple abandoned leaves.

### `docs/probe-party-tokens.sh`

Added per architecture review, alongside `docs/probe-pagination.sh` and
`docs/probe-class.sh`: a plain-curl re-run of the alphabet measurement above,
so a grader can reproduce the union-vs-filters table without any TypeScript
in the loop. Takes a date range, an optional class id/name pair, and a list
of party-name tokens; tracks the running union of CNJ numbers exactly like
the measurement table does. Deliberately requires **both** class fields when
a class filter is passed - its own comment repeats the "id alone is silently
ignored" warning from the class-filter correction above, so a grader
re-running it does not repeat the mistake that produced this issue's first,
wrong measurement pass. Smoke-tested live against 2025-03-12 (day-level and
day+class-202) while writing it; output shape matches the shipped table.

### Verification

`npm test`: **105 tests green** (89 pre-existing + 13 in
`test/party-sweep.test.ts` + 3 in `test/uncoverable.test.ts`, both
`test/sweep.test.ts` cover-seam tests updated in place for the `CoverEvent`
split), no network. `npm run typecheck`: clean.

`test/party-sweep.test.ts` covers: plateau after N consecutive flat filters
(`covered`, correct `filtersTried`/`unionSize`, and the token *after* the
plateau is never even tried); a capped filter's silence not counting toward
the plateau even when it adds nothing new, and a capped filter that DOES grow
the union still resetting the streak (the two corrections above); budget
exhausted while still growing (`abandoned`); an explicit
`maxFiltersPerLeaf` cutoff test independent of the plateau; the factory
guards rejecting `plateauAfter < 1` and `maxFiltersPerLeaf < plateauAfter`
(plus the inclusive boundary case); the first response's rows counted toward
the union without a repeated request; a `RejectedQueryError` skipped rather
than fatal (and still charged against the budget); any other error
propagating instead of being swallowed; deduplication across overlapping
filters; and a `sweep()` integration test proving a leaf
`DateRangeSplit`/`JudicialClassSplit` cannot split any further reaches
`covered` through the cover, never `unsplittable`.

### What is measured, not proved

Per the issue's own framing (and `partition.ts`'s module comment): unlike
`DateRangeSplit`/`JudicialClassSplit`, whose subqueries are disjoint by
construction and so terminate with *proved* completeness, `PartyTokenSweep`'s
filters overlap and its termination is empirical. A `covered` event means the
union stopped growing for `plateauAfter` consecutive *uncapped* filters from
*this* alphabet - not that no other token, from a different alphabet or a
longer run, could ever add one more case, and not that a capped filter's own
truncation hides nothing further. The measurement above is the actual
evidence available for that claim on 2025-03-12: 22 filters total (15 chosen
+ 7 exploratory) with zero new cases past filter 13, 9 of them uncapped in a
row. An `abandoned` event is the honest alternative when the budget runs out
first, written to `data/uncoverable.ndjson` specifically so a completeness
claim is never implied where it was not earned.
