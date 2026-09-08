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
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  listArticles,
  loadArticle,
  writeBack,
  createDraftArticle,
  demoteToEnProgreso,
  promoteToTerminado,
  sendToEdicion,
  sendToRevision,
} from './lib/articles-store.mjs';
import { validateArticle } from './lib/article-validator.mjs';
import { publishArticleUseCase } from './lib/publish-use-case.mjs';
import { textToParagraphHtml, looksLikeStructuredPaste } from './lib/text-to-html.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR    = path.join(__dirname, '..', 'public');
const AUDIT_LOG     = path.join(__dirname, '..', 'live-write-audit.log.jsonl');

/**
 * Escribe una entrada article.delete.permanent en el audit log local para un
 * ID que verificación en vivo confirmó que ya no existe en SPIP. No requiere
 * Playwright — es solo un append al log para que futuros reloads lo filtren.
 *
 * Idempotente: si ya existe una entrada de borrado permanente para este ID
 * en el log, no escribe nada.
 */
function logExternalDeletion(spipId) {
  try {
    // Idempotency check — no escribir si ya hay una entrada de borrado para este ID
    if (fs.existsSync(AUDIT_LOG)) {
      const existing = fs.readFileSync(AUDIT_LOG, 'utf8');
      const alreadyLogged = existing.split('\n').some((line) => {
        try {
          const e = JSON.parse(line);
          return e.action === 'article.delete.permanent' &&
                 String(e.target?.id) === String(spipId);
        } catch { return false; }
      });
      if (alreadyLogged) return;
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action:    'article.delete.permanent',
      script:    'server.mjs/verify',
      target:    { id: String(spipId) },
      dryRun:    false,
      result:    'success',
      note:      'Confirmado ausente en SPIP por verificación activa — borrado externamente.',
    });
    fs.appendFileSync(AUDIT_LOG, entry + '\n', 'utf8');
  } catch (_) { /* silencioso */ }
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 3000;

// ── In-memory publish lock ────────────────────────────────────────────────────
// Single-process guard. Sufficient for a single-user local tool.
// If ever deployed with multiple replicas, replace with Redis SETNX.

const publishingInProgress = new Set();

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── API: lista de artículos ───────────────────────────────────────────────────

app.get('/api/articles', (_req, res) => {
  try {
    const articles = listArticles();
    res.json({ articles });
  } catch (err) {
    console.error('[GET /api/articles]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: crear artículo nuevo (borrador vacío en Edición) ────────────────────
//
// "Nuevo artículo" del dashboard. Sin gate de validación — un borrador
// recién nacido nunca es válido y no tiene por qué serlo.

app.post('/api/articles', (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const article = createDraftArticle({ title });
    return res.status(201).json({ article });
  } catch (err) {
    console.error('[POST /api/articles]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: detalle de artículo ──────────────────────────────────────────────────

app.get('/api/articles/:id', (req, res) => {
  try {
    const article = loadArticle(req.params.id);
    if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });
    res.json({ article });
  } catch (err) {
    console.error('[GET /api/articles/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: desaprobar artículo (Terminado → En Progreso) ────────────────────────
//
// Sin gate de validación — mandar un artículo a "en-progreso" siempre debe
// poder hacerse, esté válido o no. No toca SPIP ni spipArticleId.

app.post('/api/articles/:id/demote', (req, res) => {
  const { id } = req.params;
  try {
    const article = loadArticle(id);
    if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

    demoteToEnProgreso(id);
    return res.json({ success: true, workflowStatus: 'en-progreso' });
  } catch (err) {
    console.error('[POST /api/articles/:id/demote]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: aprobar artículo (En Progreso → Terminado) ───────────────────────────
//
// Gateado por validateArticle: solo se puede aprobar si el artículo es válido.
// No toca SPIP ni spipArticleId.

app.post('/api/articles/:id/promote', (req, res) => {
  const { id } = req.params;
  try {
    const article = loadArticle(id);
    if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

    const errors = validateArticle(article);
    if (errors.length > 0) {
      return res.status(422).json({
        error: 'El artículo no pasa la validación y no puede ser aprobado.',
        validationErrors: errors,
      });
    }
    promoteToTerminado(id);
    return res.json({ success: true, workflowStatus: 'terminado' });
  } catch (err) {
    console.error('[POST /api/articles/:id/promote]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: guardar borrador (título + texto libre) mientras está en Edición ────
//
// Recibe texto plano (lo que el usuario escribió/pegó) y lo convierte acá,
// de forma centralizada, en el HTML restringido que exige contentHtml.
// No toca workflowStatus — guardar nunca cambia de etapa.

app.put('/api/articles/:id/draft', (req, res) => {
  const { id } = req.params;
  try {
    const article = loadArticle(id);
    if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

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

    return res.json({ success: true, ...(warning ? { warning } : {}) });
  } catch (err) {
    console.error('[PUT /api/articles/:id/draft]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: enviar a Edición (En Progreso → Edición) ─────────────────────────────
//
// Sin gate — mandar un artículo a reescribir siempre debe poder hacerse,
// esté como esté. No toca SPIP ni spipArticleId.

app.post('/api/articles/:id/send-to-edicion', (req, res) => {
  const { id } = req.params;
  try {
    const article = loadArticle(id);
    if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

    sendToEdicion(id);
    return res.json({ success: true, workflowStatus: 'edicion' });
  } catch (err) {
    console.error('[POST /api/articles/:id/send-to-edicion]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: enviar a Revisión (Edición → En Progreso) ────────────────────────────
//
// Gate mínimo: título y contenido no vacíos. No exige el schema completo —
// eso se termina de completar y se marca como error en la pestaña
// En Progreso, igual que con cualquier otro artículo incompleto.

app.post('/api/articles/:id/send-to-revision', (req, res) => {
  const { id } = req.params;
  try {
    const article = loadArticle(id);
    if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

    if (!article.title?.trim() || !article.contentHtml?.trim() || !article.section?.trim()) {
      return res.status(422).json({
        error: 'El artículo necesita título, sección y contenido antes de pasar a revisión.',
      });
    }

    sendToRevision(id);
    return res.json({ success: true, workflowStatus: 'en-progreso' });
  } catch (err) {
    console.error('[POST /api/articles/:id/send-to-revision]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: publicar artículo ────────────────────────────────────────────────────

app.post('/api/articles/:id/publish', async (req, res) => {
  const { id } = req.params;

  // Quick guard before acquiring the lock
  const article = loadArticle(id);
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });
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

    // Re-read from disk after lock (double-check)
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

  } catch (err) {
    console.error(`[publish] ❌ Error inesperado:`, err);
    return res.status(500).json({ error: err.message });
  } finally {
    publishingInProgress.delete(id);
  }
});

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
app.get('/api/site/article/:spipId/status', async (req, res) => {
  const { spipId } = req.params;
  try {
    const { inspectArticleStatus } = await getSpipAdmin();
    const result = await inspectArticleStatus(spipId);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[GET /api/site/article/${spipId}/status]`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/site/article/:spipId/status — cambia el estado en SPIP
// Body: { status: 'poubelle' | 'prepa' | 'prop' | 'publie' | 'refuse', dryRun?: boolean }
app.post('/api/site/article/:spipId/status', async (req, res) => {
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

  try {
    const { changeArticleStatus, VALID_SPIP_STATUSES } = await getSpipAdmin();
    if (!VALID_SPIP_STATUSES[status]) {
      return res.status(400).json({
        error: `Estado inválido "${status}". Válidos: ${Object.keys(VALID_SPIP_STATUSES).join(', ')}`,
      });
    }
    const result = await changeArticleStatus(spipId, status, { dryRun });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[POST /api/site/article/${spipId}/status]`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/site/article/:spipId/delete — borrado permanente desde la papelera
// Body: { dryRun?: boolean }
// El artículo DEBE estar en "poubelle" antes de llamar a este endpoint.
app.post('/api/site/article/:spipId/delete', async (req, res) => {
  const { spipId } = req.params;
  const { dryRun = false } = req.body ?? {};

  try {
    const { permanentlyDelete } = await getSpipAdmin();
    const result = await permanentlyDelete(spipId, { dryRun });
    if (result.success) {
      return res.json({ success: true, dryRun: result.dryRun ?? false });
    }
    return res.status(500).json({
      error: `El artículo ${spipId} sigue en la papelera tras el intento de borrado.`,
    });
  } catch (err) {
    console.error(`[POST /api/site/article/${spipId}/delete]`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/site/audit-report — cruce audit log ↔ archivos locales (sin Playwright)
// Con ?verify=true, comprueba en SPIP si los IDs duplicados sobrantes siguen vivos.
app.get('/api/site/audit-report', async (req, res) => {
  try {
    const { auditLogReport } = await getSpipAdmin();
    const report = auditLogReport();

    if (req.query.verify === 'true' && report.duplicates?.length) {
      const { verifyDuplicates, ArticleNotFoundError } = await getSpipAdmin();

      // Collect all surplus (non-canonical) IDs across all duplicate groups
      const surplusIds = [];
      for (const dup of report.duplicates) {
        const canonical = dup.suggestedCanonical;
        for (const entry of dup.aliveEntries) {
          if (String(entry.spipArticleId) !== String(canonical)) {
            surplusIds.push(String(entry.spipArticleId));
          }
        }
      }

      // One Playwright session for all checks — login once, navigate per entry
      const verifyMap = await verifyDuplicates(surplusIds);

      // Apply results back to each duplicate group
      for (const dup of report.duplicates) {
        const canonical = dup.suggestedCanonical;
        const verified  = [];
        for (const entry of dup.aliveEntries) {
          const id = String(entry.spipArticleId);
          if (id === String(canonical)) {
            verified.push({ ...entry, spipExists: true });
            continue;
          }
          const check = verifyMap.get(id);
          if (check?.exists === false) {
            // Confirmed gone — write to log (idempotent)
            logExternalDeletion(id);
            verified.push({ ...entry, spipExists: false });
          } else if (check?.exists === true) {
            verified.push({ ...entry, spipExists: true });
          } else {
            // null — couldn't verify (timeout, nav error, etc.)
            console.warn(`[verify] No se pudo verificar SPIP #${id}: ${check?.error ?? 'desconocido'}`);
            verified.push({ ...entry, spipExists: null, verifyError: check?.error });
          }
        }
        dup.aliveEntries   = verified;
        dup.verifiedInSpip = true;
        // Resolved only if ALL surplus IDs are confirmed gone (false), not unverifiable (null)
        const stillAlive = verified.filter(
          (e) => String(e.spipArticleId) !== String(canonical) && e.spipExists !== false
        );
        dup.resolvedInSpip = stillAlive.length === 0;
      }
      report.verified = true;
    }

    return res.json({ success: true, report });
  } catch (err) {
    console.error('[GET /api/site/audit-report]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/articles/:id/recover — expone --recover-from-log como llamada de API
// Escribe spipArticleId de vuelta en el JSON cuando el write-back falló antes.
app.post('/api/articles/:id/recover', async (req, res) => {
  const { id } = req.params;

  const article = loadArticle(id);
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  if (article.spipArticleId) {
    return res.status(409).json({
      error:         'El artículo ya tiene spipArticleId. No se necesita recuperación.',
      spipArticleId: article.spipArticleId,
    });
  }

  try {
    const result = await publishArticleUseCase(article, { recoverFromLog: true });
    switch (result.status) {
      case 'recovered':
        return res.json({ success: true, ...result });
      case 'recover-not-found':
        return res.status(404).json({ error: `No hay entrada en el audit log para "${id}"` });
      default:
        return res.status(500).json({ error: `Estado inesperado: ${result.status}` });
    }
  } catch (err) {
    console.error(`[POST /api/articles/${id}/recover]`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback — sirve index.html para cualquier ruta no-API ────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🗞️  Kilombo Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});
