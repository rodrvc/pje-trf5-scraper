/**
 * Identifiers of the PJe search form.
 *
 * WARNING: the `j_idNNN` values are ids JSF generates from the order of the
 * components in the view. **They change if the court redeploys the
 * application**, and when that happens the scraper stops finding results without
 * raising any error.
 *
 * That is why they all live here instead of being scattered through the code,
 * and why `discoverSearchComponentId()` derives them from the markup at runtime
 * rather than trusting the constant blindly.
 *
 * How to rediscover them if they stop working:
 *
 *   1. Open the search page and view the source.
 *   2. Look for `executarPesquisa=function()`. The id of the component that
 *      triggers the search is the one in `'parameters':{'fPP:j_idNNN': ...}`.
 *   3. Field names come from the `name="..."` attributes of the `fPP` form.
 */

/** The search form. */
export const SEARCH_FORM = 'fPP';

/**
 * The component that runs the search.
 *
 * Not the visible button: `fPP:searchProcessos` exists in the markup, but
 * submitting it does not trigger the query — the server answers 200 and only
 * refreshes the message panel. The button calls `executarPesquisa()` in
 * JavaScript, which submits this component instead.
 */
export const SEARCH_COMPONENT_ID = 'fPP:j_id244';

/** Search form fields. */
export const FIELDS = {
  caseNumber:
    'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso',
  referenceCase: 'fPP:j_id162:processoReferenciaInput',
  partyName: 'fPP:dnp:nomeParte',
  attorneyName: 'fPP:j_id180:nomeAdv',
  judicialClass: 'fPP:j_id189:classeJudicial',
  /** The autocomplete requires the internal class id, not its display name. */
  judicialClassId: 'fPP:j_id189:sgbClasseJudicial_selection',
  /** Suggestion box, used to fetch the class catalog. */
  judicialClassSuggestion: 'fPP:j_id189:sgbClasseJudicial',
  partyDocument: 'fPP:dpDec:documentoParte',
  oabNumber: 'fPP:Decoration:numeroOAB',
  oabLetter: 'fPP:Decoration:j_id223',
  oabState: 'fPP:Decoration:estadoComboOAB',
  filingDateFrom: 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate',
  filingDateFromMonth: 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate',
  filingDateTo: 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate',
  filingDateToMonth: 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate',
} as const;

/** Value Seam uses for "nothing selected" in dropdowns. */
export const NO_SELECTION = 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue';

/** Maximum results the site returns per query. Not configurable. */
export const RESULT_CAP = 30;

/** Text the server uses to warn that it truncated the results. */
export const CAP_WARNING = 'muitos processos';

/**
 * Finds the real id of the search component in the markup.
 *
 * Preferred over the constant: it survives a redeploy by the court. Returns
 * `undefined` when not found, leaving the caller to decide between the known
 * value and aborting.
 */
export function discoverSearchComponentId(html: string): string | undefined {
  // executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{... 'parameters':{'fPP:j_id244':'fPP:j_id244'} ...
  const match = /executarPesquisa\s*=\s*function[\s\S]{0,600}?'parameters'\s*:\s*\{\s*'([^']+)'/.exec(
    html,
  );
  return match?.[1];
}
