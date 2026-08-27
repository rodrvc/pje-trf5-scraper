import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { toFormDate, parseClassCatalog } from '../src/pje/search.js';

const CATALOG = readFileSync(
  join(import.meta.dirname, 'fixtures', 'class-catalog.html'),
  'utf8',
);

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

describe('parseClassCatalog', () => {
  it('extracts the full catalog from the real autocomplete response', () => {
    const classes = parseClassCatalog(CATALOG);

    // The site returns every class at once, not just the matching ones.
    expect(classes.length).toBeGreaterThan(100);
  });

  it('pairs each internal id with its name despite the padding cells', () => {
    const classes = parseClassCatalog(CATALOG);
    const agravo = classes.find((c) => c.id === '202');

    expect(agravo?.name).toBe('AGRAVO DE INSTRUMENTO');
  });

  it('preserves Portuguese accents', () => {
    const classes = parseClassCatalog(CATALOG);

    expect(classes.some((c) => c.name.includes('AÇÃO'))).toBe(true);
    expect(classes.every((c) => !c.name.includes('Ã§'))).toBe(true);
  });

  it('every id is numeric, which is what the form expects', () => {
    const classes = parseClassCatalog(CATALOG);

    expect(classes.every((c) => /^\d+$/.test(c.id))).toBe(true);
  });

  it('does not repeat classes', () => {
    const classes = parseClassCatalog(CATALOG);
    const ids = new Set(classes.map((c) => c.id));

    expect(ids.size).toBe(classes.length);
  });

  it('returns an empty list when the response carries no suggestions', () => {
    expect(parseClassCatalog('<html><body>nothing</body></html>')).toEqual([]);
  });
});
