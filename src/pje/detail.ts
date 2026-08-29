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
 * the same `Pager` union by `src/domain/parse-detail.ts`.
 *
 * **Both widgets submit the entire outer form, not a small sub-form of their
 * own** - confirmed live, documented in `PROBLEMS.md` §6. PJe's markup nests
 * `<form>` elements (each pager's own controls sit inside a `<form>` that is
 * itself inside the page's main `j_id146` form); HTML forbids nested forms,
 * so a real browser silently drops the inner `<form>` tags and every "nested"
 * field ends up belonging to the outer form. `buildPagingBody()` therefore
 * builds the paging POST from `parseOuterFormFields()` (page 1's full set of
 * submittable fields, ~75 of them), with the pager's own page-value field
 * overridden and one small addition per widget - not from the six or so
 * fields the pager's own markup mentions, which the server silently accepts
 * but renders nothing for.
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
  parseOuterFormFields,
  parsePassiveParties,
  readDeclaredTotal,
  readSliderValue,
  TABLE_ID,
  type FormField,
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
    // Read once, from page 1: every subsequent paging POST for this case
    // reuses this same field set (only the pager's own page-value field
    // changes), since all of it is inert hidden state, not per-page data.
    const formId = outerFormId(pagers);
    const formFields = formId !== undefined ? parseOuterFormFields(html, formId) : [];

    const activeParties = await this.collectAllPages(
      ca,
      TABLE_ID.activeParties,
      pagers.activeParties,
      formFields,
      html,
      parseActiveParties,
    );
    const passiveParties = await this.collectAllPages(
      ca,
      TABLE_ID.passiveParties,
      pagers.passiveParties,
      formFields,
      html,
      parsePassiveParties,
    );
    const movements = await this.collectAllPages(
      ca,
      TABLE_ID.movements,
      pagers.movements,
      formFields,
      html,
      parseMovements,
    );
    const documents = await this.collectAllPages(
      ca,
      TABLE_ID.documents,
      pagers.documents,
      formFields,
      html,
      parseDocuments,
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
   * Row counting - both for the "did the page advance" check and the
   * declared-total cross-check - always uses the raw `<tbody>` row count
   * (`countTableRows`), never `parse(html).length`: `parseMovements()` and
   * `parseParties()` (like `parseDocuments()`) silently drop a row they
   * cannot parse, one lenient skip at a time, while "N resultados
   * encontrados" counts every rendered row regardless. Counting the parsed
   * output instead would turn one skipped row into a hard `ParseError`
   * against the declared total, and would shrink the inferred page size
   * enough to make every later page look like it started at the wrong index.
   */
  private async collectAllPages<T>(
    ca: string,
    tableIdSuffix: string,
    pager: Pager | undefined,
    formFields: FormField[],
    firstPageHtml: string,
    parse: (html: string) => T[],
  ): Promise<T[]> {
    const declaredTotal = readDeclaredTotal(firstPageHtml, tableIdSuffix);
    const firstPage = parse(firstPageHtml);
    const pageSize = countTableRows(firstPageHtml, tableIdSuffix);

    if (pager === undefined) {
      assertTotalMatches(tableIdSuffix, declaredTotal, pageSize);
      return firstPage;
    }

    // RichFaces renders at most ~10 numbered datascroller links, so a
    // pager's own reported page count under-counts once a table exceeds
    // roughly 10 pages. The declared total is the more trustworthy source
    // whenever both are available; the pager's own count is only a fallback
    // for when there is no declared total to divide by.
    const pageCount =
      declaredTotal !== undefined && pageSize > 0
        ? Math.ceil(declaredTotal / pageSize)
        : pager.pageCount;

    if (pageCount <= 1) {
      assertTotalMatches(tableIdSuffix, declaredTotal, pageSize);
      return firstPage;
    }

    if (pageCount > MAX_PAGES) {
      throw new ParseError(
        `Table "${tableIdSuffix}" reports ${pageCount} pages, over the ${MAX_PAGES}-page ceiling: ` +
          'refusing to walk it, likely a bad pager or declared-total reading rather than a real table this size.',
        tableIdSuffix,
      );
    }

    const rows: T[] = [...firstPage];
    let rowCount = pageSize;

    for (let page = 2; page <= pageCount; page++) {
      const pageHtml = await this.fetchPage(ca, pager, page, formFields);
      assertPageAdvanced(pageHtml, tableIdSuffix, pager, page, pageSize);
      rows.push(...parse(pageHtml));
      rowCount += countTableRows(pageHtml, tableIdSuffix);
    }

    assertTotalMatches(tableIdSuffix, declaredTotal, rowCount);
    return rows;
  }

  /** Sends the paging POST for one page of one pager. */
  private async fetchPage(
    ca: string,
    pager: Pager,
    page: number,
    formFields: FormField[],
  ): Promise<string> {
    const body = buildPagingBody(pager, page, formFields);
    const response = await this.session.post('detail', body, { query: `?ca=${ca}` });
    return response.html;
  }
}

/**
 * The id of the outer form every pager's fields really belong to (see this
 * module's header comment) - the first colon-separated segment of any
 * pager's own `baseId`, since every pager on the detail page nests inside
 * the same one. `undefined` when there is no pager at all to derive it from
 * (nothing to page through, so no form fields are needed either).
 */
function outerFormId(pagers: {
  activeParties?: Pager;
  passiveParties?: Pager;
  movements?: Pager;
  documents?: Pager;
}): string | undefined {
  const anyPager = pagers.activeParties ?? pagers.passiveParties ?? pagers.movements ?? pagers.documents;
  return anyPager?.baseId.split(':')[0];
}

/**
 * Builds the AJAX POST body for one page of one pager, whichever widget it
 * is.
 *
 * Both widgets submit the **entire** outer form (see this module's header
 * comment): `formFields` (page 1's full field set) is replayed in order,
 * with the pager's own page-value field overridden to the requested page,
 * prefixed with `AJAXREQUEST=_viewRoot` and suffixed with the one field each
 * widget's real `onchange`/`A4J.AJAX.Submit` call adds beyond the form's own
 * fields:
 *
 * - **Datascroller**: `ajaxSingle=<pageFieldId>` (the scroller field doubles
 *   as the ajax-single target).
 * - **Slider**: `<eventFieldId>=<eventFieldId>` (a distinct, self-referential
 *   id the real `onchange` names - not the page number, unlike the
 *   datascroller's `ajaxSingle`).
 */
export function buildPagingBody(
  pager: Pager,
  page: number,
  formFields: FormField[],
): URLSearchParams {
  const body = new URLSearchParams();
  body.set('AJAXREQUEST', '_viewRoot');

  // The page value itself is not always a field this form actually renders.
  // A slider's page-field id names a real text <input> (its own visible
  // value), present among formFields and overridden in place. A
  // datascroller's page-field id names no <input> at all - only a wrapper
  // <div> - because a real browser communicates the target page purely
  // through the JS event's `page` memo (`Event.fire(this,
  // 'rich:datascroller:onscroll', {'page': '2'})`), never as form state.
  // Tracking whether it was actually overridden lets the field be added
  // afterwards when it wasn't - confirmed live: omitting it renders nothing.
  let pageFieldOverridden = false;
  for (const [name, value] of formFields) {
    const isPageField = name === pager.pageFieldId;
    if (isPageField) pageFieldOverridden = true;
    body.append(name, isPageField ? String(page) : value);
  }
  if (!pageFieldOverridden) {
    body.set(pager.pageFieldId, String(page));
  }

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
 * The two pager widgets are checked differently, because they behave
 * differently under paging - both confirmed live:
 *
 * - **Datascroller**: every row's id embeds its *absolute* position in the
 *   whole table (`processoPartesPoloPassivoResumidoList:10:` on page 2 of a
 *   12-row table, not `:0:`). The first row index the response actually
 *   returned is checked against `(page - 1) * pageSize`, the index the
 *   requested page should start at.
 * - **Slider**: rows are **re-indexed from 0 on every page** instead (page 2
 *   of a 15-per-page, 75-row movements table is rows `0..14`, not `15..29`).
 *   The absolute-index check would misfire on a slider page that genuinely
 *   advanced; the response's own `'sliderValue':'N'` is checked against the
 *   requested page instead.
 *
 * Either way, if the server ignores the page parameter (a stale ViewState, a
 * wrong field id after a redeploy) it can return page 1 again with a 200
 * status and no error of its own - `PjeDetail` would otherwise concatenate
 * that unchanged page onto the result a second time, producing silent
 * duplicates.
 *
 * Silently accepts a page with nothing to check against (no rows to read an
 * index from, or no `sliderValue` in the response): there is nothing to
 * contradict in that case.
 */
function assertPageAdvanced(
  html: string,
  tableIdSuffix: string,
  pager: Pager,
  page: number,
  pageSize: number,
): void {
  if (pager.kind === 'slider') {
    const sliderValue = readSliderValue(html);
    if (sliderValue === undefined) return;
    if (sliderValue !== page) {
      throw new ParseError(
        `Table "${tableIdSuffix}" page ${page}'s response reports sliderValue=${sliderValue}: ` +
          'the paging POST likely did not move the server past the previous page ' +
          '(stale ViewState or a wrong field id), which would otherwise silently duplicate rows.',
        tableIdSuffix,
      );
    }
    return;
  }

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
