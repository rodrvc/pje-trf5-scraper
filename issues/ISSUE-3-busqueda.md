---
id: ISSUE-3
titulo: Búsqueda de procesos
estado: hecho
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

**`src/pje/busqueda.ts`** — ejecuta el POST reproduciendo el formulario `fPP`
completo (los campos vacíos también viajan; omitir alguno hace que el servidor
responda 200 sin resultados y sin decir por qué). El id del componente de
búsqueda se descubre del HTML en la primera consulta, con la constante como
respaldo.

También obtiene el **catálogo de clases judiciales** (132 entradas con sus ids
internos), que hace falta para la segunda dimensión de partición del ISSUE-4.

**`src/domain/parse-resultados.ts`** — parsers puros `(html) => T`, probados con
fixtures reales.

### Dos trampas del HTML que costaron

**La celda de resultados no tiene saltos de línea.** Clase, número, asunto y
partes conviven en una celda donde `.text()` de cheerio lo colapsa todo en una
sola línea. El primer intento dividía por líneas inexistentes y nunca extraía
las partes. Se parsea por posición respecto al `<b>` interno, que delimita
"sigla + número - asunto".

**El autocompletado devuelve cuatro celdas, no dos.** RichFaces intercala
celdas de relleno vacías entre id y nombre. El parser tomaba la primera celda
(vacía) como id y devolvía 0 clases. Se descartan las vacías antes de emparejar.

### Hallazgo: el encoding del sitio no es uniforme

Al capturar las fixtures se descubrió que **las cargas de página completas vienen
en ISO-8859-1, pero las respuestas AJAX de los POST vienen en UTF-8**, y ninguna
declara `charset` en el cuerpo.

El cliente asumía latin-1 para todo, lo que habría corrompido **todos** los datos
extraídos, ya que la búsqueda responde por AJAX. Se corrigió decidiendo por los
bytes: se intenta UTF-8 y, si no es válido, se decodifica como latin-1.
Documentado en `PROBLEMAS.md` §8.

### Verificación

`npm test`: **55 tests en verde**, sin red.

Smoke test contra el sitio real:

| Consulta | Filas | Saturada |
|---|---|---|
| 05/03/2025 | 10 | no |
| 11/03/2025 | 30 | **sí** |
| 11/03/2025 + clase 202 | 19 | no |

Los datos salen completos y con acentos correctos (`APELAÇÃO CÍVEL`, asunto
`Juros`, partes con el separador ` X `). La tercera fila confirma que la segunda
dimensión de partición funciona: el día que saturaba deja de hacerlo al filtrar
por clase.
