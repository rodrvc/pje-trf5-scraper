/**
 * Pure argv parsing for the CLI (ISSUE-8). No `process`, no I/O, no defaults
 * that depend on the current date being baked in at import time - `parseArgs`
 * takes `argv` and returns a plain `CliOptions`, so it is unit-testable
 * without spawning the real entry point (`src/cli/index.ts`).
 *
 * Accepts both `--name=value` and `--name value` forms, since either is a
 * reasonable thing to type on a command line and the brief does not mandate
 * one over the other.
 */

/** Everything the CLI needs to run one `Scraper.run()`/`retryFailed()` call. */
export interface CliOptions {
  from: string;
  to: string;
  maxRequests: number;
  maxCases: number;
  delayMs: number;
  retryFailed: boolean;
  dataDir: string;
  pdfDir: string;
  /** No `limits` at all (a long-running full run) - see `--help`. */
  unbounded: boolean;
}

/** Thrown by `parseArgs` for any bad input; the CLI prints `usage()` and exits 2 for it. */
export class CliArgsError extends Error {}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_MAX_REQUESTS = 40;
const DEFAULT_MAX_CASES = 3;
const DEFAULT_DELAY_MS = 1500;
/** Below this, the client would hammer a real court's public server. */
const MIN_DELAY_MS = 500;

export function usage(): string {
  return `Usage: npm run scrape -- [options]

Scrapes the TRF5 PJe public case consultation over a date range, downloading
every case's documents (ISSUE-8). By default this is a BOUNDED DEMO run (see
--unbounded below) - safe to run repeatedly against the real site without
risking a long, uncapped crawl.

Options:
  --from=YYYY-MM-DD     Start of the date range (default: yesterday, UTC)
  --to=YYYY-MM-DD       End of the date range (default: same as --from)
  --max-requests=N      Stop after N network requests (default: ${DEFAULT_MAX_REQUESTS})
  --max-cases=N         Stop after N cases detailed (default: ${DEFAULT_MAX_CASES})
  --delay-ms=N          Minimum delay between requests (default: ${DEFAULT_DELAY_MS}, min: ${MIN_DELAY_MS})
  --retry-failed        Re-attempt previously failed cases/documents instead of a fresh
                        sweep (--from/--to are ignored)
  --data-dir=PATH       Where case/progress data is written (default: data)
  --pdf-dir=PATH        Where downloaded PDFs are written (default: pdfs)
  --unbounded           Run with no request/case budget at all (--max-requests and
                        --max-cases are ignored): a long-running full run, not the
                        bounded demo. Use with care: this is a real court's server.
  -h, --help            Show this help and exit

Examples:
  npm run scrape -- --from=2025-03-05 --to=2025-03-05 --max-cases=1
  npm run scrape -- --retry-failed
`;
}

/** Yesterday, UTC, as YYYY-MM-DD - the default range for a bounded demo run. */
function yesterdayUtc(): string {
  const ms = Date.now() - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Recognized `--name` flags, boolean ones included - used to reject unknown flags. */
const VALUED_FLAGS = new Set([
  'from',
  'to',
  'max-requests',
  'max-cases',
  'delay-ms',
  'data-dir',
  'pdf-dir',
]);
const BOOLEAN_FLAGS = new Set(['retry-failed', 'unbounded', 'help']);

/** Splits argv into a name -> value map, accepting both `--name=value` and `--name value`. */
function tokenize(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      result.set('help', true);
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new CliArgsError(`Unexpected argument: ${arg}`);
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const name = body.slice(0, eq);
      result.set(name, body.slice(eq + 1));
      continue;
    }

    if (BOOLEAN_FLAGS.has(body)) {
      result.set(body, true);
      continue;
    }

    if (VALUED_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new CliArgsError(`--${body} requires a value`);
      }
      result.set(body, next);
      i += 1;
      continue;
    }

    throw new CliArgsError(`Unknown flag: --${body}`);
  }

  return result;
}

function requireDate(name: string, value: string): string {
  if (!YMD.test(value)) {
    throw new CliArgsError(`--${name} must be YYYY-MM-DD, got: ${value}`);
  }
  return value;
}

function requirePositiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliArgsError(`--${name} must be a positive integer, got: ${value}`);
  }
  return n;
}

/** `flags.get(name)` narrowed to a string, or `fallback` when the flag was not given. */
function stringFlag(flags: Map<string, string | true>, name: string, fallback: string): string {
  const raw = flags.get(name);
  return typeof raw === 'string' ? raw : fallback;
}

export function parseArgs(argv: string[]): CliOptions {
  const flags = tokenize(argv);

  const unknown = [...flags.keys()].find(
    (name) => !VALUED_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name),
  );
  if (unknown !== undefined) {
    throw new CliArgsError(`Unknown flag: --${unknown}`);
  }

  const fromRaw = flags.get('from');
  const from = typeof fromRaw === 'string' ? requireDate('from', fromRaw) : yesterdayUtc();

  const toRaw = flags.get('to');
  const to = typeof toRaw === 'string' ? requireDate('to', toRaw) : from;

  if (from > to) {
    throw new CliArgsError(`--from (${from}) must not be after --to (${to})`);
  }

  const maxRequestsRaw = flags.get('max-requests');
  const maxRequests =
    typeof maxRequestsRaw === 'string'
      ? requirePositiveInt('max-requests', maxRequestsRaw)
      : DEFAULT_MAX_REQUESTS;

  const maxCasesRaw = flags.get('max-cases');
  const maxCases =
    typeof maxCasesRaw === 'string' ? requirePositiveInt('max-cases', maxCasesRaw) : DEFAULT_MAX_CASES;

  const delayMsRaw = flags.get('delay-ms');
  const delayMs =
    typeof delayMsRaw === 'string' ? requirePositiveInt('delay-ms', delayMsRaw) : DEFAULT_DELAY_MS;
  if (delayMs < MIN_DELAY_MS) {
    throw new CliArgsError(
      `--delay-ms must be at least ${MIN_DELAY_MS} - this is a real court's server, not a sandbox.`,
    );
  }

  return {
    from,
    to,
    maxRequests,
    maxCases,
    delayMs,
    retryFailed: flags.get('retry-failed') === true,
    dataDir: stringFlag(flags, 'data-dir', 'data'),
    pdfDir: stringFlag(flags, 'pdf-dir', 'pdfs'),
    unbounded: flags.get('unbounded') === true,
  };
}

/** Whether `--help`/`-h` was given, checked before full validation (help must never fail on bad flags). */
export function wantsHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}
