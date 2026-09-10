# REMOTE-MANAGE.md — Gestión Remota de Artículos en SPIP

Este documento cubre todas las operaciones que afectan directamente a **kilombo.top en vivo** (cambios de estado, borrados permanentes, recuperación de marcadores). No toca artículos locales en borrador.

---

## 1. Conceptos fundamentales

### Artículo remoto vs. local
- **Local:** archivo JSON en `articles/` — es un borrador o versión en edición
- **Remoto:** artículo en SPIP (kilombo.top) — es la versión publicada o en revisión
- Este documento solo cubre operaciones **remotas**

### Audit log
El archivo `live-write-audit.log.jsonl` registra cada publicación, cambio de estado y borrado permanente. Es el único registro de verdad para reconciliar estados entre local y remoto.

---

## 2. Flujo de dos pasos para borrado permanente

### ¿Por qué dos pasos?

SPIP solo permite borrado permanente desde la página de papelera (`/ecrire/?exec=corbeille`). Un artículo debe estar explícitamente marcado como "A la papelera" antes de poder ser eliminado. Este es un diseño seguro que evita borrados accidentales.

### Paso 1: Mover a papelera

```bash
npm run status -- --change --id <spip_id> --status poubelle
```

O desde el dashboard: **Sitio** → "Cambiar estado" → selecciona "A la papelera"

### Paso 2: Borrar permanentemente

```bash
npm run delete-article -- --id <spip_id>
```

O desde el dashboard: **Sitio** → "Borrado permanente" → confirma (IRREVERSIBLE)

### Verificación

Una vez borrado, el artículo desaparece completamente de SPIP. El audit log registra ambas operaciones:
- `article.status.change` con `status: "poubelle"`
- `article.delete.permanent` con `success: true`

---

## 3. Detección y reparación de duplicados en SPIP

### Qué es un duplicado

Mismo artículo local publicado más de una vez → múltiples SPIP IDs para el mismo `id` local.

**Ejemplo:** articulo-X fue publicado, falló el write-back, se reintentó, resultando en:
- SPIP ID #234 (primer intento, exitoso)
- SPIP ID #235 (reintento, también exitoso)

Solo uno de ellos (típicamente el más reciente) debería existir.

### Cómo ocurren

1. Fallo de red al intentar escribir el `spipArticleId` al JSON local
2. Reintento manual de publicación sin esperar a que se escriba el marcador
3. Cambios del lado de SPIP que el dashboard no detecta
4. Bugs en middleware editorial

### Flujo: encontrar y reparar duplicados

#### Paso 1: Scan local (rápido)

```bash
npm run audit -- --report
```

Busca en `live-write-audit.log.jsonl`:
- Múltiples entradas `article.create` con `success: true` para el mismo slug local
- Devuelve: lista de slugs con > 1 SPIP ID

**Salida:**
```
✓ ok: 156 artículos (un solo SPIP ID, marcador coincide)
⚠️ duplicates: 3 artículos con múltiples SPIP IDs
```

#### Paso 2: Verificar en SPIP (lento pero preciso)

Dashboard → **Sitio** → botón **"🔍 Verificar en SPIP"**

Conecta a SPIP vía Playwright y navega a cada SPIP ID:
- ¿Sigue existiendo el artículo?
- ¿En qué estado está?
- ¿Hace falta borrarlo?

**Salida:**
```
❌ Duplicados detectados:
   articulo-X: IDs #234, #235
     #234: ✓ En SPIP (redacción)
     #235: ✓ En SPIP (redacción)   ← este es el duplicado

✓ Si borras #234, quedará: #235 como canónico
```

#### Paso 3: Eliminar duplicado(s) más antiguos

Dashboard → **Sitio** → "Mover a papelera" (el duplicado más viejo)

Dashboard → **Sitio** → "Borrar permanentemente"

#### Paso 4: Confirmar

Dashboard → **Sitio** → **"🔍 Verificar en SPIP"** de nuevo

Resultado esperado:
```
✅ Sin duplicados activos verificado en SPIP
```

### Caso especial: Duplicado ya borrado externamente

Si alguien borró un artículo directamente en `/ecrire/` (fuera del dashboard), el audit log todavía tiene la entrada `article.create` para ese ID. El scan mostrará que es un "duplicado fantasma".

**Solución:** dashboard → **Sitio** → botón "✓ Confirmar borrado" (marca el ID como `delete.permanent` en el audit log sin intentar borrarlo de nuevo)

---

## 4. Recuperación de marcadores perdidos (write-back failures)

### Qué es una "write-back failure"

Una publicación fue exitosa en SPIP (el artículo se creó, recibió un ID), pero falló la escritura del `spipArticleId` en el JSON local. Resultado:
- **Dashboard:** muestra `spipArticleId: null` (parece no publicado)
- **Audit log:** registro `article.create` con el ID exitoso
- **SPIP:** el artículo existe con el ID registrado

### Cómo se ve

Dashboard → **Sitio** → "Estado del audit log" → sección **"⚠️ Write-backs faltantes"**

```
articulo-Y fue publicado exitosamente (SPIP ID #456)
pero el JSON local no quedó actualizado.
```

### Reparación

CLI:
```bash
node src/publish-article.mjs articulo-Y --recover-from-log
```

O desde dashboard (futuro): botón "Recuperar marcador"

**Efecto:** lee el audit log, encuentra la entrada `article.create` más reciente exitosa, escribe el `spipArticleId` en el JSON local, registra la operación como `article.writeBack.recovery`.

---

## 5. Cambios de estado en SPIP (editorial workflow)

### Estados válidos

| Estado | Valor | Descripción |
|--------|-------|-------------|
| En curso de redacción | `prepa` | Borrador, no visible públicamente |
| Propuesto a evaluación | `prop` | En revisión editorial |
| Publicado | `publie` | Visible en el sitio público |
| Rechazado | `refuse` | Editorial rechazó publicar |
| A la papelera | `poubelle` | Retirado, preparado para borrado |

### Cambiar estado (CLI)

```bash
npm run status -- --change --id <spip_id> --status <estado>
```

**Ejemplo:**
```bash
npm run status -- --change --id 456 --status publie
```

⚠️ **Gate de seguridad:** publicación directa requiere variable de entorno:
```bash
KILO_APPROVE_PUBLISHING=true npm run status -- --change --id 456 --status publie
```

### Cambiar estado (Dashboard)

**Sitio** → "Cambiar estado" → ingresa SPIP ID → selecciona estado → confirma

Gate de confirmación automático para `publie`.

---

## 6. Flujo completo: ejemplo end-to-end de limpieza

Escenario: articulo-X se publicó dos veces. Necesitas dejar solo la versión más reciente en SPIP.

```
1. npm run audit -- --report
   ✓ Confirma: articulo-X tiene IDs #234 y #235

2. Dashboard → Sitio → "Verificar en SPIP"
   ✓ Confirma: ambos IDs siguen vivos

3. Decide: #234 es el viejo (2026-09-05), #235 es el nuevo (2026-09-10)
   → Elimina #234

4. Dashboard → Sitio → "Cambiar estado"
   - Ingresa: 234
   - Selecciona: "A la papelera"
   - Confirma

5. Dashboard → Sitio → "Borrado permanente"
   - Ingresa: 234
   - Confirma (IRREVERSIBLE)

6. Dashboard → Sitio → "Verificar en SPIP"
   ✓ Resultado: "Solo #235 (canónico) sigue vivo"

7. npm run audit -- --report
   ✓ Confirma: articulo-X ahora tiene 1 solo SPIP ID (#235)
```

---

## 7. Operaciones rápidas vs. lentas

### Rápidas (< 1 segundo)

- `npm run audit -- --report` (lee archivo local JSON)
- Dashboard → Sitio → audit panel (lee audit log)
- Dashboard → Sitio → "Buscar duplicados locales" (compara títulos en memoria)

**Recomendación:** usarlas para pre-checks antes de operaciones remotas.

### Lentas (10-60 segundos)

- Dashboard → Sitio → "Verificar en SPIP" (Playwright + login + navegación web)
- `npm run status -- --inspect --id <id>` (igual, Playwright)
- `npm run delete-article -- --id <id>` (incluye navegación a papelera)

**Recomendación:** usarlas cuando necesites confirmar estado real, no como chequeo rutinario.

---

## 8. Futuro: detección de duplicados locales

### ¿Qué es?

Dos artículos locales (JSON) con títulos casi idénticos pero IDs diferentes. Ejemplo:

- `articulo-X.json` — "Vacunas COVID — La conspiración"
- `articulo-Y.json` — "Vacunas COVID: la conspiración"

Podrían ser el mismo artículo redactado dos veces accidentalmente, o dos versiones que se pueden consolidar.

### Cómo usarlo (cuando esté implementado)

Dashboard → **Sitio** → "Buscar duplicados locales"

Resultado:
```
⚠️ Encontrados 2 duplicados:

Grupo 1: "Vacunas COVID conspiración"
  ☑ articulo-X (terminado, SPIP #215)  ← canónico, conservar
  ☐ articulo-Y (en-progreso, no publicado)

[✓ Eliminar no seleccionados]
```

El usuario:
1. Elige cuál conservar (el canónico)
2. Hace click en "Eliminar"
3. El dashboard borra los no seleccionados

---

## 9. Troubleshooting

### "El login a SPIP falla"

**Causas posibles:**
- `KILOMBOTOP_PASSWORD` en `.env` es incorrecta o vacía
- Cuenta de usuario bloqueada en SPIP
- SPIP está fuera de servicio

**Solución:**
```bash
# Verifica que la contraseña esté cargada
cat .env | grep KILOMBOTOP

# Prueba login manual
npm run status -- --inspect --id 1
```

### "Cambio de estado dice 'no encontrado' pero el artículo existe"

El widget de estado de SPIP puede haber cambiado en versiones nuevas, o el artículo está en un estado especial.

**Solución:**
1. Navega manualmente a `https://www.kilombo.top/ecrire/?exec=article&id_article=<id>`
2. Verifica que el widget de estado esté visible
3. Si cambió el layout, avísanos para actualizar el parser de Playwright

### "Borrado permanente dice 'sigue en papelera' pero lo acabo de mover"

El artículo puede necesitar un refresh o no estar realmente en papelera.

**Solución:**
```bash
# Verifica el estado actual
npm run status -- --inspect --id <id>

# Intenta borrar de nuevo (el script reintenta)
npm run delete-article -- --id <id>
```

### "Verificar en SPIP tarda mucho (2-5 minutos)"

Es normal. Estamos usando Playwright (un navegador real) para:
1. Login SSO
2. Navegación a múltiples artículos
3. Lectura del DOM

**Paciencia.** No hay forma de acelerarlo sin cambiar a una API de SPIP (que no existe en la versión 4.x).

---

## 10. Notas arquitectónicas para mejoras futuras

### Quick wins (bajo esfuerzo, alto valor)

1. **Eliminar el requisito de papelera**
   - Implementar borrado directo desde `terminado` → nada
   - Requiere verificar si SPIP permite borrado directo (sin papelera)
   - Esfuerzo: bajo (1-2 horas de research + 1 hora de código)
   - Valor: conveniencia, menos clicks

2. **Auto-detección de cambios externos en SPIP**
   - Polling periódico del audit log vs. SPIP real
   - Notificación si un ID desaparece (fue borrado externamente)
   - Esfuerzo: medio (requiere endpoint que corra en background)
   - Valor: visibilidad de cambios inesperados

3. **Botones directos en fila de artículo**
   - "Desaprobar" (terminado → en-progreso) en Terminado
   - "Borrar de SPIP" en Terminado (mover a papelera + borrar)
   - Esfuerzo: bajo (UI + 2 click handlers)
   - Valor: flujo más directo, menos UI pesada

### Cambios arquitectónicos (alto esfuerzo, alto valor)

1. **Migrar a API REST de SPIP**
   - SPIP 4.2+ expone una API JSON si está habilitada
   - Eliminaría necesidad de Playwright
   - Operaciones remotas serían instantáneas
   - Esfuerzo: alto (reescribir `spip-admin.mjs`, `spip-client.mjs`)
   - Valor: rendimiento, confiabilidad, menos frágil

2. **Webhooks desde SPIP**
   - SPIP notifica cambios vía POST a nuestro servidor
   - Dashboard se actualiza en tiempo real
   - Esfuerzo: muy alto (requiere integración profunda con SPIP)
   - Valor: real-time sync, sin polling

---

## 11. Resumen de comandos

```bash
# Lectura
npm run audit -- --report                      # Scan local de duplicados
npm run status -- --inspect --id <id>          # Ver estado actual de un artículo

# Cambio de estado
npm run status -- --change --id <id> --status poubelle   # Mover a papelera
npm run status -- --change --id <id> --status publie     # Publicar (requiere env var)

# Borrado permanente (2 pasos)
npm run status -- --change --id <id> --status poubelle
npm run delete-article -- --id <id>

# Recuperación
node src/publish-article.mjs <file.json> --recover-from-log

# Dashboard (local)
npm run dashboard    # Inicia en http://localhost:3000
```

---

## 12. Contacto y reportes

Si encuentras inconsistencias entre el audit log y SPIP real:
1. Ejecuta `npm run audit -- --report` (snapshot local)
2. Ejecuta dashboard → Sitio → "Verificar en SPIP" (snapshot remoto)
3. Reporta si los dos divergen (posible bug en reconciliación)
