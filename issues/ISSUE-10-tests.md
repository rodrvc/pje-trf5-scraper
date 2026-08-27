---
id: ISSUE-10
titulo: Suite de tests con fixtures
estado: todo
---

## Objetivo

"Manejo de errores 429" es criterio explícito de evaluación, y se decidió **no
demostrarlo contra el servidor real** de un tribunal. Por lo tanto **los tests
son la evidencia**, no un apéndice.

## Alcance

- Tests de la lógica de retry/backoff con mock HTTP (`nock`): 429 con y sin
  `Retry-After`, 503, errores de red, agotamiento de intentos
- Tests de los parsers como **funciones puras** `(html: string) => T`,
  sin red de por medio
- **Fixtures HTML reales** en `test/fixtures/`, capturadas del sitio:
  - resultados con tope (30 + aviso)
  - resultados sin tope
  - panel de rechazo del servidor
  - detalle con paginación interna
  - respuesta HTML donde se esperaba un PDF (sesión caída)
  - proceso en segredo de justiça, si se encuentra uno

Las fixtures valen doble: prueban los parsers sin red y documentan el sitio.

## Criterio de aceptación

- `npm test` pasa sin conexión a internet.
- El comportamiento ante 429 queda demostrado de forma reproducible.

## Resolución

_(pendiente)_
