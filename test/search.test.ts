import { describe, expect, it } from 'vitest';

import { toFormDate } from '../src/pje/search.js';

describe('toFormDate', () => {
  it('converts ISO to the dd/MM/yyyy the form expects', () => {
    expect(toFormDate('2025-03-11')).toBe('11/03/2025');
    expect(toFormDate('2026-12-01')).toBe('01/12/2026');
  });

  it('rejects a malformed date instead of building an invalid query', () => {
    expect(() => toFormDate('11/03/2025')).toThrow(RangeError);
    expect(() => toFormDate('')).toThrow(RangeError);
  });
});
