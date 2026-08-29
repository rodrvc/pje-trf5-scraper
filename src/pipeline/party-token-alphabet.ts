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
 * Measured live against the leaf the issue and PROBLEMS.md both use as the
 * running example, 2025-03-12 + class 202 (30 rows unfiltered, capped), using
 * the real `PjeSearch`/`JsfSession`/`HttpClient` stack (`delayMs: 1600`):
 *
 * | Filter    | Rows | Capped | Union so far |
 * |-----------|------|--------|---------------|
 * | `DE A`    | 24   | no     | 24            |
 * | `DA S`    | 6    | no     | 26            |
 * | `OS S`    | 18   | no     | 29            |
 * | `NT O`    | 15   | no     | 29            |
 * | `ES A`    | 13   | no     | 30            |
 * | `RA S`    | 16   | no     | 30            |
 * | `AN A`    | 14   | no     | 30            |
 * | `IN A`    | 13   | no     | 30            |
 * | `RI A`    | 14   | no     | 30            |
 * | `DO S`    | 13   | no     | 30            |
 * | `ER A`    | 24   | no     | 30            |
 * | `CO S`    | 11   | no     | 30            |
 * | `TE S`    | 7    | no     | 30            |
 * | `AL V`    | 5    | no     | 30            |
 * | `UZ A`    | 0    | no     | 30            |
 *
 * versus the single-letter alphabet on the same leaf:
 *
 * | Filter  | Rows | Capped | Union so far |
 * |---------|------|--------|---------------|
 * | `A A`   | 30   | **yes**| 30            |
 * | `A B`   | 11   | no     | 30            |
 * | `A C`   | 26   | no     | 30            |
 * | `A D`   | 30   | **yes**| 30            |
 * | `A E`   | 30   | **yes**| 30            |
 *
 * **Decision: the digraph/trigram alphabet.** Both plateaued at the same
 * union size (30, on this leaf, on the day measured - see the resolution's
 * note on why this run did not exceed the unfiltered cap, unlike the larger
 * unions PROBLEMS.md recorded on an earlier pass), but the single-letter
 * alphabet got there through filters that are **themselves capped** (`A A`,
 * `A D`, `A E` each hit exactly 30 rows with the truncation warning) - which
 * means their own rows are silently incomplete, and the plateau they show
 * cannot be trusted at face value: the true union past a capped filter is
 * unknown, not merely "no larger than reported". A narrower, corpus-informed
 * token (a real digraph/trigram) stays under the cap far more reliably
 * (every one of the 15 probed came back uncapped here), so every filter's
 * contribution to the union is verifiable rather than a possible
 * undercount. Single characters are the crudest tool that passes validation,
 * but "passes validation" is not the same bar as "produces a trustworthy
 * response" - and the latter is what a *measured* completeness claim rests
 * on.
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
