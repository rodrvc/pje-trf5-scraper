/**
 * Running queries against the Consulta Pública form.
 *
 * JSF requires the POST to reproduce the whole form, not just the fields that
 * matter: the empty ones must travel too. Omitting any of them makes the server
 * answer 200 with no results and no explanation.
 */

import type { Query, JudicialClass, SearchResponse } from '../domain/types.js';
import { RejectedQueryError } from '../domain/errors.js';
import { parseSearchResponse } from '../domain/parse-results.js';
import {
  FIELDS,
  discoverSearchComponentId,
  SEARCH_FORM,
  SEARCH_COMPONENT_ID,
  NO_SELECTION,
} from './constants.js';
import type { JsfSession } from './session.js';

/** Converts an ISO date (2025-03-11) to the form's format (11/03/2025). */
export function toFormDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`Invalid ISO date: "${iso}"`);
  }
  return `${day}/${month}/${year}`;
}

/** The reference month the JSF calendar expects alongside each date. */
function referenceMonth(iso: string): string {
  const [year, month] = iso.split('-');
  return `${month}/${year}`;
}

export class PjeSearch {
  /**
   * Id of the component that triggers the search.
   *
   * Discovered from the markup on the first query rather than trusting the
   * constant: JSF's `j_idNNN` values change if the court redeploys, and this
   * keeps the scraper from failing silently.
   */
  private componentId = SEARCH_COMPONENT_ID;
  private componentIdDiscovered = false;

  constructor(private readonly session: JsfSession) {}

  /**
   * Runs a query and returns its results.
   *
   * @throws RejectedQueryError when the server validated the query and discarded it.
   */
  async search(query: Query): Promise<SearchResponse> {
    const initial = await this.session.open('search');
    this.discoverComponentId(initial.html);

    const response = await this.session.post('search', this.buildFormBody(query));
    const result = parseSearchResponse(response.html);

    // A server rejection is not "zero results": the query never ran, and
    // retrying it unchanged would give the same outcome.
    if (result.rows.length === 0 && result.rejectionMessage !== undefined) {
      throw new RejectedQueryError(
        `The server rejected the query: ${result.rejectionMessage}`,
        result.rejectionMessage,
      );
    }

    return result;
  }

  /**
   * Fetches the judicial class catalog with internal ids.
   *
   * Needed for the second partition dimension: when a single day saturates the
   * 30-result cap, it is split by class. The form requires the internal id, not
   * the display name.
   *
   * The autocomplete returns the full catalog, so one call is enough.
   */
  async classCatalog(): Promise<JudicialClass[]> {
    await this.session.open('search');

    const body = new URLSearchParams();
    body.set('AJAXREQUEST', '_viewRoot');
    body.set(FIELDS.judicialClass, '');
    body.set(SEARCH_FORM, SEARCH_FORM);
    body.set(FIELDS.judicialClassSuggestion, FIELDS.judicialClassSuggestion);
    body.set('ajaxSingle', FIELDS.judicialClassSuggestion);
    body.set('AJAX:EVENTS_COUNT', '1');

    const response = await this.session.post('search', body);
    return parseClassCatalog(response.html);
  }

  private discoverComponentId(html: string): void {
    if (this.componentIdDiscovered) return;

    const discovered = discoverSearchComponentId(html);
    if (discovered !== undefined) {
      this.componentId = discovered;
    }
    this.componentIdDiscovered = true;
  }

  /**
   * Reproduces the whole form.
   *
   * The ViewState is added by `JsfSession`, which owns it per view.
   */
  private buildFormBody(query: Query): URLSearchParams {
    const from = toFormDate(query.from);
    const to = toFormDate(query.to);

    const body = new URLSearchParams();
    body.set('AJAXREQUEST', '_viewRoot');

    // Search fields, empty except the ones this query uses.
    body.set(FIELDS.caseNumber, '');
    body.set('mascaraProcessoReferenciaRadio', 'on');
    body.set(FIELDS.referenceCase, '');
    body.set(FIELDS.partyName, '');
    body.set(FIELDS.attorneyName, '');
    body.set(FIELDS.judicialClass, query.judicialClassName ?? '');
    body.set(FIELDS.judicialClassId, query.judicialClassId ?? '');
    body.set('tipoMascaraDocumento', 'on');
    body.set(FIELDS.partyDocument, '');
    body.set(FIELDS.oabNumber, '');
    body.set(FIELDS.oabLetter, '');
    body.set(FIELDS.oabState, NO_SELECTION);

    body.set(FIELDS.filingDateFrom, from);
    body.set(FIELDS.filingDateFromMonth, referenceMonth(query.from));
    body.set(FIELDS.filingDateTo, to);
    body.set(FIELDS.filingDateToMonth, referenceMonth(query.to));

    body.set(SEARCH_FORM, SEARCH_FORM);
    body.set('autoScroll', '');

    // The component that runs the search. Not the visible button.
    body.set(this.componentId, this.componentId);
    body.set('AJAX:EVENTS_COUNT', '1');

    return body;
  }
}

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
 * Hence dropping the empty ones before reading id and name.
 */
export function parseClassCatalog(html: string): JudicialClass[] {
  const classes: JudicialClass[] = [];
  const seen = new Set<string>();

  const rows = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
  for (const [, content] of rows) {
    if (content === undefined) continue;

    const cells = [...content.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(([, cell]) => (cell ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter((cell) => cell !== '');

    const [id, name] = cells;
    if (id === undefined || name === undefined) continue;
    if (!/^\d+$/.test(id) || name === '') continue;
    if (seen.has(id)) continue;

    seen.add(id);
    classes.push({ id, name });
  }

  return classes;
}
