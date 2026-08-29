#!/bin/bash
# probe-party-tokens.sh <de> <ate> [idClase] [nombreClase] <token1> [token2 ...]
#
# Re-runs the ISSUE-4b party-token alphabet measurement over plain HTTP, the
# same way docs/probe-pagination.sh and docs/probe-class.sh check the date and
# class dimensions. One request per token plus one unfiltered baseline;
# tracks the running union of CNJ numbers across tokens so the plateau point
# is visible without any TypeScript in the loop.
#
# Class filter is optional: pass idClase/nombreClase together, or "" "" to
# probe day-level only (as ISSUE-4b's own alphabet measurement did, since
# that is the leaf PROBLEMS.md's original probe used). If you do pass a
# class id, you MUST also pass its display name - the server silently drops
# the class filter when the id arrives without the name (see PROBLEMS.md §5,
# "Correction: the judicial-class filter needs both the id AND the display
# name" - this is exactly the bug that produced a wrong first measurement
# for this issue).
#
# Example, reproducing the shipped alphabet on 2025-03-12, day-level:
#   ./docs/probe-party-tokens.sh 12/03/2025 12/03/2025 "" "" \
#     "DA S" "OS S" "NT O" "ES A" "RA S" "AN A" "IN A" "RI A" "DO S" \
#     "CO S" "TE S" "AL V" "UZ A" "DE A" "ER A"
#
# Example, with the class filter applied (both fields required):
#   ./docs/probe-party-tokens.sh 12/03/2025 12/03/2025 202 "AGRAVO DE INSTRUMENTO" "DA S" "DE A"

set -euo pipefail

DE="$1"; A="$2"; ID="${3:-}"; NOM="${4:-}"
shift 4
TOKENS=("$@")

if [ "${#TOKENS[@]}" -eq 0 ]; then
  echo "usage: $0 <de> <ate> [idClase] [nombreClase] <token1> [token2 ...]" >&2
  exit 1
fi

BASE="https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam"
J=$(mktemp)
UNION_FILE=$(mktemp)
trap 'rm -f "$J" "$UNION_FILE" /tmp/ppt_pg.html /tmp/ppt_pr.html' EXIT

# One request per query: fresh GET for the ViewState, then the full-form POST.
# Mirrors docs/probe-pagination.sh and docs/probe-class.sh exactly, with the
# party-name field (fPP:dnp:nomeParte) as the only field that varies here.
run_query() {
  local party="$1"
  curl -sk -c "$J" -o /tmp/ppt_pg.html "$BASE"
  local vs
  vs=$(python3 -c "
import re
h = open('/tmp/ppt_pg.html', encoding='latin-1').read()
print(re.search(r'name=\"javax\.faces\.ViewState\"[^>]*value=\"([^\"]*)\"', h).group(1))
")
  curl -sk -b "$J" -c "$J" -o /tmp/ppt_pr.html -X POST "$BASE" \
    -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
    -H "Referer: $BASE" \
    --data 'AJAXREQUEST=_viewRoot' \
    --data-urlencode 'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso=' \
    --data 'mascaraProcessoReferenciaRadio=on' \
    --data-urlencode 'fPP:j_id162:processoReferenciaInput=' \
    --data-urlencode "fPP:dnp:nomeParte=$party" \
    --data-urlencode 'fPP:j_id180:nomeAdv=' \
    --data-urlencode "fPP:j_id189:classeJudicial=$NOM" \
    --data-urlencode "fPP:j_id189:sgbClasseJudicial_selection=$ID" \
    --data 'tipoMascaraDocumento=on' --data-urlencode 'fPP:dpDec:documentoParte=' \
    --data-urlencode 'fPP:Decoration:numeroOAB=' --data-urlencode 'fPP:Decoration:j_id223=' \
    --data-urlencode 'fPP:Decoration:estadoComboOAB=org.jboss.seam.ui.NoSelectionConverter.noSelectionValue' \
    --data-urlencode "fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate=$DE" \
    --data-urlencode 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate=08/2026' \
    --data-urlencode "fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate=$A" \
    --data-urlencode 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate=08/2026' \
    --data 'fPP=fPP' --data 'autoScroll=' --data "javax.faces.ViewState=$vs" \
    --data 'fPP:j_id244=fPP:j_id244' --data 'AJAX:EVENTS_COUNT=1'

  python3 -c "
import re
h = open('/tmp/ppt_pr.html', encoding='latin-1').read()
rows = re.findall(r'Ver Detalhes', h)
capped = 'muitos processos' in h
nums = re.findall(r'\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}', h)
print(len(rows), capped, ','.join(nums))
"
}

echo "leaf: $DE..$A class=${ID:-<none>} (${NOM:-no class filter})"
echo

# Sleep between requests: this hits a real court's production server. 1.5s
# matches the scraper's own default delayMs floor (src/http/client.ts).
DELAY=1.5

read -r rows capped nums < <(run_query "")
IFS=',' read -ra new_nums <<< "$nums"
for n in "${new_nums[@]}"; do echo "$n" >> "$UNION_FILE"; done
union_size=$(sort -u "$UNION_FILE" | grep -c .)
printf '%-3s %-10s rows=%-4s capped=%-5s new=%-3s union=%s\n' 'seed' '(none)' "$rows" "$capped" "$union_size" "$union_size"

i=0
for token in "${TOKENS[@]}"; do
  i=$((i + 1))
  sleep "$DELAY"
  before=$(sort -u "$UNION_FILE" | grep -c .)
  read -r rows capped nums < <(run_query "$token")
  if [ -n "$nums" ]; then
    IFS=',' read -ra new_nums <<< "$nums"
    for n in "${new_nums[@]}"; do echo "$n" >> "$UNION_FILE"; done
  fi
  after=$(sort -u "$UNION_FILE" | grep -c .)
  new=$((after - before))
  printf '%-3s %-10s rows=%-4s capped=%-5s new=%-3s union=%s\n' "$i" "\"$token\"" "$rows" "$capped" "$new" "$after"
done
