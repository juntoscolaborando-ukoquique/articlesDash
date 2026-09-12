#!/usr/bin/env node

/**
 * Update article fields (surtitre, soustitre, descriptif) in SPIP articles
 * More robust and flexible than the simple subtitle updater
 */

import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';
import { readFile } from 'fs/promises';

// Field definitions for SPIP articles
const FIELD_DEFINITIONS = {
  surtitre: {
    selector: 'input[name="surtitre"], textarea[name="surtitre"]',
    description: 'Surtitre (text above title)',
    maxLength: 100
  },
  soustitre: {
    selector: 'input[name="soustitre"], textarea[name="soustitre"]',
    description: 'Subtítulo (subtitle)',
    maxLength: 150
  },
  descriptif: {
    selector: 'textarea[name="descriptif"]',
    description: 'Descriptif (short description for listings)',
    maxLength: 300
  },
  titre: {
    selector: 'input[name="titre"]',
    description: 'Título principal',
    maxLength: 200
  }
};

// Validate field value
function validateField(fieldName, value) {
  const definition = FIELD_DEFINITIONS[fieldName];
  if (!definition) {
    return { valid: false, error: `Unknown field: ${fieldName}` };
  }
  
  if (value === undefined || value === null) {
    return { valid: false, error: `Value required for ${fieldName}` };
  }
  
  const strValue = String(value).trim();
  
  if (strValue.length === 0) {
    return { valid: true, value: strValue, warning: 'Empty value (will clear field)' };
  }
  
  if (definition.maxLength && strValue.length > definition.maxLength) {
    return { 
      valid: false, 
      error: `${fieldName} too long: ${strValue.length} chars (max ${definition.maxLength})` 
    };
  }
  
  // Check for problematic HTML
  if (/<[^>]+>/g.test(strValue) && fieldName !== 'descriptif') {
    return { 
      valid: false, 
      error: `${fieldName} contains HTML tags (not allowed for this field)` 
    };
  }
  
  return { valid: true, value: strValue };
}

// Get current field values
async function getCurrentFields(page) {
  return await page.evaluate((definitions) => {
    const result = {};
    for (const [fieldName, def] of Object.entries(definitions)) {
      const element = document.querySelector(def.selector);
      result[fieldName] = {
        exists: !!element,
        value: element ? element.value : null,
        elementType: element ? element.tagName.toLowerCase() : null
      };
    }
    return result;
  }, FIELD_DEFINITIONS);
}

// Update field values
async function updateFields(page, updates) {
  const updateResults = {};
  
  for (const [fieldName, newValue] of Object.entries(updates)) {
    const definition = FIELD_DEFINITIONS[fieldName];
    if (!definition) {
      updateResults[fieldName] = { success: false, error: `Unknown field: ${fieldName}` };
      continue;
    }
    
    const updated = await page.evaluate(({ fieldName, selector, value }) => {
      const element = document.querySelector(selector);
      if (!element) {
        return { success: false, error: `Element not found for ${fieldName}` };
      }
      
      const oldValue = element.value;
      element.value = value;
      
      // Trigger events
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      return { 
        success: true, 
        oldValue, 
        newValue: value,
        changed: oldValue !== value
      };
    }, { fieldName, selector: definition.selector, value: newValue });
    
    updateResults[fieldName] = updated;
  }
  
  return updateResults;
}

// Submit the form
async function submitForm(page) {
  return await page.evaluate(() => {
    // Try different submit strategies
    const strategies = [
      () => {
        const btn = document.querySelector('input[type="submit"][name="modif"]');
        if (btn) { btn.click(); return true; }
        return false;
      },
      () => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) { btn.click(); return true; }
        return false;
      },
      () => {
        const btn = document.querySelector('input[type="submit"]');
        if (btn) { btn.click(); return true; }
        return false;
      },
      () => {
        const form = document.querySelector('form');
        if (form) { form.submit(); return true; }
        return false;
      }
    ];
    
    for (const strategy of strategies) {
      if (strategy()) {
        return { success: true, strategy: strategy.name || 'unknown' };
      }
    }
    
    return { success: false, error: 'No submit method found' };
  });
}

// Main update function
async function updateArticleFields(articleId, fieldUpdates) {
  console.log(`\n📝 Updating article ${articleId}...`);
  
  // Validate all updates first
  const validatedUpdates = {};
  const errors = [];
  
  for (const [fieldName, value] of Object.entries(fieldUpdates)) {
    const validation = validateField(fieldName, value);
    if (!validation.valid) {
      errors.push(`${fieldName}: ${validation.error}`);
    } else {
      if (validation.warning) {
        console.log(`⚠️  ${fieldName}: ${validation.warning}`);
      }
      validatedUpdates[fieldName] = validation.value;
    }
  }
  
  if (errors.length > 0) {
    console.error('❌ Validation errors:');
    errors.forEach(error => console.error(`  - ${error}`));
    return { success: false, errors };
  }
  
  if (Object.keys(validatedUpdates).length === 0) {
    console.log('⚠️  No valid updates to apply');
    return { success: false, error: 'No valid updates' };
  }
  
  console.log(`Fields to update: ${Object.keys(validatedUpdates).join(', ')}`);
  
  let success = false;
  await withSpipSession(async (page) => {
    const url = `${BASE_URL}/ecrire/?exec=article_edit&id_article=${articleId}`;
    console.log(`Opening ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(2000); // Longer wait for AJAX fields to load
    
    // Get current field values
    const currentFields = await getCurrentFields(page);
    console.log('\nCurrent field values:');
    for (const [fieldName, info] of Object.entries(currentFields)) {
      if (info.exists) {
        const preview = info.value ? `"${info.value.substring(0, 60)}${info.value.length > 60 ? '...' : ''}"` : '(empty)';
        console.log(`  ${fieldName}: ${preview} (${info.value?.length || 0} chars)`);
      } else if (fieldName in validatedUpdates) {
        console.log(`  ${fieldName}: ❌ Field not found in form`);
      }
    }
    
    // Update fields
    console.log('\nUpdating fields...');
    const updateResults = await updateFields(page, validatedUpdates);
    
    let anyChanges = false;
    for (const [fieldName, result] of Object.entries(updateResults)) {
      if (result.success) {
        if (result.changed) {
          console.log(`  ✅ ${fieldName}: Updated`);
          anyChanges = true;
        } else {
          console.log(`  ⚠️  ${fieldName}: No change needed`);
        }
      } else {
        console.log(`  ❌ ${fieldName}: ${result.error}`);
      }
    }
    
    if (!anyChanges) {
      console.log('No changes to save');
      success = true; // Technically successful, just no changes
      return;
    }
    
    // Submit form
    console.log('\nSubmitting changes...');
    const submitResult = await submitForm(page);
    
    if (submitResult.success) {
      console.log(`✅ Form submitted using ${submitResult.strategy}`);
      await page.waitForTimeout(3000);
      success = true;
    } else {
      console.error(`❌ Failed to submit form: ${submitResult.error}`);
      success = false;
    }
    
  }, { 
    targetUrl: `${BASE_URL}/ecrire/?exec=article_edit&id_article=${articleId}`,
    expectedUrlIncludes: 'exec=article_edit'
  });
  
  return { success };
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help') {
    showHelp();
    process.exit(0);
  }
  
  // Check for JSON file input
  if (args[0].endsWith('.json')) {
    return { mode: 'json', file: args[0] };
  }
  
  // Direct field updates
  if (args.length >= 3) {
    const articleId = args[0];
    const updates = {};
    
    for (let i = 1; i < args.length; i += 2) {
      const field = args[i];
      const value = args[i + 1];
      
      if (value === undefined) {
        console.error(`❌ Missing value for field: ${field}`);
        process.exit(1);
      }
      
      // Remove quotes if present
      const cleanValue = value.replace(/^["']|["']$/g, '');
      updates[field] = cleanValue;
    }
    
    return { mode: 'direct', articleId, updates };
  }
  
  console.error('❌ Invalid arguments');
  showHelp();
  process.exit(1);
}

function showHelp() {
  console.log(`
Update SPIP Article Fields
==========================

Usage:
  1. Update fields directly:
     node src/scripts/update-article-fields.mjs <articleId> <field1> "<value1>" [<field2> "<value2>" ...]
     
     Example:
     node src/scripts/update-article-fields.mjs 100 soustitre "Nuevo subtítulo" descriptif "Breve descripción"
  
  2. Update from JSON file:
     node src/scripts/update-article-fields.mjs <article-file.json>
     
     The JSON file should contain the article data with spipArticleId field.

Available fields:
  - titre: Main title
  - surtitre: Text above title (max 100 chars)
  - soustitre: Subtitle (max 150 chars)
  - descriptif: Short description for listings (max 300 chars)

Notes:
  - Fields with HTML tags are rejected (except descriptif which may contain limited HTML)
  - Empty values will clear the field
  - The script will show current values before updating
`);
}

// Process JSON file
async function processJsonFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    const article = JSON.parse(content);
    
    if (!article.spipArticleId) {
      console.error('❌ JSON file must contain spipArticleId field');
      process.exit(1);
    }
    
    const updates = {};
    if (article.soustitre !== undefined) updates.soustitre = article.soustitre;
    if (article.surtitre !== undefined) updates.surtitre = article.surtitre;
    if (article.descriptif !== undefined) updates.descriptif = article.descriptif;
    if (article.title !== undefined) updates.titre = article.title;
    
    return {
      articleId: article.spipArticleId,
      updates,
      source: `JSON file: ${filePath}`
    };
  } catch (error) {
    console.error(`❌ Error reading JSON file: ${error.message}`);
    process.exit(1);
  }
}

// Main execution
async function main() {
  const args = parseArgs();
  
  if (args.mode === 'json') {
    const { articleId, updates, source } = await processJsonFile(args.file);
    console.log(`📄 Processing ${source}`);
    const result = await updateArticleFields(articleId, updates);
    
    if (result.success) {
      console.log(`\n✅ Article ${articleId} updated successfully from JSON file`);
    } else {
      console.log(`\n❌ Failed to update article ${articleId}`);
      if (result.errors) console.log('Errors:', result.errors);
    }
    
  } else if (args.mode === 'direct') {
    const result = await updateArticleFields(args.articleId, args.updates);
    
    if (result.success) {
      console.log(`\n✅ Article ${args.articleId} updated successfully`);
    } else {
      console.log(`\n❌ Failed to update article ${args.articleId}`);
      if (result.errors) console.log('Errors:', result.errors);
    }
  }
}

// Run main
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}