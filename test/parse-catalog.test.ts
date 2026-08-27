/**
 * Judicial class catalog parsing.
 *
 * Inline HTML shows the shape being parsed; the captured fixture pins the real
 * response. Note the fixture cannot detect that the live site changed — it is a
 * frozen copy — only that this parser changed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseClassCatalog } from '../src/domain/parse-catalog.js';

const CATALOG = readFileSync(
  join(import.meta.dirname, 'fixtures', 'class-catalog.html'),
  'utf8',
);

/**
 * One autocomplete suggestion, shaped like RichFaces emits it.
 *
 * The catch: four cells, not two. Empty padding cells sit between the id and
 * the name, so reading them positionally picks up the padding instead.
 */
function suggestion(id: string, name: string): string {
  return `
    <tr class="rich-sb-int">
      <td class="rich-sb-cell-padding"></td>
      <td class="rich-table-cell">${id}</td>
      <td class="rich-sb-cell-padding"></td>
      <td class="rich-table-cell">${name}</td>
    </tr>`;
}

describe('parseClassCatalog', () => {
  it('pairs each id with its name, skipping the padding cells', () => {
    const html = suggestion('202', 'AGRAVO DE INSTRUMENTO') + suggestion('63', 'AÇÃO CIVIL COLETIVA');

    expect(parseClassCatalog(html)).toEqual([
      { id: '202', name: 'AGRAVO DE INSTRUMENTO' },
      { id: '63', name: 'AÇÃO CIVIL COLETIVA' },
    ]);
  });

  it('ignores rows whose first cell is not a numeric id', () => {
    const header = '<tr><td>Código</td><td>Descrição</td></tr>';

    expect(parseClassCatalog(header)).toEqual([]);
  });

  it('keeps the first occurrence when an id repeats', () => {
    const html = suggestion('202', 'AGRAVO DE INSTRUMENTO') + suggestion('202', 'DUPLICATE');

    expect(parseClassCatalog(html)).toEqual([{ id: '202', name: 'AGRAVO DE INSTRUMENTO' }]);
  });

  it('returns an empty list when the response carries no suggestions', () => {
    expect(parseClassCatalog('<html><body>nothing</body></html>')).toEqual([]);
  });

  it('reads the real catalog PJe returns', () => {
    const classes = parseClassCatalog(CATALOG);

    // The autocomplete returns every class at once, not just matching ones.
    expect(classes.length).toBeGreaterThan(100);
    expect(classes.find((c) => c.id === '202')?.name).toBe('AGRAVO DE INSTRUMENTO');
    // Accents must survive the UTF-8 AJAX response.
    expect(classes.some((c) => c.name.includes('AÇÃO'))).toBe(true);
  });
});
