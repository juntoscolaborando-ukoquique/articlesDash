/**
 * api.js — fetch wrappers for the article workflow-transition endpoints.
 *
 * publishArticle / demoteArticle / promoteArticle / sendToEdicionArticle /
 * sendToRevisionArticle all follow the same shape: disable the button, show
 * a loading label, POST to an endpoint, toast the result, and either settle
 * (reload + call onSettled) or restore the button. postTransition() carries
 * that shared skeleton; each caller only supplies the endpoint, labels, and
 * the per-status logic that differs (success message, which status codes
 * get special handling, etc.) via onResult().
 *
 * This module is deliberately view-agnostic: it knows nothing about
 * articles-list rows, the detail view, or the editor — callers pass in
 * their own onSettled callback (usually loadArticles from list-view.js) and
 * their own optional button element.
 *
 * `btn` may be null (e.g. sending to revisión from the editor view, where
 * there's no dedicated row button) — the helper skips all button DOM writes
 * in that case. Returns the boolean `success` from onResult(), since at
 * least one caller (handleEditorSend) needs to know whether the transition
 * landed.
 */

'use strict';

import { showToast, apiFetch } from './utils.js';
import { setActiveTab, showListView } from './list-view.js';

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
    const res = await apiFetch(endpoint, {
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

  if (outcome.onSuccess) await outcome.onSuccess();
  else if (outcome.settle) await onSettled();
  if (outcome.restore && btn) {
    btn.disabled = false;
    if (busyClass) btn.classList.remove(busyClass);
    btn.textContent = idleText;
  }

  return outcome.success ?? false;
}

// ── Publish ───────────────────────────────────────────────────────────────

export async function publishArticle(id, btn, onSettled) {
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
        // Article was auto-archived on the server. Always return to the list
        // view first — this matters when publish was triggered from the
        // Detail view, which would otherwise stay on screen showing a now-
        // stale article while the tab state silently changed underneath it
        // — then switch to the Archive tab so the user can see where it
        // went. setActiveTab('archivo') already triggers loadArchive()
        // internally, so we just await the promise it returns instead of
        // calling loadArchive() a second time.
        return {
          success: true,
          settle: false, // skip generic loadArticles — we navigate away instead
          toastType: 'success',
          toastDuration: 7000,
          message: `✅ Publicado en SPIP (ID #${data.spipArticleId}) — el artículo pasó al Archivo.`,
          onSuccess: async () => {
            showListView();
            await setActiveTab('archivo');
          },
        };
      }
      if (res.status === 409) {
        return { success: false, settle: true, toastType: 'info', message: `⛔ ${data.error}` };
      }
      return { success: false, restore: true, toastType: 'error', message: `❌ Error: ${data.error ?? 'Error desconocido'}` };
    },
  });
}

// ── Demote (Terminado → En Progreso) ────────────────────────────────────────

export async function demoteArticle(id, btn, onSettled) {
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

// ── Promote (En Progreso → Terminado) ───────────────────────────────────────

export async function promoteArticle(id, btn, onSettled) {
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

// ── Send to Edición (En Progreso → Edición) ─────────────────────────────────

export async function sendToEdicionArticle(id, btn, onSettled) {
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

// ── Send to Revisión (Edición → En Progreso) ────────────────────────────────
//
// Called with btn=null from the editor view (handleEditorSend) — there's no
// dedicated row button there, just the editor's own "Enviar" button, which
// the caller manages itself. postTransition() skips button DOM writes when
// btn is null; the boolean return value is how handleEditorSend finds out
// whether it needs to re-enable its own button.

export async function sendToRevisionArticle(id, btn, onSettled) {
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
