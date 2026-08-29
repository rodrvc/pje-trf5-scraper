/**
 * The party-token cover: reaches the cases that day + judicial class alone
 * cannot show (ISSUE-4b, PROBLEMS.md §5 "The third dimension").
 *
 * `Nome da parte` is a `LIKE %token% AND LIKE %token%` substring match, order
 * independent and matching mid-word, guarded only by an "at least two names"
 * validation that merely counts whitespace-separated tokens - single
 * characters pass. Because the filter reaches cases the unfiltered query
 * cannot show, unioning several filters' results over a saturated leaf yields
 * more than the 30-row cap.
 *
 * This is a **cover**, not a partition: the subsets a filter carves out
 * overlap (the same case can match several tokens), so there is no proof the
 * union is complete once every filter has run - only a measured plateau.
 * That is why it implements `CoverFn` (`sweep.ts`) rather than
 * `PartitionStrategy` (`partition.ts`) - see both modules' comments for the
 * fuller rationale, settled during ISSUE-4's architecture review.
 */

import { RejectedQueryError } from '../domain/errors.js';
import type { Query, SearchResponse, SearchResultRow } from '../domain/types.js';
import type { CoverEvent, CoverFn, SearchFn } from './sweep.js';
import { PARTY_TOKEN_ALPHABET } from './party-token-alphabet.js';

export interface PartyTokenSweepOptions {
  /**
   * Token alphabet to iterate, in order. Defaults to the measured choice in
   * `party-token-alphabet.ts`; overridable for tests and for tuning without
   * touching this module.
   */
  alphabet?: readonly string[];
  /**
   * Stop after this many consecutive filters that added no new case to the
   * union. Default 5: the measured runs (see the alphabet module's doc
   * comment) plateaued within 4-5 filters once the union stopped growing, so
   * 5 flat filters in a row is strong evidence the remaining alphabet would
   * not add anything either, while staying small enough not to waste
   * requests chasing a plateau that already happened. Configurable because
   * this is a judgment call tuned on a small sample, not a proven constant.
   */
  plateauAfter?: number;
  /**
   * Maximum number of filters to try on one leaf, counting the first
   * (unfiltered) response already supplied by the walk. Guards a leaf that
   * keeps growing slowly from consuming the alphabet unboundedly against a
   * live server. Default matches the alphabet's own length, i.e. "try the
   * whole alphabet at most once".
   */
  maxFiltersPerLeaf?: number;
}

const DEFAULT_PLATEAU_AFTER = 5;

/**
 * Builds a `CoverFn` backed by the party-name substring filter.
 *
 * Returned as a factory (rather than a class instantiated per leaf) because
 * the sweep only ever needs one `CoverFn` value, configured once, reused
 * across every leaf it is invoked on - the per-leaf state (the union map,
 * the plateau counter) lives inside the generator's own closure per
 * invocation, not on `this`.
 */
export function createPartyTokenSweep(options: PartyTokenSweepOptions = {}): CoverFn {
  const alphabet = options.alphabet ?? PARTY_TOKEN_ALPHABET;
  const plateauAfter = options.plateauAfter ?? DEFAULT_PLATEAU_AFTER;
  const maxFiltersPerLeaf = options.maxFiltersPerLeaf ?? alphabet.length;

  return async function* partyTokenSweep(
    leaf: Query,
    first: SearchResponse,
    search: SearchFn,
  ): AsyncGenerator<CoverEvent> {
    // The union is keyed by CNJ number so a case matched by several filters
    // (the filters overlap by design) is only counted once. Seeded with the
    // leaf's own first response - it is already fetched, so re-running it
    // here would waste a request for no new information.
    const union = new Map<string, SearchResultRow>();
    for (const row of first.rows) union.set(row.number, row);

    let filtersTried = 0;
    let flatStreak = 0;

    for (const token of alphabet) {
      if (filtersTried >= maxFiltersPerLeaf) break;

      let response;
      try {
        response = await search({ ...leaf, partyName: token });
      } catch (error) {
        // A token the server's "two names" validation rejects (or any other
        // RejectedQueryError) is not fatal to the leaf: it simply carried no
        // information, so it is recorded and skipped rather than aborting
        // the whole cover. Anything else propagates - a network failure or
        // rate limit is the runner's problem (ISSUE-7), not this cover's.
        if (error instanceof RejectedQueryError) {
          filtersTried += 1;
          continue;
        }
        throw error;
      }

      filtersTried += 1;
      const sizeBefore = union.size;
      for (const row of response.rows) union.set(row.number, row);
      const grew = union.size > sizeBefore;

      // A filter that is itself capped is untrustworthy as a "no new cases"
      // signal: its own rows are truncated at the site's 30-row limit, so it
      // may be hiding cases beyond what it reported, whether or not it added
      // anything to the union this time. Its rows still get folded into the
      // union above (they are still real, verified cases), but it must not
      // count toward - or reset - the flat streak either way, the same
      // distrust already applied when comparing alphabets (see
      // party-token-alphabet.ts): only an uncapped filter's silence is
      // evidence the plateau is real.
      if (!response.capped) {
        flatStreak = grew ? 0 : flatStreak + 1;
      }

      if (flatStreak >= plateauAfter) {
        yield {
          type: 'covered',
          rows: [...union.values()],
          filtersTried,
          unionSize: union.size,
          plateaued: true,
        };
        return;
      }
    }

    // The alphabet (or the per-leaf budget) ran out before `plateauAfter`
    // consecutive flat filters were observed: the union may still have grown
    // on the very last filter tried, so this leaf is known-incomplete, not
    // covered. It must never be reported as complete.
    yield {
      type: 'abandoned',
      rows: [...union.values()],
      filtersTried,
      unionSize: union.size,
    };
  };
}
