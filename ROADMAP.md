# Roadmap — Kilombo Editorial Pipeline

**Actualizado:** 2026-09-05

---

## Criterio de ordenamiento

Las etapas siguen el orden del PLAN_KILOMBO.md: de lo más frágil y externo
(publicar en SPIP) hacia lo más interno (editor, IA). Cada etapa debe estar
**probada en producción** antes de empezar la siguiente. No hay UI hasta que
el backend que la sustenta esté verificado.

---

## Estado actual

```
Etapa 1 — Publicar    █████████████  ✅ CERRADA — primera corrida real: ID 109
Etapa 2 — Dashboard   ░░░░░░░░░░░░░  no iniciada
Etapa 3 — Editor      ░░░░░░░░░░░░░  no iniciada
Etapa 4 — IA          ░░░░░░░░░░░░░  no iniciada
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

**Empieza cuando:** la Etapa 2 esté cerrada.

Una pantalla de edición donde se puede cargar o pegar contenido, estructurarlo
en los campos del schema (título, sección, cuerpo, topics, etc.) y guardarlo
como JSON en `articles/` listo para publicar desde la lista de la Etapa 2.

Reutiliza del proyecto viejo:
- `RichTextEditor.tsx` (Tiptap) para `contentHtml`, `chapo`, `ps`
- `api/lib/schemas.mjs` + patrón Zod para validación en tiempo real
- Sanitización con DOMPurify

### Entregable de cierre
El cliente puede crear un artículo completo desde el browser y publicarlo
sin intervención del programador.

---

## Etapa 4 — Asistencia con IA

**Empieza cuando:** la Etapa 3 esté cerrada y el flujo sin IA sea estable.

Agrega un botón "Mejorar con IA" sobre el editor de la Etapa 3 que sugiere
reformulaciones vía Groq. Reutiliza `ai-improve-service.mjs` del proyecto
viejo, con la corrección del bug de matching texto plano vs. HTML (documentado
en PLAN_KILOMBO.md §5).

### Entregable de cierre
El cliente puede pedir sugerencias de mejora y aplicarlas con un clic, sin
que el HTML del artículo se corrompa.

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
