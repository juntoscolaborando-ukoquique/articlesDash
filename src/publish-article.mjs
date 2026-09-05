#!/usr/bin/env node
/**
 * src/publish-article.mjs
 *
 * Punto de entrada principal del proyecto articulos-READY.
 * Lee un archivo JSON, lo valida y lo publica en www.kilombo.top
 * dejándolo en estado "en preparación" para revisión humana.
 *
 * MODOS DE USO:
 *
 *   Publicar un artículo:
 *     node src/publish-article.mjs articles/mi-articulo.json
 *
 *   Dry-run (rellena el formulario pero no crea nada en la BD):
 *     node src/publish-article.mjs articles/mi-articulo.json --dry-run
 *
 *   Solo validar el JSON sin abrir el browser:
 *     node src/publish-article.mjs articles/mi-articulo.json --validate-only
 *
 * REQUISITOS:
 *   - Archivo .env en la raíz del proyecto con KILOMBOTOP_PASSWORD
 *   - Playwright instalado: npm install && npx playwright install chromium
 *
 * RESULTADO:
 *   El artículo queda en SPIP con estado "en preparación" (prepa).
 *   Nunca se publica directamente. La publicación final la hace un humano
 *   desde el panel de SPIP en /ecrire/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidArticle } from './lib/article-validator.mjs';
// SPIPClient se importa de forma lazy para que --validate-only no requiera Playwright

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const AUDIT_LOG_PATH = path.join(PROJECT_ROOT, 'live-write-audit.log.jsonl');

// ── Consulta del audit log ────────────────────────────────────────────────────

/**
 * Busca en el audit log la entrada más reciente de `article.create` exitosa
 * para el artículo con el ID dado. Usado como ledger secundario cuando el
 * write-back al JSON falla o cuando el JSON no tiene spipArticleId.
 *
 * @param {string} articleId - el campo `id` del artículo (slug)
 * @returns {{ articleId: string, publishedAt: string, url: string } | null}
 */
function findAuditEntry(articleId) {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return null;

  let lastMatch = null;
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry.action === 'article.create' &&
        entry.result === 'success' &&
        entry.target?.id === articleId &&
        entry.articleId
      ) {
        lastMatch = {
          articleId:   entry.articleId,
          publishedAt: entry.timestamp,
          url: `https://www.kilombo.top/ecrire/?exec=article&id_article=${entry.articleId}`,
        };
      }
    } catch {
      // línea malformada — ignorar
    }
  }

  return lastMatch;
}

// ── Write-back de resultado ───────────────────────────────────────────────────

/**
 * Escribe spipArticleId, publishedAt y publishedUrl de vuelta al archivo JSON
 * del artículo. Este es el marcador de idempotencia: si el script se vuelve a
 * correr sobre el mismo archivo, el chequeo al inicio detecta estos campos y
 * aborta antes de crear un duplicado en SPIP.
 *
 * Los campos se insertan al final del objeto para no romper la legibilidad del
 * JSON original. El archivo se sobreescribe en-place con formato 2-space indent.
 *
 * @param {string} absolutePath - ruta absoluta al archivo JSON del artículo
 * @param {object} article      - objeto artículo ya cargado en memoria
 * @param {{ articleId: string, url: string }} publishResult
 */
function writeBackResult(absolutePath, article, publishResult) {
  const updated = {
    ...article,
    spipArticleId: publishResult.articleId,
    publishedAt:   new Date().toISOString(),
    publishedUrl:  publishResult.url,
  };
  fs.writeFileSync(absolutePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    articlePath: null,
    dryRun: false,
    validateOnly: false,
    recoverFromLog: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--validate-only') args.validateOnly = true;
    else if (arg === '--recover-from-log') args.recoverFromLog = true;
    else if (!arg.startsWith('--')) args.articlePath = arg;
  }

  return args;
}

function printUsage() {
  console.error(
    'Uso:\n' +
      '  node src/publish-article.mjs <articulo.json> [--dry-run] [--validate-only]\n' +
      '\n' +
      'Opciones:\n' +
      '  --dry-run           Rellena el formulario pero no crea nada en la BD\n' +
      '  --validate-only     Solo valida el JSON, sin abrir el browser\n' +
      '  --recover-from-log  Si el JSON no tiene spipArticleId pero el audit log\n' +
      '                      registra una publicación exitosa para este artículo,\n' +
      '                      escribe el marcador de vuelta en el JSON y sale.\n' +
      '                      Usar solo cuando el write-back falló en una corrida\n' +
      '                      anterior. No publica nada nuevo.\n' +
      '\n' +
      'Ejemplo:\n' +
      '  node src/publish-article.mjs articles/mi-articulo.json\n' +
      '  node src/publish-article.mjs articles/mi-articulo.json --dry-run\n' +
      '\n' +
      'Con npm (recordar el "--" antes de la ruta):\n' +
      '  npm run validate -- articles/mi-articulo.json\n' +
      '  npm run publish -- articles/mi-articulo.json --dry-run\n' +
      '  npm run validate:example   # valida articles/example-article.json sin pasar ruta'
  );
}

// ── Carga y parseo del archivo JSON ───────────────────────────────────────────

function loadArticle(articlePath) {
  const absolutePath = path.resolve(articlePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Archivo no encontrado: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (ext !== '.json') {
    throw new Error(`El archivo debe tener extensión .json, encontrado: ${ext}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new Error(`No se pudo leer el archivo: ${err.message}`);
  }

  let article;
  try {
    article = JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON inválido en ${absolutePath}: ${err.message}`);
  }

  return { article, absolutePath };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.articlePath) {
    printUsage();
    process.exit(1);
  }

  // ── 1. Cargar el archivo JSON ─────────────────────────────────────────────
  let article, absolutePath;
  try {
    ({ article, absolutePath } = loadArticle(args.articlePath));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  console.log(`\nArticulo: ${path.basename(absolutePath)}`);
  console.log(`─`.repeat(50));

  // ── 1b. Chequeo de idempotencia ───────────────────────────────────────────
  // Si el artículo ya fue publicado, spipArticleId quedó escrito de vuelta en
  // el JSON. Abortar aquí evita crear un duplicado en SPIP.
  if (article.spipArticleId) {
    console.log(`\n⛔ Este artículo ya fue publicado.`);
    console.log(`   spipArticleId : ${article.spipArticleId}`);
    console.log(`   publishedAt   : ${article.publishedAt}`);
    if (article.publishedUrl) console.log(`   publishedUrl  : ${article.publishedUrl}`);
    console.log(`\n   Para re-publicar (p.ej. prueba manual), eliminar esos campos del JSON.`);
    process.exit(0);
  }

  // ── 1c. Recuperación manual desde el audit log ───────────────────────────
  // Solo actúa con --recover-from-log. Sin ese flag, esta sección no corre:
  // - --validate-only es read-only por contrato, no debe tocar el archivo.
  // - Una ejecución normal sin el flag respeta el flujo "borrar campos →
  //   republicar" documentado en el README.
  if (args.recoverFromLog) {
    const auditEntry = findAuditEntry(article.id);
    if (!auditEntry) {
      console.log(`\nℹ️  No se encontró entrada exitosa en el audit log para "${article.id}".`);
      console.log(`   No hay nada que recuperar.`);
      process.exit(0);
    }
    console.log(`\n⚠️  El audit log registra una publicación exitosa previa para "${article.id}":`);
    console.log(`   spipArticleId : ${auditEntry.articleId}`);
    console.log(`   publishedAt   : ${auditEntry.publishedAt}`);
    console.log(`   publishedUrl  : ${auditEntry.url}`);
    console.log(`\n   Escribiendo marcador de idempotencia en el JSON...`);
    try {
      writeBackResult(absolutePath, article, auditEntry);
      console.log(`   ✅ spipArticleId recuperado y escrito en ${path.basename(absolutePath)}.`);
      console.log(`\n⛔ Artículo marcado como publicado. Para re-publicar, eliminar spipArticleId del JSON.`);
    } catch (writeErr) {
      console.error(`   ❌ No se pudo escribir el marcador: ${writeErr.message}`);
      console.error(`   Agregar manualmente:`);
      console.error(`     "spipArticleId": "${auditEntry.articleId}",`);
      console.error(`     "publishedAt": "${auditEntry.publishedAt}",`);
      console.error(`     "publishedUrl": "${auditEntry.url}"`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── 2. Validar el schema ──────────────────────────────────────────────────
  console.log('Validando schema...');
  try {
    assertValidArticle(article, absolutePath);
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
  console.log('✅ Schema válido');

  // ── 2b. Aviso de campos aún no soportados por spip-client.mjs ─────────────
  // Ver docs/SCHEMA.md → "Mapeo completo JSON → SPIP" para el detalle de cada uno.
  // Se muestra siempre (también en --validate-only) para que se vea antes de publicar.
  // La lista de campos no implementados la mantiene spip-client.mjs (fuente de verdad).
  const { getUnimplementedFields } = await import('./lib/spip-client.mjs');
  const unimplementedFields = getUnimplementedFields(article);

  if (unimplementedFields.length > 0) {
    console.log(
      '\n⚠️  Este artículo trae campos que todavía NO se escriben en SPIP:\n' +
        unimplementedFields.map((f) => `     • ${f}`).join('\n') +
        '\n   Se van a validar pero se van a ignorar al publicar (ver docs/SCHEMA.md).'
    );
  }

  if (args.validateOnly) {
    console.log('\nModo --validate-only: finalizado sin publicar.');
    process.exit(0);
  }

  // ── 3. Resumen antes de publicar ──────────────────────────────────────────
  console.log('\nResumen del artículo:');
  console.log(`  ID:       ${article.id}`);
  console.log(`  Título:   ${article.title}`);
  if (article.surtitre)  console.log(`  Surtitre: ${article.surtitre}`);
  if (article.soustitre) console.log(`  Subtítulo: ${article.soustitre}`);
  console.log(`  Sección:  ${article.section}`);
  console.log(`  Idioma:   ${article.language}`);
  console.log(`  Fecha:    ${article.date || '(desconocida)'}`);
  console.log(`  Topics:   ${article.topics.join(', ')}`);
  if (args.dryRun) {
    console.log('\n⚠️  Modo DRY-RUN activado — no se creará nada en la BD');
  }

  // ── 4. Publicar ───────────────────────────────────────────────────────────
  console.log('\nIniciando publicación en www.kilombo.top...');
  console.log(`─`.repeat(50));

  // Import lazy: evita cargar Playwright cuando no es necesario (e.g. --validate-only)
  const { SPIPClient } = await import('./lib/spip-client.mjs');
  const client = new SPIPClient();
  const result = await client.publishArticle(article, { dryRun: args.dryRun });

  console.log(`─`.repeat(50));

  if (result.success) {
    if (result.dryRun) {
      console.log('\n✅ Dry-run completado. El formulario se rellenó correctamente.');
      console.log('   Ejecutar sin --dry-run para crear el artículo.');
    } else {
      console.log('\n✅ Artículo publicado en estado "en preparación"');
      if (result.articleId) {
        console.log(`   ID SPIP:  ${result.articleId}`);
        console.log(`   URL:      ${result.url}`);

        // Escribir de vuelta al JSON para que un segundo intento no duplique
        try {
          writeBackResult(absolutePath, article, result);
          console.log(`\n   ✍️  spipArticleId escrito en ${path.basename(absolutePath)}`);
        } catch (err) {
          console.error(`\n   ⚠️  No se pudo escribir el resultado en el JSON: ${err.message}`);
          console.error(`   El artículo fue creado (ID ${result.articleId}) pero el archivo`);
          console.error(`   no tiene el marcador de idempotencia.`);
          // Reintentar una vez — a veces el fallo es un lock transitorio del FS
          try {
            writeBackResult(absolutePath, article, result);
            console.error(`   ✅ Reintento exitoso — spipArticleId escrito.`);
          } catch (retryErr) {
            console.error(`   ❌ Reintento también falló: ${retryErr.message}`);
            console.error(`   Agregar manualmente al JSON antes de volver a correr el script:`);
            console.error(`     "spipArticleId": "${result.articleId}",`);
            console.error(`     "publishedAt": "${new Date().toISOString()}",`);
            console.error(`     "publishedUrl": "${result.url}"`);
            console.error(`   Si no se agrega, la próxima corrida puede crear un duplicado.`);
            console.error(`   Alternativamente: node src/publish-article.mjs ${args.articlePath} --recover-from-log`);
          }
        }
      }
      console.log('\n   Próximo paso: revisar y publicar desde /ecrire/ en kilombo.top');
    }
  } else {
    console.error(`\n❌ Error al publicar: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ Error inesperado: ${err.message}`);
  process.exitCode = 1;
});
