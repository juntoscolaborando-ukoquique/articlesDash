/**
 * duplicates.js — local duplicate-title detection on the "Sitio" tab.
 *
 * Compares normalized titles across articles/*.json (never archive/, never
 * SPIP) and lets the user pick which copy to keep and delete the rest.
 * Only ever calls DELETE /api/articles/:id — the server blocks that for any
 * article already published or already in Terminado, so this UI can never
 * reach a live SPIP article. Completamente aislado del resto del pipeline
 * editorial, igual que site-admin.js / audit-report.js.
 */

'use strict';

import { findDuplicatesBtn, duplicatesResult } from './dom.js';
import { showToast, renderError, apiFetch } from './utils.js';

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function buildArticleRow(article, groupIndex, isSuggestedKeep) {
  const li = document.createElement('li');
  li.className = 'dup-item';

  const label = document.createElement('label');
  label.className = 'dup-item-label';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `dup-keep-${groupIndex}`;
  radio.value = article.id;
  radio.checked = isSuggestedKeep;
  label.appendChild(radio);

  const main = document.createElement('div');
  main.className = 'dup-item-main';

  const titleRow = document.createElement('div');
  titleRow.className = 'dup-item-title-row';
  const idEl = document.createElement('code');
  idEl.className = 'dup-item-id';
  idEl.textContent = article.id;
  titleRow.appendChild(idEl);
  if (isSuggestedKeep) {
    const badge = document.createElement('span');
    badge.className = 'dup-badge-keep';
    badge.textContent = 'más reciente';
    titleRow.appendChild(badge);
  }
  main.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'dup-item-meta';
  const spip = article.spipArticleId ? `SPIP #${article.spipArticleId}` : 'no publicado';
  meta.textContent =
    `${article.workflowStatus} · ${spip} · ${fmtDate(article.modifiedAtMs)} · ` +
    `${fmtBytes(article.fileSize)} · ${article.wordCount} palabras`;
  main.appendChild(meta);

  label.appendChild(main);
  li.appendChild(label);
  return li;
}

function buildGroupCard(group, groupIndex) {
  const card = document.createElement('div');
  card.className = 'dup-group';
  card.dataset.group = String(groupIndex);

  const h4 = document.createElement('h4');
  h4.textContent = `"${group.articles[0].title}" — ${group.articles.length} copias`;
  card.appendChild(h4);

  const list = document.createElement('ul');
  list.className = 'dup-list';
  group.articles.forEach((article, i) => {
    list.appendChild(buildArticleRow(article, groupIndex, i === 0));
  });
  card.appendChild(list);

  const btn = document.createElement('button');
  btn.className = 'dup-btn-delete';
  btn.textContent = 'Borrar no seleccionados';
  btn.addEventListener('click', () => handleDeleteGroup(card, btn));
  card.appendChild(btn);

  const result = document.createElement('p');
  result.className = 'dup-group-result';
  card.appendChild(result);

  return card;
}

async function handleFindDuplicates() {
  findDuplicatesBtn.disabled = true;
  findDuplicatesBtn.textContent = 'Buscando…';
  duplicatesResult.innerHTML = '';

  try {
    const res = await apiFetch('/api/articles/duplicates');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Error desconocido');

    if (data.groups.length === 0) {
      duplicatesResult.innerHTML = '<p class="dup-ok">✓ No se encontraron títulos duplicados.</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    data.groups.forEach((group, i) => frag.appendChild(buildGroupCard(group, i)));
    duplicatesResult.appendChild(frag);
  } catch (err) {
    renderError(duplicatesResult, err, '❌');
  } finally {
    findDuplicatesBtn.disabled = false;
    findDuplicatesBtn.textContent = 'Buscar duplicados';
  }
}

async function handleDeleteGroup(card, btn) {
  const radios = Array.from(card.querySelectorAll('input[type="radio"]'));
  const keepId = card.querySelector('input[type="radio"]:checked')?.value;
  const toDelete = radios.map((r) => r.value).filter((id) => id !== keepId);

  if (toDelete.length === 0) return; // nada seleccionado para borrar

  const confirmed = confirm(
    `Vas a borrar ${toDelete.length} artículo${toDelete.length !== 1 ? 's' : ''}:\n\n` +
    toDelete.map((id) => `  - ${id}`).join('\n') +
    `\n\nSe conserva: ${keepId}\n\n` +
    `Esta operación no se puede deshacer. ¿Continuar?`
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = 'Borrando…';
  const resultEl = card.querySelector('.dup-group-result');

  const failed = [];
  for (const id of toDelete) {
    try {
      const res  = await apiFetch(`/api/articles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) failed.push(`${id}: ${data.error ?? 'error desconocido'}`);
    } catch (err) {
      failed.push(`${id}: ${err.message}`);
    }
  }

  if (failed.length > 0) {
    resultEl.textContent = `❌ ${failed.join(' · ')}`;
    resultEl.className = 'dup-group-result err';
    btn.disabled = false;
    btn.textContent = 'Borrar no seleccionados';
    return;
  }

  showToast(
    `✅ ${toDelete.length} artículo${toDelete.length !== 1 ? 's' : ''} borrado${toDelete.length !== 1 ? 's' : ''}.`,
    'success',
    6000
  );
  card.remove();
  if (duplicatesResult.querySelectorAll('.dup-group').length === 0) {
    duplicatesResult.innerHTML = '<p class="dup-ok">✓ Todos los duplicados de esta búsqueda fueron resueltos.</p>';
  }
}

// ── Self-wiring ─────────────────────────────────────────────────────────────

findDuplicatesBtn.addEventListener('click', handleFindDuplicates);
