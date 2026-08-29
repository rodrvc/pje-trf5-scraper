/**
 * Parsing of the case detail view.
 *
 * Every function here is pure: `(html) => T`, tested against fixtures without
 * network. The detail page packs three things a caller needs before it can
 * finish extracting a case:
 *
 *   1. The header fields, both parties tables, movements and documents, all
 *      present on the first GET - but each of the four tables can be capped
 *      to one page of an internal pager, so "present" does not mean
 *      "complete".
 *   2. The pager for each table (kind, ids, page count), so `PjeDetail` (in
 *      `src/pje/detail.ts`) knows what else to walk. This is RichFaces
 *      transport detail - the `pje` layer asks for parsed rows by calling
 *      `parseActiveParties`/`parsePassiveParties`/`parseMovements`/
 *      `parseDocuments`, and separately for the pager, but never needs to
 *      know a table's internal JSF id.
 *   3. Whether the case is under segredo de justiça, in which case most of
 *      the above is simply absent rather than an error.
 *
 * All the RichFaces ids in this file (`processoPartesPoloAtivoResumidoList`,
 * etc.) are matched with `[id$="..."]` suffix selectors, the same way
 * `parse-results.ts` matches `table[id$="processosTable"]`: the `j_id146:`
 * prefix in front of them is a JSF-generated container id that can shift on
 * redeploy, same risk as the `j_idNNN` ids `src/pje/constants.ts` documents
 * for the search form.
 */

import * as cheerio from 'cheerio';

import type { CaseDocument, DocumentDownloadRef, Movement, Party } from './types.js';
import { ParseError } from './errors.js';

/** "DD/MM/YYYY - description" or "DD/MM/YYYY HH:MM:SS - description". */
const RE_DATED_ENTRY = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{2}:\d{2}:\d{2})?\s*-\s*(.+)$/s;

/** CPF or CNPJ, however the party line spells it: "CPF: 123.456.789-00". */
const RE_DOCUMENT = /(CPF|CNPJ):\s*([\d./-]+)/;

/**
 * "OAB PB18409" or "OAB PE12345A" right after the name.
 *
 * Some state bars append a letter suffix to the registration number (e.g.
 * supplementary/provisional registrations); the plain `\d+` form used to miss
 * those entirely.
 */
const RE_OAB = /OAB\s+([A-Z]{2}\d+[A-Z]?)/;

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
 * "autos sigilosos"), and that wording is only trusted **inside the notice
 * panel** (`dl.rich-messages` / `span.rich-messages-label`, the same block
 * `parse-results.ts` reads server rejections from) — never in free text
 * elsewhere on the page. A movement description like "pedido de segredo de
 * justiça indeferido" (a request for secrecy that was *denied*) is common in
 * an entirely ordinary, public case; matching the whole page's text would
 * misclassify it as sealed and discard real data.
 *
 * The "Dados do Processo" heading being present is what marks an ordinary
 * case. **Its absence alone is not enough to call a page sealed** — a
 * database error page rendered as HTML, a dropped session that
 * `session.open()`'s GET does not otherwise catch (unlike `post()`, which
 * retries once on the same signal), or a changed layout all lack that heading
 * too, and none of them is the same domain state as a real sealed case.
 * Collapsing "unrecognised" into "sealed" would persist a failure as if it
 * were real data, and it would never be retried.
 *
 * `unexpected` carries a short `reason` for the run log; the caller decides
 * whether to throw, retry or record it as a failure (see
 * `UnexpectedDetailPageError` in `src/domain/errors.ts`) — that decision does
 * not belong in a pure parser.
 */
export function classifyDetailPage(html: string): DetailPageKind {
  const $ = cheerio.load(html);
  const notice = squash($('dl.rich-messages, span.rich-messages-label').text());
  if (/segredo de justi[çc]a|autos? sigiloso/i.test(notice)) {
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
  judgingBody?: string;
  address?: string;
  referenceCase?: string;
}

/**
 * Parses the header panel.
 *
 * Each field sits in a `.propertyView` block with a `<label>` and a
 * `.value`. Two of the six cells share no label of their own — one holds
 * "Órgão Julgador Colegiado" and "Endereço" stacked, the other just "Órgão
 * Julgador" — so those two are matched by content instead of by their
 * (empty) `<label>`. They are two distinct fields (`court` and
 * `judgingBody`): a case can have a collegiate body listed alongside its own
 * chamber, and dropping one when both are present would lose information.
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
        // markup; joined with "; " since the field is a single string. Note
        // the site's own markup drops the rubric's closing parenthesis (e.g.
        // "Substituição da Parte (9494" with no matching ")") - that is not a
        // parsing bug, it is what the page actually sends.
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
        // One of the two unlabelled cells: the collegiate body (with the
        // address stacked below it) or the chamber alone.
        if (/Endereço/.test(value)) {
          const court = /Órgão Julgador Colegiado\s*(.*?)\s*Endereço/.exec(value)?.[1];
          const address = /Endereço\s*(.*)$/.exec(value)?.[1];
          if (court !== undefined && court !== '') header.court = court;
          if (address !== undefined && address !== '') header.address = address;
        } else if (/Órgão Julgador/.test(value)) {
          const judgingBody = /Órgão Julgador\s*(.*)$/.exec(value)?.[1];
          if (judgingBody !== undefined && judgingBody !== '') header.judgingBody = judgingBody;
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

/** Id suffix (without the `j_id146:`-style prefix) of each paginated table. */
export const TABLE_ID = {
  activeParties: 'processoPartesPoloAtivoResumidoList',
  passiveParties: 'processoPartesPoloPassivoResumidoList',
  movements: 'processoEvento',
  documents: 'processoDocumentoGridTab',
} as const;

const ALL_TABLE_ID_SUFFIXES = Object.values(TABLE_ID);

/**
 * Returns the markup from one table's own `id="..."` onward, cut off before
 * the next table's `id="..."` (whichever of the other three comes first) -
 * or before the end of the document, if the table asked about is the last one
 * or the only one present.
 *
 * Neither the "N resultados encontrados" marker nor a `Richfaces.Slider`
 * registration carries the id of the table it belongs to (unlike a
 * datascroller, whose own id embeds the table name): both are found by
 * proximity, searching forward from the table's id. Left unbounded, that
 * search can walk straight past an empty/single-page table and pick up the
 * *next* table's marker or pager instead - this bound is what stops that.
 * Returns `''` when the table's own id is not present in the markup at all
 * (a sealed/unexpected page, or a table this site does not render).
 */
function tableSection(html: string, tableIdSuffix: string): string {
  const idMatch = new RegExp(`id="[^"]*${tableIdSuffix}"`).exec(html);
  if (idMatch === null) return '';

  const start = idMatch.index;
  let end = html.length;
  for (const other of ALL_TABLE_ID_SUFFIXES) {
    if (other === tableIdSuffix) continue;
    const otherMatch = new RegExp(`id="[^"]*${other}"`).exec(html.slice(start));
    if (otherMatch !== null) {
      end = Math.min(end, start + otherMatch.index);
    }
  }

  return html.slice(start, end);
}

/**
 * Parses one side's parties table (active or passive).
 *
 * Each row is one participant: the case party itself (`span.text-bold`) or
 * one of its attorneys (a plain, class-less `span`), one row per person. That
 * span is always the **first** child of the outer `.col-sm-12` div — deeper
 * spans exist too (e.g. `<span title="Procuradoria">...`, nested in a `<ul>`
 * of representation metadata) and must not be read as separate parties.
 */
function parseParties(html: string, tableIdSuffix: string): Party[] {
  const $ = cheerio.load(html);
  const parties: Party[] = [];

  $(`table[id$="${tableIdSuffix}"] > tbody > tr`).each((_, row) => {
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

/** Parses the active-parties (polo ativo) table. */
export function parseActiveParties(html: string): Party[] {
  return parseParties(html, TABLE_ID.activeParties);
}

/** Parses the passive-parties (polo passivo) table. */
export function parsePassiveParties(html: string): Party[] {
  return parseParties(html, TABLE_ID.passiveParties);
}

/** Parses the movements table. */
export function parseMovements(html: string): Movement[] {
  const $ = cheerio.load(html);
  const movements: Movement[] = [];

  $(`table[id$="${TABLE_ID.movements}"] > tbody > tr`).each((_, row) => {
    const text = squash($(row).find('td').first().text());
    const match = RE_DATED_ENTRY.exec(text);
    if (match === null) return;
    const [, day, month, year, description] = match;
    movements.push({
      date: toIsoDate(day as string, month as string, year as string),
      description: (description as string).trim(),
    });
  });

  return movements;
}

/**
 * Parses the attached documents table.
 *
 * Only rows with a real download link (an `href` carrying `idBin`) become a
 * `CaseDocument`. A document with no binary attached — only a "Visualizar"
 * popup with no querystring — has no `download` ref to build and is skipped:
 * there is nothing to download. Both kinds count towards the table's declared
 * total, though: `PjeDetail` cross-checks against the **row** count, before
 * this filter, since the "N resultados encontrados" the page itself reports
 * counts every row, downloadable or not.
 */
export function parseDocuments(html: string): CaseDocument[] {
  const $ = cheerio.load(html);
  const documents: CaseDocument[] = [];

  $(`table[id$="${TABLE_ID.documents}"] > tbody > tr`).each((_, row) => {
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

    const download: DocumentDownloadRef = {
      idBin,
      numeroDocumento,
      nomeArqProcDocBin,
      idProcessoDocumento,
      actionMethod,
    };

    documents.push({
      date:
        dateFields !== undefined
          ? toIsoDate(dateFields[0] as string, dateFields[1] as string, dateFields[2] as string)
          : '',
      name,
      kind,
      download,
    });
  });

  return documents;
}

/**
 * Counts every row in a paginated table's `<tbody>`, downloadable or not.
 *
 * Used to cross-check against the "N resultados encontrados" total the page
 * itself declares (see `readDeclaredTotal`): a row count is not the same
 * thing as `parseDocuments().length`, which already dropped view-only rows.
 *
 * Direct `> tbody > tr` child, not a loose descendant selector: a
 * datascroller's own paging control renders as a small nested `<table>`
 * (its own `<tbody>` has no id) inside the outer table, and a bare
 * `tbody tr` selector silently counted that control row as an extra row of
 * the outer table too.
 */
export function countTableRows(html: string, tableIdSuffix: string): number {
  const $ = cheerio.load(html);
  return $(`table[id$="${tableIdSuffix}"] > tbody > tr`).length;
}

/**
 * Reads the "N resultados encontrados" total the page declares for one table.
 *
 * The marker is a `<span>` following the table, but *not* immediately after
 * its literal `</table>`: some of these tables (documents, in particular)
 * nest inner tables inside header-sort forms, so the first `</table>` found
 * after the table's own id can close one of those instead of the outer
 * table. `tableSection()` sidesteps that by bounding the search at the next
 * table's own id instead. Returns `undefined` when the table or the marker
 * is not present at all - a table not being present on a sealed/unexpected
 * page is not this function's business to flag.
 */
export function readDeclaredTotal(html: string, tableIdSuffix: string): number | undefined {
  const section = tableSection(html, tableIdSuffix);
  if (section === '') return undefined;

  const match = /(\d+)\s*resultados encontrados/.exec(section);
  return match !== null ? Number.parseInt(match[1] as string, 10) : undefined;
}

/** Ids and shape of the JSF pager governing one table, whichever widget renders it. */
export type Pager =
  | {
      kind: 'datascroller';
      /** Component the AJAX POST is addressed to (scroller id minus its trailing suffix). */
      baseId: string;
      /** Full id of the scroller field: carries the target page, also used as `ajaxSingle`. */
      pageFieldId: string;
      pageCount: number;
    }
  | {
      kind: 'slider';
      /** Component (form) the AJAX POST is addressed to. */
      baseId: string;
      /** The slider's own id: its value (a page number) is the field that must be set. */
      pageFieldId: string;
      /** The distinct, self-referential id the slider's onchange event names in `parameters`. */
      eventFieldId: string;
      pageCount: number;
    };

/**
 * Reads the pager for one table, whichever RichFaces widget renders it.
 *
 * Parties use `Richfaces.Datascroller` (numbered page links). Movements and
 * documents, on this site, use `Richfaces.Slider` instead (a 1..maxValue
 * range, rendered as a small drag control) — a different component with a
 * different AJAX shape, easy to miss if only the parties tables are used as
 * the reference: a single fixture (`detail-with-pagination.html`) carries
 * both kinds side by side (parties paginate with a scroller; movements and
 * documents, in that same case, with a slider).
 *
 * A single-page table renders no pager registration at all (seen for a
 * movements/documents table small enough to fit on one slider page - the
 * slider itself, unlike the datascroller, is not known to render hidden with
 * `maxValue: 1`; no case sampled had a single-page slider to confirm either
 * way) or a hidden, page-link-less one (seen for parties) — both are read as
 * one page, which is why the pager itself, not just its page count, is
 * optional: `undefined` means "nothing to walk here".
 */
export function parsePager(html: string, tableIdSuffix: string): Pager | undefined {
  return parseSliderPager(html, tableIdSuffix) ?? parseDatascrollerPager(html, tableIdSuffix);
}

function parseDatascrollerPager(
  html: string,
  tableIdSuffix: string,
): Extract<Pager, { kind: 'datascroller' }> | undefined {
  const registerCall = new RegExp(
    `new Richfaces\\.Datascroller\\('([^']*${tableIdSuffix}[^']*)',\\s*function\\(event\\)\\{` +
      `A4J\\.AJAX\\.Submit\\('([^']+)'`,
  );
  const match = registerCall.exec(html);
  if (match === null) return undefined;

  const pageFieldId = match[1] as string;
  const baseId = match[2] as string;

  // Page count: the highest numeric page link rendered near this scroller's
  // table (both the active page and the clickable ones), read from the small
  // `rich-dtascroller-table` that immediately precedes the registration
  // script. A single page renders that table with no numeric links at all.
  const registerIndex = match.index;
  const searchStart = html.lastIndexOf('rich-dtascroller-table', registerIndex);
  const scrollerMarkup = searchStart === -1 ? '' : html.slice(searchStart, registerIndex);

  const pageNumbers = [
    ...scrollerMarkup.matchAll(/class="\s*rich-datascr-(?:act|inact)\s*"[^>]*>(\d+)</g),
  ]
    .map((m) => Number.parseInt(m[1] as string, 10))
    .filter((n) => !Number.isNaN(n));

  const pageCount = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;

  return { kind: 'datascroller', baseId, pageFieldId, pageCount };
}

/**
 * Reads a `Richfaces.Slider` pager.
 *
 * Its registration looks like:
 *
 *   new Richfaces.Slider("j_id146:j_id561:j_id562",
 *     {'minValue':'1','maxValue':'5', ...,
 *      'onchange':'A4J.AJAX.Submit(\'j_id146:j_id561\', event,
 *        {..., parameters:{\'j_id146:j_id561:j_id563\':\'j_id146:j_id561:j_id563\'} ...})' })
 *
 * `j_id562` (the slider's own id) is the field whose **value is the page
 * number** — mirrored by a plain text `<input name="j_id146:j_id561:j_id562"
 * value="1">` next to the slider control, the same way the current page shows
 * up as ordinary form state. `j_id563` is a distinct, self-referential id the
 * onchange event names in its `parameters` map (parallel to the
 * datascroller's `ajaxSingle`) — sent as itself, not as the page number.
 *
 * There is no direct id linking a slider to "its" table the way a
 * datascroller's own id embeds the table name (`processoEvento` does not
 * appear anywhere in `j_id561`/`j_id562`/`j_id563`), so the slider found
 * within `tableSection()`'s bounded window - from the table's own id up to
 * the next table's - is taken as the one that paginates it. Without that
 * bound, the search would walk straight past a table with no slider of its
 * own (parties, which use a datascroller instead) and pick up the *next*
 * table's slider by mistake.
 */
function parseSliderPager(
  html: string,
  tableIdSuffix: string,
): Extract<Pager, { kind: 'slider' }> | undefined {
  const section = tableSection(html, tableIdSuffix);
  if (section === '') return undefined;

  // The registration is JS embedded in an HTML attribute, so its quotes come
  // through the raw markup backslash-escaped (`\'`, one literal backslash),
  // not JSON/JS-source-escaped (`\\'`).
  const sliderCall =
    /new Richfaces\.Slider\("([^"]+)",\{'minValue':'(\d+)','maxValue':'(\d+)'[\s\S]{0,600}?A4J\.AJAX\.Submit\(\\'([^\\']+)\\'[\s\S]{0,600}?parameters\\'\s*:\s*\{\\'([^\\']+)\\'/.exec(
      section,
    );
  if (sliderCall === null) return undefined;

  const pageFieldId = sliderCall[1] as string;
  const maxValue = Number.parseInt(sliderCall[3] as string, 10);
  const baseId = sliderCall[4] as string;
  const eventFieldId = sliderCall[5] as string;

  return {
    kind: 'slider',
    baseId,
    pageFieldId,
    eventFieldId,
    pageCount: Number.isNaN(maxValue) ? 1 : maxValue,
  };
}

/** Pagers for every table the detail view can paginate, keyed by table. */
export interface DetailPagers {
  activeParties?: Pager;
  passiveParties?: Pager;
  movements?: Pager;
  documents?: Pager;
}

/** Reads the pager for every paginated table in the detail view. */
export function parseAllPagers(html: string): DetailPagers {
  const activeParties = parsePager(html, TABLE_ID.activeParties);
  const passiveParties = parsePager(html, TABLE_ID.passiveParties);
  const movements = parsePager(html, TABLE_ID.movements);
  const documents = parsePager(html, TABLE_ID.documents);

  return {
    ...(activeParties !== undefined ? { activeParties } : {}),
    ...(passiveParties !== undefined ? { passiveParties } : {}),
    ...(movements !== undefined ? { movements } : {}),
    ...(documents !== undefined ? { documents } : {}),
  };
}

/**
 * Reads the absolute row index of a table's first `<tbody>` row (e.g. `10`
 * for `id="...processoEvento:10:j_id495"`).
 *
 * Every row's id embeds its position in the *whole* table, not the page:
 * page 2 of a 12-row table starts at index 10, not 0. Used to confirm a
 * paging POST actually moved to the requested page rather than being
 * silently ignored (stale ViewState, wrong field id) and returning page 1
 * again - `undefined` when the table has no rows to read an index from.
 */
export function firstRowIndex(html: string, tableIdSuffix: string): number | undefined {
  const match = new RegExp(`${tableIdSuffix}:(\\d+):`).exec(html);
  return match !== null ? Number.parseInt(match[1] as string, 10) : undefined;
}

/**
 * Throws `ParseError` unless a table's row count matches its own declared
 * total.
 *
 * The declared total is read once, from page 1 (it does not change page to
 * page); `actualCount` is the number of rows accumulated after walking every
 * page. A mismatch means a page went missing or was duplicated - silently
 * returning a short or long list would look like success.
 */
export function assertTotalMatches(
  tableIdSuffix: string,
  declaredTotal: number | undefined,
  actualCount: number,
): void {
  if (declaredTotal === undefined) return;
  if (actualCount !== declaredTotal) {
    throw new ParseError(
      `Table "${tableIdSuffix}" declared ${declaredTotal} rows but ${actualCount} were collected ` +
        'after walking its pager: a page was likely dropped, duplicated or never fetched.',
      tableIdSuffix,
    );
  }
}

/**
 * Reads the `sliderValue` a slider's AJAX paging response reports, e.g. `2`
 * from `'sliderValue':'2'`.
 *
 * Unlike a datascroller page, a slider page's rows are **re-indexed from 0**
 * on every page (page 2 of a 15-per-page table is rows `0..N`, not `15..N`;
 * confirmed live, see PROBLEMS.md §6). `firstRowIndex()` therefore cannot
 * confirm a slider paging POST actually advanced - this is the equivalent
 * check for that widget: the response itself echoes which page it rendered.
 */
export function readSliderValue(html: string): number | undefined {
  const match = /'sliderValue'\s*:\s*'(\d+)'/.exec(html);
  return match !== null ? Number.parseInt(match[1] as string, 10) : undefined;
}

/**
 * A field name/value pair from a submittable `<input>`.
 */
export type FormField = readonly [name: string, value: string];

/**
 * Input `type`s a real browser never includes in a form submission unless
 * that specific control was the one activated - never true for a page we
 * are replaying wholesale.
 */
const NON_SUBMITTED_INPUT_TYPES = new Set(['submit', 'button', 'image', 'checkbox', 'radio']);

/**
 * Extracts every submittable, named `<input>` field from one form onward, in
 * document order - the fields a real form submission of that form would
 * carry.
 *
 * **Why "from the form onward" rather than "inside the form":** PJe nests
 * `<form>` elements (a scroller's or slider's own pager sits in a `<form>`
 * that is itself inside the page's main `j_id146` form). HTML forbids nested
 * forms; when a real browser parses this markup it silently drops the inner
 * `<form>` open tag and its matching `</form>`, so every "nested" field ends
 * up belonging to the *outer* form's DOM, not a form of its own. A
 * `Richfaces.Slider`'s `A4J.AJAX.Submit('j_id146:j_id561', ...)` therefore
 * does not submit some small six-field sub-form; it submits the **entire**
 * `j_id146` form, all ~75 fields of it. Posting only the inner pager's own
 * fields (the first attempt at this) is accepted by the server with a 200,
 * but renders nothing (`Ajax-Update-Ids content=""`): confirmed live, see
 * PROBLEMS.md §6.
 *
 * `javax.faces.ViewState` appears once per (HTML-invalid) nested form in the
 * markup, always with the same value; only its first occurrence is kept, one
 * of the few places this function does more than "read what's there in
 * order" - a real submitted form has exactly one ViewState field, not one
 * per visually-nested widget.
 *
 * Cheerio (built on parse5) corrects the invalid nesting the same way a
 * browser does, so a plain `input[name]` selector already returns the right,
 * flattened set; the only extra step is starting the parse from the target
 * form's own opening tag (there can be *other*, unrelated top-level forms
 * earlier in the document, e.g. a tab-switcher form, whose fields must not
 * be included).
 */
export function parseOuterFormFields(html: string, formId: string): FormField[] {
  const marker = `id="${formId}"`;
  const idIndex = html.indexOf(marker);
  if (idIndex === -1) return [];

  const formStart = html.lastIndexOf('<form', idIndex);
  if (formStart === -1) return [];

  const $ = cheerio.load(html.slice(formStart));
  const fields: FormField[] = [];
  let seenViewState = false;

  $('input[name]').each((_, element) => {
    const $el = $(element);
    const type = ($el.attr('type') ?? 'text').toLowerCase();
    if (NON_SUBMITTED_INPUT_TYPES.has(type)) return;

    const name = $el.attr('name') ?? '';
    if (name === '') return;

    if (name === 'javax.faces.ViewState') {
      if (seenViewState) return;
      seenViewState = true;
    }

    fields.push([name, $el.attr('value') ?? '']);
  });

  return fields;
}
