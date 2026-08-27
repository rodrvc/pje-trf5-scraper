/**
 * Parsing of the judicial class catalog.
 *
 * Lives here rather than next to the search client for the same reason as the
 * result parsers: it is a pure `(html) => T` function, testable without network.
 */

import * as cheerio from 'cheerio';

import type { JudicialClass } from './types.js';

/**
 * Extracts the class catalog from the autocomplete response.
 *
 * Each suggestion arrives as a **four**-cell row, not two: RichFaces interleaves
 * empty padding cells between the content ones.
 *
 *   <td class="rich-sb-cell-padding"></td>  <- padding
 *   <td class="rich-table-cell">283</td>    <- internal id
 *   <td class="rich-sb-cell-padding"></td>  <- padding
 *   <td class="rich-table-cell">AÇÃO PENAL...</td>  <- name
 *
 * Hence dropping the empty cells before reading id and name; taking them by
 * position picks up the padding instead, which is what returned an empty
 * catalog before.
 */
export function parseClassCatalog(html: string): JudicialClass[] {
  // Rows are wrapped in a table before loading: cheerio follows the HTML spec
  // and silently drops <tr> elements that sit outside one, which is how a
  // fragment of an AJAX response can legitimately arrive.
  const $ = cheerio.load(html.includes('<table') ? html : `<table><tbody>${html}</tbody></table>`);
  const classes: JudicialClass[] = [];
  const seen = new Set<string>();

  $('tr').each((_, element) => {
    const cells = $(element)
      .find('td')
      .map((_i, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((text) => text !== '');

    const [id, name] = cells;
    if (id === undefined || name === undefined) return;
    if (!/^\d+$/.test(id) || seen.has(id)) return;

    seen.add(id);
    classes.push({ id, name });
  });

  return classes;
}
