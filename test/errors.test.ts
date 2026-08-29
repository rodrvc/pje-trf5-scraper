import { describe, expect, it } from 'vitest';

import {
  CircuitBreakerError,
  RateLimitError,
  RejectedQueryError,
  ScraperError,
  SessionExpiredError,
  UnexpectedDetailPageError,
} from '../src/domain/errors.js';

describe('scraper errors', () => {
  it('are told apart by class, without inspecting the message', () => {
    const errors: ScraperError[] = [
      new RateLimitError('429'),
      new SessionExpiredError('session dropped'),
      new CircuitBreakerError('too many 429s'),
    ];

    expect(errors.filter((e) => e instanceof RateLimitError)).toHaveLength(1);
    expect(errors.every((e) => e instanceof ScraperError)).toBe(true);
  });

  it('RateLimitError keeps the server Retry-After', () => {
    expect(new RateLimitError('429', 30).retryAfterSeconds).toBe(30);
    expect(new RateLimitError('429').retryAfterSeconds).toBeUndefined();
  });

  it('RejectedQueryError keeps the reason the server gave', () => {
    const reason = 'É necessário informar ao menos dois nomes';
    expect(new RejectedQueryError('rejected', reason).serverMessage).toBe(reason);
  });

  it('each error reports its own class name', () => {
    expect(new SessionExpiredError('x').name).toBe('SessionExpiredError');
  });

  it('UnexpectedDetailPageError keeps the reason so the run log says what came back', () => {
    const error = new UnexpectedDetailPageError('unexpected page', 'database error page');
    expect(error.reason).toBe('database error page');
    expect(error).toBeInstanceOf(ScraperError);
  });
});
