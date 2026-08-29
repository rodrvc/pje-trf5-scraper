import { describe, expect, it } from 'vitest';

import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../src/pipeline/partition.js';
import type { JudicialClass, Query } from '../src/domain/types.js';

describe('DateRangeSplit', () => {
  const strategy = new DateRangeSplit();

  it('is not splittable when the range is a single day', () => {
    expect(strategy.canSplit({ from: '2025-03-11', to: '2025-03-11' })).toBe(false);
  });

  it('splits a two-day range into two single days, later day first', () => {
    const query: Query = { from: '2025-03-11', to: '2025-03-12' };
    expect(strategy.canSplit(query)).toBe(true);
    expect(strategy.split(query)).toEqual([
      { from: '2025-03-12', to: '2025-03-12' },
      { from: '2025-03-11', to: '2025-03-11' },
    ]);
  });

  it('halves an odd-length range giving the extra day to the earlier half, later half first', () => {
    // 2025-03-01..2025-03-05 is 5 days: mid should split 3/2, never an empty half.
    const query: Query = { from: '2025-03-01', to: '2025-03-05' };
    const [later, earlier] = strategy.split(query);
    expect(later).toEqual({ from: '2025-03-04', to: '2025-03-05' });
    expect(earlier).toEqual({ from: '2025-03-01', to: '2025-03-03' });
  });

  it('crosses a month boundary correctly, later half first', () => {
    const query: Query = { from: '2025-02-27', to: '2025-03-02' };
    const [later, earlier] = strategy.split(query);
    // 4 days total (27, 28, 01, 02): earlier half gets the extra day.
    expect(later).toEqual({ from: '2025-03-01', to: '2025-03-02' });
    expect(earlier).toEqual({ from: '2025-02-27', to: '2025-02-28' });
  });

  it('handles the leap day correctly (2024 is a leap year), later half first', () => {
    const query: Query = { from: '2024-02-28', to: '2024-03-01' };
    const [later, earlier] = strategy.split(query);
    // 3 days total (28, 29, 01): earlier half gets the extra day.
    expect(later).toEqual({ from: '2024-03-01', to: '2024-03-01' });
    expect(earlier).toEqual({ from: '2024-02-28', to: '2024-02-29' });
  });

  it('does not treat 2025 (non-leap) as having a Feb 29', () => {
    // A range spanning what would be Feb 29 in a leap year, in a non-leap one:
    // Feb 28 -> Mar 1 is a 2-day range, not 3.
    const query: Query = { from: '2025-02-28', to: '2025-03-01' };
    expect(strategy.split(query)).toEqual([
      { from: '2025-03-01', to: '2025-03-01' },
      { from: '2025-02-28', to: '2025-02-28' },
    ]);
  });

  it('preserves other query fields across the split', () => {
    const query: Query = {
      from: '2025-03-11',
      to: '2025-03-12',
      judicialClassId: '202',
      judicialClassName: 'Agravo de Instrumento',
    };
    for (const subquery of strategy.split(query)) {
      expect(subquery.judicialClassId).toBe('202');
      expect(subquery.judicialClassName).toBe('Agravo de Instrumento');
    }
  });

  it('throws rather than silently no-op when asked to split an unsplittable range', () => {
    expect(() => strategy.split({ from: '2025-03-11', to: '2025-03-11' })).toThrow(RangeError);
  });
});

describe('JudicialClassSplit', () => {
  const catalog: JudicialClass[] = [
    { id: '202', name: 'Agravo de Instrumento' },
    { id: '283', name: 'Apelação Cível' },
  ];
  const strategy = new JudicialClassSplit(catalog);

  it('refuses to be built with an empty catalog', () => {
    // An empty catalog would let canSplit() keep saying "yes" for any single
    // day with no class set, while split() produced zero subqueries - the
    // walk would then emit the capped event and nothing else, silently
    // dropping the whole leaf. Failing at construction surfaces this where an
    // operator is watching (the catalog fetch, before any sweep starts).
    expect(() => new JudicialClassSplit([])).toThrow(RangeError);
  });

  it('is applicable only to a single day with no class set yet', () => {
    expect(strategy.canSplit({ from: '2025-03-11', to: '2025-03-11' })).toBe(true);
  });

  it('is not applicable to a multi-day range, even without a class', () => {
    expect(strategy.canSplit({ from: '2025-03-11', to: '2025-03-12' })).toBe(false);
  });

  it('is not applicable once a class is already set', () => {
    expect(
      strategy.canSplit({ from: '2025-03-11', to: '2025-03-11', judicialClassId: '202' }),
    ).toBe(false);
  });

  it('produces one subquery per class in the catalog', () => {
    const query: Query = { from: '2025-03-11', to: '2025-03-11' };
    expect(strategy.split(query)).toEqual([
      { from: '2025-03-11', to: '2025-03-11', judicialClassId: '202', judicialClassName: 'Agravo de Instrumento' },
      { from: '2025-03-11', to: '2025-03-11', judicialClassId: '283', judicialClassName: 'Apelação Cível' },
    ]);
  });

  it('throws rather than silently no-op when called on a query it cannot split', () => {
    expect(() =>
      strategy.split({ from: '2025-03-11', to: '2025-03-11', judicialClassId: '202' }),
    ).toThrow(RangeError);
  });
});

describe('PartitionChain', () => {
  const catalog: JudicialClass[] = [{ id: '202', name: 'Agravo de Instrumento' }];

  it('picks the first strategy able to split the query', () => {
    const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);

    expect(chain.applicable({ from: '2025-03-11', to: '2025-03-12' })?.name).toBe('date-range');
    expect(chain.applicable({ from: '2025-03-11', to: '2025-03-11' })?.name).toBe('judicial-class');
  });

  it('returns undefined when no link in the chain can split further', () => {
    const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);
    // Single day, class already set: date is exhausted and class was already applied.
    expect(
      chain.applicable({ from: '2025-03-11', to: '2025-03-11', judicialClassId: '202' }),
    ).toBeUndefined();
  });

  it('picks a later link when the earlier ones are exhausted', () => {
    // Not a claim that any arbitrary strategy can join this chain (see
    // partition.ts's module comment: PartitionChain is closed over
    // PartitionStrategy, a provable partition - ISSUE-4b's PartyTokenSweep is
    // deliberately NOT one of these and plugs into sweep.ts's separate `cover`
    // seam instead). This only checks that PartitionChain itself has no
    // hardcoded notion of "two links": a third PartitionStrategy-shaped link
    // is picked up like any other once the earlier links stop applying.
    const laterLink = {
      name: 'later-link',
      canSplit: (q: Query) => q.judicialClassId !== undefined,
      split: (q: Query) => [q],
    };
    const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog), laterLink]);

    expect(
      chain.applicable({ from: '2025-03-11', to: '2025-03-11', judicialClassId: '202' })?.name,
    ).toBe('later-link');
  });
});
