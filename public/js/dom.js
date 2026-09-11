/**
 * dom.js — centralized DOM element references.
 *
 * Queried once at module load, same as the original inline consts at the
 * top of the monolithic app.js. Any module that needs one of these imports
 * it from here instead of calling document.getElementById() itself, so
 * there's a single source of truth for "what does index.html need to
 * provide" (this is also what test/check-dom-ids.sh checks against).
 */

'use strict';

export const tbody          = document.getElementById('articles-body');
export const countEl        = document.getElementById('article-count');
export const refreshBtn     = document.getElementById('refresh-btn');
export const newArticleBtn  = document.getElementById('new-article-btn');
export const toastContainer = document.getElementById('toast-container');

export const viewList      = document.getElementById('view-list');
export const viewDetail    = document.getElementById('view-detail');
export const detailContent = document.getElementById('detail-content');
export const backBtn       = document.getElementById('back-btn');

export const viewEditor          = document.getElementById('view-editor');
export const viewSite            = document.getElementById('view-site');
export const editorBackBtn       = document.getElementById('editor-back-btn');
export const editorTitleInput    = document.getElementById('editor-title');
export const editorSectionSelect = document.getElementById('editor-section');
export const editorBodyInput     = document.getElementById('editor-body');
export const editorSaveBtn       = document.getElementById('editor-save-btn');
export const editorSendBtn       = document.getElementById('editor-send-btn');
export const editorSaveStatus    = document.getElementById('editor-save-status');

export const tabBtns         = document.querySelectorAll('.tab-btn');
export const countEdicion    = document.getElementById('count-edicion');
export const countTerminado  = document.getElementById('count-terminado');
export const countEnProgreso = document.getElementById('count-en-progreso');
export const countArchivo    = document.getElementById('count-archivo');

export const draftHistoryPanel = document.getElementById('draft-history-panel');
export const draftHistoryList  = document.getElementById('draft-history-list');

export const siteStatusIdInput = document.getElementById('site-status-id');
export const siteStatusSelect  = document.getElementById('site-status-select');
export const siteStatusBtn     = document.getElementById('site-status-btn');
export const siteStatusResult  = document.getElementById('site-status-result');
export const siteDeleteIdInput = document.getElementById('site-delete-id');
export const siteDeleteBtn     = document.getElementById('site-delete-btn');
export const siteDeleteResult  = document.getElementById('site-delete-result');

export const auditRefreshBtn = document.getElementById('audit-refresh-btn');
export const auditVerifyBtn  = document.getElementById('audit-verify-btn');
export const auditLoading    = document.getElementById('audit-loading');
export const auditContent    = document.getElementById('audit-content');

export const serverOfflineBanner = document.getElementById('server-offline-banner');
export const serverRetryBtn      = document.getElementById('server-retry-btn');
