import { describe, expect, it } from 'vitest';

import { CliArgsError, parseArgs } from '../src/cli/args.js';
import { format, formatRetry } from '../src/cli/logger.js';

describe('parseArgs', () => {
  it('defaults from/to to yesterday (UTC) and fills in every other default', () => {
    const options = parseArgs([]);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(options).toMatchObject({
      from: yesterday,
      to: yesterday,
      maxRequests: 40,
      maxCases: 3,
      delayMs: 1500,
      retryFailed: false,
      dataDir: 'data',
      pdfDir: 'pdfs',
      unbounded: false,
    });
  });

  it('accepts a full flag set, both --name=value and --name value', () => {
    const options = parseArgs([
      '--from=2025-03-01',
      '--to',
      '2025-03-05',
      '--max-requests=100',
      '--max-cases=10',
      '--delay-ms=2000',
      '--retry-failed',
      '--data-dir=out/data',
      '--pdf-dir=out/pdfs',
      '--unbounded',
    ]);
    expect(options).toEqual({
      from: '2025-03-01',
      to: '2025-03-05',
      maxRequests: 100,
      maxCases: 10,
      delayMs: 2000,
      retryFailed: true,
      dataDir: 'out/data',
      pdfDir: 'out/pdfs',
      unbounded: true,
    });
  });

  it('rejects an invalid date', () => {
    expect(() => parseArgs(['--from=03-01-2025'])).toThrow(CliArgsError);
  });

  it('rejects a delay below the 500ms floor', () => {
    expect(() => parseArgs(['--delay-ms=100'])).toThrow(CliArgsError);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus=1'])).toThrow(CliArgsError);
  });
});

describe('format', () => {
  it('renders a final search window', () => {
    const line = format({
      kind: 'sweep',
      event: { type: 'window', query: { from: '2025-03-05', to: '2025-03-05' }, rows: [{ number: '1', ca: 'a' }], depth: 0 },
    });
    expect(line).toBe('search 2025-03-05 -> 1 rows');
  });

  it('renders a downloaded document', () => {
    const line = format({
      kind: 'document-downloaded',
      caseNumber: '0800123-45.2025.4.05.8100',
      documentId: '1234',
      skipped: false,
    });
    expect(line).toBe('pdf 0800123-45.2025.4.05.8100 doc 1234 saved');
  });

  it('renders a failed case', () => {
    const line = format({ kind: 'case-failed', number: '123', reason: 'ParseError: boom' });
    expect(line).toBe('case 123 FAILED: ParseError: boom');
  });
});

describe('formatRetry', () => {
  it('renders a 429 wait', () => {
    expect(formatRetry({ attempt: 2, delayMs: 4000, url: 'https://x' })).toBe('429 -> waiting 4.0s (attempt 2)');
  });
});
