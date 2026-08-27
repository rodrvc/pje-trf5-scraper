/**
 * Errores del scraper.
 *
 * Están tipados porque cada uno exige una reacción distinta: el rate limiting
 * se reintenta con espera, la sesión caída se reestablece, y una consulta
 * rechazada no tiene sentido reintentarla tal cual. Distinguirlos por clase
 * evita tener que inspeccionar el texto del mensaje para decidir qué hacer.
 */

export abstract class ScraperError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * El servidor respondió 429. Se reintenta con backoff exponencial.
 *
 * `retryAfterSegundos` viene de la cabecera `Retry-After` cuando el servidor la
 * envía; en ese caso tiene prioridad sobre el backoff calculado.
 */
export class RateLimitError extends ScraperError {
  constructor(
    message: string,
    readonly retryAfterSegundos?: number,
  ) {
    super(message);
  }
}

/**
 * La sesión JSF caducó.
 *
 * Llega como 200 con el HTML de la home, no como un error HTTP, así que hay que
 * detectarla por contenido. Se resuelve reestableciendo la sesión y reintentando
 * la operación.
 */
export class SessionExpiredError extends ScraperError {}

/**
 * El servidor validó la consulta y la rechazó (por ejemplo, exige al menos dos
 * nombres al buscar por parte). Reintentarla sin cambiarla daría lo mismo.
 */
export class RejectedQueryError extends ScraperError {
  constructor(
    message: string,
    readonly mensajeServidor: string,
  ) {
    super(message);
  }
}

/** El HTML no tenía la forma esperada. Suele indicar que el sitio cambió. */
export class ParseError extends ScraperError {
  constructor(
    message: string,
    readonly contexto?: string,
  ) {
    super(message);
  }
}

/** La descarga no devolvió un PDF válido. */
export class DownloadError extends ScraperError {
  constructor(
    message: string,
    readonly contentType?: string,
  ) {
    super(message);
  }
}

/**
 * Se acumularon demasiados 429 seguidos.
 *
 * Corta la ejecución en vez de seguir insistiendo contra un servidor que está
 * pidiendo explícitamente que se pare.
 */
export class CircuitBreakerError extends ScraperError {}
