/**
 * Live smoke test for ISSUE-9 (part 1): runs the real orchestrator loop
 * against the actual TRF5 site for one day (2025-03-05, 10 cases, no class
 * split needed - see the issue resolution for the recorded numbers).
 *
 * Not part of the automated test suite (no assertions, just printed output)
 * and not run in CI - same posture as `scripts/smoke-download.ts`. Kept as a
 * committed, re-runnable tool.
 *
 * To stay under ~25 live requests: documents are only downloaded for the
 * FIRST case detailed (`only_first_case` downloader below); every other
 * case still gets its real detail fetch (so the loop itself, not just the
 * search, is exercised end to end). `delayMs: 1500` throttles every request.
 * The temp data/pdfs directories are removed at the end regardless of
 * outcome.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpClient } from '../src/http/client.js';
import { PjeDetail } from '../src/pje/detail.js';
import { PjeDownloader, type DownloadResult } from '../src/pje/download.js';
import { PjeSearch } from '../src/pje/search.js';
import { JsfSession } from '../src/pje/session.js';
import { PersistenceStore } from '../src/persistence/store.js';
import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../src/pipeline/partition.js';
import { Scraper, type LogSink, type OrchestratorLogEvent } from '../src/pipeline/orchestrator.js';
import type { CaseDocument } from '../src/domain/types.js';

const RANGE = { from: '2025-03-05', to: '2025-03-05' };

/** Prints every orchestrator event as it happens. */
const consoleLogger: LogSink = {
  log(event: OrchestratorLogEvent) {
    console.log(`[${event.kind}]`, JSON.stringify(event).slice(0, 200));
  },
};

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'orchestrator-smoke-data-'));
  const pdfDir = await mkdtemp(join(tmpdir(), 'orchestrator-smoke-pdfs-'));

  try {
    const http = new HttpClient({ delayMs: 1500 });
    const session = new JsfSession(http);
    const pjeSearch = new PjeSearch(session);
    const detail = new PjeDetail(session);
    const realDownloader = new PjeDownloader({ session, rootDir: pdfDir });

    const catalog = await pjeSearch.classCatalog();
    const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);
    const store = new PersistenceStore({ dataDir });

    // Downloads documents only for the first case whose detail was fetched,
    // to keep this run's live request count small; every other case is
    // still detailed for real, exercising the full loop.
    let firstCaseNumber: string | undefined;
    const cappedDownloader = {
      async download(caseNumber: string, doc: CaseDocument, ca?: string): Promise<DownloadResult> {
        firstCaseNumber ??= caseNumber;
        if (caseNumber !== firstCaseNumber) {
          return { ok: true, path: '(skipped by smoke script)', bytes: 0, skipped: true };
        }
        return realDownloader.download(caseNumber, doc, ca);
      },
    };

    const scraper = new Scraper({
      search: (query) => pjeSearch.search(query),
      detail,
      downloader: cappedDownloader as unknown as PjeDownloader,
      store,
      chain,
      logger: consoleLogger,
    });

    const summary = await scraper.run(RANGE);
    console.log('--- summary ---');
    console.log(summary);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(pdfDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
