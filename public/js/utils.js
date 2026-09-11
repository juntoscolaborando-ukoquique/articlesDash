/**
 * utils.js — small helpers with no view of their own: toasts, formatting,
 * escaping, workflow-status logic, and the plain-text/HTML converters used
 * by both the fields editor and the draft editor.
 */

'use strict';

import { toastContainer } from './dom.js';

// ── Toast ─────────────────────────────────────────────────────────────────

export function showToast(message, type = 'info', durationMs = 5000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export function sectionLabel(section) {
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

// ── Workflow status ───────────────────────────────────────────────────────

export function workflowStatusOf(article) {
  // workflowStatus is the source of truth for the tab. Missing = "terminado"
  // (default for articles created before this field existed). The backend
  // already self-heals: an article declared "terminado" that fails
  // validateArticle gets demoted to "en-progreso" on every GET /api/articles,
  // so by the time it reaches here workflowStatus already reflects that.
  // Edición is never auto-assigned — it only shows up if a human sent the
  // article there explicitly, so no self-heal path leads here.
  return article.workflowStatus ?? 'terminado';
}

export function isTerminado(article) {
  return workflowStatusOf(article) === 'terminado';
}

// ── XSS helper ────────────────────────────────────────────────────────────

export function escHtml(str) {
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
export function renderError(el, err, prefix = 'Error') {
  const msg = (err instanceof Error ? err.message : String(err)) || 'Error desconocido';
  el.innerHTML = `<p style="color:var(--red)">${escHtml(prefix)}: ${escHtml(msg)}</p>`;
}

// ── Server offline detection ──────────────────────────────────────────────

/**
 * Returns true when the error is a connectivity failure (fetch could not
 * reach the server at all — not a 4xx/5xx HTTP response, which still means
 * the server is up). Covers the Firefox "NetworkError" and Chrome
 * "Failed to fetch" messages as well as generic TypeError from fetch.
 */
export function isNetworkError(err) {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('networkerror') ||
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('network request failed')
  );
}

let _retryInterval = null;
let _retryListenerAttached = false;

/**
 * Show the persistent offline banner and start polling /api/articles every
 * 3 s. When the server responds the banner is hidden automatically and the
 * page reloads so the user sees fresh data.
 *
 * Safe to call multiple times — the retry listener and the poll interval are
 * each guarded against being registered more than once.
 */
export function showOfflineBanner() {
  // Lazy import to avoid circular dep (dom.js → utils.js is already present)
  import('./dom.js').then(({ serverOfflineBanner, serverRetryBtn }) => {
    if (!serverOfflineBanner) return;
    serverOfflineBanner.hidden = false;

    // Wire the retry button exactly once across all calls
    if (!_retryListenerAttached) {
      _retryListenerAttached = true;
      serverRetryBtn.addEventListener('click', () => _tryReconnect(serverOfflineBanner, serverRetryBtn));
    }

    // Auto-poll every 3 s — only one interval at a time
    if (_retryInterval) return;
    _retryInterval = setInterval(() => _tryReconnect(serverOfflineBanner, serverRetryBtn), 3000);
  });
}

async function _tryReconnect(banner, btn) {
  btn.disabled = true;
  btn.textContent = 'Reintentando…';
  try {
    const res = await fetch('/api/articles', { method: 'GET' });
    if (res.ok) {
      clearInterval(_retryInterval);
      _retryInterval = null;
      banner.hidden = true;
      window.location.reload();
    } else {
      btn.disabled = false;
      btn.textContent = '↺ Reintentar';
    }
  } catch {
    btn.disabled = false;
    btn.textContent = '↺ Reintentar';
  }
}
//
// Duplicado intencional de htmlParagraphsToText() / textToParagraphHtml()
// en src/lib/text-to-html.mjs. El frontend no tiene bundler, así que no
// puede importar el módulo Node directamente. Si se añade un paso de
// build, colapsar en una sola función. Mantener sincronizadas: cualquier
// cambio aquí debe reflejarse allá y viceversa (ver test/text-to-html.test.mjs
// para el lado Node — no hay equivalente para estas copias todavía).

export function htmlToPlainText(html) {
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

export function textToParagraphHtml(text) {
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
