/**
 * src/lib/article-validator.mjs
 *
 * Valida un objeto artículo contra el schema definido en docs/SCHEMA.md.
 * Devuelve una lista de errores (vacía si el artículo es válido).
 *
 * USO:
 *   import { validateArticle } from './article-validator.mjs';
 *   const errors = validateArticle(article);
 *   if (errors.length > 0) { ... }
 */

// ── Valores permitidos ────────────────────────────────────────────────────────

const VALID_SECTIONS = ['general', 'tierra', 'gci', 'pi', 'nom', 'actualidad'];
const VALID_LANGUAGES = ['ES', 'FR', 'EN'];
const VALID_STATUSES = ['prepa'];
const SCHEMA_VERSION = '1.0';

// Tags HTML permitidos en contentHtml, chapo y ps
const ALLOWED_TAGS = new Set([
  'h3', 'h4', 'p', 'br', 'hr',
  'strong', 'em',
  'ul', 'ol', 'li',
  'blockquote',
  'figure', 'figcaption', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a',
]);

// Atributos que nunca deben aparecer en el HTML
const FORBIDDEN_ATTR_PATTERNS = [/^style$/i, /^class$/i, /^on\w+$/i];

// Tags prohibidos explícitamente
const FORBIDDEN_TAGS = new Set(['div', 'span', 'script', 'style', 'iframe', 'object', 'embed']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extrae todos los tags y atributos del HTML usando regex ligero.
 * No pretende ser un parser completo — cubre los errores más comunes.
 *
 * @param {string} html
 * @returns {{ tags: string[], forbiddenAttrs: string[], missingAlts: boolean }}
 */
function analyzeHtml(html) {
  const tags = [];
  const forbiddenAttrs = [];
  let missingAlts = false;

  // Extraer tags de apertura: <tagname attr1 attr2>
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)\s*\/?>/g;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrsStr = match[2] || '';
    tags.push(tagName);

    // Detectar atributos prohibidos
    const attrNameRegex = /\s([a-zA-Z][\w-]*)\s*(?:=|\s|$)/g;
    let attrMatch;
    while ((attrMatch = attrNameRegex.exec(attrsStr)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      if (FORBIDDEN_ATTR_PATTERNS.some((p) => p.test(attrName))) {
        forbiddenAttrs.push(`${tagName}[${attrName}]`);
      }
    }

    // Verificar que <img> tenga atributo alt
    if (tagName === 'img' && !/\balt\s*=/i.test(attrsStr)) {
      missingAlts = true;
    }
  }

  return { tags, forbiddenAttrs, missingAlts };
}

/**
 * Valida el HTML de un campo (contentHtml, chapo, ps).
 * Devuelve un array de mensajes de error, vacío si es válido.
 *
 * @param {string} html
 * @param {string} fieldName
 * @returns {string[]}
 */
function validateHtml(html, fieldName) {
  const errors = [];
  const { tags, forbiddenAttrs, missingAlts } = analyzeHtml(html);

  const unknownTags = [...new Set(tags)].filter(
    (t) => !ALLOWED_TAGS.has(t) && !FORBIDDEN_TAGS.has(t)
  );
  const forbiddenFound = [...new Set(tags)].filter((t) => FORBIDDEN_TAGS.has(t));

  if (forbiddenFound.length > 0) {
    errors.push(`${fieldName}: tags prohibidos: <${forbiddenFound.join('>, <')}>`);
  }
  if (unknownTags.length > 0) {
    errors.push(`${fieldName}: tags no permitidos: <${unknownTags.join('>, <')}>`);
  }
  if (forbiddenAttrs.length > 0) {
    errors.push(`${fieldName}: atributos prohibidos: ${forbiddenAttrs.join(', ')}`);
  }
  if (missingAlts) {
    errors.push(`${fieldName}: hay imágenes <img> sin atributo alt`);
  }

  // Marcadores de cita AI ([cite: N]) — artefactos del asistente de escritura
  // que se publicarían como texto literal en el sitio si no se eliminan.
  if (/\[cite:\s*\d+\]/i.test(html)) {
    errors.push(
      `${fieldName}: contiene marcadores de cita AI ([cite: N]) que se publicarían como texto literal — eliminarlos antes de publicar`
    );
  }

  return errors;
}

// ── Validador principal ───────────────────────────────────────────────────────

/**
 * Valida un artículo contra el schema v1.0.
 *
 * @param {unknown} article - El objeto a validar (parseado desde JSON)
 * @returns {string[]} Lista de errores. Vacía si el artículo es válido.
 */
export function validateArticle(article) {
  const errors = [];

  if (!article || typeof article !== 'object') {
    return ['El artículo debe ser un objeto JSON'];
  }

  // ── Versión del schema ─────────────────────────────────────────────────────
  if (article._schema_version !== SCHEMA_VERSION) {
    errors.push(`_schema_version debe ser "${SCHEMA_VERSION}", encontrado: "${article._schema_version}"`);
  }

  // ── Identidad ──────────────────────────────────────────────────────────────
  if (!article.id || typeof article.id !== 'string') {
    errors.push('id: obligatorio');
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.id)) {
    errors.push(`id: slug inválido "${article.id}" — solo minúsculas, números y guiones`);
  }

  if (!VALID_LANGUAGES.includes(article.language)) {
    errors.push(`language: debe ser uno de ${VALID_LANGUAGES.join(', ')}, encontrado: "${article.language}"`);
  }

  if (!VALID_SECTIONS.includes(article.section)) {
    errors.push(`section: debe ser uno de ${VALID_SECTIONS.join(', ')}, encontrado: "${article.section}"`);
  }

  // ── Cabecera editorial ─────────────────────────────────────────────────────
  if (!article.title || typeof article.title !== 'string' || !article.title.trim()) {
    errors.push('title: obligatorio y no puede estar vacío');
  }

  if (article.surtitre !== undefined && typeof article.surtitre !== 'string') {
    errors.push('surtitre: debe ser string');
  }

  if (article.soustitre !== undefined && typeof article.soustitre !== 'string') {
    errors.push('soustitre: debe ser string');
  }

  if (article.descriptif !== undefined) {
    if (typeof article.descriptif !== 'string') {
      errors.push('descriptif: debe ser string');
    } else if (/<[a-z]/i.test(article.descriptif)) {
      errors.push('descriptif: no debe contener HTML (es texto plano para listados y SEO)');
    }
  }

  // ── Imagen destacada ───────────────────────────────────────────────────────
  if (article.coverImage !== undefined) {
    if (typeof article.coverImage !== 'object' || article.coverImage === null) {
      errors.push('coverImage: debe ser un objeto');
    } else {
      if (!article.coverImage.url || typeof article.coverImage.url !== 'string') {
        errors.push('coverImage.url: obligatorio cuando coverImage está presente');
      } else if (!/^https?:\/\/.+/.test(article.coverImage.url)) {
        errors.push('coverImage.url: debe ser una URL absoluta (https://...)');
      }
      if (!article.coverImage.alt || typeof article.coverImage.alt !== 'string') {
        errors.push('coverImage.alt: obligatorio cuando coverImage está presente (accesibilidad)');
      }
    }
  }

  // ── Cuerpo del artículo ────────────────────────────────────────────────────
  if (article.chapo !== undefined) {
    if (typeof article.chapo !== 'string') {
      errors.push('chapo: debe ser string');
    } else if (article.chapo.trim()) {
      errors.push(...validateHtml(article.chapo, 'chapo'));
    }
  }

  if (!article.contentHtml || typeof article.contentHtml !== 'string' || !article.contentHtml.trim()) {
    errors.push('contentHtml: obligatorio y no puede estar vacío');
  } else {
    errors.push(...validateHtml(article.contentHtml, 'contentHtml'));
  }

  if (article.ps !== undefined) {
    if (typeof article.ps !== 'string') {
      errors.push('ps: debe ser string');
    } else if (article.ps.trim()) {
      errors.push(...validateHtml(article.ps, 'ps'));
    }
  }

  // ── Fuente y autoría ───────────────────────────────────────────────────────
  if (article.author !== undefined && typeof article.author !== 'string') {
    errors.push('author: debe ser string');
  }

  if (article.sourceSite !== undefined && typeof article.sourceSite !== 'string') {
    errors.push('sourceSite: debe ser string');
  }

  if (article.sourceUrl !== undefined && article.sourceUrl !== '') {
    if (!/^https?:\/\/.+/.test(article.sourceUrl)) {
      errors.push('sourceUrl: debe ser una URL absoluta (https://...) o estar ausente');
    }
  }

  if (article.sourceDate !== undefined && article.sourceDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(article.sourceDate)) {
      errors.push('sourceDate: debe ser formato YYYY-MM-DD');
    }
  }

  // ── Clasificación y estado ─────────────────────────────────────────────────
  if (article.date === undefined) {
    errors.push('date: obligatorio (usar "" si la fecha es desconocida)');
  } else if (article.date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(article.date)) {
    errors.push('date: debe ser formato YYYY-MM-DD o "" si desconocida');
  }

  if (!Array.isArray(article.topics)) {
    errors.push('topics: debe ser un array');
  } else {
    if (article.topics.length < 2 || article.topics.length > 6) {
      errors.push(`topics: debe tener entre 2 y 6 elementos, tiene ${article.topics.length}`);
    }
    const nonString = article.topics.filter((t) => typeof t !== 'string');
    if (nonString.length > 0) {
      errors.push('topics: todos los elementos deben ser strings');
    }
    const uppercase = article.topics.filter((t) => typeof t === 'string' && t !== t.toLowerCase());
    if (uppercase.length > 0) {
      errors.push(`topics: los slugs deben estar en minúsculas: ${uppercase.join(', ')}`);
    }
  }

  if (!VALID_STATUSES.includes(article.status)) {
    errors.push(`status: debe ser "${VALID_STATUSES[0]}", encontrado: "${article.status}"`);
  }

  return errors;
}

/**
 * Devuelve los campos del artículo que están definidos en el schema pero que
 * spip-client.mjs todavía no escribe en SPIP. Es la fuente de verdad única
 * para el aviso de campos no implementados — publish-article.mjs la llama
 * en lugar de mantener su propia lista duplicada.
 *
 * Vive aquí (article-validator.mjs) en vez de en spip-client.mjs para que
 * --validate-only y el servidor puedan llamarla sin cargar Playwright.
 * spip-client.mjs re-exporta esta función para compatibilidad.
 *
 * Cuando se implemente un campo en performCreate(), quitarlo de aquí.
 *
 * @param {object} article - artículo validado
 * @returns {string[]} lista de descripciones de campos no implementados
 */
export function getUnimplementedFields(article) {
  const fields = [];
  if (article.coverImage) fields.push('coverImage (imagen destacada)');
  if (Array.isArray(article.topics) && article.topics.length > 0) {
    fields.push('topics (mots-clés)');
  }
  if (article.author) fields.push('author');
  if (article.date) fields.push('date (fecha del artículo)');
  return fields;
}

/**
 * Valida y lanza un error si el artículo no es válido.
 * Útil para validación en el punto de entrada del script.
 *
 * @param {unknown} article
 * @param {string} [sourcePath] - ruta del archivo JSON, para el mensaje de error
 * @throws {Error} con todos los errores de validación concatenados
 */
export function assertValidArticle(article, sourcePath = '') {
  const errors = validateArticle(article);
  if (errors.length > 0) {
    const source = sourcePath ? ` en ${sourcePath}` : '';
    throw new Error(
      `Artículo inválido${source}:\n` +
        errors.map((e) => `  • ${e}`).join('\n')
    );
  }
}
