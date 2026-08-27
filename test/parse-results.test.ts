/**
 * Result parsing tests.
 *
 * Most cases use minimal inline HTML, so each test shows exactly what goes in
 * and what comes out. The real fixtures — full responses captured from PJe — are
 * kept for the cases where fidelity to the live markup is the point.
 *
 * What these fixtures can and cannot do: being frozen copies, they verify that
 * the parsers still behave as they did against the markup as it was captured.
 * They **cannot** detect that the live site has changed — by construction, a
 * stored fixture never changes. Guarding against site drift needs a live check,
 * which is what the startup preflight is for.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  detectCap,
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

describe('detectCap', () => {
  const WARNING = 'Sua consulta retornou muitos processos, somente os 30 primeiros';

  it('agrees with itself when the server warns and the page is full', () => {
    expect(detectCap(`<div>${WARNING}</div>`, 30)).toEqual({
      capped: true,
      byText: true,
      byCount: true,
      disagree: false,
    });
  });

  it('agrees with itself on an ordinary short response', () => {
    expect(detectCap('<div>10 resultados</div>', 10)).toEqual({
      capped: false,
      byText: false,
      byCount: false,
      disagree: false,
    });
  });

  it('flags disagreement when the page is full but the warning is missing', () => {
    // This is how a change in the server's wording would announce itself. Folding
    // both readings into one boolean would hide it forever behind the row count.
    const signal = detectCap('<div>no warning at all</div>', 30);

    expect(signal.capped).toBe(true); // still capped: the count is load-bearing
    expect(signal.byCount).toBe(true);
    expect(signal.byText).toBe(false);
    expect(signal.disagree).toBe(true);
  });

  it('flags disagreement when the warning appears on a page that is not full', () => {
    const signal = detectCap(`<div>${WARNING}</div>`, 12);

    expect(signal.capped).toBe(true);
    expect(signal.disagree).toBe(true);
  });

  it('does not flag a page one row short of the cap', () => {
    expect(detectCap('<div>no warning</div>', 29).capped).toBe(false);
  });

  it('both readings agree on the live site responses', () => {
    const capped = detectCap(fixture('results-capped.html'), 30);
    const uncapped = detectCap(fixture('results-uncapped.html'), 10);

    expect(capped).toMatchObject({ capped: true, byText: true, byCount: true, disagree: false });
    expect(uncapped).toMatchObject({ capped: false, disagree: false });
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
    // Both readings agree, so nothing about the site has drifted.
    expect(response.capSignal.disagree).toBe(false);
  });

  it('an ordinary query returns its rows and nothing else', () => {
    const response = parseSearchResponse(fixture('results-uncapped.html'));

    expect(response.capped).toBe(false);
    expect(response.rejectionMessage).toBeUndefined();
    expect(response.rows.length).toBeGreaterThan(0);
  });
});
