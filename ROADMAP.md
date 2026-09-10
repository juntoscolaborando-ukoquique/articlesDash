# Roadmap — Kilombo Editorial Pipeline

**Actualizado:** 2026-09-05

---

## Documentación de soporte

- [REMOTE-MANAGE.md](REMOTE-MANAGE.md) — Guía completa para operaciones
  remotas en SPIP (cambios de estado, borrados, recuperación de marcadores,
  duplicados). Lectura obligatoria antes de trabajar con la pestaña Sitio.

- [IMPLEMENTATION-ANALYSIS.md](IMPLEMENTATION-ANALYSIS.md) — Análisis de
  viabilidad de tres mejoras de infraestructura: (1) documentación de
  operaciones remotas, (2) detección de duplicados locales en el dashboard
  Sitio (~7.5-9.5 horas, diseño completo + código de ejemplo), (3) borrado
  directo sin papelera (análisis: no recomendado, mantener 2-step actual).

---

Las etapas siguen el orden del PLAN_KILOMBO.md: de lo más frágil y externo
(publicar en SPIP) hacia lo más interno (editor, IA). Cada etapa debe estar
**probada en producción** antes de empezar la siguiente. No hay UI hasta que
el backend que la sustenta esté verificado.

---

## Estado actual

```
Etapa 1 — Publicar    █████████████  ✅ CERRADA — primera corrida real: ID 109
Etapa 2 — Dashboard   █████████████  ✅ CERRADA
Etapa 3 — Editor      ██████░░░░░░░  🔄 EN CURSO — flujo básico ya en código
Etapa 4 — IA pipeline ░░░░░░░░░░░░░  no iniciada
```

---

## Etapa 1 — Cerrar el "último tramo" (terminal → SPIP)

**Contexto:** El mecanismo base de Playwright (login SSO de YunoHost + relleno
de formulario + dry-run + bloqueo de POSTs) ya fue probado y funciona en
`KILOMBO-BUILD` (`scripts/create-article.mjs`, `scripts/migrate-to-spip.mjs`).
Lo que falta es una corrida de humo del *nuevo* código (`src/publish-article.mjs`
+ `src/lib/spip-client.mjs`) con el schema extendido: `surtitre`, `soustitre`,
`chapo`, `descriptif`, `sourceSite`, `sourceUrl` — campos que el script viejo
no rellenaba y que son nuevos en esta versión.

**Riesgo real:** bajo. No es validar desde cero, es confirmar que los campos
adicionales del nuevo schema se comportan como se espera en el formulario real.

### Tareas pendientes

- [x] **D0** — `npm run probe`: confirmar que `SLUG_TO_RUBRIQUE_ID` coincide
      con el sitio vivo ✅ verificado 2026-09-05 — todos los IDs correctos
- [x] **D1** — `npm run publish -- articles/example-article.json --dry-run`:
      verificar que todos los campos nuevos (surtitre, soustitre, chapo, etc.)
      se rellenan sin error ✅ completado
- [x] **D2** — primera publicación real con `example-article.json`:
      confirmar que `spipArticleId` queda escrito en el JSON y el artículo
      aparece en `/ecrire/` con todos los campos completos ✅ ID 109
- [ ] **D3** — implementar `topics` (mots-clés): formulario separado en SPIP
      vía Playwright, una vez confirmado que la creación base es sólida

### Entregable de cierre
✅ **Completado** — artículo ID 109 publicado en kilombo.top el 2026-09-05.
`spipArticleId` escrito en `test-publicacion-automatica.json`. Flujo completo
verificado de punta a punta.

**Hallazgo:** `surtitre`, `soustitre`, `chapo` y `ps` se cargan via AJAX —
requieren `waitForSelector()` antes de rellenarse. Documentado en
`docs/ARTICLE-DESIGN.md`. Pendiente para una iteración futura (no bloquea
la Etapa 2).

---

## Etapa 2 — Dashboard mínimo (lista + publicar)

**Empieza cuando:** la Etapa 1 esté cerrada (entregable cumplido).

**Por qué antes que el editor:** el cliente necesita ver qué artículos hay
y poder publicarlos sin acordarse de los comandos de terminal. Es la UI más
pequeña posible que entrega valor real. El editor completo viene después.

### Qué es

Una web local (o desplegada) con dos pantallas:

1. **Lista de artículos** — lee todos los `.json` de `articles/`, muestra
   título, sección, fecha, estado (`listo` / `publicado`) y `spipArticleId`
   si existe.
2. **Detalle / publicar** — muestra el resumen del artículo y un botón
   "Publicar en SPIP" que llama al backend (que invoca `publish-article.mjs`
   o directamente `SPIPClient`). Bloquea el botón si ya tiene `spipArticleId`.

### Requerimientos de concurrencia

El botón "Publicar en SPIP" introduce un modo de fallo que no existía en la
CLI: dos requests simultáneos (doble-click, recarga, pestaña duplicada) pueden
pasar ambos el chequeo `spipArticleId` antes de que el primero haga el
write-back, creando dos artículos en SPIP.
El botón "Publicar en SPIP" introduce una classica race: dos requests
concurrentes pueden saltarse un chequeo local (el `spipArticleId` que vive
en el JSON) y acabar creando duplicados en SPIP. La solución debe ser
defensiva y por capas:

1) Frontend: deshabilitar el botón optimísticamente para evitar doble-click
   accidental durante la espera del servidor (mejor UX, no una defensa única).

2) Backend: guard en el endpoint `POST /articles/:id/publish` que impida
   publicar dos veces el mismo `articleId`. Recomendación por orden de
   preferencia:

   - Si el dashboard se despliega en un solo proceso (instancia única): usar
     un `Set` en memoria para marcar `publishingInProgress`. Es simple y
     suficiente.

   - Si hay posibilidad de múltiples procesos/replicas (Heroku, PM2, k8s,
     contenedores), usar un lock distribuido ligero con Redis (SETNX / EX)
     o la librería `redlock` para coordinar entre instancias. El lock debe
     tener un TTL corto (p. ej. 60s) y la rutina debe renovar o fallar
     limpiamente si expira.

3) Double-check antes y después de adquirir el lock: siempre re-leer el
   JSON desde disco justo antes de iniciar la publicación (tras adquirir el
   lock) para verificar que `spipArticleId` no fue escrito por otra corrida.
   Esto evita races entre el chequeo inicial y el momento en que se toma el
   lock.

4) Uso del audit log como ledger secundario: si el write-back al JSON falla
   tras una creación exitosa en SPIP, `live-write-audit.log.jsonl` ya tiene la
   evidencia. Exponer un modo de recuperación (`--recover-from-log`) es
   necesario y ya existe en `src/publish-article.mjs`.

Ejemplo de patrón (Redis SETNX, pseudo-código):

```js
// usar un cliente Redis conectado (ioredis / node-redis)
const LOCK_PREFIX = 'publish-lock:';
const LOCK_TTL = 60; // segundos

async function tryAcquireLock(redis, articleId) {
  const key = LOCK_PREFIX + articleId;
  // SET key value NX EX LOCK_TTL
  const res = await redis.set(key, process.pid, 'NX', 'EX', LOCK_TTL);
  return res === 'OK';
}

async function releaseLock(redis, articleId) {
  await redis.del(LOCK_PREFIX + articleId);
}

app.post('/articles/:id/publish', async (req, res) => {
  const id = req.params.id;
  // 0) quick guard: reject if JSON already has spipArticleId
  const article = loadArticleFromDisk(id);
  if (article.spipArticleId) return res.status(409).json({ error: 'Artículo ya publicado' });

  // 1) try to acquire lock
  const locked = await tryAcquireLock(redis, id);
  if (!locked) return res.status(409).json({ error: 'Publicación en curso para este artículo' });

  try {
    // 2) re-read file after taking lock (double-check)
    const recheck = loadArticleFromDisk(id);
    if (recheck.spipArticleId) return res.status(409).json({ error: 'Artículo ya publicado (post-lock)' });

    // 3) call SPIPClient.publishArticle()
    const result = await spipClient.publishArticle(recheck, { dryRun: false });

    // 4) on success, write-back to JSON (atomic rename pattern recommended)
    if (result.success) writeBackResultToDiskAtomically(id, result);

    return res.json(result);
  } finally {
    await releaseLock(redis, id);
  }
});
```

Notas operativas:

- Si optas por Redis, usar un TTL razonable y diseñar la operación para que
  la duración típica de publicación quede por debajo del TTL, o renovar el
  lock si la operación puede tardar más (implementar solo si necesario).
- En despliegues únicos, el `Set` en memoria es suficiente y más simple.
- Hacer el write-back al JSON de forma atómica: escribir a un fichero
  temporal y `rename` sobre el original para evitar archivos parcialmente
  escritos que confundan lecturas concurrentes.
- Mantener el `--recover-from-log` y documentar el procedimiento operativo
  si el write-back falla (usar `live-write-audit.log.jsonl` para recuperar
  el `spipArticleId`).

Con esto la UX (frontend disable) evita clicks repetidos y el backend
garantiza la exclusión mutua real incluso en entornos con múltiples réplicas.

### Qué no incluye todavía
- Editor de contenido (viene en la Etapa 3)
- Subida de imágenes
- Autenticación (es una herramienta interna de un solo usuario)

### Stack sugerido
- **Backend:** Node.js + Express (mínimo, sin framework pesado) que expone
  dos endpoints: `GET /articles` y `POST /articles/:id/publish`
- **Frontend:** HTML + JS vanilla o un framework ligero (sin TypeScript por
  ahora, para no añadir tooling hasta que sea necesario)
- El backend reutiliza directamente `SPIPClient` y `article-validator.mjs`
  — no hay reescritura, solo un wrapper HTTP

### Entregable de cierre
Publicar un artículo desde el browser sin tocar la terminal.

---

## Etapa 3 — Editor de artículos (texto imperfecto → JSON listo)

**Estado real (actualizado 2026-09-06):** parte de esta etapa ya está en
código, aunque ninguna entrada de CHANGELOG.md la había documentado hasta
ahora. Ya existen:

- Flujo de tres pasos `edicion` → `en-progreso` → `terminado`
  (`workflowStatus` en `articles-store.mjs`, endpoints `demote` / `promote` /
  `send-to-edicion` / `send-to-revision` en `server.mjs`, pestañas
  correspondientes en `app.js`).
- Pantalla de Edición mínima: título + cuadro de texto libre, que el backend
  convierte a `contentHtml` restringido vía `textToParagraphHtml()`
  (`PUT /api/articles/:id/draft`).
- Auto-corrección: un artículo declarado "terminado" que deja de pasar
  `validateArticle()` se degrada solo a "en-progreso" en la próxima lectura.
- Guardia contra pegar JSON/HTML en crudo en el cuadro de texto libre
  (`looksLikeStructuredPaste()`), como aviso no bloqueante — ver CHANGELOG 1.3.4.

**Lo que falta para cerrar la etapa:**
- **Detección y limpieza de duplicados locales en el Sitio** — cuando dos
  borradores tienen títulos similares. Ver
  [IMPLEMENTATION-ANALYSIS.md](IMPLEMENTATION-ANALYSIS.md) §2 ("Issue 2:
  Duplicate detection") para los detalles de diseño, endpoints backend, UI
  y estimación de esfuerzo (~7.5-9.5 horas). La feature está completamente
  analizada y lista para implementar. Resumen: nuevo endpoint
  `POST /api/site/find-local-duplicates`, card en Sitio tab, selector de
  canonical con metadata (fecha, tamaño, palabras), botón para borrar duplicados
  seleccionados. Incluye shared utility `src/lib/text-utils.mjs` con normalización
  de títulos para evitar divergencia backend/frontend.

- Editor real de campos (surtitre, soustitre, chapo, ps, topics, coverImage) —
  hoy Edición solo cubre título + cuerpo en texto plano.
  → Ver **[IMPROVE_STEPS.md](../IMPROVE_STEPS.md)** para el plan detallado:
  splitter heurístico + formulario editable en En Progreso, diseñado para que
  Groq (Etapa 4) se enchufe en el mismo punto sin tocar la UI.
- Rich-text (Tiptap) en vez de textarea plano, si se decide que hace falta
  para el contenido real que se está publicando.
- Sanitización explícita (DOMPurify o equivalente) antes de que el HTML
  pegado llegue a `article-validator.mjs`, en vez de depender solo de la
  detección heurística de `looksLikeStructuredPaste()`.
- Antes de abrir el editor a pegado de HTML más libre, resolver la deuda
  técnica ya documentada en 1.3.3: reemplazar el validador de HTML basado en
  regex por un parser real (`node-html-parser` o `parse5`).

### Entregable de cierre
El cliente puede crear un artículo completo desde el browser y publicarlo
sin intervención del programador.

---

## Etapa 4 — IA pipeline (Groq en las transiciones del workflow)

**Empieza cuando:** la Etapa 3 esté cerrada y el flujo manual sea estable
en producción.

### Qué es

Groq actúa automáticamente en dos puntos del workflow, no como asistente
opcional sino como parte de la transición de estado. El artículo nunca pasa
de etapa con los campos en crudo — el paso por IA es la condición de que
esté listo para la siguiente fase.

#### Transición 1 — Edición → En Progreso

Cuando el usuario pulsa "Enviar a Revisión", antes de escribir
`workflowStatus: "en-progreso"` en el JSON, el backend llama a Groq con el
texto libre que escribió el editor y le pide que lo estructure en los campos
del schema: `title`, `surtitre`, `soustitre`, `chapo`, `contentHtml`, `ps`,
`descriptif`, `topics`, `section`, `date`, `sourceSite`, `sourceUrl`.

El resultado se escribe en el JSON antes de que el artículo aparezca en la
pestaña En Progreso. El usuario ve el artículo ya con los campos asignados,
no el texto en bruto.

**Contrato esperado de Groq en esta fase:**
- Extraer título obvio si no está puesto.
- Rellenar `contentHtml` con el HTML restringido del schema (solo `<p>` y
  `<br>`; `text-to-html.mjs` puede usarse para sanear la salida).
- Proponer `topics` (array de 2–6 slugs en minúsculas) y `section` (uno de
  los valores válidos del schema) como sugerencia — el editor puede
  corregirlos en En Progreso.
- No inventar información que no esté en el texto original.

#### Transición 2 — En Progreso → Terminado

Cuando el usuario pulsa "Aprobar", antes de correr `validateArticle` y fijar
`workflowStatus: "terminado"`, el backend llama a Groq para dar el formato
definitivo al artículo: ajustar el HTML de `contentHtml` al schema estricto,
completar `chapo` si está vacío, normalizar `topics` y verificar que `section`
sea uno de los valores válidos.

Solo si tras el paso por Groq el artículo pasa `validateArticle` completo,
se escribe `terminado`. Si no pasa, se devuelven los errores de validación
al usuario para corrección manual (mismo flujo que hoy, sin IA).

**Propósito de esta fase:** llegar a Terminado con el JSON listo para
publicar directamente, sin intervención manual del programador.

### Módulo a crear

`src/lib/groq-enrichment.mjs` — cliente Groq con dos funciones exportadas:

```js
enrichDraft(rawText, partialArticle)   // Transición 1
finalizeArticle(article)               // Transición 2
```

Ambas devuelven `{ status: 'ok' | 'error', fields, rawResponse }`. El
caller (use case o handler) decide si escribir el resultado o mostrarlo
como sugerencia al usuario.

> **Nota de integración:** `enrichDraft()` reemplaza a `splitContentIntoFields()`
> de `field-splitter.mjs` (ver [IMPROVE_STEPS.md](../IMPROVE_STEPS.md) Paso 7)
> en el mismo punto de `POST /api/articles/:id/send-to-revision` — devuelve la
> misma forma `{ chapo, contentHtml, ps, guessed }`, sin cambios en la UI ni en
> el endpoint de campos.

Reutiliza la clave `GROQ_API_KEY` — añadir a `.env` y `.env.example` antes de
implementar (el placeholder ya está en `.env.example`).
Reutiliza el patrón de `ai-improve-service.mjs` del proyecto viejo, con la
corrección del bug de matching texto plano vs. HTML (documentado en
PLAN_KILOMBO.md §5).

### Decisiones abiertas (a tomar antes de implementar)

1. **¿Automático o con confirmación?** — En la Transición 1, ¿el usuario
   ve el artículo ya estructurado y puede editar antes de confirmar, o se
   aplica sin previa vista? Recomendación: mostrar los campos propuestos en
   un paso intermedio ("Groq sugiere esto — ¿confirmar?") para que el editor
   tenga control.

2. **Manejo de errores de Groq** — si la API falla o devuelve JSON
   malformado, ¿se bloquea la transición o se deja pasar el artículo en
   crudo? Recomendación: dejar pasar con aviso, no bloquear el workflow.

3. **Prompt engineering** — los prompts son parte del código y deben estar
   versionados en `src/lib/groq-enrichment.mjs`, no hardcodeados en los
   handlers.

### Entregable de cierre

Un artículo pegado como texto plano en el editor llega a Terminado con todos
los campos del schema correctamente asignados y listo para publicar, sin que
el programador toque el JSON a mano.

---

## Etapa 3.5 — Retractación de artículos ya publicados

**Empieza cuando:** la pestaña Sitio del dashboard (ya implementada) sea
estable. No bloquea el cierre de la Etapa 3.

### Problema

El pipeline es hoy de una sola dirección: publicar. Si un artículo ya
publicado en SPIP es desaprobado (se descubren marcadores `[cite: N]`
que se publicaron como texto literal, se detecta contenido corrupto, cambio
editorial de criterio), no hay forma automatizada de retirarlo. El editor
tiene que entrar manualmente a `/ecrire/`, cambiar el estado y opcionalmente
borrar. Para artículos con `workflowStatus: 'terminado'` y `spipArticleId`
presente, el dashboard no ofrece ninguna acción.

### Solución propuesta

Dos botones en cada fila de la pestaña Terminado que tenga `spipArticleId`,
uno al lado del otro:

- **"Desaprobar"** — marca el artículo como desaprobado editorialmente pero
  lo deja en SPIP (en papelera). Útil cuando el contenido necesita revisión
  y puede volver a publicarse tras correcciones.
- **"Borrar de SPIP"** — elimina el artículo permanentemente del sitio.
  Opción separada y más destructiva; solo disponible una vez que el artículo
  ya está en estado retractado/desaprobado, o como acción directa con doble
  confirmación.

Los dos botones son acciones distintas con consecuencias distintas — no se
colapsan en uno. El flujo de cada uno:

El botón de acción principal de cada fila es **stateful** — muestra una cosa
u otra según si el artículo ya está publicado en SPIP:

- **Sin `spipArticleId`** (no publicado): muestra **"Publicar en SPIP"** —
  comportamiento actual.
- **Con `spipArticleId`** (ya publicado): el botón "Publicar en SPIP"
  desaparece y en su lugar aparece **"Borrar de SPIP"** (rojo, peligro).
  Esto hace estructuralmente imposible re-publicar un artículo ya publicado
  desde la UI — el botón que podría crear un duplicado ya no existe.

Al lado del botón principal, para artículos publicados, aparece también
**"Desaprobar"** (amarillo, advertencia) — acción menos destructiva que mueve
el artículo a papelera en SPIP sin borrarlo.

Resumen visual por estado:

```
Sin spipArticleId  →  [ Publicar en SPIP ]
Con spipArticleId  →  [ Desaprobar ]  [ Borrar de SPIP ]
```

**Botón "Desaprobar" (reversible):** cambia el estado SPIP a `poubelle` vía
el endpoint existente `POST /api/site/article/:spipId/status`. El artículo
deja de ser visible en el sitio público pero sigue en SPIP (papelera). El
JSON local pasa a `workflowStatus: 'retractado'` + `retractedAt` timestamp.
El artículo aparece en una nueva sub-sección "Desaprobados" en la pestaña
Terminado (o en su propia pestaña si el volumen lo justifica). Desde ahí
puede re-editarse y volver a publicarse.

**Botón "Borrar de SPIP" (irreversible):** disponible en la misma fila, al
lado de "Desaprobar". Llama al endpoint existente
`POST /api/site/article/:spipId/delete` — mueve a papelera y borra
permanentemente en una sola operación, o en dos pasos si el artículo ya está
desaprobado. Requiere confirmación explícita con texto claro de irreversibilidad
(mismo patrón que el `confirm()` ya implementado en la pestaña Sitio). El JSON
local pasa a `workflowStatus: 'borrado'` + `deletedAt`. El artículo desaparece
de todas las vistas del dashboard.

### Lo que ya existe y se reutiliza

- `spip-admin.mjs` — `changeArticleStatus()` y `permanentlyDelete()` ya
  implementados y probados.
- `POST /api/site/article/:spipId/status` y `.../delete` — endpoints ya
  presentes en `server.mjs`.
- `confirm()` gates en `handleSiteStatusChange()` y `handleSiteDelete()`
  en `app.js` — patrón a replicar.

### Lo que hay que añadir

- `workflowStatus: 'retractado'` y `'borrado'` como valores válidos en
  `articles-store.mjs` y la lógica de listado.
- Botón "Desaprobar" y botón "Borrar de SPIP" en las filas de Terminado con
  `spipArticleId`, uno al lado del otro con estilos diferenciados (amarillo
  advertencia vs. rojo peligro). Cada uno con su propio `confirm()`.
- `confirm()` de "Borrar de SPIP" más reforzado (irreversible, dos líneas de
  advertencia).
- Endpoint `POST /api/articles/:id/retract` en `server.mjs` que orqueste:
  cambio de estado SPIP → write-back de `workflowStatus: 'retractado'`.
  (Reutiliza `publishArticleUseCase` como modelo arquitectónico — mismo
  patrón de seams inyectables para testear sin Playwright.)
- Tests en `test/publish-use-case.test.mjs` o un archivo hermano que
  verifiquen que la retractación escribe los campos correctos.

### Entregable de cierre

Un artículo publicado puede ser desaprobado o borrado de SPIP desde el
dashboard en dos clicks, con botones separados ("Desaprobar" / "Borrar de
SPIP") visibles en cada fila de Terminado, el estado local actualizado y sin
necesidad de tocar `/ecrire/` manualmente.

---

## Lo que no está en este roadmap (fuera de alcance por ahora)

- Autenticación multiusuario
- Subida directa de `coverImage` a SPIP (Etapa 1, D5 eventual)
- Gestión del estado `publie` desde el dashboard (la publicación final sigue
  siendo manual desde `/ecrire/` — decisión de diseño deliberada)
- Mirror JSON / CDN de artículos publicados (era parte del proyecto viejo,
  no es necesario para el flujo editorial básico)

---

## Respuesta directa a la pregunta

> ¿El dashboard es un buen siguiente paso?

Casi. El mecanismo base de Playwright está probado en `KILOMBO-BUILD` — no
hay que validar desde cero. Lo que falta es una corrida de humo rápida del
nuevo código con el schema extendido (campos como `surtitre`, `chapo`, etc.
que son nuevos respecto al script viejo). Eso es una tarde, no una semana.

Una vez que D1/D2 pasen, el dashboard mínimo (Etapa 2) es el paso correcto:
es la UI más pequeña que convierte esta herramienta de terminal en algo que
puede usar el cliente.
