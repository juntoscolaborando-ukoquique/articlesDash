#!/usr/bin/env node

/**
 * Update subtitle (soustitre) field in existing SPIP articles
 */

import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';

async function updateSubtitle(page, articleId, newSubtitle) {
  const url = `${BASE_URL}/ecrire/?exec=article&id_article=${articleId}`;
  console.log(`Opening article ${articleId}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1000);
  
  // Get current subtitle
  const currentSubtitle = await page.evaluate(() => {
    const input = document.querySelector('input[name="soustitre"]');
    return input ? input.value : '';
  });
  
  console.log(`Current subtitle: "${currentSubtitle}"`);
  console.log(`New subtitle: "${newSubtitle}"`);
  
  if (currentSubtitle === newSubtitle) {
    console.log('Subtitle unchanged, skipping update.');
    return false;
  }
  
  // Update the subtitle field
  await page.evaluate((subtitle) => {
    const input = document.querySelector('input[name="soustitre"]');
    if (input) {
      input.value = subtitle;
      // Trigger change event
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, newSubtitle);
  
  // Try to submit the form
  const submitted = await page.evaluate(() => {
    // Look for submit button
    const submitBtn = document.querySelector('input[type="submit"][name="modif"]');
    if (submitBtn) {
      submitBtn.click();
      return true;
    }
    
    // Alternative: find any submit button
    const anySubmit = document.querySelector('input[type="submit"], button[type="submit"]');
    if (anySubmit) {
      anySubmit.click();
      return true;
    }
    
    // Last resort: submit the form
    const form = document.querySelector('form');
    if (form) {
      form.submit();
      return true;
    }
    
    return false;
  });
  
  if (submitted) {
    console.log('Form submitted. Waiting for save...');
    await page.waitForTimeout(3000);
    return true;
  } else {
    console.error('Could not find submit button/form');
    return false;
  }
}

// Main execution
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node src/scripts/update-spip-subtitle.mjs <articleId> "<new subtitle>"');
  console.error('Example: node src/scripts/update-spip-subtitle.mjs 100 "Análisis crítico de la gestión institucional"');
  process.exit(1);
}

const articleId = args[0];
const newSubtitle = args[1];

await withSpipSession(async (page) => {
  const success = await updateSubtitle(page, articleId, newSubtitle);
  if (success) {
    console.log(`✅ Subtitle updated for article ${articleId}`);
  } else {
    console.log(`⚠️  Could not update subtitle for article ${articleId}`);
  }
}, { 
  targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${articleId}`,
  expectedUrlIncludes: 'exec=article'
});