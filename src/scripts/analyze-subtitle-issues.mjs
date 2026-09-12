#!/usr/bin/env node

/**
 * Analyze subtitle formatting issues in SPIP articles
 * Detects obvious problems: HTML tags, overly long subtitles, subtitles that should be content
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ARTICLES_DIR = join(__dirname, '../../../articulos-READY/articles');

// Criteria for problematic subtitles
const ISSUE_TYPES = {
  HTML_TAGS: 'Contains HTML tags',
  TOO_LONG: 'Too long (over 150 characters)',
  CONTAINS_MARKDOWN: 'Contains markdown-like formatting',
  CONTAINS_URL: 'Contains URL (should be in contentHtml or ps)',
  EMPTY: 'Empty subtitle (not a problem but noted)',
  LIKELY_CONTENT: 'Looks like it should be contentHtml (long, detailed)',
  SPECIAL_CHARS: 'Contains unusual special characters'
};

function analyzeSubtitle(subtitle) {
  if (!subtitle || subtitle.trim() === '') {
    return { issue: ISSUE_TYPES.EMPTY, severity: 'info' };
  }

  const issues = [];
  
  // Check for HTML tags
  const htmlRegex = /<[^>]+>/;
  if (htmlRegex.test(subtitle)) {
    issues.push({ issue: ISSUE_TYPES.HTML_TAGS, severity: 'high' });
  }
  
  // Check length
  if (subtitle.length > 150) {
    issues.push({ issue: ISSUE_TYPES.TOO_LONG, severity: 'medium' });
  }
  
  // Check for ellipsis pattern (may indicate cut-off text)
  if (subtitle.includes('...') || subtitle.endsWith('...')) {
    issues.push({ issue: 'Contains ellipsis (may be cut-off text)', severity: 'low' });
  }
  
  // Check for markdown
  const markdownRegex = /[*_`#\[\]()]/;
  if (markdownRegex.test(subtitle)) {
    issues.push({ issue: ISSUE_TYPES.CONTAINS_MARKDOWN, severity: 'low' });
  }
  
  // Check for URLs
  const urlRegex = /(https?:\/\/|www\.)/i;
  if (urlRegex.test(subtitle)) {
    issues.push({ issue: ISSUE_TYPES.CONTAINS_URL, severity: 'medium' });
  }
  
  // Check if it looks like content (detailed description)
  if (subtitle.length > 100 && subtitle.includes('. ')) {
    issues.push({ issue: ISSUE_TYPES.LIKELY_CONTENT, severity: 'medium' });
  }
  
  // Check for unusual special characters
  const specialCharRegex = /[<>{}|\\^~\[\]]/;
  if (specialCharRegex.test(subtitle)) {
    issues.push({ issue: ISSUE_TYPES.SPECIAL_CHARS, severity: 'low' });
  }
  
  return issues.length > 0 ? issues : null;
}

async function analyzeAllArticles() {
  try {
    const files = await readdir(ARTICLES_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    console.log(`Analyzing ${jsonFiles.length} articles for subtitle issues...\n`);
    
    const results = [];
    
    for (const file of jsonFiles) {
      try {
        const filePath = join(ARTICLES_DIR, file);
        const content = await readFile(filePath, 'utf8');
        const article = JSON.parse(content);
        
        const subtitle = article.soustitre || '';
        const issues = analyzeSubtitle(subtitle);
        
        if (issues || subtitle) {
          results.push({
            file,
            id: article.id,
            spipId: article.spipArticleId || 'N/A',
            subtitle,
            issues,
            title: article.title || 'No title'
          });
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error.message);
      }
    }
    
    // Display results
    let totalIssues = 0;
    const articlesWithIssues = results.filter(r => r.issues && r.issues.length > 0);
    
    if (articlesWithIssues.length === 0) {
      console.log('✅ No subtitle formatting issues found in any articles!');
      console.log('\nSummary of all subtitles:');
      results.forEach(r => {
        console.log(`  ${r.file} (${r.id}):`);
        console.log(`    Title: ${r.title}`);
        console.log(`    Subtitle: "${r.subtitle}" (${r.subtitle.length} chars)`);
        console.log(`    SPIP ID: ${r.spipId}`);
        console.log();
      });
      return;
    }
    
    console.log(`⚠️ Found ${articlesWithIssues.length} articles with subtitle issues:\n`);
    
    articlesWithIssues.forEach(result => {
      console.log(`📄 ${result.file} (${result.id})`);
      console.log(`   Title: ${result.title}`);
      console.log(`   Subtitle: "${result.subtitle}"`);
      console.log(`   SPIP ID: ${result.spipId}`);
      console.log(`   Issues:`);
      
      result.issues.forEach(issue => {
        if (Array.isArray(issue)) {
          issue.forEach(i => {
            console.log(`     - ${i.severity.toUpperCase()}: ${i.issue}`);
            totalIssues++;
          });
        } else {
          console.log(`     - ${issue.severity.toUpperCase()}: ${issue.issue}`);
          totalIssues++;
        }
      });
      console.log();
    });
    
    // Summary
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Total articles analyzed: ${jsonFiles.length}`);
    console.log(`   Articles with issues: ${articlesWithIssues.length}`);
    console.log(`   Total issues found: ${totalIssues}`);
    
    // Recommendations
    console.log(`\n💡 RECOMMENDATIONS:`);
    articlesWithIssues.forEach(result => {
      console.log(`   ${result.file}:`);
      if (result.issues.some(i => (Array.isArray(i) ? i.some(ii => ii.issue === ISSUE_TYPES.HTML_TAGS) : i.issue === ISSUE_TYPES.HTML_TAGS))) {
        console.log(`     - Remove HTML tags from subtitle`);
      }
      if (result.issues.some(i => (Array.isArray(i) ? i.some(ii => ii.issue === ISSUE_TYPES.TOO_LONG) : i.issue === ISSUE_TYPES.TOO_LONG))) {
        console.log(`     - Consider shortening subtitle (${result.subtitle.length} chars)`);
      }
      if (result.issues.some(i => (Array.isArray(i) ? i.some(ii => ii.issue === ISSUE_TYPES.LIKELY_CONTENT) : i.issue === ISSUE_TYPES.LIKELY_CONTENT))) {
        console.log(`     - Subtitle may be too detailed; move to contentHtml if appropriate`);
      }
    });
    
  } catch (error) {
    console.error('Error analyzing articles:', error);
  }
}

// Run analysis
if (import.meta.url === `file://${process.argv[1]}`) {
  analyzeAllArticles();
}