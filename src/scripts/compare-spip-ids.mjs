#!/usr/bin/env node
// Simple helper: compare title and body of two SPIP articles via withSpipSession
import path from 'node:path';
import { fileURLToPath } from 'url';

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length < 2) {
    console.error('Usage: node src/scripts/compare-spip-ids.mjs <idA> <idB>');
    process.exit(2);
  }
  const [idA, idB] = ids;
  const { withSpipSession, BASE_URL } = await import('../lib/spip-session.mjs');

  await withSpipSession(async (page) => {
    async function fetchFor(id) {
      const url = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;
      process.stdout.write(`Navegando a ${url} ...\n`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // try common selectors
      const data = await page.evaluate(() => {
        const getVal = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
          return el.textContent;
        };
        const title = getVal('input[name="titre"]') || getVal('input#titre') || getVal('input[name="titre[0]"]') || '';
        const content = getVal('textarea[name="texte"]') || getVal('textarea#texte') || '';
        // fallback: find any element with class 'formulaire' and grab innerText
        const fallbackText = (content || '').trim() || (document.querySelector('.formulaire')?.innerText || '').trim();
        return { title: (title || '').trim(), content: (content || fallbackText || '').trim() };
      });
      return data;
    }

    const a = await fetchFor(idA);
    const b = await fetchFor(idB);

    function normalize(s) {
      return s.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    console.log('\n--- Result:');
    console.log(`ID ${idA} — title: "${a.title}" (len ${a.title.length}), content len ${a.content.length}`);
    console.log(`ID ${idB} — title: "${b.title}" (len ${b.title.length}), content len ${b.content.length}`);

    const titleSame = normalize(a.title) === normalize(b.title);
    const contentSame = normalize(a.content) === normalize(b.content);

    console.log('\nComparison:');
    console.log(`Titles identical: ${titleSame}`);
    console.log(`Contents identical: ${contentSame}`);

    if (!titleSame) {
      console.log('\nTitle diff preview:');
      console.log('A:', a.title.substring(0, 200));
      console.log('B:', b.title.substring(0, 200));
    }
    if (!contentSame) {
      console.log('\nContent diff preview (first 500 chars):');
      console.log('A:', a.content.substring(0, 500));
      console.log('B:', b.content.substring(0, 500));
    }

  }, { targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${idA}`, expectedUrlIncludes: 'exec=article' });
}

main().catch((err) => { console.error(err); process.exit(1); });
