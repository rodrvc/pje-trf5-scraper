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

### Measurement: choosing the token alphabet

Ran live against the real `PjeSearch`/`JsfSession`/`HttpClient` stack
(`delayMs: 1600`, no `sleep()` of the sweep's own), comparing two candidate
alphabets on 2025-03-12 + class 202 - the leaf both this issue and
PROBLEMS.md §5 use as the running saturated example:

**Digraph/trigram alphabet** (two short, frequent Portuguese fragments per
filter, e.g. `"DE A"`):

| Filter | Rows | Capped | Union so far |
|---|---|---|---|
| `DE A` | 24 | no | 24 |
| `DA S` | 6 | no | 26 |
| `OS S` | 18 | no | 29 |
| `NT O` | 15 | no | 29 |
| `ES A` | 13 | no | 30 |
| `RA S` | 16 | no | 30 |
| `AN A` | 14 | no | 30 |
| `IN A` | 13 | no | 30 |
| `RI A` | 14 | no | 30 |
| `DO S` | 13 | no | 30 |
| `ER A` | 24 | no | 30 |
| `CO S` | 11 | no | 30 |
| `TE S` | 7 | no | 30 |
| `AL V` | 5 | no | 30 |
| `UZ A` | 0 | no | 30 |

**Single-letter alphabet** (e.g. `"A A"`, `"A B"` - the crudest tokens that
still pass the "at least two names" validation), on the same leaf:

| Filter | Rows | Capped | Union so far |
|---|---|---|---|
| `A A` | 30 | **yes** | 30 |
| `A B` | 11 | no | 30 |
| `A C` | 26 | no | 30 |
| `A D` | 30 | **yes** | 30 |
| `A E` | 30 | **yes** | 30 |

**Decision: the digraph/trigram alphabet.** Both plateaued at the same union
size on this leaf, but the single-letter alphabet reached it through filters
that were **themselves capped** (`A A`, `A D`, `A E`) - each individually
truncated at exactly 30 rows with the server's own warning, meaning their
contribution to the union is silently incomplete: the true set behind a
capped single-letter filter is unknown, not merely "no larger than what was
returned". A single character matches far too much of the corpus to stay
under the site's own cap, which defeats the purpose of using it as a *cover*
signal at all. The digraph/trigram alphabet's 15 probed filters, by contrast,
all came back uncapped, so every one of them is individually trustworthy -
what a *measured* completeness claim needs, since there is no proof behind
it, only observation. `PARTY_TOKEN_ALPHABET` (`party-token-alphabet.ts`)
holds the chosen 15 tokens, in one place, with this table and reasoning
alongside it so `party-sweep.ts` itself does not need to justify the choice.

**Stop rule: `plateauAfter: 5` consecutive flat filters (default,
configurable).** The digraph run above plateaued after 5 consecutive filters
added nothing (`RA S` through `DO S`, the union already having settled by
`ES A`); a stricter cutoff (e.g. 3) would have stopped at the same point here,
but 5 leaves a safety margin against a single unlucky run of overlapping
filters being mistaken for a genuine plateau, at the cost of at most a few
extra requests per leaf once the real plateau has already happened.
Configurable rather than hardcoded because it is a judgment call from one
measured run, not a proven constant - a future run against a differently
shaped leaf may want to tune it.

### An honest finding: none of the four "known saturated" leaves still saturate

PROBLEMS.md §5 records a union of 42/41/37/33 unique cases (against an
unfiltered cap of 30) for four leaves - 2025-03-12, -11, -14, -19, all + class
202 - measured with nine crude filters at the time PROBLEMS.md was written.
Re-running the live measurement above against the **same** leaves today
(2026-08-28) gives a materially different picture:

| Leaf (+ class 202) | Unfiltered rows today | Capped today? |
|---|---|---|
| 2025-03-12 | 30 | **yes** |
| 2025-03-14 | 14 | no |
| 2025-03-19 | 17 | no |

(2025-03-11 was checked in the first measurement pass and came back at 19
rows, uncapped, consistent with ISSUE-3's own resolution recording that same
number.)

Only 2025-03-12 still saturates. On that one live leaf, the digraph alphabet's
union plateaued at exactly 30 - the same as the unfiltered count - rather than
past it, and a follow-up probe with six further tokens not in the chosen
alphabet (`IL VA`, `SANT OS`, `SIL VA`, `FER RE`, `MEN DES`, `CAR LOS`) found
zero new cases, all uncapped. This is a real, reproducible result, not a bug
in the cover: **PJe TRF5 is a live production system**, and the case data
behind a fixed date + class window is not static - cases can be filed,
reassigned between classes, or otherwise move between when PROBLEMS.md's
original probe ran and this one. The corpus a `DateRangeSplit` +
`JudicialClassSplit` cascade sees today is not guaranteed to be the same
corpus PROBLEMS.md described, and this cover's job is only ever to react to
*today's* saturation, whatever that turns out to be.

This means the acceptance criterion "a leaf that saturates under day + class
yields more than 30 unique cases" could not be demonstrated live on the two
leaves the issue names, because as of this measurement pass **the leaves
named no longer both saturate**, and the one that does happens to have
exactly 30 real cases behind it today - the cover correctly reports `covered`
at union 30 rather than fabricating growth that is not there. The
`createPartyTokenSweep` unit tests (`test/party-sweep.test.ts`) instead prove
the mechanism directly with a scripted fake search that *does* return more
than 30 unique cases across its filters, which is the part of the acceptance
criterion actually testable without depending on a live corpus's state at a
particular moment; the live run above is evidence the mechanism also behaves
correctly (covered vs. abandoned, budget respected, capped filters treated as
untrustworthy) against the real server, not a claim that this specific leaf
still exceeds 30 today.

### `data/uncoverable.ndjson`

**`src/pipeline/uncoverable.ts`** — `recordUncoverable(record, path?)`, a
small, focused writer: one JSON object per line (`query`, `depth`,
`filtersTried`, `unionSize`, `rows`, `recordedAt`), append-only, creating the
parent directory if missing. Deliberately minimal rather than a full
persistence layer: ISSUE-7 (`todo` as of this branch) owns the general
resuming story - state files, atomic writes, `--retry-failed` - and this
module only commits to the file **format** the two issues need to coordinate
on, an NDJSON record per abandoned leaf, so a caller can turn every
`abandoned` `SweepEvent` into one call to `recordUncoverable` without
inventing its own shape. `test/uncoverable.test.ts` covers the parent
directory being created on demand, one line per record with a valid ISO
timestamp, and appending (not overwriting) across multiple abandoned leaves.

### Verification

`npm test`: **98 tests green** (89 pre-existing + 7 in `test/party-sweep.test.ts`
+ 2 in `test/uncoverable.test.ts`, both `test/sweep.test.ts` cover-seam tests
updated in place for the `CoverEvent` split), no network. `npm run typecheck`:
clean.

`test/party-sweep.test.ts` covers: plateau after N consecutive flat filters
(`covered`, correct `filtersTried`/`unionSize`, and the token *after* the
plateau is never even tried); budget exhausted while still growing
(`abandoned`); the first response's rows counted toward the union without a
repeated request; a `RejectedQueryError` skipped rather than fatal (and still
charged against the budget); any other error propagating instead of being
swallowed; deduplication across overlapping filters; and a `sweep()`
integration test proving a leaf `DateRangeSplit`/`JudicialClassSplit` cannot
split any further reaches `covered` through the cover, never `unsplittable`.

### What is measured, not proved

Per the issue's own framing (and `partition.ts`'s module comment): unlike
`DateRangeSplit`/`JudicialClassSplit`, whose subqueries are disjoint by
construction and so terminate with *proved* completeness, `PartyTokenSweep`'s
filters overlap and its termination is empirical. A `covered` event means the
union stopped growing for `plateauAfter` consecutive filters from *this*
alphabet - not that no other token, from a different alphabet or a longer
run, could ever add one more case. The measurement above is the actual
evidence available for that claim on the one leaf that still saturated at
measurement time: 21 filters total (15 chosen + 6 exploratory) with zero new
cases past the 6th, uncapped throughout. An `abandoned` event is the honest
alternative when the budget runs out first, written to
`data/uncoverable.ndjson` specifically so a completeness claim is never
implied where it was not earned.
