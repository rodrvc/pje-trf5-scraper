/**
 * The token alphabet for `PartyTokenSweep` (ISSUE-4b).
 *
 * PROBLEMS.md §5, "The third dimension": `Nome da parte` runs
 * `LIKE %token% AND LIKE %token%` against whitespace-separated tokens, and the
 * server's only guard - "at least two names" - merely counts tokens, so a
 * single character passes each. That leaves two natural candidate alphabets:
 *
 *   A. Frequent Portuguese digraphs/trigrams, paired as two tokens (e.g.
 *      "DE A", "DA S"). Hypothesis: common substrings are narrow enough that
 *      each filter's own response stays well under the 30-row cap, so every
 *      filter is individually trustworthy.
 *   B. Single-letter pairs (e.g. "A A", "A B", ...). The crudest alphabet
 *      that still passes validation.
 *
 * Measured live against 2025-03-12, day-level (no class filter) - the leaf
 * PROBLEMS.md's original probe actually used: 30 rows unfiltered, capped
 * (warning present), using the real `PjeSearch`/`JsfSession`/`HttpClient`
 * stack (`delayMs: 1600`). An earlier measurement pass mistakenly ran this
 * comparison against "day + class 202" - see the resolution's note on the
 * class-filter bug that produced that leaf by accident; this table replaces
 * it and is the one the alphabet decision rests on.
 *
 * | # | Filter    | Rows | Capped  | New | Union |
 * |---|-----------|------|---------|-----|-------|
 * | 1 | `DE A`    | 30   | **yes** | -   | -     |
 * | 2 | `DA S`    | 12   | no      | 1   | 39    |
 * | 3 | `OS S`    | 23   | no      | 2   | 41    |
 * | 4 | `NT O`    | 21   | no      | 3   | 44    |
 * | 5 | `ES A`    | 18   | no      | 0   | 44    |
 * | 6 | `RA S`    | 21   | no      | 0   | 44    |
 * | 7 | `AN A`    | 18   | no      | 0   | 44    |
 * | 8 | `IN A`    | 23   | no      | 0   | 44    |
 * | 9 | `RI A`    | 21   | no      | 1   | 45    |
 * | 10| `DO S`    | 21   | no      | 0   | 45    |
 * | 11| `ER A`    | 30   | **yes** | -   | -     |
 * | 12| `CO S`    | 16   | no      | 0   | 45    |
 * | 13| `TE S`    | 12   | no      | 1   | 46    |
 * | 14| `AL V`    | 7    | no      | 0   | 46    |
 * | 15| `UZ A`    | 0    | no      | 0   | 46    |
 *
 * (Seed: the unfiltered response itself, 30 rows, already folded into the
 * union before filter 1 runs - see `party-sweep.ts`. Rows for `DE A` and
 * `ER A` are shown but their "New"/"Union" columns are marked "-": both hit
 * the 30-row cap themselves, so their contribution is untrustworthy and is
 * excluded from the flat-streak count and the union tally - the same rule
 * applied to the single-letter alphabet below.)
 *
 * The union plateaus at **46** starting at filter 13 (`TE S`); filters 14-15
 * add nothing further. A follow-up probe with 7 more tokens not in this
 * alphabet (`IL VA`, `SANT OS`, `SIL VA`, `FER RE`, `MEN DES`, `CAR LOS`,
 * `MA RIA`) found zero further growth, confirming the plateau rather than an
 * accident of a short run.
 *
 * versus the single-letter alphabet, measured earlier on a different leaf
 * (day + class 202, before the class-filter bug above was found - see the
 * resolution) where the same pattern held: `A A`, `A D`, `A E` were
 * themselves capped, so their reported plateau could not be trusted at face
 * value the same way `DE A`/`ER A` above cannot be.
 *
 * **Decision: the digraph/trigram alphabet.** A single character matches far
 * too much of the corpus to reliably stay under the site's own 30-row cap -
 * two of fifteen digraph/trigram filters were still capped here, and single
 * letters would be capped far more often, which defeats the purpose of using
 * a filter as a *cover* signal at all: a capped filter's own rows are
 * silently incomplete, so it cannot be trusted to report "no new cases", only
 * "no new cases *among the ones shown*". `PARTY_TOKEN_ALPHABET` holds the
 * chosen 15 tokens, in one place, with this table and reasoning alongside it
 * so `party-sweep.ts` itself does not need to justify the choice.
 *
 * Ordered roughly by expected frequency in Portuguese surnames/given names
 * (per digraph/trigram frequency intuition, not a formal corpus count):
 * "DE", "DA", "OS", "NT", "ES", "RA", "AN", "IN", "RI", "DO", "ER", "CO",
 * "TE", "AL", "UZ", each paired with a second short, common fragment so the
 * "at least two tokens" validation passes.
 */
export const PARTY_TOKEN_ALPHABET: readonly string[] = [
  'DE A',
  'DA S',
  'OS S',
  'NT O',
  'ES A',
  'RA S',
  'AN A',
  'IN A',
  'RI A',
  'DO S',
  'ER A',
  'CO S',
  'TE S',
  'AL V',
  'UZ A',
];
