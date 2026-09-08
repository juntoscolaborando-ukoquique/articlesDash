/**
 * src/lib/spip-admin.mjs
 *
 * Biblioteca de operaciones de administración del sitio SPIP en kilombo.top.
 * Cubre acciones sobre artículos ya publicados: cambio de estado y borrado
 * permanente.
 *
 * DISEÑO:
 *   - Toda operación usa withSpipSession() (ciclo de vida del browser centralizado)
 *   - Toda mutación pasa por guardedWrite() (audit log + política centralizada)
 *   - No importa nada del pipeline editorial (articles-store, article-validator,
 *     publish-use-case). Es una capa independiente sobre spip-session y gateway.
 *   - Los CLI scripts (manage-article-status.mjs, permanently-delete-article.mjs)
 *     son adaptadores delgados que llaman a estas funciones.
 *   - server.mjs puede importar estas funciones para exponer endpoints /api/site/*
 *     sin mezclar código de gestión del sitio con el pipeline editorial.
 *
 * FUNCIONES EXPORTADAS:
 *   changeArticleStatus(spipId, targetStatus, { dryRun?, inspectOnly? })
 *   permanentlyDelete(spipId, { dryRun? })
 *   inspectArticleStatus(spipId)
 *   auditLogReport()
 *
 * ESTADOS SPIP VÁLIDOS:
 *   prepa    — En curso de redacción
 *   prop     — Propuesto a evaluación
 *   publie   — Publicado
 *   refuse   — Rechazado
 *   poubelle — A la papelera (necesario antes del borrado permanente)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guardedWrite } from './live-write-gateway.mjs';
import { withSpipSession, BASE_URL, DEFAULT_ENV_PATH } from './spip-session.mjs';
import { listArticles } from './articles-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const AUDIT_LOG_PATH = path.join(PROJECT_ROOT, 'live-write-audit.log.jsonl');

/**
 * Error específico para cuando un artículo no existe en SPIP.
 * Distingue "genuinamente borrado" de otros fallos de Playwright
 * (timeout, login failure, red caída) que no deben tratarse como borrado.
 */
export class ArticleNotFoundError extends Error {
  constructor(spipId) {
    super(`Artículo ${spipId} no encontrado en SPIP (widget de estado ausente)`);
    this.name = 'ArticleNotFoundError';
    this.spipId = spipId;
  }
}

export const VALID_SPIP_STATUSES = {
  prepa:    'En curso de redacción',
  prop:     'Propuesto a evaluación',
  publie:   'Publicado',
  refuse:   'Rechazado',
  poubelle: 'A la papelera',
};

// ── Helpers de DOM (ejecutan en contexto de Playwright) ───────────────────────

/**
 * Lee el estado actual y las opciones disponibles del widget de estado de SPIP.
 * Ejecuta enteramente en el contexto del navegador vía page.evaluate().
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ currentStatus: string, availableOptions: Array<{value,label,checked}> } | { error: string }>}
 */
async function readStatusWidget(page) {
  return page.evaluate(() => {
    const statusBox = document.querySelector('.statut_actuel');
    if (!statusBox) return { error: 'Widget de estado no encontrado en la página', notFound: true };

    const labelEl = statusBox.querySelector('.statut-label');
    const currentStatus = labelEl ? labelEl.textContent.trim() : 'desconocido';

    // Abrir el panel de selección
    const modifyBtn = statusBox.querySelector('.btn_modifier');
    if (modifyBtn) modifyBtn.click();

    return new Promise((resolve) => {
      setTimeout(() => {
        const radios = Array.from(document.querySelectorAll('input[name="statut"]')).map((r) => ({
          value:   r.value,
          label:   document.querySelector(`label[for="${r.id}"]`)?.textContent.trim() ?? r.value,
          checked: r.checked,
        }));
        resolve({ currentStatus, availableOptions: radios });
      }, 500);
    });
  });
}

/**
 * Selecciona un estado por su valor y hace click en el botón Cambiar.
 * Retorna { success, finalStatus?, error? }.
 *
 * @param {import('playwright').Page} page
 * @param {string} targetStatus
 * @param {boolean} dryRun
 */
async function applyStatusChange(page, targetStatus, dryRun) {
  if (dryRun) {
    return { success: true, dryRun: true };
  }

  let dialogAccepted = false;
  page.on('dialog', async (dialog) => {
    dialogAccepted = true;
    await dialog.accept();
  });

  // Abrir el panel de selección
  const changeButton = await page.$('.statut_actuel .btn_modifier');
  if (!changeButton) return { success: false, error: 'Botón de cambio de estado no encontrado' };
  await changeButton.click();
  await page.waitForTimeout(600);

  // Seleccionar el radio correspondiente
  const selected = await page.evaluate((target) => {
    const radio = document.querySelector(`input[name="statut"][value="${target}"]`);
    if (!radio) return { success: false, error: `Opción "${target}" no encontrada en el formulario` };
    radio.click();
    return { success: true };
  }, targetStatus);

  if (!selected.success) return { success: false, error: selected.error };
  await page.waitForTimeout(400);

  // Confirmar el cambio
  const submitted = await page.evaluate(() => {
    const button = document.querySelector('button[name="changer"]');
    if (!button) return { success: false, error: 'Botón Cambiar no encontrado' };
    button.click();
    return { success: true };
  });

  if (!submitted.success) return { success: false, error: submitted.error };

  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);

  const finalStatus = await page.evaluate(() => {
    const label = document.querySelector('.statut-label');
    return label ? label.textContent.trim() : 'desconocido';
  });

  return { success: true, finalStatus, dialogAccepted };
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Lee el estado actual de un artículo SPIP y las opciones disponibles.
 * Solo lectura — no modifica nada.
 *
 * @param {string|number} spipId — ID numérico del artículo en SPIP
 * @returns {Promise<{ currentStatus: string, availableOptions: Array<{value,label,checked}> }>}
 * @throws si el login falla o el widget no se encuentra
 */
export async function inspectArticleStatus(spipId) {
  const targetUrl = `${BASE_URL}/ecrire/?exec=article&id_article=${spipId}`;
  return withSpipSession(
    async (page) => {
      const result = await readStatusWidget(page);
      if (result.error) {
        if (result.notFound) throw new ArticleNotFoundError(spipId);
        throw new Error(result.error);
      }
      return result;
    },
    { targetUrl, expectedUrlIncludes: 'exec=article' }
  );
}

/**
 * Verifica en una sola sesión Playwright si una lista de IDs SPIP sobrantes
 * (no canónicos) siguen existiendo en el sitio. Abre el browser una sola vez,
 * navega a cada artículo con el mismo page, y cierra la sesión al terminar.
 *
 * Retorna un Map<spipId, { exists: boolean|null, error?: string }>:
 *   exists: true  → artículo encontrado en SPIP
 *   exists: false → confirmado ausente (ArticleNotFoundError)
 *   exists: null  → no se pudo verificar (error de red, timeout, etc.)
 *
 * @param {string[]} spipIds — IDs a verificar (sin el canónico)
 * @returns {Promise<Map<string, { exists: boolean|null, error?: string }>>}
 */
export async function verifyDuplicates(spipIds) {
  if (spipIds.length === 0) return new Map();

  // Usar el primer ID como targetUrl para el login inicial
  const firstUrl = `${BASE_URL}/ecrire/?exec=article&id_article=${spipIds[0]}`;
  const results  = new Map();

  await withSpipSession(
    async (page) => {
      for (const spipId of spipIds) {
        const url = `${BASE_URL}/ecrire/?exec=article&id_article=${spipId}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(800);
          const widget = await readStatusWidget(page);
          if (widget.notFound) {
            results.set(String(spipId), { exists: false });
          } else if (widget.error) {
            results.set(String(spipId), { exists: null, error: widget.error });
          } else {
            results.set(String(spipId), { exists: true });
          }
        } catch (err) {
          // Error de navegación/timeout — no se puede confirmar ausencia
          results.set(String(spipId), { exists: null, error: err.message });
        }
      }
    },
    { targetUrl: firstUrl, expectedUrlIncludes: 'exec=article' }
  );

  return results;
}

/**
 * Cambia el estado de un artículo SPIP.
 *
 * @param {string|number} spipId — ID numérico del artículo en SPIP
 * @param {string} targetStatus — uno de VALID_SPIP_STATUSES
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{ success: boolean, finalStatus?: string, dialogAccepted?: boolean, dryRun?: boolean }>}
 * @throws si el estado no es válido, el login falla, o la operación falla
 */
export async function changeArticleStatus(spipId, targetStatus, { dryRun = false } = {}) {
  if (!VALID_SPIP_STATUSES[targetStatus]) {
    throw new Error(
      `Estado inválido "${targetStatus}". Válidos: ${Object.keys(VALID_SPIP_STATUSES).join(', ')}`
    );
  }

  const targetUrl = `${BASE_URL}/ecrire/?exec=article&id_article=${spipId}`;

  return withSpipSession(
    (page) =>
      guardedWrite({
        action: 'article.status.change',
        target: { id: String(spipId), status: targetStatus },
        dryRun,
        execute: () => applyStatusChange(page, targetStatus, dryRun),
      }),
    { targetUrl, expectedUrlIncludes: 'exec=article' }
  );
}

/**
 * Borra permanentemente un artículo que ya está en la papelera de SPIP.
 *
 * SPIP solo permite el borrado permanente desde ecrire/?exec=corbeille
 * (checkboxes elements[] + submit effacer). El artículo DEBE estar en
 * estado "poubelle" antes de llamar a esta función.
 *
 * @param {string|number} spipId — ID numérico del artículo en SPIP
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{ success: boolean, stillPresent?: boolean }>}
 * @throws si el login falla o el artículo no está en la papelera
 */
export async function permanentlyDelete(spipId, { dryRun = false } = {}) {
  // Login vía página de artículo para establecer la sesión SPIP
  const targetUrl = `${BASE_URL}/ecrire/?exec=article&id_article=${spipId}`;

  return withSpipSession(
    (page) =>
      guardedWrite({
        action: 'article.delete.permanent',
        target: { id: String(spipId) },
        dryRun,
        execute: async () => {
          // Navegar a la papelera
          await page.goto(`${BASE_URL}/ecrire/?exec=corbeille`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1500);

          const checkbox = await page.$(`input[type="checkbox"][name="elements[]"][value="${spipId}"]`);
          if (!checkbox) {
            throw new Error(
              `Artículo ${spipId} no encontrado en la papelera. ` +
              `Moverlo primero a "poubelle" con changeArticleStatus(${spipId}, 'poubelle').`
            );
          }

          if (dryRun) {
            return { success: true, dryRun: true };
          }

          await page.check(`input[type="checkbox"][name="elements[]"][value="${spipId}"]`);

          page.on('dialog', async (dialog) => { await dialog.accept(); });

          await page.click('input[type="submit"][name="effacer"]');
          await page.waitForTimeout(3000);

          const stillPresent = Boolean(
            await page.$(`input[name="elements[]"][value="${spipId}"]`)
          );

          return { success: !stillPresent, stillPresent };
        },
      }),
    { targetUrl, expectedUrlIncludes: 'exec=article' }
  );
}

// ── Audit Reconciliation ──────────────────────────────────────────────────────

/**
 * Lee el audit log y los artículos locales y devuelve un informe de
 * reconciliación entre ambos. Función pura — sin Playwright, sin red.
 *
 * Categorías de retorno:
 *   ok                — un solo create SPIP vivo y el JSON local tiene el marcador
 *   writeBacksMissing — un solo create vivo pero el JSON NO tiene el marcador
 *   duplicates        — más de un create SPIP vivo para el mismo slug local
 *   orphanedMarkers   — el JSON tiene spipArticleId pero no hay create vivo que lo respalde
 *
 * IMPORTANTE (edge cases del brief):
 *   1. target.id tiene semántica distinta según la acción. Se filtra por action
 *      antes de agrupar: 'article.create' usa slug local; 'article.delete.permanent'
 *      usa ID numérico SPIP. No mezclar.
 *   2. Los duplicados tienen precedencia sobre write-backs perdidos para el mismo
 *      slug. Si un slug aparece en duplicates, no aparece en writeBacksMissing.
 *   3. Si el JSON local no tiene spipArticleId, se usa el create más reciente como
 *      "canónico sugerido" y se marca como no confirmado.
 *   4. El log es append-only. Los borrados permanentes se leen y se usa ese set
 *      para excluir IDs ya eliminados del mapa de duplicados y write-backs.
 *   5. Duplicados: se ofrecen acciones de papelera pero NO de borrado directo.
 *   6. Marcadores sin respaldo en el log (JSONs editados a mano): categoría propia.
 *
 * @returns {{
 *   ok:                Array<{slug,title,spipArticleId,loggedAt,localHasMarker,localSpipId}>,
 *   writeBacksMissing: Array<{slug,title,spipArticleId,loggedAt,localHasMarker,localSpipId}>,
 *   duplicates:        Array<{slug,title,aliveEntries,localSpipId,suggestedCanonical}>,
 *   orphanedMarkers:   Array<{id,title,spipArticleId}>,
 * }}
 */
export function auditLogReport() {
  // ── 1. Leer y parsear el log ───────────────────────────────────────────────
  let allEntries = [];
  if (fs.existsSync(AUDIT_LOG_PATH)) {
    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n');
    allEntries = lines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  // Filtrar por tipo de acción ANTES de usar target.id (semántica distinta — Punto 1)
  const creates = allEntries.filter(
    (e) => e.action === 'article.create' && e.result === 'success'
  );
  const deletes = allEntries.filter(
    (e) => e.action === 'article.delete.permanent' && e.result === 'success'
  );

  // ── 2. Set de SPIP IDs borrados permanentemente ───────────────────────────
  // Necesario para no re-mostrar duplicados ya resueltos (Punto 4)
  const permanentlyDeletedSpipIds = new Set(deletes.map((e) => String(e.target?.id)));

  // ── 3. Agrupar creates por slug, excluyendo IDs ya borrados ──────────────
  /** @type {Map<string, Array<{spipArticleId:string, loggedAt:string, title:string}>>} */
  const bySlug = new Map();
  for (const entry of creates) {
    const slug = entry.target?.id;
    if (!slug) continue;
    if (permanentlyDeletedSpipIds.has(String(entry.articleId))) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({
      slug,
      title:         entry.target?.title ?? '(sin título)',
      spipArticleId: String(entry.articleId),
      loggedAt:      entry.timestamp,
    });
  }

  // ── 4. Cargar artículos locales ───────────────────────────────────────────
  const localArticles = listArticles();
  const localById     = new Map(localArticles.map((a) => [a.id, a]));

  // ── 5. Clasificar por slug ─────────────────────────────────────────────────
  const ok                = [];
  const writeBacksMissing = [];
  const duplicates        = [];

  for (const [slug, aliveEntries] of bySlug) {
    if (aliveEntries.length === 0) continue;

    const local       = localById.get(slug);
    const localSpipId = local?.spipArticleId ?? null;

    if (aliveEntries.length > 1) {
      // DUPLICADO — más de un create vivo para el mismo slug (Punto 2)
      // Canónico sugerido: el más reciente (último del array ya que el log es cronológico)
      const suggestedCanonical = aliveEntries[aliveEntries.length - 1].spipArticleId;
      duplicates.push({
        slug,
        title:             aliveEntries[0].title,
        aliveEntries,
        localSpipId,
        // Si el JSON no tiene marcador, indicar como "sugerido, no confirmado" (Punto 3)
        suggestedCanonical: localSpipId ?? suggestedCanonical,
        suggestedIsConfirmed: !!localSpipId,
      });
    } else {
      // Un solo create vivo — OK o write-back perdido
      const entry = aliveEntries[0];
      const enriched = {
        ...entry,
        localHasMarker: !!localSpipId,
        localSpipId,
      };
      if (localSpipId) {
        ok.push(enriched);
      } else {
        writeBacksMissing.push(enriched);
      }
    }
  }

  // ── 6. Marcadores huérfanos (Punto 6) ─────────────────────────────────────
  // JSON tiene spipArticleId pero ninguna entrada de article.create viva lo respalda
  const orphanedMarkers = [];
  for (const local of localArticles) {
    if (!local.spipArticleId) continue;
    const aliveEntries = bySlug.get(local.id) ?? [];
    const hasMatchingLog = aliveEntries.some(
      (e) => String(e.spipArticleId) === String(local.spipArticleId)
    );
    if (!hasMatchingLog) {
      orphanedMarkers.push({
        id:            local.id,
        title:         local.title,
        spipArticleId: local.spipArticleId,
      });
    }
  }

  return { ok, writeBacksMissing, duplicates, orphanedMarkers };
}
