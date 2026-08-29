/**
 * Downloading attached documents.
 *
 * PROBLEMS.md §7: a document's link is not a URL to a PDF. It is a GET to the
 * detail view itself, carrying the five identifiers `parseDocuments()`
 * collected (`DocumentDownloadRef`), which 302-redirects to
 * `download.seam?cid=<N>` - and that `cid` is ephemeral, single-use and
 * session-bound: reusing it returns 404. This rules out collecting links for
 * later bulk download; the redirect must be followed immediately, with the
 * session alive, which is exactly what `HttpClient.getBinary` already does
 * (axios follows redirects internally, `maxRedirects: 5`).
 *
 * 429 handling is not reimplemented here. `HttpClient` already retries 429s
 * with backoff, honours `Retry-After`, and trips a circuit breaker after too
 * many consecutive ones (ISSUE-2). A 429 landing on the *redirect target*
 * (`download.seam?cid=N`, not the original document URL) is still covered:
 * `HttpClient`'s retry loop sees it as the final response status of the whole
 * request (axios only forwards a 3xx through the chain; a 429 stops it and is
 * returned as-is) and retries by re-issuing the request from the *original*
 * document URL - which mints a **fresh** `cid` each time, so retrying never
 * reuses a stale one. This was verified with a throwaway nock test chaining
 * 302 -> 429 -> 302 -> 200 through two distinct `cid`s before this file was
 * written; test/download.test.ts's "429 then success" case is the same proof
 * kept as a permanent test.
 *
 * An HTML response where a PDF was expected means the session dropped (or an
 * error page rendered with a 200 status) - not a 429, but a failure that must
 * not be written to disk as if it were a document. That case re-establishes
 * the session (mirroring `JsfSession.post`'s own one-retry discipline) and
 * tries again exactly once.
 */

import { mkdir, open as fsOpen, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { HttpClient } from '../http/client.js';
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
 */
export interface DownloadFailure {
  ok: false;
  reason: string;
  status?: number;
  /** Whether trying again later is worth it, as opposed to a permanent shape mismatch. */
  retryable: boolean;
  /** How many HTTP attempts this call made (1, or 2 when a session re-establish was tried). */
  attempts: number;
}

export type DownloadResult = DownloadSuccess | DownloadFailure;

export interface PjeDownloaderOptions {
  session: JsfSession;
  http: HttpClient;
  /** Root directory PDFs are written under. Injectable so tests use a temp dir. */
  rootDir: string;
}

/**
 * Builds the GET URL for a document's binary, against the detail view: the
 * link a real detail page renders is not a distinct endpoint, it is the same
 * `listView.seam` the case detail itself lives at, with these five params
 * added (confirmed against `test/fixtures/detail-with-pagination.html`).
 */
export function buildDownloadUrl(session: JsfSession, doc: CaseDocument): string {
  const { idBin, numeroDocumento, nomeArqProcDocBin, idProcessoDocumento, actionMethod } =
    doc.download;
  const params = new URLSearchParams({
    idBin,
    numeroDocumento,
    nomeArqProcDocBin,
    idProcessoDocumento,
    actionMethod,
  });
  return session.url('detail', `?${params.toString()}`);
}

/** Downloads one case's attached documents, one at a time. */
export class PjeDownloader {
  private readonly session: JsfSession;
  private readonly http: HttpClient;
  private readonly rootDir: string;

  constructor(options: PjeDownloaderOptions) {
    this.session = options.session;
    this.http = options.http;
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

    const url = buildDownloadUrl(this.session, doc);

    // At most two HTTP attempts: the first, and - only if the first came back
    // as HTML instead of a PDF, and a `ca` was given to reopen the view with -
    // one retry after re-establishing the session. Mirrors JsfSession.post's
    // own "one retry is enough" discipline: a second failure of the same kind
    // means something else is wrong.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: { data: Buffer; status: number; contentType: string };
      try {
        response = await this.http.getBinary(url, { Referer: this.session.url('detail') });
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
          attempts: attempt,
        };
        if (attempt === 1 && ca !== undefined) {
          await this.session.reestablish('detail', `?ca=${ca}`);
          continue;
        }
        return failure;
      }

      if (!hasPdfMagic(response.data)) {
        return {
          ok: false,
          reason: 'Response declared Content-Type application/pdf but the body has no %PDF header.',
          status: response.status,
          retryable: true,
          attempts: attempt,
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

function mapThrownError(error: unknown, attempts: number): DownloadFailure {
  if (error instanceof RateLimitError) {
    return { ok: false, reason: `Rate limited: ${error.message}`, retryable: true, attempts };
  }
  if (error instanceof CircuitBreakerError) {
    return {
      ok: false,
      reason: `Circuit breaker tripped: ${error.message}`,
      retryable: true,
      attempts,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, reason: message, retryable: false, attempts };
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
 * before it leaves only the `.tmp` file (or nothing), never a `.pdf`.
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
