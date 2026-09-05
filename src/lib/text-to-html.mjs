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
export function htmlParagraphsToText(html) {
  if (!html) return '';

  const withoutParagraphBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/^\s*<p>/i, '')
    .replace(/<\/p>\s*$/i, '');

  return unescapeHtml(withoutParagraphBreaks).trim();
}
