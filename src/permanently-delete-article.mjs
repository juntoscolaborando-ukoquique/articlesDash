#!/usr/bin/env node
/**
 * permanently-delete-article.mjs — CLI para borrado permanente de un artículo
 * en SPIP. Adaptador delgado sobre src/lib/spip-admin.mjs.
 *
 * Si el artículo no está en "poubelle", el script lo mueve automáticamente
 * antes de proceder al borrado permanente. No es necesario correr
 * manage-article-status.mjs primero.
 *
 * npm equivalente:
 *   npm run delete-article -- --id <id>
 */

import readline from 'node:readline';
import { permanentlyDelete, inspectArticleStatus, changeArticleStatus } from './lib/spip-admin.mjs';

function parseArgs(argv) {
  const args = { id: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id')      args.id = argv[++i];
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 's');
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.id) {
    console.error(`
Uso:
  node src/permanently-delete-article.mjs --id <spip_id> [--dry-run]

Si el artículo no está en la papelera, se moverá automáticamente a "poubelle"
antes de proceder al borrado permanente.
    `);
    process.exit(1);
  }

  try {
    // Auto-mover a poubelle si no está ya en la papelera
    const { currentStatus } = await inspectArticleStatus(args.id);
    const alreadyInTrash = currentStatus === 'A la papelera';

    if (!alreadyInTrash) {
      console.log(`\nArtículo ${args.id} está en estado "${currentStatus}".`);

      if (!args.dryRun) {
        const confirmed = await askConfirmation(
          `¿Mover a papelera y borrar permanentemente? [s/N] `
        );
        if (!confirmed) {
          console.log('Operación cancelada.');
          return;
        }
      }

      console.log(`Moviendo a papelera…`);
      if (!args.dryRun) {
        const moveResult = await changeArticleStatus(args.id, 'poubelle');
        if (!moveResult.success) {
          console.error(`❌ No se pudo mover el artículo ${args.id} a la papelera.`);
          process.exitCode = 1;
          return;
        }
        console.log(`✓ Movido a papelera.`);
      } else {
        console.log(`[DRY RUN] Movería artículo ${args.id} a papelera.`);
      }
    }

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
