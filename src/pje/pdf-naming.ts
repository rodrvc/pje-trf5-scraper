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
 *
 * Windows reserved device names (`CON`, `PRN`, `NUL`, ...) are out of scope:
 * the scraper targets a Linux/macOS-shaped runtime, per the rest of the
 * codebase (no path handling anywhere else guards against them either).
 */

import { join } from 'node:path';

import type { CaseDocument } from '../domain/types.js';

/** Cap on the readable ("kind") segment of the file name, in characters. */
const MAX_KIND_LENGTH = 80;

/**
 * Replaces anything that is not a letter, digit, dot, dash or underscore with
 * `_`, and collapses runs of `_` down to one. Applied independently to each
 * path segment (case number, and the readable part of the file name) - never
 * to a full path at once, so a segment cannot inject a path separator.
 *
 * A segment made up entirely of dots (`.`, `..`, `...`) is rejected outright
 * after trimming, and any leading dots are stripped from what remains:
 * dots survive the character filter above (CNJ numbers use them), but `..`
 * is a directory traversal token and `caseDir(rootDir, '..')` would escape
 * `rootDir` if it were allowed through unchanged.
 */
export function sanitiseSegment(raw: string): string {
  const replaced = raw.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/_+/g, '_');
  const trimmed = replaced.replace(/^_+|_+$/g, '');

  if (trimmed.length === 0 || /^\.+$/.test(trimmed)) {
    return '_';
  }

  // Strip any remaining leading dots (e.g. ".git", "..foo") so the segment
  // can never be read as a hidden file or a traversal token by anything
  // downstream that treats a leading "." specially.
  const withoutLeadingDots = trimmed.replace(/^\.+/, '');
  return withoutLeadingDots.length > 0 ? withoutLeadingDots : '_';
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
 * sanitiser and are capped at `MAX_KIND_LENGTH` characters -
 * `nomeArqProcDocBin` is server-supplied and unbounded, and a full path past
 * ~255 bytes fails with `ENAMETOOLONG` on a real filesystem.
 * `idProcessoDocumento` is appended unsanitised-but-safe (it is always a bare
 * numeric id straight from the query string) so that even a kind/date
 * sanitising to the same string still yields distinct files.
 */
export function pdfPath(rootDir: string, caseNumber: string, doc: CaseDocument): string {
  const datePart = sanitiseSegment(doc.date || 'undated');
  const kindPart = sanitiseSegment(doc.kind || doc.name || 'documento').slice(0, MAX_KIND_LENGTH);
  const idPart = sanitiseSegment(doc.download.idProcessoDocumento);
  const fileName = `${datePart}_${kindPart}_${idPart}.pdf`;
  return join(caseDir(rootDir, caseNumber), fileName);
}
