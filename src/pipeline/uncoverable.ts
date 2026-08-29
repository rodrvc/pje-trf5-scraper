/**
 * Records leaves abandoned before their party-token cover plateaued.
 *
 * ISSUE-4b's acceptance requires that a leaf abandoned mid-way through its
 * request budget is never counted as complete. An `abandoned` `SweepEvent`
 * already carries everything needed to report that honestly (`filtersTried`,
 * `unionSize`), so this module is a minimal sink for it - a consumer of the
 * sweep can call `recordUncoverable` once per `abandoned` event without
 * inventing its own file format.
 *
 * Deliberately small: ISSUE-7 owns the general persistence and resuming
 * story (state files, atomic writes, `--retry-failed`), including where the
 * `abandoned` event's already-deduplicated `rows` get persisted as part of
 * the run's normal output. This module does not duplicate that: storing the
 * full row payload here too would let the same cases be double-counted on a
 * later replay that reads both files. It commits only to the **format** the
 * two issues coordinate on for the counters and evidence a completeness
 * claim needs - one JSON object per line, append-only.
 *
 * No caller wires this in yet: ISSUE-4b's own tests exercise it directly, and
 * ISSUE-7's runner (not yet built) is expected to call it once per
 * `abandoned` `SweepEvent` it observes.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Query } from '../domain/types.js';

/** One record: a leaf whose cover ran out of budget while the union was still growing. */
export interface UncoverableRecord {
  query: Query;
  depth: number;
  filtersTried: number;
  unionSize: number;
  /**
   * CNJ numbers found so far, optional. Not the full row objects - those are
   * already part of the `abandoned` event's deduplicated output, which
   * ISSUE-7 persists separately; repeating them here would double the
   * bookkeeping for the same information. The bare numbers are kept only as
   * a lightweight cross-check against that other record, when useful.
   */
  cnjNumbers?: string[];
  /** When the record was written, ISO 8601 - for auditing a run after the fact. */
  recordedAt: string;
}

/**
 * Appends one NDJSON line for an abandoned leaf.
 *
 * `path` is required and injected rather than defaulted to a path under
 * `data/`: ISSUE-7 owns that directory's layout and lifecycle, and this
 * module should not assume where its caller wants the file written. Creates
 * the parent directory if missing and appends rather than rewrites, matching
 * ISSUE-7's append-only design for the same reason: an interrupted process
 * must not corrupt what was already recorded.
 */
export async function recordUncoverable(
  record: Omit<UncoverableRecord, 'recordedAt'>,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify({ ...record, recordedAt: new Date().toISOString() });
  await appendFile(path, `${line}\n`, 'utf8');
}
