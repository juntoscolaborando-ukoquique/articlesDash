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
 *   checkArticlesExist(spipIds)               — solo lectura, una sesión compartida
 *   verifyDuplicatesInSpip(duplicates, seams?) — orquesta checkArticlesExist sobre
 *                                                 un report.duplicates; NO escribe nada
 *   confirmExternalDeletion(spipId)            — única función que persiste una
 *                                                 "borrado externo" (pasa por guardedWrite)
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
import { listArticles } from './articles-store.mjs';

// spip-session.mjs does `import { chromium } from 'playwright'` at the top
// level. Importing it statically here would force Playwright to be installed
// even to call pure functions like auditLogReport() or to run unit tests with
// injected seams. The dynamic import below means Playwright is only resolved
// when a function that actually needs a browser is called.
let _spipSession = null;
async function getSpipSession() {
  if (!_spipSession) _spipSession = await import('./spip-session.mjs');
  return _spipSession;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const AUDIT_LOG_PATH = path.join(PROJECT_ROOT, 'live-write-audit.log.jsonl');

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
    if (!statusBox) return { error: 'Widget de estado no encontrado en la página' };

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
  const { withSpipSession, BASE_URL } = await getSpipSession();
  const targetUrl = `${BASE_URL}/ecrire/?exec=article&id_article=${spipId}`;
  return withSpipSession(
    async (page) => {
      const result = await readStatusWidget(page);
      if (result.error) throw new Error(result.error);
      return result;
    },
    { targetUrl, expectedUrlIncludes: 'exec=article' }
  );
}

/**
 * Verifica en una ÚNICA sesión SPIP (un solo login, no uno por ID) si cada
 * uno de los IDs dados sigue existiendo. Heurística: el widget de estado
 * (`.statut_actuel`) presente en la página de edición del artículo.
 *
 * IMPORTANTE — esto es un indicio, no una prueba: un cambio de layout de SPIP,
 * una carga lenta, o cualquier problema transitorio de red dan el mismo
 * resultado (`false`) que un artículo genuinamente inexistente, porque no
 * tenemos forma verificada de distinguir "objeto no encontrado" de "la página
 * no cargó bien" sin conocer el markup exacto que devuelve esta instancia de
 * SPIP en cada caso. Por eso el resultado de esta función NUNCA se escribe
 * solo — ver verifyDuplicatesInSpip() (de lectura) y confirmExternalDeletion()
 * (la única que persiste, y requiere una acción humana explícita).
 *
 * Si el login mismo falla (contraseña incorrecta, SPIP caído, etc.), la
 * excepción se propaga sin capturar — es un fallo de la sesión completa, no
 * de un ID puntual, y no debe malinterpretarse como "todos estos IDs no
 * existen".
 *
 * @param {Array<string|number>} spipIds
 * @param {object} [seams] — inyección de dependencias para tests
 * @param {Function} [seams._withSpipSession] — default: withSpipSession real
 * @returns {Promise<Map<string, boolean>>} spipId (string) → existe (boolean).
 *   Un ID cuya navegación individual falla (no el login) queda ausente del
 *   Map — "no verificado", distinto de `false` ("confirmado ausente").
 */
export async function checkArticlesExist(spipIds, { _withSpipSession, _baseUrl } = {}) {
  const results = new Map();
  if (spipIds.length === 0) return results;

  // Only load spip-session (which loads Playwright) if no session seam is
  // provided. A caller that injects `_withSpipSession` never actually needs
  // the real BASE_URL either — its fake session ignores the constructed
  // URL — so we must not fall back to getSpipSession() for it, or we'd pull
  // Playwright back in anyway.
  // 'https://www.kilombo.top' mirrors the literal already in live-write-gateway.mjs
  // for the same reason.
  const { withSpipSession, BASE_URL } = _withSpipSession ? {} : await getSpipSession();
  const withSession = _withSpipSession ?? withSpipSession;
  const baseUrl     = _baseUrl ?? BASE_URL ?? 'https://www.kilombo.top';

  await withSession(
    async (page) => {
      for (const id of spipIds) {
        const url = `${baseUrl}/ecrire/?exec=article&id_article=${id}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          const result = await readStatusWidget(page);
          results.set(String(id), !result.error);
        } catch {
          // Fallo puntual de navegación para este ID — no se pudo verificar,
          // se omite del Map en vez de asumir cualquier resultado.
        }
      }
    },
    { targetUrl: `${baseUrl}/ecrire/?exec=article&id_article=${spipIds[0]}`, expectedUrlIncludes: 'exec=article' }
  );

  return results;
}

/**
 * Cruza `duplicates` (de auditLogReport()) contra SPIP en vivo. Anota cada
 * entrada sobrante con `spipExists` y cada grupo con `resolvedInSpip`.
 *
 * SOLO LECTURA — a diferencia de una versión anterior de esta función, NO
 * escribe nada en el audit log. Un ID que aparece como "no existe" es una
 * observación de esta sesión, recalculada en cada llamada; no se persiste
 * hasta que un humano lo confirme explícitamente vía confirmExternalDeletion().
 * Esto evita que un falso positivo transitorio (ver checkArticlesExist) se
 * convierta en un registro permanente e irreversible.
 *
 * @param {Array} duplicates — report.duplicates de auditLogReport() (se muta in-place y se retorna)
 * @param {object} [seams] — inyección de dependencias para tests
 * @param {Function} [seams._checkArticlesExist] — default: checkArticlesExist real
 * @returns {Promise<Array>}
 */
export async function verifyDuplicatesInSpip(duplicates, { _checkArticlesExist = checkArticlesExist } = {}) {
  const idsToCheck = [];
  for (const dup of duplicates) {
    for (const entry of dup.aliveEntries) {
      if (String(entry.spipArticleId) !== String(dup.suggestedCanonical)) {
        idsToCheck.push(entry.spipArticleId);
      }
    }
  }

  const existsById = await _checkArticlesExist(idsToCheck);

  for (const dup of duplicates) {
    const canonical = dup.suggestedCanonical;
    dup.aliveEntries = dup.aliveEntries.map((entry) => {
      if (String(entry.spipArticleId) === String(canonical)) {
        return { ...entry, spipExists: true };
      }
      const exists = existsById.get(String(entry.spipArticleId));
      // exists === false → confirmado ausente por checkArticlesExist.
      // undefined (no verificado) o true → se trata como "sigue vivo" (fail-safe:
      // nunca se cuenta como resuelto sin una señal positiva de ausencia).
      return { ...entry, spipExists: exists !== false };
    });
    dup.verifiedInSpip = true;
    const stillAlive = dup.aliveEntries.filter(
      (e) => String(e.spipArticleId) !== String(canonical) && e.spipExists
    );
    dup.resolvedInSpip = stillAlive.length === 0;
  }

  return duplicates;
}

/**
 * Registra de forma PERMANENTE que un artículo fue confirmado ausente en SPIP
 * (borrado manualmente o por un script externo). A diferencia de
 * verifyDuplicatesInSpip() (observación efímera, solo lectura), esto excluye
 * el ID de todos los futuros auditLogReport() para siempre — por eso requiere
 * una acción humana explícita (botón "Confirmar borrado" en el dashboard, tras
 * revisar el resultado de la verificación) en vez de dispararse solo.
 *
 * Pasa por guardedWrite() — el punto único de control para toda escritura al
 * audit log — en vez de escribir el archivo directamente.
 *
 * @param {string|number} spipId
 * @returns {Promise<{success: boolean}>}
 */
export async function confirmExternalDeletion(spipId) {
  await guardedWrite({
    action: 'article.delete.permanent',
    script: 'server.mjs/confirm-external-deletion',
    target: { id: String(spipId) },
    dryRun: false,
    execute: async () => ({
      note: 'Confirmado ausente en SPIP por revisión humana (verificación + confirmación manual, no automático).',
    }),
  });
  return { success: true };
}

/**
 * Cambia el estado de un artículo SPIP.
 *
 * ⚠️  GATE DE SEGURIDAD PARA `publie`: esta función no impone la restricción
 * de "publicar requiere aprobación explícita" — esa responsabilidad es del
 * caller, porque el mecanismo de aprobación es diferente en cada contexto:
 *   - API (server.mjs):             req.body.approvePublishing === true
 *   - CLI (manage-article-status):  process.env.KILO_APPROVE_PUBLISHING
 * Si se añade un nuevo caller que pueda pasar `targetStatus === 'publie'`,
 * DEBE implementar su propio gate antes de llamar a esta función.
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

  const { withSpipSession, BASE_URL } = await getSpipSession();
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
  const { withSpipSession, BASE_URL } = await getSpipSession();
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
