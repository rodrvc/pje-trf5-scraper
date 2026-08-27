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

- Cookie jar compartido, para que la sesión sobreviva entre peticiones
- Seguir redirects (necesario para los PDFs, ver ISSUE-6)
- Decodificar **ISO-8859-1**: pedir `arraybuffer` y convertir con `iconv-lite`
  antes de pasar a cheerio, o los acentos se corrompen
- Leer y refrescar el `javax.faces.ViewState` en cada respuesta
- Delay configurable entre peticiones (lo pide el enunciado)
- **Reintentos con backoff exponencial ante 429**, respetando `Retry-After`
  si viene; con jitter y tope de intentos. Aplicar también a 503 y errores de
  red transitorios

## Criterio de aceptación

- Un GET a la home devuelve HTML con acentos correctos y un ViewState válido.
- La lógica de backoff se verifica con tests y un mock HTTP (no gatillando 429
  contra el sitio real de un tribunal).

## Resolución

_(pendiente)_
