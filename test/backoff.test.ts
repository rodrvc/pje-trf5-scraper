import { describe, expect, it } from 'vitest';

import {
  BACKOFF_POR_DEFECTO,
  calcularEspera,
  parseRetryAfter,
} from '../src/http/backoff.js';

/** Fuente de aleatoriedad fija, para que las esperas sean deterministas. */
const sinJitter = () => 0.5;

describe('parseRetryAfter', () => {
  it('entiende el formato en segundos', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('entiende el formato de fecha HTTP', () => {
    const ahora = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    const dentroDeUnMinuto = 'Wed, 21 Oct 2026 07:29:00 GMT';
    expect(parseRetryAfter(dentroDeUnMinuto, ahora)).toBe(60_000);
  });

  it('nunca devuelve espera negativa si la fecha ya pasó', () => {
    const ahora = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    const pasado = 'Wed, 21 Oct 2026 07:00:00 GMT';
    expect(parseRetryAfter(pasado, ahora)).toBe(0);
  });

  it('devuelve undefined cuando la cabecera falta o no se entiende', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('pronto')).toBeUndefined();
  });
});

describe('calcularEspera', () => {
  it('crece de forma exponencial con cada intento', () => {
    const opciones = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };
    expect(calcularEspera(1, opciones, undefined, sinJitter)).toBe(1_000);
    expect(calcularEspera(2, opciones, undefined, sinJitter)).toBe(2_000);
    expect(calcularEspera(3, opciones, undefined, sinJitter)).toBe(4_000);
    expect(calcularEspera(4, opciones, undefined, sinJitter)).toBe(8_000);
  });

  it('no supera el techo configurado', () => {
    const opciones = { baseMs: 1_000, maxMs: 5_000, jitter: 0 };
    expect(calcularEspera(10, opciones, undefined, sinJitter)).toBe(5_000);
  });

  it('obedece al Retry-After del servidor por encima del cálculo propio', () => {
    const opciones = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };
    // El exponencial daría 4000; el servidor pide 30s y manda el servidor.
    expect(calcularEspera(3, opciones, 30_000, sinJitter)).toBe(30_000);
  });

  it('aplica el techo también al Retry-After, para no colgar la ejecución', () => {
    const opciones = { baseMs: 1_000, maxMs: 10_000, jitter: 0 };
    expect(calcularEspera(1, opciones, 3_600_000, sinJitter)).toBe(10_000);
  });

  it('reparte las esperas con jitter para que los reintentos no se sincronicen', () => {
    const opciones = { baseMs: 1_000, maxMs: 60_000, jitter: 0.3 };
    const minimo = calcularEspera(1, opciones, undefined, () => 0);
    const maximo = calcularEspera(1, opciones, undefined, () => 1);

    expect(minimo).toBe(700); // 1000 - 30%
    expect(maximo).toBe(1_300); // 1000 + 30%
    expect(minimo).not.toBe(maximo);
  });

  it('nunca devuelve una espera negativa', () => {
    const opciones = { baseMs: 100, maxMs: 60_000, jitter: 2 };
    expect(calcularEspera(1, opciones, undefined, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('trae valores por defecto razonables', () => {
    expect(BACKOFF_POR_DEFECTO.baseMs).toBeGreaterThan(0);
    expect(BACKOFF_POR_DEFECTO.maxMs).toBeGreaterThan(BACKOFF_POR_DEFECTO.baseMs);
  });
});
