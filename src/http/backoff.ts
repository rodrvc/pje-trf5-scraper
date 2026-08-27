/**
 * Retry delay computation.
 *
 * Kept apart from the HTTP client because it is pure logic: given an attempt
 * number and an optional server header, it returns how many milliseconds to
 * wait. That makes it exhaustively testable without a network, which is what
 * makes the 429 handling demonstrable without hammering the live site.
 */

export interface BackoffOptions {
  /** Delay for the first retry, in ms. Each subsequent one doubles. */
  baseMs: number;
  /** Delay ceiling, in ms. Keeps high attempt counts from waiting absurdly long. */
  maxMs: number;
  /**
   * Randomness ratio between 0 and 1.
   *
   * Without jitter, requests that fail at the same time would retry in lockstep
   * and collide again. At 0.3 the delay varies by ±30%.
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 0.3,
};

/**
 * Parses the `Retry-After` header, which comes in two formats: seconds ("120")
 * or an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT").
 *
 * @param nowMs Current time, injectable so the date format can be tested.
 * @returns Milliseconds to wait, or `undefined` when the header is missing or
 *   unparseable. Never negative: a date already in the past means 0.
 */
export function parseRetryAfter(
  value: string | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;

  const text = value.trim();
  if (text === '') return undefined;

  // Seconds format.
  if (/^\d+$/.test(text)) {
    return Number(text) * 1_000;
  }

  // HTTP date format.
  const targetMs = Date.parse(text);
  if (Number.isNaN(targetMs)) return undefined;

  return Math.max(0, targetMs - nowMs);
}

/**
 * Computes how long to wait before the next attempt.
 *
 * The server's `Retry-After` takes precedence over our own calculation: if the
 * server says how long to wait, obeying it is the right call. The ceiling still
 * applies, so an outlandish value cannot stall the run.
 *
 * @param attempt Retry number, starting at 1.
 * @param random Randomness source, injectable for deterministic tests.
 */
export function computeDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const { baseMs, maxMs, jitter } = options;

  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, maxMs);
  }

  // Exponential: base * 2^(attempt-1), capped at the ceiling.
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);

  // Symmetric jitter: ±(jitter * 100)% around the computed value.
  const deviation = exponential * jitter * (random() * 2 - 1);

  return Math.max(0, Math.round(exponential + deviation));
}

/** Pauses execution. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
