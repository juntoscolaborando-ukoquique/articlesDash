/**
 * main.js — Kilombo Dashboard entry point.
 *
 * Responsabilidades: cargar la lista de artículos, wirear la navegación
 * central (tabs, refresh, volver), y arrancar los fetches iniciales. Cada
 * módulo de vista (list-view, detail-view, editor, site-admin,
 * audit-report) wirea sus propios controles internos al importarse — este
 * archivo sólo conecta lo que es genuinamente "routing" entre vistas.
 */

'use strict';

import { refreshBtn, backBtn, tabBtns } from './dom.js';
import { WS } from './state.js';
import { loadArticles, setActiveTab, showListView } from './list-view.js';
import { loadAllowedTagsFromSchema } from './detail-view.js';

// Importados solo por su efecto de auto-wiring al cargar el módulo (cada
// uno registra sus propios event listeners internamente).
import './editor.js';
import './site-admin.js';
import './audit-report.js';

// ── Core navigation ───────────────────────────────────────────────────────

tabBtns.forEach((btn) => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));
refreshBtn.addEventListener('click', loadArticles);
backBtn.addEventListener('click', showListView);
document.getElementById('site-back-btn').addEventListener('click', () => setActiveTab(WS.TERMINADO));

// ── Boot ──────────────────────────────────────────────────────────────────

loadArticles();
loadAllowedTagsFromSchema();
