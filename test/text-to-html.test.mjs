import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { textToParagraphHtml, htmlParagraphsToText } from '../src/lib/text-to-html.mjs';

describe('textToParagraphHtml', () => {
  test('texto vacío devuelve string vacío', () => {
    assert.equal(textToParagraphHtml(''), '');
    assert.equal(textToParagraphHtml('   '), '');
    assert.equal(textToParagraphHtml(undefined), '');
  });

  test('un solo párrafo se envuelve en <p>', () => {
    assert.equal(textToParagraphHtml('Hola mundo'), '<p>Hola mundo</p>');
  });

  test('líneas en blanco separan párrafos', () => {
    const html = textToParagraphHtml('Primer párrafo.\n\nSegundo párrafo.');
    assert.equal(html, '<p>Primer párrafo.</p>\n<p>Segundo párrafo.</p>');
  });

  test('saltos de línea simples se convierten en <br>', () => {
    const html = textToParagraphHtml('Línea uno\nLínea dos');
    assert.equal(html, '<p>Línea uno<br>Línea dos</p>');
  });

  test('escapa caracteres HTML pegados por accidente', () => {
    const html = textToParagraphHtml('Esto es <script>alert(1)</script> y "comillas" & ampersand');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('normaliza \\r\\n a \\n antes de separar párrafos', () => {
    const html = textToParagraphHtml('Uno\r\n\r\nDos');
    assert.equal(html, '<p>Uno</p>\n<p>Dos</p>');
  });
});

describe('htmlParagraphsToText — round trip con textToParagraphHtml', () => {
  test('round trip de un párrafo simple', () => {
    const original = 'Hola mundo';
    assert.equal(htmlParagraphsToText(textToParagraphHtml(original)), original);
  });

  test('round trip de varios párrafos con saltos internos', () => {
    const original = 'Primer párrafo\ncon dos líneas.\n\nSegundo párrafo.';
    assert.equal(htmlParagraphsToText(textToParagraphHtml(original)), original);
  });

  test('round trip de texto con caracteres especiales', () => {
    const original = 'Precio: 10 < 20 & "descuento" aplicado';
    assert.equal(htmlParagraphsToText(textToParagraphHtml(original)), original);
  });

  test('html vacío devuelve string vacío', () => {
    assert.equal(htmlParagraphsToText(''), '');
    assert.equal(htmlParagraphsToText(undefined), '');
  });
});
