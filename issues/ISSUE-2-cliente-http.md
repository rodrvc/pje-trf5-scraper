---
id: ISSUE-2
titulo: Cliente HTTP (sesión, encoding, reintentos)
estado: hecho
---

## Objetivo

La base sobre la que se apoya todo el resto: un cliente que mantenga la sesión
JSF, decodifique bien el texto y aguante el rate limiting.

Resuelve los problemas 1, 8 y 9 de `PROBLEMAS.md`.

## Alcance

Separado en dos capas, para que el transporte no conozca el dominio:

**`HttpClient` — transporte puro** (no sabe qué es JSF)
- Cookie jar compartido, para que la sesión sobreviva entre peticiones
- Seguir redirects (necesario para los PDFs, ver ISSUE-6)
- Decodificar **ISO-8859-1**: pedir `arraybuffer` y convertir con `iconv-lite`
  antes de pasar a cheerio, o los acentos se corrompen
- Delay configurable entre peticiones y **concurrencia 1** por defecto
  (es el sitio de un tribunal real; la moderación es criterio, no timidez)
- **Reintentos con backoff exponencial ante 429**, respetando `Retry-After`
  si viene; con jitter y tope de intentos. Aplicar también a 503 y errores de
  red transitorios
- Circuit breaker: ante N 429 consecutivos, abortar limpio en vez de insistir

**`JsfSession` — protocolo JSF**, encima del anterior
- ViewState **por vista**, no global: el del detalle es distinto al de la
  búsqueda (ver problema 6). Un `Map<viewKey, viewState>`
- Refrescar el ViewState con cada respuesta

**Sesión expirada como error de primera clase**
Una corrida larga va a perder la sesión, y eso llega como **200 + HTML de la
home**, no como error HTTP. Hay que detectarlo, reestablecer sesión, refrescar
ViewState y reintentar la operación. Interactúa con ISSUE-6: un `cid` obtenido
antes de la caída queda inservible.

**Ids autogenerados de JSF** (`j_id244`, ids de scrollers): cambian si el
tribunal redespliega la aplicación. Centralizarlos en un módulo de constantes
con comentario de cómo redescubrirlos, y derivarlos del HTML en runtime cuando
sea posible, en vez de hardcodearlos dispersos.

## Criterio de aceptación

- Un GET a la home devuelve HTML con acentos correctos y un ViewState válido.
- La lógica de backoff se verifica con tests y un mock HTTP (no gatillando 429
  contra el sitio real de un tribunal).
- Una sesión caída se detecta y se reestablece sin abortar la ejecución.

## Resolución

Implementado en tres piezas, con el transporte separado del protocolo:

**`src/http/backoff.ts`** — cálculo puro de la espera. Se separó del cliente
justamente para poder probarlo exhaustivamente sin red: es lo que hace
demostrable el manejo de 429 sin castigar el sitio real.
`parseRetryAfter()` entiende los dos formatos de la cabecera (segundos y fecha
HTTP) y nunca devuelve negativo. El jitter evita que varias peticiones que
fallan a la vez reintenten sincronizadas.

**`src/http/client.ts`** — transporte puro, no sabe qué es JSF:
- cookie jar (tough-cookie) y redirects, necesarios para los PDFs
- decodificación explícita de ISO-8859-1 con iconv-lite
- **concurrencia 1** vía cola interna, más delay configurable entre peticiones
- reintentos ante 429/502/503/504 y errores de red transitorios
- `Retry-After` del servidor con prioridad sobre el backoff propio, pero
  acotado al techo para que un valor desmedido no cuelgue la ejecución
- circuit breaker: ante N 429 seguidos aborta en vez de insistir

**`src/pje/session.ts`** — protocolo JSF encima del cliente:
- ViewState **por vista** (`Map<Vista, string>`), porque el del detalle es
  distinto al de la búsqueda
- detección de sesión caída: el PJe no responde 401/403 sino 200 con el
  formulario vacío, así que se reconoce por contenido. Al detectarla,
  reestablece sesión y reintenta **una sola vez** (si vuelve a caer el problema
  es otro y conviene que se propague en vez de entrar en bucle)
- las respuestas AJAX parciales se juzgan por otro criterio que las cargas
  completas: solo cuentan como caída si además perdieron el ViewState

**`src/pje/constants.ts`** — ids de JSF centralizados. Son autogenerados y
cambian si el tribunal redespliega, así que además de la constante hay un
`descubrirIdBusqueda()` que los deriva del HTML en runtime.

### Verificación

`npm test`: **30 tests en verde**, sin red (nock). Cubren backoff exponencial,
ambos formatos de `Retry-After`, agotamiento de reintentos, circuit breaker y
su reinicio, decodificación latin-1, redirect de descarga, ritmo entre
peticiones y serialización de concurrentes.

Smoke test contra el sitio real: sesión abierta (200), ViewState capturado,
acentos correctos, y `descubrirIdBusqueda()` derivó `fPP:j_id244` del HTML por
sí solo, coincidiendo con la constante. El reCAPTCHA sigue desactivado.
