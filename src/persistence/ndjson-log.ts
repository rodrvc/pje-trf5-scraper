/**
 * The one primitive every persistence store in this module is built on: an
 * append-only, newline-delimited JSON log.
 *
 * Why append-only rather than temp+rename (as ISSUE-6 does for PDFs, and as
 * ISSUE-7's own original spec suggested for state): a temp+rename write
 * still has to read the whole previous file, add one record, and rewrite it
 * whole - O(n) per write, and a crash between "read" and "rename" can still
 * lose whatever else was appended to the real file in between by a
 * concurrent writer (not a concern here, single-process, but it is a real
 * cost for no benefit). Appending one complete, `\n`-terminated line removes
 * the whole-file rewrite (and the rename needed to make it atomic) from the
 * picture. It is not immune to corruption, though: a process killed mid-
 * `appendFile` can still leave a torn **last** line on disk (this is a
 * regular file, not a pipe - there is no OS-level guarantee that a single
 * `write()` below some buffer size lands atomically, unlike `PIPE_BUF` for
 * pipes). `appendLine` and `readLines` below exist specifically to make that
 * one remaining failure mode survivable: a torn line is possible, and it is
 * handled, not prevented.
 *
 * Every store module (`case-store.ts`, `pending-store.ts`,
 * `sweep-progress-store.ts`, `failure-ledger.ts` - shared by
 * `failed-document-store.ts` and `case-failure-store.ts`) reads its NDJSON
 * file through `readLines` and writes through `appendLine`, so both halves
 * of that handling live in exactly one place instead of several slightly
 * different copies.
 */

import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { ParseError } from '../domain/errors.js';

/**
 * Appends one record as a single JSON line, creating the parent directory
 * first if needed.
 *
 * Before appending, repairs a torn **previous** write: if the file already
 * exists and does not end in `\n`, a prior process was killed mid-append,
 * leaving a partial line with no trailing newline. That partial line never
 * represented a completed record - it is truncated off entirely (back to
 * the last `\n`) before the new, complete record is appended, so the new
 * record lands on a clean line of its own rather than being concatenated
 * onto the torn fragment's tail. Without this, `{"a":2` (torn) followed by
 * appending `{"a":3}\n` would read back as one single, doubly-unparseable
 * line (`{"a":2{"a":3}`), silently losing both records instead of just the
 * torn one; truncating first also avoids leaving that fragment sitting
 * forever as a non-last (and therefore hard-error, see `readLines`) line
 * once further records are appended after it.
 */
export async function appendLine(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await truncateTornTail(path);
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * If `path` exists and does not end in `\n`, truncates back to the last
 * complete line.
 *
 * Reads only a small trailing window of the file, growing it geometrically
 * until a `\n` is found, rather than the whole file: this runs before
 * *every* `appendLine`, so an O(file size) read here would turn what should
 * be an O(1)-amortised append into O(n) per write - exactly the
 * quadratic-over-a-run cost the review flagged for `CaseStore.has()`,
 * relocated to the write path instead of fixed. In the overwhelmingly
 * common case (the previous write completed cleanly) this costs one 1-byte
 * read to confirm the last byte is `\n` and nothing more.
 */
async function truncateTornTail(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r+');
  } catch (error) {
    if (isNotFound(error)) return; // Nothing to repair: this is the first write.
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return;

    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a /* '\n' */) return; // Already ends cleanly: nothing to repair.

    // Torn tail confirmed: find the previous `\n` by reading a trailing
    // window, doubling it until found or the whole file has been scanned.
    // A torn write is always short relative to a log's total size (at most
    // one record), so this loop runs once in practice.
    //
    // windowSize starts at 0 (not 4096): the loop condition is
    // `windowSize < size`, so for any file no larger than the starting
    // window that condition would be false on the very first check, the
    // body would never run, lastNewline would stay -1, and truncateAt below
    // would become 0 - deleting every valid record on disk along with the
    // torn tail. Starting at 0 guarantees at least one iteration runs for
    // any non-empty file, growing to 4096 on that first pass.
    let windowSize = 0;
    let lastNewline = -1;
    while (lastNewline === -1 && windowSize < size) {
      windowSize = Math.min(windowSize === 0 ? 4096 : windowSize * 2, size);
      const window = Buffer.alloc(windowSize);
      await handle.read(window, 0, windowSize, size - windowSize);
      const found = window.lastIndexOf(0x0a);
      if (found !== -1) lastNewline = size - windowSize + found;
    }
    // No '\n' anywhere: the entire file is one torn line (e.g. the very
    // first write in the log's history was interrupted). Truncate to empty.
    const truncateAt = lastNewline === -1 ? 0 : lastNewline + 1;

    console.warn(`${path}: truncating a torn tail left by an earlier interrupted write`);
    await handle.truncate(truncateAt);
  } finally {
    await handle.close();
  }
}

/**
 * Reads every line of an NDJSON file and parses each with `parse`.
 *
 * Missing file reads as empty (a store that has never been written to is a
 * normal startup state, not an error). A blank trailing line (the file's
 * final `\n`) is silently skipped.
 *
 * Only the **last** non-empty line is allowed to fail parsing: that is the
 * one line a process can plausibly have been killed while writing (see
 * `appendLine`'s tail-repair comment - by the time a *later* line exists,
 * the earlier one was already flushed whole). It is logged with
 * `console.warn` and dropped rather than crashing startup. Any **other**
 * (non-last) line that fails to parse is not an artifact of a torn write -
 * every line before the true last one was necessarily completed before the
 * next one began - so it signals real corruption (a bad manual edit, a disk
 * fault, a bug in a writer) and is raised as `ParseError` rather than
 * silently skipped, which would hide data loss instead of surfacing it.
 *
 * Streams the file with `readline` rather than `readFile` + `split`, so a
 * large log does not have to be held as one in-memory string and array of
 * lines before parsing begins.
 */
export async function readLines<T>(path: string, parse: (line: string) => T): Promise<T[]> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  try {
    const rawLines: string[] = [];
    const rl = createInterface({ input: handle.createReadStream({ encoding: 'utf8' }) });
    for await (const line of rl) {
      if (line.trim() !== '') rawLines.push(line);
    }

    const records: T[] = [];
    const lastIndex = rawLines.length - 1;
    for (const [index, line] of rawLines.entries()) {
      try {
        records.push(parse(line));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (index === lastIndex) {
          console.warn(
            `${path}: ignoring unparseable last line (likely a truncated write): ${message}`,
          );
        } else {
          throw new ParseError(
            `${path}: line ${index + 1} of ${rawLines.length} failed to parse and is not the ` +
              `file's last line, so it cannot be a truncated write: ${message}`,
            path,
          );
        }
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
