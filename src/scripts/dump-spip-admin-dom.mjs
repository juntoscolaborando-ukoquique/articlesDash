#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';

const id = process.argv[2];
if (!id) { console.error('Usage: node src/scripts/dump-spip-admin-dom.mjs <id>'); process.exit(2); }

const out = path.join('tmp', `${id}_admin_dump.html`);
await withSpipSession(async (page) => {
  const url = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;
  console.log(`Opening ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1000);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  fs.writeFileSync(out, html, 'utf8');
  console.log('Wrote', out);
}, { targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${id}`, expectedUrlIncludes: 'exec=article' });
