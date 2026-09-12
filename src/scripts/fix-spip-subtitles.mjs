#!/usr/bin/env node

/**
 * Fix subtitle formatting issues in SPIP articles
 * Identifies articles with missing or problematic subtitles and creates corrected versions
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ARTICLES_DIR = join(__dirname, '../../../articulos-READY/articles');
const execAsync = promisify(exec);

// Helper to extract SPIP article
async function extractArticle(id) {
  try {
    const { stdout } = await execAsync(`node src/scripts/extract-spip-article.mjs ${id}`, {
      cwd: join(__dirname, '..', '..')
    });
    
    // Parse the JSON output (it might have logs before the JSON)
    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) return null;
    
    const jsonStr = stdout.substring(jsonStart);
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error(`Error extracting article ${id}:`, error.message);
    return null;
  }
}

// Analyze subtitle and suggest improvements
function analyzeAndFixSubtitle(articleData) {
  const { titre, soustitre, texte, descriptif, chapo } = articleData;
  
  // If subtitle exists and looks OK, keep it
  if (soustitre && soustitre.trim() && soustitre.length > 10 && soustitre.length < 120) {
    return soustitre; // Keep existing
  }
  
  // Generate subtitle based on content
  let suggestedSubtitle = '';
  
  // Try to extract from descriptif first
  if (descriptif && descriptif.trim()) {
    const desc = descriptif.trim();
    if (desc.length < 120) {
      suggestedSubtitle = desc;
    } else {
      // Take first sentence
      const firstSentence = desc.split(/[.!?]/)[0];
      if (firstSentence && firstSentence.length < 120) {
        suggestedSubtitle = firstSentence;
      }
    }
  }
  
  // If no descriptif, try chapo
  if (!suggestedSubtitle && chapo && chapo.trim()) {
    const chapoText = chapo.replace(/<[^>]+>/g, ' ').trim();
    if (chapoText.length < 120) {
      suggestedSubtitle = chapoText.substring(0, 100);
    }
  }
  
  // If still no subtitle, generate from title or content
  if (!suggestedSubtitle) {
    if (titre && titre.trim()) {
      // For generic titles, create descriptive subtitle
      const genericTitles = ['Algo más sobre', 'Nota sobre', 'Artículo sobre', 'Informe'];
      const isGeneric = genericTitles.some(prefix => titre.includes(prefix));
      
      if (isGeneric && texte) {
        // Extract first meaningful sentence from text
        const cleanText = texte.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const firstSentence = cleanText.split(/[.!?]/)[0];
        if (firstSentence && firstSentence.length > 20 && firstSentence.length < 120) {
          suggestedSubtitle = firstSentence;
        }
      }
      
      // If still no subtitle, create one based on title
      if (!suggestedSubtitle) {
        suggestedSubtitle = `Análisis y contexto sobre "${titre.substring(0, 40)}${titre.length > 40 ? '...' : ''}"`;
      }
    } else {
      suggestedSubtitle = 'Artículo de análisis y documentación';
    }
  }
  
  // Clean up the subtitle
  suggestedSubtitle = suggestedSubtitle.trim();
  if (suggestedSubtitle.endsWith('.')) {
    suggestedSubtitle = suggestedSubtitle.slice(0, -1);
  }
  
  // Capitalize first letter
  if (suggestedSubtitle.length > 0) {
    suggestedSubtitle = suggestedSubtitle.charAt(0).toUpperCase() + suggestedSubtitle.slice(1);
  }
  
  return suggestedSubtitle;
}

// Create article JSON from SPIP data
function createArticleJson(articleData, spipId) {
  const {
    titre,
    surtitre,
    texte,
    descriptif,
    chapo,
    ps,
    nom_site,
    url_site,
    date,
    lang,
    auteur
  } = articleData;
  
  // Generate ID from title
  const id = titre ? 
    titre.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with dashes
      .replace(/^-+|-+$/g, '') // Trim dashes
      .substring(0, 50) : 
    `spip-article-${spipId}`;
  
  // Determine section based on content (simplified)
  const section = 'nom'; // Default section
  
  // Determine language
  const language = lang === 'FR' ? 'FR' : 'ES';
  
  // Create article object
  const article = {
    _schema_version: '1.0',
    id,
    language,
    section,
    title: titre || `Artículo SPIP ${spipId}`,
    soustitre: analyzeAndFixSubtitle(articleData),
    descriptif: descriptif || '',
    chapo: chapo || '',
    contentHtml: texte || '',
    ps: ps || '',
    author: auteur || '',
    sourceSite: nom_site || '',
    sourceUrl: url_site || '',
    date: date?.iso || '2026-09-12',
    topics: [],
    status: 'prepa',
    workflowStatus: 'terminado',
    notes: `Extraído y corregido desde SPID ID ${spipId}. Subtítulo añadido/mejorado.`,
    spipArticleId: spipId.toString()
  };
  
  return article;
}

async function fixSpipArticles() {
  console.log('Buscando artículos SPIP con problemas de subtítulos...\n');
  
  // Check SPIP articles 100-110 (smaller range to avoid timeout)
  const articlesToFix = [];
  
  for (let id = 100; id <= 110; id++) {
    console.log(`Comprobando artículo ${id}...`);
    const articleData = await extractArticle(id);
    
    if (articleData && articleData.titre) {
      // Check if subtitle needs fixing
      const needsFix = !articleData.soustitre || 
                      articleData.soustitre.trim() === '' || 
                      articleData.soustitre.length < 10 ||
                      articleData.soustitre.length > 150;
      
      if (needsFix) {
        console.log(`  ✅ Necesita corrección: "${articleData.titre}"`);
        articlesToFix.push({ id, data: articleData });
      } else {
        console.log(`  ✓ OK: "${articleData.titre}"`);
      }
    } else if (articleData && !articleData.titre) {
      console.log(`  - Vacío o sin título`);
    } else {
      console.log(`  - Error o no accesible`);
    }
  }
  
  console.log(`\nEncontrados ${articlesToFix.length} artículos que necesitan corrección de subtítulos:\n`);
  
  // Process each article
  for (const { id, data } of articlesToFix) {
    console.log(`\n📝 Procesando artículo ${id}: "${data.titre || 'Sin título'}"`);
    
    // Create corrected article
    const correctedArticle = createArticleJson(data, id);
    const filename = `${correctedArticle.id}.json`;
    const filepath = join(ARTICLES_DIR, filename);
    
    // Check if file already exists
    try {
      await readFile(filepath);
      console.log(`  ⚠️  Archivo ya existe: ${filename}`);
    } catch {
      // File doesn't exist, create it
      await writeFile(filepath, JSON.stringify(correctedArticle, null, 2));
      console.log(`  ✅ Creado: ${filename}`);
      console.log(`     Título: ${correctedArticle.title}`);
      console.log(`     Subtítulo: "${correctedArticle.soustitre}"`);
      console.log(`     Notas: ${correctedArticle.notes}`);
    }
  }
  
  // Summary
  console.log('\n📊 RESUMEN:');
  console.log(`   Artículos SPIP comprobados: 100-110 (11 artículos)`);
  console.log(`   Artículos que necesitan corrección: ${articlesToFix.length}`);
  console.log(`   Archivos creados/corregidos: ${articlesToFix.length}`);
  
  if (articlesToFix.length > 0) {
    console.log('\n💡 SIGUIENTES PASOS:');
    console.log('   1. Revisar los archivos JSON creados en la carpeta articles/');
    console.log('   2. Ejecutar validación: node src/lib/article-validator.mjs');
    console.log('   3. Publicar artículos corregidos: node src/publish-article.mjs <archivo>');
    console.log('   4. Verificar en SPIP que los subtítulos se hayan actualizado correctamente');
  }
}

// Run the fix
if (import.meta.url === `file://${process.argv[1]}`) {
  fixSpipArticles();
}