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
 * cost for no benefit). An `appendFile` of one complete, `\n`-terminated
 * line is a single syscall-level write that either lands whole or not at
 * all on any POSIX filesystem for writes below the pipe buffer size (every
 * line this module writes is a small JSON object, always well under that);
 * there is nothing to rename because there is no whole-file rewrite to make
 * atomic in the first place. The one failure mode this leaves is a process
 * killed mid-write leaving a torn final line - handled by
 * `readLines` below, which drops a trailing line that does not parse and
 * logs why, rather than crashing the whole store on startup.
 *
 * Every store module (`case-store.ts`, `pending-store.ts`,
 * `sweep-progress-store.ts`, `failed-document-store.ts`,
 * `uncoverable-store.ts`) reads its NDJSON file through `readLines` and
 * writes through `appendLine`, so the "tolerate a truncated last line"
 * behaviour and the "one appendFile per write" guarantee live in exactly one
 * place instead of five slightly-different copies.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Appends one record as a single JSON line, creating the parent directory
 * first if needed. Each call is one `appendFile`, so concurrent appenders
 * within the same process still interleave whole lines, never partial ones.
 */
export async function appendLine(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Reads every line of an NDJSON file and parses each with `parse`.
 *
 * Missing file reads as empty (a store that has never been written to is a
 * normal startup state, not an error). A blank trailing line (the file's
 * final `\n`) is silently skipped. Any other line that fails to parse is
 * assumed to be a torn write from a process killed mid-append - logged to
 * `console.warn` with its line number and dropped, rather than crashing
 * startup over the last, possibly-incomplete record. Every earlier line is
 * unaffected: a torn write only ever damages the line being written when the
 * process dies, never lines already flushed before it.
 */
export async function readLines<T>(path: string, parse: (line: string) => T): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const records: T[] = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      records.push(parse(line));
    } catch (error) {
      console.warn(
        `${path}: ignoring unparseable line ${index + 1} (likely a truncated write): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return records;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
