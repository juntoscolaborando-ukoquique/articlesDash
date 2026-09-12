#!/usr/bin/env node
import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';

function cleanHtml(raw) {
  if (!raw) return '';
  let s = raw;
  s = s.replace(/<mark[^>]*>[\s\S]*?<\/mark>/gi, '');
  s = s.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<html[^>]*>/gi, '');
  s = s.replace(/<\/html>/gi, '');
  s = s.replace(/<body[^>]*>/gi, '');
  s = s.replace(/<\/body>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const id = process.argv[2];
if (!id) { console.error('Usage: node src/scripts/update-spip-article-edit.mjs <id>'); process.exit(2); }

await withSpipSession(async (page) => {
  const url = `${BASE_URL}/ecrire/?exec=article_edit&id_article=${id}`;
  console.log(`Opening ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1200);

  // Try to find textarea or editor source
  const found = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="texte"]');
    const hidden = document.querySelector('input[name="texte"]');
    const editor = document.querySelector('.markItUpEditor, .markItUp, .editer_texte');
    return {
      textareaExists: !!ta,
      textareaValue: ta ? ta.value : null,
      hiddenExists: !!hidden,
      hiddenValue: hidden ? hidden.value : null,
      editorHtml: editor ? editor.innerHTML.slice(0, 2000) : null,
    };
  });

  console.log('textareaExists:', found.textareaExists);
  if (found.textareaExists) console.log('textarea length:', (found.textareaValue||'').length);
  if (!found.textareaExists && found.hiddenExists) console.log('found hidden input for texte, length:', (found.hiddenValue||'').length);

  const source = found.textareaValue || found.hiddenValue || '';
  if (!source) {
    console.log('No source content found in textarea/hidden input — aborting.');
    return;
  }

  const cleaned = cleanHtml(source);
  if (cleaned === source.trim()) {
    console.log('No cleaning changes needed.');
    return;
  }

  // Set back the value and submit
  await page.evaluate((html) => {
    const ta = document.querySelector('textarea[name="texte"]');
    if (ta) {
      ta.value = html;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const hid = document.querySelector('input[name="texte"]');
      if (hid) hid.value = html;
    }
  }, cleaned);

  // Submit
  await page.evaluate(() => {
    const btn = document.querySelector('form input[type="submit"], form button[type="submit"]');
    if (btn) btn.click(); else {
      const f = document.querySelector('form'); if (f) f.submit();
    }
  });

  await page.waitForTimeout(2000);
  console.log('Update attempt completed — verify in admin UI.');
}, { targetUrl: `${BASE_URL}/ecrire/?exec=article_edit&id_article=${id}`, expectedUrlIncludes: 'exec=article_edit' });
