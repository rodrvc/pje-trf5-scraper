/**
 * Case detail parsing tests.
 *
 * Inline HTML documents the exact shape being parsed; the captured fixtures
 * pin fidelity to the real markup, including its traps (see below).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertTotalMatches,
  classifyDetailPage,
  countTableRows,
  decodeLatin1QueryValue,
  firstRowIndex,
  parseActiveParties,
  parseAllPagers,
  parseCaseHeader,
  parseDocuments,
  parseMovements,
  parsePassiveParties,
  parsePager,
  readDeclaredTotal,
} from '../src/domain/parse-detail.js';
import { ParseError } from '../src/domain/errors.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('classifyDetailPage', () => {
  it('classifies an ordinary page by the "Dados do Processo" heading', () => {
    expect(classifyDetailPage('<html>Dados do Processo</html>')).toEqual({ kind: 'detail' });
  });

  it('classifies the page as sealed only on the positive segredo/sigilo text inside the notice panel', () => {
    const html = `<html><dl class="rich-messages"><dd>Processo em segredo de justiça</dd></dl></html>`;
    expect(classifyDetailPage(html)).toEqual({ kind: 'sealed' });

    const html2 = `<html><span class="rich-messages-label">Autos sigilosos</span></html>`;
    expect(classifyDetailPage(html2)).toEqual({ kind: 'sealed' });
  });

  it('does NOT scan the whole page for the sealed wording: a movement mentioning it is not sealed', () => {
    // This is the fix for a real false positive: "pedido de segredo de
    // justiça indeferido" (a request for secrecy that was DENIED) is a common,
    // entirely ordinary movement in a public case. Matching free text
    // anywhere on the page would misclassify this case as sealed and discard
    // real data - the wording only counts inside the notice panel.
    const html = `
      <html>
        Dados do Processo
        <table id="j_id146:processoEvento"><tbody><tr>
          <td><span>01/01/2025 - Pedido de segredo de justiça indeferido</span></td>
        </tr></tbody></table>
      </html>`;

    expect(classifyDetailPage(html)).toEqual({ kind: 'detail' });
  });

  it('does NOT call an unrecognised page sealed: it is "unexpected" instead', () => {
    // This is the core fix: a page with neither the heading nor the sealed
    // wording (a dropped session, a changed layout) must not be silently
    // treated as valid sealed-case data.
    expect(classifyDetailPage('<html>nothing recognisable here</html>')).toEqual({
      kind: 'unexpected',
      reason: 'no detail panel',
    });
  });

  it('classifies a database error page as "unexpected", not sealed', () => {
    // Real capture: case 0804011-36.2025.4.05.8100 returned this instead of
    // the detail view. It lacks "Dados do Processo" just like a sealed case
    // would, which is exactly why a second, independent signal is needed.
    const classification = classifyDetailPage(fixture('detail-server-error.html'));

    expect(classification).toEqual({ kind: 'unexpected', reason: 'database error page' });
  });

  it('reads the hand-derived sealed fixture as sealed', () => {
    expect(classifyDetailPage(fixture('detail-sealed.html'))).toEqual({ kind: 'sealed' });
  });

  it('reads a real ordinary detail page as "detail"', () => {
    expect(classifyDetailPage(fixture('detail-with-pagination.html'))).toEqual({ kind: 'detail' });
  });
});

describe('parseCaseHeader', () => {
  it('reads every header field from a real detail page', () => {
    const header = parseCaseHeader(fixture('detail-with-pagination.html'));

    expect(header).toEqual({
      number: '0803385-67.2025.4.05.0000',
      filingDate: '2025-03-05',
      judicialClass: 'AGRAVO DE INSTRUMENTO (202)',
      // Two subject rubrics on this case, joined: the field is a single
      // string. Note the missing closing parens ("Substituição da Parte
      // (9494" with no ")") - that is not a parsing bug, the site's own
      // markup drops them.
      subject:
        'DIREITO PROCESSUAL CIVIL E DO TRABALHO (8826) - Partes e Procuradores (8842) - ' +
        'Substituição da Parte (9494; DIREITO PROCESSUAL CIVIL E DO TRABALHO (8826) - ' +
        'Liquidação / Cumprimento / Execução (9148) - Valor da Execução / Cálculo / ' +
        'Atualização (9149) - Juros (10684',
      jurisdiction: 'TRF5',
      // Collegiate body and chamber are two distinct fields, both present on
      // this case: "Pleno" (the collegiate body) and its own chamber.
      court: 'Pleno',
      judgingBody: 'Gab VICE-PRESIDÊNCIA',
      address:
        'Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife, ' +
        'RECIFE - PE - CEP: 50030-908',
      referenceCase: '0803391-30.2016.4.05.8200',
    });
  });

  it('keeps court and judgingBody as separate fields when both are present', () => {
    const html = `
      <div class="propertyView"><div class="name"><label></label></div>
        <div class="value col-sm-12">Órgão Julgador Colegiado Turma Recursal Endereço Rua X, 1</div></div>
      <div class="propertyView"><div class="name"><label></label></div>
        <div class="value col-sm-12">Órgão Julgador 3ª Vara Federal</div></div>`;

    const header = parseCaseHeader(html);

    expect(header.court).toBe('Turma Recursal');
    expect(header.judgingBody).toBe('3ª Vara Federal');
    expect(header.address).toBe('Rua X, 1');
  });

  it('returns an empty header for markup with no propertyView blocks', () => {
    expect(parseCaseHeader('<html>nothing</html>')).toEqual({});
  });
});

describe('parseActiveParties / parsePassiveParties', () => {
  it('parses a party with no document, only a role', () => {
    const html = `
      <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="text-bold">JOHN DOE (TESTEMUNHA)</span></div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    expect(parseActiveParties(html)).toEqual([{ name: 'JOHN DOE', role: 'TESTEMUNHA', status: 'Ativo' }]);
  });

  it('parses an attorney line with both OAB and CPF', () => {
    const html = `
      <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="">A B - OAB SP123 - CPF: 999.999.999-99 (ADVOGADO)</span></div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    expect(parseActiveParties(html)).toEqual([
      {
        name: 'A B',
        role: 'ADVOGADO',
        document: { kind: 'CPF', value: '999.999.999-99' },
        oab: 'SP123',
        status: 'Ativo',
      },
    ]);
  });

  it('parses an OAB registration with a letter suffix (e.g. PE12345A)', () => {
    // Some state bars append a letter to supplementary/provisional
    // registrations; the plain digits-only pattern used to miss these.
    const html = `
      <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="">C D - OAB PE12345A - CPF: 888.888.888-88 (ADVOGADO)</span></div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    expect(parseActiveParties(html)[0]?.oab).toBe('PE12345A');
  });

  it('does not read representation metadata (e.g. "Procuradoria") as a separate party', () => {
    // Real trap: a nested <span title="Procuradoria"> sits inside a <ul> below
    // the party's own span. Selecting all class-less spans in the cell used to
    // read this as a second, bogus party.
    const html = `
      <table id="j_id146:processoPartesPoloAtivoResumidoList"><tbody><tr>
        <td><span><div class="col-sm-12"><span class="text-bold">CORP LTDA - CNPJ: 11.111.111/0001-11 (AGRAVANTE)</span>
          <ul><li><small class="text-muted"><span title="Procuradoria">Procuradoria Geral Federal (PGF/AGU)</span></small></li></ul>
        </div></span></td>
        <td>Ativo</td>
      </tr></tbody></table>`;

    const parties = parseActiveParties(html);

    expect(parties).toHaveLength(1);
    expect(parties[0]?.name).toBe('CORP LTDA');
  });

  it('extracts the sole active party from a real detail page', () => {
    expect(parseActiveParties(fixture('detail-with-pagination.html'))).toEqual([
      {
        name: 'INSTITUTO NACIONAL DE COLONIZACAO E REFORMA AGRARIA',
        role: 'AGRAVANTE',
        document: { kind: 'CNPJ', value: '00.375.972/0001-60' },
        status: 'Ativo',
      },
    ]);
  });

  it("extracts page 1's 10 passive parties from a real detail page", () => {
    const parties = parsePassiveParties(fixture('detail-with-pagination.html'));

    expect(parties).toHaveLength(10);
    expect(parties.map((p) => p.role)).toEqual(expect.arrayContaining(['AGRAVADO', 'ADVOGADO']));
    // Accents survive.
    expect(parties.some((p) => p.name === 'MERCIA VIDAL LEAL')).toBe(true);
  });

  it("extracts page 2's 2 remaining passive parties from the AJAX fixture", () => {
    const parties = parsePassiveParties(fixture('detail-page2-ajax.html'));

    expect(parties).toHaveLength(2);
    expect(parties.every((p) => p.role === 'ADVOGADO')).toBe(true);
  });

  it('returns nothing for a table that does not exist', () => {
    expect(parseActiveParties('<html></html>')).toEqual([]);
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

  it("extracts page 1's 15 movements from a real detail page, in accented Portuguese", () => {
    // The full case has 75 movements over 5 pages (a Richfaces.Slider pager,
    // not a Datascroller - see parseAllPagers below); this fixture only
    // captured the first page.
    const movements = parseMovements(fixture('detail-with-pagination.html'));

    expect(movements).toHaveLength(15);
    expect(movements.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date))).toBe(true);
    expect(movements.some((m) => m.description.includes('certidão'))).toBe(true);
  });
});

describe('parseDocuments', () => {
  it('keeps a document with a real download link and groups its identifiers under `download`', () => {
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
        download: {
          idBin: '123',
          numeroDocumento: 'abc',
          nomeArqProcDocBin: 'Despacho',
          idProcessoDocumento: '456',
          actionMethod: 'foo',
        },
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

  it("extracts page 1's 14 downloadable documents from a real detail page", () => {
    // The full case has 20 documents over 2 slider pages; this fixture only
    // captured the first page (14 downloadable + 1 view-only = 15 rows).
    const documents = parseDocuments(fixture('detail-with-pagination.html'));

    expect(documents).toHaveLength(14);
    for (const doc of documents) {
      expect(doc.download.idBin).toMatch(/^\d+$/);
      expect(doc.download.numeroDocumento).not.toBe('');
      expect(doc.download.idProcessoDocumento).toMatch(/^\d+$/);
      expect(doc.download.actionMethod).toContain('processoDocumentoBinHome');
    }
  });

  it('decodes accented file names correctly: the real trap is latin-1, not UTF-8', () => {
    // "Despacho Inspeção - 1141 - INSPEÇÃO GERAL ORDINÁRIA DE 2023" is what the
    // link's query string spells as "Despacho+Inspe%E7%E3o+-+1141+-+INSPE%C7%C3O...".
    // Those are latin-1 codepoints (%E7 = ç, %C7 = Ç), not UTF-8 sequences: decoding
    // with UTF-8 (the default for the rest of the site's AJAX responses) corrupts it.
    const documents = parseDocuments(fixture('detail-with-pagination.html'));
    const inspecao = documents.find((d) => d.download.idBin === '2674278');

    expect(inspecao?.download.nomeArqProcDocBin).toBe(
      'Despacho Inspeção - 1141 - INSPEÇÃO GERAL ORDINÁRIA DE 2023',
    );
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

describe('parsePager / parseAllPagers', () => {
  it('reads a two-page datascroller and its base/page-field ids', () => {
    const pager = parsePager(fixture('detail-with-pagination.html'), 'processoPartesPoloPassivoResumidoList');

    expect(pager).toEqual({
      kind: 'datascroller',
      baseId: 'j_id146:processoPartesPoloPassivoResumidoList:j_id401',
      pageFieldId: 'j_id146:processoPartesPoloPassivoResumidoList:j_id401:j_id402',
      pageCount: 2,
    });
  });

  it('reads a single, hidden datascroller (active parties) as one page', () => {
    const pager = parsePager(fixture('detail-with-pagination.html'), 'processoPartesPoloAtivoResumidoList');

    expect(pager?.pageCount).toBe(1);
  });

  it('reads the movements table as a 5-page Richfaces.Slider, not a datascroller', () => {
    // This is the pagination bug the review caught: movements and documents on
    // this site paginate with a Richfaces.Slider (a 1..maxValue drag control),
    // a different widget with a different AJAX shape from the parties tables'
    // Datascroller. A parser that only recognised Datascroller silently
    // truncated 75 movements down to the 15 on page 1.
    const pager = parsePager(fixture('detail-with-pagination.html'), 'processoEvento');

    expect(pager).toMatchObject({ kind: 'slider', pageCount: 5 });
    if (pager?.kind === 'slider') {
      expect(pager.baseId).toBe('j_id146:j_id561');
      expect(pager.pageFieldId).toBe('j_id146:j_id561:j_id562');
      expect(pager.eventFieldId).toBe('j_id146:j_id561:j_id563');
    }
  });

  it('reads the documents table as a 2-page Richfaces.Slider', () => {
    const pager = parsePager(fixture('detail-with-pagination.html'), 'processoDocumentoGridTab');

    expect(pager).toMatchObject({ kind: 'slider', pageCount: 2 });
    if (pager?.kind === 'slider') {
      expect(pager.baseId).toBe('j_id146:j_id653');
      expect(pager.pageFieldId).toBe('j_id146:j_id653:j_id654');
      expect(pager.eventFieldId).toBe('j_id146:j_id653:j_id655');
    }
  });

  it('does not pick up a later table\'s slider for a table with no pager of its own', () => {
    // Parties tables paginate with a Datascroller and have no slider of their
    // own; without bounding the search, looking for "the nearest slider after
    // this table" would walk straight past them and find movements' slider
    // instead.
    const pager = parsePager(fixture('detail-with-pagination.html'), 'processoPartesPoloAtivoResumidoList');

    expect(pager?.kind).toBe('datascroller');
  });

  it('reads pagers for all four tables at once', () => {
    const pagers = parseAllPagers(fixture('detail-with-pagination.html'));

    expect(pagers.activeParties?.kind).toBe('datascroller');
    expect(pagers.passiveParties).toMatchObject({ kind: 'datascroller', pageCount: 2 });
    expect(pagers.movements).toMatchObject({ kind: 'slider', pageCount: 5 });
    expect(pagers.documents).toMatchObject({ kind: 'slider', pageCount: 2 });
  });

  it('returns nothing for markup with no pagers at all', () => {
    expect(parseAllPagers('<html></html>')).toEqual({});
  });
});

describe('readDeclaredTotal', () => {
  it('reads each real table\'s own declared total', () => {
    const html = fixture('detail-with-pagination.html');

    expect(readDeclaredTotal(html, 'processoPartesPoloAtivoResumidoList')).toBe(1);
    expect(readDeclaredTotal(html, 'processoPartesPoloPassivoResumidoList')).toBe(12);
    expect(readDeclaredTotal(html, 'processoEvento')).toBe(75);
    expect(readDeclaredTotal(html, 'processoDocumentoGridTab')).toBe(20);
  });

  it('returns undefined when the table is not present', () => {
    expect(readDeclaredTotal('<html></html>', 'processoEvento')).toBeUndefined();
  });
});

describe('countTableRows', () => {
  it('counts every row, downloadable or not', () => {
    // 14 downloadable + 1 view-only = 15 rows, though parseDocuments() only
    // returns 14: the row count and the parsed count are different things on
    // purpose (see assertTotalMatches).
    expect(countTableRows(fixture('detail-with-pagination.html'), 'processoDocumentoGridTab')).toBe(15);
  });
});

describe('firstRowIndex', () => {
  it('reads the absolute index of the first row (page 1 starts at 0)', () => {
    expect(firstRowIndex(fixture('detail-with-pagination.html'), 'processoPartesPoloPassivoResumidoList')).toBe(0);
  });

  it('reads a page-2 response\'s first row as starting past page 1 (index 10, not 0)', () => {
    expect(firstRowIndex(fixture('detail-page2-ajax.html'), 'processoPartesPoloPassivoResumidoList')).toBe(10);
  });

  it('returns undefined when the table has no rows', () => {
    expect(firstRowIndex('<html></html>', 'processoEvento')).toBeUndefined();
  });
});

describe('assertTotalMatches', () => {
  it('does nothing when the counts agree', () => {
    expect(() => assertTotalMatches('processoEvento', 15, 15)).not.toThrow();
  });

  it('does nothing when no total was declared (nothing to check against)', () => {
    expect(() => assertTotalMatches('processoEvento', undefined, 3)).not.toThrow();
  });

  it('throws ParseError when the collected count falls short of the declared total', () => {
    // This is what would have caught the truncation bug directly: 75
    // declared, only 15 actually collected.
    expect(() => assertTotalMatches('processoEvento', 75, 15)).toThrow(ParseError);
  });

  it('throws ParseError when the collected count exceeds the declared total (duplicates)', () => {
    expect(() => assertTotalMatches('processoEvento', 12, 22)).toThrow(ParseError);
  });
});
