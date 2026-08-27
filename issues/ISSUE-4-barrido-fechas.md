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

Verificado que **un solo día NO siempre cabe en 30**: sondeando marzo 2025,
6 de 13 días saturan. Por eso la subdivisión es en **cascada de dos dimensiones**:

1. **Fechas**: partir el rango en dos, recursivamente
2. **Clase judicial**: cuando un solo día siga saturando, subdividir ese día por
   clase. Verificado: 11/03/2025 satura con 30, pero con clase 202 baja a 19

Diseñarlo como una estrategia intercambiable, no como un `if` anidado:

    interface ParticionStrategy {
      puedeSubdividir(q: Query): boolean;
      subdividir(q: Query): Query[];
    }

con `DateRangeSplit` y `ClaseJudicialSplit`, encadenadas: cuando la primera se
agota, pasa a la siguiente.

- **Condición de saturación: `filas >= 30 || hay aviso`** (defensiva; en 14
  sondeos siempre coincidieron, pero un tope silencioso crearía el agujero exacto
  que se intenta evitar)
- Catálogo de clases: se obtiene con un POST al autocompletado, que devuelve las
  133 clases con sus ids internos
- Deduplicar por número CNJ: ventanas distintas pueden traer el mismo proceso
- Recorrer **de presente hacia atrás**, para que una ejecución corta muestre
  procesos recientes
- Determinar empíricamente el límite inferior del histórico (búsqueda binaria
  sobre el año de inicio) en vez de arrancar en una fecha arbitraria
- Aritmética de fechas en UTC o sobre strings ISO, nunca con `new Date()` local
- Log de cada ventana cubierta, para que el avance sea auditable

## Criterio de aceptación

- Un rango amplio se subdivide solo hasta que ninguna consulta topa.
- Un día que satura se subdivide por clase judicial, no se marca como perdido.
- No se pierden procesos por saturación silenciosa.
- Las ventanas cubiertas quedan registradas para poder reanudar (ISSUE-7).

## Resolución

_(pendiente)_
