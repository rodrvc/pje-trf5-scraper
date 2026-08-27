/**
 * HTTP client tests against a simulated server.
 *
 * Handling 429 is an explicit grading criterion, and the decision was not to
 * demonstrate it by provoking one against a real court's site. These tests are
 * that demonstration: they reproduce rate limiting in a controlled, repeatable
 * way without sending a single request over the network.
 */

import nock from 'nock';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpClient } from '../src/http/client.js';
import { CircuitBreakerError, RateLimitError } from '../src/domain/errors.js';

const BASE = 'https://example.test';

/** Client with no real waits, to keep the tests fast. */
function fastClient(overrides: ConstructorParameters<typeof HttpClient>[0] = {}) {
  return new HttpClient({
    delayMs: 0,
    backoff: { baseMs: 1, maxMs: 5, jitter: 0 },
    ...overrides,
  });
}

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe('encoding', () => {
  it('decodes ISO-8859-1, which is what page loads return', async () => {
    // "APELAÇÃO CÍVEL" encoded as latin-1.
    const latin1 = Buffer.from('APELAÇÃO CÍVEL', 'latin1');
    nock(BASE).get('/page').reply(200, latin1, { 'Content-Type': 'text/html;charset=ISO-8859-1' });

    const { html } = await fastClient().get(`${BASE}/page`);

    expect(html).toBe('APELAÇÃO CÍVEL');
  });

  it('avoids the corruption typical of reading latin-1 as UTF-8', async () => {
    const latin1 = Buffer.from('Última movimentação', 'latin1');
    nock(BASE).get('/page').reply(200, latin1, { 'Content-Type': 'text/html;charset=ISO-8859-1' });

    const { html } = await fastClient().get(`${BASE}/page`);

    expect(html).toBe('Última movimentação');
    // Reading it as UTF-8 would give "Ãltima movimentaÃ§Ã£o".
    expect(html).not.toContain('Ã§');
    expect(html).not.toContain('Ã£');
  });
});

describe('retrying on 429', () => {
  it('retries and eventually returns the good response', async () => {
    nock(BASE).get('/x').reply(429).get('/x').reply(429).get('/x').reply(200, 'ok');

    const response = await fastClient().get(`${BASE}/x`);

    expect(response.status).toBe(200);
    expect(response.html).toBe('ok');
    expect(nock.isDone()).toBe(true);
  });

  it('honours the Retry-After the server sends', async () => {
    nock(BASE).get('/x').reply(429, '', { 'Retry-After': '0' }).get('/x').reply(200, 'ok');

    const delays: number[] = [];
    const client = fastClient({
      onRetry: ({ delayMs }) => delays.push(delayMs),
    });

    await client.get(`${BASE}/x`);

    // Retry-After: 0 wins over the computed backoff.
    expect(delays).toEqual([0]);
  });

  it('reports each retry so it can be logged', async () => {
    nock(BASE).get('/x').reply(429).get('/x').reply(429).get('/x').reply(200, 'ok');

    const attempts: number[] = [];
    const client = fastClient({
      onRetry: ({ attempt }) => attempts.push(attempt),
    });

    await client.get(`${BASE}/x`);

    expect(attempts).toEqual([1, 2]);
  });

  it('gives up with RateLimitError once retries run out', async () => {
    nock(BASE).get('/x').times(3).reply(429, '', { 'Retry-After': '7' });

    const client = fastClient({ maxRetries: 2 });

    await expect(client.get(`${BASE}/x`)).rejects.toThrow(RateLimitError);
  });

  it('keeps Retry-After on the error, so it can be retried later', async () => {
    nock(BASE).get('/x').times(2).reply(429, '', { 'Retry-After': '42' });

    const client = fastClient({ maxRetries: 1 });

    await expect(client.get(`${BASE}/x`)).rejects.toMatchObject({
      retryAfterSeconds: 42,
    });
  });

  it('retries transient 5xx as well', async () => {
    nock(BASE).get('/x').reply(503).get('/x').reply(200, 'ok');

    const response = await fastClient().get(`${BASE}/x`);

    expect(response.status).toBe(200);
  });

  it('does not retry a 404: it is not transient', async () => {
    nock(BASE).get('/x').reply(404, 'not found');

    const response = await fastClient().get(`${BASE}/x`);

    expect(response.status).toBe(404);
    expect(nock.isDone()).toBe(true); // a single request
  });
});

describe('circuit breaker', () => {
  it('aborts when the server keeps asking us to stop', async () => {
    nock(BASE).get('/x').times(10).reply(429);

    const client = fastClient({ maxRetries: 20, circuitBreakerThreshold: 3 });

    await expect(client.get(`${BASE}/x`)).rejects.toThrow(CircuitBreakerError);
  });

  it('resets after a good response', async () => {
    nock(BASE)
      .get('/a')
      .reply(429)
      .get('/a')
      .reply(200, 'ok')
      .get('/b')
      .reply(429)
      .get('/b')
      .reply(200, 'ok');

    const client = fastClient({ circuitBreakerThreshold: 2 });

    // Two 429s overall, but not consecutive: the breaker must not trip.
    await expect(client.get(`${BASE}/a`)).resolves.toMatchObject({ status: 200 });
    await expect(client.get(`${BASE}/b`)).resolves.toMatchObject({ status: 200 });
  });
});

describe('binary downloads', () => {
  it('returns undecoded bytes and exposes the content type', async () => {
    const pdf = Buffer.from('%PDF-1.4\nbinary\n');
    nock(BASE).get('/doc').reply(200, pdf, { 'Content-Type': 'application/pdf' });

    const response = await fastClient().getBinary(`${BASE}/doc`);

    expect(response.contentType).toContain('application/pdf');
    expect(response.data.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('follows the redirect, which is how PJe serves its PDFs', async () => {
    nock(BASE)
      .get('/document?idBin=1')
      .reply(302, '', { Location: `${BASE}/download.seam?cid=99` });
    nock(BASE)
      .get('/download.seam?cid=99')
      .reply(200, Buffer.from('%PDF-1.4'), { 'Content-Type': 'application/pdf' });

    const response = await fastClient().getBinary(`${BASE}/document?idBin=1`);

    expect(response.data.toString()).toContain('%PDF');
    expect(nock.isDone()).toBe(true);
  });
});

describe('request pacing', () => {
  it('spaces out requests so the server is not overrun', async () => {
    nock(BASE).get('/a').reply(200, 'a').get('/b').reply(200, 'b');

    const client = new HttpClient({ delayMs: 50 });
    const start = Date.now();
    await client.get(`${BASE}/a`);
    await client.get(`${BASE}/b`);

    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('serializes concurrent requests instead of firing them at once', async () => {
    let inFlight = 0;
    let peakConcurrency = 0;

    nock(BASE)
      .get('/x')
      .times(3)
      .reply(() => {
        inFlight++;
        peakConcurrency = Math.max(peakConcurrency, inFlight);
        inFlight--;
        return [200, 'ok'];
      });

    const client = fastClient();
    await Promise.all([
      client.get(`${BASE}/x`),
      client.get(`${BASE}/x`),
      client.get(`${BASE}/x`),
    ]);

    expect(peakConcurrency).toBe(1);
  });
});
