# articulos-READY

Herramienta para publicar artículos completos en `www.kilombo.top` (SPIP 4.4),
dejándolos en estado **"en preparación"** para revisión humana antes de publicarlos.
Incluye un dashboard web local para gestionar artículos sin usar la terminal.

## Repositorios

- **Principal (GitLab):** https://gitlab.com/ukoquique/simplekilombodash
- **Backup (GitHub):** https://github.com/juntoscolaborando-ukoquique/articlesDash

GitLab es la fuente de verdad. GitHub se mantiene como espejo de respaldo.

---

## Flujo de trabajo

```
articles/
  mi-articulo.json          ← artículo READY (ver docs/SCHEMA.md)
        │
        ▼
  node src/publish-article.mjs articles/mi-articulo.json
  (o botón "Publicar" en el dashboard)
        │
        ▼
  Validación del JSON        ← src/lib/article-validator.mjs
        │
        ▼
  Login en kilombo.top       ← src/lib/spip-session.mjs
  (YunoHost SSO / SPIP)
        │
        ▼
  Rellena formulario SPIP    ← src/lib/spip-client.mjs
  (Playwright headless)
        │
        ▼
  Audit log                  ← src/lib/live-write-gateway.mjs
  live-write-audit.log.jsonl
        │
        ▼
  Artículo en SPIP           estado: "en preparación" (prepa)
  → revisar en /ecrire/      listo para revisión humana
        │
        ▼
  Write-back al JSON         spipArticleId + publishedAt + publishedUrl
  articles/mi-articulo.json  ← marcador de idempotencia
```

El artículo **nunca se publica automáticamente**. Siempre queda en `prepa`.

---

## Estructura del proyecto

```
articulos-READY/
├── articles/                  ← artículos JSON listos para publicar
│   └── example-article.json   ← artículo de ejemplo completo
│
├── src/
│   ├── server.mjs             ← servidor Express (dashboard backend)
│   ├── publish-article.mjs    ← adaptador CLI (punto de entrada terminal)
│   ├── probe-rubriques.mjs    ← Fase D0: verifica rubriques contra el sitio vivo
│   └── lib/
│       ├── publish-use-case.mjs   ← orquestación pura del flujo de publicación
│       ├── articles-store.mjs     ← I/O de archivos JSON de artículos
│       ├── article-validator.mjs  ← valida el JSON contra el schema
│       ├── spip-client.mjs        ← rellena el formulario SPIP (Playwright)
│       ├── spip-session.mjs       ← login a kilombo.top + helper withSpipSession
│       └── live-write-gateway.mjs ← chokepoint de auditoría para escrituras
│
├── public/
│   ├── index.html             ← dashboard web (frontend)
│   └── app.js                 ← lógica del dashboard (JS vanilla)
│
├── test/
│   └── article-validator.test.mjs  ← suite de tests (node --test)
│
├── docs/
│   ├── SCHEMA.md              ← especificación completa del formato JSON
│   ├── ARTICLE-DESIGN.md      ← qué aspectos del diseño controla el pipeline
│   └── REFACTOR.md            ← tareas de refactorización (estado actual)
│
├── .env                       ← credenciales (no versionado)
├── .env.example               ← plantilla de variables de entorno
├── ROADMAP.md                 ← etapas del proyecto
├── CHANGELOG.md               ← historial de cambios
└── package.json
```

---

## Instalación

### Requisitos

- Node.js 20+
- Playwright con Chromium

```bash
npm install
npx playwright install chromium
```

### Configuración

```bash
cp .env.example .env
# editar .env con la contraseña real de kilombo.top
```

---

## Uso

### Dashboard web (Etapa 2)

```bash
npm start
# o:
npm run dashboard
```

Abre `http://localhost:3000` en el browser. Muestra todos los artículos en
`articles/` con título, sección, fecha, estado y ID SPIP. El botón
"Publicar en SPIP" ejecuta el flujo completo desde el browser.

### Publicar un artículo (CLI)

```bash
node src/publish-article.mjs articles/mi-articulo.json
# o con npm:
npm run publish -- articles/mi-articulo.json
```

El script:
1. Verifica que el artículo no fue publicado antes (chequeo de idempotencia)
2. Valida el JSON contra el schema
3. Hace login en kilombo.top
4. Rellena el formulario SPIP con todos los campos del artículo
5. Guarda en estado `prepa` (en preparación)
6. Imprime la URL del artículo creado en SPIP
7. Escribe `spipArticleId`, `publishedAt` y `publishedUrl` de vuelta en el JSON

### Modo dry-run (previsualizar sin crear)

```bash
node src/publish-article.mjs articles/mi-articulo.json --dry-run
npm run publish -- articles/mi-articulo.json --dry-run
```

Rellena el formulario visualmente pero bloquea todos los POSTs.
No crea ningún artículo en la base de datos. Seguro para probar.

### Solo validar el JSON

```bash
node src/publish-article.mjs articles/mi-articulo.json --validate-only
npm run validate -- articles/mi-articulo.json
npm run validate:example   # valida articles/example-article.json directamente
```

### Recuperar un marcador de idempotencia perdido

Si el script publicó con éxito pero el write-back al JSON falló:

```bash
node src/publish-article.mjs articles/mi-articulo.json --recover-from-log
```

Busca en el audit log la publicación exitosa para ese artículo y escribe
`spipArticleId` / `publishedAt` / `publishedUrl` de vuelta en el JSON.

### Verificar secciones antes de publicar (Fase D0)

```bash
npm run probe
```

Abre el formulario `article_edit` en el sitio vivo, lee todas las opciones del
`<select name="id_parent">` e imprime el mapeo completo de IDs reales. Luego
compara con la tabla `SLUG_TO_RUBRIQUE_ID` en `spip-client.mjs` y marca
discrepancias.

Salida esperada cuando todo está bien:

```
  ✅ general      → 1    "kilombo"
  ✅ tierra       → 1    "kilombo"
  ✅ gci          → 3    "icg"
  ✅ pi           → 2    "Proletarios internacionalistas"
  ✅ nom          → 19   "NUEVO ORDEN / PLANDEMISMO..."
  ✅ actualidad   → 21   "Actualités"

✅ Tabla SLUG_TO_RUBRIQUE_ID verificada — todos los IDs coinciden con el sitio.
```

### Tests

```bash
node --test
# o para un archivo concreto:
node --test test/article-validator.test.mjs
```

---

## Formato del artículo

Ver [`docs/SCHEMA.md`](docs/SCHEMA.md) para la especificación completa.

Ejemplo mínimo:

```json
{
  "_schema_version": "1.0",
  "id": "mi-articulo",
  "language": "ES",
  "section": "actualidad",
  "title": "Título del artículo",
  "descriptif": "Resumen breve para listados.",
  "contentHtml": "<p>Cuerpo del artículo.</p>",
  "date": "2026-09-05",
  "topics": ["tema1", "tema2"],
  "status": "prepa"
}
```

---

## Arquitectura y decisiones de diseño

### Capas

```
CLI (publish-article.mjs)          ← parsea args, imprime, process.exit
Dashboard (server.mjs)             ← HTTP, bloqueo por lock, respuesta JSON
        │
        ▼
publishArticleUseCase()            ← orquestación pura, sin I/O de presentación
(publish-use-case.mjs)             ← devuelve { status, ... }, nunca process.exit
        │
        ├── article-validator.mjs  ← validación pura (sin dependencias externas)
        ├── spip-client.mjs        ← Playwright, rellena formulario SPIP
        ├── spip-session.mjs       ← login SSO, withSpipSession helper
        ├── live-write-gateway.mjs ← audit log, guardedWrite chokepoint
        └── articles-store.mjs     ← I/O de archivos JSON (write-back atómico)
```

### Por qué Playwright

El backend `ecrire/` de SPIP está detrás del proxy SSO de YunoHost. Un cliente
HTTP normal no puede completar ese handshake. Playwright maneja el flujo de
redirección SSO + cookies automáticamente con un browser real headless.

### Mapeo SLUG → rubrique ID

`SLUG_TO_RUBRIQUE_ID` en `spip-client.mjs` traduce los slugs de sección del schema
(e.g. `"nom"`, `"actualidad"`) a los IDs numéricos de rubrique que usa SPIP
internamente. Estos IDs son propios de cada instalación SPIP y pueden cambiar
si se reorganizan las secciones. Correr `npm run probe` antes de publicar en
un entorno nuevo o tras reorganizar el panel SPIP.

### Idempotencia: protección contra duplicados

Al publicar con éxito, el script escribe tres campos de vuelta en el JSON:

```json
{
  "spipArticleId": "92",
  "publishedAt":   "2026-09-05T10:00:00.000Z",
  "publishedUrl":  "https://www.kilombo.top/ecrire/?exec=article&id_article=92"
}
```

Si el mismo archivo se vuelve a pasar al script (o se pulsa el botón del
dashboard de nuevo), el chequeo al inicio detecta `spipArticleId` y aborta
antes de tocar el browser. Para re-publicar intencionalmente (solo en pruebas
o si el artículo fue eliminado de SPIP), eliminar esos tres campos del JSON.

El dashboard también tiene un lock en memoria por artículo que impide que dos
clicks simultáneos lancen dos publicaciones antes de que la primera haga el
write-back.

### Por qué `live-write-gateway.mjs`

Toda escritura en el sitio vivo pasa por un único punto (`guardedWrite()`).
Hoy es un pass-through con audit log. En el futuro, cualquier control
(confirmación humana, rate limiting, scoping de credenciales) se añade ahí
sin tocar los scripts que llaman. El gateway también exporta
`findSuccessEntry()` para consultar el log — es la única fuente de verdad
sobre el formato del JSONL.

### Por qué el artículo queda en `prepa`

Este proyecto es solo el primer paso del pipeline editorial. La decisión de
publicar la toma siempre un humano desde el panel de SPIP. Este código nunca
llama a `manage-article-status` con `publie`. El validador rechaza
explícitamente cualquier artículo con `status` distinto de `"prepa"`.

### Import lazy de SPIPClient

`publish-use-case.mjs` importa `spip-client.mjs` de forma dinámica
(`await import(...)`) solo cuando va a publicar. Esto permite que
`--validate-only` funcione sin tener Playwright instalado, separando la
capa de validación de la de browser automation.

### Campos validados pero aún no enviados a SPIP

Al publicar (y en modo `--validate-only`), el script avisa de los campos del
JSON que están definidos en el schema y son válidos, pero que todavía no tienen
implementación de escritura en `spip-client.mjs`:

- `coverImage` — imagen destacada del artículo
- `topics` — mots-clés (palabras clave)
- `author` — autor explícito (distinto del usuario autenticado)
- `date` — fecha del artículo (se valida pero aún no hay selector confirmado)

El artículo se crea igualmente; estos campos hay que añadirlos manualmente
desde el panel de SPIP. Cuando se implemente cada uno en `spip-client.mjs`,
el aviso desaparece automáticamente.

> ⚠️ El campo `date` que se muestra en el dashboard **no** es la fecha que
> queda en el artículo publicado en SPIP, ya que todavía no se escribe.

### Campos WYSIWYG marcados como opcionales

`surtitre`, `soustitre`, `chapo` y `ps` existen en la base de datos SPIP pero
pueden estar ocultos por el editor WYSIWYG de SPIP 4.4. `spip-client.mjs` los
rellena con `optional: true`: si el selector no aparece en el formulario, se
registra un aviso pero la publicación no falla.

---

## Audit log

Cada intento de escritura se registra en `live-write-audit.log.jsonl`:

```jsonl
{"timestamp":"2026-09-05T10:00:00.000Z","action":"article.create","target":{"id":"mi-articulo","title":"..."},"dryRun":false,"result":"success","articleId":92}
```

El log permanece local (está en `.gitignore`) y nunca se borra automáticamente.
Revisar periódicamente. Si un write-back falla tras una publicación exitosa,
el log tiene la evidencia para recuperar el `spipArticleId` con
`--recover-from-log`.
