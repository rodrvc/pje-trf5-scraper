---
id: ISSUE-3
titulo: Búsqueda de procesos
estado: todo
---

## Objetivo

Ejecutar el POST de búsqueda y parsear la tabla de resultados.

Resuelve los problemas 2 y 4 de `PROBLEMAS.md`.

## Alcance

- Armar el POST con todos los campos del formulario `fPP`
- **Enviar `fPP:j_id244`**, no el botón visible `fPP:searchProcessos`
  (el visible no dispara la búsqueda)
- Parsear cada fila: número CNJ, clase judicial, asunto, partes,
  última movimentación y el token `ca=` para el detalle
- Detectar el aviso de tope ("somente os 30 primeiros") y exponerlo al llamador,
  que es lo que gatilla la subdivisión del ISSUE-4
- Parsear el panel `dl.rich-messages` y propagar los rechazos del servidor
  (p.ej. "É necessário informar ao menos dois nomes") en vez de reportar
  "sin resultados"

## Criterio de aceptación

- Una búsqueda conocida devuelve las filas esperadas con acentos correctos.
- Un rango amplio marca la bandera de tope; uno estrecho no.

## Resolución

_(pendiente)_
