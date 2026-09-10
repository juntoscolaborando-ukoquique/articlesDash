/**
 * server.mjs
 *
 * Express backend para el dashboard de Kilombo Editorial.
 *
 * Endpoints:
 *   GET  /api/articles           — lista todos los artículos en articles/
 *   GET  /api/articles/:id       — devuelve un artículo completo
 *   POST /api/articles/:id/publish — publica el artículo en SPIP
 *
 * Guarda contra publicaciones duplicadas:
 *   1) Chequeo inicial: si el JSON ya tiene spipArticleId → 409
 *   2) Lock en memoria: si ya hay una publicación en curso → 409
 *   3) Double-check post-lock: re-lee el JSON antes de lanzar SPIPClient
 *
 * Uso:
 *   node src/server.mjs [--port=3000]
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listArticles,
  listArchive,
  loadArticle,
  writeBack,
  createDraftArticle,
  demoteToEnProgreso,
  promoteToTerminado,
  sendToEdicion,
  sendToRevision,
  archiveArticle,
} from './lib/articles-store.mjs';
import { validateArticle, ALLOWED_TAGS } from './lib/article-validator.mjs';
import { publishArticleUseCase } from './lib/publish-use-case.mjs';
import { textToParagraphHtml, looksLikeStructuredPaste } from './lib/text-to-html.mjs';
import { splitContentIntoFields } from './lib/field-splitter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR    = path.join(__dirname, '..', 'public');

// ── Arg parsing ───────────────────────────────────────────────────────────────

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 3000;

// ── In-memory publish lock ────────────────────────────────────────────────────
// Single-process guard. Sufficient for a single-user local tool.
// If ever deployed with multiple replicas, replace with Redis SETNX.

const publishingInProgress = new Set();

// ── Shared route helpers ─────────────────────────────────────────────────────
//
// Express 4 does NOT catch a rejected promise thrown from an async route
// handler — an error thrown outside a route's own try/catch (e.g. loadArticle()
// before its try block, as several routes below used to do) leaves the request
// hanging with no response at all, instead of a 500. asyncHandler() closes that
// gap by wrapping every route body in one try/catch, and also centralizes the
// "log the error, respond 500 with its message" boilerplate every route used
// to repeat by hand.
//
// loadArticleOr404() covers the load-or-404 guard that opens almost every
// /api/articles/:id/* route. If it returns null, the response is already
// sent (404) and the caller should just `return`.

function asyncHandler(label, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${label}]`, err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  };
}

function loadArticleOr404(id, res) {
  const article = loadArticle(id);
  if (!article) {
    res.status(404).json({ error: 'Artículo no encontrado' });
    return null;
  }
  return article;
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── API: lista de artículos ───────────────────────────────────────────────────

app.get('/api/articles', asyncHandler('GET /api/articles', async (_req, res) => {
  const articles = listArticles();
  res.json({ articles });
}));

// ── API: crear artículo nuevo (borrador vacío en Edición) ────────────────────
//
// "Nuevo artículo" del dashboard. Sin gate de validación — un borrador
// recién nacido nunca es válido y no tiene por qué serlo.

app.post('/api/articles', asyncHandler('POST /api/articles', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : '';
  const article = createDraftArticle({ title });
  res.status(201).json({ article });
}));

// ── API: schema (metadata expuesta al frontend) ───────────────────────────────
//
// Le da a public/app.js una fuente de verdad en runtime en vez de una copia
// manual. sanitizeHtml() en app.js consulta esto una vez al cargar la página
// y cae de vuelta a una lista fija embebida si el fetch falla (arranque sin
// red, etc.) — ver el comentario junto a DETAIL_ALLOWED_TAGS en app.js.

app.get('/api/schema/allowed-tags', asyncHandler('GET /api/schema/allowed-tags', async (_req, res) => {
  res.json({ allowedTags: [...ALLOWED_TAGS] });
}));

// ── API: archivo — lista ──────────────────────────────────────────────────────

app.get('/api/articles/archive', asyncHandler('GET /api/articles/archive', async (_req, res) => {
  res.json({ articles: listArchive() });
}));

// ── API: detalle de artículo ──────────────────────────────────────────────────

app.get('/api/articles/:id', asyncHandler('GET /api/articles/:id', async (req, res) => {
  const article = loadArticleOr404(req.params.id, res);
  if (!article) return;
  res.json({ article });
}));

// ── API: archivo — mover artículo manualmente ─────────────────────────────────
//
// El auto-archivado ocurre en listArticles(). Este endpoint permite al usuario
// archivar manualmente un artículo desde la UI sin esperar al límite.
// Sin gate: cualquier artículo puede archivarse, esté publicado o no.

app.post('/api/articles/:id/archive', asyncHandler('POST /api/articles/:id/archive', async (req, res) => {
  const { id } = req.params;
  if (!loadArticleOr404(id, res)) return;
  archiveArticle(id);
  res.json({ success: true });
}));

// ── API: desaprobar artículo (Terminado → En Progreso) ────────────────────────
//
// Sin gate de validación — mandar un artículo a "en-progreso" siempre debe
// poder hacerse, esté válido o no. No toca SPIP ni spipArticleId.

app.post('/api/articles/:id/demote', asyncHandler('POST /api/articles/:id/demote', async (req, res) => {
  const { id } = req.params;
  if (!loadArticleOr404(id, res)) return;

  demoteToEnProgreso(id);
  res.json({ success: true, workflowStatus: 'en-progreso' });
}));

// ── API: aprobar artículo (En Progreso → Terminado) ───────────────────────────
//
// Gateado por validateArticle: solo se puede aprobar si el artículo es válido.
// No toca SPIP ni spipArticleId.

app.post('/api/articles/:id/promote', asyncHandler('POST /api/articles/:id/promote', async (req, res) => {
  const { id } = req.params;
  const article = loadArticleOr404(id, res);
  if (!article) return;

  const errors = validateArticle(article);
  if (errors.length > 0) {
    return res.status(422).json({
      error: 'El artículo no pasa la validación y no puede ser aprobado.',
      validationErrors: errors,
    });
  }
  promoteToTerminado(id);
  res.json({ success: true, workflowStatus: 'terminado' });
}));

// ── API: guardar borrador (título + texto libre) mientras está en Edición ────
//
// Recibe texto plano (lo que el usuario escribió/pegó) y lo convierte acá,
// de forma centralizada, en el HTML restringido que exige contentHtml.
// No toca workflowStatus — guardar nunca cambia de etapa.

app.put('/api/articles/:id/draft', asyncHandler('PUT /api/articles/:id/draft', async (req, res) => {
  const { id } = req.params;
  const article = loadArticleOr404(id, res);
  if (!article) return;

  const title = typeof req.body?.title === 'string' ? req.body.title : article.title;
  const section = typeof req.body?.section === 'string' ? req.body.section : article.section;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const contentHtml = textToParagraphHtml(text);

  writeBack(id, { title, section, contentHtml });

  // No bloquea el guardado — un borrador siempre debe poder guardarse tal
  // como está — pero avisa si el texto pegado parece JSON/markup en vez de
  // prosa, para que un humano lo note antes de mandarlo a Revisión.
  const warning = looksLikeStructuredPaste(text)
    ? 'El texto pegado parece JSON o HTML en crudo, no prosa. Revisar antes de enviar a Revisión.'
    : undefined;

  res.json({ success: true, ...(warning ? { warning } : {}) });
}));

// ── API: enviar a Edición (En Progreso → Edición) ─────────────────────────────
//
// Sin gate — mandar un artículo a reescribir siempre debe poder hacerse,
// esté como esté. No toca SPIP ni spipArticleId.

app.post('/api/articles/:id/send-to-edicion', asyncHandler('POST /api/articles/:id/send-to-edicion', async (req, res) => {
  const { id } = req.params;
  if (!loadArticleOr404(id, res)) return;

  sendToEdicion(id);
  res.json({ success: true, workflowStatus: 'edicion' });
}));

// ── API: enviar a Revisión (Edición → En Progreso) ────────────────────────────
//
// Gate mínimo: título y contenido no vacíos. No exige el schema completo —
// eso se termina de completar y se marca como error en la pestaña
// En Progreso, igual que con cualquier otro artículo incompleto.

app.post('/api/articles/:id/send-to-revision', asyncHandler('POST /api/articles/:id/send-to-revision', async (req, res) => {
  const { id } = req.params;
  const article = loadArticleOr404(id, res);
  if (!article) return;

  if (!article.title?.trim() || !article.contentHtml?.trim() || !article.section?.trim()) {
    return res.status(422).json({
      error: 'El artículo necesita título, sección y contenido antes de pasar a revisión.',
    });
  }

  // Splitter heurístico (docs/IMPROVE_STEPS.md, Paso 2): corre una sola vez,
  // acá, en la transición — no en cada lectura. Nunca pisa un campo que el
  // artículo ya tenga (p.ej. tras un demote + edición manual previa): el
  // splitter solo llena huecos, la corrección humana previa siempre gana.
  const { chapo, contentHtml, ps, guessed } = splitContentIntoFields(article.contentHtml);
  writeBack(id, {
    chapo,
    contentHtml,
    ps,
    ...(guessed.sourceUrl && !article.sourceUrl ? { sourceUrl: guessed.sourceUrl } : {}),
    ...(guessed.sourceSite && !article.sourceSite ? { sourceSite: guessed.sourceSite } : {}),
    ...(guessed.sourceDate && !article.sourceDate ? { sourceDate: guessed.sourceDate } : {}),
    ...(guessed.author && !article.author ? { author: guessed.author } : {}),
  });

  sendToRevision(id);
  res.json({ success: true, workflowStatus: 'en-progreso' });
}));

// ── API: guardar campos estructurados (En Progreso) ───────────────────────────
//
// A diferencia de /draft, los campos llegan ya separados (los dejó el
// formulario de En Progreso) — no corre textToParagraphHtml() ni el
// splitter de nuevo. Sin gate de validación: guardar siempre debe poder
// hacerse, aunque el artículo no sea válido todavía (ese gate vive en
// /promote). Solo copia las claves que vienen en el body y son conocidas.

const FIELDS_EDITABLE_KEYS = [
  'chapo', 'contentHtml', 'ps', 'topics', 'date',
  'author', 'sourceSite', 'sourceUrl', 'sourceDate',
];

app.put('/api/articles/:id/fields', asyncHandler('PUT /api/articles/:id/fields', async (req, res) => {
  const { id } = req.params;
  if (!loadArticleOr404(id, res)) return;

  const body = req.body ?? {};
  const patch = {};
  for (const key of FIELDS_EDITABLE_KEYS) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  writeBack(id, patch);
  res.json({ success: true });
}));

// ── API: publicar artículo ────────────────────────────────────────────────────

app.post('/api/articles/:id/publish', asyncHandler('POST /api/articles/:id/publish', async (req, res) => {
  const { id } = req.params;

  // Quick guard before acquiring the lock
  const article = loadArticleOr404(id, res);
  if (!article) return;
  if (article.spipArticleId) {
    return res.status(409).json({
      error:         'Artículo ya publicado',
      spipArticleId: article.spipArticleId,
      publishedAt:   article.publishedAt,
      publishedUrl:  article.publishedUrl,
    });
  }

  // In-memory lock — sufficient for single-process deployment
  if (publishingInProgress.has(id)) {
    return res.status(409).json({ error: 'Publicación en curso para este artículo' });
  }
  publishingInProgress.add(id);

  try {
    const dryRun = req.body?.dryRun === true;

    console.log(`[publish] "${article.title}" (id=${id}, dryRun=${dryRun})`);

    // Re-read from disk after lock (double-check). Kept as a manual lookup
    // (not loadArticleOr404) because these two checks carry "(post-lock)" in
    // their messages, distinct from the pre-lock guard above — useful signal
    // for telling the two guards apart when debugging a race.
    const fresh = loadArticle(id);
    if (!fresh) return res.status(404).json({ error: 'Artículo no encontrado (post-lock)' });
    if (fresh.spipArticleId) {
      return res.status(409).json({ error: 'Artículo ya publicado (post-lock)', spipArticleId: fresh.spipArticleId });
    }

    const result = await publishArticleUseCase(fresh, { dryRun });

    switch (result.status) {
      case 'already-published':
        return res.status(409).json({ error: 'Artículo ya publicado', ...result });

      case 'invalid':
        return res.status(422).json({ error: result.validationError });

      case 'dry-run':
        return res.json({ success: true, dryRun: true, unimplementedFields: result.unimplementedFields });

      case 'published':
        return res.json({
          success:             true,
          spipArticleId:       result.spipArticleId,
          publishedAt:         result.publishedAt,
          publishedUrl:        result.publishedUrl,
          unimplementedFields: result.unimplementedFields,
        });

      case 'published-no-writeback':
        return res.status(207).json({
          success:         true,
          writeBackFailed: true,
          message:         'Artículo publicado en SPIP pero el write-back al JSON falló. Ver audit log.',
          recoverCommand:  result.recoverCommand,
          spipArticleId:   result.spipArticleId,
          publishedAt:     result.publishedAt,
          publishedUrl:    result.publishedUrl,
        });

      // These statuses can only occur if validateOnly/recoverFromLog are ever
      // wired up to this endpoint. Handle them explicitly rather than let them
      // fall through to a misleading 500.
      case 'valid':
        return res.json({ success: true, valid: true, unimplementedFields: result.unimplementedFields });

      case 'recovered':
        return res.json({
          success:         true,
          recovered:       true,
          spipArticleId:   result.spipArticleId,
          publishedAt:     result.publishedAt,
          publishedUrl:    result.publishedUrl,
          writeBackFailed: result.writeBackFailed ?? false,
        });

      case 'recover-not-found':
        return res.status(404).json({ error: `No se encontró entrada en el audit log para "${result.articleId}"` });

      case 'error':
        return res.status(500).json({ error: result.error ?? 'Error desconocido' });

      default:
        console.error(`[publish] Estado inesperado del use case: ${result.status}`);
        return res.status(500).json({ error: `Estado inesperado: ${result.status}` });
    }
  } finally {
    publishingInProgress.delete(id);
  }
}));

// ── API: gestión del sitio SPIP (/api/site/*) ────────────────────────────────
//
// Completamente desacoplada del pipeline editorial (/api/articles/*).
// Importa solo spip-admin.mjs — nunca articles-store, article-validator,
// publish-use-case ni text-to-html.
//
// Estas rutas son el backend de la pestaña "Sitio" del dashboard.
// Cualquier nueva operación de administración del sitio SPIP
// (despublicar, archivar, cambiar rubrique, etc.) se añade aquí.

// Import lazy — spip-admin arrastra Playwright; no cargarlo al arrancar el server.
let _spipAdmin = null;
async function getSpipAdmin() {
  if (!_spipAdmin) _spipAdmin = await import('./lib/spip-admin.mjs');
  return _spipAdmin;
}

// GET /api/site/article/:spipId/status — inspecciona el estado en SPIP
app.get('/api/site/article/:spipId/status', asyncHandler('GET /api/site/article/:spipId/status', async (req, res) => {
  const { spipId } = req.params;
  const { inspectArticleStatus } = await getSpipAdmin();
  const result = await inspectArticleStatus(spipId);
  res.json({ success: true, ...result });
}));

// POST /api/site/article/:spipId/status — cambia el estado en SPIP
// Body: { status: 'poubelle' | 'prepa' | 'prop' | 'publie' | 'refuse', dryRun?: boolean }
app.post('/api/site/article/:spipId/status', asyncHandler('POST /api/site/article/:spipId/status', async (req, res) => {
  const { spipId } = req.params;
  const { status, dryRun = false } = req.body ?? {};

  if (!status) {
    return res.status(400).json({ error: 'Se requiere el campo "status" en el body.' });
  }

  // Gate de seguridad: publicar directamente requiere flag explícito
  if (status === 'publie' && !req.body.approvePublishing) {
    return res.status(403).json({
      error: 'Publicar directamente requiere "approvePublishing: true" en el body.',
    });
  }

  const { changeArticleStatus, VALID_SPIP_STATUSES } = await getSpipAdmin();
  if (!VALID_SPIP_STATUSES[status]) {
    return res.status(400).json({
      error: `Estado inválido "${status}". Válidos: ${Object.keys(VALID_SPIP_STATUSES).join(', ')}`,
    });
  }
  const result = await changeArticleStatus(spipId, status, { dryRun });
  res.json({ success: true, ...result });
}));

// POST /api/site/article/:spipId/delete — borrado permanente desde la papelera
// Body: { dryRun?: boolean }
// El artículo DEBE estar en "poubelle" antes de llamar a este endpoint.
app.post('/api/site/article/:spipId/delete', asyncHandler('POST /api/site/article/:spipId/delete', async (req, res) => {
  const { spipId } = req.params;
  const { dryRun = false } = req.body ?? {};

  const { permanentlyDelete } = await getSpipAdmin();
  const result = await permanentlyDelete(spipId, { dryRun });
  if (result.success) {
    return res.json({ success: true, dryRun: result.dryRun ?? false });
  }
  res.status(500).json({
    error: `El artículo ${spipId} sigue en la papelera tras el intento de borrado.`,
  });
}));

// GET /api/site/audit-report — cruce audit log ↔ archivos locales (sin Playwright)
// Con ?verify=true, comprueba en SPIP si los IDs duplicados sobrantes siguen vivos.
app.get('/api/site/audit-report', asyncHandler('GET /api/site/audit-report', async (req, res) => {
  const { auditLogReport } = await getSpipAdmin();
  const report = auditLogReport();

  if (req.query.verify === 'true' && report.duplicates?.length) {
    const { verifyDuplicatesInSpip } = await getSpipAdmin();
    // Observación efímera, solo lectura — no escribe nada en el audit log.
    // Ver src/lib/spip-admin.mjs para el porqué (falsos positivos transitorios
    // no deben convertirse en registros permanentes sin revisión humana).
    report.duplicates = await verifyDuplicatesInSpip(report.duplicates);
    report.verified = true;
  }

  res.json({ success: true, report });
}));

// POST /api/site/duplicates/:spipId/confirm-deleted — confirma manualmente que
// un ID marcado "no existe en SPIP" por la verificación fue realmente borrado
// externamente. Única vía que persiste esa observación (pasa por guardedWrite
// en confirmExternalDeletion) — nunca se dispara automáticamente.
app.post('/api/site/duplicates/:spipId/confirm-deleted', asyncHandler('POST /api/site/duplicates/:spipId/confirm-deleted', async (req, res) => {
  const { spipId } = req.params;
  const { confirmExternalDeletion } = await getSpipAdmin();
  const result = await confirmExternalDeletion(spipId);
  res.json({ success: true, ...result });
}));

// POST /api/articles/:id/recover — expone --recover-from-log como llamada de API
// Escribe spipArticleId de vuelta en el JSON cuando el write-back falló antes.
app.post('/api/articles/:id/recover', asyncHandler('POST /api/articles/:id/recover', async (req, res) => {
  const { id } = req.params;
  const article = loadArticleOr404(id, res);
  if (!article) return;

  if (article.spipArticleId) {
    return res.status(409).json({
      error:         'El artículo ya tiene spipArticleId. No se necesita recuperación.',
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
}));

// ── SPA fallback — sirve index.html para cualquier ruta no-API ────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Export (for tests) + conditional listen ───────────────────────────────────
// Export `app` so test/server.test.mjs can import it and spin up an
// http.Server on a random port without touching the network in production.
// `app.listen()` only runs when this module is the direct entry point.

export { app };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  app.listen(PORT, () => {
    console.log(`\n🗞️  Kilombo Dashboard`);
    console.log(`   http://localhost:${PORT}\n`);
  });
}
