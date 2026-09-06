import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  textToParagraphHtml,
  htmlParagraphsToText,
  looksLikeStructuredPaste,
} from '../src/lib/text-to-html.mjs';

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

describe('looksLikeStructuredPaste', () => {
  test('texto vacío o ausente no dispara la señal', () => {
    assert.equal(looksLikeStructuredPaste(''), false);
    assert.equal(looksLikeStructuredPaste('   '), false);
    assert.equal(looksLikeStructuredPaste(undefined), false);
  });

  test('prosa normal, aunque mencione llaves o corchetes sueltos, no dispara la señal', () => {
    assert.equal(
      looksLikeStructuredPaste('El evento fue todo un [éxito] según los vecinos, dijeron {muy contentos}.'),
      false
    );
  });

  test('un objeto JSON completo pegado entero dispara la señal', () => {
    const pasted = JSON.stringify({ id: 'otro-articulo', title: 'Otro título', contentHtml: '<p>hola</p>' });
    assert.equal(looksLikeStructuredPaste(pasted), true);
  });

  test('un array JSON completo pegado entero dispara la señal', () => {
    assert.equal(looksLikeStructuredPaste('["uno", "dos", "tres"]'), true);
  });

  test('markup HTML denso pegado en crudo dispara la señal', () => {
    const pasted = '<h2>Título</h2><p style="color:red">texto</p><div><span>más</span></div>';
    assert.equal(looksLikeStructuredPaste(pasted), true);
  });

  test('un párrafo largo con una sola etiqueta ocasional no dispara la señal', () => {
    const pasted =
      'Un párrafo bien largo de prosa normal que en algún punto menciona <em>algo</em> ' +
      'en cursiva pero por lo demás es puro texto plano escrito por una persona, sin más tags.';
    assert.equal(looksLikeStructuredPaste(pasted), false);
  });
});
