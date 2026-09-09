# CHANGELOG

Registro de cambios del proyecto `articulos-READY`.
Formato: [Semantic Versioning](https://semver.org/). Las entradas más recientes van primero.

---

## [1.4.0] — 2026-09-08

Tres mejoras de flujo editorial en el editor (Edición) y la pestaña En Progreso.

### Añadido

- `public/app.js` — **Auto-guardado al pegar**: pegar en el textarea de cuerpo
  o en el campo de título dispara `saveDraft()` automáticamente tras un tick
  (para que el valor del input ya tenga el texto pegado al leerlo). El snapshot
  de historial se toma *antes* del paste, de modo que la versión pre-pegado
  queda siempre preservada.

- `public/app.js` + `public/index.html` — **Historial de borradores**:
  panel "📋 Historial de borradores" que aparece debajo del editor cada vez
  que se abre un artículo con historial existente. Almacena hasta 5 snapshots
  (`{ title, section, text, savedAt }`) en `localStorage`, indexados por ID
  de artículo. Cada snapshot muestra la hora y un preview de 60 caracteres,
  con un botón "Restaurar" que repone los campos del editor sin guardar
  automáticamente — el usuario revisa y confirma con "Guardar". El panel se
  cierra con ✕ y persiste entre recargas de página.

  Motivación: el auto-guardado al pegar (arriba) convierte un paste incorrecto
  en una sobreescritura inmediata del JSON. Sin historial, no hay recuperación.

- `public/app.js` — **Chequeo preventivo de títulos duplicados**: al hacer clic
  en "Aprobar" en la pestaña En Progreso, se normaliza el título del artículo
  (minúsculas, sin acentos, puntuación colapsada a espacios) y se compara contra
  todos los demás artículos del array. Si se detecta un near-match (igualdad
  exacta, o uno de los títulos contiene al otro), aparece un `confirm()` que
  nombra el artículo similar y su estado. Bloqueo suave — el usuario puede
  aprobar igualmente si es intencional. No requiere cambios en el servidor;
  opera sobre el array `articles` ya cargado en el cliente.

### Refactors aplicados (sin cambios de comportamiento)

- `public/app.js` — `postTransition()`: helper compartido que elimina el
  boilerplate repetido en las cinco funciones de transición de workflow
  (`publishArticle`, `demoteArticle`, `promoteArticle`, `sendToEdicionArticle`,
  `sendToRevisionArticle`). Cada función ahora declara solo su endpoint, labels
  y lógica de resultado vía `onResult()`.

- `src/server.mjs` — `asyncHandler()` + `loadArticleOr404()`: elimina el
  try/catch y la guarda load-or-404 duplicados en cada ruta. Cierra también
  el bug latente de Express 4 donde un `async` handler que lanza fuera de su
  propio try/catch deja la request colgada sin respuesta.

- `src/lib/article-validator.mjs` + `src/server.mjs` + `public/app.js` —
  `ALLOWED_TAGS` exportado como fuente de verdad única vía
  `GET /api/schema/allowed-tags`. `DETAIL_ALLOWED_TAGS` en `app.js` pasa de
  copia manual a fallback con carga dinámica al arrancar. Cierra el riesgo de
  drift documentado entre las dos listas.

### Otros cambios

- `src/lib/spip-client.mjs` + `src/lib/article-validator.mjs` — sección `nomfr`
  añadida (`SLUG_TO_RUBRIQUE_ID: '9'`, `VALID_SECTIONS`): rubrique francesa
  "NOUVEL ORDRE/PLANDÉMISME ET DOMESTICATION". Usada para re-publicar el
  artículo francés de Ronald Bernard (#124) en la sección correcta.

- `articles/*.json` — cuatro archivos renombrados para que el nombre de archivo
  coincida con el campo `id` interno (footgun eliminado).

- `src/lib/article-validator.mjs` — `sourceDate` añadido a
  `getUnimplementedFields()`. `ALLOWED_TAGS` exportado.

- `docs/SCHEMA.md` — `sourceDate` documentado en el mapeo JSON→SPIP como
  campo que se valida pero no se escribe en SPIP.

- `public/index.html` — banner de advertencia sobre el campo `date` eliminado.
  La advertencia ahora aparece en tiempo de publicación vía
  `getUnimplementedFields()`, como el resto de campos no implementados.

- `public/app.js` — botón "📋 Copiar contenido" en la vista de detalle de
  artículos En Progreso: copia título, chapo, cuerpo y ps como texto plano al
  portapapeles.

- `public/app.js` + `public/index.html` — botón "← Volver al dashboard" en la
  cabecera de Gestión del Sitio.

- `public/app.js` — campo ID SPIP en la pestaña Sitio tiene `<datalist>` con
  los últimos 10 artículos publicados (título + ID). Se actualiza con cada
  `loadArticles()`.

- `PUBLISHING.md` — nuevo documento: qué significa "publicado" en este
  dashboard, historial del problema del artículo francés #111 → resuelto
  como #124.

---

## [1.3.14] — 2026-09-08

Refactor: la verificación de duplicados en SPIP vuelve a respetar la
arquitectura del proyecto (punto único de control de escrituras + capa de
lógica separada de las rutas HTTP).

### Contexto

`?verify=true` (1.3.12) escribía directamente al audit log desde
`server.mjs` (`fs.appendFileSync` + una copia propia de `AUDIT_LOG_PATH`),
sin pasar por `guardedWrite()` — el "punto único de control" que
`live-write-gateway.mjs` documenta como obligatorio para toda escritura.
Además, cualquier error de `inspectArticleStatus()` (login fallido, timeout,
cambio de layout de SPIP) se trataba igual que "el artículo no existe",
y ese resultado se persistía de inmediato y para siempre — sin distinción
de confianza ni confirmación humana.

### Cambiado

- `src/lib/spip-admin.mjs` — la lógica de verificación se extrae de
  `server.mjs` a tres funciones nuevas, siguiendo el mismo patrón de
  `publish-use-case.mjs` (lógica pura + seams de inyección para tests):
  - `checkArticlesExist(spipIds, seams?)` — **una sola sesión SPIP** (un solo
    login) para todos los IDs, en vez de una sesión por ID. Un fallo de login
    se propaga como error de la operación completa, no se malinterpreta como
    "todos estos IDs no existen".
  - `verifyDuplicatesInSpip(duplicates, seams?)` — orquesta lo anterior sobre
    un `report.duplicates`. **Solo lectura**: nunca escribe al audit log. Un
    ID no verificable (Map sin esa entrada) se trata como "sigue vivo"
    (fail-safe), no como confirmado ausente.
  - `confirmExternalDeletion(spipId)` — única función que persiste una
    "borrado externo", y pasa por `guardedWrite()` correctamente. Requiere
    una llamada explícita — ver endpoint nuevo abajo.
- `src/server.mjs` — la ruta `?verify=true` ahora solo llama a
  `verifyDuplicatesInSpip()`; se eliminan `logExternalDeletion()`, el import
  de `fs` y la copia local de `AUDIT_LOG`.
- `public/app.js` + `public/index.html` — cada entrada marcada "ya no existe
  en SPIP" ahora muestra un botón **"Confirmar borrado"** con su propio gate
  de confirmación (`confirm()`, mismo patrón que "Borrado permanente"),
  llamando al endpoint nuevo. La verificación en sí ya no tiene efectos
  secundarios permanentes.

### Añadido

- `POST /api/site/duplicates/:spipId/confirm-deleted` — endpoint para el
  botón de confirmación manual descrito arriba.
- `test/spip-admin.test.mjs` — 7 tests nuevos para `checkArticlesExist()` y
  `verifyDuplicatesInSpip()` (sesión única, fail-safe ante "no verificado",
  el canónico nunca se envía a verificar, un fallo de login no se confunde
  con "no existe"). `confirmExternalDeletion()` queda fuera del alcance de
  los tests unitarios — escribe de verdad vía `guardedWrite()`, igual que
  `changeArticleStatus()`/`permanentlyDelete()`.

---

## [1.3.12] — 2026-09-07

Verificación en vivo de duplicados + botones diferenciados en Gestión del Sitio.

### Añadido

- `src/server.mjs` — `GET /api/site/audit-report?verify=true`: nuevo parámetro
  opcional que, cuando está presente, llama a `inspectArticleStatus()` vía
  Playwright para cada ID sobrante de los duplicados detectados. Si el artículo
  ya no existe en SPIP (fue borrado manualmente o por un script externo), lo marca
  como `spipExists: false` y lo excluye del conteo de duplicados reales. Esto
  resuelve el falso positivo de #122 (borrado en sesión anterior pero todavía
  registrado en el log como `article.create` sin una entrada `article.delete.permanent`
  correspondiente).

- `public/index.html` + `public/app.js` — dos botones diferenciados en el
  encabezado del panel "Estado del audit log":
  - **↺ Recargar** — recarga desde el log local únicamente (sin Playwright,
    instantáneo). Equivalente al botón anterior.
  - **🔍 Verificar en SPIP** — llama a `?verify=true`, contacta SPIP para cada
    duplicado sobrante, y actualiza la UI con el resultado real:
    - IDs ya borrados aparecen como "ya no existe en SPIP" (gris, sin botón de
      acción).
    - Si todos los sobrantes están borrados, el bloque ⚠️ Duplicados colapsa a
      ✅ con badge "verificado en SPIP".
    - El botón muestra "🔍 Verificando…" y se deshabilita durante la operación.

- `public/index.html` + `public/app.js` — estilos nuevos:
  `.audit-verified-badge`, `.audit-spip-gone`, `.audit-verify-btn`.

### Corregido

- `public/app.js` — `renderAuditReport()`: el banner ✅ OK y la línea de
  resumen ahora filtran `duplicates` por `resolvedInSpip` antes de decidir si
  mostrar la sección de error. Antes, cualquier entrada duplicada en el log
  (incluso con IDs ya borrados de SPIP) siempre aparecía como ⚠️ sin forma de
  descartar el aviso.

### Contexto

El audit log es append-only por diseño — las entradas `article.create` de #120
y #122 (borrados en sesión anterior) permanecen ahí indefinidamente. Sin
verificación activa, el panel siempre mostraría ⚠️ Duplicados para
`per-la-realidad-es-muy-diferente` aunque el problema ya estuviera resuelto.
El botón "Verificar en SPIP" cierra esa brecha sin modificar el log.

---

## [1.3.11] — 2026-09-07

Tests de publish-use-case.mjs + seam de inyección de dependencias.

### Añadido

- `test/publish-use-case.test.mjs` — 13 tests nuevos para `publishArticleUseCase`,
  organizados en cuatro grupos:
  - Idempotencia: artículo ya publicado devuelve `already-published`.
  - Validación: schema inválido devuelve `invalid`; `--validate-only` devuelve
    `valid` sin tocar el disco.
  - Publicación normal: éxito, `dry-run`, error de SPIPClient (lanza / devuelve
    `success=false`), write-back fallido dos veces devuelve `published-no-writeback`.
  - Recuperación: entrada en log devuelve `recovered`, sin entrada devuelve
    `recover-not-found`.

  Test clave — los dos paths de éxito escriben el mismo conjunto de campos:
  ```
  publicación normal y recuperación escriben el mismo conjunto de campos en el write-back
  ```
  Este test habría atrapado el bug de `workflowStatus: 'terminado'` ausente en
  la recuperación (corregido en 1.3.9 / tar.gz fixed).

- `src/lib/publish-use-case.mjs` — tres seams de inyección de dependencias para
  tests (nunca usados en producción):
  - `_spipClient` — instancia pre-construida de SPIPClient; evita cargar Playwright.
  - `_findSuccessEntry` — stub del lector del audit log.
  - `_writeBack` / `_writeBackToFile` — stubs del write-back al disco.

### Verificado

- `node --test` — 95 tests, 0 fallos (antes: 82).

---

## [1.3.10] — 2026-09-07

Gates de confirmación reales en la pestaña Sitio del dashboard.

### Corregido

- `public/app.js` — `handleSiteStatusChange()`: seleccionar "publie" ahora muestra
  un `confirm()` antes de enviar la petición. Antes el código hacía
  `if (status === 'publie') body.approvePublishing = true` automáticamente, lo que
  convertía el gate del servidor en decorativo — el usuario nunca veía ninguna
  fricción. Ahora el diálogo explica que publicar directamente hace el artículo
  visible en el sitio público inmediatamente y pide confirmación explícita.

- `public/app.js` — `handleSiteDelete()`: borrado permanente ahora muestra un
  `confirm()` antes de enviar. La operación es irreversible (el artículo desaparece
  completamente de SPIP), pero antes se ejecutaba sin ninguna confirmación — un
  solo click bastaba. Ahora el diálogo advierte de la irreversibilidad y recuerda
  que el artículo debe estar en la papelera primero.

### Contexto

El servidor tiene gates deliberados para operaciones peligrosas (publicar
directamente requiere `approvePublishing: true` en el body, el CLI equivalente
requiere `KILO_APPROVE_PUBLISHING=true` como variable de entorno). Pero el
dashboard los satisfacía automáticamente sin intervención del usuario — la
fricción era solo para scripts, no para la UI.

---

## [1.3.9] — 2026-09-07

Borrado permanente de artículo de prueba (test-publicacion-automatica).

### Eliminado

- Artículo SPIP ID 109 (`test-publicacion-automatica`) — borrado permanentemente
  del sitio kilombo.top. Era un artículo de prueba técnica creado durante la
  Etapa 1 (v1.2.0) para verificar el pipeline de publicación, nunca destinado
  a publicarse. Proceso:
  1. `node src/manage-article-status.mjs --inspect --id 109` — confirmó estado
     "A la papelera"
  2. `node src/permanently-delete-article.mjs --id 109 --dry-run` — previsualización
  3. `node src/permanently-delete-article.mjs --id 109` — borrado ejecutado
  4. Verificación: `--inspect --id 109` ahora devuelve "Widget de estado no
     encontrado" (artículo no existe)

### Contexto

El artículo 109 fue identificado durante la auditoría de reconciliación entre
el log de publicaciones (`live-write-audit.log.jsonl`) y los archivos JSON
locales. A diferencia de los artículos 119 y 120 (duplicados por fallo de
write-back, también borrados), el 109 era deliberadamente un test que cumplió
su propósito y ya no tenía razón de existir en el sitio.

---

## [1.3.8] — 2026-09-07

Corrección de la carga lazy de spip-client en --validate-only.

### Corregido

- `src/lib/publish-use-case.mjs` — el paso §4 (campos no implementados) hacía
  `await import('./spip-client.mjs')` antes de comprobar `validateOnly`, lo que
  cargaba Playwright igualmente en modo `--validate-only`. El README y el
  comentario interno decían que el import era "lazy para no cargar Playwright en
  validate-only" — descripción incorrecta del comportamiento real.

  Fix: `getUnimplementedFields` se movió a `article-validator.mjs` (sin
  dependencias de Playwright) e importada estáticamente. El import lazy de
  `spip-client.mjs` queda solo en el paso §5 (publicar), que nunca se alcanza
  en `--validate-only`. Verificado: `playwright` no aparece en el module cache
  tras cargar `publish-use-case.mjs` sin publicar.

- `src/lib/spip-client.mjs` — `getUnimplementedFields` reemplazada por un
  re-export de `article-validator.mjs` para no romper cualquier importador
  externo que la use desde `spip-client`.

- `src/lib/article-validator.mjs` — añadida `getUnimplementedFields(article)`:
  función pura que lista los campos del schema todavía no escritos en SPIP
  (coverImage, topics, author, date). Sin dependencias externas.

---

## [1.3.7] — 2026-09-07

Correcciones de seguridad y calidad de datos.

### Corregido

- `public/app.js` — `renderDetail()`: `contentHtml`, `chapo` y `ps` ahora pasan
  por `sanitizeHtml()` antes de ser inyectados con `innerHTML`. Antes se
  insertaban directamente, exponiendo la vista de detalle a HTML arbitrario de
  artículos en En Progreso que aún no habían pasado validación.

  `sanitizeHtml()` usa `DOMParser` (árbol real, sin regex) y permite únicamente
  los tags del schema (`h3`, `h4`, `p`, `br`, `strong`, `em`, `a`, `img`, etc.)
  con un subconjunto seguro de atributos. Cualquier tag no permitido se reemplaza
  por su contenido textual. Las URLs `javascript:` y `data:` en `href`/`src` se
  bloquean. Los enlaces `<a>` reciben `rel="noopener noreferrer"` automáticamente.

  El conjunto de tags permitidos refleja `ALLOWED_TAGS` en `article-validator.mjs`
  — si cambia uno, hay que actualizar el otro.

- `src/lib/article-validator.mjs` — `validateHtml()`: nuevo chequeo de
  marcadores de cita AI (`[cite: N]`). Cualquier campo HTML (`contentHtml`,
  `chapo`, `ps`) que los contenga falla validación con un mensaje explícito.
  Estos artefactos se publicarían como texto literal visible en el sitio.

- `src/lib/articles-store.mjs` — `listArticles()`: el self-heal que degrada
  artículos de Terminado → En Progreso ahora emite `console.warn` con el id del
  artículo y la lista de errores de validación que motivaron la degradación.
  Antes la operación era silenciosa — no había forma de saber qué artículos
  habían sido degradados ni por qué sin releer los JSONs.

### Datos

- `articles/testimonios-french` (sin extensión) — eliminado. Era una copia
  antigua del artículo sin `spipArticleId`, invisible a `listArticles()`, dejada
  por un error de edición.

- `articles/example-article.json` — recreado como fixture genérico del schema
  (aplicando patch-01-example-article.patch). El archivo original tenía `id:
  "fauci-fusible-controlado"` y era el artículo real publicado como ID 110; al
  ser renombrado correctamente a `fauci-fusible-controlado.json` dejó roto
  `npm run validate:example`. El nuevo fixture usa `id: "example-article"`, sin
  `spipArticleId` y con nota explícita de que no debe publicarse nunca.

- `README.md` — línea del árbol de directorios actualizada: `example-article.json`
  ahora dice "(nunca se publica)".

### Auto-corrección en caliente (self-heal)

Al arrancar el servidor con la nueva validación, `listArticles()` detectó tres
artículos en Terminado con marcadores `[cite: N]` y los degradó automáticamente
a En Progreso, emitiendo avisos en el log del servidor:

- `testimonios-alta-finanza-luciferina-ronald-bernard`
- `temoignage-et-suite-affaire-ronald-bernard-haute-finance`
- `temoignage-haute-finance-luciferienne-ronald-bernard`

Los tres necesitan limpieza manual antes de poder volver a Terminado.

---

## [1.3.6] — 2026-09-06

Arquitectura desacoplada para gestión del sitio SPIP + pestaña Sitio en el dashboard.

### Añadido

- `src/lib/spip-admin.mjs` — biblioteca de operaciones de administración de
  artículos ya publicados en SPIP. Exporta tres funciones:
  - `inspectArticleStatus(spipId)` — solo lectura; devuelve estado actual y
    opciones disponibles del widget de estado SPIP.
  - `changeArticleStatus(spipId, targetStatus, { dryRun? })` — cambia el estado
    de un artículo en SPIP (prepa/prop/publie/refuse/poubelle).
  - `permanentlyDelete(spipId, { dryRun? })` — borra permanentemente desde la
    papelera (`exec=corbeille`).
  - Toda operación usa `withSpipSession()` (ciclo de vida del browser centralizado)
    y `guardedWrite()` (audit log garantizado, incluyendo el borrado permanente
    que antes lo saltaba). No importa nada del pipeline editorial.

- `src/server.mjs` — tres nuevos endpoints bajo `/api/site/*`, completamente
  desacoplados de `/api/articles/*`:
  - `GET  /api/site/article/:spipId/status` — inspecciona estado en SPIP
  - `POST /api/site/article/:spipId/status` — cambia estado (body: `{ status, dryRun? }`)
  - `POST /api/site/article/:spipId/delete` — borrado permanente (requiere estar en poubelle)
  - Import de `spip-admin.mjs` es lazy (no carga Playwright al arrancar el servidor).

- `public/index.html` + `public/app.js` — nueva pestaña **🌐 Sitio** en el nav,
  con dos tarjetas:
  - **Cambiar estado** — campo ID SPIP + selector de estado + botón.
  - **Borrado permanente** — campo ID SPIP + botón con estilo de peligro.
  - El JS de Sitio es una sección completamente aislada al final de `app.js`:
    sus propias refs DOM, sus propias funciones, llama solo a `/api/site/*`.
    No toca `articles`, `activeTab`, ni ninguna función del pipeline editorial.

### Modificado

- `src/manage-article-status.mjs` — reescrito como adaptador delgado de
  `spip-admin.mjs` (~55 líneas vs ~280 anteriores). Ya no contiene lógica DOM,
  no lanza Playwright directamente, no duplica el ciclo de vida del browser.

- `src/permanently-delete-article.mjs` — reescrito como adaptador delgado de
  `spip-admin.mjs` (~45 líneas vs ~110 anteriores). Ahora pasa por `guardedWrite`
  (antes lo saltaba — era el único script de mutación SPIP sin audit log).

- `public/app.js` — `setActiveTab()` y `showListView()` actualizados para manejar
  la nueva vista `view-site` sin romper el comportamiento existente de las
  pestañas editoriales.

### Arquitectura

```
Pipeline editorial (sin cambios):
  articles-store ← article-validator ← text-to-html
  publish-use-case ← spip-client
  server /api/articles/*  ←→  public/app.js (pestañas Edición/En Progreso/Terminado)

Gestión del sitio (nuevo, desacoplado):
  spip-admin ← spip-session + live-write-gateway
  server /api/site/*  ←→  public/app.js (pestaña Sitio)
  CLI: manage-article-status.mjs + permanently-delete-article.mjs → spip-admin
```

---

## [1.3.5] — 2026-09-06

Incorporación de scripts de gestión de estado y borrado permanente de artículos SPIP.

### Añadido

- `src/manage-article-status.mjs` — cambia el estado de un artículo en SPIP vía
  Playwright. Dos modos: `--inspect` (muestra el estado actual y las opciones
  disponibles) y `--change` (cambia a `prepa`, `prop`, `publie`, `refuse` o
  `poubelle`). Incluye gate de seguridad: cambiar a `publie` directamente requiere
  `KILO_APPROVE_PUBLISHING=true` como variable de entorno. Registra la operación
  en `live-write-audit.log.jsonl` vía `guardedWrite()`. Portado de
  `KILOMBO-BUILD/scripts/manage-article-status.mjs` con imports adaptados a
  nuestra estructura (`src/lib/`).

- `src/permanently-delete-article.mjs` — borra permanentemente un artículo que
  ya está en la papelera de SPIP (`poubelle`). SPIP solo expone el borrado
  permanente desde `ecrire/?exec=corbeille` (formulario con checkboxes
  `elements[]` + submit `effacer`) — no hay URL directa sin token CSRF de sesión
  activa. El script verifica que el artículo esté en la papelera antes de
  proceder y guarda un screenshot de confirmación. Portado de
  `KILOMBO-BUILD/scripts/permanently-delete-article.mjs`.

- `package.json` — scripts `status` y `delete-article` añadidos:
  ```
  npm run status -- --inspect --id <id>
  npm run status -- --change --id <id> --status poubelle
  npm run delete-article -- --id <id>
  ```

### Contexto

Necesidad surgida al publicar artículos duplicados en SPIP (IDs 119, 120) por
fallos de write-back. El proyecto KILOMBO-BUILD ya tenía estos scripts; se portaron
aquí para no depender de ese proyecto para operaciones de mantenimiento del sitio.

Flujo de borrado permanente:
1. `npm run status -- --change --id <id> --status poubelle`
2. `npm run delete-article -- --id <id>`

---

## [1.3.4] — 2026-09-06

Correcciones de bugs en el editor y el flujo de workflow.

### Añadido

- `src/lib/text-to-html.mjs` — nueva exportación `looksLikeStructuredPaste(text)`:
  heurística que detecta si el texto pegado en el editor es JSON, HTML en crudo
  u otro contenido estructurado en vez de prosa. No bloquea el guardado — un
  borrador siempre debe poder guardarse tal como está — pero el servidor devuelve
  un `warning` que el frontend muestra como toast para que el editor lo note
  antes de enviar a Revisión.

- `test/text-to-html.test.mjs` — casos de test añadidos para
  `looksLikeStructuredPaste`.

### Modificado

- `src/server.mjs` — `PUT /api/articles/:id/draft`:
  - Acepta y persiste el campo `section` junto con `title` y `contentHtml`.
    Antes `section` se ignoraba en el guardado del borrador.
  - Llama a `looksLikeStructuredPaste()` sobre el texto recibido y, si
    detecta contenido estructurado, incluye `warning` en la respuesta JSON.

- `src/server.mjs` — `POST /api/articles/:id/send-to-revision`:
  gate ampliado para exigir también `section` (además de título y contenido)
  antes de dejar pasar el artículo a En Progreso.

- `public/app.js` — editor de Edición:
  - Añadido `<select>` de sección (DOM ref `editorSectionSelect`) entre el
    campo de título y el textarea de cuerpo.
  - `openEditor()`: carga y muestra la sección del artículo al abrir el editor.
  - `saveDraft()`: envía `section` al servidor en cada guardado; muestra el
    `warning` del servidor como toast si está presente.
  - `handleEditorSend()`: valida que haya sección seleccionada antes de
    guardar y llamar a `send-to-revision` — muestra toast de error y hace
    foco en el select si falta.
  - Badge de estado: ahora solo se muestra en la pestaña Terminado
    (`listo` / `publicado`). En Edición y En Progreso la celda queda vacía.
  - Subtítulo de En Progreso cambiado de "X artículos con errores de
    validación" a "X artículos para validar".

- `public/index.html` — editor de Edición:
  - Añadido `<select id="editor-section">` con las 6 secciones válidas del
    schema (`general`, `tierra`, `gci`, `pi`, `nom`, `actualidad`).
  - Añadidos estilos `.editor-section-select` consistentes con el resto del
    editor.

- `src/lib/articles-store.mjs` — `atomicWrite()` extraído como helper
  privado compartido por `writeBack()` y `writeBackToFile()`. Sin cambio
  de comportamiento observable.

- `ROADMAP.md` — Etapa 3 actualizada con el estado real del código (flujo
  de tres pasos ya implementado, pantalla de Edición mínima ya en código).
  Etapa 4 reescrita con el plan de IA pipeline vía Groq en las dos
  transiciones del workflow (Edición→En Progreso y En Progreso→Terminado).

### Verificado

- `npm test` — 82 tests, 0 fallos.

---

## [1.3.3] — 2026-09-05

---

## [1.3.4] — 2026-09-06

Corrección de bugs encontrados en revisión de código, y sincronización de
esta bitácora con el estado real del repositorio.

### Corregido

- `src/lib/spip-client.mjs` — `performCreate()` ya no reporta éxito cuando
  no puede extraer el `id_article` de la URL tras guardar. Antes seguía de
  largo con un aviso en consola y devolvía `{ articleId: null }`;
  `publishArticleUseCase()` tomaba eso como una publicación válida y
  escribía `spipArticleId: null` en el JSON del artículo — un valor falsy
  que ni el chequeo de idempotencia ni `findSuccessEntry()` detectan
  después, dejando el artículo marcado "publicado" sin ID real y sin forma
  de recuperarlo. Ahora lanza un error explícito y el flujo completo
  reporta `status: 'error'`, forzando una revisión manual en `/ecrire/`
  antes de reintentar.

- `src/lib/publish-use-case.mjs` — el `recoverCommand` sugerido cuando el
  write-back falla dos veces asumía `articles/${article.id}.json` como
  ruta del archivo. Como el `id` del JSON no siempre coincide con el
  nombre del archivo (ver 1.3.0), el comando sugerido podía apuntar a un
  archivo inexistente justo en el momento en que alguien más lo necesita.
  Ahora usa la ruta real (`absolutePath` si se conoce, si no
  `findArticleAbsolutePath(id)`) y, si de verdad no puede resolverla,
  avisa en vez de imprimir un comando roto.

- `src/lib/articles-store.mjs` — el helper `atomicWrite()` que el CHANGELOG
  1.3.3 decía haber extraído nunca llegó a existir en el código:
  `writeBack()` y `writeBackToFile()` seguían duplicando verbatim la
  secuencia leer→fusionar→escribir-temp→rename. Ahora el helper existe de
  verdad y ambas funciones delegan en él. Sin cambio de comportamiento
  observable, pero la entrada anterior del CHANGELOG ya describe el estado
  real del código.

- `articles/articulo-1788658811564.json` eliminado — quedó con
  `contentHtml` conteniendo el JSON completo de otro artículo (incluyendo
  HTML con estilos inline) pegado como texto plano y envuelto en `<p>`/
  `<br>` por `textToParagraphHtml()`. Pasaba `validateArticle()` porque el
  contenido estaba correctamente escapado, así que no había ninguna señal
  automática de que el "artículo" no era prosa real.

### Añadido

- `src/lib/text-to-html.mjs` — nueva función `looksLikeStructuredPaste(text)`:
  detecta heurísticamente si el texto pegado en la pantalla de Edición es en
  realidad JSON o markup HTML en crudo (el caso de arriba) en lugar de
  prosa. No bloquea el guardado — un borrador siempre debe poder guardarse
  tal como está — pero `PUT /api/articles/:id/draft` ahora devuelve un
  `warning` cuando la detecta, y el dashboard lo muestra como toast.
- `test/text-to-html.test.mjs` — 6 tests nuevos para `looksLikeStructuredPaste`.

### Documentado

- Nota para la próxima sesión: `ROADMAP.md` decía "Etapa 3 — no iniciada",
  pero `server.mjs`/`articles-store.mjs`/`app.js` ya implementan el flujo
  completo de tres etapas (`edicion` → `en-progreso` → `terminado`,
  `createDraftArticle`, `promoteToTerminado`, etc.) sin que ninguna entrada
  de este CHANGELOG lo documentara. Corregido en ROADMAP.md — ver ahí el
  estado real de la Etapa 3.

### Verificado

- `npm test` — 82 tests, 0 fallos.
- Servidor arranca y `GET /api/articles` responde correctamente tras los cambios.
- `npm run validate:example` — comportamiento idéntico a antes.

---

## [1.3.3] — 2026-09-05

Refactors de calidad de código y documentación de deuda técnica.

### Cambiado

- `src/lib/articles-store.mjs` — extraído helper privado `atomicWrite(filepath, article, fields)`.
  `writeBack()` y `writeBackToFile()` duplicaban verbatim la secuencia
  "leer → fusionar campos → escribir temp → rename atómico". Ahora ambas
  delegan en el helper compartido. Sin cambio de comportamiento observable.

### Documentado

- `ROADMAP.md` — nueva sección "Deuda técnica conocida" con entrada para el
  HTML checker basado en regex de `article-validator.mjs`. Explica por qué es
  aceptable con el contenido curado actual, cuáles son sus límites conocidos
  (`>` en `attrsStr` como rama muerta, sin detección de HTML malformado), los
  paquetes candidatos a reemplazo (`node-html-parser`, `parse5`), y cuándo
  conviene resolverlo (antes de la Etapa 3 — editor libre).

---

## [1.3.2] — 2026-09-05

Aplicado `articulos-READY-updated.tar.gz`.

### Añadido

- `src/lib/text-to-html.mjs` — utilidad pura de conversión entre texto plano
  y el HTML restringido que exige `contentHtml` (solo `<p>` y `<br>`, sin
  atributos, sin tags prohibidos). Escapa `<`, `>` y `&` automáticamente.
  Exporta `textToParagraphHtml(text)` y `htmlParagraphsToText(html)`.
  Sin dependencias externas; pensado para ser usado desde el editor de la
  Etapa 3.

- `test/article-validator.test.mjs` — suite completa de tests para
  `article-validator.mjs`. Cubre: artículo mínimo y completo válido,
  `_schema_version`, `id`, `language`, `section`, `title`, `surtitre` /
  `soustitre`, `descriptif`, `coverImage`, HTML permitido / prohibido,
  `chapo` / `ps`, `sourceSite` / `sourceUrl` / `sourceDate`, `date`,
  `topics`, `status` y mensajes de error de `assertValidArticle`.

- `test/text-to-html.test.mjs` — suite de tests para `text-to-html.mjs`.
  Cubre: texto vacío, párrafo único, separación por líneas en blanco, `<br>`
  en saltos simples, escape de caracteres HTML accidentales, normalización
  de `\r\n`, y round-trip `textToParagraphHtml` → `htmlParagraphsToText`.

- `docs/ARTICLE-DESIGN.md` — documento de diseño sobre los campos del
  formulario SPIP: qué responde a `fill()`, qué necesita `waitForSelector()`
  (campos AJAX), qué está fuera del alcance del pipeline (tema Escal,
  mots-clés, logo).

### Verificado

- `npm test` — 76 tests, 0 fallos.

---

## [1.3.1] — 2026-09-05

Refactor de arquitectura: extracción del use case de publicación.

### Añadido

- `src/lib/publish-use-case.mjs` — orquestación pura del flujo de publicación.
  Contiene toda la lógica de negocio: chequeo de idempotencia, recuperación
  desde el audit log, validación del schema, aviso de campos no implementados,
  llamada a `SPIPClient`, write-back atómico con reintento. Nunca llama a
  `process.exit()` ni imprime en consola. Devuelve un resultado estructurado
  con campo `status` (`already-published` | `recovered` | `recover-not-found` |
  `invalid` | `valid` | `dry-run` | `published` | `published-no-writeback` |
  `error`). Puede ser invocada desde CLI o desde HTTP sin ninguna adaptación.

- `src/lib/live-write-gateway.mjs` — nueva exportación `findSuccessEntry(action, targetId)`:
  busca en el audit log la entrada más reciente exitosa para una acción y un
  `target.id` dados. Antes esta lógica vivía duplicada en `publish-article.mjs`
  como función privada `findAuditEntry`, que reimplementaba el formato del log
  que el gateway ya conocía. Ahora el gateway es la única fuente de verdad sobre
  la estructura del log.

- `src/lib/articles-store.mjs` — nueva exportación `findArticleAbsolutePath(id)`:
  devuelve la ruta absoluta al archivo JSON de un artículo dado su campo `id`.
  Necesaria para que `server.mjs` pueda pasar la ruta al use case sin reimplementar
  la búsqueda por id.

### Modificado

- `src/publish-article.mjs` — reescrito como adaptador CLI delgado (~110 líneas).
  Ahora solo hace: parsear args, leer el JSON del disco, llamar a
  `publishArticleUseCase()`, imprimir el resultado y `process.exit`. Toda la
  lógica de negocio fue movida al use case.

- `src/server.mjs` — endpoint `POST /api/articles/:id/publish` simplificado:
  ahora adquiere el lock, hace el double-check, llama a `publishArticleUseCase()`
  y mapea el campo `status` del resultado a los códigos HTTP correctos (200, 207,
  409, 422, 500). La lógica de publicación ya no está duplicada entre el CLI y
  el servidor.

### Verificado

- `npm run validate:example` — salida idéntica a antes del refactor.
- `GET /api/articles` — devuelve la lista correctamente.
- Servidor arranca sin errores.

---

## [1.3.0] — 2026-09-05

Etapa 2 iniciada — Dashboard mínimo (lista + publicar).

### Añadido

- `src/server.mjs` — servidor Express con tres endpoints:
  - `GET /api/articles` — lee todos los `.json` de `articles/` y devuelve la
    lista con los campos clave (título, sección, fecha, estado, `spipArticleId`).
  - `GET /api/articles/:id` — devuelve el artículo completo por su campo `id`.
  - `POST /api/articles/:id/publish` — publica el artículo en SPIP con tres
    capas de protección contra duplicados: chequeo inicial, lock en memoria
    (suficiente para instancia única; ver ROADMAP para patrón Redis si hay
    réplicas), y double-check post-lock. Write-back atómico (temp + rename).
    Import lazy de Playwright: no se carga al arrancar el servidor.
  - SPA fallback: cualquier ruta no-API sirve `public/index.html`.
- `src/lib/articles-store.mjs` — capa de acceso a `articles/*.json`:
  - `listArticles()` — escanea el directorio y devuelve resúmenes ordenados
    (listos primero, luego por fecha descendente).
  - `loadArticle(id)` — carga un artículo completo buscando por el campo `id`
    del JSON (no por nombre de archivo).
  - `writeBack(id, fields)` — fusiona campos y escribe de forma atómica.
  - Corrección aplicada durante el smoke-test: `loadArticle` y `writeBack`
    buscaban el archivo asumiendo `id == nombre de archivo`, lo que fallaba
    cuando el nombre del archivo no coincide con el campo `id` (como en
    `example-article.json` / `fauci-fusible-controlado`). Ahora escanean el
    directorio y buscan por campo `id`.
- `public/index.html` — dashboard con tema oscuro (fondo `#0f1117`, acento oro):
  tabla con columnas Título, Sección, Fecha, Estado, ID SPIP y botón de acción.
  Banner de aviso sobre el campo `date` no implementado en SPIP.
- `public/app.js` — JS vanilla: carga la lista, renderiza filas, maneja el
  botón "Publicar en SPIP" con deshabilitado optimístico anti-doble-click,
  toasts de éxito/error/info, escape HTML en todos los valores (XSS-safe),
  botón de refresco manual.
- `package.json` — scripts `start` y `dashboard` añadidos (`node src/server.mjs`).
- `express@4.19.2` añadido como dependencia (versión exacta).

### Verificado

- `GET /api/articles` devuelve `example-article.json` con id `fauci-fusible-controlado`.
- `GET /api/articles/fauci-fusible-controlado` devuelve el artículo completo.
- `GET /api/articles/nonexistent` devuelve 404.
- `GET /` sirve `public/index.html` (200).

---

## [1.2.4] — 2026-09-05

### Corregido

- `src/publish-article.mjs` — la recuperación desde el audit log ya **no corre
  de forma incondicional**. El paso §1c ahora está detrás de `--recover-from-log`:
  sin ese flag, ninguna corrida (incluyendo `--validate-only`) toca el JSON ni
  consulta el log. Antes, el paso corría al inicio de cada ejecución normal, lo
  que causaba dos problemas:
  1. `--validate-only` podía reescribir el JSON silenciosamente si el audit log
     contenía una entrada previa — violando el contrato "sin efectos secundarios"
     de ese flag.
  2. El flujo "borrar `spipArticleId` + re-ejecutar para republicar" (documentado
     en el README) quedaba bloqueado: el script resucitaba el ID obsoleto del log
     y salía reportando "ya publicado" sin intentar la nueva publicación.
- `src/publish-article.mjs` — `parseArgs()` y `printUsage()` actualizados para
  reconocer y documentar `--recover-from-log`.
- Smoke test confirmado: `--validate-only` sobre `example-article.json` sale
  limpio sin modificar el archivo; `--recover-from-log` reporta correctamente
  que no hay entrada en el log cuando no existe ninguna.

---

## [1.2.3] — 2026-09-05

### Eliminado

- `articles/test-publicacion-automatica.json` — artículo de prueba técnica
  borrado. Cumplió su propósito (verificar el pipeline, ID SPIP 109). Lo
  dejaba como entrada "publicada" en `articles/`, que aparecerá en la lista
  del dashboard de la Etapa 2.

---

## [1.2.2] — 2026-09-05

Aplicado `articulos-READY-fixes.patch`.

### Corregido

- `src/lib/spip-client.mjs` — `slugToRubriquId()` eliminó el bypass numérico
  (`/^\d+$/.test(section) return section`). El validador garantiza que `section`
  siempre llega como slug válido, así que esa rama era código muerto que además
  podría enmascarar un slug mal formado que pareciera número.
- `src/probe-rubriques.mjs` — import de `slugToRubriquId` eliminado (importado
  pero nunca usado).

### Añadido

- `date` añadido como campo no implementado en `getUnimplementedFields()`
  (`spip-client.mjs`), en el mapeo de `docs/SCHEMA.md`, en `README.md` y en el
  aviso de runtime. El campo se valida pero no hay selector confirmado para el
  input de fecha en el formulario SPIP; requiere `--inspect` antes de implementar.

---

## [1.2.1] — 2026-09-05

Correcciones de validación, documentación y robustez operacional.

### Corregido

- `docs/SCHEMA.md` — fila `status` en "Mapeo completo JSON → SPIP" ahora indica
  explícitamente que el campo **no se escribe** — SPIP asigna `prepa` por defecto.
  Antes la tabla implicaba que el script enviaba `statut`, lo que contradecía el
  código y el README.

- `src/lib/article-validator.mjs` — `chapo` y `ps` ahora tienen chequeo de tipo
  explícito (`typeof !== 'string'`) antes de validar el HTML, igual que `surtitre`
  y `soustitre`. Antes, un valor no-string se saltaba silenciosamente la validación
  y llegaba a `fillField()` causando un error críptico de Playwright.

- `src/lib/article-validator.mjs` — `analyzeHtml()`: regex de detección de
  atributos añade `$` como alternativa final (`(?:=|>|\s|$)`). Antes, un atributo
  booleano trailing sin delimitador posterior (e.g. `<img src="x" alt>`) no se
  detectaba, creando un hueco en la detección de atributos prohibidos (`style=`,
  `class=`, `on*=`) y en el chequeo de `alt` ausente.

- `src/lib/article-validator.mjs` — `author` y `sourceSite` ahora tienen chequeo
  de tipo explícito, consistente con el resto de campos opcionales de string.

- `src/lib/spip-session.mjs` + `.env.example` — comentario de
  `KILOMBOTOP_FUTURE_PASSWORD` corregido: el fallback se evalúa por ausencia del
  valor, no por fallo del login. Antes el comentario describía un comportamiento
  de retry que el código nunca implementó.

### Añadido

- `src/publish-article.mjs` — `findAuditEntry()`: consulta el audit log como
  ledger secundario para recuperar `spipArticleId` cuando el write-back al JSON
  falló en una corrida anterior. Al inicio del flujo, si el JSON no tiene
  `spipArticleId` pero el audit log registra una publicación exitosa para el mismo
  `id`, recupera el marcador automáticamente y aborta sin duplicar. En el catch
  del write-back post-publicación, reintenta la escritura una vez antes de
  imprimir instrucciones manuales.

- `docs/ARTICLE-DESIGN.md` — sección "Diseño global del sitio" corregida: colores,
  tipografía, sidebar y labels son configurables vía `configurer_escal` con la
  contraseña del usuario `kilombo`, usando las herramientas ya existentes en
  `KILOMBO-BUILD` (`customize-escal-theme.mjs`, `probe-escal-fields.mjs`). Antes
  el documento los marcaba incorrectamente como fuera de alcance.

---

## [1.2.0] — 2026-09-05

Primera publicación real confirmada contra el sitio vivo. Etapa 1 del pipeline
cerrada.

### Añadido

- `articles/test-publicacion-automatica.json` — artículo ficticio de prueba
  técnica. Publicado exitosamente en kilombo.top con ID SPIP 109 (estado `prepa`).
  Confirma que el flujo completo `validate → login SSO → relleno de formulario →
  guardar → write-back de spipArticleId` funciona de punta a punta.
- `docs/ARTICLE-DESIGN.md` — documenta qué aspectos del diseño del artículo
  controla el pipeline y qué está fuera de su alcance (tema Escal, campos WYSIWYG,
  logo, mots-clés). Basado en análisis directo del HTML del formulario SPIP 4.4.21.

### Descubierto en la primera corrida real

- `surtitre`, `soustitre`, `chapo` y `ps` no están en el HTML inicial del
  formulario — se cargan vía AJAX después de que el JS de SPIP procesa los bloques.
  Esto explica los avisos "campo opcional no encontrado" que aparecen en el output.
  Para rellenarlos se necesita un `waitForSelector()` antes del `fill()`. Documentado
  en `docs/ARTICLE-DESIGN.md` como pendiente de implementar.

---

## [1.1.0] — 2026-09-05

Protección contra publicaciones duplicadas y herramienta de verificación de secciones.

### Añadido

- `src/probe-rubriques.mjs` — **Fase D0**: abre el formulario `article_edit` en
  el sitio vivo, lee todas las opciones de `<select name="id_parent">` e imprime
  el mapeo completo de IDs reales. Compara con `SLUG_TO_RUBRIQUE_ID` y sale con
  código 1 si hay discrepancias. Ejecutar antes de cualquier publicación real
  con `npm run probe`.
- `src/lib/spip-client.mjs` — `SLUG_TO_RUBRIQUE_ID` ahora se exporta para que
  `probe-rubriques.mjs` pueda comparar sin duplicar la tabla.
- `package.json` — script `probe` añadido como atajo a `probe-rubriques.mjs`.
- `publish-article.mjs` — **chequeo de idempotencia al inicio del flujo**: si el
  JSON del artículo ya contiene `spipArticleId`, el script aborta antes de abrir
  el browser e imprime el ID, la fecha y la URL de la publicación original. Para
  re-publicar intencionalmente hay que eliminar esos tres campos del JSON.
- `publish-article.mjs` — **write-back del resultado**: tras una publicación
  exitosa, escribe `spipArticleId`, `publishedAt` y `publishedUrl` de vuelta en
  el archivo JSON original (in-place). Si la escritura falla, imprime los valores
  en consola para que puedan añadirse a mano.
- `README.md` — documentada la Fase D0, el mapeo slug → rubrique, y el
  comportamiento de idempotencia.

---

## [1.0.1] — 2026-09-05

Correcciones tras revisión de código de la primera versión funcional.

### Corregido

- `live-write-gateway.mjs` — `guardedWrite()` descartaba el valor devuelto por
  `execute()` al escribir la entrada de audit log exitosa, por lo que
  `articleId` nunca quedaba registrado en `live-write-audit.log.jsonl` a pesar
  de aparecer en el ejemplo documentado en `README.md`. Ahora los campos del
  resultado (p.ej. `articleId`) se incluyen en la entrada.
- `spip-client.mjs` — `fillField()` decidía `select` vs. `fill()` inspeccionando
  si el string del selector contenía la palabra "select", un supuesto frágil
  que solo funcionaba por casualidad de nomenclatura. `SELECTORS` ahora declara
  `{ selector, type }` explícito por campo.
- `package.json` — `npm run validate` sin argumentos no hacía nada útil
  (imprimía el uso y salía con error) porque el script nunca pasaba una ruta
  de artículo. Se agregó `validate:example` como atajo, y el mensaje de uso
  ahora explica la sintaxis `npm run validate -- <ruta>`.

### Añadido

- `publish-article.mjs` ahora avisa en la terminal si el artículo trae
  `coverImage`, `topics` o `author` — campos que se validan pero que
  `spip-client.mjs` todavía no escribe en SPIP (ver `docs/SCHEMA.md`).
  Antes este hueco solo estaba documentado, sin ningún aviso en tiempo de
  ejecución.

---

## [1.0.0] — 2026-09-05

Versión inicial del proyecto. Scaffolding completo con toda la lógica de
publicación, validación y auditoría.

### Añadido

**Documentación**
- `docs/SCHEMA.md` — especificación completa del formato JSON de artículo v1.0:
  campos requeridos y opcionales, tipos, valores permitidos, reglas de validación,
  tabla de secciones SPIP y mapeo completo JSON → campos SPIP.
- `README.md` — arquitectura del proyecto, flujo de trabajo, guía de instalación
  y uso, decisiones de diseño documentadas.
- `CHANGELOG.md` — este archivo.
- `.env.example` — plantilla de variables de entorno con comentarios.

**Código fuente**
- `src/publish-article.mjs` — punto de entrada CLI con tres modos:
  publicación real, `--dry-run` y `--validate-only`. Import lazy de
  `SPIPClient` para que `--validate-only` funcione sin Playwright instalado.
- `src/lib/article-validator.mjs` — validador del schema v1.0 sin dependencias
  externas. Valida tipos, slugs, HTML controlado (tags y atributos permitidos,
  `alt` obligatorio en `<img>`), URLs, fechas y enums. Exporta `validateArticle()`
  y `assertValidArticle()`.
- `src/lib/spip-client.mjs` — rellena el formulario SPIP `article_edit` vía
  Playwright headless. Incluye tabla `SLUG_TO_RUBRIQUE_ID` verificada contra
  el SPIP vivo, manejo de campos opcionales WYSIWYG (`surtitre`, `soustitre`,
  `chapo`, `ps`) que no fallan si no están visibles, y bloqueo de POSTs en
  modo dry-run.
- `src/lib/spip-session.mjs` — login a `www.kilombo.top` manejando tanto el
  formulario nativo de SPIP como el portal SSO de YunoHost. Adaptado de
  `KILOMBO-BUILD/KILOMBO/scripts/lib/spip-session.mjs`.
- `src/lib/live-write-gateway.mjs` — chokepoint único para toda escritura en
  el sitio vivo. Registra cada intento en `live-write-audit.log.jsonl` (JSONL).
  Adaptado de `KILOMBO-BUILD/KILOMBO/scripts/lib/live-write-gateway.mjs`.

**Datos**
- `articles/example-article.json` — artículo de ejemplo completo y válido que
  ejercita todos los campos del schema: `surtitre`, `soustitre`, `chapo`,
  `contentHtml` con múltiples secciones y tags, `ps`, `coverImage`, fuente,
  autoría y notas internas.

**Configuración**
- `package.json` — dependencia única: `playwright@1.47.2` (versión exacta,
  sin rangos abiertos).

### Decisiones de diseño iniciales

- El artículo **siempre queda en estado `prepa`**. El validador rechaza
  cualquier valor distinto en el campo `status`. No existe ningún camino en
  el código que llame a `publie`.
- Los campos WYSIWYG (`surtitre`, `soustitre`, `chapo`, `ps`) se intentan
  rellenar pero con `optional: true`: su ausencia en el formulario genera un
  aviso, no un error fatal.
- Solo se copió el código estrictamente necesario de `KILOMBO-BUILD`.
  No se trajeron: el servidor Express, el sistema de borradores, la migración
  masiva, ni los scripts de publicación al mirror JSON.
