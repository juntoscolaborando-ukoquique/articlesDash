/**
 * src/lib/spip-client.mjs
 *
 * Capa de abstracción sobre el formulario SPIP article_edit.
 * Recibe un artículo validado (schema v1.0) y lo publica en kilombo.top
 * vía Playwright, dejándolo en estado "en preparación" (prepa).
 *
 * RESPONSABILIDADES:
 *   - Traducir slugs de sección a IDs numéricos de SPIP (rubriques)
 *   - Rellenar todos los campos del formulario article_edit
 *   - Enrutar toda escritura por guardedWrite() para audit logging
 *   - Extraer el ID del artículo creado de la URL resultante
 *
 * CAMPOS QUE SE RELLENAN:
 *   Confirmados con input visible en el formulario:
 *     titre, texte, id_parent, descriptif, nom_site, url_site
 *   En BD pero pueden estar en modo WYSIWYG (verificar con --inspect):
 *     surtitre, soustitre, chapo, ps
 *
 * LO QUE NO IMPLEMENTA (pendiente):
 *   - Subida de imagen (coverImage) — requiere el formulario de adjuntos
 *   - Asignación de mots-clés (topics) — formulario separado en SPIP
 *   - Asociación de autor — formulario separado en SPIP
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedWrite } from './live-write-gateway.mjs';
import { withSpipSession, BASE_URL, DEFAULT_ENV_PATH } from './spip-session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDIT_URL = `${BASE_URL}/ecrire/?exec=article_edit&new=oui`;

// ── Tabla de rubriques ────────────────────────────────────────────────────────
// Verificada contra el SPIP vivo en kilombo.top.
// Para re-verificar: abrir EDIT_URL con --inspect y leer <select name="id_parent">

/** @type {Record<string, string>} */
export const SLUG_TO_RUBRIQUE_ID = {
  general:    '1',   // kilombo (raíz) — contenido sin categoría específica
  tierra:     '1',   // sin rubrique propio; usa la raíz
  gci:        '3',   // icg
  pi:         '2',   // Proletarios internacionalistas
  nom:        '19',  // NUEVO ORDEN / PLANDEMISMO Y DOMESTICACIÓN (ES)
  actualidad: '21',  // Actualités
};

/**
 * Traduce un slug de sección al ID numérico de rubrique SPIP.
 *
 * NOTA: no acepta IDs numéricos directamente — `article-validator.mjs` exige
 * que `section` sea uno de los slugs de VALID_SECTIONS antes de llegar acá,
 * así que cualquier atajo numérico sería código muerto en el flujo normal.
 *
 * @param {string} section - slug (e.g. 'nom')
 * @returns {string} ID numérico como string
 * @throws {Error} si el slug no está en la tabla
 */
export function slugToRubriquId(section) {
  const id = SLUG_TO_RUBRIQUE_ID[section];
  if (!id) {
    throw new Error(
      `Sección desconocida: "${section}". ` +
        `Valores válidos: ${Object.keys(SLUG_TO_RUBRIQUE_ID).join(', ')}.`
    );
  }
  return id;
}

// ── Selectores del formulario SPIP ────────────────────────────────────────────
// Confirmados como visibles en el HTML del formulario article_edit de kilombo.top
const SELECTORS = {
  title:      { selector: 'input[name="titre"]',         type: 'text' },   // ✅ confirmado
  body:       { selector: 'textarea[name="texte"]',       type: 'text' },   // ✅ confirmado
  section:    { selector: 'select[name="id_parent"]',     type: 'select' }, // ✅ confirmado
  descriptif: { selector: 'textarea[name="descriptif"]',  type: 'text' },   // ✅ confirmado
  sourceSite: { selector: 'input[name="nom_site"]',       type: 'text' },   // ✅ confirmado
  sourceUrl:  { selector: 'input[name="url_site"]',       type: 'text' },   // ✅ confirmado
  // Los siguientes existen en la BD SPIP pero pueden estar en modo WYSIWYG.
  // Si no responden a fill(), puede necesitarse interacción adicional con el editor.
  surtitre:   { selector: 'input[name="surtitre"]',       type: 'text' },   // ⚠️ verificar con --inspect
  soustitre:  { selector: 'input[name="soustitre"]',      type: 'text' },   // ⚠️ verificar con --inspect
  chapo:      { selector: 'textarea[name="chapo"]',       type: 'text' },   // ⚠️ verificar con --inspect
  ps:         { selector: 'textarea[name="ps"]',          type: 'text' },   // ⚠️ verificar con --inspect
  saveButton: { selector: 'input[type="submit"][name="save"]', type: 'text' },
};

// ── Llenado del formulario ────────────────────────────────────────────────────

/**
 * Rellena un campo del formulario y dispara blur para el autosave AJAX de SPIP.
 * Si el selector no existe en la página, lo registra como advertencia y continúa
 * (evita que campos opcionales no visibles rompan la publicación).
 *
 * @param {import('playwright').Page} page
 * @param {{ selector: string, type: 'text' | 'select' }} field - entrada de SELECTORS
 * @param {string} value
 * @param {boolean} dryRun
 * @param {boolean} [optional=false] - si true, la ausencia del campo no es un error
 */
async function fillField(page, field, value, dryRun, optional = false) {
  const { selector, type } = field;
  const locator = page.locator(selector);
  const count = await locator.count();

  if (count === 0) {
    if (optional) {
      console.log(`  ⚠️  Campo opcional no encontrado: ${selector} — omitiendo`);
      return;
    }
    throw new Error(`Campo requerido no encontrado en el formulario: ${selector}`);
  }

  if (type === 'select') {
    await locator.selectOption(value);
  } else {
    await locator.fill(value);
    await locator.blur();
  }

  if (!dryRun) {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }
}

const REQUIRED_FIELDS = [
  { key: 'title', field: SELECTORS.title, log: (v) => `  Título: "${v}"` },
  { key: 'contentHtml', field: SELECTORS.body, log: () => '  Cuerpo (contentHtml)...' },
];

const CONDITIONAL_FIELDS = [
  { key: 'descriptif', field: SELECTORS.descriptif, optionalSelector: false, log: () => '  Descriptif...' },
  { key: 'sourceSite', field: SELECTORS.sourceSite, optionalSelector: false, log: (v) => `  Fuente (nom_site): "${v}"` },
  { key: 'sourceUrl', field: SELECTORS.sourceUrl, optionalSelector: false, log: (v) => `  URL fuente (url_site): "${v}"` },
  { key: 'surtitre', field: SELECTORS.surtitre, optionalSelector: true, log: (v) => `  Surtitre: "${v}"` },
  { key: 'soustitre', field: SELECTORS.soustitre, optionalSelector: true, log: (v) => `  Soustitre: "${v}"` },
  { key: 'chapo', field: SELECTORS.chapo, optionalSelector: true, log: () => '  Chapo (entradilla)...' },
  { key: 'ps', field: SELECTORS.ps, optionalSelector: true, log: () => '  Post-scriptum...' },
];

/**
 * Operación real de relleno y envío del formulario.
 * Solo debe invocarse dentro del callback execute() de guardedWrite().
 *
 * @param {import('playwright').Page} page
 * @param {object} article - artículo validado (schema v1.0)
 * @param {boolean} dryRun
 * @returns {Promise<{ articleId: string | null }>}
 */
async function performCreate(page, article, dryRun) {
  const rubriquId = slugToRubriquId(article.section);

  // En dry-run, bloquea todos los POSTs al backend para no crear nada en BD
  if (dryRun) {
    console.log('🔒 DRY-RUN: bloqueando todas las peticiones POST a SPIP');
    await page.route('**/ecrire/**', (route) => {
      if (route.request().method() === 'POST') {
        console.log(`   [BLOQUEADO] POST → ${route.request().url()}`);
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  for (const { key, field, log } of REQUIRED_FIELDS) {
    console.log(log(article[key]));
    await fillField(page, field, article[key], dryRun);
  }

  console.log(`  Sección: ${article.section} → rubrique ${rubriquId}`);
  await fillField(page, SELECTORS.section, rubriquId, dryRun);

  for (const { key, field, optionalSelector, log } of CONDITIONAL_FIELDS) {
    const value = article[key];
    if (!value) continue;
    console.log(log(value));
    await fillField(page, field, value, dryRun, optionalSelector);
  }

  // ── Guardar ───────────────────────────────────────────────────────────────
  let articleId = null;

  if (!dryRun) {
    console.log('  Guardando artículo...');
    await page.locator(SELECTORS.saveButton.selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.locator(SELECTORS.saveButton.selector).click();
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const currentUrl = page.url();
    const idMatch = currentUrl.match(/id_article=(\d+)/);

    if (idMatch) {
      articleId = idMatch[1];
      console.log(`\n✅ Artículo creado con ID ${articleId}`);
      console.log(`   URL en SPIP: ${BASE_URL}/ecrire/?exec=article&id_article=${articleId}`);
      console.log(`   Estado: en preparación (prepa) — listo para revisión humana`);
    } else {
      console.warn(`\n⚠️  No se pudo extraer el ID del artículo de la URL: ${currentUrl}`);
    }
  } else {
    console.log('\n✅ Dry-run completado — no se creó ningún artículo en la BD');
  }

  return { articleId };
}

// ── SPIPClient ────────────────────────────────────────────────────────────────

/**
 * Devuelve los campos del artículo que están definidos en el schema pero que
 * spip-client.mjs todavía no escribe en SPIP. Es la fuente de verdad única
 * para el aviso de campos no implementados — publish-article.mjs la llama
 * en lugar de mantener su propia lista duplicada.
 *
 * Cuando se implemente un campo aquí, el aviso desaparece automáticamente.
 *
 * @param {object} article - artículo validado
 * @returns {string[]} lista de descripciones de campos no implementados
 */
export function getUnimplementedFields(article) {
  const fields = [];
  // Añadir una entrada aquí mientras el campo no tenga implementación en performCreate().
  // Quitarla cuando se implemente.
  if (article.coverImage) fields.push('coverImage (imagen destacada)');
  if (Array.isArray(article.topics) && article.topics.length > 0) {
    fields.push('topics (mots-clés)');
  }
  if (article.author) fields.push('author');
  if (article.date) fields.push('date (fecha del artículo)');
  return fields;
}

export class SPIPClient {
  /**
   * @param {object} [options]
   * @param {string} [options.envPath] - ruta al archivo .env
   * @param {number} [options.timeout] - timeout en ms para el browser (default: 120000)
   */
  constructor(options = {}) {
    this.envPath = options.envPath || DEFAULT_ENV_PATH;
    this.timeout = options.timeout || 120000;
  }

  /**
   * Publica un artículo en SPIP en estado "en preparación" (prepa).
   *
   * @param {object} article - artículo ya validado contra el schema v1.0
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false] - si true, no crea nada en BD
   * @returns {Promise<{ success: boolean, articleId?: string, url?: string, error?: string }>}
   */
  async publishArticle(article, { dryRun = false } = {}) {
    try {
      const result = await withSpipSession(
        (page) =>
          guardedWrite({
            action: 'article.create',
            target: { id: article.id, title: article.title, section: article.section },
            dryRun,
            execute: () => performCreate(page, article, dryRun),
          }),
        {
          envPath: this.envPath,
          timeout: this.timeout,
          targetUrl: EDIT_URL,
          expectedUrlIncludes: 'exec=article_edit',
        }
      );

      return {
        success: true,
        articleId: result.articleId,
        url: result.articleId
          ? `${BASE_URL}/ecrire/?exec=article&id_article=${result.articleId}`
          : null,
        dryRun,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        dryRun,
      };
    }
  }
}

export default SPIPClient;
