/**
 * src/lib/text-utils.mjs
 *
 * Utilidades puras de texto, sin acceso a fs. Hoy solo tiene normalizeTitle,
 * usada por articles-store.mjs para agrupar duplicados locales por título.
 * Separado de articles-store.mjs para poder testearse en aislamiento.
 */

/**
 * Normaliza un título para comparación de duplicados: minúsculas, sin
 * acentos, solo alfanuméricos + espacios, espacios colapsados.
 *
 * Nota: NFD + strip de diacríticos convierte "ñ" en "n" (la tilde de la ñ
 * cae en el mismo rango \u0300-\u036f que los acentos). Es una decisión
 * deliberada para tolerar typos de tildes entre copias del mismo artículo
 * ("articulo" vs "artículo"); el costo es que "año" y "ano" normalizan
 * igual. Aceptable para detectar duplicados — el humano decide cuál
 * conservar mirando el título original, no el normalizado.
 *
 * @param {string} title
 * @returns {string} título normalizado, o '' si `title` es vacío/no-string
 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita diacríticos (á→a, ñ→n, etc.)
    .replace(/[^\w\s]/g, '')         // solo alfanuméricos + espacios
    .replace(/\s+/g, ' ')            // colapsa espacios múltiples
    .trim();
}
