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
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

// ── SPA fallback — sirve index.html para cualquier ruta no-API ────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🗞️  Kilombo Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});
