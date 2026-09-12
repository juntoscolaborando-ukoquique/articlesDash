import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitContentIntoFields } from '../src/lib/field-splitter.mjs';
import { textToParagraphHtml } from '../src/lib/text-to-html.mjs';

function html(...paragraphs) {
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

describe('splitContentIntoFields', () => {
  test('empty input returns everything empty, never throws', () => {
    assert.deepEqual(splitContentIntoFields(''), {
      chapo: '', contentHtml: '', ps: '', guessed: {},
    });
    assert.deepEqual(splitContentIntoFields(null), {
      chapo: '', contentHtml: '', ps: '', guessed: {},
    });
    assert.deepEqual(splitContentIntoFields(undefined), {
      chapo: '', contentHtml: '', ps: '', guessed: {},
    });
  });

  test('unrecognizable text with no paragraphs is returned unchanged', () => {
    const input = 'texto sin tags de párrafo';
    const result = splitContentIntoFields(input);
    assert.equal(result.chapo, '');
    assert.equal(result.contentHtml, input);
    assert.equal(result.ps, '');
    assert.deepEqual(result.guessed, {});
  });

  test('single paragraph: never splits a chapo out of the whole body', () => {
    const input = html('Un solo párrafo de cuerpo.');
    const result = splitContentIntoFields(input);
    assert.equal(result.chapo, '');
    assert.equal(result.contentHtml, input);
    assert.equal(result.ps, '');
  });

  test('extracts chapo when 2+ paragraphs remain', () => {
    const input = html('Primer párrafo (chapo).', 'Segundo párrafo del cuerpo.');
    const result = splitContentIntoFields(input);
    assert.equal(result.chapo, '<p>Primer párrafo (chapo).</p>');
    assert.equal(result.contentHtml, html('Segundo párrafo del cuerpo.'));
    assert.equal(result.ps, '');
  });

  test('extracts a source footer (Fuente: URL) and does not duplicate it in the body', () => {
    const input = html(
      'Primer párrafo.',
      'Segundo párrafo del cuerpo.',
      'Fuente: https://example.com/articulo-original',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.sourceUrl, 'https://example.com/articulo-original');
    assert.ok(!result.contentHtml.includes('Fuente:'));
    assert.ok(!result.chapo.includes('Fuente:'));
  });

  test('extracts source site name when present before the URL', () => {
    const input = html(
      'Primer párrafo.',
      'Segundo párrafo.',
      'Fuente: El Sitio Original - https://example.com/nota',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.sourceSite, 'El Sitio Original');
    assert.equal(result.guessed.sourceUrl, 'https://example.com/nota');
  });

  test('extracts author (Autor: / Por:)', () => {
    const input = html(
      'Primer párrafo.',
      'Segundo párrafo.',
      'Autor: Juana Pérez',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.author, 'Juana Pérez');
    assert.ok(!result.contentHtml.includes('Autor:'));
  });

  test('extracts a numeric date near "publicado"/"fecha" context', () => {
    const input = html(
      'Primer párrafo.',
      'Segundo párrafo.',
      'Publicado el 20/07/2026',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.sourceDate, '2026-07-20');
  });

  test('extracts a textual Spanish date ("20 de julio de 2026")', () => {
    const input = html(
      'Primer párrafo.',
      'Segundo párrafo.',
      'Fecha de publicación: 20 de julio de 2026',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.sourceDate, '2026-07-20');
  });

  test('ignores a date-looking paragraph with no publication context', () => {
    const input = html(
      'Primer párrafo.',
      'El evento del 20/07/2026 marcó un antes y un después.',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.sourceDate, undefined);
  });

  test('extracts a post-scriptum (PD:) and removes it from the body', () => {
    const input = html(
      'Primer párrafo.',
      'Segundo párrafo.',
      'PD: esto es una aclaración final.',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.ps, '<p>PD: esto es una aclaración final.</p>');
    assert.ok(!result.contentHtml.includes('aclaración final'));
  });

  test('recognizes multiple P.S. marker variants', () => {
    for (const marker of ['P.D.', 'PS:', 'Nota:', '[Nota importante]', '* Aclaración']) {
      const input = html('Primer párrafo.', 'Segundo párrafo.', `${marker} contenido de cierre.`);
      const result = splitContentIntoFields(input);
      assert.ok(result.ps.includes('contenido de cierre.'), `marker "${marker}" should be detected as PS`);
    }
  });

  test('does NOT treat ordinary words starting with a PS marker as a P.S. (regression)', () => {
    // "Notario" starts with "nota", "Psicólogos" starts with "ps" — neither
    // is a postscript marker. Without a word boundary these were wrongly
    // popped off the body and into `ps`.
    for (const closingParagraph of [
      'Notario declaró que el proceso fue irregular y citó varias pruebas documentales.',
      'Psicólogos alertan sobre el aumento de casos reportados este año.',
    ]) {
      const input = html('Primer párrafo.', 'Segundo párrafo.', closingParagraph);
      const result = splitContentIntoFields(input);
      assert.equal(result.ps, '', `"${closingParagraph}" should not be detected as PS`);
      assert.ok(
        result.contentHtml.includes(closingParagraph),
        `"${closingParagraph}" should stay in contentHtml`
      );
    }
  });

  test('does not mistake a body sentence that merely mentions "fecha" for a source-date footer (regression)', () => {
    const closingParagraph =
      'La fecha límite para presentar el recurso vence el 20 de julio de 2026, según fuentes judiciales.';
    const input = html('Primer párrafo.', 'Segundo párrafo.', closingParagraph);
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.sourceDate, undefined);
    assert.ok(result.contentHtml.includes(closingParagraph));
  });

  test('combines source footer + PS + chapo extraction together, in order', () => {
    const input = html(
      'Este es el chapo.',
      'Primer párrafo del cuerpo.',
      'Segundo párrafo del cuerpo.',
      'PD: nota final del editor.',
      'Autor: Redacción',
      'Fuente: https://example.com/original',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.chapo, '<p>Este es el chapo.</p>');
    assert.equal(
      result.contentHtml,
      html('Primer párrafo del cuerpo.', 'Segundo párrafo del cuerpo.'),
    );
    assert.equal(result.ps, '<p>PD: nota final del editor.</p>');
    assert.equal(result.guessed.author, 'Redacción');
    assert.equal(result.guessed.sourceUrl, 'https://example.com/original');
  });

  test('preserves inline tags (<strong>/<em>/<br>) inside kept paragraphs', () => {
    const input = html(
      'Chapo con <strong>énfasis</strong>.',
      'Cuerpo con<br>salto de línea y <em>cursiva</em>.',
    );
    const result = splitContentIntoFields(input);
    assert.equal(result.chapo, '<p>Chapo con <strong>énfasis</strong>.</p>');
    assert.ok(result.contentHtml.includes('<strong>') === false); // no leaked from chapo
    assert.ok(result.contentHtml.includes('<em>cursiva</em>'));
  });

  test('works end-to-end on the output of textToParagraphHtml()', () => {
    const raw = [
      'Bajada llamativa del artículo.',
      'Cuerpo principal del artículo, con varios datos.',
      'Segundo párrafo del cuerpo.',
      'PD: dato adicional.',
      'Fuente: https://origen.example.com/nota',
    ].join('\n\n');

    const contentHtml = textToParagraphHtml(raw);
    const result = splitContentIntoFields(contentHtml);

    assert.equal(result.chapo, '<p>Bajada llamativa del artículo.</p>');
    assert.equal(result.guessed.sourceUrl, 'https://origen.example.com/nota');
    assert.equal(result.ps, '<p>PD: dato adicional.</p>');
    assert.ok(result.contentHtml.includes('Cuerpo principal'));
    assert.ok(result.contentHtml.includes('Segundo párrafo'));
  });

  test('never overwrites — guessed fields are only suggestions, caller decides precedence', () => {
    // El splitter no conoce el artículo completo; la regla de "nunca pisar
    // un campo ya presente" vive en el caller (server.mjs), no acá. Este
    // test documenta que guessed siempre viene poblado igual sin importar
    // el estado del artículo -- es responsabilidad del caller filtrarlo.
    const input = html('Primer párrafo.', 'Segundo párrafo.', 'Autor: Alguien');
    const result = splitContentIntoFields(input);
    assert.equal(result.guessed.author, 'Alguien');
  });
});
