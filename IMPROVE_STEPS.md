# IMPROVE_STEP.md — Splitter heurístico + editor de campos en En Progreso

**Fecha:** 2026-09-09
**Relación con `docs/ROADMAP.md`:**
- Cierra parte de lo que Etapa 3 marca como pendiente: *"Editor real de
  campos (surtitre, soustitre, chapo, ps, topics, coverImage) — hoy Edición
  solo cubre título + cuerpo en texto plano."*
- Es una versión **heurística y sin dependencias externas** de la
  "Transición 1" descrita en Etapa 4 (Groq en Edición → En Progreso). No la
  reemplaza — la interfaz de salida (`{ chapo, contentHtml, ps, ... }`) se
  diseña a propósito para que `groq-enrichment.mjs` pueda enchufarse después
  en el mismo punto del flujo sin tocar la UI. Ver "Paso 7" más abajo.

---

## Objetivo

Hoy, al mandar un artículo de Edición a En Progreso (`sendToRevision`), todo
el texto libre queda comprimido en un solo campo (`contentHtml`), y En
Progreso lo muestra en la misma vista de solo-lectura que Terminado
(`openDetail()` en `app.js`). El editor nunca ve los campos separados hasta
que ya están "bien" — no hay ningún paso intermedio donde corregirlos.

Este documento define cómo:

1. Separar automáticamente el texto en los campos del schema
   (`chapo` / `contentHtml` / `ps`, y oportunistamente `sourceUrl` /
   `sourceSite` / `sourceDate` / `author` si el texto los delata) en el
   momento de la transición Edición → En Progreso.
2. Reemplazar la vista de solo-lectura de En Progreso por un formulario
   editable, precargado con esos campos, donde el usuario corrige a mano
   antes de aprobar.

**No objetivo de esta fase:** adivinar `topics` o `section`. Un campo
vacío es una señal clara de "falta llenar esto"; un campo con un valor
inventado-pero-plausible es peor, porque puede pasar desapercibido. Quedan
fuera del splitter v1 — se llenan a mano en el formulario nuevo.

---

## Qué existe hoy (referencias)

| Pieza | Archivo | Notas |
|---|---|---|
| Transición Edición → En Progreso | `src/server.mjs` → `POST /api/articles/:id/send-to-revision` | Gate mínimo: título+sección+contentHtml no vacíos. Llama a `sendToRevision(id)`. |
| Conversión texto plano → HTML | `src/lib/text-to-html.mjs` → `textToParagraphHtml()` | Ya parte el texto en párrafos por línea en blanco y los envuelve en `<p>`. Reusar esta lógica de partición, no reinventarla. |
| Guardado de borrador | `PUT /api/articles/:id/draft` (`server.mjs`) | Hoy solo escribe `{ title, section, contentHtml }`. `chapo`/`ps` nunca se tocan desde la UI. |
| Vista de artículo en En Progreso | `public/app.js` → `openDetail(id)` | Es la MISMA vista que usa Terminado — de solo lectura. No hay `openEditor`-equivalente para En Progreso todavía. |
| Vista de artículo en Edición | `public/app.js` → `openEditor(id)` | Un solo `<textarea>` de cuerpo + input de título + select de sección. |
| Validación de campos | `src/lib/article-validator.mjs` → `validateArticle()` | Gate de la promoción En Progreso → Terminado. Sigue igual — el splitter no cambia qué se valida. |

---

## Pasos de implementación

### Paso 1 — `src/lib/field-splitter.mjs` (módulo puro, sin DOM ni Express)

Nueva función exportada:

```js
/**
 * @param {string} contentHtml - el contentHtml actual del artículo (ya en
 *   formato <p>...</p> restringido, tal como lo deja textToParagraphHtml()).
 * @returns {{
 *   chapo: string,
 *   contentHtml: string,
 *   ps: string,
 *   guessed: { sourceUrl?: string, sourceSite?: string, sourceDate?: string, author?: string }
 * }}
 */
export function splitContentIntoFields(contentHtml) { ... }
```

Reglas heurísticas (todas best-effort — si no matchean, no tocan nada):

1. **Extraer párrafos.** Parsear `contentHtml` con una regex simple sobre
   `<p>...</p>` (el HTML ya viene restringido y previsible por
   `textToParagraphHtml()` — no hace falta un parser completo acá). Cada
   párrafo es un string de texto (con posibles `<strong>`/`<em>`/`<br>`
   internos, que se preservan tal cual).

2. **Detectar y extraer un "pie de fuente"** (metadata), buscando desde el
   *último* párrafo hacia atrás, mientras el párrafo matchee alguno de estos
   patrones (case-insensitive):
   - `Fuente:` / `Fuente original:` seguido de una URL → `guessed.sourceUrl`
     (y `guessed.sourceSite` si hay un nombre de sitio antes de la URL)
   - `Autor:` / `Por:` seguido de un nombre → `guessed.author`
   - Una fecha reconocible (`DD/MM/YYYY`, `DD-MM-YYYY`, o
     `"20 de julio de 2026"`) cerca de las palabras `publicado`/`fecha` →
     `guessed.sourceDate` (normalizada a `YYYY-MM-DD`)
   Cada párrafo que matchea se **quita** de la lista de párrafos del cuerpo
   — no debe terminar duplicado dentro de `contentHtml`.

3. **Detectar un post-scriptum**, buscando el último párrafo restante (tras
   el paso 2) si empieza con `P.D.`, `PD:`, `PS:`, `Nota:`, `[Nota` o `*` →
   pasa a `ps`, se quita de la lista.

4. **Chapo.** Si quedan **2 o más párrafos** tras los pasos 2–3, el primero
   pasa a `chapo` y se quita de la lista. Si solo queda 1 párrafo, no hay
   nada que partir — `chapo` queda `''` (nunca forzar un chapo idéntico al
   cuerpo entero).

5. **Cuerpo.** Los párrafos restantes, re-envueltos en `<p>...</p>`, son el
   nuevo `contentHtml`.

6. Si el input está vacío o no tiene párrafos reconocibles, devolver todo
   sin cambios (`chapo: ''`, `contentHtml` igual al original, `ps: ''`,
   `guessed: {}`) — nunca lanzar, nunca bloquear.

**Tests** (`test/field-splitter.test.mjs`, mismo patrón que
`test/text-to-html.test.mjs`): casos con pie de fuente presente/ausente, con
y sin PD, con 1 solo párrafo (no debe partir chapo), con fecha en varios
formatos, con texto vacío.

---

### Paso 2 — Enganchar el splitter en la transición

En `POST /api/articles/:id/send-to-revision` (`server.mjs`), después del
gate existente (título+sección+contentHtml no vacíos) y antes de llamar a
`sendToRevision(id)`:

```js
import { splitContentIntoFields } from './lib/field-splitter.mjs';

// ...dentro de la ruta, tras el gate existente:
const { chapo, contentHtml, ps, guessed } = splitContentIntoFields(article.contentHtml);
writeBack(id, {
  chapo,
  contentHtml,
  ps,
  ...(guessed.sourceUrl  && !article.sourceUrl  ? { sourceUrl:  guessed.sourceUrl }  : {}),
  ...(guessed.sourceSite && !article.sourceSite ? { sourceSite: guessed.sourceSite } : {}),
  ...(guessed.sourceDate && !article.sourceDate ? { sourceDate: guessed.sourceDate } : {}),
  ...(guessed.author     && !article.author     ? { author:     guessed.author }     : {}),
});
sendToRevision(id);
```

Importante: **nunca pisar un valor ya presente** — el `&& !article.xxx` es
para el caso de re-enviar un artículo que ya pasó por acá antes (p.ej.
después de un `demote` + edición manual). El splitter solo debe llenar
huecos, nunca sobreescribir una corrección humana previa.

Esto corre **una sola vez**, en el momento de la transición — no en cada
lectura (`listArticles()` sigue igual, sin tocar).

---

### Paso 3 — Nuevo endpoint para guardar campos estructurados

Hoy `PUT /api/articles/:id/draft` solo acepta `{ title, section, text }` y
asume texto libre (formato Edición). En Progreso necesita guardar campos ya
separados, sin re-partir nada.

Nuevo endpoint en `server.mjs`:

```js
// PUT /api/articles/:id/fields — guarda los campos ya separados que se
// editan en la pantalla de En Progreso. A diferencia de /draft, no corre
// textToParagraphHtml() ni el splitter — los campos ya vienen como los dejó
// el usuario en el formulario. Sin gate de validación (guardar siempre debe
// poder hacerse, aunque el artículo no sea válido todavía).
app.put('/api/articles/:id/fields', asyncHandler('PUT /api/articles/:id/fields', async (req, res) => {
  const { id } = req.params;
  if (!loadArticleOr404(id, res)) return;

  const body = req.body ?? {};
  const patch = {};
  for (const key of ['chapo', 'contentHtml', 'ps', 'topics', 'date',
                      'author', 'sourceSite', 'sourceUrl', 'sourceDate']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  writeBack(id, patch);
  res.json({ success: true });
}));
```

Nota: los textareas de `chapo`/`contentHtml`/`ps` en el formulario nuevo
siguen editando **HTML restringido**, no texto plano — reusar el mismo
patrón de conversión (`textToParagraphHtml`/`htmlToPlainText`) que ya usa
Edición para cada campo individualmente, en vez de inventar un editor rico
nuevo en esta fase.

---

### Paso 4 — Nueva vista editable en el frontend

En `public/app.js`, junto a `openEditor()` (Edición) y `openDetail()`
(Terminado, solo-lectura), agregar `openFieldsEditor(id)`:

- Reutiliza la sección de detalle existente en `index.html` pero con
  `<textarea>`/`<input>` en vez de `<div>` de solo lectura, uno por campo:
  `chapo`, `contentHtml` (cuerpo), `ps`, `topics` (input de tags separados
  por coma → array), `date`, `author`, `sourceSite`, `sourceUrl`,
  `sourceDate`.
- Cada campo HTML (`chapo`/`contentHtml`/`ps`) se muestra en el textarea
  como texto plano vía `htmlToPlainText()` (ya existe, reusar tal cual) y
  se reconvierte a HTML restringido vía `textToParagraphHtml()` al guardar.
- Un botón "Guardar cambios" que hace `PUT /api/articles/:id/fields` (Paso 3).
- Los botones de transición (`Aprobar` → Terminado, `Enviar a Edición` →
  vuelta a reescritura libre) quedan igual que hoy, ya viven en el detalle.
- `validateArticle()` sigue corriendo solo en el gate de `promote` — este
  formulario no bloquea el guardado si faltan campos, solo el "Aprobar".

### Paso 5 — Enganchar la apertura de fila

En `renderRow()` (`app.js`), el `titleBtn` de una fila hoy decide entre
`openEditor` (si `isEdicion`) y `openDetail` (todo lo demás). Cambiar a
tres ramas:

```js
titleBtn.addEventListener('click', () => {
  if (isEdicion)                    return openEditor(article.id);
  if (workflowStatus === 'en-progreso') return openFieldsEditor(article.id);
  return openDetail(article.id); // terminado — sigue de solo lectura
});
```

---

### Paso 6 — Verificación

- `node --test` — el nuevo `field-splitter.test.mjs` debe sumarse a la
  suite existente sin romper nada de lo que ya pasa (102 tests hoy).
- Prueba manual de punta a punta: escribir un borrador en Edición con un
  pie de fuente reconocible (`Fuente: https://...`), mandarlo a Revisión, y
  confirmar en el formulario nuevo que `chapo`/`contentHtml`/`ps`/`sourceUrl`
  quedaron separados razonablemente — y que un borrador *sin* estructura
  reconocible simplemente cae entero en `contentHtml` sin romperse.
- Confirmar que re-enviar a Revisión un artículo que ya pasó por acá (tras
  un `demote`) no pisa campos que el humano ya corrigió a mano (regla del
  Paso 2).

---

### Paso 7 (futuro, no en esta fase) — Swap a Groq

Etapa 4 de `docs/ROADMAP.md` ya describe `src/lib/groq-enrichment.mjs` con
`enrichDraft(rawText, partialArticle)` para este mismo punto del flujo. El
`{ chapo, contentHtml, ps, guessed }` que devuelve `splitContentIntoFields()`
se diseñó con la misma forma a propósito: cuando llegue el momento, el
Paso 2 solo cambia qué función llama (heurística → Groq), sin tocar
`server.mjs` más allá de esa línea, ni el formulario del Paso 4 (que ya
está pensado para mostrar campos "sugeridos, a corregir" venga de donde
venga la sugerencia).

---

## Decisiones ya tomadas

- Heurística pura primero, sin llamadas a IA — cero dependencias nuevas,
  cero coste por request, aceptando una tasa de acierto menor.
- `topics` y `section` quedan fuera del splitter v1 — se llenan a mano.
- El splitter nunca sobreescribe un campo ya presente (solo llena huecos).
- El splitter corre **una vez**, en la transición, no en cada lectura.

## Decisiones abiertas (a resolver antes o durante la implementación)

1. **Demote y re-split.** Si un artículo se manda de vuelta a Edición
   (`demoteToEnProgreso`/`sendToEdicion`) y se reescribe desde cero, ¿debe
   el próximo `send-to-revision` volver a correr el splitter sobre el texto
   nuevo? (Probablemente sí — pero como el texto cambió por completo, no
   hay "campos ya corregidos" que proteger, así que la regla del Paso 2 no
   debería generar conflictos.)
2. **`topics` en el formulario nuevo.** ¿Input de texto libre separado por
   comas, o attempt de autosuggest a partir de topics ya usados en otros
   artículos (mencionado como idea suelta en una conversación anterior)?
   Fuera de alcance de este documento — decidir al implementar el Paso 4.

## Criterio de cierre

Un artículo pegado como texto libre en Edición, al llegar a En Progreso,
aparece con los campos del schema ya separados (aunque imperfectos) en un
formulario editable — no como el mismo bloque de texto que se escribió. El
usuario corrige visualmente y recién entonces aprueba a Terminado.
