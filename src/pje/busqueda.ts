/**
 * Ejecución de búsquedas contra el formulario de Consulta Pública.
 *
 * JSF exige que el POST reproduzca el formulario completo, no solo los campos
 * que interesan: los que van vacíos también deben viajar. Omitir alguno hace
 * que el servidor responda 200 sin resultados, sin decir por qué.
 */

import type { Consulta, ClaseJudicial, RespuestaBusqueda } from '../domain/types.js';
import { RejectedQueryError } from '../domain/errors.js';
import { parsearRespuestaBusqueda } from '../domain/parse-resultados.js';
import {
  CAMPOS,
  descubrirIdBusqueda,
  FORM_BUSQUEDA,
  ID_BOTON_BUSQUEDA,
  SIN_SELECCION,
} from './constants.js';
import type { JsfSession } from './session.js';

/** Convierte una fecha ISO (2025-03-11) al formato del formulario (11/03/2025). */
export function aFechaFormulario(iso: string): string {
  const [anio, mes, dia] = iso.split('-');
  if (anio === undefined || mes === undefined || dia === undefined) {
    throw new RangeError(`Fecha ISO inválida: "${iso}"`);
  }
  return `${dia}/${mes}/${anio}`;
}

/** El mes de referencia que el calendario JSF espera junto a cada fecha. */
function mesDeReferencia(iso: string): string {
  const [anio, mes] = iso.split('-');
  return `${mes}/${anio}`;
}

export class BusquedaPje {
  /**
   * Id del componente que dispara la búsqueda.
   *
   * Se descubre del HTML en la primera búsqueda en vez de confiar en la
   * constante: los `j_idNNN` de JSF cambian si el tribunal redespliega, y esto
   * evita que el scraper deje de funcionar en silencio.
   */
  private idBoton = ID_BOTON_BUSQUEDA;
  private idBotonDescubierto = false;

  constructor(private readonly sesion: JsfSession) {}

  /**
   * Ejecuta una consulta y devuelve sus resultados.
   *
   * @throws RejectedQueryError si el servidor validó la consulta y la descartó.
   */
  async buscar(consulta: Consulta): Promise<RespuestaBusqueda> {
    const inicial = await this.sesion.abrir('busqueda');
    this.descubrirBoton(inicial.html);

    const respuesta = await this.sesion.postear('busqueda', this.construirCuerpo(consulta));
    const resultado = parsearRespuestaBusqueda(respuesta.html);

    // Un rechazo del servidor no es "cero resultados": la consulta ni se
    // ejecutó, y reintentarla igual daría lo mismo.
    if (resultado.resultados.length === 0 && resultado.mensajeRechazo !== undefined) {
      throw new RejectedQueryError(
        `El servidor rechazó la consulta: ${resultado.mensajeRechazo}`,
        resultado.mensajeRechazo,
      );
    }

    return resultado;
  }

  /**
   * Obtiene el catálogo de clases judiciales con sus ids internos.
   *
   * Hace falta para la segunda dimensión de partición: cuando un solo día
   * satura el tope de 30, se subdivide por clase. El formulario exige el id
   * interno, no el nombre visible.
   *
   * El autocompletado devuelve el catálogo completo, así que basta una llamada.
   */
  async catalogoClases(): Promise<ClaseJudicial[]> {
    await this.sesion.abrir('busqueda');

    const cuerpo = new URLSearchParams();
    cuerpo.set('AJAXREQUEST', '_viewRoot');
    cuerpo.set(CAMPOS.claseJudicial, '');
    cuerpo.set(FORM_BUSQUEDA, FORM_BUSQUEDA);
    cuerpo.set(CAMPOS.claseJudicialSuggestion, CAMPOS.claseJudicialSuggestion);
    cuerpo.set('ajaxSingle', CAMPOS.claseJudicialSuggestion);
    cuerpo.set('AJAX:EVENTS_COUNT', '1');

    const respuesta = await this.sesion.postear('busqueda', cuerpo);
    return parsearCatalogoClases(respuesta.html);
  }

  private descubrirBoton(html: string): void {
    if (this.idBotonDescubierto) return;

    const descubierto = descubrirIdBusqueda(html);
    if (descubierto !== undefined) {
      this.idBoton = descubierto;
    }
    this.idBotonDescubierto = true;
  }

  /**
   * Reproduce el formulario completo.
   *
   * El ViewState lo añade `JsfSession`, que es quien lo mantiene por vista.
   */
  private construirCuerpo(consulta: Consulta): URLSearchParams {
    const desde = aFechaFormulario(consulta.desde);
    const hasta = aFechaFormulario(consulta.hasta);

    const cuerpo = new URLSearchParams();
    cuerpo.set('AJAXREQUEST', '_viewRoot');

    // Campos de búsqueda, vacíos salvo los que use esta consulta.
    cuerpo.set(CAMPOS.numeroProceso, '');
    cuerpo.set('mascaraProcessoReferenciaRadio', 'on');
    cuerpo.set(CAMPOS.procesoReferencia, '');
    cuerpo.set(CAMPOS.nombreParte, '');
    cuerpo.set(CAMPOS.nombreAbogado, '');
    cuerpo.set(CAMPOS.claseJudicial, consulta.claseJudicialNombre ?? '');
    cuerpo.set(CAMPOS.claseJudicialId, consulta.claseJudicialId ?? '');
    cuerpo.set('tipoMascaraDocumento', 'on');
    cuerpo.set(CAMPOS.documentoParte, '');
    cuerpo.set(CAMPOS.numeroOAB, '');
    cuerpo.set(CAMPOS.letraOAB, '');
    cuerpo.set(CAMPOS.estadoOAB, SIN_SELECCION);

    cuerpo.set(CAMPOS.fechaAutuacionDesde, desde);
    cuerpo.set(CAMPOS.fechaAutuacionDesdeActual, mesDeReferencia(consulta.desde));
    cuerpo.set(CAMPOS.fechaAutuacionHasta, hasta);
    cuerpo.set(CAMPOS.fechaAutuacionHastaActual, mesDeReferencia(consulta.hasta));

    cuerpo.set(FORM_BUSQUEDA, FORM_BUSQUEDA);
    cuerpo.set('autoScroll', '');

    // El componente que ejecuta la búsqueda. No es el botón visible.
    cuerpo.set(this.idBoton, this.idBoton);
    cuerpo.set('AJAX:EVENTS_COUNT', '1');

    return cuerpo;
  }
}

/**
 * Extrae el catálogo de clases de la respuesta del autocompletado.
 *
 * Cada sugerencia llega como una fila de **cuatro** celdas, no dos: RichFaces
 * intercala celdas de relleno vacías entre las de contenido.
 *
 *   <td class="rich-sb-cell-padding"></td>  <- relleno
 *   <td class="rich-table-cell">283</td>    <- id interno
 *   <td class="rich-sb-cell-padding"></td>  <- relleno
 *   <td class="rich-table-cell">AÇÃO PENAL...</td>  <- nombre
 *
 * Por eso se descartan las vacías antes de leer id y nombre.
 */
export function parsearCatalogoClases(html: string): ClaseJudicial[] {
  const clases: ClaseJudicial[] = [];
  const vistos = new Set<string>();

  const filas = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
  for (const [, contenido] of filas) {
    if (contenido === undefined) continue;

    const celdas = [...contenido.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(([, celda]) => (celda ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter((celda) => celda !== '');

    const [id, nombre] = celdas;
    if (id === undefined || nombre === undefined) continue;
    if (!/^\d+$/.test(id) || nombre === '') continue;
    if (vistos.has(id)) continue;

    vistos.add(id);
    clases.push({ id, nombre });
  }

  return clases;
}
