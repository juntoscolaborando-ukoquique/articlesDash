#!/usr/bin/env node
/**
 * archive-published-articles.mjs
 *
 * Mueve a articles/archive/ todos los artículos locales que ya tienen
 * un `spipArticleId` — es decir, los que han sido publicados en SPIP
 * y ya no necesitan ocupar el dashboard activo.
 *
 * CUÁNDO USARLO
 *   - Mantenimiento periódico: cuando el dashboard acumula artículos ya
 *     publicados que no requieren más acción editorial local.
 *   - Después de una sesión de publicación masiva.
 *   - Si se desactivó el auto-archivo de la versión 1.15.0 o antes de
 *     actualizarse a esa versión.
 *
 * COMPORTAMIENTO
 *   - Solo mueve artículos que tienen `spipArticleId` en su JSON.
 *   - Nunca toca artículos sin `spipArticleId` (borradores, en progreso, etc.).
 *   - Operación local pura: no abre navegador ni conecta a SPIP.
 *   - Sin confirmación interactiva por defecto; usa --dry-run para previsualizar.
 *   - Salida: lista de artículos movidos (o que se moverían con --dry-run).
 *
 * USO
 *   node src/scripts/archive-published-articles.mjs [--dry-run]
 *
 * OPCIONES
 *   --dry-run   Muestra qué se movería sin mover nada.
 *
 * EJEMPLOS
 *   node src/scripts/archive-published-articles.mjs --dry-run
 *   node src/scripts/archive-published-articles.mjs
 */

import { listArticles, archiveArticle } from '../lib/articles-store.mjs';

const dryRun = process.argv.includes('--dry-run');

if (dryRun) {
  console.error('[dry-run] No se moverá ningún archivo.');
}

const published = listArticles().filter((a) => a.spipArticleId);

if (published.length === 0) {
  console.log('✅ No hay artículos publicados en el dashboard activo. Nada que archivar.');
  process.exit(0);
}

console.log(`${dryRun ? '[dry-run] ' : ''}Artículos publicados a archivar: ${published.length}\n`);

let ok = 0;
let fail = 0;

for (const article of published) {
  const label = `${article.id}  (SPIP #${article.spipArticleId})`;

  if (dryRun) {
    console.log(`  → ${label}`);
    ok++;
    continue;
  }

  try {
    archiveArticle(article.id);
    console.log(`  ✅ ${label}`);
    ok++;
  } catch (err) {
    console.error(`  ❌ ${label}  — ${err.message}`);
    fail++;
  }
}

console.log();
if (dryRun) {
  console.log(`[dry-run] ${ok} artículos se moverían a articles/archive/. Ejecuta sin --dry-run para confirmar.`);
} else {
  console.log(`${ok} archivado${ok !== 1 ? 's' : ''}, ${fail} error${fail !== 1 ? 'es' : ''}.`);
  if (fail > 0) process.exit(1);
}
