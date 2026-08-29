/**
 * Parsing of the case detail view.
 *
 * Every function here is pure: `(html) => T`, tested against fixtures without
 * network. The detail page packs three things a caller needs before it can
 * finish extracting a case:
 *
 *   1. The header fields, parties and (usually) all movements and documents,
 *      all present on the first GET.
 *   2. The datascroller ids and page counts for whichever tables paginate, so
 *      `PjeDetail` (in `src/pje/detail.ts`) knows what else to walk.
 *   3. Whether the case is under segredo de justiça, in which case most of
 *      the above is simply absent rather than an error.
 */

import * as cheerio from 'cheerio';

import type {
  CaseDocument,
  DatascrollerInfo,
  DetailScrollers,
  Movement,
  Party,
} from './types.js';

/** "DD/MM/YYYY - description" or "DD/MM/YYYY HH:MM:SS - description". */
const RE_DATED_ENTRY = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{2}:\d{2}:\d{2})?\s*-\s*(.+)$/s;

/** CPF or CNPJ, however the party line spells it: "CPF: 123.456.789-00". */
const RE_DOCUMENT = /(CPF|CNPJ):\s*([\d./-]+)/;

/** "OAB PB18409" right after the name. */
const RE_OAB = /OAB\s+([A-Z]{2}\d+)/;

/** The role in parentheses at the end of the party line: "(AGRAVANTE)". */
const RE_ROLE = /\(([^()]+)\)\s*$/;

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Converts a captured DD/MM/YYYY (optionally with a time) to ISO 8601 (date only). */
function toIsoDate(day: string, month: string, year: string): string {
  return `${year}-${month}-${day}`;
}

/**
 * Decodes a query-string value that was percent-encoded as **latin-1**, not
 * UTF-8.
 *
 * The rest of the site's AJAX responses arrive as UTF-8 (PROBLEMS.md §8), but
 * the `nomeArqProcDocBin` parameter on document links is the one exception
 * found so far: accents there decode to `%E7` (ç), `%E3` (ã), `%C1` (Á) —
 * latin-1 codepoints, not UTF-8 sequences. Decoding it as UTF-8 corrupts every
 * accented file name ("Inspeção" becomes garbage). `+` also stands for space,
 * as in any `application/x-www-form-urlencoded` value.
 */
export function decodeLatin1QueryValue(raw: string): string {
  const withSpaces = raw.replace(/\+/g, ' ');
  const bytes: number[] = [];

  for (let i = 0; i < withSpaces.length; i++) {
    if (withSpaces[i] === '%' && i + 2 < withSpaces.length) {
      const hex = withSpaces.slice(i + 1, i + 3);
      const byte = Number.parseInt(hex, 16);
      if (!Number.isNaN(byte)) {
        bytes.push(byte);
        i += 2;
        continue;
      }
    }
    bytes.push(withSpaces.charCodeAt(i));
  }

  return Buffer.from(bytes).toString('latin1');
}

/** How a detail-view GET response was classified. */
export type DetailPageKind =
  | { kind: 'sealed' }
  | { kind: 'detail' }
  | { kind: 'unexpected'; reason: string };

/**
 * Classifies what a detail-view GET actually returned.
 *
 * Three-way on purpose, not a boolean: the only positive signal for a case
 * under segredo de justiça is the site's own wording ("segredo de justiça" /
 * "autos sigilosos"). The "Dados do Processo" heading being present is what
 * marks an ordinary case. **Its absence alone is not enough to call a page
 * sealed** — a database error page rendered as HTML, a dropped session that
 * `session.open()`'s GET does not otherwise catch (unlike `post()`, which
 * retries once on the same signal), or a changed layout all lack that heading
 * too, and none of them is the same domain state as a real sealed case.
 * Collapsing "unrecognised" into "sealed" would persist a failure as if it
 * were real, sealed data, and it would never be retried.
 *
 * `unexpected` carries a short `reason` for the run log; the caller decides
 * whether to throw, retry or record it as a failure (see
 * `UnexpectedDetailPageError` in `src/domain/errors.ts`) — that decision does
 * not belong in a pure parser.
 */
export function classifyDetailPage(html: string): DetailPageKind {
  if (/segredo de justi[çc]a|autos? sigiloso/i.test(html)) {
    return { kind: 'sealed' };
  }
  if (html.includes('Dados do Processo')) {
    return { kind: 'detail' };
  }
  if (/PSQLException|SQLException|Stacktrace completo/i.test(html)) {
    return { kind: 'unexpected', reason: 'database error page' };
  }
  return { kind: 'unexpected', reason: 'no detail panel' };
}

/** Header fields shown in the "Dados do Processo" panel. */
export interface CaseHeader {
  number?: string;
  filingDate?: string;
  judicialClass?: string;
  subject?: string;
  jurisdiction?: string;
  court?: string;
  address?: string;
  referenceCase?: string;
}

/**
 * Parses the header panel.
 *
 * Each field sits in a `.propertyView` block with a `<label>` and a
 * `.value`. Two of the six cells share no label of their own — one holds
 * "Órgão Julgador Colegiado" and "Endereço" stacked with `<b>` sub-labels, the
 * other just "Órgão Julgador" — so those two are matched by content instead
 * of by their (empty) `<label>`.
 */
export function parseCaseHeader(html: string): CaseHeader {
  const $ = cheerio.load(html);
  const header: CaseHeader = {};

  $('.propertyView').each((_, element) => {
    const $prop = $(element);
    const label = squash($prop.find('.name label').text());
    const rawValue = $prop.find('.value').first().text();
    const value = squash(rawValue);
    if (value === '') return;

    switch (label) {
      case 'Número Processo':
        header.number = value;
        break;
      case 'Data da Distribuição':
        header.filingDate = toIsoFromForm(value);
        break;
      case 'Classe Judicial':
        header.judicialClass = value;
        break;
      case 'Assunto':
        // A case can carry more than one subject rubric, one per line in the
        // markup; joined with "; " since the field is a single string.
        header.subject = rawValue
          .split('\n')
          .map((line) => squash(line))
          .filter((line) => line !== '')
          .join('; ');
        break;
      case 'Jurisdição':
        header.jurisdiction = value;
        break;
      case 'Processo referência':
        header.referenceCase = value;
        break;
      case '': {
        // One of the two unlabelled cells: court info (with address) or the
        // judging body alone. Distinguished by which sub-labels they carry.
        if (/Endereço/.test(value)) {
          const court = /Órgão Julgador Colegiado\s*(.*?)\s*Endereço/.exec(value)?.[1];
          const address = /Endereço\s*(.*)$/.exec(value)?.[1];
          if (court !== undefined && court !== '') header.court = court;
          if (address !== undefined && address !== '') header.address = address;
        } else if (/Órgão Julgador/.test(value)) {
          // Only set when the collegiate cell above did not already provide one.
          if (header.court === undefined) {
            const court = /Órgão Julgador\s*(.*)$/.exec(value)?.[1];
            if (court !== undefined && court !== '') header.court = court;
          }
        }
        break;
      }
      default:
        break;
    }
  });

  return header;
}

/** Converts a DD/MM/YYYY header value to ISO 8601. Returns the input unchanged if unparsable. */
function toIsoFromForm(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (match === null) return value;
  const [, day, month, year] = match;
  return toIsoDate(day as string, month as string, year as string);
}

/**
 * Parses one party line.
 *
 * The markup packs name, document, OAB and role into a single line of text
 * with no separating elements, e.g.:
 *
 *   BRUNO GUILHERME DE MENEZES - OAB PB18409 - CPF: 011.004.534-31 (ADVOGADO)
 *   MERCIA VIDAL LEAL - CPF: 108.720.784-34 (AGRAVADO)
 *
 * The role in parentheses at the end is the only reliable anchor; everything
 * before it is name plus optional " - OAB ..." / " - CPF/CNPJ: ..." segments.
 */
function parsePartyLine(line: string, status: string | undefined): Party | undefined {
  const text = squash(line);
  if (text === '') return undefined;

  const roleMatch = RE_ROLE.exec(text);
  const role = roleMatch?.[1]?.trim() ?? '';
  const withoutRole = roleMatch !== null ? text.slice(0, roleMatch.index).trim() : text;

  const oabMatch = RE_OAB.exec(withoutRole);
  const docMatch = RE_DOCUMENT.exec(withoutRole);

  // The name is whatever precedes the first " - " that introduces OAB or the
  // document, or the whole remaining text when neither is present.
  const cutPoints = [oabMatch?.index, docMatch?.index].filter(
    (i): i is number => i !== undefined,
  );
  const cut = cutPoints.length > 0 ? Math.min(...cutPoints) : withoutRole.length;
  const name = withoutRole
    .slice(0, cut)
    .replace(/-\s*$/, '')
    .trim();

  if (name === '') return undefined;

  const party: Party = { name, role };
  if (docMatch !== undefined && docMatch !== null) {
    const kind = docMatch[1] as 'CPF' | 'CNPJ';
    party.document = { kind, value: docMatch[2] as string };
  }
  if (oabMatch !== null && oabMatch[1] !== undefined) party.oab = oabMatch[1];
  if (status !== undefined && status !== '') party.status = status;

  return party;
}

/**
 * Parses one side's parties table (active or passive).
 *
 * Each row is one participant: the case party itself (`span.text-bold`) or
 * one of its attorneys (a plain, class-less `span`), one row per person. That
 * span is always the **first** child of the outer `.col-sm-12` div — deeper
 * spans exist too (e.g. `<span title="Procuradoria">...`, nested in a `<ul>`
 * of representation metadata) and must not be read as separate parties.
 *
 * @param tableId The table's id, e.g. `j_id146:processoPartesPoloAtivoResumidoList`.
 */
export function parseParties(html: string, tableId: string): Party[] {
  const $ = cheerio.load(html);
  const parties: Party[] = [];

  $(`table[id="${tableId}"] tbody tr, table[id="${tableId}"] > tbody > tr`).each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    if (cells.length < 2) return;

    const nameCell = cells.eq(0);
    const statusCell = cells.eq(1);
    const status = squash(statusCell.text()) || undefined;

    const span = nameCell.find('div.col-sm-12').first().find('> span').first();
    if (span.length === 0) return;

    const party = parsePartyLine(squash(span.text()), status);
    if (party !== undefined) parties.push(party);
  });

  return parties;
}

/** Parses the movements table. */
export function parseMovements(html: string): Movement[] {
  const $ = cheerio.load(html);
  const movements: Movement[] = [];

  $('table[id$=":processoEvento"] tbody tr, tbody[id$=":processoEvento:tb"] > tr').each(
    (_, row) => {
      const text = squash($(row).find('td').first().text());
      const match = RE_DATED_ENTRY.exec(text);
      if (match === null) return;
      const [, day, month, year, description] = match;
      movements.push({
        date: toIsoDate(day as string, month as string, year as string),
        description: (description as string).trim(),
      });
    },
  );

  return movements;
}

/**
 * Parses the attached documents table.
 *
 * Only rows with a real download link (an `href` carrying `idBin`) become a
 * `CaseDocument` with every identifier ISSUE-6 needs. A document with no
 * binary attached — only a "Visualizar" popup with no querystring — is
 * skipped: there is nothing to download.
 */
export function parseDocuments(html: string): CaseDocument[] {
  const $ = cheerio.load(html);
  const documents: CaseDocument[] = [];

  $('table[id$=":processoDocumentoGridTab"] tbody tr, tbody[id$=":processoDocumentoGridTab:tb"] > tr').each(
    (_, row) => {
      const $row = $(row);
      const link = $row.find('a[href*="idBin="]').first();
      if (link.length === 0) return;

      const href = link.attr('href') ?? '';
      const query = href.split('?')[1] ?? '';
      const params = new URLSearchParams(query);

      const idBin = params.get('idBin');
      const numeroDocumento = params.get('numeroDocumento');
      const idProcessoDocumento = params.get('idProcessoDocumento');
      const actionMethod = params.get('actionMethod');
      // URLSearchParams decodes as UTF-8; this field is latin-1 (see
      // decodeLatin1QueryValue), so it is read from the raw query instead.
      const rawName = /nomeArqProcDocBin=([^&]*)/.exec(query)?.[1] ?? '';
      const nomeArqProcDocBin = decodeLatin1QueryValue(rawName);

      if (
        idBin === null ||
        numeroDocumento === null ||
        idProcessoDocumento === null ||
        actionMethod === null
      ) {
        return;
      }

      const linkText = squash(link.text());
      const match = RE_DATED_ENTRY.exec(linkText);
      const dateFields = match !== null ? [match[1], match[2], match[3]] : undefined;
      const rest = match !== null ? (match[4] as string).trim() : linkText;

      // "Name (Kind)": the kind is the parenthesised suffix, the name is what precedes it.
      const kindMatch = RE_ROLE.exec(rest);
      const name = kindMatch !== null ? rest.slice(0, kindMatch.index).trim() : rest;
      const kind = kindMatch?.[1]?.trim() ?? '';

      documents.push({
        date:
          dateFields !== undefined
            ? toIsoDate(dateFields[0] as string, dateFields[1] as string, dateFields[2] as string)
            : '',
        name,
        kind,
        idBin,
        numeroDocumento,
        nomeArqProcDocBin,
        idProcessoDocumento,
        actionMethod,
      });
    },
  );

  return documents;
}

/**
 * Reads the id, base id and page count of one `Richfaces.Datascroller`.
 *
 * `tableIdSuffix` identifies which table's scroller to read (e.g.
 * `processoPartesPoloPassivoResumidoList` or `processoEvento`): the
 * `new Richfaces.Datascroller('<scrollerId>', function(event){
 * A4J.AJAX.Submit('<baseId>', ...` call is searched for among ids starting
 * with that prefix.
 *
 * A single-page table renders no scroller registration at all (seen for
 * movements) or a hidden, page-link-less one (seen for parties) — both are
 * read as one page, which is why the id itself, not just the page count, is
 * optional: `undefined` means "nothing to walk here".
 */
function parseScroller(html: string, tableIdSuffix: string): DatascrollerInfo | undefined {
  const registerCall = new RegExp(
    `new Richfaces\\.Datascroller\\('([^']*${tableIdSuffix}[^']*)',\\s*function\\(event\\)\\{` +
      `A4J\\.AJAX\\.Submit\\('([^']+)'`,
  );
  const match = registerCall.exec(html);
  if (match === null) return undefined;

  const scrollerId = match[1] as string;
  const baseId = match[2] as string;

  // Page count: the highest numeric page link rendered near this scroller's
  // table (both the active page and the clickable ones), read from the small
  // `rich-dtascroller-table` that immediately precedes the registration
  // script. A single page renders that table with no numeric links at all.
  const registerIndex = match.index;
  const searchStart = html.lastIndexOf('rich-dtascroller-table', registerIndex);
  const scrollerMarkup =
    searchStart === -1 ? '' : html.slice(searchStart, registerIndex);

  const pageNumbers = [...scrollerMarkup.matchAll(/class="\s*rich-datascr-(?:act|inact)\s*"[^>]*>(\d+)</g)]
    .map((m) => Number.parseInt(m[1] as string, 10))
    .filter((n) => !Number.isNaN(n));

  const pageCount = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;

  return { baseId, scrollerId, pageCount };
}

/** Reads the datascroller info for every paginated table in the detail view. */
export function parseScrollers(html: string): DetailScrollers {
  const activeParties = parseScroller(html, 'processoPartesPoloAtivoResumidoList');
  const passiveParties = parseScroller(html, 'processoPartesPoloPassivoResumidoList');
  const movements = parseScroller(html, 'processoEvento');

  return {
    ...(activeParties !== undefined ? { activeParties } : {}),
    ...(passiveParties !== undefined ? { passiveParties } : {}),
    ...(movements !== undefined ? { movements } : {}),
  };
}
