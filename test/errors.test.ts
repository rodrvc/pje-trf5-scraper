import { describe, expect, it } from 'vitest';

import {
  CircuitBreakerError,
  RateLimitError,
  RejectedQueryError,
  ScraperError,
  SessionExpiredError,
} from '../src/domain/errors.js';

describe('errores del scraper', () => {
  it('se distinguen por clase, sin inspeccionar el mensaje', () => {
    const errores: ScraperError[] = [
      new RateLimitError('429'),
      new SessionExpiredError('sesión caída'),
      new CircuitBreakerError('demasiados 429'),
    ];

    expect(errores.filter((e) => e instanceof RateLimitError)).toHaveLength(1);
    expect(errores.every((e) => e instanceof ScraperError)).toBe(true);
  });

  it('RateLimitError conserva el Retry-After del servidor', () => {
    expect(new RateLimitError('429', 30).retryAfterSegundos).toBe(30);
    expect(new RateLimitError('429').retryAfterSegundos).toBeUndefined();
  });

  it('RejectedQueryError conserva el motivo que dio el servidor', () => {
    const motivo = 'É necessário informar ao menos dois nomes';
    expect(new RejectedQueryError('rechazada', motivo).mensajeServidor).toBe(motivo);
  });

  it('cada error reporta su propio nombre de clase', () => {
    expect(new SessionExpiredError('x').name).toBe('SessionExpiredError');
  });
});
