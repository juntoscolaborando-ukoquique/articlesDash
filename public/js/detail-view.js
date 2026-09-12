/**
 * detail-view.js — the read-only article detail screen, the "En Progreso"
 * fields editor (both render into #detail-content, one replacing the other
 * depending on workflowStatus), and the HTML sanitizer that makes it safe
 * to inject article HTML into either of them.
 */

'use strict';

import { viewList, viewEditor, viewDetail, detailContent } from './dom.js';
import { escHtml, formatDate, sectionLabel, renderError, showToast, htmlToPlainText, textToParagraphHtml } from './utils.js';
import { publishArticle, demoteArticle, promoteArticle, sendToEdicionArticle } from './api.js';
import { loadArticles, showListView } from './list-view.js';

// ── View switching ────────────────────────────────────────────────────────

export function showDetailViewLoading() {
  viewList.style.display = 'none';
  viewEditor.style.display = 'none';
  viewDetail.style.display = 'block';
  detailContent.innerHTML = '<p style="color:var(--muted)">Cargando…</p>';
}

// ── Detail view ───────────────────────────────────────────────────────────

export async function openDetail(id) {
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

// renderDetail() itself just computes the flags, sets the markup, and wires
// the buttons that markup produced. The markup building and the button
// wiring each live in their own function below so neither has to be read
// alongside the other to understand either one.

function topicsHtmlFor(article) {
  return Array.isArray(article.topics) && article.topics.length
    ? `<div class="topics-list">${article.topics.map((t) => `<span class="topic-chip">${escHtml(t)}</span>`).join('')}</div>`
    : '<span style="color:var(--muted)">—</span>';
}

function spipHtmlFor(article) {
  if (!article.spipArticleId) return '<span style="color:var(--muted)">—</span>';
  return article.publishedUrl
    ? `<span class="spip-id"><a href="${escHtml(article.publishedUrl)}" target="_blank" rel="noopener">#${escHtml(String(article.spipArticleId))}</a></span>`
    : `<span class="spip-id">#${escHtml(String(article.spipArticleId))}</span>`;
}

function buildDetailHtml(article, { isPublished, status, isTerminadoDetail }) {
  return `
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
        <span><strong>ID SPIP:</strong> ${spipHtmlFor(article)}</span>
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
      ${topicsHtmlFor(article)}

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
}

function wirePublishButton(article, isPublished) {
  if (isPublished) return;
  const detailBtn = document.getElementById('detail-publish-btn');
  detailBtn.addEventListener('click', () => {
    publishArticle(article.id, detailBtn, async () => {
      await loadArticles();   // actualiza la lista en background
      await openDetail(article.id);
    });
  });
}

function wireApprovalButtons(article, isTerminadoDetail) {
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
    return;
  }

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
function wireCopyButton(article) {
  if (article.workflowStatus !== 'en-progreso') return;

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

export function renderDetail(article) {
  const isPublished = Boolean(article.spipArticleId);
  const status = isPublished ? 'publicado' : 'listo';
  // GET /api/articles/:id devuelve el JSON crudo (loadArticle), no el objeto
  // mapeado de listArticles() — mismo default de ausencia que allá.
  const isTerminadoDetail = (article.workflowStatus ?? 'terminado') === 'terminado';

  detailContent.innerHTML = buildDetailHtml(article, { isPublished, status, isTerminadoDetail });

  wirePublishButton(article, isPublished);
  wireApprovalButtons(article, isTerminadoDetail);
  wireCopyButton(article);
}

// ── Fields editor view (En Progreso) ─────────────────────────────────────
//
// Formulario editable de los campos separados por el splitter heurístico
// (src/lib/field-splitter.mjs) al entrar a En Progreso: chapo / contenido /
// ps / topics / metadata de fuente. Reemplaza la vista de solo-lectura
// (renderDetail) únicamente para artículos en workflowStatus 'en-progreso'.
// Ver docs/IMPROVE_STEPS.md — Paso 4.

export async function openFieldsEditor(id) {
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

export function renderFieldsEditor(article) {
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

// ── HTML sanitiser ────────────────────────────────────────────────────────
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

export async function loadAllowedTagsFromSchema() {
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
export function sanitizeHtml(html) {
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
