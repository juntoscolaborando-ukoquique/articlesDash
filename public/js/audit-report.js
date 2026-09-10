/**
 * audit-report.js — the audit reconciliation panel on the "Sitio" tab:
 * duplicate SPIP publications, missing write-backs, and orphaned local
 * markers, each with its own repair action.
 */

'use strict';

import { tabBtns, auditRefreshBtn, auditVerifyBtn, auditLoading, auditContent } from './dom.js';
import { showToast, renderError } from './utils.js';

function fmtTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return ts; }
}

export async function loadAuditReport({ verify = false } = {}) {
  auditLoading.style.display = 'block';
  auditContent.innerHTML = '';
  if (verify) {
    auditVerifyBtn.disabled = true;
    auditVerifyBtn.textContent = '🔍 Verificando…';
  }
  try {
    const url  = verify ? '/api/site/audit-report?verify=true' : '/api/site/audit-report';
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error ?? 'Error desconocido');
    renderAuditReport(data.report);
  } catch (err) {
    renderError(auditContent, err, '❌');
  } finally {
    auditLoading.style.display = 'none';
    auditVerifyBtn.disabled = false;
    auditVerifyBtn.textContent = '🔍 Verificar en SPIP';
  }
}

function renderAuditReport(report) {
  const { duplicates, writeBacksMissing, orphanedMarkers, ok } = report;
  const frag = document.createDocumentFragment();

  // ── A. Duplicados ──────────────────────────────────────────────────────
  if (duplicates.length > 0) {
    // Separar duplicados reales de los ya resueltos según verificación SPIP
    const realDups     = duplicates.filter((d) => !d.resolvedInSpip);
    const resolvedDups = duplicates.filter((d) =>  d.resolvedInSpip);
    const verified     = report.verified;

    const sec = document.createElement('div');
    sec.className = realDups.length > 0
      ? 'audit-section audit-section-danger'
      : 'audit-section audit-section-info';

    const h4 = document.createElement('h4');
    if (realDups.length > 0) {
      h4.textContent = `⚠️  Duplicados en SPIP (${realDups.length})`;
    } else {
      h4.innerHTML = `✅ Sin duplicados activos${verified ? ' <span class="audit-verified-badge">verificado en SPIP</span>' : ''}`;
    }
    sec.appendChild(h4);

    if (realDups.length > 0) {
      const note = document.createElement('p');
      note.className = 'audit-note';
      note.textContent = verified
        ? 'Duplicados confirmados en vivo en SPIP. Mover los IDs sobrantes a la papelera, luego borrarlos desde el formulario de abajo.'
        : 'El mismo artículo fue publicado más de una vez según el audit log. Usar "Verificar en SPIP" para confirmar si los duplicados siguen vivos.';
      sec.appendChild(note);
    }

    for (const group of realDups) {
      const card = document.createElement('div');
      card.className = 'audit-item';

      const titleEl = document.createElement('strong');
      titleEl.textContent = group.title;
      card.appendChild(titleEl);

      const slugEl = document.createElement('code');
      slugEl.className = 'audit-slug';
      slugEl.textContent = group.slug;
      card.appendChild(slugEl);

      const canonical      = group.localSpipId ?? group.suggestedCanonical;
      const isConfirmed    = group.suggestedIsConfirmed;
      const canonicalLabel = group.suggestedIsConfirmed
        ? `SPIP #${canonical} (canónico — en JSON local)`
        : `SPIP #${group.suggestedCanonical} (sugerido, no confirmado)`;

      const canonNote = document.createElement('p');
      canonNote.className = 'audit-canon';
      canonNote.textContent = canonicalLabel;
      card.appendChild(canonNote);

      const list = document.createElement('ul');
      list.className = 'audit-spip-list';
      for (const entry of group.aliveEntries) {
        const li = document.createElement('li');
        const isCanon  = canonical && String(entry.spipArticleId) === String(canonical);
        const spipGone = group.verifiedInSpip && entry.spipExists === false;
        li.innerHTML = `SPIP #<strong>${entry.spipArticleId}</strong> — ${fmtTs(entry.loggedAt)}`;
        if (isCanon) {
          li.innerHTML += isConfirmed
            ? ' <span class="audit-badge audit-badge-canon">canónico</span>'
            : ' <span class="audit-badge audit-badge-suggested">sugerido — no mover</span>';
        } else if (spipGone) {
          li.innerHTML += ' <span class="audit-spip-gone">ya no existe en SPIP</span>';
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'audit-btn-confirm-deleted';
          confirmBtn.textContent = `Confirmar borrado de #${entry.spipArticleId}`;
          confirmBtn.title = 'Revisá manualmente en SPIP antes de confirmar — esto es permanente.';
          confirmBtn.addEventListener('click', () => handleConfirmExternalDeletion(entry.spipArticleId, confirmBtn));
          li.appendChild(confirmBtn);
        } else {
          const btn = document.createElement('button');
          btn.className = 'audit-btn-papelera';
          btn.textContent = `Mover #${entry.spipArticleId} a papelera`;
          btn.dataset.spipId = entry.spipArticleId;
          btn.addEventListener('click', () => handleMoveToPapelera(entry.spipArticleId, btn));
          li.appendChild(btn);
        }
        list.appendChild(li);
      }
      card.appendChild(list);
      sec.appendChild(card);
    }

    // Duplicados resueltos (solo se muestran si se verificó en SPIP)
    if (resolvedDups.length > 0 && verified) {
      const resolvedNote = document.createElement('p');
      resolvedNote.className = 'audit-note';
      resolvedNote.innerHTML = `<em>Resueltos (IDs sobrantes ya no existen en SPIP): ${resolvedDups.map((d) => d.slug).join(', ')}</em>`;
      sec.appendChild(resolvedNote);
    }

    frag.appendChild(sec);
  }

  // ── B. Write-backs perdidos ───────────────────────────────────────────
  if (writeBacksMissing.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'audit-section audit-section-warning';
    const h4 = document.createElement('h4');
    h4.textContent = `⏳ Write-backs perdidos (${writeBacksMissing.length})`;
    sec.appendChild(h4);
    const note = document.createElement('p');
    note.className = 'audit-note';
    note.textContent = 'Publicados en SPIP según el audit log, pero el JSON local no tiene el marcador spipArticleId. Usar "Recuperar" para escribirlo.';
    sec.appendChild(note);

    for (const entry of writeBacksMissing) {
      const card = document.createElement('div');
      card.className = 'audit-item';

      const titleEl = document.createElement('strong');
      titleEl.textContent = entry.title;
      card.appendChild(titleEl);

      const slugEl = document.createElement('code');
      slugEl.className = 'audit-slug';
      slugEl.textContent = entry.slug;
      card.appendChild(slugEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'audit-meta';
      metaEl.textContent = `SPIP #${entry.spipArticleId} — ${fmtTs(entry.loggedAt)}`;
      card.appendChild(metaEl);

      const btn = document.createElement('button');
      btn.className = 'audit-btn-recover';
      btn.textContent = 'Recuperar marcador';
      btn.dataset.slug = entry.slug;
      btn.addEventListener('click', () => handleRecover(entry.slug, btn));
      card.appendChild(btn);

      const result = document.createElement('span');
      result.className = 'audit-inline-result';
      card.appendChild(result);

      sec.appendChild(card);
    }
    frag.appendChild(sec);
  }

  // ── C. Marcadores huérfanos ───────────────────────────────────────────
  if (orphanedMarkers.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'audit-section audit-section-info';
    const h4 = document.createElement('h4');
    h4.textContent = `ℹ️  Marcadores sin respaldo en el log (${orphanedMarkers.length})`;
    sec.appendChild(h4);
    const note = document.createElement('p');
    note.className = 'audit-note';
    note.textContent = 'El JSON tiene spipArticleId pero no hay entrada de article.create en el audit log que lo respalde. Puede ser un JSON editado a mano o un log migrado.';
    sec.appendChild(note);

    for (const marker of orphanedMarkers) {
      const card = document.createElement('div');
      card.className = 'audit-item';

      const titleEl = document.createElement('strong');
      titleEl.textContent = marker.title;
      card.appendChild(titleEl);

      const slugEl = document.createElement('code');
      slugEl.className = 'audit-slug';
      slugEl.textContent = marker.id;
      card.appendChild(slugEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'audit-meta';
      metaEl.textContent = `spipArticleId: ${marker.spipArticleId} — verificar manualmente`;
      card.appendChild(metaEl);

      sec.appendChild(card);
    }
    frag.appendChild(sec);
  }

  // ── D. OK banner ─────────────────────────────────────────────────────
  const realDuplicates = duplicates.filter((d) => !d.resolvedInSpip);
  if (realDuplicates.length === 0 && writeBacksMissing.length === 0 && orphanedMarkers.length === 0) {
    const okEl = document.createElement('p');
    okEl.className = 'audit-ok';
    okEl.innerHTML = `✅ Audit log y archivos locales coinciden. (${report.ok.length} artículo${report.ok.length !== 1 ? 's' : ''} OK)` +
      (report.verified ? ' <span class="audit-verified-badge">verificado en SPIP</span>' : '');
    frag.appendChild(okEl);
  } else {
    const summary = document.createElement('p');
    summary.className = 'audit-summary';
    summary.textContent = `${ok.length} OK · ${realDuplicates.length} duplicado${realDuplicates.length !== 1 ? 's' : ''} · ${writeBacksMissing.length} write-back pendiente${writeBacksMissing.length !== 1 ? 's' : ''} · ${orphanedMarkers.length} huérfano${orphanedMarkers.length !== 1 ? 's' : ''}` +
      (report.verified ? ' · verificado en SPIP ✓' : '');
    frag.appendChild(summary);
  }

  auditContent.appendChild(frag);
}

async function handleMoveToPapelera(spipId, btn) {
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res  = await fetch(`/api/site/article/${encodeURIComponent(spipId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'poubelle' }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ SPIP #${spipId} movido a la papelera. Ahora podés borrarlo desde el formulario de Borrado permanente.`, 'success', 8000);
      await loadAuditReport();
    } else {
      btn.disabled = false;
      btn.textContent = `Mover #${spipId} a papelera`;
      showToast(`❌ ${data.error ?? 'Error desconocido'}`, 'error');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Mover #${spipId} a papelera`;
    showToast(`❌ Error de red: ${err.message}`, 'error');
  }
}

async function handleConfirmExternalDeletion(spipId, btn) {
  // Gate de confirmación — esto es permanente e irreversible (ver spip-admin.mjs
  // confirmExternalDeletion). La verificación en vivo es un indicio, no una
  // prueba; por eso pedimos que un humano lo revise antes de confirmar.
  const confirmed = confirm(
    `⚠️  Confirmar que el artículo SPIP #${spipId} fue borrado externamente.\n\n` +
    `Esto es PERMANENTE: el ID se excluirá de todos los reportes de duplicados ` +
    `futuros, incluso sin verificar. Recomendado: revisá manualmente en SPIP ` +
    `(/ecrire/?exec=article&id_article=${spipId}) antes de confirmar.\n\n` +
    `¿Continuar?`
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = 'Confirmando…';
  try {
    const res  = await fetch(`/api/site/duplicates/${encodeURIComponent(spipId)}/confirm-deleted`, {
      method: 'POST',
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ SPIP #${spipId} confirmado como borrado externamente.`, 'success', 6000);
      await loadAuditReport();
    } else {
      btn.disabled = false;
      btn.textContent = `Confirmar borrado de #${spipId}`;
      showToast(`❌ ${data.error ?? 'Error desconocido'}`, 'error');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Confirmar borrado de #${spipId}`;
    showToast(`❌ Error de red: ${err.message}`, 'error');
  }
}

async function handleRecover(slug, btn) {
  btn.disabled = true;
  btn.textContent = 'Recuperando…';
  const resultEl = btn.nextElementSibling;
  try {
    const res  = await fetch(`/api/articles/${encodeURIComponent(slug)}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      resultEl.textContent = `✅ Recuperado — SPIP #${data.spipArticleId}`;
      resultEl.className = 'audit-inline-result ok';
      setTimeout(() => loadAuditReport(), 1200);
    } else {
      btn.disabled = false;
      btn.textContent = 'Recuperar marcador';
      resultEl.textContent = `❌ ${data.error ?? 'Error'}`;
      resultEl.className = 'audit-inline-result err';
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Recuperar marcador';
    resultEl.textContent = `❌ Error de red: ${err.message}`;
    resultEl.className = 'audit-inline-result err';
  }
}

// ── Self-wiring ───────────────────────────────────────────────────────────

auditRefreshBtn.addEventListener('click', () => loadAuditReport());
auditVerifyBtn.addEventListener('click',  () => loadAuditReport({ verify: true }));

// Load the audit report automatically when the Sitio tab is activated
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'sitio') {
      loadAuditReport();
    }
  });
});
