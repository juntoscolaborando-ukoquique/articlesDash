/**
 * list-view.js — the main articles table, tab switching, and the archive tab.
 *
 * Also owns showListView() (the default/"home" view) since every other view
 * needs to be able to get back to it. This creates import cycles with
 * editor.js, detail-view.js, and site-admin.js (they call back into
 * loadArticles/showListView, and this module calls into them to open a
 * row). That's fine in ES modules as long as the cross-references are only
 * used inside function bodies — never at module-evaluation time — which is
 * the case throughout this split.
 */

'use strict';

import {
  tbody, countEl, newArticleBtn, tabBtns,
  countEdicion, countTerminado, countEnProgreso, countArchivo,
  viewList, viewDetail, viewEditor, viewSite,
} from './dom.js';
import { state } from './state.js';
import { showToast, formatDate, sectionLabel, escHtml, workflowStatusOf } from './utils.js';
import {
  publishArticle, demoteArticle, promoteArticle,
  sendToEdicionArticle, sendToRevisionArticle,
} from './api.js';
import { openEditor } from './editor.js';
import { openDetail, openFieldsEditor } from './detail-view.js';
import { populatePublishedArticlesList } from './site-admin.js';

// ── View switching ────────────────────────────────────────────────────────

export function showListView() {
  viewDetail.style.display = 'none';
  viewEditor.style.display = 'none';
  viewSite.style.display   = 'none';
  viewList.style.display   = 'block';
}

// ── Tab logic ─────────────────────────────────────────────────────────────

export function setActiveTab(tab) {
  state.activeTab = tab;
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  newArticleBtn.style.display = tab === 'edicion' ? '' : 'none';
  if (tab === 'sitio') {
    viewList.style.display  = 'none';
    viewSite.style.display  = 'block';
  } else if (tab === 'archivo') {
    viewSite.style.display  = 'none';
    viewList.style.display  = 'block';
    loadArchive();
  } else {
    viewSite.style.display  = 'none';
    viewList.style.display  = 'block';
    renderTable(state.articles);
  }
}

export function updateTabCounts(data) {
  const edicion    = data.filter((a) => workflowStatusOf(a) === 'edicion').length;
  const terminado  = data.filter((a) => workflowStatusOf(a) === 'terminado').length;
  const enProgreso = data.length - edicion - terminado;
  countEdicion.textContent    = edicion;
  countTerminado.textContent  = terminado;
  countEnProgreso.textContent = enProgreso;
  // Archive count is loaded separately on demand — keep the span current
  // without triggering a fetch; it gets set by loadArchive().
}

// ── Render ────────────────────────────────────────────────────────────────

export function renderRow(article) {
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
  } else if (article.previousSpipIds?.length) {
    // Article was previously published to SPIP but the marker was cleared.
    // Show the old IDs in red as a warning — this article existed in SPIP before.
    const warn = document.createElement('span');
    warn.className = 'spip-id spip-id-stale';
    warn.title = 'Este artículo fue publicado en SPIP anteriormente con este ID. El marcador local fue borrado (re-publicación pendiente).';
    warn.textContent = article.previousSpipIds.map((id) => `#${id}`).join(', ');
    tdSpip.appendChild(warn);
  } else if (article.lastKnownSpipId) {
    // All previous SPIP copies confirmed deleted. Show last known ID as a
    // muted historical reference — not an alert, just audit log info.
    const ref = document.createElement('span');
    ref.className = 'spip-id spip-id-history';
    ref.title = `Publicado anteriormente como SPIP #${article.lastKnownSpipId} — borrado del sitio.`;
    ref.textContent = `#${article.lastKnownSpipId} (borrado)`;
    tdSpip.appendChild(ref);
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

export function renderTable(data) {
  tbody.innerHTML = '';

  const filtered = data.filter((a) => workflowStatusOf(a) === state.activeTab);

  updateTabCounts(data);

  if (!filtered.length) {
    const emptyMessages = {
      edicion:      'No hay borradores en Edición.',
      'en-progreso': 'No hay artículos en progreso.',
      terminado:    'No hay artículos listos para publicar.',
    };
    tbody.innerHTML = `<tr class="state-row"><td colspan="6">${emptyMessages[state.activeTab] ?? 'No hay artículos.'}</td></tr>`;
    countEl.textContent = 'Artículos';
    return;
  }

  if (state.activeTab === 'terminado') {
    const listos     = filtered.filter((a) => a.status === 'listo').length;
    const publicados = filtered.filter((a) => a.status === 'publicado').length;
    countEl.textContent = `Terminado — ${listos} listo${listos !== 1 ? 's' : ''}, ${publicados} publicado${publicados !== 1 ? 's' : ''}`;
  } else if (state.activeTab === 'en-progreso') {
    countEl.textContent = `En Progreso — ${filtered.length} artículo${filtered.length !== 1 ? 's' : ''} para validar`;
  } else {
    countEl.textContent = `Edición — ${filtered.length} borrador${filtered.length !== 1 ? 'es' : ''}`;
  }

  for (const article of filtered) {
    tbody.appendChild(renderRow(article));
  }
}

// ── Data fetching ─────────────────────────────────────────────────────────

export async function loadArticles() {
  tbody.innerHTML = '<tr class="state-row"><td colspan="6">Cargando…</td></tr>';
  try {
    const res = await fetch('/api/articles');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.articles = data.articles ?? [];
    renderTable(state.articles);
    populatePublishedArticlesList(state.articles);
  } catch (err) {
    // Table context: renderError() would produce <p> inside <tbody> (invalid HTML). escHtml() is intentional here.
    tbody.innerHTML = `<tr class="state-row"><td colspan="6">Error al cargar artículos: ${escHtml(err.message)}</td></tr>`;
    showToast(`Error al cargar artículos: ${err.message}`, 'error');
  }
}

// ── Archive tab ───────────────────────────────────────────────────────────

export async function loadArchive() {
  tbody.innerHTML = '<tr class="state-row"><td colspan="6">Cargando archivo…</td></tr>';
  countEl.textContent = 'Archivo';
  try {
    const res = await fetch('/api/articles/archive');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const archived = data.articles ?? [];
    countArchivo.textContent = archived.length;
    renderArchiveTable(archived);
  } catch (err) {
    tbody.innerHTML = `<tr class="state-row"><td colspan="6">Error al cargar el archivo: ${escHtml(err.message)}</td></tr>`;
    showToast(`Error al cargar el archivo: ${err.message}`, 'error');
  }
}

export function renderArchiveTable(data) {
  tbody.innerHTML = '';

  if (!data.length) {
    tbody.innerHTML = '<tr class="state-row"><td colspan="6">El archivo está vacío.</td></tr>';
    countEl.textContent = 'Archivo — vacío';
    return;
  }

  countEl.textContent = `Archivo — ${data.length} artículo${data.length !== 1 ? 's' : ''}`;

  for (const article of data) {
    const tr = document.createElement('tr');
    tr.dataset.id = article.id;

    // Title (read-only — archived articles can't be edited from the dashboard)
    const tdTitle = document.createElement('td');
    tdTitle.className = 'col-title';
    const titleEl = document.createElement('span');
    titleEl.className = 'article-title-link';
    titleEl.style.color = 'var(--muted)';
    titleEl.textContent = article.title || '(sin título)';
    tdTitle.appendChild(titleEl);
    if (article.descriptif) {
      const descDiv = document.createElement('div');
      descDiv.className = 'article-descriptif';
      descDiv.textContent = article.descriptif;
      tdTitle.appendChild(descDiv);
    }

    const tdSection = document.createElement('td');
    tdSection.className = 'col-section';
    tdSection.textContent = sectionLabel(article.section);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = formatDate(article.date);

    const tdStatus = document.createElement('td');
    tdStatus.className = 'col-status';
    tdStatus.innerHTML = `<span class="badge badge-${article.status}">${article.status}</span>`;

    const tdSpip = document.createElement('td');
    tdSpip.className = 'col-spip';
    if (article.spipArticleId && article.publishedUrl) {
      const a = document.createElement('a');
      a.href = article.publishedUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'spip-id';
      a.textContent = `#${article.spipArticleId}`;
      tdSpip.appendChild(a);
    } else if (article.spipArticleId) {
      const span = document.createElement('span');
      span.className = 'spip-id';
      span.textContent = `#${article.spipArticleId}`;
      tdSpip.appendChild(span);
    } else {
      tdSpip.innerHTML = `<span class="spip-id" style="color:var(--border)">—</span>`;
    }

    // No action buttons — archive is read-only
    const tdAction = document.createElement('td');
    tdAction.className = 'col-action';

    tr.append(tdTitle, tdSection, tdDate, tdStatus, tdSpip, tdAction);
    tbody.appendChild(tr);
  }
}

// ── Row action handlers ──────────────────────────────────────────────────

export function handlePublish(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  publishArticle(id, btn, loadArticles);
}

export function handleDemote(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  demoteArticle(id, btn, loadArticles);
}

// ── Duplicate title check ─────────────────────────────────────────────────
// Normalizes a title for loose comparison: lowercase, strip accents,
// collapse non-alphanumeric to spaces.
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Returns the first article whose normalized title near-matches `title`,
// excluding the article with `excludeId`. Checks all workflow statuses.
export function findDuplicateTitle(title, excludeId) {
  const norm = normalizeTitle(title);
  if (!norm) return null;
  return state.articles.find((a) => {
    if (a.id === excludeId) return false;
    const other = normalizeTitle(a.title);
    if (!other) return false;
    return other === norm || other.includes(norm) || norm.includes(other);
  }) ?? null;
}

export function handlePromote(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;

  const article = state.articles.find((a) => a.id === id);
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

export function handleSendToEdicion(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  sendToEdicionArticle(id, btn, loadArticles);
}

export function handleSendToRevisionFromList(e) {
  const btn = e.currentTarget;
  const id  = btn.dataset.articleId;
  sendToRevisionArticle(id, btn, loadArticles);
}
