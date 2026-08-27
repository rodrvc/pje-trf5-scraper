/**
 * Cliente HTTP: transporte puro.
 *
 * Deliberadamente no sabe nada de JSF, ViewState ni del PJe. Se encarga de
 * cookies, redirects, encoding, ritmo y reintentos. El protocolo de la
 * aplicación vive una capa más arriba, en `src/pje/`.
 */

import axios, { type AxiosInstance, type AxiosResponse, isAxiosError } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import iconv from 'iconv-lite';
import { CookieJar } from 'tough-cookie';

import { CircuitBreakerError, RateLimitError } from '../domain/errors.js';
import {
  BACKOFF_POR_DEFECTO,
  type BackoffOptions,
  calcularEspera,
  esperar,
  parseRetryAfter,
} from './backoff.js';

/**
 * El sitio responde en ISO-8859-1. Decodificar como UTF-8 corrompe los acentos
 * ("APELAÇÃO" queda "APELAÃÃO"), así que se convierte explícitamente.
 */
const ENCODING_DEL_SITIO = 'latin1';

export interface HttpClientOptions {
  /** Espera mínima entre peticiones, en ms. Evita sobrecargar el servidor. */
  delayMs?: number;
  /** Reintentos ante 429 antes de rendirse con esa petición. */
  maxReintentos?: number;
  /** Cuántos 429 seguidos se toleran antes de abortar la ejecución. */
  umbralCircuitBreaker?: number;
  backoff?: BackoffOptions;
  timeoutMs?: number;
  userAgent?: string;
  /** Se invoca antes de cada espera por rate limiting, para poder registrarla. */
  alReintentar?: (info: { intento: number; esperaMs: number; url: string }) => void;
}

/** Respuesta ya decodificada a texto. */
export interface RespuestaTexto {
  html: string;
  status: number;
  url: string;
  headers: Record<string, string>;
}

/** Respuesta binaria, para descargas. */
export interface RespuestaBinaria {
  datos: Buffer;
  status: number;
  contentType: string;
  url: string;
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly jar: CookieJar;
  private readonly delayMs: number;
  private readonly maxReintentos: number;
  private readonly umbralCircuitBreaker: number;
  private readonly backoff: BackoffOptions;
  private readonly alReintentar: HttpClientOptions['alReintentar'];

  /** Momento de la última petición, para espaciar la siguiente. */
  private ultimaPeticionMs = 0;

  /** 429 consecutivos. Se reinicia con cada respuesta buena. */
  private rateLimitsSeguidos = 0;

  /**
   * Cola de peticiones.
   *
   * Serializa el acceso a la red: concurrencia 1. Es el sitio de un tribunal
   * real y el enunciado pide no sobrecargarlo; además el ritmo entre peticiones
   * solo tiene sentido si no hay varias en vuelo a la vez.
   */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(options: HttpClientOptions = {}) {
    this.delayMs = options.delayMs ?? 1_000;
    this.maxReintentos = options.maxReintentos ?? 5;
    this.umbralCircuitBreaker = options.umbralCircuitBreaker ?? 10;
    this.backoff = options.backoff ?? BACKOFF_POR_DEFECTO;
    this.alReintentar = options.alReintentar;

    this.jar = new CookieJar();
    this.axios = wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        timeout: options.timeoutMs ?? 30_000,
        maxRedirects: 5,
        // El texto se decodifica a mano desde latin-1, y las descargas son
        // binarias: en ambos casos hace falta el buffer sin tocar.
        responseType: 'arraybuffer',
        // Los 4xx/5xx se gestionan aquí, no como excepción de axios.
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

  /** Vacía las cookies. Se usa al reestablecer una sesión caída. */
  async reiniciarSesion(): Promise<void> {
    await this.jar.removeAllCookies();
    this.rateLimitsSeguidos = 0;
  }

  async get(url: string, headers?: Record<string, string>): Promise<RespuestaTexto> {
    const respuesta = await this.pedir({ method: 'GET', url, ...(headers ? { headers } : {}) });
    return this.aTexto(respuesta, url);
  }

  async post(
    url: string,
    cuerpo: URLSearchParams,
    headers?: Record<string, string>,
  ): Promise<RespuestaTexto> {
    const respuesta = await this.pedir({
      method: 'POST',
      url,
      data: cuerpo.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...headers,
      },
    });
    return this.aTexto(respuesta, url);
  }

  /**
   * GET que devuelve los bytes sin decodificar.
   *
   * Para los PDFs: el enlace redirige a `download.seam?cid=<N>`, y ese `cid` es
   * de un solo uso, así que hay que seguir el redirect en el momento y quedarse
   * con el contenido.
   */
  async getBinario(url: string, headers?: Record<string, string>): Promise<RespuestaBinaria> {
    const respuesta = await this.pedir({ method: 'GET', url, ...(headers ? { headers } : {}) });
    return {
      datos: Buffer.from(respuesta.data as ArrayBuffer),
      status: respuesta.status,
      contentType: String(respuesta.headers['content-type'] ?? ''),
      url: respuesta.request?.res?.responseUrl ?? url,
    };
  }

  private aTexto(respuesta: AxiosResponse, urlOriginal: string): RespuestaTexto {
    const headers: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(respuesta.headers)) {
      if (typeof valor === 'string') headers[clave.toLowerCase()] = valor;
    }

    return {
      html: iconv.decode(Buffer.from(respuesta.data as ArrayBuffer), ENCODING_DEL_SITIO),
      status: respuesta.status,
      url: respuesta.request?.res?.responseUrl ?? urlOriginal,
      headers,
    };
  }

  /** Encola la petición para que no haya dos en vuelo a la vez. */
  private pedir(config: Parameters<AxiosInstance['request']>[0]): Promise<AxiosResponse> {
    const resultado = this.cola.then(
      () => this.pedirConReintentos(config),
      () => this.pedirConReintentos(config),
    );
    // La cola no debe romperse porque una petición falle.
    this.cola = resultado.catch(() => undefined);
    return resultado;
  }

  private async pedirConReintentos(
    config: Parameters<AxiosInstance['request']>[0],
  ): Promise<AxiosResponse> {
    const url = String(config.url ?? '');

    for (let intento = 0; intento <= this.maxReintentos; intento++) {
      await this.respetarRitmo();

      let respuesta: AxiosResponse;
      try {
        respuesta = await this.axios.request(config);
      } catch (error) {
        // Fallo de red: se reintenta con la misma política que un 429, porque
        // suele ser transitorio.
        if (intento === this.maxReintentos || !this.esErrorTransitorio(error)) throw error;
        await this.esperarAntesDeReintentar(intento + 1, undefined, url);
        continue;
      }

      if (!this.mereceReintento(respuesta.status)) {
        this.rateLimitsSeguidos = 0;
        return respuesta;
      }

      if (respuesta.status === 429) {
        this.rateLimitsSeguidos++;
        if (this.rateLimitsSeguidos >= this.umbralCircuitBreaker) {
          throw new CircuitBreakerError(
            `${this.rateLimitsSeguidos} respuestas 429 seguidas: se aborta para no ` +
              'insistir contra un servidor que está pidiendo parar.',
          );
        }
      }

      if (intento === this.maxReintentos) {
        if (respuesta.status === 429) {
          throw new RateLimitError(
            `429 tras ${this.maxReintentos} reintentos: ${url}`,
            parseRetryAfterSegundos(respuesta),
          );
        }
        return respuesta;
      }

      const retryAfterMs = parseRetryAfter(
        typeof respuesta.headers['retry-after'] === 'string'
          ? respuesta.headers['retry-after']
          : undefined,
      );
      await this.esperarAntesDeReintentar(intento + 1, retryAfterMs, url);
    }

    // Inalcanzable: el bucle sale por return o por throw.
    throw new Error('estado inesperado en el bucle de reintentos');
  }

  /** 429 y 5xx transitorios merecen otro intento; el resto no. */
  private mereceReintento(status: number): boolean {
    return status === 429 || status === 503 || status === 502 || status === 504;
  }

  private esErrorTransitorio(error: unknown): boolean {
    if (!isAxiosError(error)) return false;
    const codigosTransitorios = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNABORTED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
    ];
    return error.code !== undefined && codigosTransitorios.includes(error.code);
  }

  private async esperarAntesDeReintentar(
    intento: number,
    retryAfterMs: number | undefined,
    url: string,
  ): Promise<void> {
    const esperaMs = calcularEspera(intento, this.backoff, retryAfterMs);
    this.alReintentar?.({ intento, esperaMs, url });
    await esperar(esperaMs);
  }

  /** Espacia las peticiones para no atropellar al servidor. */
  private async respetarRitmo(): Promise<void> {
    if (this.delayMs <= 0) return;

    const transcurrido = Date.now() - this.ultimaPeticionMs;
    if (transcurrido < this.delayMs) {
      await esperar(this.delayMs - transcurrido);
    }
    this.ultimaPeticionMs = Date.now();
  }
}

function parseRetryAfterSegundos(respuesta: AxiosResponse): number | undefined {
  const cabecera = respuesta.headers['retry-after'];
  if (typeof cabecera !== 'string') return undefined;
  const ms = parseRetryAfter(cabecera);
  return ms === undefined ? undefined : Math.round(ms / 1_000);
}
