/**
 * Parsing of the search results table.
 *
 * Every function here is pure: it takes HTML and returns data. That allows
 * testing them against stored fixtures, with no network involved.
 */

import * as cheerio from 'cheerio';

import type { SearchResponse, SearchResultRow } from './types.js';
import { CAP_WARNING, RESULT_CAP } from '../pje/constants.js';

/** Unique CNJ number: 0000462-42.2023.8.17.3480 */
const RE_CNJ_NUMBER = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

/** Detail access token, found inside the row's onclick handler. */
const RE_CA_TOKEN = /listView\.seam\?ca=([a-f0-9]+)/i;

/** Normalizes the irregular whitespace the markup leaves behind. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts the message the server shows when it rejects a query.
 *
 * PJe validates server-side and reports in a separate panel rather than as an
 * HTTP error: searching by party name with a single term returns "É necessário
 * informar ao menos dois nomes". Without reading this panel, the scraper would
 * conclude "no results" for a query that never ran.
 */
export function extractRejectionMessage(html: string): string | undefined {
  const $ = cheerio.load(html);

  for (const element of $('dl.rich-messages, span.rich-messages-label').toArray()) {
    const text = squash($(element).text());
    if (text !== '') return text;
  }

  return undefined;
}

/**
 * Detects that the query hit the cap and results are being withheld.
 *
 * Two signals are checked independently. The textual warning is the primary
 * source, but rows are counted too: if the site ever truncated without warning,
 * trusting the text alone would open a silent coverage gap — exactly what the
 * partitioning is meant to prevent.
 */
export function isCapped(html: string, rowCount: number): boolean {
  return html.includes(CAP_WARNING) || rowCount >= RESULT_CAP;
}

/**
 * Breaks apart the cell that packs class, number, subject and parties together.
 *
 * In the markup those are not on separate lines nor in elements with their own
 * class: the inner `<b>` holds "abbreviation + number - subject", and the rest
 * sits as loose text around it:
 *
 *   APELAÇÃO CÍVEL <b>ApCiv 0000462-42.2023.8.17.3480 - Juros</b> DOE X BANK
 *   └── before the <b>: class    └── inside the <b>          └── after: parties
 *
 * Hence parsing by position relative to the `<b>` rather than splitting plain
 * text: cheerio's `.text()` collapses everything onto a single line with no
 * separators.
 */
function parseCaseCell(cell: cheerio.Cheerio<never>): {
  number?: string;
  judicialClass?: string;
  subject?: string;
  parties?: string;
} {
  const result: {
    number?: string;
    judicialClass?: string;
    subject?: string;
    parties?: string;
  } = {};

  const bold = cell.find('b').first();
  const boldText = squash(bold.text());
  const fullText = squash(cell.text());

  const match = RE_CNJ_NUMBER.exec(boldText || fullText);
  if (match === null) return result;

  result.number = match[0];

  // The subject follows the number inside the same <b>, after " - ".
  const afterNumber = (boldText || fullText)
    .slice((match.index ?? 0) + match[0].length)
    .trim();
  const subject = afterNumber.replace(/^-\s*/, '').trim();
  if (subject !== '') result.subject = subject;

  if (boldText !== '') {
    // The judicial class is whatever precedes the <b> in the cell.
    const boldStart = fullText.indexOf(boldText);
    if (boldStart > 0) {
      const judicialClass = fullText.slice(0, boldStart).trim();
      if (judicialClass !== '') result.judicialClass = judicialClass;
    }

    // The parties are whatever follows the <b>.
    const boldEnd = boldStart + boldText.length;
    if (boldStart >= 0 && boldEnd < fullText.length) {
      const parties = fullText.slice(boldEnd).trim();
      if (parties !== '') result.parties = parties;
    }
  }

  return result;
}

/**
 * Extracts the rows of the results table.
 *
 * A row without a CNJ number or a detail token is dropped: without those two the
 * case can neither be identified nor opened, so it carries nothing useful.
 */
export function parseResultRows(html: string): SearchResultRow[] {
  const $ = cheerio.load(html);
  const rows: SearchResultRow[] = [];

  $('table[id$="processosTable"] tbody tr').each((_, element) => {
    const $row = $(element);

    // The token lives in the onclick handler, not in an href.
    const onclickAttrs = $row
      .find('a[onclick]')
      .map((_i, a) => $(a).attr('onclick') ?? '')
      .get()
      .join(' ');

    const ca = RE_CA_TOKEN.exec(onclickAttrs)?.[1];
    if (ca === undefined) return;

    const cells = $row.find('td');
    // The middle cell packs class, number, subject and parties.
    const parsed = parseCaseCell(cells.eq(1) as cheerio.Cheerio<never>);

    if (parsed.number === undefined) return;

    const lastMovement = squash(cells.eq(2).text());

    rows.push({
      number: parsed.number,
      ca,
      ...(parsed.judicialClass !== undefined ? { judicialClass: parsed.judicialClass } : {}),
      ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
      ...(parsed.parties !== undefined ? { parties: parsed.parties } : {}),
      ...(lastMovement !== '' ? { lastMovement } : {}),
    });
  });

  return rows;
}

/** Interprets a complete search response. */
export function parseSearchResponse(html: string): SearchResponse {
  const rejectionMessage = extractRejectionMessage(html);
  const rows = parseResultRows(html);

  return {
    rows,
    capped: isCapped(html, rows.length),
    ...(rejectionMessage !== undefined ? { rejectionMessage } : {}),
  };
}
