# Diseño del artículo publicado — qué podemos controlar

Este documento describe qué aspectos del diseño y contenido de un artículo en
`www.kilombo.top` están en nuestras manos y cuáles están determinados por SPIP
o por el tema Escal instalado en el servidor.

Basado en análisis directo del HTML del formulario `article_edit` de
**SPIP 4.4.21** con **Escal v5.2.9** en kilombo.top.

---

## Estructura del formulario SPIP

El formulario `article_edit` tiene tres columnas:

- **Izquierda** — adjuntar documentos (renderizado, accesible)
- **Centro** — campos editoriales principales (renderizado, accesible)
- **Derecha** — logo, estado, fecha, autores, mots-clés (cargados por AJAX,
  **no están en el HTML inicial**)

Los bloques de la columna derecha se cargan dinámicamente después de que el
navegador ejecuta JavaScript. Esto es lo que explica por qué `surtitre`,
`soustitre`, `chapo` y `ps` no responden a `fill()` en el flujo actual: sus
inputs no están presentes en el HTML al momento en que el script intenta
rellenarlos.

---

## Lo que controlamos desde el pipeline

### Campos que se rellenan hoy

Estos campos están en el formulario principal (columna central) y funcionan
correctamente con `fill()`:

| Campo JSON   | Campo SPIP   | Tipo       | Estado    |
|--------------|--------------|------------|-----------|
| `title`      | `titre`      | input text | ✅ activo |
| `contentHtml`| `texte`      | textarea   | ✅ activo |
| `section`    | `id_parent`  | select     | ✅ activo |
| `descriptif` | `descriptif` | textarea   | ✅ activo |
| `sourceSite` | `nom_site`   | input text | ✅ activo |
| `sourceUrl`  | `url_site`   | input text | ✅ activo |

### HTML del cuerpo (`contentHtml`)

El campo `texte` acepta HTML directamente. SPIP lo renderiza tal cual en el
frontend del artículo. El techo de diseño del cuerpo del artículo está
determinado por lo que el tema Escal soporta y por los tags que el validador
del schema permite.

**Tags disponibles hoy** (permitidos por el schema y renderizados por Escal):

```
Estructura:   <h3> <h4> <p> <br> <hr>
Énfasis:      <strong> <em>
Listas:       <ul> <ol> <li>
Citas:        <blockquote>
Imágenes:     <figure> <figcaption> <img src="..." alt="...">
Tablas:       <table> <thead> <tbody> <tr> <th> <td>
Enlaces:      <a href="...">
```

**Shortcodes propios de Escal** (barra markItUp): el editor de SPIP expone
estas cajas de llamada que el tema renderiza con estilos propios. Se pueden
incluir como HTML en `contentHtml` si se conoce la sintaxis exacta:
- `<aide>` — cuadro de ayuda
- `<important>` — cuadro de alerta importante
- `<avertissement>` — cuadro de advertencia
- `<info>` — cuadro informativo
- `<centrer>` — centrar contenido

> ⚠️ Estos shortcodes no están validados por `article-validator.mjs` — si se
> incluyen, el validador los marcará como tags no permitidos. Habría que
> ampliar la lista `ALLOWED_TAGS` para usarlos.

**Imágenes inline:** una imagen con URL absoluta en el cuerpo funciona hoy
sin ningún cambio en el pipeline:

```html
<figure>
  <img src="https://example.com/imagen.jpg" alt="Descripción de la imagen">
  <figcaption>Pie de foto</figcaption>
</figure>
```

No requiere subir nada — la imagen se referencia desde su URL externa.

---

## Lo que podemos agregar con trabajo adicional

### Campos AJAX — surtitre, soustitre, chapo, ps, date

`surtitre`, `soustitre`, `chapo`, `ps` y `date` existen en la base de datos
— SPIP los rastrea con tokens MD5 (`ctr_surtitre`, `ctr_date`, etc.). El
problema es que sus inputs de edición se cargan mediante el sistema `ajaxbloc`
de SPIP, que construye las URLs de los bloques secundarios en el cliente a
partir de tokens cifrados en `data-ajax-env`. En Playwright headless, ese
ciclo JS nunca completa la petición al servidor — los inputs no aparecen en
el DOM.

**Esto no es un problema de selectores incorrectos.** El bloque entero
(`formulaire_dater`, `formulaire_instituer`, etc.) no se renderiza. La
solución para todos estos campos es la misma: resolver el problema del AJAX
headless una sola vez — probablemente forzando la ejecución del ciclo
`ajaxbloc` mediante una interacción que SPIP reconozca, o construyendo y
disparando directamente la petición que ese bloque haría.

Una vez resuelto, los selectores probables son:
- `date` — `select[name="date_redac_annee"]`, `select[name="date_redac_mois"]`,
  `input[name="date_redac_jour"]` (patrón estándar de SPIP `formulaire_dater`)
- `surtitre` / `soustitre` — `input[name="surtitre"]`, `input[name="soustitre"]`
- `chapo` / `ps` — `textarea[name="chapo"]`, `textarea[name="ps"]`

**Esfuerzo estimado:** medio. Resolver el AJAX headless desbloquea todos estos
campos a la vez. Candidato natural para implementar antes de la Etapa 2 del
dashboard, dado que `date` tiene impacto editorial real (SPIP asigna la fecha
de creación si no se envía).

### Logo del artículo (imagen destacada)

El formulario de logo está en la columna derecha (AJAX). Usa el plugin
**bigup** para upload de archivo — no acepta URL, solo upload binario.

**Para implementarlo** habría que:
1. Descargar la imagen de `coverImage.url` a un archivo temporal
2. Hacer click en el campo de upload `<input type="file" name="logo_on[]">`
3. Subir el archivo con `page.setInputFiles()`
4. Esperar a que bigup confirme el upload

**Esfuerzo estimado:** medio. Requiere descarga del archivo, gestión del
input de tipo file, y verificar que el upload asíncrono de bigup se completó.

### Mots-clés (`topics`)

El formulario de mots-clés también está en la columna derecha (AJAX). Usa un
`<select name="id_mot">` + submit. Habría que navegar los grupos de palabras
clave de SPIP, encontrar el ID numérico de cada topic y asociarlo.

**Para implementarlo** habría que navegar a la página del artículo ya creado
(con el `id_article` obtenido del write-back) y operar el formulario de
`associer_mot` por cada topic del array.

**Esfuerzo estimado:** medio-alto. Los IDs numéricos de los mots en SPIP no
son predecibles — habría que mantener una tabla de mapeo similar a
`SLUG_TO_RUBRIQUE_ID`, o hacer scraping previo con `probe-mots.mjs`.

---

## Lo que NO está a nuestro alcance

### `style=` y `class=` en el HTML del artículo

El validador del schema prohíbe explícitamente `style=` y `class=` en el
HTML del cuerpo (`contentHtml`). Esta restricción es intencional: evita que
el contenido dependa de CSS específico que puede no existir en el tema del
frontend, y previene inconsistencias visuales entre artículos.

Si se necesita un estilo especial en un artículo concreto, la solución
correcta es usar los shortcodes de Escal (`<important>`, `<centrer>`, etc.)
o extender el tema globalmente desde `configurer_escal`.

### Publicar directamente (`publie`)

El pipeline siempre publica en estado `prepa`. El artículo no es visible en
el frontend hasta que un humano lo cambia a `publie` desde el panel SPIP.
Este es un límite de diseño deliberado, no técnico.

---

## Diseño global del sitio — Escal `configurer_escal`

El panel `exec=configurer_escal` de SPIP expone configuración completa del
tema Escal: colores, fondos, tipografía, bordes, sidebar, menú, cabecera,
pie de página, labels de widgets. Todo accesible con la contraseña del usuario
`kilombo` — sin SSH, sin acceso al servidor.

**KILOMBO-BUILD ya tiene herramientas para esto:**

```bash
# Descubrir todos los campos configurables (169 campos en kilombo.top)
node scripts/probe-escal-fields.mjs --export escal-fields.json

# Cambiar un campo (siempre con --dry-run primero)
node scripts/customize-escal-theme.mjs --field <nombre-campo> --value "valor" --dry-run
node scripts/customize-escal-theme.mjs --field <nombre-campo> --value "valor"
```

Los campos disponibles se organizan en submenús:
- **Diseño** — colores principales, fondos
- **Los fondos y los textos** — colores de texto, fondo de contenido
- **Bordes y redondeo** — esquinas, bordes de cajas
- **Banner** — cabecera del sitio
- **Menú horizontal** — navegación principal
- **Página de inicio** — tabs, secciones destacadas
- **Elección de los bloques laterales** — qué sidebar mostrar
- **Configuración de bloques laterales** — títulos de widgets
- **Pie de página** — copyright, links del footer
- **Acogida** / **Otras páginas** / **Multilingüismo** / **Modalbox**

**Para usar estas herramientas en `articulos-READY`**, habría que copiar o
importar `customize-escal-theme.mjs` y `probe-escal-fields.mjs` desde
`KILOMBO-BUILD`. No son parte del flujo de publicación de artículos (son
configuración global del sitio), pero pertenecen al mismo proyecto editorial
y usan la misma contraseña.

> Ver `KILOMBO-BUILD/KILOMBO/docs/THEME-CUSTOMIZATION.md` para la guía
> completa y `KILOMBO-BUILD/KILOMBO/docs/SPIP-THEME-MANAGEMENT-FINDINGS.md`
> para el análisis de lo que es configurable.

---

## Tabla resumen

| Aspecto | Estado | Notas |
|---|---|---|
| Título | ✅ activo | |
| Cuerpo HTML (h3, p, ul, blockquote, etc.) | ✅ activo | |
| Imágenes inline por URL | ✅ activo | `<img src="https://...">` en contentHtml |
| Tablas | ✅ activo | |
| Sección (rubrique) | ✅ activo | |
| Descripción / resumen | ✅ activo | |
| Fuente (sitio + URL) | ✅ activo | |
| Surtitre / soustitre | ⚙️ pendiente | Bloque AJAX no carga en headless — resolver junto con chapo/date |
| Chapo (entradilla destacada) | ⚙️ pendiente | Ídem |
| Post-scriptum | ⚙️ pendiente | Ídem |
| Fecha del artículo (`date`) | ⚙️ pendiente | Ídem — impacto editorial real (SPIP asigna fecha de creación si falta) |
| Shortcodes Escal (`<important>`, etc.) | ⚙️ pendiente | Requiere ampliar ALLOWED_TAGS |
| Logo / imagen destacada | ⚙️ pendiente | Requiere upload de archivo vía bigup |
| Mots-clés (topics) | ⚙️ pendiente | Requiere mapeo ID mots + formulario separado |
| Colores, tipografía, fondos del sitio | ✅ alcanzable | Via `configurer_escal` + `customize-escal-theme.mjs` en KILOMBO-BUILD |
| Layout, sidebar, cabecera, pie | ✅ alcanzable | Via `configurer_escal` + `customize-escal-theme.mjs` en KILOMBO-BUILD |
| Labels de widgets y navegación | ✅ alcanzable | Via `configurer_escal` + `customize-escal-theme.mjs` en KILOMBO-BUILD |
| `style=` / `class=` en el HTML | ❌ prohibido | Restricción intencional del schema |
| Publicar directamente (`publie`) | ❌ fuera de alcance | Decisión de diseño — siempre `prepa` |
