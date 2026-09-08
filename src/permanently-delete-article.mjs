#!/usr/bin/env node
/**
 * permanently-delete-article.mjs — CLI para borrado permanente de un artículo
 * desde la papelera de SPIP. Adaptador delgado sobre src/lib/spip-admin.mjs.
 *
 * El artículo DEBE estar en estado "poubelle" antes de correr este script:
 *   node src/manage-article-status.mjs --change --id <id> --status poubelle
 *   node src/permanently-delete-article.mjs --id <id>
 *
 * npm equivalentes:
 *   npm run status -- --change --id <id> --status poubelle
 *   npm run delete-article -- --id <id>
 */

import { permanentlyDelete } from './lib/spip-admin.mjs';

function parseArgs(argv) {
  const args = { id: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id')      args.id = argv[++i];
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.id) {
    console.error(`
Uso:
  node src/permanently-delete-article.mjs --id <spip_id> [--dry-run]

El artículo DEBE estar en "poubelle" primero:
  npm run status -- --change --id <id> --status poubelle
  npm run delete-article -- --id <id>
    `);
    process.exit(1);
  }

  try {
    const result = await permanentlyDelete(args.id, { dryRun: args.dryRun });
    if (result.dryRun) {
      console.log(`[DRY RUN] Borraría permanentemente el artículo ${args.id} de la papelera SPIP`);
    } else if (result.success) {
      console.log(`✅ Artículo ${args.id} borrado permanentemente.`);
    } else {
      console.error(`⚠️  El artículo ${args.id} sigue apareciendo en la papelera tras el intento.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
