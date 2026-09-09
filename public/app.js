/**
 * app.js — Kilombo Dashboard frontend
 *
 * Responsabilidades:
 *   - Cargar la lista de artículos desde GET /api/articles
 *   - Renderizar la tabla filtrada por tab activo (Terminado / En Progreso)
 *   - Cargar y renderizar el detalle de un artículo desde GET /api/articles/:id
 *   - Manejar el botón "Publicar en SPIP" en ambas vistas
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let articles  = [];
let activeTab = 'terminado'; // 'edicion' | 'en-progreso' | 'terminado'

// ── DOM refs ──────────────────────────────────────────────────────────────────

const tbody          = document.getElementById('articles-body');
const countEl        = document.getElementById('article-count');
const refreshBtn     = document.getElementById('refresh-btn');
const newArticleBtn  = document.getElementById('new-article-btn');
const toastContainer = document.getElementById('toast-container');

const viewList      = document.getElementById('view-list');
const viewDetail    = document.getElementById('view-detail');
const detailContent = document.getElementById('detail-content');
const backBtn       = document.getElementById('back-btn');

const viewEditor       = document.getElementById('view-editor');
const viewSite         = document.getElementById('view-site');
const editorBackBtn    = document.getElementById('editor-back-btn');
const editorTitleInput = document.getElementById('editor-title');
const editorSectionSelect = document.getElementById('editor-section');
const editorBodyInput  = document.getElementById('editor-body');
const editorSaveBtn    = document.getElementById('editor-save-btn');
const editorSendBtn    = document.getElementById('editor-send-btn');
const editorSaveStatus = document.getElementById('editor-save-status');

const tabBtns         = document.querySelectorAll('.tab-btn');
const countEdicion    = document.getElementById('count-edicion');
const countTerminado  = document.getElementById('count-terminado');
const countEnProgreso = document.getElementById('count-en-progreso');

let editingArticleId = null; // id del borrador abierto en la pantalla de Edición

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(message, type = 'info', durationMs = 5000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function sectionLabel(section) {
  const map = {
    general:    'General',
    tierra:     'Tierra',
    gci:        'GCI',
    pi:         'PI',
    nom:        'Nuevo Orden',
    nomfr:      'Nouvel Ordre (FR)',
    actualidad: 'Actualidad',
  };
  return map[section] ?? section ?? '—';
}

// ── Tab logic ─────────────────────────────────────────────────────────────────

function workflowStatusOf(article) {
  // workflowStatus is the source of truth for the tab. Missing = "terminado"
  // (default for articles created before this field existed). The backend
  // already self-heals: an article declared "terminado" that fails
  // validateArticle gets demoted to "en-progreso" on every GET /api/articles,
  // so by the time it reaches here workflowStatus already reflects that.
  // Edición is never auto-assigned — it only shows up if a human sent the
  // article there explicitly, so no self-heal path leads here.
  return article.workflowStatus ?? 'terminado';
}

function isTerminado(article) {
  return workflowStatusOf(article) === 'terminado';
}

function setActiveTab(tab) {
  activeTab = tab;
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  newArticleBtn.style.display = tab === 'edicion' ? '' : 'none';
  if (tab === 'sitio') {
    viewList.style.display  = 'none';
    viewSite.style.display  = 'block';
  } else {
    viewSite.style.display  = 'none';
    viewList.style.display  = 'block';
    renderTable(articles);
  }
}

function updateTabCounts(data) {
  const edicion    = data.filter((a) => workflowStatusOf(a) === 'edicion').length;
  const terminado  = data.filter((a) => workflowStatusOf(a) === 'terminado').length;
  const enProgreso = data.length - edicion - terminado;
  countEdicion.textContent    = edicion;
  countTerminado.textContent  = terminado;
  countEnProgreso.textContent = enProgreso;
}

// ── View switching ────────────────────────────────────────────────────────────

function showListView() {
  viewDetail.style.display = 'none';
  viewEditor.style.display = 'none';
  viewSite.style.display   = 'none';
  viewList.style.display   = 'block';
}

function showDetailViewLoading() {
  viewList.style.display = 'none';
  viewEditor.style.display = 'none';
  viewDetail.style.display = 'block';
  detailContent.innerHTML = '<p style="color:var(--muted)">Cargando…</p>';
}

function showEditorView() {
  viewList.style.display = 'none';
  viewDetail.style.display = 'none';
  viewEditor.style.display = 'block';
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderRow(article) {
  const tr = document.createElement('tr');
  tr.dataset.id = article.id;

  const isPublished = article.status === 'publicado';
  const workflowStatus = workflowStatusOf(article);
  const isEdicion = workflowStatus === 'edicion';

  // Title cell
  const tdTitle = document.createElement('td');
  tdTitle.className = 'col-title';
  const titleBtn = document.createElement('button');
  titleBtn.className = 'article-title-link';
  titleBtn.textContent = article.title || '(sin título)';
  titleBtn.title = isEdicion ? 'Seguir editando' : (workflowStatus === 'en-progreso' ? 'Editar campos' : 'Ver detalle');
  titleBtn.addEventListener('click', () => {
    if (isEdicion) return openEditor(article.id);
    if (workflowStatus === 'en-progreso') return openFieldsEditor(article.id);
    return openDetail(article.id); // terminado — sigue de solo lectura
  });
  tdTitle.appendChild(titleBtn);
  const hint = document.createElement('div');
  hint.className = 'title-hint';
  hint.textContent = isEdicion ? 'Seguir editando →' : (workflowStatus === 'en-progreso' ? 'Editar campos →' : 'Ver detalle →');
  tdTitle.appendChild(hint);
  if (article.descriptif) {
    const descDiv = document.createElement('div');
    descDiv.className = 'article-descriptif';
    descDiv.textContent = article.descriptif;
    tdTitle.appendChild(descDiv);
  }
  // Show validation errors in En Progreso / Terminado — no tienen sentido en
  // Edición, donde todavía falta completar casi todo el schema a propósito.
  if (!isEdicion && !article.valid && article.validationErrors?.length) {
    const errDiv = document.createElement('div');
    errDiv.className = 'validation-errors';
    for (const err of article.validationErrors.slice(0, 3)) {
      const e = document.createElement('div');
      e.className = 'validation-error';
      e.textContent = `⚠ ${err}`;
      errDiv.appendChild(e);
    }
    if (article.validationErrors.length > 3) {
      const more = document.createElement('div');
      more.className = 'validation-error';
      more.textContent = `… y ${article.validationErrors.length - 3} error(es) más`;
      errDiv.appendChild(more);
    }
    tdTitle.appendChild(errDiv);
  }

  // Section
  const tdSection = document.createElement('td');
  tdSection.className = 'col-section';
  tdSection.textContent = sectionLabel(article.section);

  // Date
  const tdDate = document.createElement('td');
  tdDate.className = 'col-date';
  tdDate.textContent = formatDate(article.date);

  // Status badge — solo en Terminado (listo/publicado). En Edición y En Progreso
  // la celda queda vacía: el estado no aporta información útil al editor allí.
  const tdStatus = document.createElement('td');
  tdStatus.className = 'col-status';
  if (workflowStatusOf(article) === 'terminado') {
    tdStatus.innerHTML = `<span class="badge badge-${article.status}">${article.status}</span>`;
  }

  // SPIP ID
  const tdSpip = document.createElement('td');
  tdSpip.className = 'col-spip';
  if (article.spipArticleId && article.publishedUrl) {
    tdSpip.innerHTML = `<span class="spip-id"><a href="${escHtml(article.publishedUrl)}" target="_blank" rel="noopener">#${escHtml(String(article.spipArticleId))}</a></span>`;
  } else if (article.spipArticleId) {
    tdSpip.innerHTML = `<span class="spip-id">#${escHtml(String(article.spipArticleId))}</span>`;
  } else {
    tdSpip.innerHTML = `<span class="spip-id" style="color:var(--border)">—</span>`;
  }

  // Action buttons
  const tdAction = document.createElement('td');
  tdAction.className = 'col-action';

  if (isEdicion) {
    // Único botón posible en Edición: avanzar a En Progreso.
    const sendBtn = document.createElement('button');
    sendBtn.className = 'editor-send-btn';
    sendBtn.textContent = 'Enviar a Revisión →';
    sendBtn.dataset.articleId = article.id;
    sendBtn.addEventListener('click', handleSendToRevisionFromList);
    tdAction.appendChild(sendBtn);
  } else {
    if (!isPublished && article.valid) {
      const btn = document.createElement('button');
      btn.className = 'publish-btn';
      btn.textContent = 'Publicar en SPIP';
      btn.dataset.articleId = article.id;
      btn.addEventListener('click', handlePublish);
      tdAction.appendChild(btn);
    }
    // Desaprobar — solo en Terminado. Manda el artículo a En Progreso.
    if (workflowStatus === 'terminado') {
      const demoteBtn = document.createElement('button');
      demoteBtn.className = 'demote-btn';
      demoteBtn.textContent = 'Desaprobar';
      demoteBtn.dataset.articleId = article.id;
      demoteBtn.addEventListener('click', handleDemote);
      tdAction.appendChild(demoteBtn);
    }
    // Aprobar — solo en En Progreso. Manda el artículo a Terminado (gateado por validación).
    if (workflowStatus === 'en-progreso') {
      const promoteBtn = document.createElement('button');
      promoteBtn.className = 'promote-btn';
      promoteBtn.textContent = 'Aprobar';
      promoteBtn.dataset.articleId = article.id;
      promoteBtn.addEventListener('click', handlePromote);
      tdAction.appendChild(promoteBtn);

      // Enviar a Edición — solo en En Progreso. Manda el artículo de vuelta
      // a reescritura manual en la pantalla de Edición.
      const edicionBtn = document.createElement('button');
      edicionBtn.className = 'edicion-btn';
      edicionBtn.textContent = 'Enviar a Edición';
      edicionBtn.dataset.articleId = article.id;
      edicionBtn.addEventListener('click', handleSendToEdicion);
      tdAction.appendChild(edicionBtn);
    }
  }

  tr.append(tdTitle, tdSection, tdDate, tdStatus, tdSpip, tdAction);
  return tr;
}

function renderTable(data) {
  tbody.innerHTML = '';

  const filtered = data.filter((a) => workflowStatusOf(a) === activeTab);

  updateTabCounts(data);

  if (!filtered.length) {
    const emptyMessages = {
      edicion:      'No hay borradores en Edición.',
      'en-progreso': 'No hay artículos en progreso.',
      terminado:    'No hay artículos listos para publicar.',
    };
    tbody.innerHTML = `<tr class="state-row"><td colspan="6">${emptyMessages[activeTab] ?? 'No hay artículos.'}</td></tr>`;
    countEl.textContent = 'Artículos';
    return;
  }

  if (activeTab === 'terminado') {
    const listos     = filtered.filter((a) => a.status === 'listo').length;
    const publicados = filtered.filter((a) => a.status === 'publicado').length;
    countEl.textContent = `Terminado — ${listos} listo${listos !== 1 ? 's' : ''}, ${publicados} publicado${publicados !== 1 ? 's' : ''}`;
  } else if (activeTab === 'en-progreso') {
    countEl.textContent = `En Progreso — ${filtered.length} artículo${filtered.length !== 1 ? 's' : ''} para validar`;
  } else {
    countEl.textContent = `Edición — ${filtered.length} borrador${filtered.length !== 1 ? 'es' : ''}`;
  }

  for (const article of filtered) {
    tbody.appendChild(renderRow(article));
  }
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadArticles() {
  tbody.innerHTML = '<tr class="state-row"><td colspan="6">Cargando…</td></tr>';
  try {
    const res = await fetch('/api/articles');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    articles = data.articles ?? [];
    renderTable(articles);
    populatePublishedArticlesList(articles);
  } catch (err) {
    // Table context: renderError() would produce <p> inside <tbody> (invalid HTML). escHtml() is intentional here.
    tbody.innerHTML = `<tr class="state-row"><td colspan="6">Error al cargar artículos: ${escHtml(err.message)}</td></tr>`;    showToast(`Error al cargar artículos: ${err.message}`, 'error');
  }
}

// ── Shared: workflow transition helper ────────────────────────────────────────
//
// publishArticle / demoteArticle / promoteArticle / sendToEdicionArticle /
// sendToRevisionArticle all follow the same shape: disable the button, show a
// loading label, POST to an endpoint, toast the result, and either settle
// (reload + call onSettled) or restore the button. This helper carries that
// shared skeleton; each caller only supplies the endpoint, labels, and the
// per-status logic that differs (success message, which status codes get
// special handling, etc.) via onResult().
//
// `btn` may be null (e.g. sending to revisión from the editor view, where
// there's no dedicated row button) — the helper skips all button DOM writes
// in that case. Returns the boolean `success` from onResult(), since at least
// one caller (handleEditorSend) needs to know whether the transition landed.

async function postTransition(endpoint, {
  btn,
  loadingText,
  idleText,
  busyClass,
  body,
  onSettled,
  onResult,
}) {
  if (btn) {
    btn.disabled = true;
    if (busyClass) btn.classList.add(busyClass);
    btn.textContent = loadingText;
  }

  let outcome;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const data = await res.json();
    outcome = onResult(res, data);
  } catch (err) {
    outcome = { success: false, restore: true, message: `❌ Error de red: ${err.message}`, toastType: 'error' };
  }

  showToast(outcome.message, outcome.toastType ?? 'error', outcome.toastDuration ?? 5000);

  if (outcome.settle) await onSettled();
  if (outcome.restore && btn) {
    btn.disabled = false;
    if (busyClass) btn.classList.remove(busyClass);
    btn.textContent = idleText;
  }

  return outcome.success ?? false;
}

// ── Publish ───────────────────────────────────────────────────────────────────

async function publishArticle(id, btn, onSettled) {
  return postTransition(`/api/articles/${encodeURIComponent(id)}/publish`, {
    btn, onSettled,
    loadingText: 'Publicando…', idleText: 'Publicar en SPIP', busyClass: 'publishing',
    body: { dryRun: false },
    onResult: (res, data) => {
      if (res.ok && data.success) {
        if (data.writeBackFailed) {
          return {
            success: true, settle: true, toastType: 'error', toastDuration: 10000,
            message: `✅ Publicado en SPIP (ID ${data.spipArticleId}) pero el write-back al JSON falló. Usar --recover-from-log.`,
          };
        }
        return { success: true, settle: true, toastType: 'success', message: `✅ Publicado — ID SPIP: ${data.spipArticleId}` };
      }
      if (res.status === 409) {
        return { success: false, settle: true, toastType: 'info', message: `⛔ ${data.error}` };
      }
      return { success: false, restore: true, toastType: 'error', message: `❌ Error: ${data.error ?? 'Error desconocido'}` };
    },
  });
}

function handlePublish(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  publishArticle(id, btn, loadArticles);
}

// ── Demote (Terminado → En Progreso) ──────────────────────────────────────────

async function demoteArticle(id, btn, onSettled) {
  return postTransition(`/api/articles/${encodeURIComponent(id)}/demote`, {
    btn, onSettled,
    loadingText: 'Enviando…', idleText: 'Desaprobar',
    onResult: (res, data) => {
      if (res.ok && data.success) {
        return { success: true, settle: true, toastType: 'info', message: '↩️ Enviado a En Progreso' };
      }
      return { success: false, restore: true, toastType: 'error', message: `❌ Error: ${data.error ?? 'Error desconocido'}` };
    },
  });
}

function handleDemote(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  demoteArticle(id, btn, loadArticles);
}

// ── Promote (En Progreso → Terminado) ─────────────────────────────────────────

async function promoteArticle(id, btn, onSettled) {
  return postTransition(`/api/articles/${encodeURIComponent(id)}/promote`, {
    btn, onSettled,
    loadingText: 'Aprobando…', idleText: 'Aprobar',
    onResult: (res, data) => {
      if (res.ok && data.success) {
        return { success: true, settle: true, toastType: 'success', message: '✅ Enviado a Terminado' };
      }
      if (res.status === 422) {
        return {
          success: false, restore: true, toastType: 'error', toastDuration: 8000,
          message: '⛔ No se puede aprobar: el artículo no pasa la validación.',
        };
      }
      return { success: false, restore: true, toastType: 'error', message: `❌ Error: ${data.error ?? 'Error desconocido'}` };
    },
  });
}

// ── Duplicate title check ─────────────────────────────────────────────────────
// Normalizes a title for loose comparison: lowercase, strip accents,
// collapse non-alphanumeric to spaces.
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Returns the first article whose normalized title near-matches `title`,
// excluding the article with `excludeId`. Checks all workflow statuses.
function findDuplicateTitle(title, excludeId) {
  const norm = normalizeTitle(title);
  if (!norm) return null;
  return articles.find((a) => {
    if (a.id === excludeId) return false;
    const other = normalizeTitle(a.title);
    if (!other) return false;
    return other === norm || other.includes(norm) || norm.includes(other);
  }) ?? null;
}

function handlePromote(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;

  const article = articles.find((a) => a.id === id);
  if (article) {
    const dup = findDuplicateTitle(article.title, id);
    if (dup) {
      const confirmed = confirm(
        `⚠️ Posible título duplicado\n\n` +
        `"${article.title}"\n\n` +
        `es similar a:\n` +
        `"${dup.title}" (${dup.workflowStatus ?? 'terminado'})\n\n` +
        `¿Querés aprobar igualmente?`
      );
      if (!confirmed) return;
    }
  }

  promoteArticle(id, btn, loadArticles);
}

// ── Send to Edición (En Progreso → Edición) ───────────────────────────────────

async function sendToEdicionArticle(id, btn, onSettled) {
  return postTransition(`/api/articles/${encodeURIComponent(id)}/send-to-edicion`, {
    btn, onSettled,
    loadingText: 'Enviando…', idleText: 'Enviar a Edición',
    onResult: (res, data) => {
      if (res.ok && data.success) {
        return { success: true, settle: true, toastType: 'info', message: '✏️ Enviado a Edición' };
      }
      return { success: false, restore: true, toastType: 'error', message: `❌ Error: ${data.error ?? 'Error desconocido'}` };
    },
  });
}

function handleSendToEdicion(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  sendToEdicionArticle(id, btn, loadArticles);
}

// ── Send to Revisión (Edición → En Progreso) ──────────────────────────────────
//
// Called with btn=null from the editor view (handleEditorSend) — there's no
// dedicated row button there, just the editor's own "Enviar" button, which
// the caller manages itself. postTransition() skips button DOM writes when
// btn is null; the boolean return value is how handleEditorSend finds out
// whether it needs to re-enable its own button.

async function sendToRevisionArticle(id, btn, onSettled) {
  return postTransition(`/api/articles/${encodeURIComponent(id)}/send-to-revision`, {
    btn, onSettled,
    loadingText: 'Enviando…', idleText: 'Enviar a Revisión →',
    onResult: (res, data) => {
      if (res.ok && data.success) {
        return { success: true, settle: true, toastType: 'success', message: '📝 Enviado a En Progreso' };
      }
      return {
        success: false, restore: true, toastType: 'error', toastDuration: 8000,
        message: `⛔ ${data.error ?? 'No se pudo enviar a revisión'}`,
      };
    },
  });
}

function handleSendToRevisionFromList(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  sendToRevisionArticle(id, btn, loadArticles);
}

// ── Detail view ───────────────────────────────────────────────────────────────

async function openDetail(id) {
  showDetailViewLoading();
  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { article } = await res.json();
    renderDetail(article);
  } catch (err) {
    renderError(detailContent, err, 'Error al cargar el artículo');
    showToast(`Error al cargar el artículo: ${err.message}`, 'error');
  }
}

function renderDetail(article) {
  const isPublished = Boolean(article.spipArticleId);
  const status = isPublished ? 'publicado' : 'listo';
  // GET /api/articles/:id devuelve el JSON crudo (loadArticle), no el objeto
  // mapeado de listArticles() — mismo default de ausencia que allá.
  const isTerminadoDetail = (article.workflowStatus ?? 'terminado') === 'terminado';

  const topicsHtml = Array.isArray(article.topics) && article.topics.length
    ? `<div class="topics-list">${article.topics.map((t) => `<span class="topic-chip">${escHtml(t)}</span>`).join('')}</div>`
    : '<span style="color:var(--muted)">—</span>';

  const spipHtml = article.spipArticleId
    ? (article.publishedUrl
        ? `<span class="spip-id"><a href="${escHtml(article.publishedUrl)}" target="_blank" rel="noopener">#${escHtml(String(article.spipArticleId))}</a></span>`
        : `<span class="spip-id">#${escHtml(String(article.spipArticleId))}</span>`)
    : '<span style="color:var(--muted)">—</span>';

  detailContent.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div>
          ${article.surtitre ? `<div class="detail-surtitre">${escHtml(article.surtitre)}</div>` : ''}
          <div class="detail-title">${escHtml(article.title)}</div>
          ${article.soustitre ? `<div class="detail-soustitre">${escHtml(article.soustitre)}</div>` : ''}
        </div>
        <span class="badge badge-${status}">${status}</span>
      </div>

      <div class="detail-meta">
        <span><strong>Sección:</strong> ${escHtml(sectionLabel(article.section))}</span>
        <span><strong>Fecha:</strong> ${escHtml(formatDate(article.date))}</span>
        ${article.author ? `<span><strong>Autor:</strong> ${escHtml(article.author)}</span>` : ''}
        ${article.sourceSite ? `<span><strong>Fuente:</strong> ${escHtml(article.sourceSite)}</span>` : ''}
        <span><strong>ID SPIP:</strong> ${spipHtml}</span>
      </div>

      ${article.descriptif ? `
        <div class="detail-section-label">Descriptivo</div>
        <div class="detail-descriptif">${escHtml(article.descriptif)}</div>
      ` : ''}

      ${article.coverImage?.url ? `
        <figure class="detail-cover">
          <img src="${escHtml(article.coverImage.url)}" alt="${escHtml(article.coverImage.alt ?? '')}" loading="lazy" />
          ${article.coverImage.caption ? `<figcaption>${escHtml(article.coverImage.caption)}${article.coverImage.credit ? ` <span class="cover-credit">— ${escHtml(article.coverImage.credit)}</span>` : ''}</figcaption>` : ''}
        </figure>
      ` : ''}

      ${article.chapo ? `
        <div class="detail-section-label">Chapo</div>
        <div class="detail-chapo">${sanitizeHtml(article.chapo)}</div>
      ` : ''}

      ${article.contentHtml ? `
        <div class="detail-section-label">Contenido</div>
        <div class="detail-body">${sanitizeHtml(article.contentHtml)}</div>
      ` : `
        <div class="detail-section-label">Contenido</div>
        <p style="color:var(--red)">⚠️ Este artículo no tiene contentHtml — no se puede publicar así.</p>
      `}

      ${article.ps ? `
        <div class="detail-section-label">P.S.</div>
        <div class="detail-ps">${sanitizeHtml(article.ps)}</div>
      ` : ''}

      <div class="detail-section-label">Topics</div>
      ${topicsHtml}

      <div class="detail-footer">
        <span style="color:var(--muted); font-size:0.82rem">id: ${escHtml(article.id)}</span>
        <span>
          ${article.workflowStatus === 'en-progreso'
            ? `<button class="copy-btn" id="detail-copy-btn" data-article-id="${escHtml(article.id)}">📋 Copiar contenido</button>`
            : ''
          }
          ${isPublished
            ? ''
            : `<button class="publish-btn" id="detail-publish-btn" data-article-id="${escHtml(article.id)}">Publicar en SPIP</button>`
          }
          ${isTerminadoDetail
            ? `<button class="demote-btn" id="detail-demote-btn" data-article-id="${escHtml(article.id)}">Desaprobar</button>`
            : `<button class="promote-btn" id="detail-promote-btn" data-article-id="${escHtml(article.id)}">Aprobar</button>
               <button class="edicion-btn" id="detail-edicion-btn" data-article-id="${escHtml(article.id)}">Enviar a Edición</button>`
          }
        </span>
      </div>
    </div>
  `;

  if (!isPublished) {
    const detailBtn = document.getElementById('detail-publish-btn');
    detailBtn.addEventListener('click', () => {
      publishArticle(article.id, detailBtn, async () => {
        await loadArticles();   // actualiza la lista en background
        await openDetail(article.id);
      });
    });
  }

  if (isTerminadoDetail) {
    const demoteBtn = document.getElementById('detail-demote-btn');
    demoteBtn.addEventListener('click', () => {
      demoteArticle(article.id, demoteBtn, async () => {
        await loadArticles();
        // Ahora es en-progreso — abrir el formulario de campos, no la vista
        // de solo lectura que se acaba de dejar.
        await openFieldsEditor(article.id);
      });
    });
  } else {
    const promoteBtn = document.getElementById('detail-promote-btn');
    promoteBtn.addEventListener('click', () => {
      promoteArticle(article.id, promoteBtn, async () => {
        await openDetail(article.id);
      });
    });

    const edicionBtn = document.getElementById('detail-edicion-btn');
    edicionBtn.addEventListener('click', () => {
      sendToEdicionArticle(article.id, edicionBtn, async () => {
        await loadArticles();
        showListView();
      });
    });
  }

  // Copy button — only present for en-progreso articles
  if (article.workflowStatus === 'en-progreso') {
    document.getElementById('detail-copy-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const parts = [];
      if (article.surtitre)    parts.push(article.surtitre);
      if (article.title)       parts.push(article.title);
      if (article.soustitre)   parts.push(article.soustitre);
      if (article.descriptif)  parts.push('\n' + article.descriptif);
      if (article.chapo)       parts.push('\n' + htmlToPlainText(article.chapo));
      if (article.contentHtml) parts.push('\n' + htmlToPlainText(article.contentHtml));
      if (article.ps)          parts.push('\n' + htmlToPlainText(article.ps));

      try {
        await navigator.clipboard.writeText(parts.join('\n'));
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📋 Copiar contenido'; }, 2000);
      } catch {
        showToast('❌ No se pudo copiar al portapapeles', 'error');
      }
    });
  }
}

// ── Editor view (Edición) ────────────────────────────────────────────────────
//
// Pantalla mínima para borradores: título + un cuadro de texto libre.
// El texto se convierte en contentHtml del lado del servidor (ver
// PUT /api/articles/:id/draft) — acá solo necesitamos la conversión inversa,
// para poder reabrir un borrador ya guardado sin mostrarle tags al usuario.

// Duplicado intencional de htmlParagraphsToText() en src/lib/text-to-html.mjs.
// El frontend no tiene bundler, así que no puede importar el módulo Node directamente.
// Si se añade un paso de build, colapsar en una sola función.
// Mantener sincronizadas: cualquier cambio aquí debe reflejarse allá y viceversa.
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/^\s*<p>/i, '')
    .replace(/<\/p>\s*$/i, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// Duplicado intencional de textToParagraphHtml() en src/lib/text-to-html.mjs —
// mismo motivo que htmlToPlainText() arriba (sin bundler en el frontend).
// Usado solo por el formulario de campos de En Progreso (openFieldsEditor)
// para reconvertir texto plano a HTML restringido antes de PUT /fields.
function textToParagraphHtml(text) {
  if (!text || !text.trim()) return '';
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs
    .map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ── Fields editor view (En Progreso) ─────────────────────────────────────────
//
// Formulario editable de los campos separados por el splitter heurístico
// (src/lib/field-splitter.mjs) al entrar a En Progreso: chapo / contenido /
// ps / topics / metadata de fuente. Reemplaza la vista de solo-lectura
// (renderDetail) únicamente para artículos en workflowStatus 'en-progreso'.
// Ver docs/IMPROVE_STEPS.md — Paso 4.

async function openFieldsEditor(id) {
  showDetailViewLoading();
  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { article } = await res.json();
    renderFieldsEditor(article);
  } catch (err) {
    renderError(detailContent, err, 'Error al cargar el artículo');
    showToast(`Error al cargar el artículo: ${err.message}`, 'error');
  }
}

function renderFieldsEditor(article) {
  const topicsValue = Array.isArray(article.topics) ? article.topics.join(', ') : '';

  detailContent.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div>
          <div class="detail-title">${escHtml(article.title || '(sin título)')}</div>
        </div>
        <span style="color:var(--muted); font-size:0.82rem">En Progreso — editando campos</span>
      </div>

      <div class="detail-section-label">Chapo (bajada)</div>
      <textarea id="fields-chapo" class="editor-body-textarea" rows="3"
        placeholder="Bajada corta que aparece antes del cuerpo…">${escHtml(htmlToPlainText(article.chapo ?? ''))}</textarea>

      <div class="detail-section-label">Contenido</div>
      <textarea id="fields-content" class="editor-body-textarea" rows="12"
        placeholder="Cuerpo del artículo…">${escHtml(htmlToPlainText(article.contentHtml ?? ''))}</textarea>

      <div class="detail-section-label">P.S.</div>
      <textarea id="fields-ps" class="editor-body-textarea" rows="3"
        placeholder="Post-scriptum opcional…">${escHtml(htmlToPlainText(article.ps ?? ''))}</textarea>

      <div class="detail-section-label">Topics (separados por coma)</div>
      <input id="fields-topics" type="text" class="editor-title-input" value="${escHtml(topicsValue)}" placeholder="tema-uno, tema-dos" />

      <div class="detail-section-label">Fecha</div>
      <input id="fields-date" type="date" class="editor-title-input" value="${escHtml(article.date ?? '')}" />

      <div class="detail-section-label">Autor</div>
      <input id="fields-author" type="text" class="editor-title-input" value="${escHtml(article.author ?? '')}" />

      <div class="detail-section-label">Sitio de origen</div>
      <input id="fields-source-site" type="text" class="editor-title-input" value="${escHtml(article.sourceSite ?? '')}" />

      <div class="detail-section-label">URL de origen</div>
      <input id="fields-source-url" type="text" class="editor-title-input" value="${escHtml(article.sourceUrl ?? '')}" placeholder="https://…" />

      <div class="detail-section-label">Fecha de origen</div>
      <input id="fields-source-date" type="date" class="editor-title-input" value="${escHtml(article.sourceDate ?? '')}" />

      <div class="detail-footer">
        <span id="fields-save-status" style="color:var(--muted); font-size:0.82rem"></span>
        <span>
          <button class="publish-btn" id="fields-save-btn">Guardar cambios</button>
          <button class="promote-btn" id="fields-promote-btn" data-article-id="${escHtml(article.id)}">Aprobar</button>
          <button class="edicion-btn" id="fields-edicion-btn" data-article-id="${escHtml(article.id)}">Enviar a Edición</button>
        </span>
      </div>
    </div>
  `;

  const saveStatus = document.getElementById('fields-save-status');

  async function saveFields() {
    saveStatus.textContent = 'Guardando…';
    const patch = {
      chapo:       textToParagraphHtml(document.getElementById('fields-chapo').value),
      contentHtml: textToParagraphHtml(document.getElementById('fields-content').value),
      ps:          textToParagraphHtml(document.getElementById('fields-ps').value),
      topics:      document.getElementById('fields-topics').value
        .split(',').map((t) => t.trim()).filter(Boolean),
      date:        document.getElementById('fields-date').value,
      author:      document.getElementById('fields-author').value,
      sourceSite:  document.getElementById('fields-source-site').value,
      sourceUrl:   document.getElementById('fields-source-url').value,
      sourceDate:  document.getElementById('fields-source-date').value,
    };
    try {
      const res = await fetch(`/api/articles/${encodeURIComponent(article.id)}/fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
      saveStatus.textContent = '✅ Guardado';
      await loadArticles(); // refresca validationErrors en la lista en background
      return true;
    } catch (err) {
      saveStatus.textContent = '';
      showToast(`❌ No se pudo guardar: ${err.message}`, 'error');
      return false;
    }
  }

  document.getElementById('fields-save-btn').addEventListener('click', saveFields);

  document.getElementById('fields-promote-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Guarda antes de aprobar — Aprobar valida contra el JSON en disco, no
    // contra lo que hay sin guardar en el formulario.
    if (!(await saveFields())) return;
    promoteArticle(article.id, btn, async () => {
      await loadArticles();
      showListView();
    });
  });

  document.getElementById('fields-edicion-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(await saveFields())) return;
    sendToEdicionArticle(article.id, btn, async () => {
      await loadArticles();
      showListView();
    });
  });
}

function setEditorSaveStatus(text) {
  editorSaveStatus.textContent = text;
}

async function openEditor(id) {
  editingArticleId = id;
  showEditorView();
  editorTitleInput.value   = '';
  editorSectionSelect.value = '';
  editorBodyInput.value    = '';
  setEditorSaveStatus('Cargando…');
  editorTitleInput.disabled    = true;
  editorSectionSelect.disabled = true;
  editorBodyInput.disabled     = true;

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { article } = await res.json();

    editorTitleInput.value = article.title ?? '';
    editorSectionSelect.value = article.section ?? '';
    editorBodyInput.value = htmlToPlainText(article.contentHtml ?? '');
    setEditorSaveStatus('');
    renderDraftHistory(id);
  } catch (err) {
    showToast(`Error al cargar el borrador: ${err.message}`, 'error');
    showListView();
  } finally {
    editorTitleInput.disabled    = false;
    editorSectionSelect.disabled = false;
    editorBodyInput.disabled     = false;
  }
}

// ── Draft history (localStorage snapshots) ───────────────────────────────────

const HISTORY_MAX     = 5;
const draftHistoryPanel = document.getElementById('draft-history-panel');
const draftHistoryList  = document.getElementById('draft-history-list');
document.getElementById('draft-history-close').addEventListener('click', () => {
  draftHistoryPanel.style.display = 'none';
});

function historyKey(id) { return `draft-history:${id}`; }

function loadHistory(id) {
  try { return JSON.parse(localStorage.getItem(historyKey(id)) ?? '[]'); }
  catch { return []; }
}

function saveHistory(id, snapshots) {
  try { localStorage.setItem(historyKey(id), JSON.stringify(snapshots)); }
  catch { /* localStorage full or unavailable — silent */ }
}

/** Capture current editor state as a snapshot BEFORE a destructive change. */
function snapshotDraft(id) {
  if (!id) return;
  const snapshot = {
    savedAt: new Date().toISOString(),
    title:   editorTitleInput.value,
    section: editorSectionSelect.value,
    text:    editorBodyInput.value,
  };
  const history = loadHistory(id);
  history.unshift(snapshot);
  saveHistory(id, history.slice(0, HISTORY_MAX));
  renderDraftHistory(id);
}

function renderDraftHistory(id) {
  const history = loadHistory(id);
  if (!history.length) { draftHistoryPanel.style.display = 'none'; return; }

  draftHistoryPanel.style.display = 'block';
  draftHistoryList.innerHTML = '';
  history.forEach((snap, i) => {
    const li = document.createElement('li');
    const preview = (snap.title || snap.text || '').replace(/\n/g, ' ').trim().slice(0, 60);
    const ts = new Date(snap.savedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `
      <span class="draft-history-ts">${ts}</span>
      <span class="draft-history-preview">${escHtml(preview || '(vacío)')}</span>
      <button class="draft-history-restore" data-index="${i}">Restaurar</button>
    `;
    li.querySelector('.draft-history-restore').addEventListener('click', () => {
      const h = loadHistory(id);
      const s = h[i];
      if (!s) return;
      editorTitleInput.value      = s.title ?? '';
      editorSectionSelect.value   = s.section ?? '';
      editorBodyInput.value       = s.text ?? '';
      setEditorSaveStatus('Restaurado — guardá para confirmar');
    });
    draftHistoryList.appendChild(li);
  });
}

/**
 * Guarda título + texto libre del borrador abierto.
 * @returns {Promise<boolean>} true si el guardado fue exitoso
 */
async function saveDraft() {
  if (!editingArticleId) return false;

  const title   = editorTitleInput.value;
  const section = editorSectionSelect.value;
  const text    = editorBodyInput.value;

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(editingArticleId)}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, section, text }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      if (data.warning) showToast(`⚠️ ${data.warning}`, 'info', 8000);
      return true;
    }
    showToast(`❌ Error al guardar: ${data.error ?? 'Error desconocido'}`, 'error');
    return false;
  } catch (err) {
    showToast(`❌ Error de red al guardar: ${err.message}`, 'error');
    return false;
  }
}

async function handleEditorSave() {
  editorSaveBtn.disabled = true;
  setEditorSaveStatus('Guardando…');

  const ok = await saveDraft();

  editorSaveBtn.disabled = false;
  setEditorSaveStatus(ok ? 'Guardado ✓' : '');
  if (ok) {
    // Refresca el conteo de la pestaña Edición en segundo plano, sin sacar
    // al usuario de la pantalla de edición.
    fetch('/api/articles').then((r) => r.json()).then((d) => {
      articles = d.articles ?? [];
      updateTabCounts(articles);
    }).catch(() => {});
  }
}

async function handleEditorSend() {
  // Validación cliente antes de guardar: sección obligatoria
  if (!editorSectionSelect.value) {
    showToast('❌ Elegí una sección antes de enviar a revisión.', 'error');
    editorSectionSelect.focus();
    return;
  }

  editorSendBtn.disabled = true;
  setEditorSaveStatus('Guardando…');

  const saved = await saveDraft();
  if (!saved) {
    editorSendBtn.disabled = false;
    setEditorSaveStatus('');
    return;
  }

  const id = editingArticleId;
  const ok = await sendToRevisionArticle(id, null, async () => {
    await loadArticles();
    setActiveTab('en-progreso');
    showListView();
  });

  if (!ok) {
    editorSendBtn.disabled = false;
    setEditorSaveStatus('');
  }
}

async function createNewArticle() {
  newArticleBtn.disabled = true;
  try {
    const res = await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    const data = await res.json();

    if (res.ok && data.article) {
      await loadArticles();
      openEditor(data.article.id);
    } else {
      showToast(`❌ Error al crear el artículo: ${data.error ?? 'Error desconocido'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Error de red: ${err.message}`, 'error');
  } finally {
    newArticleBtn.disabled = false;
  }
}

// ── XSS helper ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sets el.innerHTML to a safe error message, escaping the error text so no
 * caller has to remember to call escHtml() on err.message themselves.
 * Use this instead of `el.innerHTML = \`...${err.message}...\`` everywhere.
 *
 * @param {Element} el   - container to write into
 * @param {unknown} err  - Error object or any value with a .message / toString
 * @param {string}  [prefix] - optional label prefix (default: 'Error')
 */
function renderError(el, err, prefix = 'Error') {
  const msg = (err instanceof Error ? err.message : String(err)) || 'Error desconocido';
  el.innerHTML = `<p style="color:var(--red)">${escHtml(prefix)}: ${escHtml(msg)}</p>`;
}

// ── HTML sanitiser ────────────────────────────────────────────────────────────
//
// Strips everything that isn't in the schema-allowed tag list before injecting
// article HTML into the detail view. Uses DOMParser (real tree walk, not regex)
// so no amount of encoding tricks can sneak through a forbidden tag.
//
// The tag list itself is fetched once at boot from GET /api/schema/allowed-tags,
// which re-exports the real ALLOWED_TAGS from article-validator.mjs — that's
// the single source of truth now. The set below is only a fallback for if that
// fetch fails (e.g. offline dev work): it should still roughly match the
// backend, but being briefly stale here just means the detail view sanitises
// against slightly outdated rules until the fetch succeeds, not a silent
// permanent drift like before.

let DETAIL_ALLOWED_TAGS = new Set([
  'h3', 'h4', 'p', 'br', 'hr',
  'strong', 'em',
  'ul', 'ol', 'li',
  'blockquote',
  'figure', 'figcaption', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a',
]);

async function loadAllowedTagsFromSchema() {
  try {
    const res = await fetch('/api/schema/allowed-tags');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.allowedTags) && data.allowedTags.length) {
      DETAIL_ALLOWED_TAGS = new Set(data.allowedTags);
    }
  } catch {
    // Fetch failed (offline, server down mid-boot, etc.) — keep the fallback
    // set above. Not worth a toast: it only affects detail-view sanitising,
    // and the fallback is a reasonable approximation.
  }
}

const DETAIL_ALLOWED_ATTRS = {
  'a':   ['href', 'target', 'rel'],
  'img': ['src', 'alt', 'loading', 'width', 'height'],
};

/**
 * Sanitises an HTML string for safe display in the detail view.
 * Keeps only schema-allowed tags and a small whitelist of safe attributes.
 * Any forbidden tag is replaced by its text content (not silently dropped).
 *
 * @param {string} html
 * @returns {string} sanitised HTML
 */
function sanitizeHtml(html) {
  if (!html) return '';

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = node.tagName.toLowerCase();

    if (!DETAIL_ALLOWED_TAGS.has(tag)) {
      // Forbidden element — keep its text content in a fragment
      const frag = document.createDocumentFragment();
      node.childNodes.forEach((child) => {
        const sanitized = sanitizeNode(child);
        if (sanitized) frag.appendChild(sanitized);
      });
      return frag;
    }

    const el = document.createElement(tag);
    const allowedAttrs = DETAIL_ALLOWED_ATTRS[tag] ?? [];
    allowedAttrs.forEach((attr) => {
      if (node.hasAttribute(attr)) {
        const val = node.getAttribute(attr);
        // Block javascript: and data: URLs on href/src
        if ((attr === 'href' || attr === 'src') && /^\s*(?:javascript|data):/i.test(val)) return;
        el.setAttribute(attr, val);
      }
    });
    // Force external links to open safely
    if (tag === 'a') {
      el.setAttribute('rel', 'noopener noreferrer');
      if (!el.hasAttribute('target')) el.setAttribute('target', '_blank');
    }

    node.childNodes.forEach((child) => {
      const sanitized = sanitizeNode(child);
      if (sanitized) el.appendChild(sanitized);
    });
    return el;
  }

  const frag = document.createDocumentFragment();
  doc.body.childNodes.forEach((child) => {
    const sanitized = sanitizeNode(child);
    if (sanitized) frag.appendChild(sanitized);
  });

  const wrapper = document.createElement('div');
  wrapper.appendChild(frag);
  return wrapper.innerHTML;
}

async function handleEditorBack() {
  // Guarda en silencio antes de salir — no queremos perder lo que se escribió.
  await saveDraft();
  editingArticleId = null;
  showListView();
  loadArticles();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

tabBtns.forEach((btn) => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));
refreshBtn.addEventListener('click', loadArticles);
newArticleBtn.addEventListener('click', createNewArticle);
backBtn.addEventListener('click', showListView);
editorBackBtn.addEventListener('click', handleEditorBack);
document.getElementById('site-back-btn').addEventListener('click', () => setActiveTab('terminado'));
editorSaveBtn.addEventListener('click', handleEditorSave);

// Auto-save on paste in either editor field — wait one tick for the pasted
// text to land in the input value before reading it.
// Snapshot is taken BEFORE the paste so the pre-paste state is preserved.
editorBodyInput.addEventListener('paste', () => { snapshotDraft(editingArticleId); setTimeout(saveDraft, 0); });
editorTitleInput.addEventListener('paste', () => { snapshotDraft(editingArticleId); setTimeout(saveDraft, 0); });
editorSendBtn.addEventListener('click', handleEditorSend);
loadArticles();
loadAllowedTagsFromSchema();

// ── Sitio tab — gestión del sitio SPIP ───────────────────────────────────────

/**
 * Rellena el <datalist id="published-articles-list"> con los últimos 10
 * artículos publicados (tienen spipArticleId). Cuando el usuario elige una
 * opción, el valor del input queda como el ID SPIP numérico.
 * El label visible es "Título (SPIP #ID)" para que sea reconocible.
 */
function populatePublishedArticlesList(allArticles) {
  const datalist = document.getElementById('published-articles-list');
  if (!datalist) return;

  const published = allArticles
    .filter((a) => a.spipArticleId)
    .sort((a, b) => Number(b.spipArticleId) - Number(a.spipArticleId)) // más recientes primero
    .slice(0, 10);

  datalist.innerHTML = '';
  for (const a of published) {
    const opt = document.createElement('option');
    opt.value = a.spipArticleId;
    opt.label = `${a.title} (SPIP #${a.spipArticleId})`;
    datalist.appendChild(opt);
  }
}

//
// Completamente aislado del pipeline editorial. No toca `articles`, `activeTab`
// ni ninguna función del pipeline. Llama únicamente a /api/site/* endpoints.
// Para añadir nuevas operaciones de sitio: añadir un .site-card en index.html
// y una función aquí. No hay que tocar nada del pipeline editorial.

const siteStatusIdInput  = document.getElementById('site-status-id');
const siteStatusSelect   = document.getElementById('site-status-select');
const siteStatusBtn      = document.getElementById('site-status-btn');
const siteStatusResult   = document.getElementById('site-status-result');
const siteDeleteIdInput  = document.getElementById('site-delete-id');
const siteDeleteBtn      = document.getElementById('site-delete-btn');
const siteDeleteResult   = document.getElementById('site-delete-result');

function setSiteResult(el, message, isOk) {
  el.textContent = message;
  el.className   = 'site-result ' + (isOk ? 'ok' : 'err');
}

async function handleSiteStatusChange() {
  const spipId = siteStatusIdInput.value.trim();
  const status = siteStatusSelect.value;

  if (!spipId) { setSiteResult(siteStatusResult, '❌ Ingresá el ID SPIP del artículo.', false); return; }
  if (!status) { setSiteResult(siteStatusResult, '❌ Elegí un estado.', false); return; }

  // Gate de confirmación para publie (publicación directa sin flujo editorial)
  if (status === 'publie') {
    const confirmed = confirm(
      `⚠️  Publicar directamente el artículo ${spipId} sin pasar por el flujo editorial.\n\n` +
      `Esto lo hará visible en el sitio público inmediatamente.\n\n` +
      `¿Continuar?`
    );
    if (!confirmed) return;
  }

  siteStatusBtn.disabled = true;
  setSiteResult(siteStatusResult, 'Conectando con SPIP…', true);

  try {
    const body = { status };
    if (status === 'publie') body.approvePublishing = true;

    const res  = await fetch(`/api/site/article/${encodeURIComponent(spipId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      const label = data.finalStatus ?? status;
      setSiteResult(siteStatusResult, `✅ Artículo ${spipId} → "${label}"`, true);
    } else {
      setSiteResult(siteStatusResult, `❌ ${data.error ?? 'Error desconocido'}`, false);
    }
  } catch (err) {
    setSiteResult(siteStatusResult, `❌ Error de red: ${err.message}`, false);
  } finally {
    siteStatusBtn.disabled = false;
  }
}

async function handleSiteDelete() {
  const spipId = siteDeleteIdInput.value.trim();
  if (!spipId) { setSiteResult(siteDeleteResult, '❌ Ingresá el ID SPIP del artículo.', false); return; }

  // Gate de confirmación para borrado permanente (irreversible)
  const confirmed = confirm(
    `⚠️  BORRADO PERMANENTE del artículo ${spipId}\n\n` +
    `Esta operación es IRREVERSIBLE. El artículo desaparecerá completamente de SPIP.\n\n` +
    `El artículo debe estar en la papelera ("poubelle") primero.\n\n` +
    `¿Continuar?`
  );
  if (!confirmed) return;

  siteDeleteBtn.disabled = true;
  setSiteResult(siteDeleteResult, 'Conectando con SPIP…', true);

  try {
    const res  = await fetch(`/api/site/article/${encodeURIComponent(spipId)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      setSiteResult(siteDeleteResult, `✅ Artículo ${spipId} borrado permanentemente.`, true);
      siteDeleteIdInput.value = '';
    } else {
      setSiteResult(siteDeleteResult, `❌ ${data.error ?? 'Error desconocido'}`, false);
    }
  } catch (err) {
    setSiteResult(siteDeleteResult, `❌ Error de red: ${err.message}`, false);
  } finally {
    siteDeleteBtn.disabled = false;
  }
}

siteStatusBtn.addEventListener('click', handleSiteStatusChange);
siteDeleteBtn.addEventListener('click', handleSiteDelete);

// ── Audit reconciliation panel ────────────────────────────────────────────────

const auditRefreshBtn = document.getElementById('audit-refresh-btn');
const auditVerifyBtn  = document.getElementById('audit-verify-btn');
const auditLoading    = document.getElementById('audit-loading');
const auditContent    = document.getElementById('audit-content');

function fmtTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return ts; }
}

async function loadAuditReport({ verify = false } = {}) {
  auditLoading.style.display = 'block';
  auditContent.innerHTML = '';
  if (verify) {
    auditVerifyBtn.disabled = true;
    auditVerifyBtn.textContent = '🔍 Verificando…';
  }
  try {
    const url  = verify ? '/api/site/audit-report?verify=true' : '/api/site/audit-report';
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error ?? 'Error desconocido');
    renderAuditReport(data.report);
  } catch (err) {
    renderError(auditContent, err, '❌');
  } finally {
    auditLoading.style.display = 'none';
    auditVerifyBtn.disabled = false;
    auditVerifyBtn.textContent = '🔍 Verificar en SPIP';
  }
}

function renderAuditReport(report) {
  const { duplicates, writeBacksMissing, orphanedMarkers, ok } = report;
  const frag = document.createDocumentFragment();

  // ── A. Duplicados ──────────────────────────────────────────────────────────
  if (duplicates.length > 0) {
    // Separar duplicados reales de los ya resueltos según verificación SPIP
    const realDups     = duplicates.filter((d) => !d.resolvedInSpip);
    const resolvedDups = duplicates.filter((d) =>  d.resolvedInSpip);
    const verified     = report.verified;

    const sec = document.createElement('div');
    sec.className = realDups.length > 0
      ? 'audit-section audit-section-danger'
      : 'audit-section audit-section-info';

    const h4 = document.createElement('h4');
    if (realDups.length > 0) {
      h4.textContent = `⚠️  Duplicados en SPIP (${realDups.length})`;
    } else {
      h4.innerHTML = `✅ Sin duplicados activos${verified ? ' <span class="audit-verified-badge">verificado en SPIP</span>' : ''}`;
    }
    sec.appendChild(h4);

    if (realDups.length > 0) {
      const note = document.createElement('p');
      note.className = 'audit-note';
      note.textContent = verified
        ? 'Duplicados confirmados en vivo en SPIP. Mover los IDs sobrantes a la papelera, luego borrarlos desde el formulario de abajo.'
        : 'El mismo artículo fue publicado más de una vez según el audit log. Usar "Verificar en SPIP" para confirmar si los duplicados siguen vivos.';
      sec.appendChild(note);
    }

    for (const group of realDups) {
      const card = document.createElement('div');
      card.className = 'audit-item';

      const titleEl = document.createElement('strong');
      titleEl.textContent = group.title;
      card.appendChild(titleEl);

      const slugEl = document.createElement('code');
      slugEl.className = 'audit-slug';
      slugEl.textContent = group.slug;
      card.appendChild(slugEl);

      const canonical      = group.localSpipId ?? group.suggestedCanonical;
      const isConfirmed    = group.suggestedIsConfirmed;
      const canonicalLabel = group.suggestedIsConfirmed
        ? `SPIP #${canonical} (canónico — en JSON local)`
        : `SPIP #${group.suggestedCanonical} (sugerido, no confirmado)`;

      const canonNote = document.createElement('p');
      canonNote.className = 'audit-canon';
      canonNote.textContent = canonicalLabel;
      card.appendChild(canonNote);

      const list = document.createElement('ul');
      list.className = 'audit-spip-list';
      for (const entry of group.aliveEntries) {
        const li = document.createElement('li');
        const isCanon  = canonical && String(entry.spipArticleId) === String(canonical);        const spipGone = group.verifiedInSpip && entry.spipExists === false;
        li.innerHTML = `SPIP #<strong>${entry.spipArticleId}</strong> — ${fmtTs(entry.loggedAt)}`;
        if (isCanon) {
          li.innerHTML += isConfirmed
            ? ' <span class="audit-badge audit-badge-canon">canónico</span>'
            : ' <span class="audit-badge audit-badge-suggested">sugerido — no mover</span>';
        } else if (spipGone) {
          li.innerHTML += ' <span class="audit-spip-gone">ya no existe en SPIP</span>';
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'audit-btn-confirm-deleted';
          confirmBtn.textContent = `Confirmar borrado de #${entry.spipArticleId}`;
          confirmBtn.title = 'Revisá manualmente en SPIP antes de confirmar — esto es permanente.';
          confirmBtn.addEventListener('click', () => handleConfirmExternalDeletion(entry.spipArticleId, confirmBtn));
          li.appendChild(confirmBtn);
        } else {
          const btn = document.createElement('button');
          btn.className = 'audit-btn-papelera';
          btn.textContent = `Mover #${entry.spipArticleId} a papelera`;
          btn.dataset.spipId = entry.spipArticleId;
          btn.addEventListener('click', () => handleMoveToPapelera(entry.spipArticleId, btn));
          li.appendChild(btn);
        }
        list.appendChild(li);
      }
      card.appendChild(list);
      sec.appendChild(card);
    }

    // Duplicados resueltos (solo se muestran si se verificó en SPIP)
    if (resolvedDups.length > 0 && verified) {
      const resolvedNote = document.createElement('p');
      resolvedNote.className = 'audit-note';
      resolvedNote.innerHTML = `<em>Resueltos (IDs sobrantes ya no existen en SPIP): ${resolvedDups.map((d) => d.slug).join(', ')}</em>`;
      sec.appendChild(resolvedNote);
    }

    frag.appendChild(sec);
  }

  // ── B. Write-backs perdidos ────────────────────────────────────────────────
  if (writeBacksMissing.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'audit-section audit-section-warning';
    const h4 = document.createElement('h4');
    h4.textContent = `⏳ Write-backs perdidos (${writeBacksMissing.length})`;
    sec.appendChild(h4);
    const note = document.createElement('p');
    note.className = 'audit-note';
    note.textContent = 'Publicados en SPIP según el audit log, pero el JSON local no tiene el marcador spipArticleId. Usar "Recuperar" para escribirlo.';
    sec.appendChild(note);

    for (const entry of writeBacksMissing) {
      const card = document.createElement('div');
      card.className = 'audit-item';

      const titleEl = document.createElement('strong');
      titleEl.textContent = entry.title;
      card.appendChild(titleEl);

      const slugEl = document.createElement('code');
      slugEl.className = 'audit-slug';
      slugEl.textContent = entry.slug;
      card.appendChild(slugEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'audit-meta';
      metaEl.textContent = `SPIP #${entry.spipArticleId} — ${fmtTs(entry.loggedAt)}`;
      card.appendChild(metaEl);

      const btn = document.createElement('button');
      btn.className = 'audit-btn-recover';
      btn.textContent = 'Recuperar marcador';
      btn.dataset.slug = entry.slug;
      btn.addEventListener('click', () => handleRecover(entry.slug, btn));
      card.appendChild(btn);

      const result = document.createElement('span');
      result.className = 'audit-inline-result';
      card.appendChild(result);

      sec.appendChild(card);
    }
    frag.appendChild(sec);
  }

  // ── C. Marcadores huérfanos ────────────────────────────────────────────────
  if (orphanedMarkers.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'audit-section audit-section-info';
    const h4 = document.createElement('h4');
    h4.textContent = `ℹ️  Marcadores sin respaldo en el log (${orphanedMarkers.length})`;
    sec.appendChild(h4);
    const note = document.createElement('p');
    note.className = 'audit-note';
    note.textContent = 'El JSON tiene spipArticleId pero no hay entrada de article.create en el audit log que lo respalde. Puede ser un JSON editado a mano o un log migrado.';
    sec.appendChild(note);

    for (const marker of orphanedMarkers) {
      const card = document.createElement('div');
      card.className = 'audit-item';

      const titleEl = document.createElement('strong');
      titleEl.textContent = marker.title;
      card.appendChild(titleEl);

      const slugEl = document.createElement('code');
      slugEl.className = 'audit-slug';
      slugEl.textContent = marker.id;
      card.appendChild(slugEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'audit-meta';
      metaEl.textContent = `spipArticleId: ${marker.spipArticleId} — verificar manualmente`;
      card.appendChild(metaEl);

      sec.appendChild(card);
    }
    frag.appendChild(sec);
  }

  // ── D. OK banner ──────────────────────────────────────────────────────────
  const realDuplicates = duplicates.filter((d) => !d.resolvedInSpip);
  if (realDuplicates.length === 0 && writeBacksMissing.length === 0 && orphanedMarkers.length === 0) {
    const okEl = document.createElement('p');
    okEl.className = 'audit-ok';
    okEl.innerHTML = `✅ Audit log y archivos locales coinciden. (${report.ok.length} artículo${report.ok.length !== 1 ? 's' : ''} OK)` +
      (report.verified ? ' <span class="audit-verified-badge">verificado en SPIP</span>' : '');
    frag.appendChild(okEl);
  } else {
    const summary = document.createElement('p');
    summary.className = 'audit-summary';
    summary.textContent = `${ok.length} OK · ${realDuplicates.length} duplicado${realDuplicates.length !== 1 ? 's' : ''} · ${writeBacksMissing.length} write-back pendiente${writeBacksMissing.length !== 1 ? 's' : ''} · ${orphanedMarkers.length} huérfano${orphanedMarkers.length !== 1 ? 's' : ''}` +
      (report.verified ? ' · verificado en SPIP ✓' : '');
    frag.appendChild(summary);
  }

  auditContent.appendChild(frag);
}

async function handleMoveToPapelera(spipId, btn) {
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res  = await fetch(`/api/site/article/${encodeURIComponent(spipId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'poubelle' }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ SPIP #${spipId} movido a la papelera. Ahora podés borrarlo desde el formulario de Borrado permanente.`, 'success', 8000);
      await loadAuditReport();
    } else {
      btn.disabled = false;
      btn.textContent = `Mover #${spipId} a papelera`;
      showToast(`❌ ${data.error ?? 'Error desconocido'}`, 'error');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Mover #${spipId} a papelera`;
    showToast(`❌ Error de red: ${err.message}`, 'error');
  }
}

async function handleConfirmExternalDeletion(spipId, btn) {
  // Gate de confirmación — esto es permanente e irreversible (ver spip-admin.mjs
  // confirmExternalDeletion). La verificación en vivo es un indicio, no una
  // prueba; por eso pedimos que un humano lo revise antes de confirmar.
  const confirmed = confirm(
    `⚠️  Confirmar que el artículo SPIP #${spipId} fue borrado externamente.\n\n` +
    `Esto es PERMANENTE: el ID se excluirá de todos los reportes de duplicados ` +
    `futuros, incluso sin verificar. Recomendado: revisá manualmente en SPIP ` +
    `(/ecrire/?exec=article&id_article=${spipId}) antes de confirmar.\n\n` +
    `¿Continuar?`
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = 'Confirmando…';
  try {
    const res  = await fetch(`/api/site/duplicates/${encodeURIComponent(spipId)}/confirm-deleted`, {
      method: 'POST',
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ SPIP #${spipId} confirmado como borrado externamente.`, 'success', 6000);
      await loadAuditReport();
    } else {
      btn.disabled = false;
      btn.textContent = `Confirmar borrado de #${spipId}`;
      showToast(`❌ ${data.error ?? 'Error desconocido'}`, 'error');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Confirmar borrado de #${spipId}`;
    showToast(`❌ Error de red: ${err.message}`, 'error');
  }
}

async function handleRecover(slug, btn) {
  btn.disabled = true;
  btn.textContent = 'Recuperando…';
  const resultEl = btn.nextElementSibling;
  try {
    const res  = await fetch(`/api/articles/${encodeURIComponent(slug)}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      resultEl.textContent = `✅ Recuperado — SPIP #${data.spipArticleId}`;
      resultEl.className = 'audit-inline-result ok';
      setTimeout(() => loadAuditReport(), 1200);
    } else {
      btn.disabled = false;
      btn.textContent = 'Recuperar marcador';
      resultEl.textContent = `❌ ${data.error ?? 'Error'}`;
      resultEl.className = 'audit-inline-result err';
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Recuperar marcador';
    resultEl.textContent = `❌ Error de red: ${err.message}`;
    resultEl.className = 'audit-inline-result err';
  }
}

auditRefreshBtn.addEventListener('click', () => loadAuditReport());
auditVerifyBtn.addEventListener('click',  () => loadAuditReport({ verify: true }));

// Load the audit report automatically when the Sitio tab is activated
// Hook into sitio tab activation
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'sitio') {
      loadAuditReport();
    }
  });
});
