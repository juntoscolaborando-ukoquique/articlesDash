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
const editorBackBtn    = document.getElementById('editor-back-btn');
const editorTitleInput = document.getElementById('editor-title');
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
  renderTable(articles);
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
  viewList.style.display = 'block';
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
  titleBtn.title = isEdicion ? 'Seguir editando' : 'Ver detalle';
  titleBtn.addEventListener('click', () => (isEdicion ? openEditor(article.id) : openDetail(article.id)));
  tdTitle.appendChild(titleBtn);
  const hint = document.createElement('div');
  hint.className = 'title-hint';
  hint.textContent = isEdicion ? 'Seguir editando →' : 'Ver detalle →';
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

  // Status badge
  const tdStatus = document.createElement('td');
  tdStatus.className = 'col-status';
  tdStatus.innerHTML = `<span class="badge badge-${article.status}">${article.status}</span>`;

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
    countEl.textContent = `En Progreso — ${filtered.length} artículo${filtered.length !== 1 ? 's' : ''} con errores de validación`;
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
  } catch (err) {
    tbody.innerHTML = `<tr class="state-row"><td colspan="6">Error al cargar artículos: ${escHtml(err.message)}</td></tr>`;
    showToast(`Error al cargar artículos: ${err.message}`, 'error');
  }
}

// ── Publish ───────────────────────────────────────────────────────────────────

async function publishArticle(id, btn, onSettled) {
  btn.disabled = true;
  btn.classList.add('publishing');
  btn.textContent = 'Publicando…';

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: false }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      if (data.writeBackFailed) {
        showToast(
          `✅ Publicado en SPIP (ID ${data.spipArticleId}) pero el write-back al JSON falló. Usar --recover-from-log.`,
          'error',
          10000
        );
      } else {
        showToast(`✅ Publicado — ID SPIP: ${data.spipArticleId}`, 'success');
      }
      await onSettled();
    } else if (res.status === 409) {
      showToast(`⛔ ${data.error}`, 'info');
      await onSettled();
    } else {
      showToast(`❌ Error: ${data.error ?? 'Error desconocido'}`, 'error');
      btn.disabled = false;
      btn.classList.remove('publishing');
      btn.textContent = 'Publicar en SPIP';
    }
  } catch (err) {
    showToast(`❌ Error de red: ${err.message}`, 'error');
    btn.disabled = false;
    btn.classList.remove('publishing');
    btn.textContent = 'Publicar en SPIP';
  }
}

function handlePublish(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  publishArticle(id, btn, loadArticles);
}

// ── Demote (Terminado → En Progreso) ──────────────────────────────────────────

async function demoteArticle(id, btn, onSettled) {
  btn.disabled = true;
  btn.textContent = 'Enviando…';

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}/demote`, {
      method: 'POST',
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('↩️ Enviado a En Progreso', 'info');
      await onSettled();
    } else {
      showToast(`❌ Error: ${data.error ?? 'Error desconocido'}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Desaprobar';
    }
  } catch (err) {
    showToast(`❌ Error de red: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Desaprobar';
  }
}

function handleDemote(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  demoteArticle(id, btn, loadArticles);
}

// ── Promote (En Progreso → Terminado) ─────────────────────────────────────────

async function promoteArticle(id, btn, onSettled) {
  btn.disabled = true;
  btn.textContent = 'Aprobando…';

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✅ Enviado a Terminado', 'success');
      await onSettled();
    } else if (res.status === 422) {
      showToast(`⛔ No se puede aprobar: el artículo no pasa la validación.`, 'error', 8000);
      btn.disabled = false;
      btn.textContent = 'Aprobar';
    } else {
      showToast(`❌ Error: ${data.error ?? 'Error desconocido'}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Aprobar';
    }
  } catch (err) {
    showToast(`❌ Error de red: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Aprobar';
  }
}

function handlePromote(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  promoteArticle(id, btn, loadArticles);
}

// ── Send to Edición (En Progreso → Edición) ───────────────────────────────────

async function sendToEdicionArticle(id, btn, onSettled) {
  btn.disabled = true;
  btn.textContent = 'Enviando…';

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}/send-to-edicion`, {
      method: 'POST',
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✏️ Enviado a Edición', 'info');
      await onSettled();
    } else {
      showToast(`❌ Error: ${data.error ?? 'Error desconocido'}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Enviar a Edición';
    }
  } catch (err) {
    showToast(`❌ Error de red: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Enviar a Edición';
  }
}

function handleSendToEdicion(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  sendToEdicionArticle(id, btn, loadArticles);
}

// ── Send to Revisión (Edición → En Progreso) ──────────────────────────────────

async function sendToRevisionArticle(id, btn, onSettled) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando…';
  }

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}/send-to-revision`, {
      method: 'POST',
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast('📝 Enviado a Revisión', 'success');
      await onSettled();
      return true;
    }

    showToast(`⛔ ${data.error ?? 'No se pudo enviar a revisión'}`, 'error', 8000);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Enviar a Revisión →';
    }
    return false;
  } catch (err) {
    showToast(`❌ Error de red: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Enviar a Revisión →';
    }
    return false;
  }
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
    detailContent.innerHTML = `<p style="color:var(--red)">Error al cargar el artículo: ${escHtml(err.message)}</p>`;
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
        <div class="detail-chapo">${article.chapo}</div>
      ` : ''}

      ${article.contentHtml ? `
        <div class="detail-section-label">Contenido</div>
        <div class="detail-body">${article.contentHtml}</div>
      ` : `
        <div class="detail-section-label">Contenido</div>
        <p style="color:var(--red)">⚠️ Este artículo no tiene contentHtml — no se puede publicar así.</p>
      `}

      ${article.ps ? `
        <div class="detail-section-label">P.S.</div>
        <div class="detail-ps">${article.ps}</div>
      ` : ''}

      <div class="detail-section-label">Topics</div>
      ${topicsHtml}

      <div class="detail-footer">
        <span style="color:var(--muted); font-size:0.82rem">id: ${escHtml(article.id)}</span>
        <span>
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
        await openDetail(article.id);
      });
    });
  }

  if (isTerminadoDetail) {
    const demoteBtn = document.getElementById('detail-demote-btn');
    demoteBtn.addEventListener('click', () => {
      demoteArticle(article.id, demoteBtn, async () => {
        await openDetail(article.id);
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
}

// ── Editor view (Edición) ────────────────────────────────────────────────────
//
// Pantalla mínima para borradores: título + un cuadro de texto libre.
// El texto se convierte en contentHtml del lado del servidor (ver
// PUT /api/articles/:id/draft) — acá solo necesitamos la conversión inversa,
// para poder reabrir un borrador ya guardado sin mostrarle tags al usuario.

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

function setEditorSaveStatus(text) {
  editorSaveStatus.textContent = text;
}

async function openEditor(id) {
  editingArticleId = id;
  showEditorView();
  editorTitleInput.value = '';
  editorBodyInput.value = '';
  setEditorSaveStatus('Cargando…');
  editorTitleInput.disabled = true;
  editorBodyInput.disabled = true;

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { article } = await res.json();

    editorTitleInput.value = article.title ?? '';
    editorBodyInput.value = htmlToPlainText(article.contentHtml ?? '');
    setEditorSaveStatus('');
  } catch (err) {
    showToast(`Error al cargar el borrador: ${err.message}`, 'error');
    showListView();
  } finally {
    editorTitleInput.disabled = false;
    editorBodyInput.disabled = false;
  }
}

/**
 * Guarda título + texto libre del borrador abierto.
 * @returns {Promise<boolean>} true si el guardado fue exitoso
 */
async function saveDraft() {
  if (!editingArticleId) return false;

  const title = editorTitleInput.value;
  const text = editorBodyInput.value;

  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(editingArticleId)}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
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
editorSaveBtn.addEventListener('click', handleEditorSave);
editorSendBtn.addEventListener('click', handleEditorSend);
loadArticles();
