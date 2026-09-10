/**
 * articles-store.mjs
 *
 * Lee y escribe los archivos JSON en articles/.
 * Es el único lugar del backend que toca el sistema de archivos para artículos.
 *
 * Exporta:
 *   listArticles()   → Array de objetos con los campos clave de cada artículo
 *   listArchive()    → Array de objetos del archivo (articles/archive/)
 *   loadArticle(id)  → Objeto completo del artículo, o null si no existe
 *   writeBack(id, fields) → Escribe campos en el JSON (atómico: temp + rename)
 *   archiveArticle(id)    → Mueve manualmente un artículo al archivo
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateArticle } from './article-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = process.env.ARTICLES_DIR_OVERRIDE
  ?? path.join(__dirname, '..', '..', 'articles');

// Archive lives inside articles/archive/ — same root, always relative to
// ARTICLES_DIR so ARTICLES_DIR_OVERRIDE in tests keeps everything consistent.
const ARCHIVE_DIR = path.join(ARTICLES_DIR, 'archive');

// Limits
const ARTICLES_LIMIT = 100;  // max articles in articles/ before auto-archiving
const ARCHIVE_LIMIT  = 200;  // max articles in articles/archive/ before hard-deleting oldest

// ── Helpers ───────────────────────────────────────────────────────────────────

function readArticleFile(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Finds the filepath for an article by its JSON `id` field.
 * Falls back to treating `id` as the filename stem if no match found.
 * Returns { filepath, article } or null.
 */
function findArticleById(id) {
  if (!fs.existsSync(ARTICLES_DIR)) return null;

  const files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.json'));

  for (const filename of files) {
    const filepath = path.join(ARTICLES_DIR, filename);
    const article = readArticleFile(filepath);
    if (!article) continue;
    // Match by JSON id field, or by filename stem as fallback
    const jsonId = article.id ?? filename.replace('.json', '');
    if (jsonId === id) return { filepath, article };
  }
  return null;
}

/**
 * Convierte un título en un slug apto para `id` (minúsculas, sin acentos,
 * solo [a-z0-9-]). Si el resultado queda vacío (título vacío o solo símbolos),
 * devuelve null — el llamador decide el fallback.
 */
function slugify(title) {
  const slug = String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

/**
 * Slugs that collide with static routes under /api/articles/*  (e.g.
 * GET /api/articles/archive is matched before GET /api/articles/:id,
 * so an article with id "archive" would be unreachable via the detail
 * endpoint). Reserved so uniqueArticleId() never hands one out.
 */
const RESERVED_SLUGS = new Set(['archive']);

/**
 * Devuelve un id único basado en `baseSlug`, agregando un sufijo numérico
 * si ya existe un artículo con ese id, o si colisiona con una ruta estática
 * reservada (ver RESERVED_SLUGS). Si `baseSlug` es null (título vacío
 * o "Nuevo artículo" repetido), arranca de un slug con timestamp.
 */
function uniqueArticleId(baseSlug) {
  const base = baseSlug || `articulo-${Date.now()}`;
  if (!RESERVED_SLUGS.has(base) && !findArticleById(base)) return base;

  let n = 2;
  while (RESERVED_SLUGS.has(`${base}-${n}`) || findArticleById(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Returns the absolute filepath for an article by its JSON `id` field, or null.
 * Used by server.mjs to pass the path to publishArticleUseCase.
 */
export function findArticleAbsolutePath(id) {
  const found = findArticleById(id);
  return found ? found.filepath : null;
}

/**
 * Devuelve la lista de todos los artículos en articles/*.json,
 * con los campos relevantes para la UI.
 *
 * Incluye `valid` / `validationErrors` (mismo `article-validator.mjs` de
 * siempre) y `workflowStatus` ("en-progreso" | "terminado") — el tag
 * editorial local que decide en qué pestaña vive el artículo.
 *
 * Auto-corrección: `workflowStatus` es un campo declarado por un humano,
 * pero "Terminado" nunca puede contener un artículo que ya no pasa la
 * validación. Si un artículo declarado "terminado" falla `validateArticle`,
 * se lo degrada a "en-progreso" y se persiste aquí mismo, en la misma
 * lectura que ya recorre todos los artículos — no hay un job aparte.
 * La promoción (en-progreso → terminado) NUNCA ocurre acá: solo el
 * endpoint de aprobación (humano) puede moverlo en esa dirección.
 */
export function listArticles() {
  if (!fs.existsSync(ARTICLES_DIR)) return [];

  // Auto-archive: if articles/ exceeds the limit, move oldest published
  // articles to archive/ before building the list.
  enforceArchiveLimit();

  // Build a map of slug → SPIP IDs created but never permanently deleted,
  // from the audit log. Used to flag articles that were previously published
  // to SPIP even if the local JSON no longer has a spipArticleId marker.
  //
  // NOTE: the audit log path is anchored to PROJECT_ROOT (__dirname-based),
  // NOT derived from ARTICLES_DIR — ARTICLES_DIR can be overridden
  // independently (e.g. ARTICLES_DIR_OVERRIDE in tests points at an
  // unrelated tmp dir), and live-write-gateway.mjs always writes the real
  // audit log to PROJECT_ROOT regardless of that override. Deriving the
  // path from ARTICLES_DIR silently breaks this feature whenever the two
  // diverge, same edge case documented in spip-admin.mjs's auditLogReport().
  const previousSpipIdsBySlug = new Map();
  const auditLogPath = path.join(__dirname, '..', '..', 'live-write-audit.log.jsonl');
  if (fs.existsSync(auditLogPath)) {
    const entries = fs
      .readFileSync(auditLogPath, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line)]; } catch { return []; }
      });

    // target.id has different semantics per action — 'article.create' uses
    // the local slug, 'article.delete.permanent' uses the numeric SPIP id.
    // Same rule as auditLogReport() in spip-admin.mjs; must not mix them.
    const permanentlyDeletedSpipIds = new Set(
      entries
        .filter((e) => e.action === 'article.delete.permanent' && e.result === 'success')
        .map((e) => String(e.target?.id))
    );

    for (const entry of entries) {
      if (entry.action !== 'article.create' || entry.result !== 'success') continue;
      if (!entry.target?.id || !entry.articleId) continue;
      if (permanentlyDeletedSpipIds.has(String(entry.articleId))) continue; // deleted on purpose — nothing pending

      const slug = entry.target.id;
      if (!previousSpipIdsBySlug.has(slug)) previousSpipIdsBySlug.set(slug, []);
      previousSpipIdsBySlug.get(slug).push(String(entry.articleId));
    }
  }

  return fs
    .readdirSync(ARTICLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((filename) => {
      const filepath = path.join(ARTICLES_DIR, filename);
      const article = readArticleFile(filepath);
      if (!article) return null;

      const validationErrors = validateArticle(article);
      const valid = validationErrors.length === 0;

      const id = article.id ?? filename.replace('.json', '');
      const declaredWorkflowStatus = article.workflowStatus ?? 'terminado';

      let workflowStatus = declaredWorkflowStatus;
      if (declaredWorkflowStatus === 'terminado' && !valid) {
        // Self-heal: Terminado ya no puede sostener este artículo.
        // Escribe una sola vez — la próxima lectura ya lo encuentra
        // declarado "en-progreso" y no repite el write.
        console.warn(
          `[articles-store] ⚠️  "${id}" movido de Terminado → En Progreso (falló validación):\n` +
          validationErrors.map((e) => `    • ${e}`).join('\n')
        );
        // atomicWrite() directamente, no writeBack(id, ...): ya tenemos
        // `filepath` y `article` de esta misma pasada de readdirSync().
        // writeBack() volvería a llamar a findArticleById(), que relee y
        // reparsea TODOS los archivos de articles/ otra vez solo para
        // encontrar el que ya tenemos en la mano — O(n²) en la cantidad de
        // artículos, y en cada GET /api/articles que tenga algo que sanar.
        atomicWrite(filepath, article, { workflowStatus: 'en-progreso' });
        workflowStatus = 'en-progreso';
      }

      return {
        id,
        filename,
        title: article.title ?? '(sin título)',
        section: article.section ?? null,
        language: article.language ?? null,
        date: article.date ?? null,
        status: article.spipArticleId ? 'publicado' : 'listo',
        spipArticleId: article.spipArticleId ?? null,
        publishedAt: article.publishedAt ?? null,
        publishedUrl: article.publishedUrl ?? null,
        descriptif: article.descriptif ?? null,
        valid,
        validationErrors,
        workflowStatus,
        // IDs of any previous SPIP publications for this slug (from audit log),
        // excluding the current spipArticleId. Non-empty means the article was
        // published to SPIP before but the marker was cleared (deleted + re-publish
        // pending, or write-back failed). The dashboard uses this to warn the user.
        previousSpipIds: (previousSpipIdsBySlug.get(id) ?? []).filter(
          (sid) => sid !== String(article.spipArticleId ?? '')
        ),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // publicados al final, luego por fecha descendente
      if (a.status !== b.status) return a.status === 'publicado' ? 1 : -1;
      if (a.date && b.date) return b.date.localeCompare(a.date);
      return 0;
    });
}

/**
 * Crea un artículo nuevo y vacío en workflowStatus "edicion" — el botón
 * "Nuevo artículo" del dashboard. Solo lleva título (opcional) y contentHtml
 * vacío; el resto de los campos del schema (section, topics, etc.) quedan
 * sin completar y se rellenan más adelante, cuando el artículo avanza a
 * En Progreso. No se valida acá — un borrador nunca necesita ser válido.
 *
 * @param {object} [options]
 * @param {string} [options.title]
 * @returns {object} el artículo recién creado, ya con su `id` definitivo
 */
export function createDraftArticle({ title = '' } = {}) {
  if (!fs.existsSync(ARTICLES_DIR)) fs.mkdirSync(ARTICLES_DIR, { recursive: true });

  const id = uniqueArticleId(slugify(title));
  const today = new Date().toISOString().slice(0, 10);

  const article = {
    _schema_version: '1.0',
    id,
    language: 'ES',
    section: '',
    title: title || '',
    descriptif: '',
    contentHtml: '',
    date: today,
    topics: [],
    status: 'prepa',
    workflowStatus: 'edicion',
  };

  const filepath = path.join(ARTICLES_DIR, `${id}.json`);
  fs.writeFileSync(filepath, JSON.stringify(article, null, 2) + '\n', 'utf8');

  return article;
}

/**
 * Mueve un artículo a "en-progreso". Sin gate de validación — pasar a
 * En Progreso siempre debe ser posible, esté válido o no (es la dirección
 * "mandalo de vuelta a trabajo", manual o automática).
 */
export function demoteToEnProgreso(id) {
  writeBack(id, { workflowStatus: 'en-progreso' });
}

/**
 * Mueve un artículo a "terminado". A diferencia de demoteToEnProgreso, esta
 * dirección SÍ debe estar gateada por validateArticle en quien la llama
 * (server.mjs) — esta función solo hace el write, no valida.
 */
export function promoteToTerminado(id) {
  writeBack(id, { workflowStatus: 'terminado' });
}

/**
 * Manda un artículo de vuelta a "edicion" (reescritura manual desde
 * En Progreso). Sin gate — igual que demoteToEnProgreso, siempre debe
 * poder hacerse esté como esté el artículo.
 */
export function sendToEdicion(id) {
  writeBack(id, { workflowStatus: 'edicion' });
}

/**
 * Avanza un artículo de "edicion" a "en-progreso". A diferencia de
 * promoteToTerminado, acá el gate no es el schema completo (un borrador
 * recién nacido nunca lo pasa) sino el mínimo para que valga la pena
 * revisarlo: título y contenido no vacíos. El gate vive en server.mjs
 * — esta función solo hace el write.
 */
export function sendToRevision(id) {
  writeBack(id, { workflowStatus: 'en-progreso' });
}

/**
 * Carga un artículo completo por su id (campo `id` del JSON).
 * Devuelve el objeto parseado o null si no existe.
 */
export function loadArticle(id) {
  const found = findArticleById(id);
  return found ? found.article : null;
}

/**
 * Fusiona `fields` sobre `article` y escribe el resultado en `filepath`
 * de forma atómica (write a un temporal + rename sobre el original).
 * Único punto de escritura de artículos — writeBack() y writeBackToFile()
 * delegan acá para no duplicar la secuencia leer→fusionar→escribir.
 *
 * @param {string} filepath — ruta absoluta del archivo a escribir
 * @param {object} article  — artículo actual ya cargado (se fusiona, no se relee)
 * @param {object} fields   — campos a fusionar sobre `article`
 */
function atomicWrite(filepath, article, fields) {
  const updated = { ...article, ...fields };
  const tmpPath = filepath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filepath); // atómico en el mismo filesystem
}

/**
 * Auto-archive enforcement. Called at the top of every listArticles() call.
 *
 * When articles/ has more than ARTICLES_LIMIT files (excluding archive/):
 *   1. Sort candidates by "least valuable first": published articles (have
 *      spipArticleId) sorted by publishedAt ascending (oldest first).
 *      Unpublished articles (no spipArticleId) are never auto-archived.
 *   2. Move the excess published articles to articles/archive/.
 *   3. After moving, prune archive/ to ARCHIVE_LIMIT by deleting the oldest
 *      files (by mtime) — the only place in this codebase where a JSON is
 *      permanently deleted without user action.
 *
 * Runs synchronously and in-process — it is intentionally simple and cheap
 * (just fs.renameSync). Errors are logged but never propagate to the caller.
 */
function enforceArchiveLimit() {
  try {
    if (!fs.existsSync(ARTICLES_DIR)) return;

    // Count only direct .json files in articles/ (not in archive/ subdir)
    const files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.json'));
    const overflow = files.length - ARTICLES_LIMIT;
    if (overflow <= 0) return;

    // Gather published articles with their publishedAt timestamp.
    // Articles with spipArticleId but no publishedAt (e.g. a pending
    // write-back — see previousSpipIds handling above) are excluded rather
    // than treated as "oldest": sorting a missing timestamp as '' would put
    // a just-published article at the front of the archive queue.
    const candidates = [];
    for (const filename of files) {
      const filepath = path.join(ARTICLES_DIR, filename);
      const article = readArticleFile(filepath);
      if (!article?.spipArticleId || !article?.publishedAt) continue;
      candidates.push({ filepath, filename, publishedAt: article.publishedAt });
    }

    // Oldest published first
    candidates.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

    // Move only as many as needed to bring count back to the limit
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

    const toMove = candidates.slice(0, overflow);
    for (const { filepath, filename } of toMove) {
      const dest = path.join(ARCHIVE_DIR, filename);
      // If a file with the same name already exists in archive, add a timestamp suffix
      const finalDest = fs.existsSync(dest)
        ? path.join(ARCHIVE_DIR, filename.replace('.json', `-${Date.now()}.json`))
        : dest;
      fs.renameSync(filepath, finalDest);
      console.log(`[articles-store] 📦 Auto-archivado: ${filename} → archive/${path.basename(finalDest)}`);
    }

    // Prune archive/ if it exceeds ARCHIVE_LIMIT — delete oldest by mtime
    pruneArchive();
  } catch (err) {
    console.error(`[articles-store] enforceArchiveLimit error: ${err.message}`);
  }
}

/**
 * Prunes articles/archive/ to at most ARCHIVE_LIMIT files by permanently
 * deleting the oldest ones (sorted by mtime ascending).
 * Called after every auto-archive move. Errors are logged, never propagated.
 */
function pruneArchive() {
  try {
    if (!fs.existsSync(ARCHIVE_DIR)) return;
    const files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.json'));
    const overflow = files.length - ARCHIVE_LIMIT;
    if (overflow <= 0) return;

    // Sort by mtime ascending (oldest first)
    const withMtime = files.map((f) => {
      const fp = path.join(ARCHIVE_DIR, f);
      return { filepath: fp, mtime: fs.statSync(fp).mtimeMs };
    });
    withMtime.sort((a, b) => a.mtime - b.mtime);

    for (const { filepath } of withMtime.slice(0, overflow)) {
      fs.unlinkSync(filepath);
      console.log(`[articles-store] 🗑️  Archive pruned: ${path.basename(filepath)}`);
    }
  } catch (err) {
    console.error(`[articles-store] pruneArchive error: ${err.message}`);
  }
}

/**
 * Moves an article manually to articles/archive/ (user-triggered action).
 * Does not check limits — pruneArchive() handles overflow.
 * @param {string} id — article id (JSON `id` field)
 */
export function archiveArticle(id) {
  const found = findArticleById(id);
  if (!found) throw new Error(`Artículo no encontrado: ${id}`);

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const { filepath } = found;
  const filename = path.basename(filepath);
  const dest = fs.existsSync(path.join(ARCHIVE_DIR, filename))
    ? path.join(ARCHIVE_DIR, filename.replace('.json', `-${Date.now()}.json`))
    : path.join(ARCHIVE_DIR, filename);

  fs.renameSync(filepath, dest);
  pruneArchive();
}

/**
 * Returns the list of archived articles from articles/archive/*.json,
 * mapped to the same shape as listArticles() for consistent rendering.
 * No auto-archive, no self-heal — archive is read-only from the dashboard.
 */
export function listArchive() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];

  return fs
    .readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((filename) => {
      const filepath = path.join(ARCHIVE_DIR, filename);
      const article = readArticleFile(filepath);
      if (!article) return null;

      const id = article.id ?? filename.replace('.json', '');
      return {
        id,
        filename,
        title:        article.title ?? '(sin título)',
        section:      article.section ?? null,
        language:     article.language ?? null,
        date:         article.date ?? null,
        status:       article.spipArticleId ? 'publicado' : 'listo',
        spipArticleId: article.spipArticleId ?? null,
        publishedAt:  article.publishedAt ?? null,
        publishedUrl: article.publishedUrl ?? null,
        descriptif:   article.descriptif ?? null,
        workflowStatus: article.workflowStatus ?? 'terminado',
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Most recently published first in the archive view
      if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
      if (a.date && b.date) return b.date.localeCompare(a.date);
      return 0;
    });
}

/**
 * Escribe campos adicionales (spipArticleId, publishedAt, publishedUrl)
 * de vuelta al JSON del artículo, de forma atómica (write temp + rename).
 *
 * @param {string} id          — id del artículo (campo `id` del JSON)
 * @param {object} fields      — campos a fusionar en el JSON existente
 * @throws si el archivo no existe o la escritura falla
 */
export function writeBack(id, fields) {
  const found = findArticleById(id);
  if (!found) throw new Error(`Artículo no encontrado: ${id}`);

  atomicWrite(found.filepath, found.article, fields);
}

/**
 * Escribe campos adicionales de vuelta al JSON del artículo usando una ruta absoluta.
 */
export function writeBackToFile(filepath, fields) {
  if (!fs.existsSync(filepath)) throw new Error(`Archivo no encontrado: ${filepath}`);
  let article;
  try {
    article = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    throw new Error(`JSON inválido en ${filepath}: ${err.message}`);
  }

  atomicWrite(filepath, article, fields);
}
