/**
 * src/lib/field-splitter.mjs
 *
 * Splitter heurístico: parte un contentHtml (el bloque único que produce
 * textToParagraphHtml() en la pantalla de Edición) en los campos separados
 * del schema — chapo / contentHtml / ps — más algunas sugerencias de
 * metadata (sourceUrl, sourceSite, author, sourceDate) detectadas por
 * patrón en el propio texto.
 *
 * Ver docs/IMPROVE_STEPS.md — Paso 1. Puro, sin DOM ni Express: solo texto
 * adentro, objeto afuera. Nunca lanza — si el input no matchea nada, lo
 * devuelve intacto.
 *
 * Diseñado a propósito para que `groq-enrichment.mjs` (Etapa 4 del roadmap)
 * pueda sustituirlo en el mismo punto del flujo devolviendo la misma forma:
 * { chapo, contentHtml, ps, guessed }.
 */

// El HTML de entrada ya viene restringido y previsible (solo <p>...</p>,
// eventualmente con <br>/<strong>/<em> adentro) porque sale de
// textToParagraphHtml(). No hace falta un parser HTML completo para
// separar párrafos — una regex simple sobre <p>...</p> alcanza.
const PARAGRAPH_RE = /<p>([\s\S]*?)<\/p>/gi;

const SOURCE_URL_RE = /(?:fuente(?:\s+original)?|source)\s*:\s*(?:(.+?)\s*[-–—:]\s*)?(https?:\/\/\S+)/i;
const AUTHOR_RE = /^\s*(?:autor|por|author)\s*:\s*(.+)$/i;
const PS_START_RE = /^\s*(?:p\.?\s*d\.?|ps|nota|\[nota|\*)/i;

// Fechas: DD/MM/YYYY, DD-MM-YYYY, o "20 de julio de 2026".
const DATE_NUMERIC_RE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/;
const MONTHS = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};
const DATE_TEXTUAL_RE = new RegExp(
  `\\b(\\d{1,2})\\s+de\\s+(${Object.keys(MONTHS).join('|')})\\s+de\\s+(\\d{4})\\b`,
  'i',
);
const DATE_CONTEXT_RE = /publicad|fecha/i;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Intenta extraer una fecha ISO (YYYY-MM-DD) de un párrafo de metadata,
 * solo si aparece cerca de una palabra de contexto ("publicado"/"fecha")
 * para no confundir cualquier fecha mencionada en el cuerpo con la fecha
 * de publicación.
 */
function extractSourceDate(text) {
  if (!DATE_CONTEXT_RE.test(text)) return null;

  const numeric = text.match(DATE_NUMERIC_RE);
  if (numeric) {
    const [, d, m, y] = numeric;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  const textual = text.match(DATE_TEXTUAL_RE);
  if (textual) {
    const [, d, monthName, y] = textual;
    const month = MONTHS[monthName.toLowerCase()];
    if (month) return `${y}-${month}-${pad2(d)}`;
  }

  return null;
}

/**
 * Extrae los párrafos de texto (sin tags <p>) de un contentHtml previsible.
 * @param {string} contentHtml
 * @returns {string[]}
 */
function extractParagraphs(contentHtml) {
  const paragraphs = [];
  let match;
  PARAGRAPH_RE.lastIndex = 0;
  while ((match = PARAGRAPH_RE.exec(contentHtml)) !== null) {
    paragraphs.push(match[1].trim());
  }
  return paragraphs;
}

function wrapParagraphs(paragraphs) {
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

/**
 * Quita tags internos (<br>, <strong>, <em>, etc.) para poder matchear
 * patrones de metadata sobre texto plano, sin alterar el párrafo original
 * que se guarda tal cual si no matchea nada.
 */
function stripInlineTags(paragraph) {
  return paragraph.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} contentHtml - el contentHtml actual del artículo (ya en
 *   formato <p>...</p> restringido, tal como lo deja textToParagraphHtml()).
 * @returns {{
 *   chapo: string,
 *   contentHtml: string,
 *   ps: string,
 *   guessed: { sourceUrl?: string, sourceSite?: string, sourceDate?: string, author?: string }
 * }}
 */
export function splitContentIntoFields(contentHtml) {
  const empty = { chapo: '', contentHtml: contentHtml ?? '', ps: '', guessed: {} };
  if (!contentHtml || !contentHtml.trim()) return empty;

  let paragraphs = extractParagraphs(contentHtml);
  if (paragraphs.length === 0) return empty;

  const guessed = {};

  // Paso 2 (regla 2): pie de fuente — desde el último párrafo hacia atrás,
  // mientras matchee. Cada match se quita de la lista.
  while (paragraphs.length > 0) {
    const plain = stripInlineTags(paragraphs[paragraphs.length - 1]);

    const sourceMatch = plain.match(SOURCE_URL_RE);
    const authorMatch = plain.match(AUTHOR_RE);
    const dateFound = extractSourceDate(plain);

    if (sourceMatch) {
      if (!guessed.sourceUrl) guessed.sourceUrl = sourceMatch[2];
      if (sourceMatch[1] && !guessed.sourceSite) guessed.sourceSite = sourceMatch[1].trim();
      paragraphs.pop();
      continue;
    }
    if (authorMatch) {
      if (!guessed.author) guessed.author = authorMatch[1].trim();
      paragraphs.pop();
      continue;
    }
    if (dateFound) {
      if (!guessed.sourceDate) guessed.sourceDate = dateFound;
      paragraphs.pop();
      continue;
    }
    break;
  }

  // Paso 3: post-scriptum — el último párrafo restante, si empieza con
  // un marcador reconocido.
  let ps = '';
  if (paragraphs.length > 0 && PS_START_RE.test(stripInlineTags(paragraphs[paragraphs.length - 1]))) {
    ps = paragraphs.pop();
  }

  // Paso 4: chapo — solo si quedan 2+ párrafos tras 2–3. Nunca vaciar el
  // cuerpo entero en el chapo.
  let chapo = '';
  if (paragraphs.length >= 2) {
    chapo = `<p>${paragraphs.shift()}</p>`;
  }

  return {
    chapo,
    contentHtml: wrapParagraphs(paragraphs),
    ps: ps ? `<p>${ps}</p>` : '',
    guessed,
  };
}
