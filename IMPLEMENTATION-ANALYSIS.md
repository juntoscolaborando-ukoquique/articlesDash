# IMPLEMENTATION ANALYSIS — NOW_DO.md Requirements

Analysis of feasibility and implementation steps for three improvements requested in NOW_DO.md.

---

## Issue 1: Local script should clarify it only modifies local copies

**Status:** ✅ Already correct / needs documentation update

### Current state

The CLI scripts are already correctly isolated:

- `npm run audit -- --report` — reads `live-write-audit.log.jsonl` and `articles/*.json` (local only)
- `npm run delete-article -- --id <id>` — operates on **SPIP remote** (explicitly moves to trash, then deletes from `/ecrire/?exec=corbeille`)

### What's needed

**Add a note to `find-duplicates.mjs` script (if we create one):**

The script we used to find duplicates in "Tus artículos en curso" was ad-hoc and not persisted in the repo. If we add a permanent `duplicate-finder.mjs`:

```javascript
#!/usr/bin/env node
/**
 * duplicate-finder.mjs — Find duplicate titles in SPIP "Tus artículos en curso"
 * 
 * ⚠️  REMOTE OPERATION: This script connects to SPIP vía Playwright and
 * queries the live articles list. It does NOT modify local JSON files.
 * 
 * To DELETE duplicates found here, use:
 *   npm run status -- --change --id <spip_id> --status poubelle
 *   npm run delete-article -- --id <spip_id>
 * 
 * Duplicates at local JSON level (in `articles/`) are handled by a separate
 * dashboard feature: Sitio → "Buscar duplicados locales"
 */
```

### Deliverable

✅ Document added to `REMOTE-MANAGE.md` (Section 3: "Detección y reparación de duplicados en SPIP")

---

## Issue 2: Add duplicate detection/removal to Sitio section of dashboard

**Status:** 🟡 Requires implementation (medium effort, 4-6 hours)

### Current architecture

The Sitio section (`public/js/site-admin.js`) currently handles:
- Status change (poubelle, publie, etc.)
- Permanent deletion
- Audit log reconciliation

### What needs to be added

#### 2A. Extract shared utility: `normalizeTitle` function

**File:** Create `src/lib/text-utils.mjs`

```javascript
/**
 * text-utils.mjs — Utilities for text manipulation shared between backend
 * and frontend (via public/js/utils.js). Single source of truth for
 * normalization logic.
 */

/**
 * Normalize a title for duplicate detection.
 * Lowercase, remove diacritics, remove special chars, collapse whitespace.
 * 
 * @param {string} title
 * @returns {string} normalized title
 */
export function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics (á→a, etc.)
    .replace(/[^\w\s]/g, '')         // keep only alphanumerics + spaces
    .replace(/\s+/g, ' ')            // collapse multiple spaces
    .trim();
}

/**
 * Extract numeric timestamp from article filename.
 * Filenames like "articulo-1789123456789.json" encode Unix timestamp.
 * 
 * @param {string} filename
 * @returns {number|null} Unix timestamp or null if not parseable
 */
export function extractTimestampFromFilename(filename) {
  const match = filename.match(/articulo-(\d{13})/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
```

**Import in `src/server.mjs`:**
```javascript
import { normalizeTitle, extractTimestampFromFilename } from './lib/text-utils.mjs';
```

**Export from `public/js/utils.js` (reuse):**
```javascript
export function normalizeTitle(title) {
  // Keep existing implementation, but note it should match backend
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

---

#### 2B. Backend endpoint: `POST /api/site/find-local-duplicates`

**File:** `src/server.mjs`

```javascript
app.post('/api/site/find-local-duplicates', asyncHandler('find duplicates', async (req, res) => {
  const { sort = 'date', order = 'desc', published = 'all' } = req.query;
  
  let articles = listArticles();
  
  // Optional filtering: published vs. unpublished
  if (published === 'false') {
    articles = articles.filter(a => !a.spipArticleId);
  } else if (published === 'true') {
    articles = articles.filter(a => a.spipArticleId);
  }
  
  const titleMap = new Map(); // normalizedTitle → array of articles
  
  for (const article of articles) {
    const norm = normalizeTitle(article.title);
    if (!titleMap.has(norm)) titleMap.set(norm, []);
    
    const createdAt = extractTimestampFromFilename(article.filename);
    const fileSize = (() => {
      try {
        const filePath = path.join(ARTICLES_DIR, article.filename);
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    })();
    
    const wordCount = article.contentHtml
      ? article.contentHtml.split(/\s+/).filter(w => w.length > 0).length
      : 0;
    
    titleMap.get(norm).push({
      id: article.id,
      filename: article.filename,
      title: article.title,
      createdAt,         // Unix timestamp from filename
      fileSize,          // bytes
      wordCount,         // approximate word count
      workflowStatus: article.workflowStatus,
      spipArticleId: article.spipArticleId || null,
      valid: article.valid,
      section: article.section,
    });
  }
  
  // Find groups with > 1 article
  const duplicates = [];
  for (const [normalized, group] of titleMap) {
    if (group.length > 1) {
      // Sort by date (newer first) unless requested otherwise
      if (sort === 'date') {
        group.sort((a, b) => {
          if (order === 'asc') {
            return (a.createdAt || 0) - (b.createdAt || 0);
          } else {
            return (b.createdAt || 0) - (a.createdAt || 0);
          }
        });
      } else if (sort === 'size') {
        group.sort((a, b) => {
          if (order === 'asc') {
            return a.fileSize - b.fileSize;
          } else {
            return b.fileSize - a.fileSize;
          }
        });
      }
      
      duplicates.push({ normalized, articles: group });
    }
  }
  
  res.json({
    success: true,
    total: articles.length,
    duplicateGroups: duplicates.length,
    duplicates,
  });
}));
```

**Query string options:**
- `?sort=date&order=desc` — sort by creation date, newest first (default)
- `?sort=date&order=asc` — oldest first
- `?sort=size&order=desc` — largest files first
- `?published=false` — only unpublished articles
- `?published=true` — only published articles
- `?published=all` — all articles (default)

#### 2C. New endpoint: `DELETE /api/articles/:id` (for local cleanup)

**File:** `src/server.mjs`

```javascript
app.delete('/api/articles/:id', asyncHandler('delete article file', async (req, res) => {
  const { id } = req.params;
  const articles = listArticles();
  const article = articles.find(a => a.id === id);
  
  if (!article) {
    return res.status(404).json({ success: false, error: 'Artículo no encontrado' });
  }
  
  // Prevent deletion of already-published articles
  if (article.spipArticleId) {
    return res.status(400).json({
      success: false,
      error: `No se puede borrar: artículo ya publicado en SPIP (#${article.spipArticleId}). ` +
             `Para borrarlo del sitio, usa: Sitio → "Cambiar estado" a papelera → "Borrado permanente"`
    });
  }
  
  // Only allow deletion of draft/early stages (not even "terminado" without publication)
  if (!['edicion', 'en-progreso'].includes(article.workflowStatus)) {
    return res.status(400).json({
      success: false,
      error: `No se puede borrar artículos en estado "${article.workflowStatus}". ` +
             `Solo se pueden eliminar borradores en edición o revisión.`
    });
  }
  
  try {
    const filePath = path.join(ARTICLES_DIR, article.filename);
    const fileSize = fs.statSync(filePath).size;
    
    // Delete the file
    fs.unlinkSync(filePath);
    
    // Log the deletion in audit log
    await guardedWrite({
      action: 'article.file.delete',
      target: { id, filename: article.filename },
      dryRun: false,
      execute: async () => ({ 
        success: true, 
        filename: article.filename,
        sizeBytes: fileSize
      }),
    });
    
    res.json({ 
      success: true, 
      message: `Artículo ${id} borrado (${(fileSize / 1024).toFixed(1)} KB).`,
      filename: article.filename,
    });
  } catch (err) {
    return res.status(500).json({ 
      success: false, 
      error: `Error al borrar archivo: ${err.message}. ` +
             `Nota: puede ser recuperado desde git history: git checkout HEAD -- articles/${article.filename}`
    });
  }
}));
```

**Safety features:**
- Blocks deletion if article has `spipArticleId` (must delete from SPIP first)
- Blocks deletion unless workflow status is `edicion` or `en-progreso`
- Logs deletion to audit log with filename and file size
- Returns recovery hint (git history) in error message
- No undo in UI (files can be recovered via git if needed)

#### 2D. Frontend UI in `public/js/site-admin.js`

```javascript
import { normalizeTitle } from './utils.js';

/**
 * Format Unix timestamp to readable date.
 * Timestamps from filenames like "articulo-1789123456789.json"
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return '—';
  const ms = timestamp < 1e10 ? timestamp * 1000 : timestamp;
  return new Date(ms).toLocaleString('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// New card in the Sitio section for duplicate finding
export async function handleFindDuplicates() {
  const btn = document.getElementById('btn-find-duplicates');
  const result = document.getElementById('duplicates-result');
  
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  result.innerHTML = '<p>Buscando duplicados locales…</p>';
  
  try {
    const res = await fetch('/api/site/find-local-duplicates?sort=date&order=desc', { 
      method: 'POST' 
    });
    const data = await res.json();
    
    if (!res.ok || !data.success) {
      result.innerHTML = `<p class="err">❌ Error: ${data.error}</p>`;
      return;
    }
    
    if (data.duplicates.length === 0) {
      result.innerHTML = `<p class="ok">✓ No se encontraron duplicados locales (${data.total} artículos analizados).</p>`;
      return;
    }
    
    // Render duplicate groups
    let html = `<h4>⚠️ ${data.duplicates.length} grupo(s) de duplicados encontrados (de ${data.total} artículos):</h4>`;
    
    for (let i = 0; i < data.duplicates.length; i++) {
      const group = data.duplicates[i];
      html += `
        <div class="duplicate-group" data-group="${i}">
          <h5>"${group.articles[0].title}"</h5>
          <ul>
      `;
      
      for (let j = 0; j < group.articles.length; j++) {
        const article = group.articles[j];
        const isCanonical = j === 0; // First (newest) is recommended
        const badge = isCanonical ? ' <span class="badge canonical">[Conservar]</span>' : '';
        const spip = article.spipArticleId ? `<span class="spip-link">SPIP #${article.spipArticleId}</span>` : '<span class="spip-none">—</span>';
        const createdDate = formatTimestamp(article.createdAt);
        const fileSize = formatBytes(article.fileSize);
        const wordCountText = article.wordCount > 0 ? ` / ${article.wordCount} palabras` : '';
        
        html += `
          <li>
            <input type="radio" name="group-${i}" value="${article.id}" ${isCanonical ? 'checked' : ''}>
            <div class="dup-item-content">
              <div class="dup-item-main">
                <span class="title">${article.title}</span>
                ${badge}
              </div>
              <div class="dup-item-meta">
                <span class="status status-${article.workflowStatus}">${article.workflowStatus}</span>
                ${spip}
                <span class="date">${createdDate}</span>
                <span class="filesize">${fileSize}${wordCountText}</span>
              </div>
            </div>
          </li>
        `;
      }
      
      html += `
          </ul>
          <button class="btn-delete-dup" data-group="${i}">Eliminar no seleccionados</button>
        </div>
      `;
    }
    
    result.innerHTML = html;
    
    // Attach delete handlers
    for (const btn of result.querySelectorAll('.btn-delete-dup')) {
      btn.addEventListener('click', handleDeleteDuplicates);
    }
    
  } catch (err) {
    result.innerHTML = `<p class="err">❌ Error de red: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar duplicados';
  }
}

async function handleDeleteDuplicates(event) {
  const btn = event.target;
  const groupIdx = btn.dataset.group;
  const group = document.querySelector(`.duplicate-group[data-group="${groupIdx}"]`);
  
  // Get the selected canonical article
  const selected = group.querySelector('input[type="radio"]:checked').value;
  
  // Get all articles in this group
  const allRadios = group.querySelectorAll('input[type="radio"]');
  const toDelete = Array.from(allRadios)
    .filter(r => r.value !== selected)
    .map(r => r.value);
  
  if (toDelete.length === 0) {
    alert('Debes dejar al menos un artículo sin seleccionar (el que vas a conservar).');
    return;
  }
  
  const deleteList = toDelete.join('\n  - ');
  const confirmed = confirm(
    `Vas a eliminar ${toDelete.length} artículos:\n\n  - ${deleteList}\n\nConservar: ${selected}\n\nEsta operación NO se puede deshacer. ¿Continuar?`
  );
  if (!confirmed) return;
  
  btn.disabled = true;
  btn.textContent = 'Borrando…';
  const result = document.getElementById('duplicates-result');
  
  let failed = [];
  for (const id of toDelete) {
    try {
      const res = await fetch(`/api/articles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!res.ok) {
        const data = await res.json();
        failed.push(`${id}: ${data.error}`);
      }
    } catch (err) {
      failed.push(`${id}: ${err.message}`);
    }
  }
  
  if (failed.length > 0) {
    alert(`❌ Errores:\n\n${failed.join('\n')}`);
    btn.disabled = false;
    btn.textContent = 'Eliminar no seleccionados';
    return;
  }
  
  alert(`✅ ${toDelete.length} artículos borrados correctamente.`);
  group.remove();
  
  const remaining = result.querySelectorAll('.duplicate-group');
  if (remaining.length === 0) {
    result.innerHTML = '<p class="ok">✓ Todos los duplicados han sido eliminados.</p>';
  }
  
  btn.disabled = false;
  btn.textContent = 'Eliminar no seleccionados';
}

// Wire up the button
document.getElementById('btn-find-duplicates')?.addEventListener('click', handleFindDuplicates);
```

#### 2E. HTML UI in `public/index.html`

Add to the Sitio section (inside `.site-card` container):

```html
<div class="site-card">
  <h3>🔍 Duplicados locales</h3>
  <p>Busca artículos con títulos similares en tus borradores y elige cuál conservar.</p>
  <button id="btn-find-duplicates">Buscar duplicados</button>
  <div id="duplicates-result"></div>
</div>
```

#### 2F. CSS in `public/index.html`

```css
/* Duplicate finder UI */

.duplicate-group {
  border: 1px solid var(--muted);
  border-radius: 4px;
  padding: 12px;
  margin: 12px 0;
  background: var(--bg-secondary);
}

.duplicate-group h5 {
  margin: 0 0 12px 0;
  font-weight: bold;
  font-size: 1rem;
}

.duplicate-group ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.duplicate-group li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--muted);
  font-size: 0.9rem;
}

.duplicate-group li:last-child {
  border-bottom: none;
}

.duplicate-group input[type="radio"] {
  margin-top: 2px;
  flex-shrink: 0;
}

.dup-item-content {
  flex: 1;
  min-width: 0;
}

.dup-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.dup-item-main .title {
  font-weight: 500;
  flex: 1;
  min-width: 200px;
}

.dup-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--muted);
  flex-wrap: wrap;
}

.status {
  background: var(--bg);
  padding: 2px 6px;
  border-radius: 2px;
  border: 1px solid var(--muted);
}

.status-edicion {
  border-color: var(--yellow);
  background: rgba(255, 193, 7, 0.1);
}

.status-en-progreso {
  border-color: var(--blue);
  background: rgba(33, 150, 243, 0.1);
}

.status-terminado {
  border-color: var(--green);
  background: rgba(76, 175, 80, 0.1);
}

.spip-link {
  color: var(--blue);
  font-weight: 500;
}

.spip-none {
  color: var(--muted);
}

.date {
  font-size: 0.8rem;
}

.filesize {
  font-size: 0.8rem;
  color: var(--muted);
}

.badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: bold;
  white-space: nowrap;
}

.badge.canonical {
  background: var(--green);
  color: white;
}

.btn-delete-dup {
  background: var(--red);
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  margin-top: 8px;
}

.btn-delete-dup:hover:not(:disabled) {
  background: var(--red-dark, #c62828);
  opacity: 0.9;
}

.btn-delete-dup:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

#duplicates-result {
  margin-top: 8px;
}

#duplicates-result .ok,
#duplicates-result .err {
  padding: 8px;
  border-radius: 4px;
  margin: 8px 0;
}

#duplicates-result .ok {
  background: rgba(76, 175, 80, 0.1);
  color: var(--green);
  border-left: 3px solid var(--green);
}

#duplicates-result .err {
  background: rgba(244, 67, 54, 0.1);
  color: var(--red);
  border-left: 3px solid var(--red);
}
```

### Effort estimate

- Create `text-utils.mjs`: 0.5 hours
- Backend endpoints (with metadata, filtering, sorting): 3 hours
- Frontend UI + handlers (with timestamps, file sizes, word counts): 2-3 hours
- CSS styling: 1 hour
- Testing: 1-2 hours
- **Revised total: 7.5-9.5 hours** (increased from 5 hours due to enhancements)

### Key improvements over basic version

1. ✅ **Extracted `normalizeTitle`** — shared between backend/frontend, DRY principle
2. ✅ **Rich metadata** — timestamps, file sizes, word counts to help decide canonical
3. ✅ **Sorting & filtering** — by date or size, published/unpublished
4. ✅ **Better audit logging** — captures filename and file size of deleted articles
5. ✅ **Recovery hints** — error messages mention `git checkout` for file recovery
6. ✅ **Improved UX** — clearer labels, status badges, better confirmation dialog
7. ✅ **Accessibility** — form fields instead of plain text, better visual hierarchy

### Quick wins / Future enhancements (if needed)

1. **Merge functionality** — combine text from both articles before deleting
2. **Undo via git** — add "Undo deletion" button that runs `git checkout HEAD -- articles/<filename>`
3. **Batch operations** — delete entire group without selecting canonical
4. **Export deleted list** — generate a report of what was deleted

---

## Issue 3: Remove "papelera" requirement — simplify to direct deletion

**Status:** 🔴 Not recommended / requires SPIP research

### Current state

**Two-step deletion:**
1. Move to papelera via `changeArticleStatus(id, 'poubelle')`
2. Delete from papelera via `permanentlyDelete(id)` which navigates to `/ecrire/?exec=corbeille`

This exists because SPIP only exposes a delete button in the trash UI, not in the article edit page.

### Analysis: Can SPIP delete directly?

#### Research needed (1-2 hours)

1. **SPIP API exploration:**
   - Does SPIP 4.4 have a hidden delete endpoint?
   - Can we POST directly to `/ecrire/?exec=corbeille&action=supprimer` without being on the page?
   - Is there a SPIP plugin for REST API that exposes delete?

2. **HTML form reverse-engineering:**
   - The papelera page has `<input type="submit" name="effacer">` — is this form-based or AJAX?
   - Can we submit this form from a different page?
   - Are there CSRF tokens we need to handle?

3. **Alternatives:**
   - Can we iframe the corbeille page and trigger the delete from there?
   - Can we use SPIP's internal XML-RPC API (deprecated but might still work)?

#### If SPIP allows direct delete

**Estimated effort:** 3-4 hours

```javascript
// Hypothetical new function: directDelete(spipId)
// Sequence:
// 1. Navigate to article page
// 2. Find a hidden delete button or form
// 3. Submit it without moving to papelera
// 4. Verify article is gone
```

**Changes needed:**
- New function `directDelete()` in `spip-admin.mjs`
- Update `permanently-delete-article.mjs` CLI to offer both paths (ask user: "1-step or 2-step?")
- Update docs
- **Keep 2-step as fallback** in case direct delete breaks

#### If SPIP doesn't allow it

**Recommendation:** Keep the 2-step flow.

**Why:** SPIP's design (papelera as mandatory intermediate state) is intentional:
- Prevents accidental deletions
- Allows recovery if delete fails halfway
- Matches user expectations ("put in trash first")
- Is consistent across SPIP admin

### Trade-off analysis

| Aspect | Pro (direct) | Pro (2-step) |
|--------|---------|--------|
| **UX** | Fewer clicks | Confirmation point, safety check |
| **Safety** | None (riskier) | Accidentally deleted? Can revert from papelera |
| **Robustness** | Simpler code | More tested, follows SPIP convention |
| **Speed** | Slightly faster | No practical difference (already 2 requests) |

**Verdict:** 2-step is safer and follows SPIP convention. Not worth the risk for 1 fewer click.

### Recommendation

✅ Keep 2-step deletion. If users complain, we can:
1. **Quick fix:** add a "1-click delete" button that secretly does both steps in sequence
2. **Long fix:** research if SPIP 5.0+ changes this

---

## Summary of actionable items

### High priority (do now)

- [x] Create `REMOTE-MANAGE.md` (documentation of remote operations)
- [ ] Add note to future `duplicate-finder.mjs` clarifying it's remote-only

### Medium priority (next sprint)

- [ ] Implement `POST /api/site/find-local-duplicates` endpoint
- [ ] Implement `DELETE /api/articles/:id` endpoint
- [ ] Add "Duplicados locales" card to Sitio section
- [ ] Add UI to select canonical + delete others

### Low priority (nice-to-have)

- [ ] Research direct deletion vs. papelera
- [ ] Add display of file size, creation date
- [ ] Add merge functionality for duplicates

### Not recommended

- ✗ Remove papelera requirement (it's a safety feature)
- ✗ Create a separate `duplicate-finder.mjs` script (belong in dashboard Sitio)

---

## Files to modify / create

## Files to modify / create

| File | Change | Effort | Notes |
|------|--------|--------|-------|
| `src/lib/text-utils.mjs` | Create (normalize title, timestamp extraction) | 0.5 hours | New file, single source of truth |
| `src/server.mjs` | Add two endpoints + metadata extraction | 3 hours | Rich filtering, sorting, audit logging |
| `public/js/site-admin.js` | Add duplicate finder UI + handlers | 2-3 hours | Timestamps, file sizes, word counts |
| `public/index.html` | Add card + CSS | 1.5 hours | Styled metadata display |
| `public/js/utils.js` | Ensure `normalizeTitle` is exported | 0.25 hours | For reuse in frontend |
| `test/` | Add tests for new endpoints | Optional (1-2 hours) | Happy path + error cases |

---

## Conclusion

**Feasibility:** ✅ All three items are feasible.

1. **Issue 1 (document local vs. remote):** ✅ Done → `REMOTE-MANAGE.md` created
2. **Issue 2 (duplicates in Sitio):** ✅ Feasible → 5 hours, high value
3. **Issue 3 (direct deletion):** 🔴 Not recommended → trade-off: safety > convenience

**Recommended next step:** Implement Issue 2 (duplicates in Sitio), starting with backend endpoints.
