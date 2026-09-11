/**
 * site-admin.js — the "Sitio" tab's direct SPIP admin actions (status
 * change, permanent delete) and the published-articles autocomplete list
 * that feeds its ID input.
 *
 * Completamente aislado del pipeline editorial. No toca `state.articles`,
 * `state.activeTab` ni ninguna función del pipeline (salvo leer la lista de
 * artículos publicados para el autocomplete). Llama únicamente a
 * /api/site/* endpoints. Para añadir nuevas operaciones de sitio: añadir un
 * .site-card en index.html y una función aquí. No hay que tocar nada del
 * pipeline editorial.
 */

'use strict';

import {
  siteStatusIdInput, siteStatusSelect, siteStatusBtn, siteStatusResult,
  siteDeleteIdInput, siteDeleteBtn, siteDeleteResult,
} from './dom.js';
import { apiFetch } from './utils.js';

/**
 * Rellena el <datalist id="published-articles-list"> con los últimos 10
 * artículos publicados (tienen spipArticleId). Cuando el usuario elige una
 * opción, el valor del input queda como el ID SPIP numérico.
 * El label visible es "Título (SPIP #ID)" para que sea reconocible.
 */
export function populatePublishedArticlesList(allArticles) {
  const datalist = document.getElementById('published-articles-list');
  if (!datalist) return;

  const published = allArticles
    .filter((a) => a.spipArticleId)
    .sort((a, b) => Number(b.spipArticleId) - Number(a.spipArticleId)) // más recientes primero
    .slice(0, 10);

  datalist.innerHTML = '';
  for (const a of published) {
    const opt = document.createElement('option');
    opt.value = a.spipArticleId;
    opt.label = `${a.title} (SPIP #${a.spipArticleId})`;
    datalist.appendChild(opt);
  }
}

function setSiteResult(el, message, isOk) {
  el.textContent = message;
  el.className   = 'site-result ' + (isOk ? 'ok' : 'err');
}

async function handleSiteStatusChange() {
  const spipId = siteStatusIdInput.value.trim();
  const status = siteStatusSelect.value;

  if (!spipId) { setSiteResult(siteStatusResult, '❌ Ingresá el ID SPIP del artículo.', false); return; }
  if (!status) { setSiteResult(siteStatusResult, '❌ Elegí un estado.', false); return; }

  // Gate de confirmación para publie (publicación directa sin flujo editorial)
  if (status === 'publie') {
    const confirmed = confirm(
      `⚠️  Publicar directamente el artículo ${spipId} sin pasar por el flujo editorial.\n\n` +
      `Esto lo hará visible en el sitio público inmediatamente.\n\n` +
      `¿Continuar?`
    );
    if (!confirmed) return;
  }

  siteStatusBtn.disabled = true;
  setSiteResult(siteStatusResult, 'Conectando con SPIP…', true);

  try {
    const body = { status };
    if (status === 'publie') body.approvePublishing = true;

    const res  = await apiFetch(`/api/site/article/${encodeURIComponent(spipId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      const label = data.finalStatus ?? status;
      setSiteResult(siteStatusResult, `✅ Artículo ${spipId} → "${label}"`, true);
    } else {
      setSiteResult(siteStatusResult, `❌ ${data.error ?? 'Error desconocido'}`, false);
    }
  } catch (err) {
    setSiteResult(siteStatusResult, `❌ Error de red: ${err.message}`, false);
  } finally {
    siteStatusBtn.disabled = false;
  }
}

async function handleSiteDelete() {
  const spipId = siteDeleteIdInput.value.trim();
  if (!spipId) { setSiteResult(siteDeleteResult, '❌ Ingresá el ID SPIP del artículo.', false); return; }

  // Gate de confirmación para borrado permanente (irreversible)
  const confirmed = confirm(
    `⚠️  BORRADO PERMANENTE del artículo ${spipId}\n\n` +
    `Esta operación es IRREVERSIBLE. El artículo desaparecerá completamente de SPIP.\n\n` +
    `El artículo debe estar en la papelera ("poubelle") primero.\n\n` +
    `¿Continuar?`
  );
  if (!confirmed) return;

  siteDeleteBtn.disabled = true;
  setSiteResult(siteDeleteResult, 'Conectando con SPIP…', true);

  try {
    const res  = await apiFetch(`/api/site/article/${encodeURIComponent(spipId)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      setSiteResult(siteDeleteResult, `✅ Artículo ${spipId} borrado permanentemente.`, true);
      siteDeleteIdInput.value = '';
    } else {
      setSiteResult(siteDeleteResult, `❌ ${data.error ?? 'Error desconocido'}`, false);
    }
  } catch (err) {
    setSiteResult(siteDeleteResult, `❌ Error de red: ${err.message}`, false);
  } finally {
    siteDeleteBtn.disabled = false;
  }
}

// ── Self-wiring ───────────────────────────────────────────────────────────

siteStatusBtn.addEventListener('click', handleSiteStatusChange);
siteDeleteBtn.addEventListener('click', handleSiteDelete);
