import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle } from '../src/lib/text-utils.mjs';

describe('normalizeTitle', () => {
  test('vacío o no-string devuelve string vacío', () => {
    assert.equal(normalizeTitle(''), '');
    assert.equal(normalizeTitle(undefined), '');
    assert.equal(normalizeTitle(null), '');
  });

  test('minúsculas y espacios ya normalizados quedan igual', () => {
    assert.equal(normalizeTitle('un titulo simple'), 'un titulo simple');
  });

  test('mayúsculas se normalizan a minúsculas', () => {
    assert.equal(normalizeTitle('Un Título En Mayúsculas'), normalizeTitle('un titulo en mayusculas'));
  });

  test('tildes se ignoran (typo-tolerante entre copias)', () => {
    assert.equal(normalizeTitle('Artículo con tildes'), normalizeTitle('Articulo con tildes'));
  });

  test('puntuación se elimina', () => {
    assert.equal(normalizeTitle('¿Qué pasó, realmente?'), normalizeTitle('Que paso realmente'));
  });

  test('espacios múltiples colapsan a uno solo', () => {
    assert.equal(normalizeTitle('Con   espacios     de más'), 'con espacios de mas');
  });

  test('dos títulos claramente distintos no coinciden', () => {
    assert.notEqual(normalizeTitle('Marcha por la memoria'), normalizeTitle('Asamblea vecinal'));
  });
});
