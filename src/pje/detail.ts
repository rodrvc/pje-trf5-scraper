/**
 * Fetching the case detail view.
 *
 * The first GET (`ca=<token>`) returns the header, both parties tables and
 * usually all movements and documents. But each of those three tables
 * paginates independently via its own `Richfaces.Datascroller`, and the first
 * page is all the initial GET carries: a case with several pages of parties
 * or movements is incomplete until every scroller has been walked.
 *
 * Paging is a separate AJAX POST per page, shaped as documented in
 * `PROBLEMS.md` §6:
 *
 *   AJAXREQUEST=_viewRoot
 *   <baseId>=<baseId>
 *   javax.faces.ViewState=<current>
 *   <scrollerId>=<page>
 *   ajaxSingle=<scrollerId>
 *   AJAX:EVENTS_COUNT=1
 *
 * `JsfSession` already tracks the detail view's ViewState separately from the
 * search view's; every POST here refreshes it from the response, same as it
 * does for search.
 */

import type { DatascrollerInfo, LegalCase } from '../domain/types.js';
import {
  classifyDetailPage,
  parseCaseHeader,
  parseDocuments,
  parseMovements,
  parseParties,
  parseScrollers,
} from '../domain/parse-detail.js';
import { UnexpectedDetailPageError } from '../domain/errors.js';
import type { JsfSession } from './session.js';

/** Ids of the three parties/movements tables the detail view paginates. */
const ACTIVE_PARTIES_TABLE = 'j_id146:processoPartesPoloAtivoResumidoList';
const PASSIVE_PARTIES_TABLE = 'j_id146:processoPartesPoloPassivoResumidoList';

export class PjeDetail {
  constructor(private readonly session: JsfSession) {}

  /**
   * Fetches and fully assembles one case, walking every paginated table.
   *
   * A sealed case returns immediately after the first GET: there is nothing
   * further to page through, and the missing sections are not an error.
   *
   * @throws UnexpectedDetailPageError when the page is neither an ordinary
   *   detail view nor positively identified as sealed - a database error page
   *   or a dropped session, for instance. Left to the orchestrator (ISSUE-9)
   *   to decide whether to retry or record as a failure.
   */
  async fetch(ca: string): Promise<LegalCase> {
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
    const scrollers = parseScrollers(html);

    const activeParties = await this.collectAllPages(
      ca,
      scrollers.activeParties,
      html,
      (pageHtml) => parseParties(pageHtml, ACTIVE_PARTIES_TABLE),
    );
    const passiveParties = await this.collectAllPages(
      ca,
      scrollers.passiveParties,
      html,
      (pageHtml) => parseParties(pageHtml, PASSIVE_PARTIES_TABLE),
    );
    const movements = await this.collectAllPages(ca, scrollers.movements, html, parseMovements);

    // Documents are not known to paginate in any case sampled while building
    // this module (see the issue's Resolution); read from the first page only.
    const documents = parseDocuments(html);

    return {
      number: header.number ?? '',
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
   * Walks every page of one datascroller, merging the parsed rows.
   *
   * Page 1's rows come from the already-fetched `firstPageHtml`, since
   * re-requesting it would waste a request; pages 2..N come from the AJAX
   * paging POST, one at a time, refreshing the ViewState as it goes.
   */
  private async collectAllPages<T>(
    ca: string,
    scroller: DatascrollerInfo | undefined,
    firstPageHtml: string,
    parse: (html: string) => T[],
  ): Promise<T[]> {
    const firstPage = parse(firstPageHtml);
    if (scroller === undefined || scroller.pageCount <= 1) {
      return firstPage;
    }

    const rows: T[] = [...firstPage];
    for (let page = 2; page <= scroller.pageCount; page++) {
      const pageHtml = await this.fetchPage(ca, scroller, page);
      rows.push(...parse(pageHtml));
    }
    return rows;
  }

  /** Sends the paging POST for one page of one scroller. */
  private async fetchPage(
    ca: string,
    scroller: DatascrollerInfo,
    page: number,
  ): Promise<string> {
    const body = new URLSearchParams();
    body.set('AJAXREQUEST', '_viewRoot');
    body.set(scroller.baseId, scroller.baseId);
    body.set(scroller.scrollerId, String(page));
    body.set('ajaxSingle', scroller.scrollerId);
    body.set('AJAX:EVENTS_COUNT', '1');

    const response = await this.session.post('detail', body, { query: `?ca=${ca}` });
    return response.html;
  }
}
