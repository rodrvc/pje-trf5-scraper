/**
 * File naming and layout for downloaded PDFs.
 *
 * Kept separate from the HTTP mechanism (`download.ts`) because it is a pure,
 * synchronous concern - given a case number and a document, compute where its
 * PDF belongs - and is trivial to test exhaustively without touching the
 * filesystem or a mock server.
 *
 * Layout: `pdfs/<CNJ-number>/<date>_<kind>_<documentId>.pdf`.
 *
 * The CNJ number and the kind/date can contain characters that are awkward or
 * unsafe in a path (`/`, `.`, control characters). Sanitisation happens
 * **after** decoding: `CaseDocument` fields already arrive decoded (see
 * `parse-detail.ts`'s handling of `nomeArqProcDocBin`), so sanitising here
 * never operates on raw percent-escapes. `idProcessoDocumento` is what
 * guarantees the file name is unique - sanitisation can collapse two distinct
 * readable names into the same string, but it never touches the id, so two
 * documents never collide on disk even when their decorative parts do.
 */

import { join } from 'node:path';

import type { CaseDocument } from '../domain/types.js';

/**
 * Replaces anything that is not a letter, digit, dot, dash or underscore with
 * `_`, and collapses runs of `_` down to one. Applied independently to each
 * path segment (case number, and the readable part of the file name) - never
 * to a full path at once, so a segment cannot inject a path separator.
 */
export function sanitiseSegment(raw: string): string {
  const replaced = raw.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/_+/g, '_');
  const trimmed = replaced.replace(/^_+|_+$/g, '');
  return trimmed.length > 0 ? trimmed : '_';
}

/** Directory a case's PDFs live under, relative to `rootDir`. */
export function caseDir(rootDir: string, caseNumber: string): string {
  return join(rootDir, sanitiseSegment(caseNumber));
}

/**
 * Full path for one document's PDF.
 *
 * The date is taken as-is (already ISO 8601, digits and dashes only) rather
 * than re-sanitised harder than necessary; kind and name go through the same
 * sanitiser. `idProcessoDocumento` is appended unsanitised-but-safe (it is
 * always a bare numeric id straight from the query string) so that even a
 * kind/date sanitising to the same string still yields distinct files.
 */
export function pdfPath(rootDir: string, caseNumber: string, doc: CaseDocument): string {
  const datePart = sanitiseSegment(doc.date || 'undated');
  const kindPart = sanitiseSegment(doc.kind || doc.name || 'documento');
  const idPart = sanitiseSegment(doc.download.idProcessoDocumento);
  const fileName = `${datePart}_${kindPart}_${idPart}.pdf`;
  return join(caseDir(rootDir, caseNumber), fileName);
}
