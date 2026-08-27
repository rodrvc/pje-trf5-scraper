---
id: ISSUE-9
titulo: Orquestador del recorrido
estado: todo
---

## Objetivo

Coordinar el flujo completo: barrido → detalle → PDFs → persistencia.

Sin esta pieza la lógica de negocio termina viviendo en el `main()`, que es el
anti-patrón clásico en scrapers. El CLI debe ser un parser de flags que instancia
y arranca el orquestador, nada más.

## Alcance

- Máquina de estados del recorrido
- **Política de fallo explícita**: ¿un detalle roto aborta la ejecución o solo se
  registra y se sigue? (el enunciado pide continuar y registrar)
- Punto de inyección de la persistencia (ISSUE-7)
- Manejo de sesión expirada como caso transversal (ISSUE-2)

## Criterio de aceptación

- El CLI no contiene lógica de negocio.
- Un fallo aislado no tumba la corrida completa.

## Resolución

_(pendiente)_
