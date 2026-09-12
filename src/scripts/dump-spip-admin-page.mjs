#!/usr/bin/env node
import fs from 'node:fs';
const ids = process.argv.slice(2);
if (ids.length === 0) { console.error('Usage: node src/scripts/dump-spip-admin-page.mjs <id>...'); process.exit(2); }
const { withSpipSession, BASE_URL } = await import('../lib/spip-session.mjs');
await withSpipSession(async (page) => {
  for (const id of ids) {
    const url = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;
    process.stdout.write(`Navigating to ${url}...\n`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const html = await page.content();
    fs.writeFileSync(`tmp/spip-admin-${id}.html`, html, 'utf8');
    process.stdout.write(`Saved tmp/spip-admin-${id}.html (len ${html.length})\n`);
  }
}, { targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${ids[0]}`, expectedUrlIncludes: 'exec=article' });
