#!/usr/bin/env node
// find-duplicate-spip-articles.mjs
// Scans the audit log for SPIP-created articles, fetches their admin pages,
// extracts title and body, and reports identical or highly similar articles.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG = path.join(__dirname, '..', '..', 'live-write-audit.log.jsonl');
const ARTICLES_DIR = path.join(__dirname, '..', '..', 'articles');
const OUT = path.join(__dirname, '..', '..', 'tmp', 'spip-duplicates-report.json');

function readAudit() {
  if (!fs.existsSync(AUDIT_LOG)) return [];
  return fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

function normalize(s = '') {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokens(s = '') {
  return new Set(normalize(s).split(/\W+/).filter(Boolean));
}

function jaccard(aSet, bSet) {
  const a = [...aSet];
  const b = [...bSet];
  const inter = a.filter((x) => bSet.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

async function fetchSpipPages(spipIds) {
  const { withSpipSession, BASE_URL } = await import('../../src/lib/spip-session.mjs');
  const results = new Map();
  await withSpipSession(async (page) => {
    for (const id of spipIds) {
      const url = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;
      process.stdout.write(`Fetching ${url} ...\n`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
        const data = await page.evaluate(() => {
          const getText = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return '';
            return el.textContent || el.value || '';
          };
          const title = getText('.titre') || getText('h1') || getText('input[name="titre"]') || '';
          const body = getText('.texte') || getText('textarea[name="texte"]') || '';
          return { title: title.trim(), body: body.trim() };
        });
        results.set(String(id), data);
      } catch (err) {
        results.set(String(id), { error: String(err) });
      }
    }
  }, { targetUrl: `${BASE_URL}/ecrire/?exec=article&id_article=${spipIds[0]}`, expectedUrlIncludes: 'exec=article' });
  return results;
}

function readLocalArticles() {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  return fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf8'));
      return { file: f, id: data.id, title: data.title || '', content: data.contentHtml || '', spipArticleId: data.spipArticleId || null };
    } catch (e) { return { file: f, error: String(e) }; }
  });
}

async function main() {
  const entries = readAudit();
  const creates = entries.filter((e) => e.action === 'article.create' && e.result === 'success');
  const deletes = entries.filter((e) => e.action === 'article.delete.permanent' && e.result === 'success');
  const deletedSet = new Set(deletes.map((d) => String(d.target?.id)));

  // unique SPIP IDs from creates, excluding deleted
  const spipIds = [...new Set(creates.map((c) => String(c.articleId)))].filter((id) => !deletedSet.has(id));

  if (spipIds.length === 0) {
    console.log('No SPIP-created articles found in audit log.');
    return;
  }

  const pages = await fetchSpipPages(spipIds);

  // build compareable records
  const records = [];
  for (const id of spipIds) {
    const val = pages.get(String(id));
    if (!val) continue;
    if (val.error) {
      records.push({ id: String(id), error: val.error });
    } else {
      const titleN = normalize(val.title);
      const bodyN = normalize(val.body);
      records.push({ id: String(id), title: val.title, body: val.body, titleN, bodyN, titleTokens: tokens(val.title), bodyTokens: tokens(val.body) });
    }
  }

  // compare all pairs
  const duplicates = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i], b = records[j];
      if (a.error || b.error) continue;
      const titleSim = jaccard(a.titleTokens, b.titleTokens);
      const bodySim = jaccard(a.bodyTokens, b.bodyTokens);
      if (titleSim >= 0.95 && bodySim >= 0.9) {
        duplicates.push({ a: a.id, b: b.id, titleSim, bodySim });
      }
    }
  }

  const local = readLocalArticles();
  const localMatches = [];
  for (const r of records) {
    if (r.error) continue;
    for (const l of local) {
      if (l.error) continue;
      const sim = jaccard(tokens(r.body), tokens(l.content));
      if (sim >= 0.9) {
        localMatches.push({ spipId: r.id, localFile: l.file, sim });
      }
    }
  }

  const report = { generatedAt: new Date().toISOString(), duplicates, localMatches, recordsCount: records.length, localCount: local.length };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('Report written to', OUT);
  console.log('Summary:', report);
}

main().catch((err) => { console.error(err); process.exitCode = 2; });
