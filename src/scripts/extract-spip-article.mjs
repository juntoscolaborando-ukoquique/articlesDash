#!/usr/bin/env node
/**
 * extract-spip-article.mjs — lee el contenido de un artículo SPIP y lo
 * imprime como JSON en stdout.
 *
 * Usa la vista exec=article (solo lectura) que renderiza los campos en el DOM
 * como HTML display. Los campos que SPIP carga vía AJAX (texte, chapo, etc.)
 * se leen de los divs de presentación (.texte, .chapo, …), no de los inputs
 * del formulario de edición.
 *
 * Uso:
 *   node src/scripts/extract-spip-article.mjs <id>
 *
 * Ejemplo:
 *   node src/scripts/extract-spip-article.mjs 128
 *
 * Salida: JSON con los campos: titre, surtitre, soustitre, texte, descriptif,
 *   chapo, ps, nom_site, url_site, sectionId, sectionLabel, statusLabel,
 *   date, auteur, lang, topics, allFields (diagnóstico)
 */

import { withSpipSession, BASE_URL } from '../lib/spip-session.mjs';

const id = process.argv[2];
if (!id) {
  console.error('Uso: node src/scripts/extract-spip-article.mjs <id>');
  process.exit(2);
}

const targetUrl = `${BASE_URL}/ecrire/?exec=article&id_article=${id}`;

await withSpipSession(async (page) => {
  console.error(`Navegando a ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Esperar a que los bloques AJAX terminen de renderizarse
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const val  = (sel) => (document.querySelector(sel)?.value  ?? '').trim();
    const text = (sel) => (document.querySelector(sel)?.textContent ?? '').trim();

    // ── Título ────────────────────────────────────────────────────────────────
    // SPIP read view renders title in .contenu_titre .titre (not in an input).
    // Fall back to input value for cases where the edit form is open.
    const titreInput   = document.querySelector('input[name="titre"]');
    const titreDisplay = document.querySelector('.contenu_titre .titre, h1.titre, .titre h1');
    const titre = (titreDisplay?.textContent || '').trim()
      || (titreInput?.value || '').trim();

    // ── Surtitre / Soustitre ──────────────────────────────────────────────────
    const surtitre  = text('.contenu_surtitre .surtitre')
      || val('input[name="surtitre"]');
    const soustitre = text('.contenu_soustitre .soustitre')
      || val('input[name="soustitre"]');

    // ── Texte (cuerpo) ────────────────────────────────────────────────────────
    const texteTextarea = document.querySelector('textarea[name="texte"]');
    const texteDiv      = document.querySelector('.contenu_texte .texte, .texte');
    const texte = (texteTextarea?.value || '').trim()
      || (texteDiv?.innerHTML || '').trim();

    // ── Descriptif ────────────────────────────────────────────────────────────
    const descriptif = val('textarea[name="descriptif"]')
      || text('.contenu_descriptif .descriptif, .descriptif');

    // ── Chapo (entradilla) ────────────────────────────────────────────────────
    const chapoTextarea = document.querySelector('textarea[name="chapo"]');
    const chapoDiv      = document.querySelector('.contenu_chapo .chapo, .chapo');
    const chapo = (chapoTextarea?.value || '').trim()
      || (chapoDiv?.innerHTML || '').trim();

    // ── PS ────────────────────────────────────────────────────────────────────
    const psTextarea = document.querySelector('textarea[name="ps"]');
    const psDiv      = document.querySelector('.contenu_ps .ps, .ps');
    const ps = (psTextarea?.value || '').trim()
      || (psDiv?.innerHTML || '').trim();

    // ── Fuente ────────────────────────────────────────────────────────────────
    const nom_site = val('input[name="nom_site"]')
      || text('.contenu_nom_site .nom_site, .nom_site');
    const url_site = val('input[name="url_site"]')
      || (document.querySelector('.contenu_url_site a, .url_site a')?.href ?? '');

    // ── Sección / Rubrique ────────────────────────────────────────────────────
    const sectionEl    = document.querySelector('select[name="id_parent"]');
    const sectionId    = sectionEl ? sectionEl.value : '';
    const sectionLabel = sectionEl
      ? (sectionEl.options[sectionEl.selectedIndex]?.text ?? '').trim()
      : text('.breadcrumb a:last-child, .rubriques a:last-child, #rubriques a');

    // ── Estado ────────────────────────────────────────────────────────────────
    const statusLabel = text('.statut-label');

    // ── Fecha ─────────────────────────────────────────────────────────────────
    // SPIP muestra la fecha en un <span class="affiche"> cuando el form no está abierto
    const dateDisplay = text('.formulaire_dater .affiche');
    // También intentar leer los campos del formulario si están abiertos
    const dateDay  = val('input[name="date_day"]')    || val('select[name="date_day"]');
    const dateMon  = val('select[name="date_month"]') || val('input[name="date_month"]');
    const dateYear = val('input[name="date_year"]')   || val('select[name="date_year"]');
    const dateIso  = dateYear && dateMon && dateDay
      ? `${dateYear}-${dateMon.padStart(2,'0')}-${dateDay.padStart(2,'0')}`
      : '';

    // ── Autor ─────────────────────────────────────────────────────────────────
    const auteurEl = document.querySelector('#auteurs a, .auteurs a, .auteur a');
    const auteur   = auteurEl ? auteurEl.textContent.trim() : '';

    // ── Idioma ────────────────────────────────────────────────────────────────
    const langEl  = document.querySelector('select[name="changer_lang"]');
    const langVal = langEl ? langEl.value : '';
    const lang    = langVal && langVal !== 'herit' ? langVal.toUpperCase() : 'ES';

    // ── Mots-clés ─────────────────────────────────────────────────────────────
    const topicsEls = document.querySelectorAll('.mots a, .keywords a');
    const topics = Array.from(topicsEls).map(el => el.textContent.trim()).filter(Boolean);

    // ── Diagnóstico: campos de formulario visibles ────────────────────────────
    const allFields = Array.from(document.querySelectorAll(
      'input[name]:not([type="hidden"]):not([type="submit"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea[name]'
    )).map(el => ({
      name:  el.name,
      tag:   el.tagName.toLowerCase(),
      value: (el.value || '').slice(0, 100),
    }));

    return {
      titre, surtitre, soustitre,
      texte, descriptif, chapo, ps,
      nom_site, url_site,
      sectionId, sectionLabel, statusLabel,
      date: { iso: dateIso, display: dateDisplay },
      auteur, lang, topics,
      allFields,
    };
  });

  process.stdout.write(JSON.stringify(data, null, 2) + '\n');

}, { targetUrl, expectedUrlIncludes: 'exec=article' });
