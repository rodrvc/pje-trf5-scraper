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
 * a problem the read side already solves for free. The index instead keeps
 * only the **latest** record per CNJ number, so a duplicate append is
 * idempotent from any reader's point of view - re-running detail extraction
 * on a case (e.g. after a schema field was added, or to persist a
 * downloaded PDF's `localPath` once documents finish - see
 * `PersistenceStore.completeRow`) just means the newer line wins.
 *
 * The index is read from disk exactly once per process (lazily, on first
 * use), then kept up to date in memory by every `append` - a single-process
 * store never needs to re-scan its own file to see writes it just made
 * itself. This turns what used to be an O(file size) re-read on every
 * `has()`/`index()` call - O(n) per row checked, O(n²) over a whole run -
 * into one O(file size) rebuild total, plus O(1) per subsequent write.
 */

import { join } from 'node:path';

import type { LegalCase } from '../domain/types.js';
import { appendLine, readLines } from './ndjson-log.js';

export const CASES_FILE = 'cases.ndjson';

export class CaseStore {
  private readonly path: string;
  private cachedIndex: Map<string, LegalCase> | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, CASES_FILE);
  }

  /**
   * Appends one case record and updates the in-memory index immediately (if
   * already built), so an `index()`/`has()` call right after an `append()`
   * in the same process sees it without touching disk again.
   */
  async append(legalCase: LegalCase): Promise<void> {
    await appendLine(this.path, legalCase);
    this.cachedIndex?.set(legalCase.number, legalCase);
  }

  /**
   * The CNJ-number → `LegalCase` index, built from disk on first call and
   * cached for the lifetime of this store instance.
   */
  async index(): Promise<Map<string, LegalCase>> {
    if (this.cachedIndex === undefined) {
      const records = await readLines(this.path, (line) => JSON.parse(line) as LegalCase);
      const byNumber = new Map<string, LegalCase>();
      for (const record of records) {
        byNumber.set(record.number, record);
      }
      this.cachedIndex = byNumber;
    }
    return this.cachedIndex;
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
