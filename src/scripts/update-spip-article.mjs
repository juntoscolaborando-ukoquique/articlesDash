#!/usr/bin/env node
import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';

function cleanHtml(raw) {
  if (!raw) return '';
  let s = raw;
  // Remove dangerous/diagnostic markers
  s = s.replace(/<mark[^>]*>[\s\S]*?<\/mark>/gi, '');
  // Remove <code> blocks that contain escaped HTML or diagnostics
  s = s.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, '');
  // Remove entire <head> / <style> sections
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Strip outer html/body tags
  s = s.replace(/<html[^>]*>/gi, '');
  s = s.replace(/<\/html>/gi, '');
  s = s.replace(/<body[^>]*>/gi, '');
  s = s.replace(/<\/body>/gi, '');
  // Remove any inline scripts
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Collapse multiple blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const id = process.argv[2];
if (!id) {
  console.error('Usage: node src/scripts/update-spip-article.mjs <id>');
  process.exit(2);
}

await withSpipSession(async (page) => {
  const url = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;
  console.log(`Opening ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1000);

  // Get current title and texte
  const current = await page.evaluate(() => {
    const title = (document.querySelector('input[name="titre"]') || {}).value || '';
    const textarea = document.querySelector('textarea[name="texte"]');
    const texte = textarea ? textarea.value : '';
    return { title, texte };
  });

  console.log('Current title:', current.title || '(empty)');
  if (!current.texte) console.log('Current body appears empty in textarea.');

  const cleaned = cleanHtml(current.texte || '');
  if (cleaned === (current.texte || '').trim()) {
    console.log('No changes required after cleaning.');
    return;
  }

  console.log('Applying cleaned content (first 300 chars):');
  console.log(cleaned.slice(0, 300).replace(/\n/g, '\\n'));

  // Fill the textarea and submit the form
  await page.evaluate((html) => {
    const ta = document.querySelector('textarea[name="texte"]');
    if (ta) {
      ta.value = html;
      // trigger input events if the editor listens to them
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, cleaned);

  // Submit: try clicking the primary submit button in the form
  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('form input[type="submit"], form button[type="submit"]');
    if (btn) {
      btn.click();
      return true;
    }
    const form = document.querySelector('form');
    if (form) {
      form.submit();
      return true;
    }
    return false;
  });

  if (!submitted) {
    throw new Error('No form submit target found on the edit page.');
  }

  // Wait a bit for the save to complete
  await page.waitForTimeout(3000);
  console.log('Update submitted; check the admin UI to confirm changes.');
}, { targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${id}`, expectedUrlIncludes: 'exec=article' });
