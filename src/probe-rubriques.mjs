#!/usr/bin/env node
/**
 * src/probe-rubriques.mjs
 *
 * Fase D0 — verifica el mapeo SLUG → rubrique ID contra el SPIP vivo.
 *
 * Abre el formulario article_edit en www.kilombo.top, lee el <select
 * name="id_parent"> y extrae todas las opciones disponibles. Luego compara
 * los IDs registrados en SLUG_TO_RUBRIQUE_ID con lo que el sitio reporta
 * y marca discrepancias.
 *
 * USO:
 *   node src/probe-rubriques.mjs
 *
 * REQUISITOS:
 *   - Archivo .env en la raíz del proyecto con KILOMBOTOP_PASSWORD
 *   - Playwright instalado: npm install && npx playwright install chromium
 *
 * CUÁNDO CORRER:
 *   Antes de cualquier publicación real en un entorno nuevo o tras una
 *   reorganización de secciones en el panel SPIP de kilombo.top.
 *   Si todos los IDs coinciden, la tabla SLUG_TO_RUBRIQUE_ID es confiable
 *   y se puede proceder con la publicación.
 */

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, getPassword, login, BASE_URL, DEFAULT_ENV_PATH } from './lib/spip-session.mjs';
import { SLUG_TO_RUBRIQUE_ID } from './lib/spip-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDIT_URL = `${BASE_URL}/ecrire/?exec=article_edit&new=oui`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv(DEFAULT_ENV_PATH);
  const password = getPassword(env);

  if (!password) {
    console.error(`❌ No se encontró KILOMBOTOP_PASSWORD en .env`);
    process.exit(1);
  }

  console.log('\nProbe D0 — verificando rubriques en www.kilombo.top');
  console.log('─'.repeat(55));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let liveOptions;

  try {
    await login(page, {
      password,
      targetUrl: EDIT_URL,
      expectedUrlIncludes: 'exec=article_edit',
    });

    // Extraer todas las opciones del <select name="id_parent">
    liveOptions = await page.$$eval('select[name="id_parent"] option', (opts) =>
      opts.map((o) => ({
        id:    o.value.trim(),
        label: o.textContent.replace(/\s+/g, ' ').trim(),
      }))
    );
  } finally {
    await browser.close();
  }

  // ── Todas las secciones disponibles en el sitio ──────────────────────────
  console.log(`\n${'ID'.padEnd(6)} Nombre en SPIP`);
  console.log('─'.repeat(55));
  for (const opt of liveOptions) {
    if (!opt.id) continue; // opción placeholder vacía
    console.log(`${opt.id.padEnd(6)} ${opt.label}`);
  }

  // ── Comparar con la tabla local ──────────────────────────────────────────
  const liveById = Object.fromEntries(liveOptions.filter((o) => o.id).map((o) => [o.id, o.label]));

  console.log('\n─'.repeat(55));
  console.log('Verificación de SLUG_TO_RUBRIQUE_ID\n');

  let allOk = true;

  for (const [slug, expectedId] of Object.entries(SLUG_TO_RUBRIQUE_ID)) {
    if (liveById[expectedId]) {
      console.log(`  ✅ ${slug.padEnd(12)} → ${expectedId.padEnd(4)} "${liveById[expectedId]}"`);
    } else {
      console.log(`  ❌ ${slug.padEnd(12)} → ${expectedId.padEnd(4)} ID NO ENCONTRADO en el sitio`);
      allOk = false;
    }
  }

  // ── IDs usados por varios slugs (aliasing intencional) ───────────────────
  const idCount = {};
  for (const id of Object.values(SLUG_TO_RUBRIQUE_ID)) {
    idCount[id] = (idCount[id] || 0) + 1;
  }
  const aliases = Object.entries(idCount).filter(([, n]) => n > 1);
  if (aliases.length > 0) {
    console.log('\n  ⚠️  Slugs que comparten rubrique (aliasing intencional):');
    for (const [id] of aliases) {
      const slugs = Object.entries(SLUG_TO_RUBRIQUE_ID)
        .filter(([, v]) => v === id)
        .map(([k]) => k)
        .join(', ');
      console.log(`     ID ${id}: ${slugs}`);
    }
  }

  console.log();

  if (allOk) {
    console.log('✅ Tabla SLUG_TO_RUBRIQUE_ID verificada — todos los IDs coinciden con el sitio.');
  } else {
    console.error('❌ Hay IDs que no coinciden. Actualizar SLUG_TO_RUBRIQUE_ID en spip-client.mjs.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ Error inesperado: ${err.message}`);
  process.exitCode = 1;
});
