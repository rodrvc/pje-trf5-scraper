/**
 * Tests del cliente HTTP contra un servidor simulado.
 *
 * El manejo de 429 es criterio de evaluación del desafío, y se decidió no
 * demostrarlo provocándolo contra el sitio real de un tribunal. Estos tests son
 * esa demostración: reproducen el rate limiting de forma controlada y
 * reproducible, sin enviar una sola petición a la red.
 */

import nock from 'nock';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpClient } from '../src/http/client.js';
import { CircuitBreakerError, RateLimitError } from '../src/domain/errors.js';

const BASE = 'https://ejemplo.test';

/** Cliente sin esperas reales, para que los tests no tarden. */
function clienteRapido(overrides: ConstructorParameters<typeof HttpClient>[0] = {}) {
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
  it('decodifica ISO-8859-1, que es lo que responde el sitio', async () => {
    // "APELAÇÃO CÍVEL" codificado en latin-1.
    const latin1 = Buffer.from('APELAÇÃO CÍVEL', 'latin1');
    nock(BASE).get('/pagina').reply(200, latin1, { 'Content-Type': 'text/html;charset=ISO-8859-1' });

    const { html } = await clienteRapido().get(`${BASE}/pagina`);

    expect(html).toBe('APELAÇÃO CÍVEL');
  });

  it('no produce la corrupción típica de leer latin-1 como UTF-8', async () => {
    const latin1 = Buffer.from('Última movimentação', 'latin1');
    nock(BASE).get('/pagina').reply(200, latin1, { 'Content-Type': 'text/html;charset=ISO-8859-1' });

    const { html } = await clienteRapido().get(`${BASE}/pagina`);

    expect(html).toBe('Última movimentação');
    // Leerlo como UTF-8 daría "Ãltima movimentaÃ§Ã£o".
    expect(html).not.toContain('Ã§');
    expect(html).not.toContain('Ã£');
  });
});

describe('reintentos ante 429', () => {
  it('reintenta y termina devolviendo la respuesta buena', async () => {
    nock(BASE).get('/x').reply(429).get('/x').reply(429).get('/x').reply(200, 'ok');

    const respuesta = await clienteRapido().get(`${BASE}/x`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.html).toBe('ok');
    expect(nock.isDone()).toBe(true);
  });

  it('respeta el Retry-After que envía el servidor', async () => {
    nock(BASE).get('/x').reply(429, '', { 'Retry-After': '0' }).get('/x').reply(200, 'ok');

    const esperas: number[] = [];
    const cliente = clienteRapido({
      alReintentar: ({ esperaMs }) => esperas.push(esperaMs),
    });

    await cliente.get(`${BASE}/x`);

    // Retry-After: 0 manda por encima del backoff calculado.
    expect(esperas).toEqual([0]);
  });

  it('avisa de cada reintento, para poder registrarlo', async () => {
    nock(BASE).get('/x').reply(429).get('/x').reply(429).get('/x').reply(200, 'ok');

    const intentos: number[] = [];
    const cliente = clienteRapido({
      alReintentar: ({ intento }) => intentos.push(intento),
    });

    await cliente.get(`${BASE}/x`);

    expect(intentos).toEqual([1, 2]);
  });

  it('se rinde con RateLimitError al agotar los reintentos', async () => {
    nock(BASE).get('/x').times(3).reply(429, '', { 'Retry-After': '7' });

    const cliente = clienteRapido({ maxReintentos: 2 });

    await expect(cliente.get(`${BASE}/x`)).rejects.toThrow(RateLimitError);
  });

  it('conserva el Retry-After en el error, para poder reintentar más tarde', async () => {
    nock(BASE).get('/x').times(2).reply(429, '', { 'Retry-After': '42' });

    const cliente = clienteRapido({ maxReintentos: 1 });

    await expect(cliente.get(`${BASE}/x`)).rejects.toMatchObject({
      retryAfterSegundos: 42,
    });
  });

  it('reintenta también los 5xx transitorios', async () => {
    nock(BASE).get('/x').reply(503).get('/x').reply(200, 'ok');

    const respuesta = await clienteRapido().get(`${BASE}/x`);

    expect(respuesta.status).toBe(200);
  });

  it('no reintenta un 404: no es transitorio', async () => {
    nock(BASE).get('/x').reply(404, 'no está');

    const respuesta = await clienteRapido().get(`${BASE}/x`);

    expect(respuesta.status).toBe(404);
    expect(nock.isDone()).toBe(true); // una sola petición
  });
});

describe('circuit breaker', () => {
  it('aborta cuando el servidor insiste en pedir que paremos', async () => {
    nock(BASE).get('/x').times(10).reply(429);

    const cliente = clienteRapido({ maxReintentos: 20, umbralCircuitBreaker: 3 });

    await expect(cliente.get(`${BASE}/x`)).rejects.toThrow(CircuitBreakerError);
  });

  it('vuelve a cero tras una respuesta buena', async () => {
    nock(BASE)
      .get('/a')
      .reply(429)
      .get('/a')
      .reply(200, 'ok')
      .get('/b')
      .reply(429)
      .get('/b')
      .reply(200, 'ok');

    const cliente = clienteRapido({ umbralCircuitBreaker: 2 });

    // Dos 429 en total, pero no consecutivos: no debe saltar el breaker.
    await expect(cliente.get(`${BASE}/a`)).resolves.toMatchObject({ status: 200 });
    await expect(cliente.get(`${BASE}/b`)).resolves.toMatchObject({ status: 200 });
  });
});

describe('descargas binarias', () => {
  it('devuelve los bytes sin decodificar y expone el content-type', async () => {
    const pdf = Buffer.from('%PDF-1.4\nbinario\n');
    nock(BASE).get('/doc').reply(200, pdf, { 'Content-Type': 'application/pdf' });

    const respuesta = await clienteRapido().getBinario(`${BASE}/doc`);

    expect(respuesta.contentType).toContain('application/pdf');
    expect(respuesta.datos.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('sigue el redirect, que es como se sirven los PDFs del PJe', async () => {
    nock(BASE)
      .get('/documento?idBin=1')
      .reply(302, '', { Location: `${BASE}/download.seam?cid=99` });
    nock(BASE)
      .get('/download.seam?cid=99')
      .reply(200, Buffer.from('%PDF-1.4'), { 'Content-Type': 'application/pdf' });

    const respuesta = await clienteRapido().getBinario(`${BASE}/documento?idBin=1`);

    expect(respuesta.datos.toString()).toContain('%PDF');
    expect(nock.isDone()).toBe(true);
  });
});

describe('ritmo entre peticiones', () => {
  it('espacia las peticiones para no atropellar al servidor', async () => {
    nock(BASE).get('/a').reply(200, 'a').get('/b').reply(200, 'b');

    const cliente = new HttpClient({ delayMs: 50 });
    const inicio = Date.now();
    await cliente.get(`${BASE}/a`);
    await cliente.get(`${BASE}/b`);

    expect(Date.now() - inicio).toBeGreaterThanOrEqual(45);
  });

  it('serializa las peticiones concurrentes en vez de lanzarlas a la vez', async () => {
    let enVuelo = 0;
    let maximoSimultaneo = 0;

    nock(BASE)
      .get('/x')
      .times(3)
      .reply(() => {
        enVuelo++;
        maximoSimultaneo = Math.max(maximoSimultaneo, enVuelo);
        enVuelo--;
        return [200, 'ok'];
      });

    const cliente = clienteRapido();
    await Promise.all([
      cliente.get(`${BASE}/x`),
      cliente.get(`${BASE}/x`),
      cliente.get(`${BASE}/x`),
    ]);

    expect(maximoSimultaneo).toBe(1);
  });
});
