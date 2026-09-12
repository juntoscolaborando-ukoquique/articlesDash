/**
 * src/lib/text-to-html.mjs
 *
 * Conversión pura entre texto plano (lo que el usuario escribe o pega en la
 * pantalla de Edición) y el HTML restringido que exige `contentHtml` según
 * article-validator.mjs (solo <p> y <br>, sin atributos, sin tags prohibidos).
 *
 * No depende de nada más — se puede testear de forma aislada.
 */

/**
 * Escapa caracteres especiales de HTML. Cualquier `<` o `>` que el usuario
 * haya pegado por accidente queda como texto literal, nunca como tag.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeHtml(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Detecta si un texto pegado en la pantalla de Edición probablemente NO es
 * prosa sino un JSON o un bloque de HTML/markup pegado por error (p.ej. la
 * salida cruda de una IA, o el JSON de otro artículo). No es una detección
 * perfecta — es una señal de alerta para mostrar un aviso al usuario antes
 * de que `textToParagraphHtml` lo envuelva silenciosamente en `<p>`/`<br>`
 * y quede guardado como si fuera contenido editorial real.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeStructuredPaste(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // JSON completo pegado entero (objeto o array)
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // no era JSON válido — sigue con la heurística de tags abajo
    }
  }

  // Alta densidad de tags HTML (más de uno cada ~80 caracteres) sugiere
  // markup pegado en crudo en lugar de texto plano.
  const tagMatches = trimmed.match(/<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/gi) || [];
  if (tagMatches.length >= 3 && tagMatches.length / trimmed.length > 1 / 80) {
    return true;
  }

  return false;
}

/**
 * Convierte texto plano en HTML válido para `contentHtml`:
 * líneas en blanco separan párrafos (<p>), saltos de línea simples dentro
 * de un párrafo se convierten en <br>. Todo el contenido queda escapado.
 *
 * @param {string} text
 * @returns {string} HTML listo para guardar en contentHtml (puede ser '')
 */
export function textToParagraphHtml(text) {
  if (!text || !text.trim()) return '';

  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * Inversa aproximada de textToParagraphHtml — reconstruye el texto plano
 * a partir del HTML generado por esta misma función, para poder reabrir
 * un borrador en la pantalla de Edición sin mostrarle tags al usuario.
 *
 * Solo garantiza un round-trip fiel para HTML que salió de
 * textToParagraphHtml. No es un parser de HTML arbitrario.
 *
 * @param {string} html
 * @returns {string}
 */
// Nota: htmlToPlainText() en public/js/utils.js es un duplicado intencional de esta
// función. El frontend no tiene bundler para importar este módulo. Si se añade un paso
// de build, colapsar ambas en una sola. Mantener sincronizadas hasta entonces.
export function htmlParagraphsToText(html) {
  if (!html) return '';

  const withoutParagraphBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/^\s*<p>/i, '')
    .replace(/<\/p>\s*$/i, '');

  return unescapeHtml(withoutParagraphBreaks).trim();
}
