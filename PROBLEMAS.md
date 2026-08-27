# Problemas a resolver

Desafío: scraper del PJe Consulta Pública del TRF5, en TypeScript, sin
automatización de navegador (solo HTTP + parsing).

Sitio: https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam

Lista de los obstáculos detectados al explorar el sitio. Se resuelven de a uno;
la resolución se escribe bajo cada problema a medida que se investiga.

---

## 1. La búsqueda no es una URL, es un POST con estado de sesión

El sitio está hecho en JSF/Seam con RichFaces. No hay URLs de búsqueda ni API:
todo va por POST con un token `javax.faces.ViewState` atado a la cookie de sesión.
Sin ese par válido el servidor responde 200 con HTML válido pero **sin resultados**,
sin ningún mensaje de error.

**Estado:** resuelto en la exploración inicial — falta escribirlo como código.

---

## 2. El botón "Pesquisar" visible no dispara la búsqueda

El botón del formulario se llama `fPP:searchProcessos`. Enviarlo no funciona:
devuelve una respuesta que solo actualiza el panel de mensajes, sin tabla.
El componente que realmente ejecuta la búsqueda es otro (`fPP:j_id244`), invocado
desde el JavaScript de la página.

**Estado:** resuelto en la exploración inicial — falta escribirlo como código.

---

## 3. El formulario tiene un reCAPTCHA

La página carga el script de Google reCAPTCHA y el botón de búsqueda lo invoca.
Un captcha activo haría el desafío inviable sin navegador.

**Estado:** descartado como riesgo — está desactivado del lado del servidor.

---

## 4. El servidor rechaza búsquedas sin avisar claramente

Buscar por nombre de parte con un solo término devuelve cero resultados. El motivo
llega en un panel de mensajes aparte, no como error HTTP: hace falta al menos dos
nombres. Si no se parsea ese panel, el scraper reporta "sin resultados" cuando en
realidad la consulta fue rechazada.

**Estado:** identificado — falta manejarlo en código.

---

## 5. El sitio corta en 30 resultados y no tiene paginación

**El problema de diseño más importante.**

El enunciado pide recorrer todas las páginas, pero no existen páginas de resultados.
Ante una consulta amplia el sitio responde *"somente os 30 primeiros serão exibidos"*
y no ofrece forma de pedir los siguientes: no hay `?page=N` ni control de paginación.

Verificado en vivo: búsqueda amplia devuelve 30 filas con el aviso; búsqueda
estrecha devuelve el total real sin aviso.

La idea es cubrir el universo con muchas búsquedas acotadas en vez de una grande,
achicando el filtro hasta que ninguna llegue al tope.

**Pendiente de investigar:** si el filtro de "Data de Autuação" se comporta igual
(topa en 30) y si funciona por sí solo. Es lo que decide la estrategia de barrido.

---

## 6. El detalle del proceso pagina por dentro

El detalle se abre con un GET usando un token `ca=` que viene en cada fila de
resultados. Trae datos del proceso, partes con CPF/CNPJ/OAB, movimientos y
documentos adjuntos.

Pero las partes y los movimientos vienen paginados **dentro** de la página (en un
caso de prueba: 65 movimientos). El primer HTML no trae todo; hay que recorrer
esos paginadores.

**Pendiente de investigar:** cómo iterarlos.

---

## 7. Los PDFs se sirven por un enlace de un solo uso

El enlace de un documento no apunta a un `.pdf`. Es un GET que redirige a
`download.seam?cid=<N>`, y ese `cid` es efímero, de un solo uso y atado a la sesión:
reutilizarlo devuelve 404 aunque se mande la cookie correcta.

Esto descarta el patrón habitual de juntar todos los enlaces y descargarlos después
en lote: hay que seguir el redirect en el momento, con la sesión viva.

**Estado:** mecanismo verificado (se descargó un PDF real) — falta escribirlo como código.

---

## 8. El sitio responde en ISO-8859-1

No es UTF-8. Decodificado por defecto, los acentos se corrompen
("APELAÇÃO" queda "APELAÃÃO"). Afecta tanto a los datos extraídos como a los
nombres de archivo de los PDFs.

**Estado:** identificado — falta manejarlo en código.

---

## 9. Manejar los errores 429

Requisito explícito del enunciado: detectar 429, reintentar con backoff exponencial,
seguir con el siguiente documento si persiste, y registrar los fallidos.

Durante la exploración **nunca se gatilló un 429**, así que no se puede demostrar
provocándolo contra el sitio real de un tribunal. Habrá que verificar la lógica con
tests y un mock HTTP.

Caso relacionado: una sesión caducada puede devolver 200 con HTML donde se esperaba
un PDF. No es un 429, pero es un fallo que hay que detectar para no guardar basura.

**Pendiente.**

---

## 10. La ejecución tiene que ser reanudable

El enunciado dice que no hace falta bajar todo de una vez, basta demostrar que el
scraper llegaría a todo si se deja corriendo. Eso implica poder cortar y retomar sin
repetir trabajo ni duplicar datos: guardar el avance, no re-descargar PDFs ya
bajados, y deduplicar procesos que aparezcan en más de una búsqueda.

**Pendiente.**
