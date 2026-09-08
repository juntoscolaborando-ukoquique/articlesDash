# Audit Reconciliation — Guía de implementación

> **Basado en:** `instrucciones` (brief de diseño, 2026-09-07)
> **Estado del audit log al momento de escribir esto:** 23 líneas — artículos 109-123, incluyendo los duplicados 119/121 y 120/122/123.

---

## Contexto y problema

El pipeline de publicación puede dejar **marcadores de idempotencia** (`spipArticleId`, `publishedAt`, `publishedUrl`) sin escribir en el JSON local cuando el write-back al archivo falla tras crear el artículo en SPIP. También pueden acumularse duplicados si el usuario publicó el mismo artículo más de una vez antes de que el marcador se escribiera.

El audit log (`live-write-audit.log.jsonl`) registra toda escritura exitosa vía `guardedWrite()`, así que es la fuente de verdad secundaria para detectar y resolver estas inconsistencias.

El objetivo de esta feature es **una pestaña en el dashboard** que lea el log, lo cruce con los archivos locales, y muestre los problemas detectados con acciones para resolverlos.

---

## Alcance

| ✅ Incluido | ❌ Fuera de alcance |
|---|---|
| Cruce local log ↔ archivos JSON | Verificar que el ID SPIP sigue vivo en el servidor |
| Detección de write-backs perdidos | Operaciones en bulk |
| Detección de duplicados en SPIP | Confirmación automática de estado via Playwright |
| Recuperación de marcadores | Log rotation / compactación del audit log |
| Historial de borrados (para no re-mostrar resueltos) | |

---

## Archivos a crear o modificar

| Archivo | Acción | Qué hace |
|---|---|---|
| `src/lib/spip-admin.mjs` | Modificar | Agregar `auditLogReport()` |
| `src/server.mjs` | Modificar | Agregar `GET /api/site/audit-report` y `POST /api/articles/:id/recover` |
| `public/app.js` | Modificar | Renderizar la reconciliation view en la pestaña Sitio |

---

## Paso 1 — `auditLogReport()` en `spip-admin.mjs`

Función **pura, síncrona, sin Playwright, sin red**. Lee dos fuentes de disco:
1. `live-write-audit.log.jsonl`
2. `articles/*.json` (via `listArticles()` de `articles-store.mjs`)

### Firma

```js
/**
 * @returns {{
 *   ok:                AuditEntry[],
 *   writeBacksMissing: AuditEntry[],
 *   duplicates:        DuplicateGroup[],
 *   orphanedMarkers:   OrphanedMarker[],
 * }}
 */
export function auditLogReport()
```

### Algoritmo detallado

#### 1. Leer y filtrar el log

```js
const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n');
const allEntries = lines.flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
```

**CRÍTICO — Punto 1 del brief:**
`target.id` tiene semántica distinta según el tipo de acción:

- `article.create`           → `target.id` es el **slug local** (`article.id`, e.g. `"fauci-fusible-controlado"`)
- `article.status.change`   → `target.id` es el **ID numérico SPIP** (e.g. `"111"`)
- `article.delete.permanent`→ `target.id` es el **ID numérico SPIP**

Filtrar siempre por `action` antes de agrupar por `target.id` para no confundir slugs con IDs numéricos.

```js
const creates = allEntries.filter(e => e.action === 'article.create'          && e.result === 'success');
const deletes = allEntries.filter(e => e.action === 'article.delete.permanent' && e.result === 'success');
```

#### 2. Construir el set de IDs SPIP borrados definitivamente

```js
const permanentlyDeletedSpipIds = new Set(deletes.map(e => String(e.target.id)));
```

Necesario porque el log es append-only (Punto 4 del brief). Sin este paso, los duplicados resueltos por borrado reaparecerán en cada carga del dashboard.

#### 3. Agrupar `creates` por slug local, excluyendo SPIP IDs ya borrados

```js
const bySlug = new Map(); // slug → AuditEntry[] (solo con articleId vivos)
for (const entry of creates) {
  const slug = entry.target.id;
  if (permanentlyDeletedSpipIds.has(String(entry.articleId))) continue; // ya borrado
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(entry);
}
```

#### 4. Cargar los artículos locales

```js
import { listArticles } from './articles-store.mjs';
const localArticles = listArticles();
const localById = new Map(localArticles.map(a => [a.id, a]));
```

#### 5. Clasificar cada slug

Para cada entrada en `bySlug` con al menos una entrada viva:

```
aliveEntries.length === 1  →  un solo create vivo
  local.spipArticleId existe  →  OK
  local.spipArticleId no existe  →  WRITE-BACK PERDIDO

aliveEntries.length > 1  →  DUPLICADO
  (nunca ofrecer recuperación directa — Punto 2 del brief)
```

#### 6. Construir `orphanedMarkers` (Punto 6 del brief)

Para cada artículo local que tiene `spipArticleId` pero no hay ninguna entrada de `article.create` viva en el log que lo respalde:

```js
for (const local of localArticles) {
  if (!local.spipArticleId) continue;
  const aliveEntries = bySlug.get(local.id) ?? [];
  const hasMatchingLog = aliveEntries.some(
    e => String(e.articleId) === String(local.spipArticleId)
  );
  if (!hasMatchingLog) {
    orphanedMarkers.push({ id: local.id, title: local.title, spipArticleId: local.spipArticleId });
  }
}
```

Cubre JSONs editados a mano, logs rotados o migrados.

### Estructura de retorno

```js
// AuditEntry (usada en ok[] y writeBacksMissing[])
{
  slug:           string,       // target.id del log (slug local)
  title:          string,       // target.title del log
  spipArticleId:  string,       // articleId del log
  loggedAt:       string,       // timestamp del log
  localHasMarker: boolean,      // si el JSON local ya tiene spipArticleId
  localSpipId:    string|null,  // spipArticleId del JSON local (puede diferir)
}

// DuplicateGroup (usada en duplicates[])
{
  slug:         string,
  title:        string,
  aliveEntries: AuditEntry[],   // SPIP IDs vivos (no borrados permanentemente)
  localSpipId:  string|null,    // cuál tiene el JSON local actualmente (puede ser null)
}

// OrphanedMarker (usada en orphanedMarkers[])
{
  id:           string,         // slug local
  title:        string,
  spipArticleId: string,        // lo que tiene el JSON, sin respaldo en el log
}
```

---

## Paso 2 — `GET /api/site/audit-report` en `server.mjs`

Endpoint ligero, **sin Playwright**, añadir junto a los otros `/api/site/*`:

```js
app.get('/api/site/audit-report', async (req, res) => {
  try {
    const { auditLogReport } = await getSpipAdmin();
    const report = auditLogReport();
    return res.json({ success: true, report });
  } catch (err) {
    console.error('[GET /api/site/audit-report]', err.message);
    return res.status(500).json({ error: err.message });
  }
});
```

`getSpipAdmin()` ya existe en `server.mjs` — import lazy de `spip-admin.mjs`. No hay nada más que agregar en cuanto a infraestructura.

---

## Paso 3 — `POST /api/articles/:id/recover` en `server.mjs`

Expone el `--recover-from-log` del CLI como llamada de API. Añadir junto a los otros `/api/articles/*`:

```js
app.post('/api/articles/:id/recover', async (req, res) => {
  const { id } = req.params;

  const article = loadArticle(id);
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  if (article.spipArticleId) {
    return res.status(409).json({
      error: 'El artículo ya tiene spipArticleId. No se necesita recuperación.',
      spipArticleId: article.spipArticleId,
    });
  }

  const result = await publishArticleUseCase(article, { recoverFromLog: true });

  switch (result.status) {
    case 'recovered':
      return res.json({ success: true, ...result });
    case 'recover-not-found':
      return res.status(404).json({ error: `No hay entrada en el audit log para "${id}"` });
    default:
      return res.status(500).json({ error: `Estado inesperado: ${result.status}` });
  }
});
```

---

## Paso 4 — Reconciliation view en `public/app.js`

### Dónde agregar

En la pestaña **Sitio** del dashboard, **encima** de los formularios existentes de "Cambiar estado" y "Borrar permanentemente". Esos formularios se mantienen intactos.

### Cuándo cargar

Al hacer clic en la pestaña Sitio: llamar a `GET /api/site/audit-report` y renderizar.
No cargar en background al arrancar — no es parte del flujo principal.

### Secciones de la UI

#### Sección A — Duplicados en SPIP

Mostrar solo si `report.duplicates.length > 0`.

Para cada `DuplicateGroup`:
- Título del artículo y su slug
- Lista de IDs SPIP vivos con su timestamp de creación
- Cuál tiene el JSON local actualmente (`localSpipId`, o "ninguno" si es null — Punto 3 del brief)
- Por cada ID que **no** es el canónico local: botón **"Mover a papelera"** → `POST /api/site/article/:spipId/status` con `{ status: 'poubelle' }`

> **Punto 5 del brief — NO encadenar papelera + borrado en un click.**
> El botón solo mueve a papelera. El borrado permanente sigue siendo el formulario
> existente en la parte inferior de la pestaña Sitio, donde el usuario escribe
> el ID manualmente. Esto preserva los dos pasos deliberados que ya existen hoy
> para una acción irreversible:
>
> 1. **"Mover a papelera"** — llama a `POST /api/site/article/:spipId/status`
>    con `{ status: 'poubelle' }`. El botón de borrado permanente no existe hasta
>    que este paso tenga éxito confirmado en la respuesta del servidor.
> 2. **"Borrar permanentemente #119"** — solo disponible tras el paso 1. Muestra
>    el ID concreto en el texto del botón para que el usuario vea exactamente qué
>    va a desaparecer antes de confirmar. Llama a `POST /api/site/article/:spipId/delete`.
>
> La razón de no encadenar: el ID "canónico" de punto 3 es una inferencia del log,
> no una certeza. Un encadenamiento automático sobre datos inciertos borra el ID
> equivocado sin que nadie lo note.

> **Punto 2 del brief — Duplicados tienen precedencia.**
> Si un slug aparece en `duplicates`, **no aparece en `writeBacksMissing`**. La UI debe resolverlos primero.

#### Sección B — Write-backs perdidos

Mostrar solo si `report.writeBacksMissing.length > 0`.

Para cada `AuditEntry` en esta lista:
- Título, ID SPIP del log, timestamp
- Botón **"Recuperar marcador"** → `POST /api/articles/:id/recover`
- Tras éxito: recargar el reporte y mover la entrada a la sección OK.

#### Sección C — Marcadores huérfanos

Mostrar solo si `report.orphanedMarkers.length > 0`.

Para cada `OrphanedMarker`:
- Artículo local, su `spipArticleId`
- Texto informativo: "No hay entrada en el audit log que respalde este marcador."
- Sin acción automática — requiere investigación manual.

#### Sección D — Estado OK

Si las tres listas anteriores están vacías:

```html
<p class="audit-ok">✅ Audit log y archivos locales coinciden.</p>
```

---

## Orden recomendado de implementación

1. - [x] **`auditLogReport()`** en `spip-admin.mjs` — pura y testeable sin servidor ni browser.
2. - [ ] **Tests unitarios** para `auditLogReport()` usando el `live-write-audit.log.jsonl` real como fixture.
3. - [x] **`GET /api/site/audit-report`** en `server.mjs` — trivial una vez que la función existe.
4. - [x] **`POST /api/articles/:id/recover`** en `server.mjs`.
5. - [x] **UI de reconciliación** en `public/app.js`.

---

## Edge cases del brief — tabla resumen

| # | Problema | Solución |
|---|---|---|
| 1 | `target.id` significa cosas distintas según la acción | Filtrar por `action === 'article.create'` antes de agrupar por `target.id` |
| 2 | Duplicados y write-backs perdidos se superponen | Duplicados tienen precedencia; no ofrecer recuperación hasta resolver duplicados |
| 3 | El "canónico" no existe si `spipArticleId` es null en el JSON | Mostrar el más reciente del log como "sugerido, no confirmado" |
| 4 | Log append-only; duplicados resueltos reaparecen | Cruzar con `article.delete.permanent` y excluir IDs borrados del mapa |
| 5 | Papelera + borrado encadenados son destructivos | Mantener dos pasos separados; botón solo mueve a papelera |
| 6 | JSON editado a mano sin entrada en el log | Categoría `orphanedMarkers` — visible pero sin acción automática |

---

## Ejemplo con los datos reales del audit log (2026-09-07)

```
Borrados permanentemente: SPIP IDs 119, 120

Duplicados vivos:
  grupo-por-verdad-y-justicia-de-bella-union → [121]  (119 excluido por borrado)
  per-la-realidad-es-muy-diferente           → [122, 123]  (120 excluido por borrado)

  Nota: con 1 solo SPIP ID vivo, "grupo-por-verdad..." ya no es un duplicado
  después del borrado. Reclasificar como write-back-missing o OK según el JSON local.

OK (un solo create vivo, spipArticleId en el JSON):
  fauci-fusible-controlado             → 110
  100000-medicos-contra-las-vacunas-covid-19 → 112
  dr-david-martin-parlamento-europeo-oms    → 113
  ... etc.

Observación sobre SPIP ID 111:
  temoignage-haute-finance-luciferienne-ronald-bernard fue publicado (create → 111)
  y luego movido a la papelera (status.change). El reporte de reconciliación
  no considera el status.change — solo importa si el JSON local tiene el marcador.
  La acción de papelera es visible en el log pero no afecta la categorización.
```
