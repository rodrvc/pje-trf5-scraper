---
id: ISSUE-8
titulo: CLI, logging y README
estado: todo
---

## Objetivo

Dejar el proyecto entregable. Cubre los criterios de evaluación de documentación
y código limpio.

## Alcance

- CLI con opciones: rango de fechas, límite de procesos, delay entre peticiones,
  `--retry-failed`
- Logging de progreso: ventana actual, procesos encontrados, PDFs bajados,
  reintentos por 429 (el enunciado lo sugiere como tip)
- `README.md` con:
  - instalación y ejecución paso a paso
  - explicación de cómo se resolvió la cobertura pese a que **el sitio no tiene
    paginación** y corta en 30 (es lo que demuestra haber entendido el sitio)
  - nota de que el scraper es HTTP puro, sin automatización de navegador
- Ejecución de muestra real que deje datos y algunos PDFs como evidencia

## Pendiente de decisión del usuario

Publicación del repo público en GitHub: si lo crea él o se publica con `gh`.
Por defecto no se publica nada sin su visto bueno.

## Criterio de aceptación

- Alguien que clone el repo puede ejecutarlo siguiendo solo el README.

## Resolución

_(pendiente)_
