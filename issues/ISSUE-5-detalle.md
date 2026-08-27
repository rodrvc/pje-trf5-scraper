---
id: ISSUE-5
titulo: Detalle del proceso
estado: todo
---

## Objetivo

Extraer toda la información de cada proceso, que es el requisito 1 del enunciado.

Resuelve el problema 6 de `PROBLEMAS.md`, ya investigado.

## Alcance

- GET al detalle usando el token `ca=` de cada fila
- Parsear: número, data da distribuição, classe judicial, assunto, jurisdição,
  órgão julgador, endereço, processo referência
- Partes de polo activo y pasivo, con CPF/CNPJ, OAB y situación
- Movimentações (fecha y descripción)
- Lista de documentos adjuntos, con los datos necesarios para bajarlos (ISSUE-6)

## Sub-problema: paginación interna

Partes y movimientos vienen paginados dentro de la página con
`Richfaces.Datascroller`. El primer HTML **no trae todo**. Se avanza con un POST:

    AJAXREQUEST=_viewRoot
    <idBase>=<idBase>
    javax.faces.ViewState=<actual>
    <idScroller>=<n>
    ajaxSingle=<idScroller>
    AJAX:EVENTS_COUNT=1

El ViewState del detalle es distinto al de la búsqueda y debe refrescarse
en cada respuesta.

## Procesos en segredo de justiça

El PJe los marca y devuelve detalle parcial o denegado. **No es un error, es un
estado válido del dominio.** Un parser que asuma que siempre hay partes y
movimientos revienta. Modelarlo explícitamente (`sigiloso: true`, campos
ausentes) y mencionarlo en el README.

## Criterio de aceptación

- Un proceso con varias páginas de partes y movimientos se extrae completo,
  no solo su primera página.
- Un proceso sigiloso se registra como tal, sin romper la ejecución.

## Resolución

_(pendiente)_
