/**
 * test/publish-use-case.test.mjs
 *
 * Suite de tests para src/lib/publish-use-case.mjs.
 *
 * El use case tiene tres dependencias de I/O que se inyectan vía options:
 *   _spipClient      — stub del cliente Playwright (evita cargar playwright)
 *   _findSuccessEntry — stub del lector del audit log
 *   _writeBack       — stub del write-back al JSON
 *   _writeBackToFile — stub del write-back por ruta absoluta
 *
 * USO:
 *   node --test
 *   node --test test/publish-use-case.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { publishArticleUseCase } from '../src/lib/publish-use-case.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function validArticle(overrides = {}) {
  return {
    _schema_version: '1.0',
    id:              'test-articulo',
    language:        'ES',
    section:         'nom',
    title:           'Título de prueba',
    descriptif:      'Resumen breve de prueba.',
    contentHtml:     '<p>Contenido de prueba.</p>',
    date:            '2026-01-01',
    status:          'prepa',
    topics:          ['tema-uno', 'tema-dos'],
    ...overrides,
  };
}

/** Stub de SPIPClient que simula una publicación exitosa. */
function makeSpipStub({ articleId = '42', url = 'https://www.kilombo.top/ecrire/?exec=article&id_article=42', success = true } = {}) {
  return {
    publishArticle: async (_article, _opts) => ({ success, articleId, url }),
  };
}

/** Colector de llamadas a writeBack — registra los fields escritos. */
function makeWriteBackSpy() {
  const calls = [];
  return {
    spy:        calls,
    writeBack:  (_id, fields) => { calls.push(fields); },
    writeBackToFile: (_path, fields) => { calls.push(fields); },
  };
}

/**
 * Colector de llamadas a logWriteBackFailure — evita que los tests que
 * fuerzan un fallo de write-back escriban entradas reales en
 * writeback-failures.log.jsonl (ver CHANGELOG — bug de tests ensuciando el
 * log de producción).
 */
function makeLogSpy() {
  const calls = [];
  return {
    spy: calls,
    logWriteBackFailure: (articleId, spipArticleId, publishedAt, error) => {
      calls.push({ articleId, spipArticleId, publishedAt, error });
    },
  };
}

// ── Helpers de seams ─────────────────────────────────────────────────────────

function ioSeams(overrides = {}) {
  const wb  = makeWriteBackSpy();
  const log = makeLogSpy();
  return {
    _writeBack:           wb.writeBack,
    _writeBackToFile:     wb.writeBackToFile,
    _findSuccessEntry:    () => null,   // sin audit log por defecto
    _logWriteBackFailure: log.logWriteBackFailure,
    _wb:                  wb,           // acceso al spy desde los tests
    _log:                 log,          // acceso al spy del logger desde los tests
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('publishArticleUseCase — idempotencia', () => {
  test('devuelve already-published si el artículo ya tiene spipArticleId', async () => {
    const article = validArticle({ spipArticleId: '99', publishedAt: '2026-01-01T00:00:00.000Z', publishedUrl: 'https://x' });
    const result = await publishArticleUseCase(article, ioSeams());
    assert.equal(result.status, 'already-published');
    assert.equal(result.spipArticleId, '99');
  });
});

describe('publishArticleUseCase — validación', () => {
  test('devuelve invalid si el artículo no pasa el schema', async () => {
    const article = validArticle({ title: '' }); // título vacío — falla validación
    const result = await publishArticleUseCase(article, ioSeams());
    assert.equal(result.status, 'invalid');
    assert.ok(result.validationError, 'debe incluir mensaje de error');
  });

  test('devuelve valid con --validate-only sin tocar I/O', async () => {
    const seams = ioSeams();
    const result = await publishArticleUseCase(validArticle(), { ...seams, validateOnly: true });
    assert.equal(result.status, 'valid');
    assert.equal(seams._wb.spy.length, 0, 'no debe haber write-backs en validate-only');
  });
});

describe('publishArticleUseCase — publicación normal', () => {
  test('devuelve published y escribe write-back con éxito', async () => {
    const seams = ioSeams();
    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      _spipClient: makeSpipStub({ articleId: '42', url: 'https://x' }),
    });

    assert.equal(result.status, 'published');
    assert.equal(result.spipArticleId, '42');
    assert.ok(result.publishedAt, 'debe incluir publishedAt');
    assert.equal(result.publishedUrl, 'https://x');
  });

  test('el write-back de publicación normal incluye workflowStatus terminado', async () => {
    const seams = ioSeams();
    await publishArticleUseCase(validArticle(), {
      ...seams,
      _spipClient: makeSpipStub({ articleId: '42' }),
    });

    assert.equal(seams._wb.spy.length, 1, 'debe haber exactamente un write-back');
    assert.equal(seams._wb.spy[0].workflowStatus, 'terminado');
    assert.equal(seams._wb.spy[0].spipArticleId, '42');
    assert.ok(seams._wb.spy[0].publishedAt);
  });

  test('devuelve dry-run sin write-back con --dry-run', async () => {
    const seams = ioSeams();
    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      dryRun: true,
      _spipClient: makeSpipStub(),
    });

    assert.equal(result.status, 'dry-run');
    assert.equal(seams._wb.spy.length, 0, 'no debe haber write-backs en dry-run');
  });

  test('devuelve error si SPIPClient lanza', async () => {
    const seams = ioSeams();
    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      _spipClient: { publishArticle: async () => { throw new Error('timeout de Playwright'); } },
    });

    assert.equal(result.status, 'error');
    assert.match(result.error, /timeout/);
  });

  test('devuelve error si SPIPClient devuelve success=false', async () => {
    const seams = ioSeams();
    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      _spipClient: makeSpipStub({ success: false }),
    });

    assert.equal(result.status, 'error');
  });

  test('devuelve published-no-writeback si el write-back falla dos veces', async () => {
    const alwaysThrows = () => { throw new Error('EROFS: disco de solo lectura'); };
    const seams = ioSeams({ _writeBack: alwaysThrows, _writeBackToFile: alwaysThrows });
    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      _spipClient: makeSpipStub({ articleId: '42' }),
    });

    assert.equal(result.status, 'published-no-writeback');
    assert.equal(result.spipArticleId, '42');
    assert.ok(result.writeBackFailed);
    assert.ok(result.recoverCommand, 'debe incluir el comando de recuperación');

    // El fallo se registró vía el seam, no en el archivo real
    // writeback-failures.log.jsonl — ver CHANGELOG.
    assert.equal(seams._log.spy.length, 1);
    assert.equal(seams._log.spy[0].articleId, 'test-articulo');
    assert.equal(seams._log.spy[0].spipArticleId, '42');
  });
});

describe('publishArticleUseCase — recuperación desde audit log', () => {
  test('devuelve recovered y escribe write-back si hay entrada en el log', async () => {
    const logEntry = {
      articleId:   '77',
      publishedAt: '2026-01-01T00:00:00.000Z',
      url:         'https://www.kilombo.top/ecrire/?exec=article&id_article=77',
    };
    const seams = ioSeams({ _findSuccessEntry: () => logEntry });

    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      recoverFromLog: true,
    });

    assert.equal(result.status, 'recovered');
    assert.equal(result.spipArticleId, '77');
  });

  test('el write-back de recuperación incluye workflowStatus terminado', async () => {
    const logEntry = { articleId: '77', publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://x' };
    const seams = ioSeams({ _findSuccessEntry: () => logEntry });

    await publishArticleUseCase(validArticle(), { ...seams, recoverFromLog: true });

    assert.equal(seams._wb.spy.length, 1, 'debe haber exactamente un write-back');
    assert.equal(seams._wb.spy[0].workflowStatus, 'terminado',
      'recuperación debe escribir workflowStatus: terminado (bug original: faltaba este campo)');
  });

  // ── TEST PRINCIPAL: los dos paths de éxito escriben el mismo conjunto de campos ──
  test('publicación normal y recuperación escriben el mismo conjunto de campos en el write-back', async () => {
    // Path A: publicación normal
    const seamsA = ioSeams();
    await publishArticleUseCase(validArticle(), {
      ...seamsA,
      _spipClient: makeSpipStub({ articleId: '55', url: 'https://x' }),
    });
    const fieldsA = seamsA._wb.spy[0];

    // Path B: recuperación desde audit log
    const logEntry = { articleId: '55', publishedAt: '2026-06-01T00:00:00.000Z', url: 'https://x' };
    const seamsB = ioSeams({ _findSuccessEntry: () => logEntry });
    await publishArticleUseCase(validArticle(), { ...seamsB, recoverFromLog: true });
    const fieldsB = seamsB._wb.spy[0];

    // Ambos deben escribir exactamente las mismas claves
    const keysA = Object.keys(fieldsA).sort();
    const keysB = Object.keys(fieldsB).sort();
    assert.deepEqual(keysA, keysB,
      `publicación escribe [${keysA}] pero recuperación escribe [${keysB}] — deben ser idénticos`);

    // workflowStatus: 'terminado' debe estar en ambos (el bug original lo omitía en recuperación)
    assert.equal(fieldsA.workflowStatus, 'terminado');
    assert.equal(fieldsB.workflowStatus, 'terminado');
  });

  test('devuelve recover-not-found si no hay entrada en el log', async () => {
    const seams = ioSeams({ _findSuccessEntry: () => null });
    const result = await publishArticleUseCase(validArticle(), {
      ...seams,
      recoverFromLog: true,
    });

    assert.equal(result.status, 'recover-not-found');
    assert.equal(seams._wb.spy.length, 0, 'no debe haber write-backs');
  });
});
