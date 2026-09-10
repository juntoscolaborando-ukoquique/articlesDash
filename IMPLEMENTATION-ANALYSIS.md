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

#### 2A. Backend endpoint: `POST /api/site/find-local-duplicates`

**File:** `src/server.mjs`

```javascript
app.post('/api/site/find-local-duplicates', asyncHandler('find duplicates', async (req, res) => {
  const articles = listArticles();
  
  // Import the normalize function from the frontend
  // (or reimplement here)
  function normalizeTitle(title) {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove diacritics
      .replace(/[^\w\s]/g, '')         // keep only alphanumerics + spaces
      .replace(/\s+/g, ' ')            // collapse whitespace
      .trim();
  }
  
  const titleMap = new Map(); // normalizedTitle → array of articles
  
  for (const article of articles) {
    const norm = normalizeTitle(article.title);
    if (!titleMap.has(norm)) titleMap.set(norm, []);
    titleMap.get(norm).push({
      id: article.id,
      filename: article.filename,
      title: article.title,
      workflowStatus: article.workflowStatus,
      spipArticleId: article.spipArticleId || null,
      valid: article.valid,
      section: article.section,
    });
  }
  
  const duplicates = [];
  for (const [normalized, group] of titleMap) {
    if (group.length > 1) {
      // Sort by most recent first (rough heuristic: later filenames)
      group.sort((a, b) => b.filename.localeCompare(a.filename));
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

#### 2B. New endpoint: `DELETE /api/articles/:id` (for local cleanup)

**File:** `src/server.mjs`

```javascript
app.delete('/api/articles/:id', asyncHandler('delete article file', async (req, res) => {
  const { id } = req.params;
  const articles = listArticles();
  const article = articles.find(a => a.id === id);
  
  if (!article) {
    return res.status(404).json({ success: false, error: 'Artículo no encontrado' });
  }
  
  // Prevent deletion of already-published articles (only delete unpublished drafts)
  if (article.spipArticleId) {
    return res.status(400).json({
      success: false,
      error: `No se puede borrar: artículo ya publicado en SPIP (#${article.spipArticleId}). Usa "Borrar de SPIP" primero.`
    });
  }
  
  // Check workflow status (only allow deletion of draft/early stages)
  if (!['edicion', 'en-progreso'].includes(article.workflowStatus)) {
    return res.status(400).json({
      success: false,
      error: `No se puede borrar artículos en estado "${article.workflowStatus}". Solo borradores (edicion/en-progreso).`
    });
  }
  
  try {
    const filePath = path.join(ARTICLES_DIR, article.filename);
    fs.unlinkSync(filePath);
    
    // Log the deletion
    await guardedWrite({
      action: 'article.file.delete',
      target: { id },
      dryRun: false,
      execute: async () => ({ success: true }),
    });
    
    res.json({ success: true, message: `Artículo ${id} borrado.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}));
```

#### 2C. Frontend UI in `public/js/site-admin.js`

```javascript
// New card in the Sitio section for duplicate finding
export async function handleFindDuplicates() {
  const btn = document.getElementById('btn-find-duplicates');
  const result = document.getElementById('duplicates-result');
  
  btn.disabled = true;
  result.innerHTML = '<p>Buscando duplicados locales…</p>';
  
  try {
    const res = await fetch('/api/site/find-local-duplicates', { method: 'POST' });
    const data = await res.json();
    
    if (!res.ok || !data.success) {
      result.innerHTML = `<p class="err">Error: ${data.error}</p>`;
      return;
    }
    
    if (data.duplicates.length === 0) {
      result.innerHTML = '<p class="ok">✓ No se encontraron duplicados locales.</p>';
      return;
    }
    
    // Render duplicate groups
    let html = `<h4>⚠️ ${data.duplicates.length} grupo(s) de duplicados encontrados:</h4>`;
    
    for (let i = 0; i < data.duplicates.length; i++) {
      const group = data.duplicates[i];
      html += `
        <div class="duplicate-group" data-group="${i}">
          <h5>"${group.articles[0].title}"</h5>
          <ul>
      `;
      
      for (let j = 0; j < group.articles.length; j++) {
        const article = group.articles[j];
        const isCanonical = j === 0;
        const badge = isCanonical ? ' <span class="badge canonical">[Conservar]</span>' : '';
        const spip = article.spipArticleId ? `SPIP #${article.spipArticleId}` : '—';
        
        html += `
          <li>
            <input type="radio" name="group-${i}" value="${article.id}" ${isCanonical ? 'checked' : ''}>
            <span class="title">${article.title}</span>
            <span class="status">${article.workflowStatus}</span>
            <span class="spip">${spip}</span>
            ${badge}
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
    result.innerHTML = `<p class="err">Error de red: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
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
    alert('Solo hay un artículo en este grupo.');
    return;
  }
  
  const confirmed = confirm(
    `Sobre ${toDelete.length} artículos duplicados:\n` +
    toDelete.map(id => ` - ${id}`).join('\n') +
    `\n\nConservar: ${selected}\n\n¿Continuar?`
  );
  if (!confirmed) return;
  
  btn.disabled = true;
  btn.textContent = 'Borrando…';
  
  for (const id of toDelete) {
    try {
      const res = await fetch(`/api/articles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Error al borrar ${id}`);
      }
    } catch (err) {
      alert(`❌ Error al borrar ${id}: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'Eliminar no seleccionados';
      return;
    }
  }
  
  alert(`✅ ${toDelete.length} artículos borrados.`);
  group.remove();
  if (result.children.length === 0) {
    result.innerHTML = '<p class="ok">✓ Todos los duplicados han sido eliminados.</p>';
  }
  
  btn.disabled = false;
}

// Wire up the button
document.getElementById('btn-find-duplicates')?.addEventListener('click', handleFindDuplicates);
```

#### 2D. HTML UI in `public/index.html`

Add to the Sitio section (inside `.site-card` container):

```html
<div class="site-card">
  <h3>🔍 Duplicados locales</h3>
  <p>Busca artículos con títulos similares en tus borradores.</p>
  <button id="btn-find-duplicates">Buscar duplicados</button>
  <div id="duplicates-result"></div>
</div>
```

#### 2E. CSS in `public/index.html`

```css
.duplicate-group {
  border: 1px solid var(--muted);
  border-radius: 4px;
  padding: 12px;
  margin: 8px 0;
}

.duplicate-group h5 {
  margin: 0 0 8px 0;
  font-weight: bold;
}

.duplicate-group ul {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.duplicate-group li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 0.9rem;
}

.duplicate-group .title {
  flex: 1;
}

.duplicate-group .status {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 2px;
  font-size: 0.8rem;
}

.duplicate-group .spip {
  color: var(--muted);
  font-size: 0.85rem;
}

.badge.canonical {
  background: var(--green);
  color: white;
  padding: 2px 6px;
  border-radius: 2px;
  font-size: 0.75rem;
}

.btn-delete-dup {
  background: var(--red);
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
}

.btn-delete-dup:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

### Effort estimate

- Backend endpoints: 2 hours
- Frontend UI + handlers: 2 hours
- Testing: 1 hour
- **Total: ~5 hours**

### Quick wins / Future enhancements

1. **Display file size** — help users identify which duplicate is larger/more complete
2. **Show creation date** — from filename (e.g., `articulo-1789123456789.json` → parse timestamp)
3. **Merge functionality** — combine fields from both articles before deleting one
4. **Undo button** — restore deleted article from git history (if needed)

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

| File | Change | Effort |
|------|--------|--------|
| `REMOTE-MANAGE.md` | Create (document remote operations) | ✅ Done |
| `src/server.mjs` | Add endpoints + handlers | 2 hours |
| `public/js/site-admin.js` | Add duplicate UI logic | 1.5 hours |
| `public/index.html` | Add card + CSS | 0.5 hours |
| `src/lib/articles-store.mjs` | Maybe export `normalizeTitle` for reuse | 0.25 hours |
| `IMPLEMENTATION-ANALYSIS.md` | Create (this file) | ✅ Done |
| `test/` | Add tests for new endpoints | Optional (1-2 hours) |

---

## Conclusion

**Feasibility:** ✅ All three items are feasible.

1. **Issue 1 (document local vs. remote):** ✅ Done → `REMOTE-MANAGE.md` created
2. **Issue 2 (duplicates in Sitio):** ✅ Feasible → 5 hours, high value
3. **Issue 3 (direct deletion):** 🔴 Not recommended → trade-off: safety > convenience

**Recommended next step:** Implement Issue 2 (duplicates in Sitio), starting with backend endpoints.
