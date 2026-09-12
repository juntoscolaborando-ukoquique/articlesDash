#!/usr/bin/env node

/**
 * Batch update subtitles for multiple SPIP articles
 * Uses the improved update-article-fields script
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ARTICLES_DIR = join(__dirname, '../../../articulos-READY/articles');
const execAsync = promisify(exec);

// Analyze article and suggest subtitle improvements
function analyzeAndSuggestSubtitle(article) {
  const { title, soustitre, descriptif, chapo, contentHtml } = article;
  
  // If subtitle exists and is decent, keep it
  if (soustitre && soustitre.trim() && soustitre.length >= 10 && soustitre.length <= 150) {
    return null; // No change needed
  }
  
  let suggestion = '';
  
  // Priority 1: Use descriptif if it exists and is good
  if (descriptif && descriptif.trim()) {
    const desc = descriptif.trim();
    if (desc.length >= 20 && desc.length <= 150) {
      suggestion = desc;
    } else {
      // Take first sentence
      const firstSentence = desc.split(/[.!?]/)[0];
      if (firstSentence && firstSentence.length >= 20 && firstSentence.length <= 150) {
        suggestion = firstSentence;
      }
    }
  }
  
  // Priority 2: Generate from title if it's generic
  if (!suggestion && title) {
    const genericPatterns = [
      /^algo más sobre/i,
      /^nota sobre/i,
      /^artículo sobre/i,
      /^informe sobre/i,
      /^comentario sobre/i,
      /^reflexiones sobre/i
    ];
    
    const isGeneric = genericPatterns.some(pattern => pattern.test(title));
    
    if (isGeneric) {
      // Create more descriptive subtitle
      const cleanTitle = title.replace(/^(algo más sobre|nota sobre|artículo sobre|informe sobre|comentario sobre|reflexiones sobre)/i, '').trim();
      suggestion = `Análisis detallado sobre ${cleanTitle}`;
    }
  }
  
  // Priority 3: Extract from content
  if (!suggestion && contentHtml) {
    const text = contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const sentences = text.split(/[.!?]/);
    if (sentences.length > 1) {
      const firstMeaningful = sentences.find(s => s.trim().length > 30 && s.trim().length < 120);
      if (firstMeaningful) {
        suggestion = firstMeaningful.trim();
      }
    }
  }
  
  // Priority 4: Generic subtitle
  if (!suggestion) {
    if (title) {
      suggestion = `Análisis y contexto sobre "${title.substring(0, 40)}${title.length > 40 ? '...' : ''}"`;
    } else {
      suggestion = 'Artículo de análisis y documentación';
    }
  }
  
  // Clean up suggestion
  suggestion = suggestion.trim();
  if (suggestion.endsWith('.')) {
    suggestion = suggestion.slice(0, -1);
  }
  
  // Capitalize first letter
  if (suggestion.length > 0) {
    suggestion = suggestion.charAt(0).toUpperCase() + suggestion.slice(1);
  }
  
  // Limit length
  if (suggestion.length > 150) {
    suggestion = suggestion.substring(0, 147) + '...';
  }
  
  return suggestion;
}

// Update single article using the update script
async function updateArticleSubtitle(articleId, newSubtitle) {
  try {
    const command = `node src/scripts/update-article-fields.mjs ${articleId} soustitre "${newSubtitle.replace(/"/g, '\\"')}"`;
    const { stdout, stderr } = await execAsync(command, {
      cwd: join(__dirname, '..', '..')
    });
    
    return {
      success: !stderr || stderr.trim() === '',
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout?.toString().trim() || '',
      stderr: error.stderr?.toString().trim() || ''
    };
  }
}

// Process all articles
async function processAllArticles() {
  console.log('🔍 Analyzing all articles for subtitle issues...\n');
  
  const files = await readdir(ARTICLES_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  
  const results = [];
  const articlesToUpdate = [];
  
  for (const file of jsonFiles) {
    try {
      const filePath = join(ARTICLES_DIR, file);
      const content = await readFile(filePath, 'utf8');
      const article = JSON.parse(content);
      
      if (!article.spipArticleId) {
        console.log(`  ⏭️  ${file}: No SPIP ID (not published)`);
        continue;
      }
      
      const analysis = analyzeAndSuggestSubtitle(article);
      
      if (analysis === null) {
        console.log(`  ✅ ${file} (SPIP ${article.spipArticleId}): Subtitle OK`);
        results.push({
          file,
          spipId: article.spipArticleId,
          status: 'ok',
          currentSubtitle: article.soustitre || '(empty)'
        });
      } else {
        console.log(`  🔧 ${file} (SPIP ${article.spipArticleId}): Needs update`);
        console.log(`     Current: "${article.soustitre || '(empty)'}"`);
        console.log(`     Suggested: "${analysis}"`);
        
        articlesToUpdate.push({
          file,
          spipId: article.spipArticleId,
          currentSubtitle: article.soustitre || '',
          suggestedSubtitle: analysis
        });
        
        results.push({
          file,
          spipId: article.spipArticleId,
          status: 'needs_update',
          currentSubtitle: article.soustitre || '(empty)',
          suggestedSubtitle: analysis
        });
      }
      
    } catch (error) {
      console.error(`  ❌ ${file}: Error - ${error.message}`);
      results.push({
        file,
        status: 'error',
        error: error.message
      });
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`   Total articles: ${jsonFiles.length}`);
  console.log(`   With SPIP IDs: ${results.filter(r => r.spipId).length}`);
  console.log(`   Need subtitle updates: ${articlesToUpdate.length}`);
  
  if (articlesToUpdate.length === 0) {
    console.log('\n✅ All articles have proper subtitles!');
    return;
  }
  
  // Ask for confirmation
  console.log('\n⚠️  The following articles need subtitle updates:');
  articlesToUpdate.forEach((article, index) => {
    console.log(`   ${index + 1}. ${article.file} (SPIP ${article.spipId})`);
    console.log(`      From: "${article.currentSubtitle}"`);
    console.log(`      To:   "${article.suggestedSubtitle}"`);
  });
  
  console.log('\nProceed with updates? (yes/no)');
  
  // For automated execution, we'll proceed after a brief pause
  // In interactive mode, you would read from stdin
  console.log('Auto-proceeding in 3 seconds...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Perform updates
  console.log('\n🔄 Updating articles...\n');
  
  const updateResults = [];
  for (const article of articlesToUpdate) {
    console.log(`Updating ${article.file} (SPIP ${article.spipId})...`);
    
    const result = await updateArticleSubtitle(article.spipId, article.suggestedSubtitle);
    
    if (result.success) {
      console.log(`  ✅ Success`);
      updateResults.push({
        file: article.file,
        spipId: article.spipId,
        success: true,
        newSubtitle: article.suggestedSubtitle
      });
      
      // Update local JSON file
      try {
        const filePath = join(ARTICLES_DIR, article.file);
        const content = await readFile(filePath, 'utf8');
        const articleData = JSON.parse(content);
        articleData.soustitre = article.suggestedSubtitle;
        articleData.notes = (articleData.notes || '') + ` Subtítulo actualizado el ${new Date().toISOString().split('T')[0]}.`;
        await writeFile(filePath, JSON.stringify(articleData, null, 2));
        console.log(`  ✅ Local file updated`);
      } catch (error) {
        console.log(`  ⚠️  Could not update local file: ${error.message}`);
      }
      
    } else {
      console.log(`  ❌ Failed: ${result.error || result.stderr}`);
      updateResults.push({
        file: article.file,
        spipId: article.spipId,
        success: false,
        error: result.error || result.stderr
      });
    }
    
    // Brief pause between updates
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Final summary
  console.log('\n📊 Update Summary:');
  const successful = updateResults.filter(r => r.success).length;
  const failed = updateResults.filter(r => !r.success).length;
  
  console.log(`   Successful: ${successful}`);
  console.log(`   Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\n❌ Failed updates:');
    updateResults.filter(r => !r.success).forEach(r => {
      console.log(`   - ${r.file} (SPIP ${r.spipId}): ${r.error}`);
    });
  }
  
  console.log('\n💡 Next steps:');
  console.log('   1. Verify updates in SPIP admin interface');
  console.log('   2. Check that local JSON files have been updated');
  console.log('   3. Run validation: node src/lib/article-validator.mjs');
}

// Helper function (missing from imports)
async function writeFile(path, content) {
  const fs = await import('fs/promises');
  return fs.writeFile(path, content, 'utf8');
}

// Run batch processing
if (import.meta.url === `file://${process.argv[1]}`) {
  processAllArticles().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}