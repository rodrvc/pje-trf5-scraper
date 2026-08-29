/**
 * JSF session on top of the HTTP client.
 *
 * JSF requires every POST to carry the `javax.faces.ViewState` of the view it is
 * sent from. Without the right cookie + ViewState pair the server answers 200
 * with valid HTML but no results: it fails silently, which is the unpleasant
 * part to debug.
 *
 * ViewState is stored **per view**, not as a single value: the detail page has a
 * different one from the search page, and mixing them breaks navigation.
 */

import type { BinaryResponse, HttpClient, TextResponse } from '../http/client.js';
import { ParseError, SessionExpiredError } from '../domain/errors.js';

export const BASE_URL = 'https://pjett.trf5.jus.br/pjeconsulta';

/** The views the scraper walks through. */
export const VIEWS = {
  search: '/ConsultaPublica/listView.seam',
  detail: '/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam',
} as const;

export type View = keyof typeof VIEWS;

const RE_VIEW_STATE = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/;

/** Extracts the ViewState from a response. Pure function, testable without network. */
export function extractViewState(html: string): string | undefined {
  return RE_VIEW_STATE.exec(html)?.[1];
}

/**
 * Detects that the session expired.
 *
 * PJe answers neither 401 nor 403: it returns 200 with an empty search form, as
 * if you had just arrived. It is recognized by what the view is missing.
 */
export function looksLikeExpiredSession(html: string, view: View): boolean {
  if (view === 'detail') {
    // The detail view always carries this heading; without it we are not there.
    return !html.includes('Dados do Processo');
  }
  // On search, a missing form means there is no live view left.
  return !html.includes('javax.faces.ViewState');
}

export class JsfSession {
  /** ViewState per view. */
  private readonly viewStates = new Map<View, string>();

  constructor(private readonly http: HttpClient) {}

  url(view: View, query?: string): string {
    return `${BASE_URL}${VIEWS[view]}${query ?? ''}`;
  }

  /**
   * Opens a view and stores its ViewState.
   *
   * This is the mandatory entry point: without having loaded the view there is
   * no ViewState to send in subsequent POSTs.
   */
  async open(view: View, query?: string): Promise<TextResponse> {
    const response = await this.http.get(this.url(view, query), {
      Referer: this.url('search'),
    });
    this.rememberViewState(view, response.html);
    return response;
  }

  /**
   * Sends a POST for the given view, adding its ViewState.
   *
   * If the response reveals an expired session, it re-establishes and retries
   * once. One retry is enough: a second failure means something else is wrong
   * and should propagate rather than loop.
   */
  async post(
    view: View,
    fields: URLSearchParams,
    options: { query?: string; retryIfExpired?: boolean } = {},
  ): Promise<TextResponse> {
    const { query, retryIfExpired = true } = options;

    const viewState = this.viewStates.get(view);
    if (viewState === undefined) {
      throw new ParseError(
        `No ViewState for view "${view}": it must be opened before posting.`,
      );
    }

    const body = new URLSearchParams(fields);
    body.set('javax.faces.ViewState', viewState);

    const response = await this.http.post(this.url(view, query), body, {
      Referer: this.url(view, query),
      'X-Requested-With': 'XMLHttpRequest',
    });

    this.rememberViewState(view, response.html);

    if (this.signalsExpiredSession(response, view)) {
      if (!retryIfExpired) {
        throw new SessionExpiredError(`Session expired while posting to "${view}".`);
      }
      await this.reestablish(view, query);
      return this.post(view, fields, { ...options, retryIfExpired: false });
    }

    return response;
  }

  /** Discards the current session and reopens the view from scratch. */
  async reestablish(view: View, query?: string): Promise<void> {
    await this.http.resetSession();
    this.viewStates.clear();
    await this.open(view, query);
  }

  /**
   * GET returning raw bytes, against a view's URL.
   *
   * Used for PDF downloads (ISSUE-6): the document link is a GET to the
   * detail view itself, carrying the download identifiers as query params,
   * which 302-redirects to a session-bound `download.seam?cid=<N>`. Routed
   * through the session (not `HttpClient` directly) so a caller can never
   * pair a download with a different client than the one holding the live
   * cookie jar - a mismatched pair would mean the redirect's `cid` is bound
   * to a session the request is not actually carrying, and PJe answers that
   * with a 404 rather than anything diagnosable.
   */
  async getBinary(
    view: View,
    query?: string,
    headers?: Record<string, string>,
  ): Promise<BinaryResponse> {
    return this.http.getBinary(this.url(view, query), {
      Referer: this.url(view),
      ...headers,
    });
  }

  viewStateFor(view: View): string | undefined {
    return this.viewStates.get(view);
  }

  private rememberViewState(view: View, html: string): void {
    const viewState = extractViewState(html);
    if (viewState !== undefined) {
      this.viewStates.set(view, viewState);
    }
  }

  /**
   * A partial AJAX response does not carry the whole page, so it cannot be
   * judged by the same standard as a full load: it only counts as expired if it
   * also lost the ViewState.
   */
  private signalsExpiredSession(response: TextResponse, view: View): boolean {
    const isAjaxResponse = response.html.includes('Ajax-Response');
    if (isAjaxResponse) {
      return extractViewState(response.html) === undefined;
    }
    return looksLikeExpiredSession(response.html, view);
  }
}
