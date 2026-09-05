# articulos-READY

Herramienta para publicar artículos completos en `www.kilombo.top` (SPIP 4.4),
dejándolos en estado **"en preparación"** para revisión humana antes de publicarlos.

---

## Flujo de trabajo

```
articles/
  mi-articulo.json          ← artículo READY (ver docs/SCHEMA.md)
        │
        ▼
  node src/publish-article.mjs articles/mi-articulo.json
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
  (Playwright headless)      ← src/publish-article.mjs
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
│   └── example-article.json   ← artículo de ejemplo
│
├── src/
│   ├── publish-article.mjs    ← script principal (punto de entrada)
│   ├── probe-rubriques.mjs    ← Fase D0: verifica rubriques contra el sitio vivo
│   └── lib/
│       ├── article-validator.mjs  ← valida el JSON contra el schema
│       ├── spip-client.mjs        ← orquesta la publicación en SPIP
│       ├── spip-session.mjs       ← login a kilombo.top (Playwright)
│       └── live-write-gateway.mjs ← chokepoint de auditoría para escrituras
│
├── docs/
│   └── SCHEMA.md              ← especificación completa del formato JSON
│
├── .env                       ← credenciales (no versionado)
├── .env.example               ← plantilla de variables de entorno
├── package.json
└── README.md
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

### Publicar un artículo

```bash
node src/publish-article.mjs articles/mi-articulo.json
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
```

Rellena el formulario visualmente pero bloquea todos los POSTs.
No crea ningún artículo en la base de datos. Seguro para probar.

### Solo validar el JSON

```bash
node src/publish-article.mjs articles/mi-articulo.json --validate-only
```

### Validar el artículo de ejemplo

```bash
npm run validate:example
```

Equivalente a `--validate-only` sobre `articles/example-article.json`. Útil para
comprobar que la instalación funciona sin necesidad de recordar rutas ni argumentos.

Nota: algunos fragmentos de la documentación mencionan `--inspect` como una forma
de verificar inputs AJAX cargados por SPIP. No existe actualmente un flag
`--inspect` en el CLI. Para inspección manual, ejecutar el flujo con
`--dry-run` y lanzar Playwright en modo no headless (o abrir devtools) desde
`src/lib/spip-client.mjs` si necesitas ver el DOM y los bloques cargados por AJAX.

### Uso con npm (recordar el `--` antes de la ruta)

```bash
npm run validate -- articles/mi-articulo.json
npm run publish -- articles/mi-articulo.json
npm run publish -- articles/mi-articulo.json --dry-run
```

El `--` es obligatorio para que npm pase los argumentos al script en lugar de
interpretarlos como opciones de npm.

### Verificar secciones antes de publicar (Fase D0)

```bash
npm run probe
# o directamente:
node src/probe-rubriques.mjs
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

Si hay discrepancias, el script sale con código 1 e indica qué IDs actualizar
en `src/lib/spip-client.mjs` antes de publicar.

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

### Por qué Playwright

El backend `ecrire/` de SPIP está detrás del proxy SSO de YunoHost. Un cliente
HTTP normal no puede completar ese handshake. Playwright maneja el flujo de
redirección SSO + cookies automáticamente con un browser real headless.

### Mapeo SLUG → rubrique ID

`SLUG_TO_RUBRIQUE_ID` en `spip-client.mjs` traduce los slugs de sección del schema
(e.g. `"nom"`, `"actualidad"`) a los IDs numéricos de rubrique que usa SPIP
internamente. Estos IDs son propios de cada instalación SPIP y pueden cambiar
si se reorganizan las secciones.

Correr `npm run probe` (Fase D0) antes de cualquier publicación en un entorno
nuevo o tras una reorganización del panel SPIP. Si algún ID no coincide con
lo que reporta el sitio, actualizar la tabla en `spip-client.mjs`.

### Idempotencia: protección contra duplicados

Al publicar con éxito, el script escribe tres campos de vuelta en el archivo JSON
del artículo:

```json
{
  "spipArticleId": "92",
  "publishedAt":   "2026-09-05T10:00:00.000Z",
  "publishedUrl":  "https://www.kilombo.top/ecrire/?exec=article&id_article=92"
}
```

Si el mismo archivo se vuelve a pasar al script, el chequeo al inicio detecta
`spipArticleId` y aborta antes de tocar el browser:

```
⛔ Este artículo ya fue publicado.
   spipArticleId : 92
   publishedAt   : 2026-09-05T10:00:00.000Z
   publishedUrl  : https://...

   Para re-publicar (p.ej. prueba manual), eliminar esos campos del JSON.
```

Para re-publicar intencionalmente (solo en pruebas o si el artículo fue eliminado
de SPIP), eliminar esos tres campos del JSON y volver a correr el script.

El modo `--dry-run` no escribe nada de vuelta — no tiene ID real que guardar.

### Por qué `live-write-gateway.mjs`

Toda escritura en el sitio vivo pasa por un único punto (`guardedWrite()`).
Hoy es un pass-through con audit log. En el futuro, cualquier control
(confirmación humana, rate limiting, scoping de credenciales) se añade ahí
sin tocar los scripts que llaman.

### Por qué el artículo queda en `prepa`

Este proyecto es solo el primer paso del pipeline editorial. La decisión de
publicar la toma siempre un humano desde el panel de SPIP. Este código nunca
llama a `manage-article-status` con `publie`. El validador rechaza
explícitamente cualquier artículo con `status` distinto de `"prepa"`.

### Import lazy de SPIPClient

`publish-article.mjs` importa `spip-client.mjs` de forma dinámica (`await import(...)`)
solo cuando va a publicar. Esto permite que `--validate-only` funcione sin
tener Playwright instalado, separando la capa de validación de la de browser
automation.

### Campos validados pero aún no enviados a SPIP

Al publicar (y en modo `--validate-only`), el script avisa de los campos del
JSON que están definidos en el schema y son válidos, pero que todavía no tienen
implementación de escritura en `spip-client.mjs`:

- `coverImage` — imagen destacada del artículo
- `topics` — mots-clés (palabras clave)
- `author` — autor explícito (distinto del usuario autenticado)
- `date` — fecha del artículo (se valida pero aún no hay selector confirmado en el formulario)

El aviso es informativo: el artículo se crea igualmente, pero estos campos no
se guardan en SPIP. Cuando se implemente cada uno, el aviso desaparecerá.

> ⚠️ `topics` es un campo **requerido** por el schema (mínimo 2 elementos).
> Mientras no esté implementado, se puede publicar igual, pero los mots-clés
> habrá que añadirlos manualmente desde el panel de SPIP.

### Campos WYSIWYG marcados como opcionales

`surtitre`, `soustitre`, `chapo` y `ps` existen en la base de datos SPIP pero
pueden estar ocultos por el editor WYSIWYG de SPIP 4.4. `spip-client.mjs` los
rellena con `optional: true`: si el selector no aparece en el formulario, se
registra un aviso pero la publicación no falla. Los campos confirmados como
siempre visibles (`titre`, `texte`, `id_parent`, `descriptif`, `nom_site`,
`url_site`) sí son obligatorios y lanzan error si faltan.

### Procedencia del código

`spip-session.mjs` y `live-write-gateway.mjs` son copias adaptadas del
proyecto `KILOMBO-BUILD` (`/root/JOB/KILOMBO/KILOMBO-BUILD/KILOMBO/scripts/lib/`).
Se copió solo lo necesario. `spip-client.mjs` fue reescrito para el schema
extendido de este proyecto.

---

## Audit log

Cada intento de escritura se registra en `live-write-audit.log.jsonl`:

```jsonl
{"timestamp":"2026-09-05T10:00:00.000Z","action":"article.create","target":{"id":"mi-articulo","title":"..."},"dryRun":false,"result":"success","articleId":92}
```

El log nunca se borra automáticamente. Revisar periódicamente.
