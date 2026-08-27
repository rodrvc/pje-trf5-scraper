#!/bin/bash
# probe3.sh <de> <ate> <idClase> <nombreClase>
DE="$1"; A="$2"; ID="$3"; NOM="$4"; J=$(mktemp)
curl -sk -c $J -o /tmp/pg4.html "https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam"
VS=$(python3 -c "
import re;h=open('/tmp/pg4.html',encoding='latin-1').read()
print(re.search(r'name=\"javax\.faces\.ViewState\"[^>]*value=\"([^\"]*)\"',h).group(1))")
curl -sk -b $J -c $J -o /tmp/pr4.html -X POST "https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam" \
 -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
 --data 'AJAXREQUEST=_viewRoot' \
 --data-urlencode 'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso=' \
 --data 'mascaraProcessoReferenciaRadio=on' --data-urlencode 'fPP:j_id162:processoReferenciaInput=' \
 --data-urlencode 'fPP:dnp:nomeParte=' --data-urlencode 'fPP:j_id180:nomeAdv=' \
 --data-urlencode "fPP:j_id189:classeJudicial=$NOM" \
 --data-urlencode "fPP:j_id189:sgbClasseJudicial_selection=$ID" \
 --data 'tipoMascaraDocumento=on' --data-urlencode 'fPP:dpDec:documentoParte=' \
 --data-urlencode 'fPP:Decoration:numeroOAB=' --data-urlencode 'fPP:Decoration:j_id223=' \
 --data-urlencode 'fPP:Decoration:estadoComboOAB=org.jboss.seam.ui.NoSelectionConverter.noSelectionValue' \
 --data-urlencode "fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate=$DE" \
 --data-urlencode 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate=08/2026' \
 --data-urlencode "fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate=$A" \
 --data-urlencode 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate=08/2026' \
 --data 'fPP=fPP' --data 'autoScroll=' --data "javax.faces.ViewState=$VS" \
 --data 'fPP:j_id244=fPP:j_id244' --data 'AJAX:EVENTS_COUNT=1'
python3 -c "
import re
h=open('/tmp/pr4.html',encoding='latin-1').read()
filas=len(re.findall(r'Ver Detalhes',h)); aviso='muitos processos' in h
n=re.findall(r'\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}',re.sub(r'<[^>]+>',' ',h))
print(f'clase=$ID | $DE | filas={filas} | tope={aviso} | 1ro={n[0] if n else \"-\"}')"
rm -f $J
