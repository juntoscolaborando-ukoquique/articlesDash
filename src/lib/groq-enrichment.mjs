/**
 * src/lib/groq-enrichment.mjs
 *
 * Etapa 4 del roadmap: enriquecimiento de artículos vía Groq LLM.
 *
 * FUNCIONES EXPORTADAS:
 *
 *   enrichDraft(rawText, partialArticle, options?)
 *     Transición 1 — Edición → En Progreso.
 *     Reemplaza splitContentIntoFields() de field-splitter.mjs en el mismo
 *     punto de POST /api/articles/:id/send-to-revision.
 *     Devuelve la misma forma: { chapo, contentHtml, ps, guessed }
 *     donde guessed = { sourceUrl?, sourceSite?, sourceDate?, author? }.
 *
 *   finalizeArticle(article, options?)
 *     Transición 2 — En Progreso → Terminado.
 *     Normaliza el HTML, completa campos vacíos (chapo, descriptif, topics,
 *     section), verifica que section sea válida.
 *     Devuelve un objeto parcial con solo los campos que Groq modificó.
 *
 * RESTRICCIONES DE IMPLEMENTACIÓN (ver ROADMAP.md Etapa 4):
 *   - Importado de forma dinámica por server.mjs (lazy import).
 *   - El cliente Groq se inyecta vía _groqClient para tests.
 *   - Timeout de 20 s + un reintento automático por llamada.
 *   - La salida de contentHtml pasa por validateHtml() igual que el input humano.
 *   - Prompts versionados aquí, nunca en server.mjs.
 *
 * ERRORES:
 *   Lanza objetos con .code:
 *     'GROQ_API_ERROR'   — fallo de red / auth / rate-limit
 *     'GROQ_PARSE_ERROR' — respuesta no parseable como JSON
 *   El caller (server.mjs) atrapa y decide si continuar con el splitter
 *   heurístico o preguntar al usuario (según la decisión de diseño del ROADMAP).
 *
 * @module
 */

import { validateHtml, sanitizeHtml } from './article-validator.mjs';

// ── Constantes ────────────────────────────────────────────────────────────────

export const GROQ_MODEL   = 'qwen/qwen3.8-27b';
const GROQ_TIMEOUT_MS     = 20_000;  // 20 s por intento
const GROQ_MAX_RETRIES    = 1;       // un reintento antes de reportar fallo

const VALID_SECTIONS = ['general', 'tierra', 'gci', 'pi', 'nom', 'nomfr', 'actualidad'];

// Tags permitidos en contentHtml (subset — los más comunes que Groq usará)
const ALLOWED_TAGS_HINT =
  '<h3>, <h4>, <p>, <br>, <hr>, <strong>, <em>, <ul>, <ol>, <li>, ' +
  '<blockquote>, <figure>, <figcaption>, <img src alt>, <table>, <thead>, ' +
  '<tbody>, <tr>, <th>, <td>, <a href>';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strips the <think>...</think> block that Qwen3 emits when
 * reasoning_effort is not explicitly disabled.
 * If the response is entirely inside an unclosed <think> block
 * (no closing tag), returns '' rather than the raw reasoning text.
 */
function stripThinkBlock(raw) {
  if (!raw) return '';
  const closed = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // If there's still an opening tag but no closing tag, the whole
  // response is reasoning — return empty so the caller handles parse failure.
  if (/<think>/i.test(closed)) return '';
  return closed;
}

/**
 * Calls groq.chat.completions.create() with a 20 s AbortSignal and
 * one automatic retry on timeout or network error.
 */
async function callWithRetry(groq, params) {
  let lastErr;
  for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
    try {
      const result = await groq.chat.completions.create(params, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Only retry on abort/network errors, not on 4xx auth/rate-limit
      const isRetryable = err.name === 'AbortError' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        (err.status >= 500);
      if (!isRetryable || attempt >= GROQ_MAX_RETRIES) break;
      // Brief pause before retry
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const e = new Error(lastErr?.message ?? 'Groq API call failed');
  e.code = 'GROQ_API_ERROR';
  e.cause = lastErr;
  throw e;
}

/**
 * Parses the raw string from Groq into a JS object.
 * Strips think-blocks, extracts the first JSON object or array.
 * Throws with code GROQ_PARSE_ERROR on failure.
 */
function parseJsonResponse(raw, expectArray = false) {
  const stripped = stripThinkBlock(raw);
  if (!stripped) {
    const e = new Error('Groq returned an empty or all-reasoning response');
    e.code = 'GROQ_PARSE_ERROR';
    e.raw = raw.slice(0, 300);
    throw e;
  }

  const pattern = expectArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = stripped.match(pattern);
  if (!match) {
    const e = new Error('Groq response did not contain a JSON ' + (expectArray ? 'array' : 'object'));
    e.code = 'GROQ_PARSE_ERROR';
    e.raw = stripped.slice(0, 300);
    throw e;
  }

  try {
    return JSON.parse(match[0]);
  } catch (parseErr) {
    const e = new Error('Groq response was not valid JSON: ' + parseErr.message);
    e.code = 'GROQ_PARSE_ERROR';
    e.raw = stripped.slice(0, 300);
    throw e;
  }
}

/**
 * Sanitises a contentHtml string coming from Groq. Unlike human input
 * (which already comes pre-restricted from textToParagraphHtml()), Groq's
 * output is free-form and must actually be cleaned, not just checked —
 * sanitizeHtml() strips forbidden tags/attributes (dropping <script>/
 * <style>/<iframe>/<object>/<embed> entirely, unwrapping anything else not
 * on the allow-list). validateHtml() then runs on the *cleaned* result so
 * any remaining structural issues (missing alt text, [cite: N] artifacts,
 * malformed markup) still surface as warnings for a human to check in
 * En Progreso. Never throws.
 */
function sanitiseContentHtml(html) {
  if (!html || typeof html !== 'string') return { html: '', warnings: [] };
  const cleaned = sanitizeHtml(html);
  const warnings = validateHtml(cleaned, 'contentHtml');
  return { html: cleaned, warnings };
}

// ── Prompts ───────────────────────────────────────────────────────────────────
// Prompts are code: versioned here, never in server.mjs route handlers.

function buildEnrichDraftPrompt(rawText, partialArticle) {
  const lang = partialArticle?.language ?? 'ES';
  const existingTitle = partialArticle?.title?.trim() ?? '';
  const existingSection = partialArticle?.section?.trim() ?? '';

  return `Eres un asistente editorial para la plataforma Kilombo (www.kilombo.top), \
un sitio de análisis geopolítico y pensamiento crítico en español y francés.

Tu tarea es analizar el siguiente texto de un artículo en borrador y extraer sus \
campos estructurados para rellenar un formulario editorial JSON.

TEXTO DEL BORRADOR:
---
${rawText.slice(0, 6000)}
---

${existingTitle ? `TÍTULO YA ASIGNADO: "${existingTitle}" (respétalo, no lo cambies)\n` : ''}
${existingSection ? `SECCIÓN YA ASIGNADA: "${existingSection}" (respétala, no la cambies)\n` : ''}

DEVUELVE ÚNICAMENTE un objeto JSON válido con esta estructura exacta (sin texto antes ni después):
{
  "title": "Título principal del artículo (string, obligatorio)",
  "soustitre": "Subtítulo breve y descriptivo (string, o \"\" si no hay)",
  "surtitre": "Texto breve sobre el título — nombre de serie o categoría temática en MAYÚSCULAS (string, o \"\")",
  "descriptif": "1-2 frases para listados y SEO, sin HTML (string, o \"\")",
  "chapo": "Párrafo introductorio en HTML, dentro de <p>...</p> (string, o \"\")",
  "contentHtml": "Cuerpo completo del artículo en HTML. Tags permitidos: ${ALLOWED_TAGS_HINT}. Sin <div>, <span>, ni atributos style/class.",
  "ps": "Post-scriptum o nota de fuente en HTML, dentro de <p>...</p> (string, o \"\")",
  "topics": ["slug-1", "slug-2"],
  "section": "una de: ${VALID_SECTIONS.join(', ')}",
  "language": "${lang}",
  "author": "Nombre del autor o \"\" si no se menciona",
  "sourceSite": "Nombre del sitio o publicación de origen o \"\"",
  "sourceUrl": "URL de la fuente original o \"\"",
  "sourceDate": "Fecha de publicación en la fuente en formato YYYY-MM-DD o \"\""
}

REGLAS ESTRICTAS:
1. No inventes información. Si un campo no está en el texto, devuelve "" o [].
2. topics: 2 a 6 slugs en minúsculas, sin acentos, separados por guiones (p.ej. "covid-19", "nueva-orden-mundial").
3. section: elige la más apropiada según el contenido. "nom" para análisis geopolítico/plandemismo en español; "nomfr" para el mismo contenido en francés; "actualidad" para noticias; "pi" para proletarios internacionalistas; "gci" para ICG; "tierra" para ecología/movimientos sociales; "general" si no encaja en ninguna.
4. contentHtml: estructura con <h3>/<h4> para secciones, <p> para párrafos, <ul><li> para listas. No incluyas el título ni el chapo dentro del contentHtml.
5. chapo: solo el párrafo introductorio (el primer párrafo llamativo), sin el resto del cuerpo.
6. Artefactos como [cite: N], [N], (N) de referencias bibliográficas deben eliminarse del output.
7. Si el texto ya está bien estructurado en HTML, consérvalo tal cual en contentHtml.`;
}

function buildFinalizeArticlePrompt(article) {
  const fieldsToCheck = {
    title: article.title,
    soustitre: article.soustitre,
    descriptif: article.descriptif,
    chapo: article.chapo,
    contentHtml: article.contentHtml,
    topics: article.topics,
    section: article.section,
  };

  return `Eres un editor de revisión final para la plataforma Kilombo (www.kilombo.top).

El siguiente artículo está a punto de ser aprobado para publicación. Tu tarea es \
verificar y completar ÚNICAMENTE los campos vacíos o problemáticos. No cambies \
nada que ya esté bien.

ARTÍCULO ACTUAL:
---
${JSON.stringify(fieldsToCheck, null, 2)}
---

DEVUELVE ÚNICAMENTE un objeto JSON con los campos que necesitan corrección \
(omite los que ya están correctos). Si todo está bien, devuelve {}.

Campos que debes verificar:
- "contentHtml": elimina artefactos como [cite: N], normaliza HTML al conjunto permitido \
(${ALLOWED_TAGS_HINT}), sin <div>/<span>/style=/class=.
- "chapo": si está vacío y el contentHtml tiene un primer párrafo introductorio claro, \
extráelo aquí como <p>...</p>. Si ya está bien, omite este campo en la respuesta.
- "descriptif": si está vacío, genera 1-2 frases en texto plano (sin HTML) para SEO.
- "topics": si está vacío o tiene menos de 2 elementos, propón 2-6 slugs en minúsculas \
sin acentos. Si ya tiene 2+, omite.
- "section": si no es uno de [${VALID_SECTIONS.join(', ')}], corrige al más apropiado.

REGLAS:
1. No inventes información que no esté en el artículo.
2. Solo devuelve los campos que realmente necesitan cambio.
3. Sin texto antes ni después del JSON.`;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Transición 1 — Edición → En Progreso.
 *
 * Toma el texto libre del borrador y devuelve los campos estructurados del
 * schema, en la misma forma que splitContentIntoFields() de field-splitter.mjs.
 *
 * @param {string} rawText — texto plano o HTML del borrador (contentHtml del artículo)
 * @param {object} partialArticle — artículo parcial (title, language, section, etc.)
 * @param {object} [options]
 * @param {object} [options._groqClient] — cliente Groq inyectable para tests
 * @returns {Promise<{
 *   chapo: string,
 *   contentHtml: string,
 *   ps: string,
 *   guessed: { sourceUrl?: string, sourceSite?: string, sourceDate?: string, author?: string },
 *   groqWarnings: string[],
 *   model: string,
 * }>}
 * @throws {{ code: 'GROQ_API_ERROR' | 'GROQ_PARSE_ERROR', message: string }}
 */
export async function enrichDraft(rawText, partialArticle = {}, { _groqClient } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey && !_groqClient) {
    const e = new Error('GROQ_API_KEY no está definida en el entorno');
    e.code = 'GROQ_API_ERROR';
    throw e;
  }

  const groq = _groqClient ?? new (await import('groq-sdk')).default({ apiKey });

  const prompt = buildEnrichDraftPrompt(rawText, partialArticle);

  const completion = await callWithRetry(groq, {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 4096,
    reasoning_effort: 'none', // suppress Qwen3 <think> block
  });

  const raw = completion.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonResponse(raw, false);

  // Sanitise contentHtml through the same gate as human input
  const { html: safeContentHtml, warnings } = sanitiseContentHtml(parsed.contentHtml ?? '');

  // Map to the shape field-splitter.mjs returns — caller uses the same write-back logic
  return {
    chapo:       typeof parsed.chapo === 'string'       ? parsed.chapo       : '',
    contentHtml: safeContentHtml,
    ps:          typeof parsed.ps === 'string'          ? parsed.ps          : '',
    guessed: {
      ...(parsed.sourceUrl  ? { sourceUrl:  String(parsed.sourceUrl)  } : {}),
      ...(parsed.sourceSite ? { sourceSite: String(parsed.sourceSite) } : {}),
      ...(parsed.sourceDate ? { sourceDate: String(parsed.sourceDate) } : {}),
      ...(parsed.author     ? { author:     String(parsed.author)     } : {}),
    },
    // Extra fields that field-splitter.mjs doesn't return — server.mjs
    // uses these to fill additional gaps without overwriting existing values.
    extra: {
      ...(parsed.title      && !partialArticle.title      ? { title:      String(parsed.title)      } : {}),
      ...(parsed.soustitre  && !partialArticle.soustitre  ? { soustitre:  String(parsed.soustitre)  } : {}),
      ...(parsed.surtitre   && !partialArticle.surtitre   ? { surtitre:   String(parsed.surtitre)   } : {}),
      ...(parsed.descriptif && !partialArticle.descriptif ? { descriptif: String(parsed.descriptif) } : {}),
      ...(Array.isArray(parsed.topics) && parsed.topics.length >= 2 && !partialArticle.topics?.length
          ? { topics: parsed.topics.map(String) } : {}),
      ...(parsed.section && VALID_SECTIONS.includes(parsed.section) && !partialArticle.section
          ? { section: parsed.section } : {}),
    },
    groqWarnings: warnings,
    model: GROQ_MODEL,
  };
}

/**
 * Transición 2 — En Progreso → Terminado.
 *
 * Verifica y completa solo los campos vacíos o problemáticos antes de
 * que el artículo sea aprobado. Devuelve un patch (objeto parcial) con
 * solo los campos que Groq modificó — el caller hace writeBack(id, patch).
 *
 * @param {object} article — artículo completo
 * @param {object} [options]
 * @param {object} [options._groqClient] — cliente Groq inyectable para tests
 * @returns {Promise<{
 *   patch: object,
 *   groqWarnings: string[],
 *   model: string,
 * }>}
 * @throws {{ code: 'GROQ_API_ERROR' | 'GROQ_PARSE_ERROR', message: string }}
 */
export async function finalizeArticle(article, { _groqClient } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey && !_groqClient) {
    const e = new Error('GROQ_API_KEY no está definida en el entorno');
    e.code = 'GROQ_API_ERROR';
    throw e;
  }

  const groq = _groqClient ?? new (await import('groq-sdk')).default({ apiKey });

  const prompt = buildFinalizeArticlePrompt(article);

  const completion = await callWithRetry(groq, {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
    reasoning_effort: 'none',
  });

  const raw = completion.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonResponse(raw, false);

  // Empty object = Groq found nothing to fix
  if (!parsed || Object.keys(parsed).length === 0) {
    return { patch: {}, groqWarnings: [], model: GROQ_MODEL };
  }

  const patch = {};
  const warnings = [];

  // contentHtml — only patch if the CURRENT contentHtml actually has a
  // problem (empty, forbidden tags/attrs, [cite: N] artifacts, etc.).
  // Groq's own prompt asks it to "omit fields that are already fine", but
  // that's a request, not a guarantee — an LLM can still return a
  // reworded/rewritten contentHtml even when nothing was wrong. Gating on
  // the current field's own validation result (same check used everywhere
  // else in this function) keeps this in line with the "never overwrite
  // something that already works" rule instead of trusting the prompt alone.
  const currentHtmlErrors = article.contentHtml ? validateHtml(article.contentHtml, 'contentHtml') : [];
  const currentHtmlNeedsFix = !article.contentHtml?.trim() || currentHtmlErrors.length > 0;

  if (typeof parsed.contentHtml === 'string' && currentHtmlNeedsFix) {
    const { html, warnings: htmlWarnings } = sanitiseContentHtml(parsed.contentHtml);
    patch.contentHtml = html;
    warnings.push(...htmlWarnings);
  }

  // chapo — only patch if article is missing it
  if (typeof parsed.chapo === 'string' && !article.chapo?.trim()) {
    patch.chapo = parsed.chapo;
  }

  // descriptif — only patch if article is missing it
  if (typeof parsed.descriptif === 'string' && !article.descriptif?.trim()) {
    patch.descriptif = parsed.descriptif;
  }

  // topics — only patch if article has < 2
  if (Array.isArray(parsed.topics) && parsed.topics.length >= 2 && (article.topics?.length ?? 0) < 2) {
    patch.topics = parsed.topics.map(String);
  }

  // section — only patch if current section is missing or invalid
  if (typeof parsed.section === 'string' &&
      VALID_SECTIONS.includes(parsed.section) &&
      !VALID_SECTIONS.includes(article.section)) {
    patch.section = parsed.section;
  }

  return { patch, groqWarnings: warnings, model: GROQ_MODEL };
}
