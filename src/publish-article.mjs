#!/usr/bin/env node
/**
 * src/publish-article.mjs
 *
 * Adaptador CLI para publishArticleUseCase().
 * Se encarga de: parsear args, leer el JSON del disco, llamar al use case,
 * imprimir el resultado en la terminal y salir con el código adecuado.
 *
 * Toda la lógica de negocio vive en src/lib/publish-use-case.mjs.
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
 *   Recuperar spipArticleId del audit log (cuando el write-back falló):
 *     node src/publish-article.mjs articles/mi-articulo.json --recover-from-log
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishArticleUseCase } from './lib/publish-use-case.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    articlePath:    null,
    dryRun:         false,
    validateOnly:   false,
    recoverFromLog: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run')           args.dryRun = true;
    else if (arg === '--validate-only')   args.validateOnly = true;
    else if (arg === '--recover-from-log') args.recoverFromLog = true;
    else if (!arg.startsWith('--'))       args.articlePath = arg;
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
    '                      registra una publicación exitosa, escribe el marcador\n' +
    '                      de vuelta en el JSON y sale. Usar solo cuando el\n' +
    '                      write-back falló en una corrida anterior.\n' +
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

// ── File loading ──────────────────────────────────────────────────────────────

function loadArticleFile(articlePath) {
  const absolutePath = path.resolve(articlePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Archivo no encontrado: ${absolutePath}`);
  }
  if (path.extname(absolutePath).toLowerCase() !== '.json') {
    throw new Error(`El archivo debe tener extensión .json`);
  }
  let article;
  try {
    article = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (err) {
    throw new Error(`JSON inválido en ${absolutePath}: ${err.message}`);
  }
  return { article, absolutePath };
}

// ── Result printer ────────────────────────────────────────────────────────────

function printResult(result, articlePath, articleBasename) {
  const sep = '─'.repeat(50);

  switch (result.status) {

    case 'already-published':
      console.log(`\n⛔ Este artículo ya fue publicado.`);
      console.log(`   spipArticleId : ${result.spipArticleId}`);
      console.log(`   publishedAt   : ${result.publishedAt}`);
      if (result.publishedUrl) console.log(`   publishedUrl  : ${result.publishedUrl}`);
      console.log(`\n   Para re-publicar (p.ej. prueba manual), eliminar esos campos del JSON.`);
      return 0;

    case 'recover-not-found':
      console.log(`\nℹ️  No se encontró entrada exitosa en el audit log para "${result.articleId}".`);
      console.log(`   No hay nada que recuperar.`);
      return 0;

    case 'recovered':
      console.log(`\n⚠️  El audit log registra una publicación exitosa previa:`);
      console.log(`   spipArticleId : ${result.spipArticleId}`);
      console.log(`   publishedAt   : ${result.publishedAt}`);
      console.log(`   publishedUrl  : ${result.publishedUrl}`);
      if (result.writeBackFailed) {
        console.error(`\n   ❌ No se pudo escribir el marcador: ${result.writeBackError}`);
        console.error(`   Agregar manualmente al JSON:`);
        console.error(`     "spipArticleId": "${result.spipArticleId}",`);
        console.error(`     "publishedAt": "${result.publishedAt}",`);
        console.error(`     "publishedUrl": "${result.publishedUrl}"`);
        return 1;
      }
      console.log(`\n   ✅ spipArticleId recuperado y escrito en ${articleBasename}.`);
      console.log(`\n⛔ Artículo marcado como publicado. Para re-publicar, eliminar spipArticleId del JSON.`);
      return 0;

    case 'invalid':
      console.error(`\n❌ ${result.validationError}`);
      return 1;

    case 'valid':
      if (result.unimplementedFields?.length) {
        console.log(
          '\n⚠️  Este artículo trae campos que todavía NO se escriben en SPIP:\n' +
          result.unimplementedFields.map((f) => `     • ${f}`).join('\n') +
          '\n   Se van a validar pero se van a ignorar al publicar (ver docs/SCHEMA.md).'
        );
      }
      console.log('\nModo --validate-only: finalizado sin publicar.');
      return 0;

    case 'dry-run':
      if (result.unimplementedFields?.length) {
        console.log(
          '\n⚠️  Campos no implementados:\n' +
          result.unimplementedFields.map((f) => `     • ${f}`).join('\n')
        );
      }
      console.log('\n✅ Dry-run completado. El formulario se rellenó correctamente.');
      console.log('   Ejecutar sin --dry-run para crear el artículo.');
      return 0;

    case 'published':
      if (result.unimplementedFields?.length) {
        console.log(
          '\n⚠️  Campos no implementados (ignorados al publicar):\n' +
          result.unimplementedFields.map((f) => `     • ${f}`).join('\n')
        );
      }
      console.log('\n✅ Artículo publicado en estado "en preparación"');
      console.log(`   ID SPIP:  ${result.spipArticleId}`);
      console.log(`   URL:      ${result.publishedUrl}`);
      console.log(`\n   ✍️  spipArticleId escrito en ${articleBasename}`);
      console.log('\n   Próximo paso: revisar y publicar desde /ecrire/ en kilombo.top');
      return 0;

    case 'published-no-writeback':
      if (result.unimplementedFields?.length) {
        console.log(
          '\n⚠️  Campos no implementados (ignorados al publicar):\n' +
          result.unimplementedFields.map((f) => `     • ${f}`).join('\n')
        );
      }
      console.log('\n✅ Artículo publicado en estado "en preparación"');
      console.log(`   ID SPIP:  ${result.spipArticleId}`);
      console.log(`   URL:      ${result.publishedUrl}`);
      console.error(`\n   ⚠️  No se pudo escribir el resultado en el JSON: ${result.writeBackError}`);
      console.error(`   El artículo fue creado (ID ${result.spipArticleId}) pero el archivo`);
      console.error(`   no tiene el marcador de idempotencia.`);
      console.error(`   Agregar manualmente al JSON antes de volver a correr el script:`);
      console.error(`     "spipArticleId": "${result.spipArticleId}",`);
      console.error(`     "publishedAt": "${result.publishedAt}",`);
      console.error(`     "publishedUrl": "${result.publishedUrl}"`);
      console.error(`   O recuperar automáticamente:`);
      console.error(`     ${result.recoverCommand}`);
      return 1;

    case 'error':
      console.error(`\n❌ Error al publicar: ${result.error}`);
      return 1;

    default:
      console.error(`\n❌ Estado desconocido: ${result.status}`);
      return 1;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.articlePath) {
    printUsage();
    process.exit(1);
  }

  let article, absolutePath;
  try {
    ({ article, absolutePath } = loadArticleFile(args.articlePath));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const basename = path.basename(absolutePath);
  console.log(`\nArticulo: ${basename}`);
  console.log('─'.repeat(50));

  // Print article summary before calling use case — doesn't depend on result
  if (!args.validateOnly && !args.recoverFromLog && !article.spipArticleId) {
    console.log('\nResumen del artículo:');
    console.log(`  ID:       ${article.id}`);
    console.log(`  Título:   ${article.title}`);
    if (article.surtitre)  console.log(`  Surtitre: ${article.surtitre}`);
    if (article.soustitre) console.log(`  Subtítulo: ${article.soustitre}`);
    console.log(`  Sección:  ${article.section}`);
    console.log(`  Idioma:   ${article.language}`);
    console.log(`  Fecha:    ${article.date || '(desconocida)'}`);
    if (article.topics?.length) console.log(`  Topics:   ${article.topics.join(', ')}`);
    if (args.dryRun) {
      console.log('\n⚠️  Modo DRY-RUN activado — no se creará nada en la BD');
    }
  }

  const result = await publishArticleUseCase(article, {
    dryRun:         args.dryRun,
    validateOnly:   args.validateOnly,
    recoverFromLog: args.recoverFromLog,
    absolutePath:   absolutePath,
  });

  if (result.status === 'valid') console.log('✅ Schema válido');

  const exitCode = printResult(result, args.articlePath, basename);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`\n❌ Error inesperado: ${err.message}`);
  process.exitCode = 1;
});
