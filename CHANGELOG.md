# CHANGELOG

Registro de cambios del proyecto `articulos-READY`.
Formato: [Semantic Versioning](https://semver.org/). Las entradas más recientes van primero.

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
