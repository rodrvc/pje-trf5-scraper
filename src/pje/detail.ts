/**
 * Fetching the case detail view.
 *
 * The first GET (`ca=<token>`) returns the header, both parties tables,
 * movements and documents. But each of those four tables paginates
 * independently, and the first page is all the initial GET carries: a case
 * with several pages of parties, movements or documents is incomplete until
 * every pager has been walked.
 *
 * Two different RichFaces widgets do the paging, not one: parties use
 * `Richfaces.Datascroller` (numbered page links); movements and documents use
 * `Richfaces.Slider` (a 1..maxValue drag control) instead. Both are read into
 * the same `Pager` union by `src/domain/parse-detail.ts`, and
 * `buildPagingBody()` below is the one place that turns either variant into
 * the right AJAX POST body - documented for the scroller in `PROBLEMS.md` §6:
 *
 *   AJAXREQUEST=_viewRoot
 *   <baseId>=<baseId>
 *   javax.faces.ViewState=<current>
 *   <pageFieldId>=<page>
 *   ajaxSingle=<pageFieldId>            # datascroller
 *   <eventFieldId>=<eventFieldId>       # slider (a distinct id, not ajaxSingle)
 *   AJAX:EVENTS_COUNT=1
 *
 * `JsfSession` already tracks the detail view's ViewState separately from the
 * search view's; every POST here refreshes it from the response, same as it
 * does for search.
 */

import type { LegalCase } from '../domain/types.js';
import {
  assertTotalMatches,
  classifyDetailPage,
  countTableRows,
  firstRowIndex,
  parseActiveParties,
  parseAllPagers,
  parseCaseHeader,
  parseDocuments,
  parseMovements,
  parsePassiveParties,
  readDeclaredTotal,
  TABLE_ID,
  type Pager,
} from '../domain/parse-detail.js';
import { ParseError, UnexpectedDetailPageError } from '../domain/errors.js';
import type { JsfSession } from './session.js';

/**
 * Hard ceiling on pages walked for a single table.
 *
 * Guards against a bogus pager read (a regex matching the wrong `maxValue`,
 * for instance) turning into a request storm against a real court's server.
 * No real table sampled while building this module came anywhere close: the
 * largest seen was 5 pages (movements, 75 rows).
 */
const MAX_PAGES = 500;

export class PjeDetail {
  constructor(private readonly session: JsfSession) {}

  /**
   * Fetches and fully assembles one case, walking every paginated table.
   *
   * A sealed case returns immediately after the first GET: there is nothing
   * further to page through, and the missing sections are not an error.
   *
   * @param expectedNumber When given (typically the CNJ number already known
   *   from the search row that produced this `ca` token), the extracted
   *   header's own number must match it exactly, or `ParseError` is thrown.
   *   The CNJ number is the dedup/persistence key downstream; silently
   *   returning a case under the wrong number, or with none at all, would
   *   corrupt whatever keys on it without any visible failure.
   * @throws UnexpectedDetailPageError when the page is neither an ordinary
   *   detail view nor positively identified as sealed - a database error page
   *   or a dropped session, for instance. Left to the orchestrator (ISSUE-9)
   *   to decide whether to retry or record as a failure.
   * @throws ParseError when the case number is missing/mismatched, when a
   *   paging POST did not move to the page it asked for, or when a paginated
   *   table's collected row count does not match its own declared total.
   */
  async fetch(ca: string, expectedNumber?: string): Promise<LegalCase> {
    const first = await this.session.open('detail', `?ca=${ca}`);
    const html = first.html;
    const extractedAt = new Date().toISOString();

    const classification = classifyDetailPage(html);

    if (classification.kind === 'sealed') {
      return {
        number: '',
        ca,
        activeParties: [],
        passiveParties: [],
        movements: [],
        documents: [],
        sealed: true,
        extractedAt,
      };
    }

    if (classification.kind === 'unexpected') {
      throw new UnexpectedDetailPageError(
        `Detail page for ca="${ca}" was neither an ordinary case nor a sealed one: ` +
          `${classification.reason}.`,
        classification.reason,
      );
    }

    const header = parseCaseHeader(html);

    // The CNJ number is the deduplication/persistence key everywhere
    // downstream: returning '' or a mismatched value must fail loudly rather
    // than quietly corrupt whatever keys on it.
    if (header.number === undefined || header.number === '') {
      throw new ParseError(
        `Detail page for ca="${ca}" carried no case number: the header markup likely changed.`,
        'missing case number',
      );
    }
    if (expectedNumber !== undefined && header.number !== expectedNumber) {
      throw new ParseError(
        `Detail page for ca="${ca}" reports case number "${header.number}", ` +
          `expected "${expectedNumber}" from the search row that led here.`,
        'case number mismatch',
      );
    }

    const pagers = parseAllPagers(html);

    const activeParties = await this.collectAllPages(
      ca,
      TABLE_ID.activeParties,
      pagers.activeParties,
      html,
      parseActiveParties,
    );
    const passiveParties = await this.collectAllPages(
      ca,
      TABLE_ID.passiveParties,
      pagers.passiveParties,
      html,
      parsePassiveParties,
    );
    const movements = await this.collectAllPages(
      ca,
      TABLE_ID.movements,
      pagers.movements,
      html,
      parseMovements,
    );
    // Cross-checked against the row count (downloadable or not), not
    // parseDocuments().length: the "N resultados encontrados" the page
    // itself declares counts every row, including view-only ones that
    // parseDocuments() already drops for having no download link.
    const documents = await this.collectAllPages(
      ca,
      TABLE_ID.documents,
      pagers.documents,
      html,
      parseDocuments,
      (pageHtml) => countTableRows(pageHtml, TABLE_ID.documents),
    );

    return {
      number: header.number,
      ca,
      ...(header.judicialClass !== undefined ? { judicialClass: header.judicialClass } : {}),
      ...(header.subject !== undefined ? { subject: header.subject } : {}),
      ...(header.filingDate !== undefined ? { filingDate: header.filingDate } : {}),
      ...(header.jurisdiction !== undefined ? { jurisdiction: header.jurisdiction } : {}),
      ...(header.court !== undefined ? { court: header.court } : {}),
      ...(header.address !== undefined ? { address: header.address } : {}),
      ...(header.referenceCase !== undefined ? { referenceCase: header.referenceCase } : {}),
      activeParties,
      passiveParties,
      movements,
      documents,
      sealed: false,
      extractedAt,
    };
  }

  /**
   * Walks every page of one pager, merging the parsed rows, then confirms
   * the accumulated count matches the table's own declared total.
   *
   * Page 1's rows come from the already-fetched `firstPageHtml`, since
   * re-requesting it would waste a request; pages 2..N come from the AJAX
   * paging POST, one at a time, refreshing the ViewState as it goes, and each
   * one is confirmed to have actually advanced (see `assertPageAdvanced`)
   * before its rows are trusted.
   *
   * @param countRows How to count a page's rows for both the page-advanced
   *   check and the declared-total cross-check - defaults to
   *   `parse(html).length`, but documents need the raw row count instead,
   *   since `parse` already drops view-only rows there.
   */
  private async collectAllPages<T>(
    ca: string,
    tableIdSuffix: string,
    pager: Pager | undefined,
    firstPageHtml: string,
    parse: (html: string) => T[],
    countRows: (html: string) => number = (html) => parse(html).length,
  ): Promise<T[]> {
    const declaredTotal = readDeclaredTotal(firstPageHtml, tableIdSuffix);
    const firstPage = parse(firstPageHtml);
    const pageSize = countRows(firstPageHtml);

    if (pager === undefined || pager.pageCount <= 1) {
      assertTotalMatches(tableIdSuffix, declaredTotal, pageSize);
      return firstPage;
    }

    const pageCount = Math.min(pager.pageCount, MAX_PAGES);
    const rows: T[] = [...firstPage];
    let rowCount = pageSize;

    for (let page = 2; page <= pageCount; page++) {
      const pageHtml = await this.fetchPage(ca, pager, page);
      assertPageAdvanced(pageHtml, tableIdSuffix, page, pageSize);
      rows.push(...parse(pageHtml));
      rowCount += countRows(pageHtml);
    }

    assertTotalMatches(tableIdSuffix, declaredTotal, rowCount);
    return rows;
  }

  /** Sends the paging POST for one page of one pager. */
  private async fetchPage(ca: string, pager: Pager, page: number): Promise<string> {
    const body = buildPagingBody(pager, page);
    const response = await this.session.post('detail', body, { query: `?ca=${ca}` });
    return response.html;
  }
}

/**
 * Builds the AJAX POST body for one page of one pager, whichever widget it
 * is.
 *
 * Both variants set the same three envelope fields (`AJAXREQUEST`,
 * `<baseId>=<baseId>`, `AJAX:EVENTS_COUNT`); they differ in how the target
 * page itself is named:
 *
 * - **Datascroller**: `<pageFieldId>=<page>` and `ajaxSingle=<pageFieldId>`
 *   (the scroller field doubles as the ajax-single target).
 * - **Slider**: `<pageFieldId>=<page>` (the slider's own id, whose value is
 *   read as the current page) *and* `<eventFieldId>=<eventFieldId>` (a
 *   distinct, self-referential id the real `onchange` names - not the page
 *   number, unlike the datascroller's `ajaxSingle`).
 */
export function buildPagingBody(pager: Pager, page: number): URLSearchParams {
  const body = new URLSearchParams();
  body.set('AJAXREQUEST', '_viewRoot');
  body.set(pager.baseId, pager.baseId);
  body.set(pager.pageFieldId, String(page));

  if (pager.kind === 'datascroller') {
    body.set('ajaxSingle', pager.pageFieldId);
  } else {
    body.set(pager.eventFieldId, pager.eventFieldId);
  }

  body.set('AJAX:EVENTS_COUNT', '1');
  return body;
}

/**
 * Throws `ParseError` unless a paging response actually moved to the
 * requested page.
 *
 * If the server ignores the page parameter (a stale ViewState, a wrong field
 * id after a redeploy) it can return page 1 again with a 200 status and no
 * error of its own - `PjeDetail` would otherwise concatenate that unchanged
 * first page onto the result a second time, producing silent duplicates.
 * Every row's id embeds its absolute position in the whole table
 * (`processoPartesPoloPassivoResumidoList:10:` on page 2 of a 12-row table,
 * not `:0:`), so the first row index the response actually returned is
 * checked against `(page - 1) * pageSize`, the index the requested page
 * should start at. `pageSize` is inferred from how many rows page 1 held,
 * since page 1 is the only page whose absolute start (0) is known for sure.
 *
 * Silently accepts a page with no rows to read an index from (an emptied-out
 * last page, for instance): there is nothing to contradict in that case.
 */
function assertPageAdvanced(
  html: string,
  tableIdSuffix: string,
  page: number,
  pageSize: number,
): void {
  const firstIndex = firstRowIndex(html, tableIdSuffix);
  if (firstIndex === undefined) return;

  const expectedIndex = (page - 1) * pageSize;
  if (firstIndex !== expectedIndex) {
    throw new ParseError(
      `Table "${tableIdSuffix}" page ${page} started at row index ${firstIndex}, ` +
        `expected ${expectedIndex}: the paging POST likely did not move the server past page 1 ` +
        '(stale ViewState or a wrong field id), which would otherwise silently duplicate rows.',
      tableIdSuffix,
    );
  }
}
