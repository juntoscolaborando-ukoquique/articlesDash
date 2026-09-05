/**
 * articles-store.mjs
 *
 * Lee y escribe los archivos JSON en articles/.
 * Es el único lugar del backend que toca el sistema de archivos para artículos.
 *
 * Exporta:
 *   listArticles()  → Array de objetos con los campos clave de cada artículo
 *   loadArticle(id) → Objeto completo del artículo, o null si no existe
 *   writeBack(id, fields) → Escribe campos en el JSON (atómico: temp + rename)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateArticle } from './article-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = path.join(__dirname, '..', '..', 'articles');

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
 * Devuelve un id único basado en `baseSlug`, agregando un sufijo numérico
 * si ya existe un artículo con ese id. Si `baseSlug` es null (título vacío
 * o "Nuevo artículo" repetido), arranca de un slug con timestamp.
 */
function uniqueArticleId(baseSlug) {
  const base = baseSlug || `articulo-${Date.now()}`;
  if (!findArticleById(base)) return base;

  let n = 2;
  while (findArticleById(`${base}-${n}`)) n += 1;
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
        writeBack(id, { workflowStatus: 'en-progreso' });
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

  const { filepath, article } = found;
  const updated = { ...article, ...fields };
  const tmpPath = filepath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filepath); // atómico en el mismo filesystem
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
  const updated = { ...article, ...fields };
  const tmpPath = filepath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filepath);
}
