/**
 * test/server.test.mjs
 *
 * Route-level integration tests for src/server.mjs.
 *
 * Spins up a real http.Server on a random port, makes actual HTTP requests,
 * and asserts on status codes + JSON bodies. Uses a temp directory for
 * articles so the real articles/ folder is never touched.
 *
 * Coverage focus (the routes that were broken and caught only by manual curl):
 *   POST /api/articles/:id/send-to-revision  — Edición → En Progreso
 *   PUT  /api/articles/:id/fields            — save structured fields
 *   POST /api/articles/:id/promote           — En Progreso → Terminado
 *
 * Plus the supporting routes they depend on, and key error paths.
 *
 * USO:
 *   node --test
 *   node --test test/server.test.mjs
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Temp articles dir ─────────────────────────────────────────────────────────
// Each test run gets a fresh directory. ARTICLES_DIR_OVERRIDE must be set
// before importing server.mjs (which imports articles-store.mjs at load time).

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kilombo-test-'));
process.env.ARTICLES_DIR_OVERRIDE = TMP_DIR;

// ── Import app after env var is set ──────────────────────────────────────────
const { app } = await import('../src/server.mjs');

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server;
let BASE;

before(() => new Promise((resolve) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    BASE = `http://127.0.0.1:${port}`;
    resolve();
  });
}));

after(() => new Promise((resolve, reject) => {
  server.close((err) => {
    // Clean up temp dir regardless
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    err ? reject(err) : resolve();
  });
}));

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const url = BASE + path;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  const res = await fetch(url, {
    ...opts,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const GET    = (p)       => api('GET',  p);
const POST   = (p, b)    => api('POST', p, b);
const PUT    = (p, b)    => api('PUT',  p, b);
const DELETE = (p)       => api('DELETE', p);

// ── Article fixtures ──────────────────────────────────────────────────────────

function validArticleJson(overrides = {}) {
  return {
    _schema_version: '1.0',
    id:              'test-articulo',
    language:        'ES',
    section:         'nom',
    title:           'Título de prueba',
    descriptif:      'Resumen de prueba.',
    contentHtml:     '<p>Cuerpo de prueba.</p>',
    date:            '2026-01-01',
    topics:          ['tema-uno', 'tema-dos'],
    status:          'prepa',
    workflowStatus:  'edicion',
    ...overrides,
  };
}

/**
 * Writes an article JSON file into the temp dir and returns its id.
 * Each test that needs a fresh article should call this.
 */
function seedArticle(overrides = {}) {
  const article = validArticleJson(overrides);
  const filepath = path.join(TMP_DIR, `${article.id}.json`);
  fs.writeFileSync(filepath, JSON.stringify(article, null, 2) + '\n', 'utf8');
  return article.id;
}

/**
 * Reads the current JSON for an article from the temp dir.
 */
function readArticle(id) {
  const files = fs.readdirSync(TMP_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const a = JSON.parse(fs.readFileSync(path.join(TMP_DIR, f), 'utf8'));
    if (a.id === id) return a;
  }
  return null;
}

/**
 * Removes all .json files from the temp dir between tests that need isolation.
 */
function clearArticles() {
  for (const f of fs.readdirSync(TMP_DIR).filter((f) => f.endsWith('.json'))) {
    fs.unlinkSync(path.join(TMP_DIR, f));
  }
}

// ── Tests: GET /api/articles ──────────────────────────────────────────────────

describe('GET /api/articles', () => {
  before(() => clearArticles());

  test('returns empty list when no articles exist', async () => {
    const { status, data } = await GET('/api/articles');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.articles));
    assert.equal(data.articles.length, 0);
  });

  test('returns seeded article in list', async () => {
    seedArticle({ id: 'list-test' });
    const { status, data } = await GET('/api/articles');
    assert.equal(status, 200);
    assert.ok(data.articles.some((a) => a.id === 'list-test'));
  });
});

// ── Tests: GET /api/articles/:id ─────────────────────────────────────────────

describe('GET /api/articles/:id', () => {
  before(() => clearArticles());

  test('returns 404 for unknown id', async () => {
    const { status } = await GET('/api/articles/no-existe');
    assert.equal(status, 404);
  });

  test('returns full article for known id', async () => {
    seedArticle({ id: 'detail-test', title: 'Detalle de prueba' });
    const { status, data } = await GET('/api/articles/detail-test');
    assert.equal(status, 200);
    assert.equal(data.article.title, 'Detalle de prueba');
  });
});

// ── Tests: POST /api/articles (create draft) ─────────────────────────────────

describe('POST /api/articles', () => {
  before(() => clearArticles());

  test('creates a new draft and returns 201 with the article', async () => {
    const { status, data } = await POST('/api/articles', { title: 'Borrador nuevo' });
    assert.equal(status, 201);
    assert.ok(data.article.id);
    assert.equal(data.article.workflowStatus, 'edicion');
  });
});

// ── Tests: PUT /api/articles/:id/draft ───────────────────────────────────────

describe('PUT /api/articles/:id/draft', () => {
  beforeEach(() => clearArticles());

  test('saves title + text, converts text to contentHtml', async () => {
    const id = seedArticle({ id: 'draft-test' });
    const { status, data } = await PUT(`/api/articles/${id}/draft`, {
      title:   'Título actualizado',
      section: 'nom',
      text:    'Primer párrafo.\n\nSegundo párrafo.',
    });
    assert.equal(status, 200);
    assert.ok(data.success);

    const saved = readArticle(id);
    assert.equal(saved.title, 'Título actualizado');
    assert.ok(saved.contentHtml.includes('<p>Primer párrafo.</p>'));
    assert.ok(saved.contentHtml.includes('<p>Segundo párrafo.</p>'));
  });

  test('warns (but does not block) when pasted text looks like JSON', async () => {
    const id = seedArticle({ id: 'draft-json-paste' });
    const { status, data } = await PUT(`/api/articles/${id}/draft`, {
      title: 'T', section: 'nom',
      text: '{"foo":"bar"}',
    });
    assert.equal(status, 200);
    assert.ok(data.success);
    assert.ok(data.warning, 'debe incluir aviso de paste estructurado');
  });

  test('returns 404 for unknown article', async () => {
    const { status } = await PUT('/api/articles/no-existe/draft', { title: 'x', section: 'nom', text: 'x' });
    assert.equal(status, 404);
  });
});

// ── Tests: POST /api/articles/:id/send-to-revision ───────────────────────────
// This is the primary route being institutionalised — was broken silently before.

describe('POST /api/articles/:id/send-to-revision', () => {
  beforeEach(() => clearArticles());

  test('advances edicion → en-progreso and returns workflowStatus', async () => {
    const id = seedArticle({
      id: 'send-revision-ok',
      title: 'Título presente',
      section: 'nom',
      contentHtml: '<p>Contenido presente.</p>',
      workflowStatus: 'edicion',
    });
    const { status, data } = await POST(`/api/articles/${id}/send-to-revision`);
    assert.equal(status, 200);
    assert.equal(data.workflowStatus, 'en-progreso');

    const saved = readArticle(id);
    assert.equal(saved.workflowStatus, 'en-progreso');
  });

  test('splitter runs: extracts chapo when body has 2+ paragraphs', async () => {
    const id = seedArticle({
      id: 'splitter-chapo',
      title: 'T',
      section: 'nom',
      contentHtml: '<p>Bajada introductoria.</p>\n<p>Cuerpo principal del artículo.</p>',
      workflowStatus: 'edicion',
    });
    await POST(`/api/articles/${id}/send-to-revision`);

    const saved = readArticle(id);
    assert.equal(saved.chapo, '<p>Bajada introductoria.</p>');
    assert.ok(saved.contentHtml.includes('Cuerpo principal'));
    assert.ok(!saved.contentHtml.includes('Bajada introductoria'),
      'chapo must not remain in contentHtml');
  });

  test('splitter does not overwrite existing sourceUrl', async () => {
    const id = seedArticle({
      id: 'splitter-no-overwrite',
      title: 'T',
      section: 'nom',
      sourceUrl: 'https://ya-existe.example.com',
      contentHtml: '<p>Párrafo uno.</p>\n<p>Párrafo dos.</p>\n<p>Fuente: https://nueva.example.com</p>',
      workflowStatus: 'edicion',
    });
    await POST(`/api/articles/${id}/send-to-revision`);

    const saved = readArticle(id);
    assert.equal(saved.sourceUrl, 'https://ya-existe.example.com',
      'pre-existing sourceUrl must not be overwritten by splitter');
  });

  test('returns 422 when title is empty', async () => {
    const id = seedArticle({
      id: 'revision-no-title',
      title: '',
      section: 'nom',
      contentHtml: '<p>Contenido.</p>',
      workflowStatus: 'edicion',
    });
    const { status, data } = await POST(`/api/articles/${id}/send-to-revision`);
    assert.equal(status, 422);
    assert.ok(data.error);
  });

  test('returns 422 when section is empty', async () => {
    const id = seedArticle({
      id: 'revision-no-section',
      title: 'Título',
      section: '',
      contentHtml: '<p>Contenido.</p>',
      workflowStatus: 'edicion',
    });
    const { status, data } = await POST(`/api/articles/${id}/send-to-revision`);
    assert.equal(status, 422);
    assert.ok(data.error);
  });

  test('returns 422 when contentHtml is empty', async () => {
    const id = seedArticle({
      id: 'revision-no-content',
      title: 'Título',
      section: 'nom',
      contentHtml: '',
      workflowStatus: 'edicion',
    });
    const { status, data } = await POST(`/api/articles/${id}/send-to-revision`);
    assert.equal(status, 422);
    assert.ok(data.error);
  });

  test('returns 404 for unknown article', async () => {
    const { status } = await POST('/api/articles/no-existe/send-to-revision');
    assert.equal(status, 404);
  });
});

// ── Tests: PUT /api/articles/:id/fields ──────────────────────────────────────

describe('PUT /api/articles/:id/fields', () => {
  beforeEach(() => clearArticles());

  test('saves all editable fields and persists to disk', async () => {
    const id = seedArticle({ id: 'fields-save', workflowStatus: 'en-progreso' });
    const patch = {
      chapo:       '<p>Bajada editada.</p>',
      contentHtml: '<p>Cuerpo editado.</p>',
      ps:          '<p>PS editado.</p>',
      topics:      ['nuevo-tema', 'otro-tema'],
      date:        '2026-06-01',
      author:      'Autor Editado',
      sourceSite:  'Sitio Editado',
      sourceUrl:   'https://editado.example.com',
      sourceDate:  '2026-05-01',
    };
    const { status, data } = await PUT(`/api/articles/${id}/fields`, patch);
    assert.equal(status, 200);
    assert.ok(data.success);

    const saved = readArticle(id);
    assert.equal(saved.chapo, '<p>Bajada editada.</p>');
    assert.equal(saved.contentHtml, '<p>Cuerpo editado.</p>');
    assert.equal(saved.ps, '<p>PS editado.</p>');
    assert.deepEqual(saved.topics, ['nuevo-tema', 'otro-tema']);
    assert.equal(saved.date, '2026-06-01');
    assert.equal(saved.author, 'Autor Editado');
    assert.equal(saved.sourceSite, 'Sitio Editado');
    assert.equal(saved.sourceUrl, 'https://editado.example.com');
    assert.equal(saved.sourceDate, '2026-05-01');
  });

  test('ignores unknown keys (no extra fields written)', async () => {
    const id = seedArticle({ id: 'fields-unknown-keys', workflowStatus: 'en-progreso' });
    await PUT(`/api/articles/${id}/fields`, {
      contentHtml: '<p>OK.</p>',
      hackField:   'valor malicioso',
    });
    const saved = readArticle(id);
    assert.equal(saved.hackField, undefined);
  });

  test('does not require all fields — partial patch is valid', async () => {
    const id = seedArticle({
      id:          'fields-partial',
      contentHtml: '<p>Original.</p>',
      author:      'Autor Original',
      workflowStatus: 'en-progreso',
    });
    const { status } = await PUT(`/api/articles/${id}/fields`, { author: 'Autor Nuevo' });
    assert.equal(status, 200);

    const saved = readArticle(id);
    assert.equal(saved.author, 'Autor Nuevo');
    assert.equal(saved.contentHtml, '<p>Original.</p>', 'unpatched fields must be preserved');
  });

  test('returns 404 for unknown article', async () => {
    const { status } = await PUT('/api/articles/no-existe/fields', { contentHtml: '<p>x</p>' });
    assert.equal(status, 404);
  });
});

// ── Tests: POST /api/articles/:id/promote ────────────────────────────────────

describe('POST /api/articles/:id/promote', () => {
  beforeEach(() => clearArticles());

  test('advances en-progreso → terminado when article is valid', async () => {
    const id = seedArticle({
      id:             'promote-ok',
      workflowStatus: 'en-progreso',
      // Valid article: all required schema fields present
    });
    const { status, data } = await POST(`/api/articles/${id}/promote`);
    assert.equal(status, 200);
    assert.equal(data.workflowStatus, 'terminado');

    const saved = readArticle(id);
    assert.equal(saved.workflowStatus, 'terminado');
  });

  test('returns 422 when article fails validation', async () => {
    const id = seedArticle({
      id:             'promote-invalid',
      topics:         [],   // empty topics — schema violation
      workflowStatus: 'en-progreso',
    });
    const { status, data } = await POST(`/api/articles/${id}/promote`);
    assert.equal(status, 422);
    assert.ok(data.validationErrors?.length, 'debe incluir lista de errores');
  });

  test('returns 404 for unknown article', async () => {
    const { status } = await POST('/api/articles/no-existe/promote');
    assert.equal(status, 404);
  });
});

// ── Tests: POST /api/articles/:id/demote ─────────────────────────────────────

describe('POST /api/articles/:id/demote', () => {
  beforeEach(() => clearArticles());

  test('moves terminado → en-progreso unconditionally', async () => {
    const id = seedArticle({ id: 'demote-ok', workflowStatus: 'terminado' });
    const { status, data } = await POST(`/api/articles/${id}/demote`);
    assert.equal(status, 200);
    assert.equal(data.workflowStatus, 'en-progreso');

    assert.equal(readArticle(id).workflowStatus, 'en-progreso');
  });

  test('demote works even if article is invalid', async () => {
    const id = seedArticle({
      id:             'demote-invalid',
      topics:         [],
      workflowStatus: 'terminado',
    });
    const { status } = await POST(`/api/articles/${id}/demote`);
    assert.equal(status, 200, 'demote must never be gated by validation');
  });
});

// ── Tests: POST /api/articles/:id/send-to-edicion ────────────────────────────

describe('POST /api/articles/:id/send-to-edicion', () => {
  beforeEach(() => clearArticles());

  test('moves en-progreso → edicion', async () => {
    const id = seedArticle({ id: 'to-edicion', workflowStatus: 'en-progreso' });
    const { status, data } = await POST(`/api/articles/${id}/send-to-edicion`);
    assert.equal(status, 200);
    assert.equal(data.workflowStatus, 'edicion');
  });
});

// ── Tests: full workflow round-trip ──────────────────────────────────────────

describe('workflow round-trip: edicion → en-progreso → terminado', () => {
  before(() => clearArticles());

  test('article flows through all three stages correctly', async () => {
    // 1. Create draft in Edición
    const id = seedArticle({
      id:             'round-trip',
      title:          'Artículo de round trip',
      section:        'nom',
      contentHtml:    '<p>Bajada del artículo.</p>\n<p>Cuerpo principal.</p>',
      workflowStatus: 'edicion',
    });

    // 2. Send to Revisión → En Progreso (splitter fires)
    const r1 = await POST(`/api/articles/${id}/send-to-revision`);
    assert.equal(r1.status, 200, 'send-to-revision must return 200');
    assert.equal(r1.data.workflowStatus, 'en-progreso');

    const afterRevision = readArticle(id);
    assert.equal(afterRevision.workflowStatus, 'en-progreso');
    assert.equal(afterRevision.chapo, '<p>Bajada del artículo.</p>',
      'splitter must have extracted chapo');

    // 3. Edit fields via /fields
    const r2 = await PUT(`/api/articles/${id}/fields`, {
      topics:     ['redaccion', 'prueba'],
      date:       '2026-09-09',
      sourceSite: 'Test',
      sourceUrl:  'https://test.example.com',
    });
    assert.equal(r2.status, 200);

    // 4. Promote → Terminado (article must be valid now)
    const r3 = await POST(`/api/articles/${id}/promote`);
    assert.equal(r3.status, 200, 'promote must succeed after fields are filled');
    assert.equal(r3.data.workflowStatus, 'terminado');

    assert.equal(readArticle(id).workflowStatus, 'terminado');
  });
});

// ── Tests: GET /api/articles/duplicates ──────────────────────────────────────

describe('GET /api/articles/duplicates', () => {
  beforeEach(() => clearArticles());

  test('returns empty groups when no titles collide', async () => {
    seedArticle({ id: 'unico-1', title: 'Un título único' });
    seedArticle({ id: 'unico-2', title: 'Otro título distinto' });

    const { status, data } = await GET('/api/articles/duplicates');
    assert.equal(status, 200);
    assert.equal(data.groups.length, 0);
  });

  test('groups articles with the same normalized title (case + tildes ignored)', async () => {
    seedArticle({ id: 'dup-1', title: 'Marcha por la Memoria' });
    seedArticle({ id: 'dup-2', title: 'marcha por la memoria' }); // sin tilde en "por", igual normalizado
    seedArticle({ id: 'sin-dup', title: 'Algo completamente distinto' });

    const { status, data } = await GET('/api/articles/duplicates');
    assert.equal(status, 200);
    assert.equal(data.groups.length, 1);

    const group = data.groups[0];
    assert.equal(group.articles.length, 2);
    const ids = group.articles.map((a) => a.id).sort();
    assert.deepEqual(ids, ['dup-1', 'dup-2']);
  });

  test('never includes articles from articles/archive/', async () => {
    // seedArticle only writes into the active TMP_DIR, so simulate an
    // archived duplicate by writing directly into TMP_DIR/archive/.
    seedArticle({ id: 'active-copy', title: 'Título archivado o no' });
    const archiveDir = path.join(TMP_DIR, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'archived-copy.json'),
      JSON.stringify(validArticleJson({ id: 'archived-copy', title: 'Título archivado o no' })),
      'utf8'
    );

    const { data } = await GET('/api/articles/duplicates');
    assert.equal(data.groups.length, 0, 'archive/ must never contribute to duplicate groups');

    fs.rmSync(archiveDir, { recursive: true, force: true });
  });
});

// ── Tests: DELETE /api/articles/:id ───────────────────────────────────────────

describe('DELETE /api/articles/:id', () => {
  beforeEach(() => clearArticles());

  test('returns 404 for unknown id', async () => {
    const { status } = await DELETE('/api/articles/no-existe');
    assert.equal(status, 404);
  });

  test('deletes a draft in edicion', async () => {
    const id = seedArticle({ id: 'borrable-edicion', workflowStatus: 'edicion' });
    const { status, data } = await DELETE(`/api/articles/${id}`);
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(readArticle(id), null, 'file must be gone from disk');
  });

  test('deletes a draft in en-progreso', async () => {
    const id = seedArticle({ id: 'borrable-en-progreso', workflowStatus: 'en-progreso' });
    const { status } = await DELETE(`/api/articles/${id}`);
    assert.equal(status, 200);
    assert.equal(readArticle(id), null);
  });

  test('refuses to delete an article already published in SPIP', async () => {
    const id = seedArticle({
      id:             'ya-publicado',
      workflowStatus: 'en-progreso',
      spipArticleId:  '119',
    });
    const { status, data } = await DELETE(`/api/articles/${id}`);
    assert.equal(status, 409);
    assert.ok(data.error.includes('119'));
    assert.ok(readArticle(id), 'file must still exist — delete must be refused');
  });

  test('refuses to delete a terminado article', async () => {
    const id = seedArticle({ id: 'terminado-no-borrable', workflowStatus: 'terminado' });
    const { status } = await DELETE(`/api/articles/${id}`);
    assert.equal(status, 409);
    assert.ok(readArticle(id), 'file must still exist — delete must be refused');
  });
});
