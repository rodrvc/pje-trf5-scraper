/**
 * Live smoke test for ISSUE-9c: a bounded demo run of the full orchestrator
 * (sweep -> detail -> PDFs -> persistence) against the real TRF5 site,
 * proving the run stays inside an explicit request/case budget rather than
 * running away on a saturated day (ISSUE-4's "Known cost": class-splitting
 * one saturating day alone can cost up to 132 requests).
 *
 * No assertions - prints the `RunSummary` and exits. Not run in CI; kept as a
 * permanent demo script (`npm run smoke:orchestrator`), the one ISSUE-8's
 * README points readers at.
 *
 * Flags (all optional): --from=YYYY-MM-DD (default: yesterday, UTC),
 * --to=YYYY-MM-DD (default: same as --from), --max-requests=N (default: 40),
 * --max-cases=N (default: 3), --delay-ms=N (default: 1500).
 *
 * Writes under `data/`/`pdfs/` (both gitignored) - delete manually afterwards.
 */
import { HttpClient } from '../src/http/client.js';
import type { RequestCounter, RunSummary } from '../src/pipeline/orchestrator.js';
import { Scraper } from '../src/pipeline/orchestrator.js';
import { DateRangeSplit, JudicialClassSplit, PartitionChain } from '../src/pipeline/partition.js';
import { PersistenceStore } from '../src/persistence/store.js';
import { PjeDetail } from '../src/pje/detail.js';
import { PjeDownloader } from '../src/pje/download.js';
import { PjeSearch } from '../src/pje/search.js';
import { JsfSession } from '../src/pje/session.js';

function flag(name: string, args: string[]): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

function yesterdayUtc(): string {
  const ms = Date.now() - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

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

async function main() {
  const args = process.argv.slice(2);
  const from = flag('from', args) ?? yesterdayUtc();
  const to = flag('to', args) ?? from;
  const maxRequests = Number(flag('max-requests', args) ?? '40');
  const maxCases = Number(flag('max-cases', args) ?? '3');
  const delayMs = Number(flag('delay-ms', args) ?? '1500');

  console.log(`range: ${from}..${to}`);
  console.log(`limits: maxRequests=${maxRequests}, maxCases=${maxCases}, delayMs=${delayMs}`);

  const requestCounter = new LiveRequestCounter();
  const http = new HttpClient({
    delayMs,
    onRequest: () => (requestCounter.requests += 1),
    onRetry: () => (requestCounter.retries429 += 1),
  });
  const session = new JsfSession(http);
  const search = new PjeSearch(session);
  const detail = new PjeDetail(session);
  const downloader = new PjeDownloader({ session, rootDir: 'pdfs' });
  const store = new PersistenceStore({ dataDir: 'data' });

  const catalog = await search.classCatalog();
  const chain = new PartitionChain([new DateRangeSplit(), new JudicialClassSplit(catalog)]);

  const scraper = new Scraper({
    search: (query) => search.search(query),
    detail,
    downloader,
    store,
    chain,
    // Sweep events can carry up to 30 rows each: print a one-line summary,
    // not the full payload, so the terminal stays readable.
    logger: {
      log: (event) =>
        console.log(
          event.kind === 'sweep'
            ? JSON.stringify({ kind: 'sweep', type: event.event.type, query: event.event.query, rows: event.event.rows.length })
            : JSON.stringify(event),
        ),
    },
    requestCounter,
    limits: { maxRequests, maxCases },
  });

  try {
    const summary = await scraper.run({ from, to });
    printSummary(summary);
    if (summary.windows === 1 && summary.casesListed === 0) {
      console.log('hint: 0 cases listed for a single window - the default day (yesterday) may be a weekend or holiday; try --from/--to on a business day.');
    }
  } catch (error) {
    // A RunAbortedError (circuit breaker) still carries a usable summary.
    if (error !== null && typeof error === 'object' && 'summary' in error) {
      printSummary((error as { summary: RunSummary }).summary);
    }
    throw error;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
