---
id: ISSUE-2
titulo: Cliente HTTP (sesión, encoding, reintentos)
estado: todo
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

_(pendiente)_
