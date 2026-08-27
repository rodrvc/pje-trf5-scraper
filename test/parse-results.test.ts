/**
 * Result parsing tests, against real HTML captured from the site.
 *
 * The fixtures are genuine PJe responses, not hand-written markup: that way the
 * tests fail if the site changes shape, which is exactly what we want to catch.
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

const CAPPED = fixture('results-capped.html');
const UNCAPPED = fixture('results-uncapped.html');
const REJECTED = fixture('rejection-response.html');

describe('parseResultRows', () => {
  it('extracts rows from a real search', () => {
    const rows = parseResultRows(CAPPED);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(30);
  });

  it('pulls the CNJ number and detail token from every row', () => {
    const [first] = parseResultRows(CAPPED);

    expect(first?.number).toMatch(/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/);
    expect(first?.ca).toMatch(/^[a-f0-9]+$/);
  });

  it('splits the cell that packs class, number, subject and parties', () => {
    const rows = parseResultRows(CAPPED);
    const withSubject = rows.find((r) => r.subject !== undefined);
    const withParties = rows.find((r) => r.parties !== undefined);

    expect(withSubject?.subject).toBeTruthy();
    // Parties are recognizable by the " X " separator between sides.
    expect(withParties?.parties).toContain(' X ');
  });

  it('preserves Portuguese accents', () => {
    const rows = parseResultRows(CAPPED);
    const text = rows.map((r) => r.judicialClass ?? '').join(' ');

    // Wrong encoding would surface as "APELAÃÃO".
    expect(text).not.toContain('Ã§');
    expect(text).not.toContain('ÃƒO');
  });

  it('invents no rows when there is no table', () => {
    expect(parseResultRows('<html><body>nothing</body></html>')).toEqual([]);
  });

  it('drops rows without a number or token, which carry nothing useful', () => {
    const html = `
      <table id="fPP:processosTable"><tbody>
        <tr><td><a onclick="openPopUp('x','/listView.seam?ca=abc123')"></a></td>
            <td>NO NUMBER HERE</td><td>movement</td></tr>
      </tbody></table>`;

    expect(parseResultRows(html)).toEqual([]);
  });
});

describe('isCapped', () => {
  it('detects the server warning', () => {
    expect(isCapped(CAPPED, 30)).toBe(true);
  });

  it('does not flag a search that returned few results', () => {
    expect(isCapped(UNCAPPED, 10)).toBe(false);
  });

  it('flags the cap on row count even when the warning is missing', () => {
    // Defensive: a silent truncation would create an invisible coverage gap.
    expect(isCapped('<html>no warning</html>', 30)).toBe(true);
  });

  it('does not flag below the cap', () => {
    expect(isCapped('<html>no warning</html>', 29)).toBe(false);
  });
});

describe('extractRejectionMessage', () => {
  it('reads the reason the server puts in the message panel', () => {
    const message = extractRejectionMessage(REJECTED);

    expect(message).toContain('dois nomes');
    // The accent must survive: the AJAX response arrives as UTF-8.
    expect(message).toContain('É necessário');
  });

  it('returns undefined when the panel is empty', () => {
    expect(extractRejectionMessage(UNCAPPED)).toBeUndefined();
  });
});

describe('parseSearchResponse', () => {
  it('a capped search returns rows plus the cap flag', () => {
    const response = parseSearchResponse(CAPPED);

    expect(response.capped).toBe(true);
    expect(response.rows.length).toBeGreaterThan(0);
  });

  it('a rejected query has no rows but does carry the reason', () => {
    const response = parseSearchResponse(REJECTED);

    expect(response.rows).toEqual([]);
    expect(response.rejectionMessage).toContain('dois nomes');
  });

  it('an ordinary search is not flagged as capped', () => {
    const response = parseSearchResponse(UNCAPPED);

    expect(response.capped).toBe(false);
    expect(response.rejectionMessage).toBeUndefined();
  });
});
