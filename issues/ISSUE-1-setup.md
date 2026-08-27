---
id: ISSUE-1
titulo: Setup del proyecto
estado: hecho
---

## Objetivo

Dejar el proyecto listo para escribir código TypeScript.

## Alcance

- `package.json` con dependencias y scripts de ejecución
- `tsconfig.json`
- `.gitignore`: `node_modules/`, `dist/`, `data/`, `pdfs/`, `*.log`
- Estructura de carpetas `src/`

Dependencias previstas: `axios`, `cheerio`, `iconv-lite`, `tough-cookie`,
`axios-cookiejar-support`. Dev: `typescript`, `@types/node`, `tsx`.

**Restricción del enunciado:** prohibido Puppeteer, Playwright y Selenium.

## Criterio de aceptación

- `npm install` y el proyecto compila.
- Los datos scrapeados no se versionan.

## Resolución

Proyecto montado y verificado: `npm install` corre limpio (0 vulnerabilidades),
`npm run typecheck` pasa y `npm test` ejecuta 4 tests en verde.

**Estructura por capas**, con dependencias en una sola dirección:

    src/http/      transporte puro (no sabe qué es JSF)
    src/pje/       protocolo JSF: sesión, ViewState, POSTs
    src/domain/    tipos y parsers puros
    src/pipeline/  orquestación
    src/cli/       parser de flags

**Ya escrito:**

- `src/domain/types.ts` — `Proceso`, `Parte`, `Movimentacao`, `Documento`,
  `Consulta`, `RespuestaBusqueda`, `ClaseJudicial`. Incluye `sigiloso` para
  segredo de justiça y `saturada` para el tope de 30.
- `src/domain/errors.ts` — errores tipados (`RateLimitError`,
  `SessionExpiredError`, `RejectedQueryError`, `ParseError`, `DownloadError`,
  `CircuitBreakerError`), para aplicar políticas de reintento por clase en vez
  de inspeccionar el texto del mensaje.
- `test/errors.test.ts` — deja la suite operativa desde el primer commit.

**Decisiones:**

- TypeScript en modo estricto, con `noUncheckedIndexedAccess` y
  `exactOptionalPropertyTypes`: en un scraper que parsea HTML impredecible,
  el compilador obliga a tratar los campos ausentes.
- ESM nativo (`"type": "module"`), Node >= 20.
- `tsx` para ejecutar sin paso de build; `vitest` + `nock` para los tests.
- Los nombres del dominio se mantienen en portugués cuando son términos propios
  del sistema judicial brasileño (autuação, polo ativo, movimentação).

**Dependencias:** axios, axios-cookiejar-support, cheerio, iconv-lite,
tough-cookie. Ninguna basada en navegador, como exige el enunciado.
