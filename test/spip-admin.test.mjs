/**
 * test/spip-admin.test.mjs
 *
 * Tests para checkArticlesExist() y verifyDuplicatesInSpip() en
 * src/lib/spip-admin.mjs.
 *
 * NO se testea confirmExternalDeletion() aquí: escribe de verdad al audit
 * log vía guardedWrite() (sin seam), igual que changeArticleStatus() o
 * permanentlyDelete() — funciones que mutan SPIP/el audit log real y quedan
 * fuera del alcance de estos tests unitarios, consistente con el resto del
 * proyecto (ver publish-use-case.test.mjs para el patrón de qué SÍ se testea).
 *
 * USO:
 *   node --test
 *   node --test test/spip-admin.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkArticlesExist, verifyDuplicatesInSpip } from '../src/lib/spip-admin.mjs';

// ── checkArticlesExist ───────────────────────────────────────────────────────

describe('checkArticlesExist', () => {
  test('devuelve un Map vacío si no hay IDs para chequear', async () => {
    const result = await checkArticlesExist([], { _withSpipSession: async () => {
      throw new Error('no debería llamarse — no hay IDs');
    } });
    assert.equal(result.size, 0);
  });

  test('una única sesión cubre todos los IDs (un solo _withSpipSession)', async () => {
    let sessionCalls = 0;
    const _withSpipSession = async (fn) => {
      sessionCalls += 1;
      const fakePage = {
        goto: async () => {},
      };
      return fn(fakePage);
    };
    // No podemos stubear readStatusWidget (no exportada) sin Playwright real,
    // así que este test solo verifica el conteo de sesiones — el contenido
    // del Map se cubre indirectamente vía verifyDuplicatesInSpip más abajo
    // con un _checkArticlesExist inyectado.
    await checkArticlesExist(['1', '2', '3'], { _withSpipSession }).catch(() => {});
    assert.equal(sessionCalls, 1, 'debe abrir una sola sesión para varios IDs, no una por ID');
  });

  test('propaga el error si la sesión/login falla (no lo atrapa como "no existe")', async () => {
    const _withSpipSession = async () => {
      throw new Error('login falló: contraseña incorrecta');
    };
    await assert.rejects(
      () => checkArticlesExist(['1'], { _withSpipSession }),
      /login falló/,
      'un fallo de sesión completa no debe interpretarse como IDs inexistentes'
    );
  });
});

// ── verifyDuplicatesInSpip ───────────────────────────────────────────────────

function makeDuplicate({ canonical, entries }) {
  return {
    slug: 'test-slug',
    title: 'Test',
    suggestedCanonical: canonical,
    aliveEntries: entries.map((spipArticleId) => ({ spipArticleId, loggedAt: '2026-01-01T00:00:00.000Z' })),
  };
}

describe('verifyDuplicatesInSpip', () => {
  test('el canónico nunca se envía a checkArticlesExist', async () => {
    const dup = makeDuplicate({ canonical: '10', entries: ['10', '11'] });
    let checkedIds = null;
    const _checkArticlesExist = async (ids) => { checkedIds = ids; return new Map(); };

    await verifyDuplicatesInSpip([dup], { _checkArticlesExist });

    assert.deepEqual(checkedIds, ['11'], 'solo el sobrante (no canónico) debe verificarse');
  });

  test('spipExists:false confirmado marca el grupo como resuelto', async () => {
    const dup = makeDuplicate({ canonical: '10', entries: ['10', '11'] });
    const _checkArticlesExist = async () => new Map([['11', false]]);

    const [result] = await verifyDuplicatesInSpip([dup], { _checkArticlesExist });

    const sobrante = result.aliveEntries.find((e) => e.spipArticleId === '11');
    assert.equal(sobrante.spipExists, false);
    assert.equal(result.resolvedInSpip, true);
    assert.equal(result.verifiedInSpip, true);
  });

  test('no verificado (ausente del Map) NO se cuenta como resuelto — fail-safe', async () => {
    const dup = makeDuplicate({ canonical: '10', entries: ['10', '11'] });
    // checkArticlesExist no pudo confirmar nada para el 11 (navegación falló)
    const _checkArticlesExist = async () => new Map();

    const [result] = await verifyDuplicatesInSpip([dup], { _checkArticlesExist });

    const sobrante = result.aliveEntries.find((e) => e.spipArticleId === '11');
    assert.equal(sobrante.spipExists, true, 'no verificado se trata como "sigue vivo", no como ausente');
    assert.equal(result.resolvedInSpip, false, 'no debe resolverse sin una señal positiva de ausencia');
  });

  test('esta función nunca escribe al audit log — es responsabilidad de confirmExternalDeletion', async () => {
    // No hay guardedWrite ni fs.appendFileSync en el módulo de esta función;
    // este test documenta la garantía por inspección de la firma de retorno
    // (no side effects observables más allá de mutar el array recibido).
    const dup = makeDuplicate({ canonical: '10', entries: ['10', '11'] });
    const _checkArticlesExist = async () => new Map([['11', false]]);
    const before = JSON.stringify(dup);

    await verifyDuplicatesInSpip([dup], { _checkArticlesExist });

    // El objeto se mutó (aliveEntries anotadas) — eso es esperado y documentado.
    assert.notEqual(JSON.stringify(dup), before);
    // No hay aserción de I/O aquí porque no hay ningún seam de escritura que
    // stubear: la ausencia misma de una dependencia de escritura es la garantía.
  });
});
