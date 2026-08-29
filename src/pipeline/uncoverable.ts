/**
 * Records leaves abandoned before their party-token cover plateaued.
 *
 * ISSUE-4b's acceptance requires that a leaf abandoned mid-way through its
 * request budget is never counted as complete. An `abandoned` `SweepEvent`
 * already carries everything needed to report that honestly (`filtersTried`,
 * `unionSize`, the rows found so far); this module is just the minimal sink
 * for it, so a consumer of the sweep can call `recordUncoverable` once per
 * `abandoned` event without inventing its own file format.
 *
 * Deliberately small: ISSUE-7 owns the general persistence and resuming
 * story (state files, atomic writes, `--retry-failed`) and may fold this into
 * a richer writer later. This module commits to the file **format** the two
 * issues coordinate on - one JSON object per line, append-only - without
 * pre-building resuming machinery that belongs to ISSUE-7.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Query, SearchResultRow } from '../domain/types.js';

/** Default location, relative to the process's working directory. */
export const DEFAULT_UNCOVERABLE_PATH = 'data/uncoverable.ndjson';

/** One record: a leaf whose cover ran out of budget while the union was still growing. */
export interface UncoverableRecord {
  query: Query;
  depth: number;
  filtersTried: number;
  unionSize: number;
  rows: SearchResultRow[];
  /** When the record was written, ISO 8601 - for auditing a run after the fact. */
  recordedAt: string;
}

/**
 * Appends one NDJSON line for an abandoned leaf.
 *
 * Creates the parent directory if missing (a fresh checkout has no `data/`
 * yet) and appends rather than rewrites, matching ISSUE-7's append-only
 * design for the same reason: an interrupted process must not corrupt what
 * was already recorded.
 */
export async function recordUncoverable(
  record: Omit<UncoverableRecord, 'recordedAt'>,
  path: string = DEFAULT_UNCOVERABLE_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify({ ...record, recordedAt: new Date().toISOString() });
  await appendFile(path, `${line}\n`, 'utf8');
}
