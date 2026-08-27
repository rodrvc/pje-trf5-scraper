---
id: ISSUE-7
titulo: Persistencia y reanudación
estado: todo
---

## Objetivo

Que el scraper se pueda cortar y retomar sin repetir trabajo. El enunciado dice
que no hace falta bajar todo de una vez, pero sí demostrar que llegaría a todo
si se deja corriendo.

Resuelve el problema 10 de `PROBLEMAS.md`.

## Alcance

- `data/processos.ndjson`: un registro por proceso, escrito de forma incremental
  (append, sin reescribir el archivo entero)
- `data/state.json`: ventanas de fecha ya cubiertas (ISSUE-4), para reanudar
- `data/failed.json`: documentos fallidos con motivo e intentos, y un modo
  `--retry-failed` para reprocesarlos. Lo pide explícitamente el enunciado
  como parte del manejo de 429
- Idempotencia: no re-descargar un PDF ya presente y válido; deduplicar procesos
  por número CNJ

## Criterio de aceptación

- Matar el proceso a mitad y relanzarlo no duplica registros ni vuelve a bajar
  PDFs ya obtenidos.

## Resolución

_(pendiente)_
