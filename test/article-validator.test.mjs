/**
 * test/article-validator.test.mjs
 *
 * Suite de tests para src/lib/article-validator.mjs.
 *
 * article-validator.mjs es una función pura (sin I/O), por eso no hay
 * excusa para no tener cobertura básica — ver REFACTOR.md "Alta prioridad".
 *
 * USO:
 *   node --test
 *   node --test test/article-validator.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateArticle, assertValidArticle } from '../src/lib/article-validator.mjs';

function baseArticle(overrides = {}) {
  return {
    _schema_version: '1.0',
    id: 'articulo-de-prueba',
    language: 'ES',
    section: 'general',
    title: 'Un título de prueba',
    contentHtml: '<p>Contenido de prueba.</p>',
    date: '2026-09-05',
    topics: ['prueba', 'validacion'],
    status: 'prepa',
    ...overrides,
  };
}

function errorsContaining(errors, substring) {
  return errors.some((e) => e.includes(substring));
}

describe('validateArticle — artículo válido', () => {
  test('el artículo mínimo no produce errores', () => {
    assert.deepEqual(validateArticle(baseArticle()), []);
  });

  test('acepta todos los campos opcionales completos', () => {
    const article = baseArticle({
      surtitre: 'Serie',
      soustitre: 'Subtítulo',
      descriptif: 'Resumen sin HTML.',
      coverImage: {
        url: 'https://example.com/foto.jpg',
        alt: 'Texto alternativo',
        caption: 'Pie de foto',
        credit: 'Reuters',
      },
      chapo: '<p>Entradilla.</p>',
      ps: '<p>Post-scriptum.</p>',
      author: 'Autor de prueba',
      sourceSite: 'Sitio fuente',
      sourceUrl: 'https://example.com/original',
      sourceDate: '2026-01-01',
    });
    assert.deepEqual(validateArticle(article), []);
  });

  test('acepta date == "" (fecha desconocida)', () => {
    assert.deepEqual(validateArticle(baseArticle({ date: '' })), []);
  });

  test('assertValidArticle no lanza para un artículo válido', () => {
    assert.doesNotThrow(() => assertValidArticle(baseArticle()));
  });
});

describe('validateArticle — entrada inválida', () => {
  test('null devuelve un único error genérico', () => {
    assert.deepEqual(validateArticle(null), ['El artículo debe ser un objeto JSON']);
  });

  test('un string devuelve el mismo error genérico', () => {
    assert.deepEqual(validateArticle('no soy un objeto'), ['El artículo debe ser un objeto JSON']);
  });
});

describe('validateArticle — _schema_version', () => {
  test('rechaza una versión distinta de "1.0"', () => {
    const errors = validateArticle(baseArticle({ _schema_version: '2.0' }));
    assert.ok(errorsContaining(errors, '_schema_version'));
  });

  test('rechaza _schema_version ausente', () => {
    const article = baseArticle();
    delete article._schema_version;
    assert.ok(errorsContaining(validateArticle(article), '_schema_version'));
  });
});

describe('validateArticle — id', () => {
  test('rechaza id ausente', () => {
    const article = baseArticle();
    delete article.id;
    assert.ok(errorsContaining(validateArticle(article), 'id: obligatorio'));
  });

  test('rechaza id con mayúsculas', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ id: 'Articulo-Malo' })), 'slug inválido'));
  });

  test('rechaza id con espacios', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ id: 'articulo malo' })), 'slug inválido'));
  });

  test('rechaza id con guion bajo', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ id: 'articulo_malo' })), 'slug inválido'));
  });

  test('acepta id con números y guiones', () => {
    assert.deepEqual(validateArticle(baseArticle({ id: 'articulo-2026-v2' })), []);
  });
});

describe('validateArticle — language', () => {
  for (const lang of ['ES', 'FR', 'EN']) {
    test(`acepta language "${lang}"`, () => {
      assert.deepEqual(validateArticle(baseArticle({ language: lang })), []);
    });
  }

  test('rechaza un idioma no soportado', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ language: 'PT' })), 'language'));
  });

  test('rechaza language en minúsculas (case-sensitive)', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ language: 'es' })), 'language'));
  });
});

describe('validateArticle — section', () => {
  for (const section of ['general', 'tierra', 'gci', 'pi', 'nom', 'actualidad']) {
    test(`acepta section "${section}"`, () => {
      assert.deepEqual(validateArticle(baseArticle({ section })), []);
    });
  }

  test('rechaza una sección desconocida', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ section: 'deportes' })), 'section'));
  });
});

describe('validateArticle — title', () => {
  test('rechaza title ausente', () => {
    const article = baseArticle();
    delete article.title;
    assert.ok(errorsContaining(validateArticle(article), 'title'));
  });

  test('rechaza title vacío', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ title: '' })), 'title'));
  });

  test('rechaza title compuesto solo de espacios', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ title: '   ' })), 'title'));
  });
});

describe('validateArticle — surtitre / soustitre', () => {
  test('rechaza surtitre que no es string', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ surtitre: 123 })), 'surtitre'));
  });

  test('rechaza soustitre que no es string', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ soustitre: [] })), 'soustitre'));
  });
});

describe('validateArticle — descriptif', () => {
  test('rechaza descriptif con HTML (debe ser texto plano)', () => {
    const errors = validateArticle(baseArticle({ descriptif: 'Resumen con <b>HTML</b>.' }));
    assert.ok(errorsContaining(errors, 'descriptif'));
  });

  test('acepta descriptif sin HTML', () => {
    assert.deepEqual(validateArticle(baseArticle({ descriptif: 'Resumen normal, sin tags.' })), []);
  });

  test('rechaza descriptif que no es string', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ descriptif: 42 })), 'descriptif'));
  });

  // Regresión: la regex antigua /<[a-z]/i daba falso positivo en texto plano con
  // comparaciones como "5<a valor" — el nuevo /<[a-z][^>]*>/i solo matcha tags reales.
  test('acepta descriptif con comparación numérica tipo "5<a valor" (no es HTML)', () => {
    assert.deepEqual(
      validateArticle(baseArticle({ descriptif: 'Dosis de 5<a 10 mg son seguras.' })),
      []
    );
  });
});

describe('validateArticle — coverImage', () => {
  test('rechaza coverImage sin url', () => {
    const errors = validateArticle(baseArticle({ coverImage: { alt: 'texto' } }));
    assert.ok(errorsContaining(errors, 'coverImage.url'));
  });

  test('rechaza coverImage sin alt', () => {
    const errors = validateArticle(baseArticle({ coverImage: { url: 'https://example.com/x.jpg' } }));
    assert.ok(errorsContaining(errors, 'coverImage.alt'));
  });

  test('rechaza coverImage.url relativa', () => {
    const errors = validateArticle(baseArticle({ coverImage: { url: '/x.jpg', alt: 'texto' } }));
    assert.ok(errorsContaining(errors, 'coverImage.url'));
  });

  test('acepta coverImage completo', () => {
    assert.deepEqual(
      validateArticle(
        baseArticle({
          coverImage: {
            url: 'https://example.com/x.jpg',
            alt: 'Texto accesible',
            caption: 'Pie',
            credit: 'Fuente',
          },
        })
      ),
      []
    );
  });
});

describe('validateArticle — HTML permitido / prohibido', () => {
  test('acepta HTML permitido en contentHtml', () => {
    const article = baseArticle({
      contentHtml: '<h3>Título</h3><p>Texto <strong>fuerte</strong> <a href="https://example.com">link</a>.</p>',
    });
    assert.deepEqual(validateArticle(article), []);
  });

  test('rechaza etiqueta no permitida', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<div>bad</div>' }));
    assert.ok(errorsContaining(errors, 'tags prohibidos'));
  });

  test('rechaza atributo style', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<p style="color:red">x</p>' }));
    assert.ok(errorsContaining(errors, 'atributos prohibidos'));
  });

  test('rechaza atributo class', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<p class="x">x</p>' }));
    assert.ok(errorsContaining(errors, 'atributos prohibidos'));
  });

  test('rechaza onclick', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<p onclick="alert(1)">x</p>' }));
    assert.ok(errorsContaining(errors, 'atributos prohibidos'));
  });

  test('rechaza img sin alt', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<img src="https://example.com/a.jpg">' }));
    assert.ok(errorsContaining(errors, 'img> sin atributo alt'));
  });

  test('rechaza tags prohibidos explícitos', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<script>alert(1)</script>' }));
    assert.ok(errorsContaining(errors, 'tags prohibidos'));
  });

  // Regresión: la regex anterior (ver CHANGELOG 1.21.0) cortaba un tag a la
  // mitad cuando un atributo entre comillas contenía '>' — un parser real
  // (parse5) lo resuelve por construcción.
  test('acepta href con ">" dentro del valor entre comillas', () => {
    const errors = validateArticle(
      baseArticle({ contentHtml: '<p><a href="https://example.com/?a=1>2">link</a></p>' })
    );
    assert.deepEqual(errors, []);
  });

  // Regresión: la regex anterior podía interpretar tags dentro de un
  // comentario HTML como tags reales. parse5 los trata como un único nodo
  // de comentario, sin bajar a su contenido.
  test('no detecta tags escondidos dentro de un comentario HTML', () => {
    const errors = validateArticle(
      baseArticle({ contentHtml: '<!-- <div class="x">nota interna</div> --><p>Texto real.</p>' })
    );
    assert.deepEqual(errors, []);
  });

  test('detecta HTML con sintaxis inválida (caracteres inesperados en el markup)', () => {
    const errors = validateArticle(baseArticle({ contentHtml: '<p>Texto<a valor</p>' }));
    assert.ok(errorsContaining(errors, 'sintaxis inválida'));
  });

  test('un <ul>/<li> sin cerrar sigue siendo válido — el HTML5 es forgiving por spec', () => {
    // No es un "parse error" del spec — el navegador (y SPIP) lo resuelven
    // implícitamente cerrando cada <li> antes del siguiente. No debe
    // bloquear la publicación.
    const errors = validateArticle(baseArticle({ contentHtml: '<ul><li>Uno<li>Dos</ul>' }));
    assert.deepEqual(errors, []);
  });
});

describe('validateArticle — chapo / ps', () => {
  test('acepta chapo válido', () => {
    assert.deepEqual(validateArticle(baseArticle({ chapo: '<p>Intro.</p>' })), []);
  });

  test('rechaza chapo con tag disallowed', () => {
    const errors = validateArticle(baseArticle({ chapo: '<span>bad</span>' }));
    assert.ok(errorsContaining(errors, 'chapo'));
  });

  test('acepta ps válido', () => {
    assert.deepEqual(validateArticle(baseArticle({ ps: '<p>Nota.</p>' })), []);
  });

  test('rechaza ps con atributos prohibidos', () => {
    const errors = validateArticle(baseArticle({ ps: '<p class="x">x</p>' }));
    assert.ok(errorsContaining(errors, 'ps'));
  });
});

describe('validateArticle — sourceSite / sourceUrl / sourceDate', () => {
  test('rechaza sourceSite no string', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ sourceSite: 1 })), 'sourceSite'));
  });

  test('acepta sourceUrl válida', () => {
    assert.deepEqual(validateArticle(baseArticle({ sourceUrl: 'https://example.com/foo' })), []);
  });

  test('rechaza sourceUrl no absoluta', () => {
    const errors = validateArticle(baseArticle({ sourceUrl: '/foo' }));
    assert.ok(errorsContaining(errors, 'sourceUrl'));
  });

  test('acepta sourceDate válido', () => {
    assert.deepEqual(validateArticle(baseArticle({ sourceDate: '2026-09-05' })), []);
  });

  test('rechaza sourceDate con formato incorrecto', () => {
    const errors = validateArticle(baseArticle({ sourceDate: '05-09-2026' }));
    assert.ok(errorsContaining(errors, 'sourceDate'));
  });
});

describe('validateArticle — date', () => {
  test('rechaza date que no es ISO', () => {
    const errors = validateArticle(baseArticle({ date: '05/09/2026' }));
    assert.ok(errorsContaining(errors, 'date'));
  });

  test('acepta date vacía como desconocida', () => {
    assert.deepEqual(validateArticle(baseArticle({ date: '' })), []);
  });

  test('rechaza date inexistente', () => {
    const article = baseArticle();
    delete article.date;
    assert.ok(errorsContaining(validateArticle(article), 'date'));
  });
});

describe('validateArticle — topics', () => {
  test('rechaza topics no array', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ topics: 'foo' })), 'topics'));
  });

  test('rechaza menos de 2 topics', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ topics: ['solo-uno'] })), 'topics'));
  });

  test('rechaza más de 6 topics', () => {
    const largeTopics = Array.from({ length: 7 }, (_, i) => `topic-${i}`);
    assert.ok(errorsContaining(validateArticle(baseArticle({ topics: largeTopics })), 'topics'));
  });

  test('rechaza elementos no string', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ topics: ['ok', 4] })), 'topics'));
  });

  test('rechaza topics con mayúsculas', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ topics: ['OK', 'prueba'] })), 'los slugs deben estar'));
  });

  test('acepta topics válidos', () => {
    assert.deepEqual(validateArticle(baseArticle({ topics: ['fauci', 'covid-19', 'pandemia', 'medicina'] })), []);
  });
});

describe('validateArticle — status', () => {
  test('acepta status "prepa"', () => {
    assert.deepEqual(validateArticle(baseArticle({ status: 'prepa' })), []);
  });

  test('rechaza status no soportado', () => {
    assert.ok(errorsContaining(validateArticle(baseArticle({ status: 'published' })), 'status'));
  });
});

describe('assertValidArticle — mensaje de error', () => {
  test('lanza un Error con cada error enumerado', () => {
    assert.throws(
      () => assertValidArticle(baseArticle({ title: '' })),
      /Artículo inválido:|title: obligatorio/
    );
  });

  test('incluye la ruta fuente si se la pasa', () => {
    assert.throws(
      () => assertValidArticle(baseArticle({ id: 'Articulo Malo' }), 'articles/x.json'),
      /articles\/x\.json/
    );
  });
});
