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
 * it and is the one the alphabet decision rests on. The order below reflects
 * that measurement run (`DE A`/`ER A` were tried at positions 1 and 11); the
 * shipped alphabet's actual order is different - see the note after the
 * table.
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
 * the 30-row cap themselves, so their own silence - had they added nothing -
 * would have been untrustworthy as plateau evidence. In this run both
 * actually happened to add nothing new against the union at the point they
 * ran, but that is incidental to the point being illustrated: a capped
 * filter's rows are still merged into the union either way (they are real,
 * verified cases - see `party-sweep.ts`'s `grew` check, which runs before
 * the capped/uncapped distinction), only its *silence* is excluded from
 * counting as flat-streak evidence, never the union itself.)
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
 * silently incomplete, so its *silence* cannot be trusted as "no new cases",
 * only as "no new cases *among the ones shown*" - though a capped filter
 * that DOES add new cases is still real, positive evidence and is treated as
 * such (see `party-sweep.ts`). `PARTY_TOKEN_ALPHABET` holds the chosen 15
 * tokens, in one place, with this table and reasoning alongside it so
 * `party-sweep.ts` itself does not need to justify the choice.
 *
 * **Shipped order: the two known-capping tokens (`DE A`, `ER A`) moved to the
 * end.** The measurement above shows they carry the least trustworthy
 * individual evidence of the fifteen (their silence, unlike every other
 * token's, cannot count toward a plateau) - so a leaf should spend its
 * cheaper, more informative uncapped tokens first and only reach for the
 * capped ones once those are exhausted, rather than risk finishing early on
 * two low-evidence requests near the front of a short run. This does not
 * change the plateau point measured above (union growth is order-independent
 * for the underlying data; only when a filter with known-untrustworthy
 * silence gets tried is affected), it only improves where a request budget
 * gets spent.
 *
 * Otherwise ordered roughly by expected frequency in Portuguese surnames/
 * given names (per digraph/trigram frequency intuition, not a formal corpus
 * count): "DA", "OS", "NT", "ES", "RA", "AN", "IN", "RI", "DO", "CO", "TE",
 * "AL", "UZ", "DE", "ER", each paired with a second short, common fragment so
 * the "at least two tokens" validation passes.
 */
export const PARTY_TOKEN_ALPHABET: readonly string[] = [
  'DA S',
  'OS S',
  'NT O',
  'ES A',
  'RA S',
  'AN A',
  'IN A',
  'RI A',
  'DO S',
  'CO S',
  'TE S',
  'AL V',
  'UZ A',
  'DE A',
  'ER A',
];
