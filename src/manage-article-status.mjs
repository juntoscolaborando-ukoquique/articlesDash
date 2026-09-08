#!/usr/bin/env node
/**
 * manage-article-status.mjs — CLI para inspeccionar o cambiar el estado de un
 * artículo en SPIP. Adaptador delgado sobre src/lib/spip-admin.mjs.
 *
 * Uso:
 *   node src/manage-article-status.mjs --inspect --id <spip_id>
 *   node src/manage-article-status.mjs --change --id <spip_id> --status <estado> [--dry-run]
 *
 * Estados válidos: prepa | prop | publie | refuse | poubelle
 *
 * Para borrado permanente, primero mover a papelera:
 *   node src/manage-article-status.mjs --change --id <id> --status poubelle
 *   node src/permanently-delete-article.mjs --id <id>
 */

import {
  inspectArticleStatus,
  changeArticleStatus,
  VALID_SPIP_STATUSES,
} from './lib/spip-admin.mjs';

function parseArgs(argv) {
  const args = { mode: null, id: null, status: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inspect')       args.mode = 'inspect';
    else if (a === '--change')   args.mode = 'change';
    else if (a === '--id')       args.id = argv[++i];
    else if (a === '--status')   args.status = argv[++i];
    else if (a === '--dry-run')  args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.mode || !args.id) {
    console.error(`
Uso:
  Inspeccionar estado actual:
    node src/manage-article-status.mjs --inspect --id <id>

  Cambiar estado:
    node src/manage-article-status.mjs --change --id <id> --status <estado> [--dry-run]

Estados válidos:
${Object.entries(VALID_SPIP_STATUSES).map(([k, v]) => `  ${k.padEnd(9)} — ${v}`).join('\n')}
    `);
    process.exit(1);
  }

  if (args.mode === 'change' && !args.status) {
    console.error(`Error: --status es requerido con --change`);
    console.error(`Válidos: ${Object.keys(VALID_SPIP_STATUSES).join(', ')}`);
    process.exit(1);
  }

  // Gate de seguridad: publicar directamente requiere confirmación explícita
  if (args.mode === 'change' && args.status === 'publie' && !process.env.KILO_APPROVE_PUBLISHING) {
    console.error('\n⚠️  Publicar directamente requiere aprobación explícita.\n');
    console.error(`  KILO_APPROVE_PUBLISHING=true node src/manage-article-status.mjs --change --id ${args.id} --status publie`);
    process.exit(1);
  }

  try {
    if (args.mode === 'inspect') {
      const result = await inspectArticleStatus(args.id);
      console.log(`\nEstado actual: ${result.currentStatus}\n`);
      console.log('Opciones disponibles:');
      result.availableOptions.forEach((opt) => {
        console.log(`  [${opt.checked ? '✓' : ' '}] ${opt.value.padEnd(9)} — ${opt.label}`);
      });
    } else {
      const result = await changeArticleStatus(args.id, args.status, { dryRun: args.dryRun });
      if (result.dryRun) {
        console.log(`[DRY RUN] Cambiaría artículo ${args.id} a estado "${args.status}"`);
      } else if (result.success) {
        console.log(`✅ Artículo ${args.id} → estado "${result.finalStatus}"`);
        if (!result.dialogAccepted) {
          console.log('⚠️  No se detectó diálogo de confirmación — verificar en SPIP.');
        }
      } else {
        console.error(`❌ Falló el cambio de estado`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
