/**
 * Downloading attached documents.
 *
 * PROBLEMS.md §7: a document's link is not a URL to a PDF. It is a GET to the
 * detail view itself, carrying the five identifiers `parseDocuments()`
 * collected (`DocumentDownloadRef`), which 302-redirects to
 * `download.seam?cid=<N>` - and that `cid` is ephemeral, single-use and
 * session-bound: reusing it returns 404. This rules out collecting links for
 * later bulk download; the redirect must be followed immediately, with the
 * session alive, which is exactly what `JsfSession.getBinary` (backed by
 * `HttpClient.getBinary`) already does (axios follows redirects internally,
 * `maxRedirects: 5`).
 *
 * Downloads are routed through `JsfSession.getBinary`, never through a raw
 * `HttpClient` handed to this module separately: the redirect's `cid` is
 * session-bound, so the request has to travel with the exact cookie jar the
 * rest of the run is using. A constructor that accepted `session` and `http`
 * as two independent dependencies would let a caller pass a client that is
 * not the one behind that session - a mismatched pair - and PJe would answer
 * with an undiagnosable 404 rather than anything that points at the mistake.
 *
 * 429 handling is not reimplemented here. `HttpClient` already retries 429s
 * with backoff, honours `Retry-After`, and trips a circuit breaker after too
 * many consecutive ones (ISSUE-2). A 429 landing on the *redirect target*
 * (`download.seam?cid=N`, not the original document URL) is still covered:
 * `HttpClient`'s retry loop sees it as the final response status of the whole
 * request (axios only forwards a 3xx through the chain; a 429 stops it and is
 * returned as-is) and retries by re-issuing the request from the *original*
 * document URL - which mints a **fresh** `cid` each time, so retrying never
 * reuses a stale one. `test/download.test.ts`'s "429 handling on downloads"
 * suite keeps that proof as a permanent test, including a case where the 429
 * lands specifically on the redirect target.
 *
 * An HTML response where a PDF was expected means the session dropped (or an
 * error page rendered with a 200 status) - not a 429, but a failure that must
 * not be written to disk as if it were a document. That case re-establishes
 * the session (mirroring `JsfSession.post`'s own one-retry discipline) and
 * tries again exactly once.
 */

import { mkdir, open as fsOpen, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CircuitBreakerError, RateLimitError } from '../domain/errors.js';
import type { CaseDocument } from '../domain/types.js';
import { pdfPath } from './pdf-naming.js';
import type { JsfSession } from './session.js';

const PDF_MAGIC = '%PDF';

/** Successful outcome: the file is on disk (freshly written or already valid). */
export interface DownloadSuccess {
  ok: true;
  path: string;
  bytes: number;
  /** True when no request was made because a valid file already existed. */
  skipped: boolean;
}

/**
 * Failed outcome.
 *
 * Never thrown: ISSUE-7/9 record failures from this discriminated result
 * rather than from a caught exception, and this module never writes
 * `data/failed.json` itself (that is ISSUE-7's file to own).
 *
 * The one exception is a filesystem error while writing the file (a full
 * disk, a permissions problem): those propagate as a thrown exception rather
 * than becoming part of this result. That is a deliberate difference from a
 * failed HTTP attempt - an I/O error is an operational problem for whoever
 * runs the process to notice and fix, not a retry-ledger item ISSUE-7 should
 * silently queue up alongside ordinary rate limiting.
 */
export interface DownloadFailure {
  ok: false;
  reason: string;
  status?: number;
  /** Whether trying again later is worth it, as opposed to a permanent shape mismatch. */
  retryable: boolean;
  /**
   * How many *session-level* attempts this call made: 1, or 2 when an HTML
   * response triggered a session re-establish and a retry. Not a count of the
   * underlying HTTP requests - `HttpClient` may have retried several times
   * within either of these attempts on its own account (429s, transient
   * network errors), invisibly to this field, since that retrying is already
   * ISSUE-2's concern and does not change what this module tried.
   */
  sessionAttempts: number;
}

export type DownloadResult = DownloadSuccess | DownloadFailure;

export interface PjeDownloaderOptions {
  session: JsfSession;
  /** Root directory PDFs are written under. Injectable so tests use a temp dir. */
  rootDir: string;
}

/**
 * The query string a document's download link carries: the five
 * `DocumentDownloadRef` fields, verbatim, against the detail view - not a
 * distinct endpoint (confirmed against `test/fixtures/detail-with-pagination.html`).
 */
function buildDownloadQuery(doc: CaseDocument): string {
  const { idBin, numeroDocumento, nomeArqProcDocBin, idProcessoDocumento, actionMethod } =
    doc.download;
  const params = new URLSearchParams({
    idBin,
    numeroDocumento,
    nomeArqProcDocBin,
    idProcessoDocumento,
    actionMethod,
  });
  return `?${params.toString()}`;
}

/**
 * Builds the full GET URL for a document's binary, against the detail view.
 * Exported for tests and any caller that wants to inspect the exact request
 * shape without going through a full download.
 */
export function buildDownloadUrl(session: JsfSession, doc: CaseDocument): string {
  return session.url('detail', buildDownloadQuery(doc));
}

/** Downloads one case's attached documents, one at a time. */
export class PjeDownloader {
  private readonly session: JsfSession;
  private readonly rootDir: string;

  constructor(options: PjeDownloaderOptions) {
    this.session = options.session;
    this.rootDir = options.rootDir;
  }

  /**
   * Downloads one document, or confirms it is already there.
   *
   * `caseNumber` is the CNJ number, used only for the directory layout and
   * for re-opening the detail view if a session re-establish is needed - the
   * download URL itself needs none of it, the five `DocumentDownloadRef`
   * fields are sufficient on their own, verified against the real link
   * shape. `ca` is the detail view's access token, required to reopen that
   * view (`JsfSession.open`) if the first attempt reveals a dropped session;
   * optional because a caller retrying a document whose case is not at hand
   * can still attempt the download once, just without the recovery path.
   */
  async download(caseNumber: string, doc: CaseDocument, ca?: string): Promise<DownloadResult> {
    const path = pdfPath(this.rootDir, caseNumber, doc);

    if (await isValidPdf(path)) {
      doc.localPath = path;
      const { size } = await stat(path);
      return { ok: true, path, bytes: size, skipped: true };
    }

    const query = buildDownloadQuery(doc);

    // At most two session-level attempts: the first, and - only if the first
    // came back as HTML instead of a PDF, and a `ca` was given to reopen the
    // view with - one retry after re-establishing the session. Mirrors
    // JsfSession.post's own "one retry is enough" discipline: a second
    // failure of the same kind means something else is wrong.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: { data: Buffer; status: number; contentType: string };
      try {
        response = await this.session.getBinary('detail', query);
      } catch (error) {
        return mapThrownError(error, attempt);
      }

      if (!response.contentType.toLowerCase().includes('application/pdf')) {
        const failure: DownloadFailure = {
          ok: false,
          reason:
            `Expected a PDF but got Content-Type "${response.contentType}" ` +
            `(status ${response.status}): likely a dropped session or an error page.`,
          status: response.status,
          retryable: true,
          sessionAttempts: attempt,
        };
        if (attempt === 1 && ca !== undefined) {
          try {
            await this.session.reestablish('detail', `?ca=${ca}`);
          } catch (error) {
            return mapThrownError(error, attempt);
          }
          continue;
        }
        return failure;
      }

      if (!hasPdfMagic(response.data)) {
        return {
          ok: false,
          reason:
            'Response declared Content-Type application/pdf but the body has no %PDF header.',
          status: response.status,
          retryable: true,
          sessionAttempts: attempt,
        };
      }

      const bytes = await writeAtomically(path, response.data);
      doc.localPath = path;
      return { ok: true, path, bytes, skipped: false };
    }

    // Unreachable: every loop iteration returns, except the one `continue`,
    // which is only taken once (attempt === 1), so the loop always returns
    // by attempt 2.
    throw new Error('unreachable: download loop exited without returning');
  }
}

function mapThrownError(error: unknown, sessionAttempts: number): DownloadFailure {
  if (error instanceof RateLimitError) {
    return {
      ok: false,
      reason: `Rate limited: ${error.message}`,
      retryable: true,
      sessionAttempts,
    };
  }
  if (error instanceof CircuitBreakerError) {
    return {
      ok: false,
      reason: `Circuit breaker tripped: ${error.message}`,
      retryable: true,
      sessionAttempts,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, reason: message, retryable: false, sessionAttempts };
}

function hasPdfMagic(data: Buffer): boolean {
  return data.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}

/** True when `path` exists and its first bytes are the `%PDF` magic header. */
async function isValidPdf(path: string): Promise<boolean> {
  try {
    const handle = await fsOpen(path, 'r');
    try {
      const buffer = Buffer.alloc(PDF_MAGIC.length);
      const { bytesRead } = await handle.read(buffer, 0, PDF_MAGIC.length, 0);
      return bytesRead === PDF_MAGIC.length && hasPdfMagic(buffer);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Writes to a temp file and renames on completion, so a process killed
 * mid-write never leaves a `.pdf` that later looks valid (ISSUE-6's
 * acceptance criterion). The rename is the atomic step; anything that fails
 * before it - including an I/O error from the write itself - leaves only the
 * `.tmp` file (or nothing), never a `.pdf`. Such an I/O error propagates as a
 * thrown exception rather than a `DownloadFailure` (see that type's doc
 * comment): a full disk is not a retry-ledger item.
 */
async function writeAtomically(path: string, data: Buffer): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  const handle = await fsOpen(tempPath, 'w');
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  return data.byteLength;
}
