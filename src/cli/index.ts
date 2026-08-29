/**
 * CLI entry point (ISSUE-8): `npm start` / `npm run scrape`.
 *
 * Only wires flags to a `Scraper` and prints progress/summary - every actual
 * decision (what to do with a sweep event, a failed detail fetch, a failed
 * download) lives in `src/pipeline/orchestrator.ts`, not here (see that
 * module's doc comment on why: keeping business logic out of `main()` is
 * exactly the anti-pattern ISSUE-9 exists to avoid).
 *
 * Promoted from `scripts/smoke-orchestrator.ts` (ISSUE-9c's bounded demo
 * script), plus the party-token cover (ISSUE-4b), which that script never
 * wired in - see `createPartyTokenSweep`.
 */

import { CliArgsError, parseArgs, usage, wantsHelp } from './args.js';
import { ConsoleLogger } from './logger.js';
import { HttpClient } from '../http/client.js';
import type { RequestCounter, RunSummary } from '../pipeline/orchestrator.js';
import { RunAbortedError, Scraper } from '../pipeline/orchestrator.js';
import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../pipeline/partition.js';
import { createPartyTokenSweep } from '../pipeline/party-sweep.js';
import { PersistenceStore } from '../persistence/store.js';
import { PjeDetail } from '../pje/detail.js';
import { PjeDownloader } from '../pje/download.js';
import { PjeSearch } from '../pje/search.js';
import { JsfSession } from '../pje/session.js';

/** A `RequestCounter` fed straight from `HttpClientOptions.onRequest`/`onRetry`. */
class LiveRequestCounter implements RequestCounter {
  requests = 0;
  retries429 = 0;
}

/** Prints one readable "label: value" line per `RunSummary` field, in a fixed order. */
function printSummary(summary: RunSummary): void {
  const lines: [string, unknown][] = [
    ['windows', summary.windows],
    ['cases listed', summary.casesListed],
    ['cases detailed', summary.casesDetailed],
    ['cases failed', summary.casesFailed],
    ['documents downloaded', summary.documentsDownloaded],
    ['documents skipped', summary.documentsSkipped],
    ['documents failed', summary.documentsFailed],
    ['requests', summary.requests],
    ['429 retries', summary.retries429],
    ['cases on disk', summary.casesOnDisk],
    ['pending rows', summary.pendingRows],
    ['retryable cases', summary.retryableCases],
    ['retryable documents', summary.retryableDocuments],
    ['stopped by', summary.stoppedBy ?? '(ran to completion)'],
  ];
  console.log('--- run summary ---');
  for (const [label, value] of lines) console.log(`${label}: ${value}`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (wantsHelp(argv)) {
    console.log(usage());
    return 0;
  }

  const options = parseArgs(argv);

  console.log(`range: ${options.from}..${options.to}`);
  console.log(
    options.unbounded
      ? `limits: none (--unbounded), delayMs=${options.delayMs}, retryFailed=${options.retryFailed}`
      : `limits: maxRequests=${options.maxRequests}, maxCases=${options.maxCases}, delayMs=${options.delayMs}, retryFailed=${options.retryFailed}`,
  );

  const logger = new ConsoleLogger();
  const requestCounter = new LiveRequestCounter();
  const http = new HttpClient({
    delayMs: options.delayMs,
    onRequest: () => (requestCounter.requests += 1),
    onRetry: (info) => {
      requestCounter.retries429 += 1;
      logger.retry(info);
    },
  });
  const session = new JsfSession(http);
  const search = new PjeSearch(session);
  const detail = new PjeDetail(session);
  const downloader = new PjeDownloader({ session, rootDir: options.pdfDir });
  const store = new PersistenceStore({ dataDir: options.dataDir });

  const catalog = await search.classCatalog();
  const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);

  const scraper = new Scraper({
    search: (query) => search.search(query),
    detail,
    downloader,
    store,
    chain,
    // ISSUE-4b: reaches cases a saturated day+class window alone cannot show.
    cover: createPartyTokenSweep(),
    logger,
    requestCounter,
    ...(options.unbounded
      ? {}
      : { limits: { maxRequests: options.maxRequests, maxCases: options.maxCases } }),
  });

  try {
    const summary = options.retryFailed
      ? await scraper.retryFailed()
      : await scraper.run({ from: options.from, to: options.to });
    printSummary(summary);
    if (!options.retryFailed && summary.windows === 1 && summary.casesListed === 0) {
      console.log(
        'hint: 0 cases listed for a single window - the default day (yesterday) may be a weekend or holiday; try --from/--to on a business day.',
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof RunAbortedError) {
      // The orchestrator already logged `run aborted: <reason>` through the sink.
      printSummary(error.summary);
      return 1;
    }
    throw error;
  }
}

// `process.exitCode` rather than `process.exit()`: an immediate exit can
// truncate piped stdout (`npm run scrape | tee run.log`) before it drains.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliArgsError) {
      console.error(`error: ${error.message}\n`);
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
