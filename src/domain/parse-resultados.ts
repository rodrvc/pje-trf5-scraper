/**
 * Parseo de la tabla de resultados de búsqueda.
 *
 * Todas las funciones de este módulo son puras: reciben HTML y devuelven datos.
 * Eso permite probarlas con fixtures guardadas, sin red de por medio.
 */

import * as cheerio from 'cheerio';

import type { RespuestaBusqueda, ResultadoBusqueda } from './types.js';
import { AVISO_TOPE, TOPE_RESULTADOS } from '../pje/constants.js';

/** Número único CNJ: 0000462-42.2023.8.17.3480 */
const RE_NUMERO_CNJ = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

/** Token de acceso al detalle, dentro del onclick de la fila. */
const RE_TOKEN_CA = /listView\.seam\?ca=([a-f0-9]+)/i;

/** Normaliza el espaciado que el HTML deja irregular. */
function limpiar(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

/**
 * Extrae el mensaje que el servidor muestra al rechazar una consulta.
 *
 * El PJe valida en el servidor y reporta en un panel aparte, no como error
 * HTTP: por ejemplo, buscar por nombre de parte con un solo término devuelve
 * "É necessário informar ao menos dois nomes". Sin leer este panel, el scraper
 * concluiría "no hay resultados" cuando en realidad la consulta ni se ejecutó.
 */
export function extraerMensajeRechazo(html: string): string | undefined {
  const $ = cheerio.load(html);

  for (const elemento of $('dl.rich-messages, span.rich-messages-label').toArray()) {
    const texto = limpiar($(elemento).text());
    if (texto !== '') return texto;
  }

  return undefined;
}

/**
 * Detecta que la consulta llegó al tope y hay resultados que no se ven.
 *
 * Se comprueban dos señales de forma independiente. El aviso textual es la
 * fuente principal, pero también se cuenta: si alguna vez el sitio recortara
 * sin avisar, confiar solo en el texto crearía un agujero de cobertura
 * silencioso, que es exactamente lo que la partición intenta evitar.
 */
export function estaSaturada(html: string, cantidadFilas: number): boolean {
  return html.includes(AVISO_TOPE) || cantidadFilas >= TOPE_RESULTADOS;
}

/**
 * Descompone la celda que concentra clase, número, asunto y partes.
 *
 * En el HTML esos datos no están en líneas separadas ni en elementos con clase
 * propia: el `<b>` interno contiene "sigla + número - asunto", y el resto queda
 * como texto suelto alrededor. Es decir:
 *
 *   APELAÇÃO CÍVEL <b>ApCiv 0000462-42.2023.8.17.3480 - Juros</b> FULANO X BANCO
 *   └── antes del <b>: clase        └── dentro del <b>          └── después: partes
 *
 * Por eso se parsea por posición respecto al `<b>` y no dividiendo texto plano:
 * `.text()` de cheerio colapsa todo en una sola línea sin saltos.
 */
function parsearCeldaProceso(celda: cheerio.Cheerio<never>): {
  numero?: string;
  claseJudicial?: string;
  asunto?: string;
  partes?: string;
} {
  const resultado: {
    numero?: string;
    claseJudicial?: string;
    asunto?: string;
    partes?: string;
  } = {};

  const negrita = celda.find('b').first();
  const textoNegrita = limpiar(negrita.text());
  const textoCompleto = limpiar(celda.text());

  const coincidencia = RE_NUMERO_CNJ.exec(textoNegrita || textoCompleto);
  if (coincidencia === null) return resultado;

  resultado.numero = coincidencia[0];

  // El asunto va tras el número, dentro del mismo <b>, separado por " - ".
  const trasNumero = (textoNegrita || textoCompleto)
    .slice((coincidencia.index ?? 0) + coincidencia[0].length)
    .trim();
  const asunto = trasNumero.replace(/^-\s*/, '').trim();
  if (asunto !== '') resultado.asunto = asunto;

  if (textoNegrita !== '') {
    // La clase judicial es lo que precede al <b> en la celda.
    const posicionNegrita = textoCompleto.indexOf(textoNegrita);
    if (posicionNegrita > 0) {
      const clase = textoCompleto.slice(0, posicionNegrita).trim();
      if (clase !== '') resultado.claseJudicial = clase;
    }

    // Las partes son lo que sigue al <b>.
    const finNegrita = posicionNegrita + textoNegrita.length;
    if (posicionNegrita >= 0 && finNegrita < textoCompleto.length) {
      const partes = textoCompleto.slice(finNegrita).trim();
      if (partes !== '') resultado.partes = partes;
    }
  }

  return resultado;
}

/**
 * Extrae las filas de la tabla de resultados.
 *
 * Una fila sin número CNJ o sin token de detalle se descarta: sin esos dos
 * datos no se puede ni identificar el proceso ni entrar a él, así que no aporta.
 */
export function parsearResultados(html: string): ResultadoBusqueda[] {
  const $ = cheerio.load(html);
  const resultados: ResultadoBusqueda[] = [];

  $('table[id$="processosTable"] tbody tr').each((_, fila) => {
    const $fila = $(fila);

    // El token vive en el onclick, no en un href.
    const onclicks = $fila
      .find('a[onclick]')
      .map((_i, a) => $(a).attr('onclick') ?? '')
      .get()
      .join(' ');

    const ca = RE_TOKEN_CA.exec(onclicks)?.[1];
    if (ca === undefined) return;

    const celdas = $fila.find('td');
    // La celda del medio concentra clase, número, asunto y partes.
    const datos = parsearCeldaProceso(celdas.eq(1) as cheerio.Cheerio<never>);

    if (datos.numero === undefined) return;

    const ultimaMovimentacao = limpiar(celdas.eq(2).text());

    resultados.push({
      numero: datos.numero,
      ca,
      ...(datos.claseJudicial !== undefined ? { claseJudicial: datos.claseJudicial } : {}),
      ...(datos.asunto !== undefined ? { asunto: datos.asunto } : {}),
      ...(datos.partes !== undefined ? { partes: datos.partes } : {}),
      ...(ultimaMovimentacao !== '' ? { ultimaMovimentacao } : {}),
    });
  });

  return resultados;
}

/** Interpreta la respuesta completa de una búsqueda. */
export function parsearRespuestaBusqueda(html: string): RespuestaBusqueda {
  const mensajeRechazo = extraerMensajeRechazo(html);
  const resultados = parsearResultados(html);

  return {
    resultados,
    saturada: estaSaturada(html, resultados.length),
    ...(mensajeRechazo !== undefined ? { mensajeRechazo } : {}),
  };
}
