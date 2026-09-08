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

### Resuelto — 2026-09-08

El artículo francés "La haute finance luciférienne" fue re-enviado a SPIP
como **#124** en la sección francesa correcta (`nomfr` → rubrique 9,
"NOUVEL ORDRE/PLANDÉMISME ET DOMESTICATION").

Estado actual: `prepa` — en la cola de revisión humana, no visible al público.
Próximo paso: un editor debe ir a `/ecrire/` y cambiarlo a `publie`.

### Qué pasó (histórico)

El artículo original #111 fue enviado a SPIP correctamente, luego **borrado
de SPIP** en una sesión de mantenimiento. El JSON local nunca fue actualizado
— seguía diciendo `terminado` + `spipArticleId: "111"`, pero ese ID ya no
existía. El dashboard mostraba "publicado" incorrectamente.

Además, la sección estaba mal asignada: `section: "nom"` apunta a rubrique
`19` (sección española "NUEVO ORDEN/PLANDEMISMO Y DOMESTICACIÓN"). El artículo
francés debe ir a rubrique `9` ("NOUVEL ORDRE/PLANDÉMISME ET DOMESTICATION").

### Correcciones aplicadas

- `spip-client.mjs`: añadido `nomfr → 9` a `SLUG_TO_RUBRIQUE_ID`
- `article-validator.mjs`: `nomfr` añadido a `VALID_SECTIONS`
- JSON del artículo: `section` corregida de `nom` a `nomfr`, marcadores
  de #111 limpiados, re-publicado como #124

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
