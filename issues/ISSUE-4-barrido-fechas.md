---
id: ISSUE-4
titulo: Barrido por ventanas de fecha
estado: todo
---

## Objetivo

Cubrir todo el universo de procesos pese a que el sitio corta en 30 y no pagina.

Resuelve el problema 5 de `PROBLEMAS.md`, que ya fue investigado: el filtro
"Data de Autuação" funciona por sí solo y topa en 30 con rangos amplios,
pero devuelve el total real con rangos chicos.

## Alcance

- Recorrer el histórico en ventanas de fecha (`dd/MM/yyyy`)
- Cuando una ventana llega al tope, **partirla en dos y reintentar cada mitad**,
  recursivamente, hasta que ninguna sature
- Piso de la recursión: un solo día. Si un día llegara a 30, no se puede
  subdividir más → registrarlo como cobertura incompleta en vez de fingir éxito
- Deduplicar por número CNJ: ventanas distintas pueden traer el mismo proceso
- Log de cada ventana cubierta, para que el avance sea auditable

## Criterio de aceptación

- Un rango amplio se subdivide solo hasta que ninguna consulta topa.
- No se pierden procesos por saturación silenciosa.
- Las ventanas cubiertas quedan registradas para poder reanudar (ISSUE-7).

## Resolución

_(pendiente)_
