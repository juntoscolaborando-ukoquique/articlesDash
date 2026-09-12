#!/usr/bin/env node

/**
 * Detailed check for subtitle formatting issues
 * Looks for subtitles that might be incorrectly formatted as normal text lines
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ARTICLES_DIR = join(__dirname, '../../../articulos-READY/articles');

function analyzeSubtitleDetails(subtitle, title) {
  const issues = [];
  
  if (!subtitle || subtitle.trim() === '') {
    return { issues: ['Empty subtitle'], suggestions: ['Consider adding a descriptive subtitle'] };
  }
  
  // Check if subtitle looks like a continuation of title (starts with lowercase)
  if (subtitle.length > 0 && /^[a-z]/.test(subtitle)) {
    issues.push('Starts with lowercase (should start with uppercase)');
  }
  
  // Check if subtitle is too similar to title
  const titleWords = title.toLowerCase().split(/\s+/);
  const subtitleWords = subtitle.toLowerCase().split(/\s+/);
  const commonWords = titleWords.filter(word => subtitleWords.includes(word));
  if (commonWords.length > 3) {
    issues.push('Too similar to title (shares many common words)');
  }
  
  // Check if subtitle looks like a sentence (ends with period)
  if (subtitle.trim().endsWith('.')) {
    issues.push('Ends with period (subtitles usually don\'t end with punctuation)');
  }
  
  // Check if subtitle contains multiple sentences (has multiple periods)
  const periodCount = (subtitle.match(/\./g) || []).length;
  if (periodCount > 1) {
    issues.push('Contains multiple sentences (too detailed for a subtitle)');
  }
  
  // Check if subtitle is very long and detailed
  if (subtitle.length > 100 && periodCount > 0) {
    issues.push('Long and sentence-like (may be too detailed for a subtitle)');
  }
  
  // Check for common subtitle patterns that might indicate issues
  if (subtitle.includes(' - ') || subtitle.includes(' – ')) {
    issues.push('Contains dash separator (might be formatting issue)');
  }
  
  // Check if subtitle looks like it should be in chapo or descriptif
  if (subtitle.length > 80 && subtitle.includes(':')) {
    issues.push('Long with colon (might be better as descriptif or chapo)');
  }
  
  const suggestions = [];
  if (issues.includes('Starts with lowercase (should start with uppercase)')) {
    suggestions.push('Capitalize first letter of subtitle');
  }
  if (issues.includes('Ends with period (subtitles usually don\'t end with punctuation)')) {
    suggestions.push('Remove trailing period');
  }
  if (issues.includes('Contains multiple sentences (too detailed for a subtitle)')) {
    suggestions.push('Simplify to a single descriptive phrase');
  }
  if (issues.includes('Long and sentence-like (may be too detailed for a subtitle)')) {
    suggestions.push('Consider shortening or moving details to descriptif/chapo');
  }
  
  return { issues, suggestions };
}

async function checkAllArticles() {
  try {
    const files = await readdir(ARTICLES_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    console.log(`Checking ${jsonFiles.length} articles for subtitle details...\n`);
    
    const results = [];
    
    for (const file of jsonFiles) {
      try {
        const filePath = join(ARTICLES_DIR, file);
        const content = await readFile(filePath, 'utf8');
        const article = JSON.parse(content);
        
        const subtitle = article.soustitre || '';
        const title = article.title || '';
        const analysis = analyzeSubtitleDetails(subtitle, title);
        
        results.push({
          file,
          id: article.id,
          spipId: article.spipArticleId || 'N/A',
          title,
          subtitle,
          length: subtitle.length,
          analysis
        });
      } catch (error) {
        console.error(`Error processing ${file}:`, error.message);
      }
    }
    
    // Display results
    const articlesWithIssues = results.filter(r => r.analysis.issues.length > 0);
    
    console.log(`📊 Found ${articlesWithIssues.length} articles with potential subtitle formatting concerns:\n`);
    
    articlesWithIssues.forEach(result => {
      console.log(`📄 ${result.file} (${result.id})`);
      console.log(`   Title: ${result.title}`);
      console.log(`   Subtitle: "${result.subtitle}" (${result.length} chars)`);
      console.log(`   SPIP ID: ${result.spipId}`);
      console.log(`   Concerns:`);
      result.analysis.issues.forEach(issue => {
        console.log(`     - ${issue}`);
      });
      if (result.analysis.suggestions.length > 0) {
        console.log(`   Suggestions:`);
        result.analysis.suggestions.forEach(suggestion => {
          console.log(`     • ${suggestion}`);
        });
      }
      console.log();
    });
    
    // Also show articles without issues
    const articlesWithoutIssues = results.filter(r => r.analysis.issues.length === 0 && r.subtitle);
    if (articlesWithoutIssues.length > 0) {
      console.log(`✅ ${articlesWithoutIssues.length} articles have well-formatted subtitles:\n`);
      articlesWithoutIssues.forEach(result => {
        console.log(`   ${result.file}: "${result.subtitle.substring(0, 60)}${result.subtitle.length > 60 ? '...' : ''}"`);
      });
      console.log();
    }
    
    // Articles without subtitles
    const articlesWithoutSubtitles = results.filter(r => !r.subtitle || r.subtitle.trim() === '');
    if (articlesWithoutSubtitles.length > 0) {
      console.log(`📝 ${articlesWithoutSubtitles.length} articles are missing subtitles:\n`);
      articlesWithoutSubtitles.forEach(result => {
        console.log(`   ${result.file}: "${result.title}"`);
      });
    }
    
  } catch (error) {
    console.error('Error checking articles:', error);
  }
}

// Run check
if (import.meta.url === `file://${process.argv[1]}`) {
  checkAllArticles();
}