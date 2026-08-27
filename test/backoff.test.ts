import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKOFF, computeDelay, parseRetryAfter } from '../src/http/backoff.js';

/** Fixed randomness source, so delays are deterministic. */
const noJitter = () => 0.5;

describe('parseRetryAfter', () => {
  it('understands the seconds format', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('understands the HTTP date format', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    const inOneMinute = 'Wed, 21 Oct 2026 07:29:00 GMT';
    expect(parseRetryAfter(inOneMinute, now)).toBe(60_000);
  });

  it('never returns a negative wait when the date has passed', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    const past = 'Wed, 21 Oct 2026 07:00:00 GMT';
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('returns undefined when the header is missing or unparseable', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('computeDelay', () => {
  it('grows exponentially with each attempt', () => {
    const options = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };
    expect(computeDelay(1, options, undefined, noJitter)).toBe(1_000);
    expect(computeDelay(2, options, undefined, noJitter)).toBe(2_000);
    expect(computeDelay(3, options, undefined, noJitter)).toBe(4_000);
    expect(computeDelay(4, options, undefined, noJitter)).toBe(8_000);
  });

  it('never exceeds the configured ceiling', () => {
    const options = { baseMs: 1_000, maxMs: 5_000, jitter: 0 };
    expect(computeDelay(10, options, undefined, noJitter)).toBe(5_000);
  });

  it('lets the server Retry-After win over our own calculation', () => {
    const options = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };
    // Exponential would give 4000; the server asks for 30s and the server wins.
    expect(computeDelay(3, options, 30_000, noJitter)).toBe(30_000);
  });

  it('applies the ceiling to Retry-After too, so the run cannot stall', () => {
    const options = { baseMs: 1_000, maxMs: 10_000, jitter: 0 };
    expect(computeDelay(1, options, 3_600_000, noJitter)).toBe(10_000);
  });

  it('spreads delays with jitter so retries do not sync up', () => {
    const options = { baseMs: 1_000, maxMs: 60_000, jitter: 0.3 };
    const lowest = computeDelay(1, options, undefined, () => 0);
    const highest = computeDelay(1, options, undefined, () => 1);

    expect(lowest).toBe(700); // 1000 - 30%
    expect(highest).toBe(1_300); // 1000 + 30%
    expect(lowest).not.toBe(highest);
  });

  it('never returns a negative delay', () => {
    const options = { baseMs: 100, maxMs: 60_000, jitter: 2 };
    expect(computeDelay(1, options, undefined, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('ships sensible defaults', () => {
    expect(DEFAULT_BACKOFF.baseMs).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF.maxMs).toBeGreaterThan(DEFAULT_BACKOFF.baseMs);
  });
});
