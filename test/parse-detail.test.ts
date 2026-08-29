/**
 * Case detail parsing tests.
 *
 * Inline HTML documents the exact shape being parsed; the captured fixtures
 * pin fidelity to the real markup, including its two traps (see below).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  decodeLatin1QueryValue,
  isSealed,
  parseCaseHeader,
  parseDocuments,
  parseMovements,
  parseParties,
  parseScrollers,
} from '../src/domain/parse-detail.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

const ACTIVE = 'j_id146:processoPartesPoloAtivoResumidoList';
const PASSIVE = 'j_id146:processoPartesPoloPassivoResumidoList';

describe('isSealed', () => {
  it('is not sealed when "Dados do Processo" is present', () => {
    expect(isSealed('<html>Dados do Processo</html>')).toBe(false);
  });

  it('is sealed when the heading is absent', () => {
    expect(isSealed('<html>nothing here</html>')).toBe(true);
  });

  it('is sealed when the page explicitly says segredo de justiça', () => {
    expect(isSealed('<html>Processo em segredo de justiça</html>')).toBe(true);
  });

  it('reads the hand-derived sealed fixture as sealed', () => {
    expect(isSealed(fixture('detail-sealed.html'))).toBe(true);
  });

  it('reads a real ordinary detail page as not sealed', () => {
    expect(isSealed(fixture('detail-with-pagination.html'))).toBe(false);
  });
});

describe('parseCaseHeader', () => {
  it('reads every header field from a real detail page', () => {
    const header = parseCaseHeader(fixture('detail-with-pagination.html'));

    expect(header).toEqual({
      number: '0803385-67.2025.4.05.0000',
      filingDate: '2025-03-05',
      judicialClass: 'AGRAVO DE INSTRUMENTO (202)',
      // Two subject rubrics on this case, joined: the field is a single string.
      subject:
        'DIREITO PROCESSUAL CIVIL E DO TRABALHO (8826) - Partes e Procuradores (8842) - ' +
        'Substituição da Parte (9494; DIREITO PROCESSUAL CIVIL E DO TRABALHO (8826) - ' +
        'Liquidação / Cumprimento / Execução (9148) - Valor da Execução / Cálculo / ' +
        'Atualização (9149) - Juros (10684',
      jurisdiction: 'TRF5',
      court: 'Pleno',
      address:
        'Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife, ' +
        'RECIFE - PE - CEP: 50030-908',
      referenceCase: '0803391-30.2016.4.05.8200',
    });
  });

  it('returns an empty header for markup with no propertyView blocks', () => {
    expect(parseCaseHeader('<html>nothing</html>')).toEqual({});
  });
});

describe('parseParties', () => {
  it('parses a party with no document, only a role', () => {
    const html = `
      <table id="t"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="text-bold">JOHN DOE (TESTEMUNHA)</span></div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    expect(parseParties(html, 't')).toEqual([{ name: 'JOHN DOE', role: 'TESTEMUNHA', status: 'Ativo' }]);
  });

  it('parses an attorney line with both OAB and CPF', () => {
    const html = `
      <table id="t"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="">A B - OAB SP123 - CPF: 999.999.999-99 (ADVOGADO)</span></div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    expect(parseParties(html, 't')).toEqual([
      {
        name: 'A B',
        role: 'ADVOGADO',
        document: { kind: 'CPF', value: '999.999.999-99' },
        oab: 'SP123',
        status: 'Ativo',
      },
    ]);
  });

  it('does not read representation metadata (e.g. "Procuradoria") as a separate party', () => {
    // Real trap: a nested <span title="Procuradoria"> sits inside a <ul> below
    // the party's own span. Selecting all class-less spans in the cell used to
    // read this as a second, bogus party.
    const html = `
      <table id="t"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="text-bold">CORP LTDA - CNPJ: 11.111.111/0001-11 (AGRAVANTE)</span>
          <ul><li><small class="text-muted"><span title="Procuradoria">Procuradoria Geral Federal (PGF/AGU)</span></small></li></ul>
        </div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    const parties = parseParties(html, 't');

    expect(parties).toHaveLength(1);
    expect(parties[0]?.name).toBe('CORP LTDA');
  });

  it('extracts the sole active party from a real detail page', () => {
    expect(parseParties(fixture('detail-with-pagination.html'), ACTIVE)).toEqual([
      {
        name: 'INSTITUTO NACIONAL DE COLONIZACAO E REFORMA AGRARIA',
        role: 'AGRAVANTE',
        document: { kind: 'CNPJ', value: '00.375.972/0001-60' },
        status: 'Ativo',
      },
    ]);
  });

  it("extracts page 1's 10 passive parties from a real detail page", () => {
    const parties = parseParties(fixture('detail-with-pagination.html'), PASSIVE);

    expect(parties).toHaveLength(10);
    expect(parties.map((p) => p.role)).toEqual(
      expect.arrayContaining(['AGRAVADO', 'ADVOGADO']),
    );
    // Accents survive.
    expect(parties.some((p) => p.name === 'MERCIA VIDAL LEAL')).toBe(true);
  });

  it("extracts page 2's 2 remaining passive parties from the AJAX fixture", () => {
    const parties = parseParties(fixture('detail-page2-ajax.html'), PASSIVE);

    expect(parties).toHaveLength(2);
    expect(parties.every((p) => p.role === 'ADVOGADO')).toBe(true);
  });

  it('returns nothing for a table that does not exist', () => {
    expect(parseParties('<html></html>', 'nonexistent')).toEqual([]);
  });
});

describe('parseMovements', () => {
  it('parses a simple dated entry', () => {
    const html = `
      <table id="j_id146:processoEvento"><tbody><tr>
        <td><span>05/03/2025 18:49:34 - Juntada de certidão</span></td>
      </tr></tbody></table>`;

    expect(parseMovements(html)).toEqual([{ date: '2025-03-05', description: 'Juntada de certidão' }]);
  });

  it('extracts all 15 movements from a real detail page, in accented Portuguese', () => {
    const movements = parseMovements(fixture('detail-with-pagination.html'));

    expect(movements).toHaveLength(15);
    expect(movements.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date))).toBe(true);
    expect(movements.some((m) => m.description.includes('certidão'))).toBe(true);
  });
});

describe('parseDocuments', () => {
  it('keeps a document with a real download link and all its identifiers', () => {
    const html = `
      <table id="j_id146:processoDocumentoGridTab"><tbody><tr>
        <td><a href="/x?idBin=123&numeroDocumento=abc&nomeArqProcDocBin=Despacho&idProcessoDocumento=456&actionMethod=foo">
          18/07/2025 09:27:31 - Despacho (Despacho)
        </a></td>
      </tr></tbody></table>`;

    expect(parseDocuments(html)).toEqual([
      {
        date: '2025-07-18',
        name: 'Despacho',
        kind: 'Despacho',
        idBin: '123',
        numeroDocumento: 'abc',
        nomeArqProcDocBin: 'Despacho',
        idProcessoDocumento: '456',
        actionMethod: 'foo',
      },
    ]);
  });

  it('skips a document with no downloadable binary (view-only popup)', () => {
    const html = `
      <table id="j_id146:processoDocumentoGridTab"><tbody><tr>
        <td><a href="#" onclick="openPopUp(...)">29/12/2025 10:25:55 - Decisão (Decisão)</a></td>
      </tr></tbody></table>`;

    expect(parseDocuments(html)).toEqual([]);
  });

  it('extracts all 14 downloadable documents from a real detail page', () => {
    const documents = parseDocuments(fixture('detail-with-pagination.html'));

    expect(documents).toHaveLength(14);
    for (const doc of documents) {
      expect(doc.idBin).toMatch(/^\d+$/);
      expect(doc.numeroDocumento).not.toBe('');
      expect(doc.idProcessoDocumento).toMatch(/^\d+$/);
      expect(doc.actionMethod).toContain('processoDocumentoBinHome');
    }
  });

  it('decodes accented file names correctly: the real trap is latin-1, not UTF-8', () => {
    // "Despacho Inspeção - 1141 - INSPEÇÃO GERAL ORDINÁRIA DE 2023" is what the
    // link's query string spells as "Despacho+Inspe%E7%E3o+-+1141+-+INSPE%C7%C3O...".
    // Those are latin-1 codepoints (%E7 = ç, %C7 = Ç), not UTF-8 sequences: decoding
    // with UTF-8 (the default for the rest of the site's AJAX responses) corrupts it.
    const documents = parseDocuments(fixture('detail-with-pagination.html'));
    const inspecao = documents.find((d) => d.idBin === '2674278');

    expect(inspecao?.nomeArqProcDocBin).toBe('Despacho Inspeção - 1141 - INSPEÇÃO GERAL ORDINÁRIA DE 2023');
  });

  it('returns nothing when the table has no rows', () => {
    expect(parseDocuments('<html></html>')).toEqual([]);
  });
});

describe('decodeLatin1QueryValue', () => {
  it('decodes latin-1 percent-encoding, not UTF-8', () => {
    expect(decodeLatin1QueryValue('Inspe%E7%E3o')).toBe('Inspeção');
    expect(decodeLatin1QueryValue('INSPE%C7%C3O')).toBe('INSPEÇÃO');
  });

  it('treats + as a space, as in any application/x-www-form-urlencoded value', () => {
    expect(decodeLatin1QueryValue('Inteiro+Teor')).toBe('Inteiro Teor');
  });

  it('passes plain ASCII through unchanged', () => {
    expect(decodeLatin1QueryValue('Despacho')).toBe('Despacho');
  });
});

describe('parseScrollers', () => {
  it('reads a two-page scroller and its base/scroller ids', () => {
    const scrollers = parseScrollers(fixture('detail-with-pagination.html'));

    expect(scrollers.passiveParties).toEqual({
      baseId: 'j_id146:processoPartesPoloPassivoResumidoList:j_id401',
      scrollerId: 'j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402',
      pageCount: 2,
    });
  });

  it('reads a single, hidden scroller (active parties) as one page', () => {
    const scrollers = parseScrollers(fixture('detail-with-pagination.html'));

    expect(scrollers.activeParties?.pageCount).toBe(1);
  });

  it('reports no scroller at all when the table renders none (movements, in this fixture)', () => {
    // Movements fit on one page here, and the markup has no scroller
    // registration whatsoever for that table — not even a hidden one, unlike
    // parties. Both cases mean "one page", but this is the harsher case: no
    // id to even name a scroller by.
    const scrollers = parseScrollers(fixture('detail-with-pagination.html'));

    expect(scrollers.movements).toBeUndefined();
  });

  it('returns nothing for markup with no scrollers at all', () => {
    expect(parseScrollers('<html></html>')).toEqual({});
  });
});
