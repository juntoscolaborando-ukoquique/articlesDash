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

import { assertValidArticle, getUnimplementedFields } from './article-validator.mjs';
import { findSuccessEntry } from './live-write-gateway.mjs';
import { writeBack, writeBackToFile, findArticleAbsolutePath } from './articles-store.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITEBACK_FAIL_LOG = path.join(__dirname, '..', '..', 'writeback-failures.log.jsonl');

/**
 * Registra de forma durable un fallo de write-back en un archivo JSONL separado.
 * No lanza — si este log falla también, al menos el audit log ya tiene la entrada.
 */
function logWriteBackFailure(articleId, spipArticleId, publishedAt, error) {
  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      articleId,
      spipArticleId,
      publishedAt,
      error: error?.message ?? String(error),
    });
    fs.appendFileSync(WRITEBACK_FAIL_LOG, entry + '\n', 'utf8');
  } catch (_) {
    // silencioso — el audit log ya tiene la evidencia
  }
}

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
  const {
    dryRun = false,
    recoverFromLog = false,
    validateOnly = false,
    absolutePath,
    // Test seam: pass a pre-constructed SPIPClient instance to avoid loading
    // Playwright in unit tests. Never set this in production code.
    _spipClient,
    // Test seams for I/O — default to the real implementations.
    _findSuccessEntry     = findSuccessEntry,
    _writeBack            = writeBack,
    _writeBackToFile      = writeBackToFile,
    // Test seam: intercepts the durable failure log written when write-back
    // fails twice. Without this seam, tests that exercise that path (e.g.
    // "devuelve published-no-writeback si el write-back falla dos veces")
    // append real entries to writeback-failures.log.jsonl on every run.
    _logWriteBackFailure  = logWriteBackFailure,
  } = options;

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
    const entry = _findSuccessEntry('article.create', article.id);
    if (!entry) {
      return { status: 'recover-not-found', articleId: article.id };
    }
    const fields = {
      spipArticleId:  entry.articleId,
      publishedAt:    entry.publishedAt,
      publishedUrl:   entry.url,
      workflowStatus: 'terminado', // mismo criterio que el path de éxito normal (línea ~174)
    };
    try {
      if (absolutePath) {
        _writeBackToFile(absolutePath, fields);
      } else {
        _writeBack(article.id, fields);
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
  // getUnimplementedFields vive en article-validator.mjs (sin Playwright),
  // importado estáticamente arriba — --validate-only no necesita spip-client.
  const unimplementedFields = getUnimplementedFields(article);

  if (validateOnly) {
    return { status: 'valid', unimplementedFields };
  }

  // ── 5. Publicar ──────────────────────────────────────────────────────────
  let result;
  try {
    const client = _spipClient ?? (() => {
      // Dynamic import keeps Playwright out of --validate-only and test paths
      return import('./spip-client.mjs').then(({ SPIPClient }) => new SPIPClient());
    })();
    // client is either the injected stub or a Promise — resolve uniformly
    const resolved = await (client instanceof Promise ? client : Promise.resolve(client));
    result = await resolved.publishArticle(article, { dryRun });
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
    spipArticleId:  result.articleId,
    publishedAt,    // reuse the same timestamp
    publishedUrl:   result.url ?? null,
    workflowStatus: 'terminado', // publicado siempre termina en Terminado
  };

  // Use articles-store's writeBack (atomic temp+rename, centralized file I/O)
  const writeBackOnce = () => {
    if (absolutePath) {
      _writeBackToFile(absolutePath, fields);
    } else {
      _writeBack(article.id, fields);
    }
  };

  try {
    writeBackOnce();
  } catch (firstErr) {
    // Un reintento — a veces es un lock transitorio del FS
    try {
      writeBackOnce();
    } catch (retryErr) {
      // El id del artículo no siempre coincide con el nombre del archivo
      // (ver CHANGELOG 1.3.0 — example-article.json / fauci-fusible-controlado),
      // así que no se puede asumir `articles/${id}.json`. Se busca la ruta real
      // por contenido (findArticleAbsolutePath ya hace el mismo escaneo que
      // writeBack); si el propio escaneo no la encuentra, se avisa en vez de
      // imprimir un comando roto.
      const realPath = absolutePath ?? findArticleAbsolutePath(article.id);
      const recoverCommand = realPath
        ? `node src/publish-article.mjs ${realPath} --recover-from-log`
        : `(no se encontró el archivo del artículo "${article.id}" para sugerir el comando — ` +
          `buscar manualmente en articles/ y correr --recover-from-log sobre esa ruta)`;

      // Log durable — independiente del toast del browser, que puede perderse.
      _logWriteBackFailure(article.id, result.articleId, publishedAt, retryErr);

      return {
        status:          'published-no-writeback',
        spipArticleId:   result.articleId,
        publishedAt, // same timestamp computed once above
        publishedUrl:    result.url ?? null,
        writeBackFailed: true,
        writeBackError:  retryErr.message,
        recoverCommand,
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
