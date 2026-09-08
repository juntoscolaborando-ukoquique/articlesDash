# Schema de Artículo — articulos-READY

Versión: `1.0`

Un artículo READY es un objeto JSON que contiene todo lo necesario para
publicarlo en `www.kilombo.top` vía el formulario SPIP, dejándolo en estado
**"en preparación"** (`prepa`) para revisión humana antes de publicar.

---

## Estructura completa

```json
{
  "_schema_version": "1.0",

  "id":       "titulo-del-articulo-slug",
  "language": "ES",
  "section":  "nom",

  "surtitre":  "OPERACIÓN COVID",
  "title":     "Anthony Fauci: Fusible Controlado",
  "soustitre": "Cómo se construye y destruye una figura institucional",
  "descriptif": "Resumen breve de 1-2 frases para listados y metadatos SEO.",

  "coverImage": {
    "url":     "https://example.com/imagen.jpg",
    "alt":     "Texto alternativo accesible",
    "caption": "Pie de foto opcional",
    "credit":  "Fuente: Reuters"
  },

  "chapo": "<p>Párrafo introductorio que aparece antes del cuerpo, generalmente en negrita.</p>",

  "contentHtml": "<h3>Primer bloque</h3><p>Contenido...</p>",

  "ps": "<p>Nota aclaratoria, addendum o fuente extendida al pie del artículo.</p>",

  "author":     "Yves Rasir",
  "sourceSite": "Herdenkings Journalistiek",
  "sourceUrl":  "https://substack.com/@yves-rasir",
  "sourceDate": "2026-07-20",

  "date":   "2026-09-05",
  "topics": ["fauci", "covid-19", "operacion-militar", "darpa"],
  "status": "prepa",

  "notes": "Traducido del francés. Revisar párrafo 3."
}
```

---

## Campos

### Identidad

| Campo             | Tipo     | Req | Descripción |
|-------------------|----------|-----|-------------|
| `_schema_version` | string   | sí  | Siempre `"1.0"` |
| `id`              | string   | sí  | Slug único: minúsculas, guiones, sin espacios ni caracteres especiales |
| `language`        | enum     | sí  | `ES` \| `FR` \| `EN` |
| `section`         | enum     | sí  | Ver tabla de secciones abajo |

### Cabecera editorial → campos SPIP directos

| Campo       | Tipo   | Req | Campo SPIP  | Descripción |
|-------------|--------|-----|-------------|-------------|
| `title`     | string | sí  | `titre`     | Título principal |
| `surtitre`  | string | no  | `surtitre`  | Texto sobre el título (p.ej. nombre de la serie o categoría temática) |
| `soustitre` | string | no  | `soustitre` | Subtítulo bajo el título |
| `descriptif`| string | no  | `descriptif`| 1-2 frases para listados y SEO. Sin HTML. |

### Imagen destacada

| Campo                  | Tipo   | Req | Descripción |
|------------------------|--------|-----|-------------|
| `coverImage`           | objeto | no  | Imagen principal del artículo |
| `coverImage.url`       | string | sí* | URL absoluta de la imagen |
| `coverImage.alt`       | string | sí* | Texto alternativo (accesibilidad, obligatorio si `coverImage` presente) |
| `coverImage.caption`   | string | no  | Pie de foto visible al lector |
| `coverImage.credit`    | string | no  | Crédito de la imagen (p.ej. `"Reuters"`) |

*Requeridos si `coverImage` está presente.

### Cuerpo del artículo → campos SPIP directos

| Campo         | Tipo   | Req | Campo SPIP | Descripción |
|---------------|--------|-----|------------|-------------|
| `chapo`       | string | no  | `chapo`    | Entradilla (párrafo introductorio antes del cuerpo, habitualmente en negrita) |
| `contentHtml` | string | sí  | `texte`    | Cuerpo principal en HTML controlado (ver reglas abajo) |
| `ps`          | string | no  | `ps`       | Post-scriptum al pie del artículo |

### Fuente y autoría → campos SPIP directos

| Campo        | Tipo   | Req | Campo SPIP  | Descripción |
|--------------|--------|-----|-------------|-------------|
| `author`     | string | no  | —           | Autor/a del artículo original |
| `sourceSite` | string | no  | `nom_site`  | Nombre del sitio o publicación de origen |
| `sourceUrl`  | string | no  | `url_site`  | URL del sitio o artículo de origen |
| `sourceDate` | string | no  | —           | Fecha de publicación en la fuente original (`YYYY-MM-DD`). Se valida pero **no se escribe en SPIP** (sin campo equivalente en el formulario de creación). |

### Clasificación y estado

| Campo    | Tipo     | Req | Campo SPIP | Descripción |
|----------|----------|-----|------------|-------------|
| `date`   | string   | sí  | —          | Fecha del artículo en formato `YYYY-MM-DD`, o `""` si desconocida. Se valida pero **todavía no se escribe en SPIP** (ver "Mapeo completo JSON → SPIP") |
| `topics` | string[] | sí  | —          | Array de 2 a 6 etiquetas en minúsculas |
| `status` | enum     | sí  | `statut`   | Siempre `"prepa"` en este proyecto |
| `workflowStatus` | enum | no | — | `"en-progreso"` \| `"terminado"`. Tag editorial **local del dashboard**, nunca se envía a SPIP. Default `"terminado"` si el campo no existe. Ver nota abajo. |

> ⚠️ **`status` vs. `workflowStatus` — no son lo mismo.** `status` es el
> campo que viaja a SPIP (`statut`) y siempre vale `"prepa"`.
> `workflowStatus` decide en qué pestaña del dashboard vive el artículo
> ("En Progreso" / "Terminado"). No lo determina solo la validación: es un
> campo declarado, y solo dos cosas pueden escribirlo —
> 1) un humano, vía `POST /api/articles/:id/demote` (Terminado → En
>    Progreso, siempre permitido, esté válido o no) y el futuro endpoint de
>    aprobación (En Progreso → Terminado, gateado por `article-validator.mjs`);
> 2) el propio `listArticles()`, que en cada lectura verifica que ningún
>    artículo declarado `"terminado"` haya dejado de pasar la validación —
>    si eso pasa, lo degrada a `"en-progreso"` automáticamente y persiste el
>    cambio. Esa dirección (auto-degradación) es la única automática; nunca
>    se promueve un artículo a `"terminado"` sin una aprobación humana.

### Notas internas

| Campo   | Tipo   | Req | Descripción |
|---------|--------|-----|-------------|
| `notes` | string | no  | Notas editoriales internas. No se envía a SPIP. |

---

## Secciones válidas

| Slug        | ID SPIP | Nombre en kilombo.top |
|-------------|---------|----------------------|
| `general`   | 1       | kilombo (raíz) |
| `tierra`    | 1       | tierra (sin rubrique propio, usa raíz) |
| `gci`       | 3       | icg |
| `pi`        | 2       | Proletarios internacionalistas |
| `nom`       | 19      | NUEVO ORDEN / PLANDEMISMO Y DOMESTICACIÓN (ES) |
| `actualidad`| 21      | Actualités |

---

## Reglas de `contentHtml`

El cuerpo del artículo es HTML controlado. Tags permitidos:

```
Estructura:   <h3> <h4> <p> <br> <hr>
Énfasis:      <strong> <em>
Listas:       <ul> <ol> <li>
Citas:        <blockquote>
Imágenes:     <figure> <figcaption> <img src alt>
Tablas:       <table> <thead> <tbody> <tr> <th> <td>
Enlaces:      <a href>
```

**Prohibido:**
- `<div>`, `<span>`, `<script>`, `<style>`
- Atributos `style=`, `class=`, `onclick=` o cualquier event handler
- Imágenes sin atributo `alt`
- HTML mal formado (tags sin cerrar, atributos sin comillas)

---

## Reglas de validación

Un archivo es READY cuando cumple **todas** estas condiciones:

1. `_schema_version` es `"1.0"`
2. `id` es un slug válido: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
3. `title` no está vacío
4. `section` es uno de los slugs válidos de la tabla
5. `language` es `ES`, `FR` o `EN`
6. `date` es `YYYY-MM-DD` o `""`
7. `contentHtml` no está vacío
8. `contentHtml` contiene solo tags permitidos
9. `topics` es un array de 2 a 6 strings en minúsculas
10. `status` es `"prepa"`
11. Si `coverImage` está presente: `url` y `alt` son obligatorios

---

## Mapeo completo JSON → SPIP

| Campo JSON   | Campo SPIP   | Notas |
|--------------|--------------|-------|
| `title`      | `titre`      | Campo principal, obligatorio |
| `surtitre`   | `surtitre`   | Campo AJAX — puede no estar en el DOM inicial del form; se rellena solo si el selector responde (ver docs/ARTICLE-DESIGN.md) |
| `soustitre`  | `soustitre`  | Ídem |
| `descriptif` | `descriptif` | Textarea visible en el form |
| `chapo`      | `chapo`      | Puede estar en modo WYSIWYG; verificar |
| `contentHtml`| `texte`      | Textarea principal, confirmado |
| `ps`         | `ps`         | Puede estar en modo WYSIWYG; verificar |
| `sourceSite` | `nom_site`   | Input visible en el form |
| `sourceUrl`  | `url_site`   | Input visible en el form |
| `sourceDate` | —            | **No se escribe** — solo metadato local. Se valida pero no hay campo correspondiente en el formulario SPIP de creación de artículo. |
| `section`    | `id_parent`  | Slug traducido a ID numérico por `slugToRubriquId()` |
| `status`     | `statut`     | **No se escribe** — SPIP asigna `prepa` por defecto al crear el artículo. El campo se valida (solo acepta `"prepa"`) pero el script nunca llama a `manage-article-status` ni toca `statut`. |
| `date`       | `date`       | **Pendiente de implementar.** Se valida pero no hay selector en `spip-client.mjs` todavía; para añadirlo, ejecutar Playwright en modo no headless y verificar el input en el DOM de `article_edit` |
| `coverImage` | logo/adjunto | Subida de imagen vía formulario de adjuntos (pendiente de implementar) |
| `author`     | —            | No tiene campo directo en SPIP en la implementación actual |
| `topics`     | mots-clés    | Formulario separado en SPIP (pendiente de implementar) |
| `notes`      | —            | Solo uso interno, nunca se envía |
