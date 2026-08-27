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

**Resolución:** el filtro "Data de Autuação" sirve para esto. Funciona por sí solo
(sin combinarlo con otros campos) y confirma el comportamiento esperado:

| Rango consultado        | Filas | ¿Tope? |
|-------------------------|-------|--------|
| 01/01/2025 – 31/12/2025 | 30    | sí     |
| 01/03/2025 – 07/03/2025 | 30    | sí     |
| 05/03/2025 (un día)     | 10    | no     |
| 08/03/2025 (un día)     | 18    | no     |

Al achicar el rango deja de saturar y devuelve el total real. Entonces el barrido
es: recorrer el histórico por ventanas de fechas y, cuando una ventana llegue a 30,
partirla en dos y reintentar cada mitad, hasta que ninguna sature. Así se cubre
todo sin agujeros y sin depender de una paginación que no existe.

Detalle para la implementación: la búsqueda por fecha es el mismo POST del
problema 1, llenando `dataAutuacaoInicioInputDate` y `dataAutuacaoFimInputDate`
en formato `dd/MM/yyyy`.

### Corrección: un día NO siempre cabe en 30

La primera versión de esta resolución asumía que un solo día siempre queda por
debajo del tope. **Es falso.** Al sondear marzo de 2025 día por día:

| Día        | Filas | ¿Tope? |
|------------|-------|--------|
| 03/03/2025 | 4     | no     |
| 04/03/2025 | 7     | no     |
| 05/03/2025 | 10    | no     |
| 06/03/2025 | 16    | no     |
| 07/03/2025 | 25    | no     |
| 10/03/2025 | 23    | no     |
| 11/03/2025 | **30**| **sí** |
| 12/03/2025 | **30**| **sí** |
| 13/03/2025 | **30**| **sí** |
| 14/03/2025 | **30**| **sí** |
| 17/03/2025 | 22    | no     |
| 18/03/2025 | **30**| **sí** |
| 19/03/2025 | **30**| **sí** |

6 de 13 días saturan. Con solo el eje de fechas se perderían procesos en la
mitad de los días.

**Solución: una segunda dimensión de partición, la clase judicial.**

El campo "Classe judicial" es un `RichFaces.Suggestion`. El texto libre no filtra:
hay que mandar el **id interno** en `fPP:j_id189:sgbClasseJudicial_selection`.
El catálogo completo (133 clases con sus ids) se obtiene con un POST al propio
autocompletado, que devuelve todas las entradas.

Verificado: el 11/03/2025 satura con 30, pero filtrando por clase 202
(Agravo de Instrumento) devuelve **19 filas sin tope**.

Entonces la subdivisión es en cascada: primero partir el rango de fechas; cuando
un solo día siga saturando, subdividir ese día por clase judicial.

### Condición de saturación

En 14 sondeos, `filas == 30` siempre vino acompañado del aviso, y `< 30` nunca.
Aun así conviene la condición defensiva **`filas >= 30 || hay aviso`**: si alguna
vez el tope llegara sin aviso, la alternativa es perder procesos en silencio.

### Vías descartadas

Los campos "Processo" y "Processo referência" **no aceptan búsqueda parcial**: al
pasarles `8100` (código de órgano de origen) devuelven exactamente los mismos
resultados que sin filtro. Se ignoran en silencio; sirven solo para búsqueda
exacta. No son utilizables para particionar.

---

## 6. El detalle del proceso pagina por dentro

El detalle se abre con un GET usando un token `ca=` que viene en cada fila de
resultados. Trae datos del proceso, partes con CPF/CNPJ/OAB, movimientos y
documentos adjuntos.

Pero las partes y los movimientos vienen paginados **dentro** de la página (en un
caso de prueba: 65 movimientos). El primer HTML no trae todo; hay que recorrer
esos paginadores.

**Resolución:** son componentes `Richfaces.Datascroller`. Cambiar de página es otro
POST AJAX, con esta forma:

    AJAXREQUEST=_viewRoot
    <idBase>=<idBase>                 # id del scroller sin el sufijo final
    javax.faces.ViewState=<actual>
    <idScroller>=2                    # numero de pagina destino
    ajaxSingle=<idScroller>
    AJAX:EVENTS_COUNT=1

Verificado: pasar a la página 2 del polo activo cambia efectivamente la lista de
participantes. Los ids de los scrollers (uno por tabla: polo activo, polo pasivo,
movimientos) se leen del HTML del detalle, y el total de páginas sale del propio
paginador (`«« « 1 2 3 ... » »»`).

Ojo: el ViewState de la página de detalle es distinto al de la búsqueda, y hay que
refrescarlo con cada respuesta.

### El token `ca=` no caduca con la sesión

Comprobado en tres escenarios con el mismo token: la sesión que lo generó, una
sesión nueva y limpia, y **sin enviar cookie alguna**. Los tres devuelven 200 con
el detalle del mismo proceso.

Es decir, `ca=` es un identificador estable del proceso, no un token de
conversación como el `cid` de los PDFs (problema 7). **Se puede persistir para
reanudar**: al retomar una ejecución no hace falta repetir la búsqueda para volver
a entrar a un proceso ya listado.

---

## 7. Los PDFs se sirven por un enlace de un solo uso

El enlace de un documento no apunta a un `.pdf`. Es un GET que redirige a
`download.seam?cid=<N>`, y ese `cid` es efímero, de un solo uso y atado a la sesión:
reutilizarlo devuelve 404 aunque se mande la cookie correcta.

Esto descarta el patrón habitual de juntar todos los enlaces y descargarlos después
en lote: hay que seguir el redirect en el momento, con la sesión viva.

**Estado:** mecanismo verificado (se descargó un PDF real) — falta escribirlo como código.

---

## 8. El encoding del sitio no es uniforme

Al principio se detectó que la página responde en ISO-8859-1 y no en UTF-8:
decodificado por defecto, los acentos se corrompen ("APELAÇÃO" queda
"APELAÃÃO").

**Pero el sitio no usa un solo encoding.** Al capturar fixtures se comprobó,
mirando los bytes crudos:

| Petición | Encoding real | ¿Declara charset? |
|---|---|---|
| GET de la página | ISO-8859-1 | no |
| POST (respuesta AJAX) | **UTF-8** | no |

Como la búsqueda responde por AJAX, asumir latin-1 en todo habría corrompido
**todos** los datos extraídos.

**Resolución:** se decide por los bytes, no por la cabecera (que no viene). Se
intenta decodificar como UTF-8; si el resultado contiene el carácter de
reemplazo, los bytes no eran UTF-8 válido y se decodifica como latin-1. Un texto
latin-1 con acentos casi nunca es UTF-8 válido por casualidad, así que la
distinción es fiable.

Implementado en `decodificarSegunBytes()` (`src/http/client.ts`), con tests que
cubren ambos casos.

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
