/**
 * Result parsing tests.
 *
 * Most cases use minimal inline HTML, so each test shows exactly what goes in
 * and what comes out. The real fixtures — full responses captured from PJe — are
 * kept for the cases where fidelity to the live markup is the point.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isCapped,
  extractRejectionMessage,
  parseResultRows,
  parseSearchResponse,
} from '../src/domain/parse-results.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

/**
 * One results row, shaped exactly like PJe's.
 *
 * Note what makes it awkward: the detail token lives in an `onclick` handler
 * rather than an href, and the middle cell packs four fields around a `<b>`
 * with no separators between them.
 */
function resultRow({
  ca = 'abc123',
  cell = 'APELAÇÃO CÍVEL <b>ApCiv 0000462-42.2023.8.17.3480 - Juros</b> DOE X BANK',
  lastMovement = 'Expedição de Certidão. (30/07/2026 11:29:31)',
} = {}): string {
  return `
    <table id="fPP:processosTable"><tbody>
      <tr>
        <td><a onclick="openPopUp('x','/listView.seam?ca=${ca}')">Ver Detalhes</a></td>
        <td>${cell}</td>
        <td>${lastMovement}</td>
      </tr>
    </tbody></table>`;
}

describe('parseResultRows', () => {
  it('pulls every field out of a row', () => {
    const [row] = parseResultRows(resultRow());

    expect(row).toEqual({
      number: '0000462-42.2023.8.17.3480',
      ca: 'abc123',
      judicialClass: 'APELAÇÃO CÍVEL',
      subject: 'Juros',
      parties: 'DOE X BANK',
      lastMovement: 'Expedição de Certidão. (30/07/2026 11:29:31)',
    });
  });

  it('handles a row with no subject after the case number', () => {
    const html = resultRow({ cell: 'MANDADO DE SEGURANÇA <b>MS 0000462-42.2023.8.17.3480</b> DOE X STATE' });

    const [row] = parseResultRows(html);

    expect(row?.number).toBe('0000462-42.2023.8.17.3480');
    expect(row?.parties).toBe('DOE X STATE');
    expect(row?.subject).toBeUndefined();
  });

  it('drops a row with no case number: it cannot be identified', () => {
    expect(parseResultRows(resultRow({ cell: 'NO NUMBER HERE' }))).toEqual([]);
  });

  it('drops a row with no detail token: it cannot be opened', () => {
    const html = `
      <table id="fPP:processosTable"><tbody>
        <tr><td><a>no onclick</a></td>
            <td><b>ApCiv 0000462-42.2023.8.17.3480</b></td><td>x</td></tr>
      </tbody></table>`;

    expect(parseResultRows(html)).toEqual([]);
  });

  it('returns nothing when there is no results table at all', () => {
    expect(parseResultRows('<html><body>nothing</body></html>')).toEqual([]);
  });

  it('reads a real capped response from the live site', () => {
    const rows = parseResultRows(fixture('results-capped.html'));

    expect(rows).toHaveLength(30);
    expect(rows[0]?.number).toMatch(/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/);
    // Accents must survive: the AJAX response arrives as UTF-8.
    expect(rows.map((r) => r.judicialClass).join(' ')).toContain('APELAÇÃO');
  });
});

describe('isCapped', () => {
  const WARNING = 'somente os 30 primeiros processos serão exibidos';

  it('flags the cap when the server says so', () => {
    expect(isCapped(`<div>Sua consulta retornou muitos processos, ${WARNING}</div>`, 30)).toBe(true);
  });

  it('flags the cap on row count alone, in case the warning ever goes missing', () => {
    // Defensive: a silent truncation would leave an invisible coverage gap.
    expect(isCapped('<div>no warning here</div>', 30)).toBe(true);
  });

  it('does not flag anything below the cap', () => {
    expect(isCapped('<div>no warning here</div>', 29)).toBe(false);
  });

  it('agrees with the live site on a capped and an uncapped response', () => {
    expect(isCapped(fixture('results-capped.html'), 30)).toBe(true);
    expect(isCapped(fixture('results-uncapped.html'), 10)).toBe(false);
  });
});

describe('extractRejectionMessage', () => {
  it('reads the reason out of the message panel', () => {
    const html = '<dl class="rich-messages"><dd>É necessário informar ao menos dois nomes</dd></dl>';

    expect(extractRejectionMessage(html)).toBe('É necessário informar ao menos dois nomes');
  });

  it('returns undefined when the panel is empty', () => {
    expect(extractRejectionMessage('<dl class="rich-messages"><dt></dt></dl>')).toBeUndefined();
  });

  it('reads the real rejection PJe sends for a one-word party search', () => {
    expect(extractRejectionMessage(fixture('rejection-response.html'))).toContain(
      'É necessário informar ao menos dois nomes',
    );
  });
});

describe('parseSearchResponse', () => {
  it('a rejected query returns no rows but does carry the reason', () => {
    const response = parseSearchResponse(fixture('rejection-response.html'));

    expect(response.rows).toEqual([]);
    expect(response.capped).toBe(false);
    expect(response.rejectionMessage).toContain('dois nomes');
  });

  it('a capped query returns rows and asks to be split', () => {
    const response = parseSearchResponse(fixture('results-capped.html'));

    expect(response.rows).toHaveLength(30);
    expect(response.capped).toBe(true);
  });

  it('an ordinary query returns its rows and nothing else', () => {
    const response = parseSearchResponse(fixture('results-uncapped.html'));

    expect(response.capped).toBe(false);
    expect(response.rejectionMessage).toBeUndefined();
    expect(response.rows.length).toBeGreaterThan(0);
  });
});
