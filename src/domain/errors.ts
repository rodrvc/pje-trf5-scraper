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

/**
 * The detail view GET returned a page that is neither an ordinary case detail
 * nor a positively-identified sealed case (segredo de justiça).
 *
 * This covers whatever else the site can hand back: a database error page
 * rendered as HTML with a 200 status, a dropped session that the `open()` GET
 * does not otherwise detect (unlike `post()`, which retries once), a changed
 * layout. None of these are the same domain state as a sealed case - treating
 * them as "sealed" would silently persist a failure as if it were real data
 * and never retry it. `reason` carries a short, human-readable excerpt of what
 * actually came back, so the run log says what happened instead of just
 * failing silently. Left for the orchestrator (ISSUE-9) to decide whether to
 * retry or record as failed - that decision does not belong in the parser.
 */
export class UnexpectedDetailPageError extends ScraperError {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}
