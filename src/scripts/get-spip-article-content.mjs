#!/usr/bin/env node
const id = process.argv[2];
if (!id) { console.error('Usage: node get-spip-article-content.mjs <id>'); process.exit(2); }
const { withSpipSession, BASE_URL } = await import('../lib/spip-session.mjs');
await withSpipSession(async (page) => {
  const url = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;
  process.stdout.write(`Opening ${url}...\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  const data = await page.evaluate(() => {
    const titleEl = document.querySelector('.titre') || document.querySelector('h1') || document.querySelector('input[name="titre"]');
    const bodyEl = document.querySelector('.texte') || document.querySelector('textarea[name="texte"]') || document.querySelector('.formulaire');
    return {
      titleText: titleEl ? (titleEl.textContent || titleEl.value || '') : '',
      titleHtml: titleEl ? (titleEl.innerHTML || '') : '',
      bodyText: bodyEl ? (bodyEl.textContent || '') : '',
      bodyHtml: bodyEl ? (bodyEl.innerHTML || '') : '',
    };
  });
  console.log('--- TITLE (text) ---');
  console.log(data.titleText.slice(0,1000));
  console.log('--- BODY (first 2000 chars of HTML) ---');
  console.log(data.bodyHtml.slice(0,2000));
}, { targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${id}`, expectedUrlIncludes: 'exec=article' });
