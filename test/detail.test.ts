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
import type { FormField, Pager } from '../src/domain/parse-detail.js';

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

  it('throws ParseError on a mismatched expected number, and passes when it matches', async () => {
    const html = `
      <html><body>Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000462-42.2023.8.17.3480</div></div>
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=mismatch`).reply(200, html);
    nock(BASE_URL).get(`${DETAIL_PATH}?ca=match`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    await expect(
      detail.fetch('mismatch', '9999999-99.2099.9.99.9999'),
    ).rejects.toThrow(ParseError);

    const result = await detail.fetch('match', '0000462-42.2023.8.17.3480');
    expect(result.number).toBe('0000462-42.2023.8.17.3480');
  });

  it('walks a two-page datascroller and merges both pages, refreshing ViewState', async () => {
    // Page 1: one row inside a real, enclosing <form id="j_id146"> - the
    // pager's own form nests inside it, mirroring the real markup: PJe
    // submits the whole outer form when paging, not the pager's own few
    // fields (see PjeDetail's module comment and PROBLEMS.md §6). A live
    // hidden field (autoScroll) rides along in that form to prove the body
    // was actually built from it, not synthesised from the pager alone.
    const page1 = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0803385-67.2025.4.05.0000</div></div>
        <form id="j_id146">
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
        <input type="hidden" autocomplete="off" name="autoScroll" value="" />
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
        </form>
      </body></html>`;

    // A real AJAX response carries an "Ajax-Response" meta marker, which is
    // how JsfSession tells a partial update apart from a full page (and thus
    // does not judge it by the "Dados do Processo" heading, which a partial
    // response never carries). Its first row's id starts at index 1 (page 2
    // of a 1-per-page table): a datascroller keeps absolute row indices
    // across pages, unlike a slider (see the slider test below).
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

    // The paging POST carried the outer form's own field (autoScroll),
    // proving the body came from replaying the whole form, not from the
    // pager's ids alone.
    expect(capturedBody?.['autoScroll']).toBe('');
    // The scroller field named the target page, addressed to the right base
    // id - added explicitly, since a datascroller's page-value id is not a
    // real form field on the page (only a wrapper <div>; see
    // buildPagingBody's comment).
    expect(capturedBody?.['j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402']).toBe(
      '2',
    );
    // JsfSession always sets ViewState itself when posting, from the value
    // it tracked after opening page 1 - not from buildPagingBody's own body.
    expect(capturedBody?.['javax.faces.ViewState']).toBe('page1-state');
    // After that POST, the session's ViewState for "detail" was refreshed to
    // the one page 2 came back with.
    expect(session.viewStateFor('detail')).toBe('page2-state');

    expect(nock.isDone()).toBe(true);
  });

  it('walks a two-page slider and merges both pages, using sliderValue to confirm advancement', async () => {
    // A slider page re-indexes its rows from 0 on every page (confirmed
    // live, see PROBLEMS.md §6), unlike a datascroller - so this table's
    // page 2 starts back at row 0, not row 15. assertPageAdvanced must use
    // the response's own 'sliderValue' for this widget instead of the
    // absolute-index check.
    const page1 = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000462-42.2023.8.17.3480</div></div>
        <form id="j_id146">
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span id="j_id146:processoEvento:0:x">01/01/2025 - Primeira movimentação</span></td></tr>
        </tbody></table>
        <span class="pull-right text-muted">2 resultados encontrados</span>
        <script>new Richfaces.Slider("j_id146:j_id561:j_id562",{'minValue':'1','maxValue':'2','sliderValue':'1','onchange':'A4J.AJAX.Submit(\\'j_id146:j_id561\\',event,{\\'parameters\\':{\\'j_id146:j_id561:j_id563\\':\\'j_id146:j_id561:j_id563\\'} } )'})</script>
        <input class="rich-inslider-field" name="j_id146:j_id561:j_id562" value="1" />
        <input type="hidden" autocomplete="off" name="j_id146:j_id561" value="j_id146:j_id561" />
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
        </form>
      </body></html>`;

    // Page 2, re-indexed from 0, echoing sliderValue: 2 as the recipe found live.
    const page2 = `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span id="j_id146:processoEvento:0:x">02/01/2025 - Segunda movimentação</span></td></tr>
        </tbody></table>
        <script>'sliderValue':'2'</script>
        <input type="hidden" name="javax.faces.ViewState" value="page2-state" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
      </body></html>`;

    const scope = nock(BASE_URL);
    scope.get(`${DETAIL_PATH}?ca=slider1`).reply(200, page1);

    let capturedBody: Record<string, string> | undefined;
    scope
      .post(`${DETAIL_PATH}?ca=slider1`, (body) => {
        capturedBody = body as Record<string, string>;
        return true;
      })
      .reply(200, page2);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('slider1');

    expect(result.movements).toEqual([
      { date: '2025-01-01', description: 'Primeira movimentação' },
      { date: '2025-01-02', description: 'Segunda movimentação' },
    ]);
    // The slider's own value field was overridden to the target page.
    expect(capturedBody?.['j_id146:j_id561:j_id562']).toBe('2');
    // And its distinct event field was appended, not folded into ajaxSingle.
    expect(capturedBody?.['j_id146:j_id561:j_id563']).toBe('j_id146:j_id561:j_id563');
    expect(nock.isDone()).toBe(true);
  });

  it("throws ParseError when a datascroller paging POST does not actually advance (server ignored it)", async () => {
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

  it('throws ParseError when a slider paging response reports the wrong sliderValue', async () => {
    const page1 = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000000-00.2025.4.05.0000</div></div>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span>01/01/2025 - Primeira movimentação</span></td></tr>
        </tbody></table>
        <span class="pull-right text-muted">2 resultados encontrados</span>
        <script>new Richfaces.Slider("j_id146:j_id561:j_id562",{'minValue':'1','maxValue':'2','sliderValue':'1','onchange':'A4J.AJAX.Submit(\\'j_id146:j_id561\\',event,{\\'parameters\\':{\\'j_id146:j_id561:j_id563\\':\\'j_id146:j_id561:j_id563\\'} } )'})</script>
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
      </body></html>`;

    // Server ignored the page request: sliderValue stayed at 1.
    const stalePage2 = `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span>01/01/2025 - Primeira movimentação</span></td></tr>
        </tbody></table>
        <script>'sliderValue':'1'</script>
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=stalesider`).reply(200, page1);
    nock(BASE_URL).post(`${DETAIL_PATH}?ca=stalesider`).reply(200, stalePage2);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    await expect(detail.fetch('stalesider')).rejects.toThrow(ParseError);
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

  it('does not throw when a table has one unparsable row but the declared total still matches', async () => {
    // This is the fix for the bug the architecture review caught:
    // parseMovements() silently drops a row whose text does not match the
    // dated-entry pattern, but "N resultados encontrados" counts every
    // rendered row regardless. Cross-checking against parse(html).length
    // (the old default) would turn that one lenient skip into a hard,
    // false-positive ParseError. countTableRows() (the raw row count) is
    // used instead, so 2 rendered rows against a declared total of 2 must
    // pass even though only 1 of them parses into a Movement.
    const html = `
      <html><body>
        Dados do Processo
        <div class="propertyView"><div class="name"><label>Número Processo</label></div>
          <div class="value col-sm-12">0000000-00.2025.4.05.0000</div></div>
        <table id="j_id146:processoEvento"><tbody>
          <tr><td><span>01/01/2025 - Distribuição</span></td></tr>
          <tr><td><span>this row does not match the dated-entry pattern at all</span></td></tr>
        </tbody></table>
        <span class="pull-right text-muted">2 resultados encontrados</span>
      </body></html>`;

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=oneskipped`).reply(200, html);

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);

    const result = await detail.fetch('oneskipped');
    // Only the parsable row makes it into the result; the declared total (2)
    // still matched the raw row count (2), so nothing threw.
    expect(result.movements).toEqual([{ date: '2025-01-01', description: 'Distribuição' }]);
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

  it('walks a real, live-captured slider pager across its two pages (movements)', async () => {
    // detail-slider-page1.html / detail-slider-page2-ajax.html are a real
    // capture: case 0000462-42.2023.8.17.3480, 27 movements over 2 slider
    // pages (15 + 12), reproduced live with the unified full-outer-form
    // paging body documented in PjeDetail's module comment. See ISSUE-5's
    // Resolution and PROBLEMS.md §6.
    const page1 = fixture('detail-slider-page1.html');

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=real-slider`).reply(200, page1);
    nock(BASE_URL)
      .post(`${DETAIL_PATH}?ca=real-slider`)
      .reply(200, fixture('detail-slider-page2-ajax.html'));

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('real-slider');

    expect(result.number).toBe('0000462-42.2023.8.17.3480');
    expect(result.movements).toHaveLength(27);
    expect(nock.isDone()).toBe(true);
  });

  it('walks all four tables of a real case, including documents (the truncation this review caught)', async () => {
    const page1 = fixture('detail-with-pagination.html');

    // Builds one fake movements page: 15 rows, indices starting at 0 (every
    // slider page re-indexes from 0 - confirmed live, unlike a
    // datascroller's absolute indices).
    function movementsPage(page: number): string {
      const rows = Array.from({ length: 15 }, (_, i) => {
        return `<tr><td><span id="j_id146:processoEvento:${i}:j_id511">0${(i % 9) + 1}/0${page}/2025 - Movimento ${page}-${i}</span></td></tr>`;
      }).join('');
      return `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoEvento"><tbody>${rows}</tbody></table>
        <script>'sliderValue':'${page}'</script>
        <input type="hidden" name="javax.faces.ViewState" value="j_id1" />
        <meta id="Ajax-Response" name="Ajax-Response" content="true" />
        </body></html>`;
    }

    // Builds one fake documents page: 5 rows, also re-indexed from 0.
    function documentsPage(page: number, rowCount: number): string {
      const rows = Array.from({ length: rowCount }, (_, i) => {
        return `<tr><td><span id="j_id146:processoDocumentoGridTab:${i}:j_id590"><a href="/x?idBin=${9000 + i}&numeroDocumento=doc${page}-${i}&nomeArqProcDocBin=Doc${i}&idProcessoDocumento=${8000 + i}&actionMethod=foo">0${i + 1}/01/2025 - Documento (Despacho)</a></span></td></tr>`;
      }).join('');
      return `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoDocumentoGridTab"><tbody>${rows}</tbody></table>
        <script>'sliderValue':'${page}'</script>
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
  it('replays form fields in order, overriding the page field in place, adding the slider\'s distinct event field', () => {
    const pager: Pager = {
      kind: 'slider',
      baseId: 'j_id146:y',
      pageFieldId: 'j_id146:y:z',
      eventFieldId: 'j_id146:y:w',
      pageCount: 5,
    };
    const formFields: FormField[] = [
      ['javax.faces.ViewState', 'state1'],
      ['j_id146:y:z', '1'],
      ['autoScroll', ''],
    ];

    const body = buildPagingBody(pager, 3, formFields);

    expect([...body.entries()]).toEqual([
      ['AJAXREQUEST', '_viewRoot'],
      ['javax.faces.ViewState', 'state1'],
      ['j_id146:y:z', '3'],
      ['autoScroll', ''],
      ['j_id146:y:w', 'j_id146:y:w'],
      ['AJAX:EVENTS_COUNT', '1'],
    ]);
  });

  it('appends the page field with ajaxSingle when it is not among the form fields (a datascroller page value is never a real input)', () => {
    const pager: Pager = {
      kind: 'datascroller',
      baseId: 'j_id146:x:base',
      pageFieldId: 'j_id146:x:base:page',
      pageCount: 3,
    };
    const formFields: FormField[] = [['autoScroll', '']];

    const body = buildPagingBody(pager, 2, formFields);

    expect([...body.entries()]).toEqual([
      ['AJAXREQUEST', '_viewRoot'],
      ['autoScroll', ''],
      ['j_id146:x:base:page', '2'],
      ['ajaxSingle', 'j_id146:x:base:page'],
      ['AJAX:EVENTS_COUNT', '1'],
    ]);
  });
});
