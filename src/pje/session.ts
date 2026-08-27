/**
 * Sesión JSF sobre el cliente HTTP.
 *
 * JSF exige que cada POST incluya el `javax.faces.ViewState` de la vista desde
 * la que se envía. Sin el par cookie + ViewState correcto el servidor responde
 * 200 con HTML válido pero sin resultados: falla en silencio, que es la parte
 * desagradable de depurar.
 *
 * El ViewState se guarda **por vista**, no como valor único: el de la página de
 * detalle es distinto al de la búsqueda, y mezclarlos rompe la navegación.
 */

import type { HttpClient, RespuestaTexto } from '../http/client.js';
import { ParseError, SessionExpiredError } from '../domain/errors.js';

export const BASE_URL = 'https://pjett.trf5.jus.br/pjeconsulta';

/** Las vistas que recorre el scraper. */
export const VISTAS = {
  busqueda: '/ConsultaPublica/listView.seam',
  detalle: '/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam',
} as const;

export type Vista = keyof typeof VISTAS;

const RE_VIEW_STATE = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/;

/** Extrae el ViewState de una respuesta. Función pura, testeable sin red. */
export function extraerViewState(html: string): string | undefined {
  return RE_VIEW_STATE.exec(html)?.[1];
}

/**
 * Detecta que la sesión caducó.
 *
 * El PJe no responde 401 ni 403: devuelve 200 con el formulario de búsqueda
 * vacío, como si acabaras de entrar. Se reconoce porque falta lo que la vista
 * debería contener.
 */
export function pareceSesionCaida(html: string, vista: Vista): boolean {
  if (vista === 'detalle') {
    // El detalle siempre trae esta cabecera; si no está, no estamos en el detalle.
    return !html.includes('Dados do Processo');
  }
  // En búsqueda, la desaparición del formulario indica que ya no hay vista viva.
  return !html.includes('javax.faces.ViewState');
}

export class JsfSession {
  /** ViewState por vista. */
  private readonly viewStates = new Map<Vista, string>();

  constructor(private readonly http: HttpClient) {}

  url(vista: Vista, query?: string): string {
    return `${BASE_URL}${VISTAS[vista]}${query ?? ''}`;
  }

  /**
   * Abre una vista y guarda su ViewState.
   *
   * Es el punto de entrada obligatorio: sin haber cargado la vista no hay
   * ViewState que enviar en los POST posteriores.
   */
  async abrir(vista: Vista, query?: string): Promise<RespuestaTexto> {
    const respuesta = await this.http.get(this.url(vista, query), {
      Referer: this.url('busqueda'),
    });
    this.registrarViewState(vista, respuesta.html);
    return respuesta;
  }

  /**
   * Envía un POST de la vista indicada, añadiendo su ViewState.
   *
   * Si la respuesta revela que la sesión caducó, la reestablece y reintenta una
   * vez. Un solo reintento basta: si vuelve a caer, el problema es otro y
   * conviene que se propague en vez de entrar en bucle.
   */
  async postear(
    vista: Vista,
    campos: URLSearchParams,
    opciones: { query?: string; reintentarSiCaduca?: boolean } = {},
  ): Promise<RespuestaTexto> {
    const { query, reintentarSiCaduca = true } = opciones;

    const viewState = this.viewStates.get(vista);
    if (viewState === undefined) {
      throw new ParseError(
        `No hay ViewState para la vista "${vista}": hay que abrirla antes de postear.`,
      );
    }

    const cuerpo = new URLSearchParams(campos);
    cuerpo.set('javax.faces.ViewState', viewState);

    const respuesta = await this.http.post(this.url(vista, query), cuerpo, {
      Referer: this.url(vista, query),
      'X-Requested-With': 'XMLHttpRequest',
    });

    this.registrarViewState(vista, respuesta.html);

    if (this.respuestaIndicaSesionCaida(respuesta, vista)) {
      if (!reintentarSiCaduca) {
        throw new SessionExpiredError(`La sesión caducó al postear en "${vista}".`);
      }
      await this.reestablecer(vista, query);
      return this.postear(vista, campos, { ...opciones, reintentarSiCaduca: false });
    }

    return respuesta;
  }

  /** Descarta la sesión actual y vuelve a abrir la vista desde cero. */
  async reestablecer(vista: Vista, query?: string): Promise<void> {
    await this.http.reiniciarSesion();
    this.viewStates.clear();
    await this.abrir(vista, query);
  }

  viewStateDe(vista: Vista): string | undefined {
    return this.viewStates.get(vista);
  }

  private registrarViewState(vista: Vista, html: string): void {
    const viewState = extraerViewState(html);
    if (viewState !== undefined) {
      this.viewStates.set(vista, viewState);
    }
  }

  /**
   * Una respuesta AJAX parcial no trae la página entera, así que no se puede
   * juzgar con el mismo criterio que una carga completa: solo se considera
   * caída si además perdió el ViewState.
   */
  private respuestaIndicaSesionCaida(respuesta: RespuestaTexto, vista: Vista): boolean {
    const esRespuestaAjax = respuesta.html.includes('Ajax-Response');
    if (esRespuestaAjax) {
      return extraerViewState(respuesta.html) === undefined;
    }
    return pareceSesionCaida(respuesta.html, vista);
  }
}
