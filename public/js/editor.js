/**
 * editor.js — the "Edición" draft editor: title + free-text body, local
 * draft-history snapshots (localStorage), save/send, and new-article
 * creation. Self-wires its own controls (save/send/back buttons, paste
 * auto-save) at module load, same as the site-admin and audit-report
 * modules do for theirs.
 */

'use strict';

import {
  viewList, viewDetail, viewEditor,
  newArticleBtn, editorTitleInput, editorSectionSelect, editorBodyInput,
  editorSaveBtn, editorSendBtn, editorSaveStatus, editorBackBtn,
  draftHistoryPanel, draftHistoryList,
} from './dom.js';
import { state } from './state.js';
import { showToast, escHtml, htmlToPlainText, apiFetch } from './utils.js';
import { sendToRevisionArticle } from './api.js';
import { loadArticles, updateTabCounts, setActiveTab, showListView } from './list-view.js';

// ── View switching ────────────────────────────────────────────────────────

export function showEditorView() {
  viewList.style.display = 'none';
  viewDetail.style.display = 'none';
  viewEditor.style.display = 'block';
}

export function setEditorSaveStatus(text) {
  editorSaveStatus.textContent = text;
}

export async function openEditor(id) {
  state.editingArticleId = id;
  showEditorView();
  editorTitleInput.value   = '';
  editorSectionSelect.value = '';
  editorBodyInput.value    = '';
  setEditorSaveStatus('Cargando…');
  editorTitleInput.disabled    = true;
  editorSectionSelect.disabled = true;
  editorBodyInput.disabled     = true;

  try {
    const res = await apiFetch(`/api/articles/${encodeURIComponent(id)}`);
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

// ── Draft history (localStorage snapshots) ───────────────────────────────

const HISTORY_MAX = 5;

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
export function snapshotDraft(id) {
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
export async function saveDraft() {
  if (!state.editingArticleId) return false;

  const title   = editorTitleInput.value;
  const section = editorSectionSelect.value;
  const text    = editorBodyInput.value;

  try {
    const res = await apiFetch(`/api/articles/${encodeURIComponent(state.editingArticleId)}/draft`, {
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

export async function handleEditorSave() {
  editorSaveBtn.disabled = true;
  setEditorSaveStatus('Guardando…');

  const ok = await saveDraft();

  editorSaveBtn.disabled = false;
  setEditorSaveStatus(ok ? 'Guardado ✓' : '');
  if (ok) {
    // Refresca el conteo de la pestaña Edición en segundo plano, sin sacar
    // al usuario de la pantalla de edición.
    fetch('/api/articles').then((r) => r.json()).then((d) => {
      state.articles = d.articles ?? [];
      updateTabCounts(state.articles);
    }).catch(() => {});
  }
}

export async function handleEditorSend() {
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

  const id = state.editingArticleId;
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

export async function createNewArticle() {
  newArticleBtn.disabled = true;
  try {
    const res = await apiFetch('/api/articles', {
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

export async function handleEditorBack() {
  // Guarda en silencio antes de salir — no queremos perder lo que se escribió.
  await saveDraft();
  state.editingArticleId = null;
  showListView();
  loadArticles();
}

// ── Self-wiring ───────────────────────────────────────────────────────────

newArticleBtn.addEventListener('click', createNewArticle);
editorBackBtn.addEventListener('click', handleEditorBack);
editorSaveBtn.addEventListener('click', handleEditorSave);
editorSendBtn.addEventListener('click', handleEditorSend);

// Auto-save on paste in either editor field — wait one tick for the pasted
// text to land in the input value before reading it.
// Snapshot is taken BEFORE the paste so the pre-paste state is preserved.
editorBodyInput.addEventListener('paste', () => { snapshotDraft(state.editingArticleId); setTimeout(saveDraft, 0); });
editorTitleInput.addEventListener('paste', () => { snapshotDraft(state.editingArticleId); setTimeout(saveDraft, 0); });
