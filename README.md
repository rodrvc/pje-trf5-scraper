# Scraper del PJe — Consulta Pública del TRF5

Scraper en TypeScript de la
[Consulta Pública del PJe del TRF5](https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam),
resuelto con **peticiones HTTP puras**: sin Puppeteer, Playwright ni Selenium.

> **Estado: en construcción.** Ver [el tablero de issues](issues/) para el avance.

---

## Sobre la documentación de este repositorio

Este repositorio incluye, **de forma deliberada**, la investigación previa al
código. No son notas sueltas ni restos de trabajo: son parte del entregable.

| Documento | Qué contiene |
|---|---|
| [`PROBLEMAS.md`](PROBLEMAS.md) | Los 10 obstáculos que presenta el sitio, con la evidencia empírica de cada hallazgo y cómo se resolvió |
| [`issues/`](issues/) | Un issue por módulo, con su resolución escrita al cerrarlo |
| [`docs/`](docs/) | Scripts que reproducen los sondeos contra el sitio |

**Por qué están aquí.** El enunciado del desafío señala que *"descubrir la
estructura del sitio, cómo funciona la paginación y qué información está
disponible"* es parte del desafío. Buena parte del trabajo real no fue escribir
el scraper, sino averiguar cómo responde un sistema JSF/Seam de 2010 que no
tiene API, falla en silencio y sirve los PDFs por enlaces de un solo uso.

Documentar esos hallazgos —incluidos los supuestos que resultaron **falsos** y
las vías que se **descartaron**— deja explícito el razonamiento detrás de cada
decisión de diseño. El caso más claro está en `PROBLEMAS.md` §5.

---

## El hallazgo central: el sitio no tiene paginación

El enunciado pide "navegar por todas las páginas". **No existen páginas de
resultados.** Ante una consulta amplia el sitio responde:

> *"Sua consulta retornou muitos processos e somente os 30 primeiros serão
> exibidos. Por favor, refine sua pesquisa."*

Corta en 30 y no ofrece forma de pedir los siguientes: no hay `?page=N`, ni
control de paginación, ni parámetro de desplazamiento.

Esto es verificable, no una conclusión a ojo:

| Consulta | Filas | ¿Aviso de tope? |
|---|---|---|
| Año 2025 completo | 30 | sí |
| Una semana | 30 | sí |
| Un día (05/03/2025) | 10 | no |
| Un día (08/03/2025) | 18 | no |

Y el contraste que lo confirma: el panel de resultados tiene **cero** controles
de paginación, mientras que el detalle de un proceso **sí** los tiene
(`Richfaces.Datascroller`, que el scraper recorre en ISSUE-5). No es que no se
sepa recorrer un paginador; es que en los resultados no hay ninguno.

**La solución** es cubrir el universo con muchas consultas acotadas en lugar de
una grande, subdividiendo en cascada por dos dimensiones:

1. **Rango de fechas de autuação** — partir el rango en dos cuando sature
2. **Clase judicial** — cuando un solo día siga saturando

La segunda dimensión resultó imprescindible: sondeando marzo de 2025, **6 de 13
días llegan al tope por sí solos**. Los detalles y las tablas completas están en
`PROBLEMAS.md` §5.

---

## Instalación

```bash
npm install
```

Requiere Node.js 20 o superior.

## Uso

```bash
npm run scrape     # ejecuta el scraper
npm test           # suite de tests (no requiere red)
npm run typecheck  # verificación de tipos
```

> Las instrucciones detalladas de ejecución se completan en ISSUE-8.

## Arquitectura

Capas con dependencias en una sola dirección:

```
src/http/      transporte puro: cookies, redirects, encoding, ritmo, reintentos
src/pje/       protocolo JSF: sesión, ViewState, POSTs del formulario
src/domain/    tipos y parsers puros
src/pipeline/  orquestación del recorrido
src/cli/       parser de flags
```

El transporte no sabe qué es JSF, y los parsers son funciones puras
`(html: string) => T`, lo que permite probarlos sin red.

## Consideración con el servidor

El PJe del TRF5 es un servicio público en producción de un tribunal real. El
scraper usa **concurrencia 1** y un delay configurable entre peticiones, y corta
la ejecución si acumula respuestas 429 seguidas en vez de insistir.

Durante toda la investigación no se llegó a provocar un 429. El manejo de rate
limiting está implementado igualmente —lo exige el enunciado— y se demuestra con
**tests contra un servidor simulado**, no castigando el sitio real.

## Licencia

MIT
