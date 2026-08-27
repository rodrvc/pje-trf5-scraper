/**
 * Scraper errors.
 *
 * These are typed because each one calls for a different reaction: rate limiting
 * is retried after a wait, an expired session is re-established, and a rejected
 * query is pointless to retry unchanged. Distinguishing them by class avoids
 * inspecting error messages to decide what to do.
 */

export abstract class ScraperError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The server answered 429. Retried with exponential backoff.
 *
 * `retryAfterSeconds` comes from the `Retry-After` header when the server sends
 * one, in which case it takes precedence over the computed backoff.
 */
export class RateLimitError extends ScraperError {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * The JSF session expired.
 *
 * It arrives as a 200 carrying the home page rather than an HTTP error, so it
 * has to be detected by content. Recovering means re-establishing the session
 * and retrying the operation.
 */
export class SessionExpiredError extends ScraperError {}

/**
 * The server validated the query and rejected it - searching by party name
 * requires at least two names, for instance. Retrying it unchanged would give
 * the same outcome.
 */
export class RejectedQueryError extends ScraperError {
  constructor(
    message: string,
    readonly serverMessage: string,
  ) {
    super(message);
  }
}

/** The markup did not have the expected shape. Usually means the site changed. */
export class ParseError extends ScraperError {
  constructor(
    message: string,
    readonly context?: string,
  ) {
    super(message);
  }
}

/** The download did not return a valid PDF. */
export class DownloadError extends ScraperError {
  constructor(
    message: string,
    readonly contentType?: string,
  ) {
    super(message);
  }
}

/**
 * Too many consecutive 429s piled up.
 *
 * Stops the run instead of hammering a server that is explicitly asking us to
 * back off.
 */
export class CircuitBreakerError extends ScraperError {}
