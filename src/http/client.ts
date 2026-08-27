/**
 * HTTP client: transport only.
 *
 * Deliberately knows nothing about JSF, ViewState or PJe. It handles cookies,
 * redirects, encoding, pacing and retries. The application protocol lives one
 * layer up, in `src/pje/`.
 */

import axios, { type AxiosInstance, type AxiosResponse, isAxiosError } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import iconv from 'iconv-lite';
import { CookieJar } from 'tough-cookie';

import { CircuitBreakerError, RateLimitError } from '../domain/errors.js';
import {
  DEFAULT_BACKOFF,
  type BackoffOptions,
  computeDelay,
  sleep,
  parseRetryAfter,
} from './backoff.js';

/**
 * The site does **not** use a single encoding: full page loads arrive as
 * ISO-8859-1, while the AJAX responses to POSTs arrive as UTF-8. Neither
 * declares a `charset` in the body, so the header cannot be trusted.
 *
 * The decision is made from the bytes: UTF-8 has a validatable structure, and
 * accented latin-1 text is almost never valid UTF-8 by accident. If it decodes
 * as UTF-8, it is UTF-8; otherwise it is latin-1.
 *
 * Getting this wrong corrupts every extracted field: "APELAÇÃO" becomes
 * "APELAÃÃO".
 */
function decodeByBytes(buffer: Buffer): string {
  const asUtf8 = buffer.toString('utf8');

  // The replacement character shows up when the bytes are not valid UTF-8.
  if (!asUtf8.includes('�')) {
    return asUtf8;
  }

  return iconv.decode(buffer, 'latin1');
}

export interface HttpClientOptions {
  /** Minimum wait between requests, in ms. Keeps load off the server. */
  delayMs?: number;
  /** Retries on 429 before giving up on a request. */
  maxRetries?: number;
  /** How many consecutive 429s to tolerate before aborting the run. */
  circuitBreakerThreshold?: number;
  backoff?: BackoffOptions;
  timeoutMs?: number;
  userAgent?: string;
  /** Called before each rate-limit wait, so it can be logged. */
  onRetry?: (info: { attempt: number; delayMs: number; url: string }) => void;
}

/** A response already decoded to text. */
export interface TextResponse {
  html: string;
  status: number;
  url: string;
  headers: Record<string, string>;
}

/** A binary response, for downloads. */
export interface BinaryResponse {
  data: Buffer;
  status: number;
  contentType: string;
  url: string;
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly jar: CookieJar;
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly circuitBreakerThreshold: number;
  private readonly backoff: BackoffOptions;
  private readonly onRetry: HttpClientOptions['onRetry'];

  /** Timestamp of the last request, used to space out the next one. */
  private lastRequestMs = 0;

  /** Consecutive 429s. Reset by any good response. */
  private consecutiveRateLimits = 0;

  /**
   * Request queue.
   *
   * Serializes network access: concurrency 1. This is a real court's public
   * service and the brief asks not to overload it; besides, pacing between
   * requests only means something when there is one in flight at a time.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HttpClientOptions = {}) {
    this.delayMs = options.delayMs ?? 1_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 10;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.onRetry = options.onRetry;

    this.jar = new CookieJar();
    this.axios = wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        timeout: options.timeoutMs ?? 30_000,
        maxRedirects: 5,
        // Text is decoded by hand and downloads are binary: both need the
        // untouched buffer.
        responseType: 'arraybuffer',
        // 4xx/5xx are handled here, not as axios exceptions.
        validateStatus: () => true,
        headers: {
          'User-Agent':
            options.userAgent ??
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      }),
    );
  }

  /** Clears cookies. Used when re-establishing an expired session. */
  async resetSession(): Promise<void> {
    await this.jar.removeAllCookies();
    this.consecutiveRateLimits = 0;
  }

  async get(url: string, headers?: Record<string, string>): Promise<TextResponse> {
    const response = await this.enqueue({ method: 'GET', url, ...(headers ? { headers } : {}) });
    return this.toText(response, url);
  }

  async post(
    url: string,
    body: URLSearchParams,
    headers?: Record<string, string>,
  ): Promise<TextResponse> {
    const response = await this.enqueue({
      method: 'POST',
      url,
      data: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...headers,
      },
    });
    return this.toText(response, url);
  }

  /**
   * GET returning the raw bytes.
   *
   * Used for PDFs: the document link redirects to `download.seam?cid=<N>`, and
   * that `cid` is single-use, so the redirect has to be followed right away and
   * the content kept.
   */
  async getBinary(url: string, headers?: Record<string, string>): Promise<BinaryResponse> {
    const response = await this.enqueue({ method: 'GET', url, ...(headers ? { headers } : {}) });
    return {
      data: Buffer.from(response.data as ArrayBuffer),
      status: response.status,
      contentType: String(response.headers['content-type'] ?? ''),
      url: response.request?.res?.responseUrl ?? url,
    };
  }

  private toText(response: AxiosResponse, originalUrl: string): TextResponse {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }

    return {
      html: decodeByBytes(Buffer.from(response.data as ArrayBuffer)),
      status: response.status,
      url: response.request?.res?.responseUrl ?? originalUrl,
      headers,
    };
  }

  /** Queues the request so no two are ever in flight at once. */
  private enqueue(config: Parameters<AxiosInstance['request']>[0]): Promise<AxiosResponse> {
    const result = this.queue.then(
      () => this.requestWithRetries(config),
      () => this.requestWithRetries(config),
    );
    // A failing request must not break the queue for everyone else.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async requestWithRetries(
    config: Parameters<AxiosInstance['request']>[0],
  ): Promise<AxiosResponse> {
    const url = String(config.url ?? '');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();

      let response: AxiosResponse;
      try {
        response = await this.axios.request(config);
      } catch (error) {
        // Network failure: retried under the same policy as a 429, since it is
        // usually transient.
        if (attempt === this.maxRetries || !this.isTransientNetworkError(error)) throw error;
        await this.waitBeforeRetry(attempt + 1, undefined, url);
        continue;
      }

      if (!this.isRetryableStatus(response.status)) {
        this.consecutiveRateLimits = 0;
        return response;
      }

      if (response.status === 429) {
        this.consecutiveRateLimits++;
        if (this.consecutiveRateLimits >= this.circuitBreakerThreshold) {
          throw new CircuitBreakerError(
            `${this.consecutiveRateLimits} consecutive 429 responses: aborting rather ` +
              'than hammering a server that is asking us to stop.',
          );
        }
      }

      if (attempt === this.maxRetries) {
        if (response.status === 429) {
          throw new RateLimitError(
            `429 after ${this.maxRetries} retries: ${url}`,
            retryAfterSeconds(response),
          );
        }
        return response;
      }

      const retryAfterMs = parseRetryAfter(
        typeof response.headers['retry-after'] === 'string'
          ? response.headers['retry-after']
          : undefined,
      );
      await this.waitBeforeRetry(attempt + 1, retryAfterMs, url);
    }

    // Unreachable: the loop exits through return or throw.
    throw new Error('unexpected state in retry loop');
  }

  /** 429 and transient 5xx deserve another attempt; nothing else does. */
  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 503 || status === 502 || status === 504;
  }

  private isTransientNetworkError(error: unknown): boolean {
    if (!isAxiosError(error)) return false;
    const transientCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNABORTED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
    ];
    return error.code !== undefined && transientCodes.includes(error.code);
  }

  private async waitBeforeRetry(
    attempt: number,
    retryAfterMs: number | undefined,
    url: string,
  ): Promise<void> {
    const delayMs = computeDelay(attempt, this.backoff, retryAfterMs);
    this.onRetry?.({ attempt, delayMs, url });
    await sleep(delayMs);
  }

  /** Spaces out requests so the server is not overrun. */
  private async throttle(): Promise<void> {
    if (this.delayMs <= 0) return;

    const elapsed = Date.now() - this.lastRequestMs;
    if (elapsed < this.delayMs) {
      await sleep(this.delayMs - elapsed);
    }
    this.lastRequestMs = Date.now();
  }
}

function retryAfterSeconds(response: AxiosResponse): number | undefined {
  const header = response.headers['retry-after'];
  if (typeof header !== 'string') return undefined;
  const ms = parseRetryAfter(header);
  return ms === undefined ? undefined : Math.round(ms / 1_000);
}
