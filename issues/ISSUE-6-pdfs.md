---
id: ISSUE-6
titulo: Descarga de PDFs
estado: todo
---

## Objetivo

Descargar los documentos adjuntos con nombre descriptivo. Requisito 2 del enunciado.

Resuelve el problema 7 de `PROBLEMAS.md`. El mecanismo ya fue verificado a mano:
se descargó un PDF real de 19 KB.

## Alcance

- Construir el GET del documento con `idBin`, `numeroDocumento`,
  `nomeArqProcDocBin`, `idProcessoDocumento` y `actionMethod`
- **Seguir el redirect en el momento**: lleva a `download.seam?cid=<N>`, donde el
  `cid` es efímero, de un solo uso y atado a la sesión. Reutilizarlo da 404, así
  que no se pueden juntar enlaces para bajarlos después en lote
- Guardar organizado por proceso:

      pdfs/<numero-CNJ>/<fecha>_<tipo>_<idDocumento>.pdf

- Sanitizar el nombre **después** de decodificar latin-1. El `idDocumento` es lo
  que garantiza unicidad: sanitizar latin-1 puede colapsar dos nombres legibles
  distintos en uno, así que la parte legible es decorativa y el id siempre va
- Escribir a archivo temporal y renombrar al final, para que una interrupción no
  deje un PDF truncado que luego se dé por válido

## Validación

- Verificar `Content-Type: application/pdf` antes de escribir. Si vuelve
  `text/html`, es sesión caída o error: tratar como fallo, renovar sesión
- Comprobar la cabecera mágica `%PDF` del archivo escrito

## Criterio de aceptación

- Los PDFs descargados abren correctamente.
- Los fallidos quedan registrados para reintentarlos (ISSUE-7).

## Resolución

_(pendiente)_
