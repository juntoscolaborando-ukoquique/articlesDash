/**
 * src/lib/publish-use-case.mjs
 *
 * Orquestación pura del flujo de publicación de un artículo en SPIP.
 * No contiene lógica de presentación ni llamadas a process.exit().
 * Puede ser invocada tanto desde el CLI (publish-article.mjs) como
 * desde el servidor Express (server.mjs) sin ninguna adaptación.
 *
 * FLUJO:
 *   1. Chequeo de idempotencia (spipArticleId en el JSON)
 *   2. Recuperación desde el audit log (--recover-from-log / recoverFromLog)
 *   3. Validación del schema
 *   4. Aviso de campos no implementados
 *   5. Publicación via SPIPClient
 *   6. Write-back atómico al JSON (con un reintento automático)
 *
 * RESULTADOS (campo `status`):
 *   'already-published' — el artículo ya tiene spipArticleId en el JSON
 *   'recovered'         — se recuperó el spipArticleId del audit log
 *   'recover-not-found' — --recover-from-log pero no hay entrada en el log
 *   'invalid'           — el schema no es válido
 *   'dry-run'           — publicación simulada completada
 *   'published'         — publicado y write-back exitoso
 *   'published-no-writeback' — publicado pero write-back falló (ver auditLog)
 *   'error'             — error inesperado durante la publicación
 *
 * @module publish-use-case
 */

import { assertValidArticle } from './article-validator.mjs';
import { findSuccessEntry } from './live-write-gateway.mjs';
import { writeBack, writeBackToFile } from './articles-store.mjs';

// ── Use case ──────────────────────────────────────────────────────────────────

/**
 * Ejecuta el flujo completo de publicación de un artículo.
 *
 * @param {object} article        - objeto artículo ya cargado y parseado
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.recoverFromLog=false]
 * @param {boolean} [options.validateOnly=false]
 *
 * @returns {Promise<{
 *   status: string,
 *   article?: object,
 *   spipArticleId?: string,
 *   publishedAt?: string,
 *   publishedUrl?: string,
 *   unimplementedFields?: string[],
 *   validationError?: string,
 *   writeBackFailed?: boolean,
 *   writeBackError?: string,
 *   recoverCommand?: string,
 *   error?: string,
 * }>}
 */
export async function publishArticleUseCase(article, options = {}) {
  const { dryRun = false, recoverFromLog = false, validateOnly = false, absolutePath } = options;

  // ── 1. Chequeo de idempotencia ──────────────────────────────────────────
  if (article.spipArticleId) {
    return {
      status:       'already-published',
      spipArticleId: article.spipArticleId,
      publishedAt:   article.publishedAt ?? null,
      publishedUrl:  article.publishedUrl ?? null,
    };
  }

  // ── 2. Recuperación desde el audit log ───────────────────────────────────
  if (recoverFromLog) {
    const entry = findSuccessEntry('article.create', article.id);
    if (!entry) {
      return { status: 'recover-not-found', articleId: article.id };
    }
    const fields = {
      spipArticleId: entry.articleId,
      publishedAt:   entry.publishedAt,
      publishedUrl:  entry.url,
    };
    try {
      if (absolutePath) {
        writeBackToFile(absolutePath, fields);
      } else {
        writeBack(article.id, fields);
      }
      return {
        status:        'recovered',
        spipArticleId: entry.articleId,
        publishedAt:   entry.publishedAt,
        publishedUrl:  entry.url,
      };
    } catch (writeErr) {
      return {
        status:            'recovered',
        spipArticleId:     entry.articleId,
        publishedAt:       entry.publishedAt,
        publishedUrl:      entry.url,
        writeBackFailed:   true,
        writeBackError:    writeErr.message,
      };
    }
  }

  // ── 3. Validación del schema ─────────────────────────────────────────────
  try {
    assertValidArticle(article);
  } catch (err) {
    return { status: 'invalid', validationError: err.message };
  }

  // ── 4. Campos no implementados ───────────────────────────────────────────
  // Import lazy: spip-client.mjs arrastra Playwright; no cargarlo en validate-only
  const { getUnimplementedFields } = await import('./spip-client.mjs');
  const unimplementedFields = getUnimplementedFields(article);

  if (validateOnly) {
    return { status: 'valid', unimplementedFields };
  }

  // ── 5. Publicar ──────────────────────────────────────────────────────────
  let result;
  try {
    const { SPIPClient } = await import('./spip-client.mjs');
    const client = new SPIPClient();
    result = await client.publishArticle(article, { dryRun });
  } catch (err) {
    return { status: 'error', error: err.message, unimplementedFields };
  }

  if (!result.success) {
    return { status: 'error', error: result.error ?? 'SPIPClient devolvió success=false', unimplementedFields };
  }

  if (dryRun) {
    return { status: 'dry-run', unimplementedFields };
  }

  // ── 6. Write-back ────────────────────────────────────────────────────────
  // Computar timestamp una sola vez para usar tanto en el write-back como en la respuesta
  const publishedAt = new Date().toISOString();

  const fields = {
    spipArticleId: result.articleId,
    publishedAt,   // reuse the same timestamp
    publishedUrl:  result.url ?? null,
  };

  // Use articles-store's writeBack (atomic temp+rename, centralized file I/O)
  const writeBackOnce = () => {
    if (absolutePath) {
      writeBackToFile(absolutePath, fields);
    } else {
      writeBack(article.id, fields);
    }
  };

  try {
    writeBackOnce();
  } catch (firstErr) {
    // Un reintento — a veces es un lock transitorio del FS
    try {
      writeBackOnce();
    } catch (retryErr) {
      return {
        status:          'published-no-writeback',
        spipArticleId:   result.articleId,
        publishedAt, // same timestamp computed once above
        publishedUrl:    result.url ?? null,
        writeBackFailed: true,
        writeBackError:  retryErr.message,
        recoverCommand:  `node src/publish-article.mjs articles/${article.id}.json --recover-from-log`,
        unimplementedFields,
      };
    }
  }

  return {
    status:        'published',
    spipArticleId: result.articleId,
    publishedAt, // reuse the same timestamp
    publishedUrl:  result.url ?? null,
    unimplementedFields,
  };
}
