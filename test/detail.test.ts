/**
 * `PjeDetail` tests: the piece that walks the detail view's internal paging.
 *
 * Mocked with nock, same as `client.test.ts`, rather than a hand-rolled fake
 * session: this exercises the real `JsfSession` (ViewState refresh included)
 * and the real AJAX POST shape, not a stand-in for them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import nock from 'nock';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpClient } from '../src/http/client.js';
import { JsfSession, BASE_URL } from '../src/pje/session.js';
import { PjeDetail, buildPagingBody } from '../src/pje/detail.js';
import { ParseError, UnexpectedDetailPageError } from '../src/domain/errors.js';
import type { Pager } from '../src/domain/parse-detail.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

const DETAIL_PATH = '/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam';

function fastClient() {
  return new HttpClient({ delayMs: 0, backoff: { baseMs: 1, maxMs: 5, jitter: 0 } });
}

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe('PjeDetail.fetch', () => {
  it('assembles the full case from a single page when nothing paginates', async () => {
    // A minimal detail page: one active party, no pagers anywhere.
    const html = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000462-42.2023.8.17.3480</div></div>
        <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody>
          <tr><td><span><div class="col-sm-12"><span class="text-bold">JOHN DOE - CPF: 111.111.111-11 (APELANTE)</span></div></span></td>
              <td>Ativo</td></tr>
        </tbody></table>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span>01/01/2025 - Distribuição</span></td></tr>
        </tbody></table>
        <table id="j_id146:processoDocumentoGridTab"><tbody></tbody></table>
        <input type="hidden" name="javax.faces.ViewState" value="j_id1" />
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=abc123`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('abc123');

    expect(result.number).toBe('0000462-42.2023.8.17.3480');
    expect(result.sealed).toBe(false);
    expect(result.activeParties).toEqual([
      {
        name: 'JOHN DOE',
        role: 'APELANTE',
        document: { kind: 'CPF', value: '111.111.111-11' },
        status: 'Ativo',
      },
    ]);
    expect(result.movements).toEqual([{ date: '2025-01-01', description: 'Distribuição' }]);
    expect(result.documents).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });

  it('throws ParseError when the header carries no case number', async () => {
    // The CNJ number is the deduplication/persistence key everywhere
    // downstream: silently returning '' for it would corrupt whatever keys on
    // it without any visible failure. This is the fix for that.
    const html = `<html><body>Dados do Processo <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody></tbody></table></body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=nonumber`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    await expect(detail.fetch('nonumber')).rejects.toThrow(ParseError);
  });

  it('throws ParseError when the extracted number does not match the search row', async () => {
    const html = `
      <html><body>Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000462-42.2023.8.17.3480</div></div>
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=mismatch`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    await expect(
      detail.fetch('mismatch', '9999999-99.2099.9.99.9999'),
    ).rejects.toThrow(ParseError);
  });

  it('does not throw when the extracted number matches the expected one', async () => {
    const html = `
      <html><body>Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000462-42.2023.8.17.3480</div></div>
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=match`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    const result = await detail.fetch('match', '0000462-42.2023.8.17.3480');
    expect(result.number).toBe('0000462-42.2023.8.17.3480');
  });

  it('walks a two-page datascroller and merges both pages, refreshing ViewState', async () => {
    // Page 1: one row, plus a live Datascroller registration announcing 2 pages.
    const page1 = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0803385-67.2025.4.05.0000</div></div>
        <table id="j_id146:processoPartesPoloPassivoResumidoList"><tbody>
          <tr><td><span><div class="col-sm-12"><span class="text-bold">JANE ROE - CPF: 222.222.222-22 (APELADO)</span></div></span></td>
              <td>Ativo</td></tr>
        </tbody></table>
        <table class="rich-dtascroller-table"><tbody><tr>
          <td class="rich-datascr-act ">1</td>
          <td class="rich-datascr-inact ">2</td>
        </tr></tbody></table>
        <script>new Richfaces.Datascroller('j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402', function(event){A4J.AJAX.Submit('j_id146:processoPartesPoloPassivoResumidoList:j_id401', event, {});});</script>
        <span class="pull-right text-muted">2 resultados encontrados</span>
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
      </body></html>`;

    // A real AJAX response carries an "Ajax-Response" meta marker, which is
    // how JsfSession tells a partial update apart from a full page (and thus
    // does not judge it by the "Dados do Processo" heading, which a partial
    // response never carries). Its first row's id starts at index 1 (page 2
    // of a 1-per-page table), matching assertPageAdvanced's expectation.
    const page2 = `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoPartesPoloPassivoResumidoList"><tbody>
          <tr><td><span id="j_id146:processoPartesPoloPassivoResumidoList:1:x"><div class="col-sm-12"><span class="">RICHARD ROE - OAB SP1 - CPF: 333.333.333-33 (ADVOGADO)</span></div></span></td>
              <td>Ativo</td></tr>
        </tbody></table>
        <input type="hidden" name="javax.faces.ViewState" value="page2-state" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
      </body></html>`;

    const scope = nock(BASE_URL);
    scope.get(`${DETAIL_PATH}?ca=xyz789`).reply(200, page1);

    let capturedBody: Record<string, string> | undefined;
    scope
      .post(`${DETAIL_PATH}?ca=xyz789`, (body) => {
        capturedBody = body as Record<string, string>;
        return true;
      })
      .reply(200, page2);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('xyz789');

    // Both pages' rows are present: the walk did not stop at page 1.
    expect(result.passiveParties).toEqual([
      {
        name: 'JANE ROE',
        role: 'APELADO',
        document: { kind: 'CPF', value: '222.222.222-22' },
        status: 'Ativo',
      },
      {
        name: 'RICHARD ROE',
        role: 'ADVOGADO',
        document: { kind: 'CPF', value: '333.333.333-33' },
        oab: 'SP1',
        status: 'Ativo',
      },
    ]);

    // The paging POST carried page 1's ViewState, not some stale or default one.
    expect(capturedBody?.['javax.faces.ViewState']).toBe('page1-state');
    // And the scroller field named the target page, addressed to the right base id.
    expect(capturedBody?.['j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402']).toBe(
      '2',
    );
    // After that POST, the session's ViewState for "detail" was refreshed to
    // the one page 2 came back with.
    expect(session.viewStateFor('detail')).toBe('page2-state');

    expect(nock.isDone()).toBe(true);
  });

  it("throws ParseError when a paging POST does not actually advance (server ignored it)", async () => {
    // If the server ignores the page parameter (stale ViewState, wrong field
    // id) it can return page 1's own rows again with a 200 status - silently
    // concatenating that would duplicate every row on page 1. Detected here by
    // the row's absolute index staying at 0 instead of moving to 1.
    const page1 = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000000-00.2025.4.05.0000</div></div>
        <table id="j_id146:processoPartesPoloPassivoResumidoList"><tbody>
          <tr><td><span id="j_id146:processoPartesPoloPassivoResumidoList:0:x"><div class="col-sm-12"><span class="text-bold">JANE ROE - CPF: 222.222.222-22 (APELADO)</span></div></span></td>
              <td>Ativo</td></tr>
        </tbody></table>
        <table class="rich-dtascroller-table"><tbody><tr>
          <td class="rich-datascr-act ">1</td>
          <td class="rich-datascr-inact ">2</td>
        </tr></tbody></table>
        <script>new Richfaces.Datascroller('j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402', function(event){A4J.AJAX.Submit('j_id146:processoPartesPoloPassivoResumidoList:j_id401', event, {});});</script>
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
      </body></html>`;

    // Server ignored the page request: same row (index 0) comes back again.
    const stalePage2 = `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoPartesPoloPassivoResumidoList"><tbody>
          <tr><td><span id="j_id146:processoPartesPoloPassivoResumidoList:0:x"><div class="col-sm-12"><span class="text-bold">JANE ROE - CPF: 222.222.222-22 (APELADO)</span></div></span></td>
              <td>Ativo</td></tr>
        </tbody></table>
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=stale1`).reply(200, page1);
    nock(BASE_URL).post(`${DETAIL_PATH}?ca=stale1`).reply(200, stalePage2);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    await expect(detail.fetch('stale1')).rejects.toThrow(ParseError);
  });

  it('throws ParseError when a table\'s collected count does not match its declared total', async () => {
    // The page declares more rows than a single, unpaginated page actually
    // carries - as if a page silently failed to load or a pager went
    // unnoticed. Declared totals must be checked even for tables the parser
    // thinks have only one page.
    const html = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000000-00.2025.4.05.0000</div></div>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span>01/01/2025 - Distribuição</span></td></tr>
        </tbody></table>
        <span class="pull-right text-muted">75 resultados encontrados</span>
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=undercount`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    await expect(detail.fetch('undercount')).rejects.toThrow(ParseError);
  });

  it('records a sealed case without parties, movements or documents, and without throwing', async () => {
    const html = fixture('detail-sealed.html');

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=sealed1`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('sealed1');

    expect(result.sealed).toBe(true);
    expect(result.activeParties).toEqual([]);
    expect(result.passiveParties).toEqual([]);
    expect(result.movements).toEqual([]);
    expect(result.documents).toEqual([]);
    expect(result.ca).toBe('sealed1');
    expect(nock.isDone()).toBe(true);
  });

  it('throws UnexpectedDetailPageError on a page that is neither ordinary nor sealed', async () => {
    // This is the fix for the bug an earlier review caught: a database error
    // page (or a dropped session, or a changed layout) must not be silently
    // recorded as a sealed case. It has to surface as a distinct failure so
    // the orchestrator (ISSUE-9) can decide whether to retry.
    const html = fixture('detail-server-error.html');

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=broken1`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    let error: unknown;
    try {
      await detail.fetch('broken1');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnexpectedDetailPageError);
    expect((error as UnexpectedDetailPageError).reason).toBe('database error page');
    expect(nock.isDone()).toBe(true);
  });

  it('does not mistake a movement mentioning "segredo de justiça" for a sealed case', async () => {
    // The scoping fix at the parser level (classifyDetailPage only trusting
    // the notice panel, never free page text) exercised end to end.
    const html = `
      <html><body>Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000462-42.2023.8.17.3480</div></div>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span>01/01/2025 - Pedido de segredo de justiça indeferido</span></td></tr>
        </tbody></table>
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=notreallysealed`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('notreallysealed');

    expect(result.sealed).toBe(false);
    expect(result.movements).toEqual([
      { date: '2025-01-01', description: 'Pedido de segredo de justiça indeferido' },
    ]);
  });

  it('walks all four tables of a real case, including documents (the truncation this review caught)', async () => {
    const page1 = fixture('detail-with-pagination.html');

    // Builds one fake movements page: 15 rows, indices starting at
    // (page - 1) * 15, matching what a real page N of a 15-per-page,
    // 75-row table should look like. A real page 2+ response for the
    // movements slider could not be captured (see ISSUE-5's Resolution and
    // PROBLEMS.md §6 for the attempts made); this exercises both
    // assertPageAdvanced and assertTotalMatches genuinely, not just
    // tolerating them, across all 4 remaining pages.
    function movementsPage(page: number): string {
      const startIndex = (page - 1) * 15;
      const rows = Array.from({ length: 15 }, (_, i) => {
        const idx = startIndex + i;
        return `<tr><td><span id="j_id146:processoEvento:${idx}:j_id511">0${(i % 9) + 1}/0${page}/2025 - Movimento ${idx}</span></td></tr>`;
      }).join('');
      return `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoEvento"><tbody>${rows}</tbody></table>
        <input type="hidden" name="javax.faces.ViewState" value="j_id1" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
        </body></html>`;
    }

    // Builds one fake documents page: 5 rows, indices starting at
    // (page - 1) * 15 (page 1's 15 rows set that page size).
    function documentsPage(page: number, rowCount: number): string {
      const startIndex = (page - 1) * 15;
      const rows = Array.from({ length: rowCount }, (_, i) => {
        const idx = startIndex + i;
        return `<tr><td><span id="j_id146:processoDocumentoGridTab:${idx}:j_id590"><a href="/x?idBin=${9000 + idx}&numeroDocumento=doc${idx}&nomeArqProcDocBin=Doc${idx}&idProcessoDocumento=${8000 + idx}&actionMethod=foo">0${i + 1}/01/2025 - Documento (Despacho)</a></span></td></tr>`;
      }).join('');
      return `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoDocumentoGridTab"><tbody>${rows}</tbody></table>
        <input type="hidden" name="javax.faces.ViewState" value="j_id1" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
        </body></html>`;
    }

    const scope = nock(BASE_URL);
    scope.get(`${DETAIL_PATH}?ca=real1`).reply(200, page1);

    // The passive-parties scroller has a real, captured second page.
    scope
      .post(`${DETAIL_PATH}?ca=real1`, (body) => {
        const b = body as Record<string, string>;
        return 'j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402' in b;
      })
      .reply(200, fixture('detail-page2-ajax.html'));

    // Movements' slider pager: 5 pages, 75 rows.
    for (const page of [2, 3, 4, 5]) {
      scope
        .post(`${DETAIL_PATH}?ca=real1`, (body) => {
          const b = body as Record<string, string>;
          return b['j_id146:j_id561:j_id562'] === String(page);
        })
        .reply(200, movementsPage(page));
    }

    // Documents' slider pager: 2 pages, 20 rows (14 downloadable + 1
    // view-only on page 1 = 15 rows; 5 more, all downloadable, on page 2).
    scope
      .post(`${DETAIL_PATH}?ca=real1`, (body) => {
        const b = body as Record<string, string>;
        return b['j_id146:j_id653:j_id654'] === '2';
      })
      .reply(200, documentsPage(2, 5));

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('real1');

    expect(result.number).toBe('0803385-67.2025.4.05.0000');
    expect(result.activeParties).toHaveLength(1);
    // 10 on page 1 + 2 on page 2: the walk reached the second page.
    expect(result.passiveParties).toHaveLength(12);
    // Movements were one of the two tables silently truncated before this
    // review: 15 on page 1, 60 more across pages 2-5.
    expect(result.movements).toHaveLength(75);
    // Documents were the other: 14 downloadable on page 1 + 5 on page 2 = 19
    // (the view-only row on page 1 has no download link and parseDocuments()
    // drops it, but it still counts towards the declared total of 20).
    expect(result.documents).toHaveLength(19);
    // Accents must survive (this fixture is a real UTF-8-alike GET capture).
    expect(result.judicialClass).toContain('AGRAVO');
    expect(nock.isDone()).toBe(true);
  });
});

describe('buildPagingBody', () => {
  it('builds a datascroller body with ajaxSingle set to the page field', () => {
    const pager: Pager = {
      kind: 'datascroller',
      baseId: 'j_id146:x:base',
      pageFieldId: 'j_id146:x:base:page',
      pageCount: 3,
    };

    const body = buildPagingBody(pager, 2);

    expect(Object.fromEntries(body)).toEqual({
      AJAXREQUEST: '_viewRoot',
      'j_id146:x:base': 'j_id146:x:base',
      'j_id146:x:base:page': '2',
      ajaxSingle: 'j_id146:x:base:page',
      'AJAX:EVENTS_COUNT': '1',
    });
  });

  it('builds a slider body with the distinct event field, not ajaxSingle', () => {
    const pager: Pager = {
      kind: 'slider',
      baseId: 'j_id146:y',
      pageFieldId: 'j_id146:y:z',
      eventFieldId: 'j_id146:y:w',
      pageCount: 5,
    };

    const body = buildPagingBody(pager, 3);

    expect(Object.fromEntries(body)).toEqual({
      AJAXREQUEST: '_viewRoot',
      'j_id146:y': 'j_id146:y',
      'j_id146:y:z': '3',
      'j_id146:y:w': 'j_id146:y:w',
      'AJAX:EVENTS_COUNT': '1',
    });
  });
});
