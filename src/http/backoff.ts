/**
 * Cálculo de la espera entre reintentos.
 *
 * Se separa del cliente HTTP porque es lógica pura: dado un número de intento y
 * una cabecera opcional del servidor, devuelve cuántos milisegundos esperar.
 * Así se puede probar exhaustivamente sin red de por medio, que es lo que hace
 * demostrable el manejo de 429 sin castigar el sitio real.
 */

export interface BackoffOptions {
  /** Espera del primer reintento, en ms. Los siguientes se duplican. */
  baseMs: number;
  /** Techo de la espera, en ms. Evita esperas absurdas en intentos altos. */
  maxMs: number;
  /**
   * Proporción de aleatoriedad, entre 0 y 1.
   *
   * Sin jitter, varias peticiones que fallan a la vez reintentarían
   * sincronizadas y volverían a chocar. Con 0.3 la espera varía ±30%.
   */
  jitter: number;
}

export const BACKOFF_POR_DEFECTO: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 0.3,
};

/**
 * Interpreta la cabecera `Retry-After`, que puede venir en dos formatos:
 * segundos ("120") o fecha HTTP ("Wed, 21 Oct 2026 07:28:00 GMT").
 *
 * @param ahoraMs Momento actual, inyectable para poder probar el formato fecha.
 * @returns Milisegundos de espera, o `undefined` si la cabecera falta o no se
 *   entiende. Nunca devuelve negativo: una fecha ya pasada equivale a 0.
 */
export function parseRetryAfter(
  valor: string | undefined,
  ahoraMs: number = Date.now(),
): number | undefined {
  if (valor === undefined) return undefined;

  const texto = valor.trim();
  if (texto === '') return undefined;

  // Formato en segundos.
  if (/^\d+$/.test(texto)) {
    return Number(texto) * 1_000;
  }

  // Formato fecha HTTP.
  const fechaMs = Date.parse(texto);
  if (Number.isNaN(fechaMs)) return undefined;

  return Math.max(0, fechaMs - ahoraMs);
}

/**
 * Calcula cuánto esperar antes del siguiente intento.
 *
 * El `Retry-After` del servidor tiene prioridad sobre el cálculo propio: si el
 * servidor dice cuánto esperar, obedecerlo es lo correcto. Igual se le aplica
 * el techo, para que un valor desmedido no cuelgue la ejecución.
 *
 * @param intento Número de reintento, empezando en 1.
 * @param aleatorio Fuente de aleatoriedad, inyectable para tests deterministas.
 */
export function calcularEspera(
  intento: number,
  opciones: BackoffOptions = BACKOFF_POR_DEFECTO,
  retryAfterMs?: number,
  aleatorio: () => number = Math.random,
): number {
  const { baseMs, maxMs, jitter } = opciones;

  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, maxMs);
  }

  // Exponencial: base * 2^(intento-1), acotado al techo.
  const exponencial = Math.min(baseMs * 2 ** Math.max(0, intento - 1), maxMs);

  // Jitter simétrico: ±(jitter * 100)% alrededor del valor calculado.
  const desviacion = exponencial * jitter * (aleatorio() * 2 - 1);

  return Math.max(0, Math.round(exponencial + desviacion));
}

/** Pausa la ejecución. */
export function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
