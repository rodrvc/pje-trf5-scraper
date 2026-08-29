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
import { PjeDetail } from '../src/pje/detail.js';

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
    // A minimal detail page: one active party, no scrollers anywhere.
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
    expect(nock.isDone()).toBe(true);
  });

  it('walks a two-page scroller and merges both pages, refreshing ViewState', async () => {
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
        <input type="hidden" name="javax.faces.ViewState" value="page1-state" />
      </body></html>`;

    // The AJAX response for page 2: a fresh row and a fresh ViewState, as a
    // real PJe paging response does.
    // A real AJAX response carries an "Ajax-Response" meta marker, which is
    // how JsfSession tells a partial update apart from a full page (and thus
    // does not judge it by the "Dados do Processo" heading, which a partial
    // response never carries).
    const page2 = `<?xml version="1.0"?><html><body>
        <table id="j_id146:processoPartesPoloPassivoResumidoList"><tbody>
          <tr><td><span><div class="col-sm-12"><span class="">RICHARD ROE - OAB SP1 - CPF: 333.333.333-33 (ADVOGADO)</span></div></span></td>
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
    expect(
      capturedBody?.['j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402'],
    ).toBe('2');
    // After that POST, the session's ViewState for "detail" was refreshed to
    // the one page 2 came back with.
    expect(session.viewStateFor('detail')).toBe('page2-state');

    expect(nock.isDone()).toBe(true);
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

  it('extracts a real case with documents from the live fixture', async () => {
    const html = fixture('detail-with-pagination.html');

    nock(BASE_URL).get(`${DETAIL_PATH}?ca=real1`).reply(200, html);
    // The passive-parties scroller has a real second page; serve it from the
    // captured AJAX fixture.
    nock(BASE_URL)
      .post(`${DETAIL_PATH}?ca=real1`)
      .reply(200, fixture('detail-page2-ajax.html'));

    const session = new JsfSession(fastClient());
    const detail = new PjeDetail(session);
    const result = await detail.fetch('real1');

    expect(result.number).toBe('0803385-67.2025.4.05.0000');
    expect(result.activeParties).toHaveLength(1);
    // 10 on page 1 + 2 on page 2: the walk reached the second page.
    expect(result.passiveParties).toHaveLength(12);
    expect(result.movements).toHaveLength(15);
    expect(result.documents.length).toBeGreaterThan(0);
    // Accents must survive (this fixture is a real UTF-8-alike GET capture).
    expect(result.judicialClass).toContain('AGRAVO');
    expect(nock.isDone()).toBe(true);
  });
});
