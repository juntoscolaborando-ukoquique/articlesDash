#!/usr/bin/env node
/**
 * search-spip-articles.mjs — busca artículos en SPIP por nombre/texto
 * y devuelve los resultados como JSON en stdout.
 *
 * Uso:
 *   node src/scripts/search-spip-articles.mjs "<término de búsqueda>"
 *
 * Ejemplos:
 *   node src/scripts/search-spip-articles.mjs "haute finance"
 *   node src/scripts/search-spip-articles.mjs "Semillas del Barrio"
 *   node src/scripts/search-spip-articles.mjs "fauci"
 *
 * Salida stdout (JSON):
 *   [
 *     { "id": "124", "title": "La haute finance luciférienne…", "url": "https://…" },
 *     …
 *   ]
 *
 * Mensajes de progreso → stderr (no contaminan la salida JSON).
 *
 * Notas:
 *   - La búsqueda usa el motor interno de SPIP (?exec=recherche).
 *   - Devuelve todos los artículos que aparecen en la página de resultados,
 *     incluidos los que están en cualquier estado (prepa, publie, etc.).
 *   - La velocidad depende del login SSO (~15-30 s en total).
 */

import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';

const query = process.argv[2];

if (!query) {
  console.error('Uso: node src/scripts/search-spip-articles.mjs "<término>"');
  console.error('Ejemplo: node src/scripts/search-spip-articles.mjs "Semillas del Barrio"');
  process.exit(2);
}

const encodedQuery = encodeURIComponent(query);
const searchUrl = `${BASE_URL}/ecrire/?exec=recherche&recherche=${encodedQuery}`;

await withSpipSession(async (page) => {
  console.error(`Buscando "${query}" en SPIP…`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);

  const results = await page.evaluate((baseUrl) => {
    const seen = new Set();
    const items = [];

    // Recopilar todos los enlaces que apunten a un id_article concreto.
    // SPIP puede renderizar los resultados en distintos contenedores
    // según la versión y el tema — rastrear todos los <a> es más robusto
    // que depender de una clase o selector específico.
    document.querySelectorAll('a[href*="id_article="]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      const match = href.match(/[?&]id_article=(\d+)/);
      if (!match) return;

      const id = match[1];
      if (id === '0') return;           // placeholders
      if (seen.has(id)) return;
      seen.add(id);

      const title = link.textContent.trim();
      if (!title) return;               // skip icon-only links

      // Build absolute admin URL
      const adminUrl = href.startsWith('http')
        ? href
        : `${baseUrl}/ecrire/?exec=article&id_article=${id}`;

      items.push({ id, title, url: adminUrl });
    });

    return items;
  }, BASE_URL);

  if (results.length === 0) {
    console.error('No se encontraron artículos para ese término.');
  } else {
    console.error(`${results.length} resultado(s) encontrado(s).`);
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');

}, { targetUrl: searchUrl, expectedUrlIncludes: 'exec=recherche' });
