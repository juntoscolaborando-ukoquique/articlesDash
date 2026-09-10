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

export const state = {
  articles: [],
  activeTab: 'terminado', // 'edicion' | 'en-progreso' | 'terminado'
  editingArticleId: null, // id del borrador abierto en la pantalla de Edición
};
