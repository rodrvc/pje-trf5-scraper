/**
 * Identificadores del formulario de búsqueda del PJe.
 *
 * ATENCIÓN: los `j_idNNN` son ids que JSF autogenera según el orden de los
 * componentes en la vista. **Cambian si el tribunal redespliega la aplicación**,
 * y cuando eso pase el scraper dejará de encontrar resultados sin dar error.
 *
 * Por eso están todos aquí y no dispersos por el código, y por eso
 * `descubrirIdBusqueda()` los deriva del HTML en tiempo de ejecución en vez de
 * confiar ciegamente en la constante.
 *
 * Cómo redescubrirlos si dejan de funcionar:
 *
 *   1. Abrir la página de búsqueda y ver el fuente.
 *   2. Buscar `executarPesquisa=function()`. El id del componente que dispara
 *      la búsqueda es el que aparece en `'parameters':{'fPP:j_idNNN': ...}`.
 *   3. Los nombres de los campos salen de los `name="..."` del formulario `fPP`.
 */

/** El formulario de búsqueda. */
export const FORM_BUSQUEDA = 'fPP';

/**
 * Componente que ejecuta la búsqueda.
 *
 * No es el botón visible: `fPP:searchProcessos` existe en el HTML pero enviarlo
 * no dispara la consulta — el servidor responde 200 y solo refresca el panel de
 * mensajes. El botón llama por JavaScript a `executarPesquisa()`, que envía este
 * otro componente.
 */
export const ID_BOTON_BUSQUEDA = 'fPP:j_id244';

/** Campos del formulario de búsqueda. */
export const CAMPOS = {
  numeroProceso:
    'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso',
  procesoReferencia: 'fPP:j_id162:processoReferenciaInput',
  nombreParte: 'fPP:dnp:nomeParte',
  nombreAbogado: 'fPP:j_id180:nomeAdv',
  claseJudicial: 'fPP:j_id189:classeJudicial',
  /** El autocompletado exige el id interno de la clase, no su nombre. */
  claseJudicialId: 'fPP:j_id189:sgbClasseJudicial_selection',
  /** Caja de sugerencias, para pedir el catálogo de clases. */
  claseJudicialSuggestion: 'fPP:j_id189:sgbClasseJudicial',
  documentoParte: 'fPP:dpDec:documentoParte',
  numeroOAB: 'fPP:Decoration:numeroOAB',
  letraOAB: 'fPP:Decoration:j_id223',
  estadoOAB: 'fPP:Decoration:estadoComboOAB',
  fechaAutuacionDesde: 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate',
  fechaAutuacionDesdeActual: 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate',
  fechaAutuacionHasta: 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate',
  fechaAutuacionHastaActual: 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate',
} as const;

/** Valor que usa Seam para "ningún elemento seleccionado" en los combos. */
export const SIN_SELECCION = 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue';

/** Máximo de resultados que el sitio devuelve por consulta. No es configurable. */
export const TOPE_RESULTADOS = 30;

/** Texto con que el servidor avisa que recortó los resultados. */
export const AVISO_TOPE = 'muitos processos';

/**
 * Busca en el HTML el id real del componente de búsqueda.
 *
 * Preferir esto a la constante: sobrevive a un redespliegue del tribunal.
 * Devuelve `undefined` si no lo encuentra, y en ese caso el llamador decide si
 * usar el valor conocido o abortar.
 */
export function descubrirIdBusqueda(html: string): string | undefined {
  // executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{... 'parameters':{'fPP:j_id244':'fPP:j_id244'} ...
  const bloque = /executarPesquisa\s*=\s*function[\s\S]{0,600}?'parameters'\s*:\s*\{\s*'([^']+)'/.exec(
    html,
  );
  return bloque?.[1];
}
