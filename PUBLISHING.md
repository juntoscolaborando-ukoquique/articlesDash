# PUBLISHING.md

Notas operativas sobre el significado de "publicado" en este dashboard
y los pasos para corregir la inconsistencia actual del artículo francés.

---

## Qué significa "publicado" en este dashboard

"Publicado" (badge verde en la pestaña Terminado) significa una sola cosa:

> El artículo fue enviado a SPIP y quedó en **"Tus artículos en curso"**
> (estado `prepa`). El campo `spipArticleId` fue escrito de vuelta en el
> JSON local por el write-back tras la publicación exitosa.

Lo que **no** significa:
- Que el artículo sea visible para el público en kilombo.top.
- Que un editor haya cambiado su estado a `publie` en el backend de SPIP.
- Que el artículo siga existiendo en SPIP (puede haber sido borrado después).

La transición `prepa → publie` es una decisión editorial humana que ocurre
en `/ecrire/` o vía la pestaña Sitio del dashboard. Este pipeline no la
gestiona ni la verifica — por diseño deliberado.

---

## Problema actual: artículo francés #111 muestra "publicado" incorrectamente

### Qué pasó

El artículo francés "La haute finance luciférienne" (ID SPIP #111) fue
enviado a SPIP correctamente en su momento. El write-back escribió:

```json
"spipArticleId": "111",
"workflowStatus": "terminado"
```

Posteriormente el artículo fue **borrado de SPIP** (en una sesión anterior
de mantenimiento). El JSON local nunca fue actualizado — sigue diciendo
`terminado` + `spipArticleId: "111"`, pero ese ID ya no existe en SPIP.

El dashboard lee el JSON, ve `spipArticleId`, y muestra "publicado" — no
tiene forma de saber que el artículo fue borrado después.

### Verificación

```bash
node src/manage-article-status.mjs --inspect --id 111
# Resultado: "Widget de estado no encontrado" — confirma que #111 no existe en SPIP
```

### Pasos para corregir

Hay dos opciones según la intención editorial:

---

#### Opción A — Re-enviar el artículo a SPIP (debe volver a estar en "en curso")

1. Limpiar el marcador del JSON local:

```bash
node -e "
const fs = require('fs');
const path = 'articles/temoignage-haute-finance-luciferienne-ronald-bernard.json';
const a = JSON.parse(fs.readFileSync(path));
delete a.spipArticleId;
delete a.publishedAt;
delete a.publishedUrl;
a.workflowStatus = 'terminado';
fs.writeFileSync(path, JSON.stringify(a, null, 2) + '\n');
console.log('OK');
"
```

2. Verificar que el artículo aparece en el dashboard sin badge "publicado"
   y con botón "Publicar en SPIP" habilitado.

3. Publicar desde el dashboard o via CLI:

```bash
node src/publish-article.mjs articles/temoignage-haute-finance-luciferienne-ronald-bernard.json
```

---

#### Opción B — Marcar el artículo como retirado (no se quiere re-publicar)

1. Actualizar el JSON para reflejar el estado real:

```bash
node -e "
const fs = require('fs');
const path = 'articles/temoignage-haute-finance-luciferienne-ronald-bernard.json';
const a = JSON.parse(fs.readFileSync(path));
delete a.spipArticleId;
delete a.publishedAt;
delete a.publishedUrl;
a.workflowStatus = 'retractado';
a.retractedAt = new Date().toISOString();
fs.writeFileSync(path, JSON.stringify(a, null, 2) + '\n');
console.log('OK');
"
```

2. El artículo desaparecerá de la pestaña Terminado (o aparecerá en la
   futura sección "Retirados" — ver ROADMAP.md Etapa 3.5).

---

### Causa raíz y prevención futura

El dashboard no tiene mecanismo para detectar que un artículo previamente
enviado fue borrado de SPIP después. El campo `spipArticleId` en el JSON
local es la única fuente de verdad local — si el artículo desaparece de
SPIP sin que el JSON se actualice, el dashboard queda desincronizado.

La pestaña **🌐 Sitio** → panel "Estado del audit log" → botón **"🔍 Verificar en SPIP"**
(distinto del botón "↺ Actualizar" del dashboard principal, que solo recarga la lista de artículos) detecta duplicados pero no
detecta artículos borrados cuyo `spipArticleId` sigue en el JSON. Esto
está documentado como trabajo futuro en ROADMAP.md Etapa 3.5 (botón
"Desaprobar" que actualiza el JSON al retirar un artículo de SPIP).

Mientras tanto: siempre que se borre un artículo de SPIP desde `/ecrire/`
o vía `permanently-delete-article.mjs`, actualizar el JSON local
manualmente o via Opción A/B de arriba.
