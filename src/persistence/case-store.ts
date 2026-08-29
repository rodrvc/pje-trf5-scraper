/**
 * Persists `LegalCase` records to `data/cases.ndjson`, one per line, appended
 * as each case's detail is fetched.
 *
 * The `ca` detail token travels with the row (PROBLEMS.md §6: it does not
 * expire with the session), so a resumed run that finds a case already in
 * this store never has to re-run the search to reach it again - it already
 * has everything the detail view returned.
 *
 * Duplicate appends are tolerated by design rather than prevented at write
 * time: the sweep can legitimately see the same case from more than one
 * window before this store's in-memory index has a chance to reject it, and
 * refusing a second write would add a synchronous check on every append for
 * a problem the read side already solves for free. `index()` and `all()`
 * instead keep only the **latest** record per CNJ number, so a duplicate
 * append is idempotent from any reader's point of view - re-running detail
 * extraction on a case (e.g. after a schema field was added) just means the
 * newer line wins.
 */

import { join } from 'node:path';

import type { LegalCase } from '../domain/types.js';
import { appendLine, readLines } from './ndjson-log.js';

export const CASES_FILE = 'cases.ndjson';

export class CaseStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, CASES_FILE);
  }

  /** Appends one case record. Safe to call again for the same case (see module comment). */
  async append(legalCase: LegalCase): Promise<void> {
    await appendLine(this.path, legalCase);
  }

  /**
   * Rebuilds a CNJ-number → `LegalCase` index from disk.
   *
   * Called once at startup: the orchestrator (ISSUE-9) uses this to decide,
   * for every row the sweep or the pending queue hands it, whether the
   * case's detail has already been fetched in an earlier, interrupted run.
   */
  async index(): Promise<Map<string, LegalCase>> {
    const records = await readLines(this.path, (line) => JSON.parse(line) as LegalCase);
    const byNumber = new Map<string, LegalCase>();
    for (const record of records) {
      byNumber.set(record.number, record);
    }
    return byNumber;
  }

  /** All cases currently on record, latest write per CNJ number. */
  async all(): Promise<LegalCase[]> {
    return [...(await this.index()).values()];
  }

  /** Whether a case has already been fetched and stored. */
  async has(number: string): Promise<boolean> {
    return (await this.index()).has(number);
  }
}
