/**
 * state.js — shared mutable app state.
 *
 * Exported as a single object rather than separate `let` bindings: ES
 * module exports of `let`/`const` are read-only live bindings from the
 * *importing* module's side — an importer can read `articles` but can't do
 * `articles = [...]`. Every module that needs to mutate this state instead
 * assigns a property on the same shared object (`state.articles = [...]`),
 * which every other module sees immediately since they all hold the same
 * object reference.
 */

'use strict';

/**
 * Workflow-status constants — the three states an article can be in on
 * the local dashboard (not to be confused with SPIP's own statut field,
 * which is always "prepa"). Use these instead of raw string literals so
 * that a typo is a ReferenceError at load time, not a silent misroute.
 *
 * Backend equivalent: VALID_WORKFLOW_STATUSES in articles-store.mjs.
 */
export const WS = Object.freeze({
  EDICION:     'edicion',
  EN_PROGRESO: 'en-progreso',
  TERMINADO:   'terminado',
});

export const state = {
  articles: [],
  activeTab: WS.TERMINADO,  // default tab on load
  editingArticleId: null,   // id of the draft open in the Edición screen
};
