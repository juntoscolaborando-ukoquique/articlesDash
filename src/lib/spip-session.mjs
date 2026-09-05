/**
 * src/lib/spip-session.mjs
 *
 * Login y sesión compartida para scripts que automatizan el backend de
 * SPIP en kilombo.top vía Playwright.
 *
 * SPIP 4.4 está detrás del proxy SSO de YunoHost. Un cliente HTTP simple
 * no puede completar ese handshake, por lo que se usa un browser headless
 * real que maneja la redirección SSO + cookies automáticamente.
 *
 * Adaptado de KILOMBO-BUILD/KILOMBO/scripts/lib/spip-session.mjs.
 * Cambios respecto al original:
 *   - loadEnv() lee el .env desde la raíz del proyecto (un nivel arriba de src/)
 *   - Se eliminaron getScopedPassword() y referencias a KILO-002 (no necesarios aquí)
 *   - Comentarios actualizados al contexto de este proyecto
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const USERNAME = 'kilombo';
export const BASE_URL = 'https://www.kilombo.top';
export const DEFAULT_ENV_PATH = path.join(__dirname, '..', '..', '.env');

/**
 * Parser manual de .env (sin dependencia en dotenv).
 * Soporta valores entre comillas simples o dobles.
 *
 * @param {string} envPath - ruta absoluta al archivo .env
 * @returns {Record<string, string>}
 */
export function loadEnv(envPath = DEFAULT_ENV_PATH) {
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `No se encontró el archivo .env en: ${envPath}\n` +
        `Copia .env.example a .env y rellena KILOMBOTOP_PASSWORD.`
    );
  }

  const vars = {};
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      // Ignorar comentarios y líneas vacías
      if (!line.trim() || line.trim().startsWith('#')) return;
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) {
        let value = match[2].trim();
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }
        vars[match[1]] = value;
      }
    });
  return vars;
}

/**
 * Obtiene la contraseña de administrador de kilombo.top.
 * Usa KILOMBOTOP_PASSWORD; si no está definida o está vacía,
 * cae en KILOMBOTOP_FUTURE_PASSWORD.
 *
 * Nota: el fallback se evalúa por presencia/valor, no por resultado del login.
 * Si KILOMBOTOP_PASSWORD está definida pero es incorrecta, el login fallará
 * sin reintentar con KILOMBOTOP_FUTURE_PASSWORD. Para rotar credenciales,
 * actualizar KILOMBOTOP_PASSWORD directamente en .env.
 *
 * @param {Record<string, string>} env - resultado de loadEnv()
 * @returns {string | null}
 */
export function getPassword(env) {
  return env.KILOMBOTOP_PASSWORD || env.KILOMBOTOP_FUTURE_PASSWORD || null;
}

/**
 * Hace login en el backend de SPIP, manejando dos formas posibles:
 *   1. Formulario de login propio de SPIP (`page=login` o `exec=login`)
 *   2. Portal SSO de YunoHost (si SPIP redirige ahí primero)
 *
 * Re-navega a la URL objetivo si el login no aterrizó donde se esperaba,
 * y lanza un error claro si sigue en una página de login al final.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.password - contraseña de administrador
 * @param {string} opts.targetUrl - URL a cargar (y recargar tras login si hace falta)
 * @param {string} [opts.expectedUrlIncludes] - fragmento que debe aparecer en la
 *   URL resultante (e.g. `'exec=article_edit'`). Si no está presente tras el primer
 *   intento, re-navega a targetUrl una vez antes de rendirse.
 * @param {string} [opts.username] - por defecto USERNAME ('kilombo')
 */
export async function login(
  page,
  { password, targetUrl, expectedUrlIncludes, username = USERNAME }
) {
  console.log(`Navegando a ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  // Formulario de login nativo de SPIP
  if (page.url().includes('page=login') || page.url().includes('exec=login')) {
    console.log('Formulario de login SPIP detectado. Iniciando sesión...');
    await page.fill('input[name="login"], input[type="text"]', username);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Portal SSO de YunoHost
  if (page.url().includes('sso') || page.url().includes('portalapi')) {
    console.log('Portal SSO de YunoHost detectado. Iniciando sesión...');
    await page.fill(
      'input[type="text"], input[name="credentials"], input[name="username"], input[id="loginInput"]',
      username
    );
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"], input[type="submit"], #submit');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  console.log('URL actual tras login:', page.url());

  if (expectedUrlIncludes && !page.url().includes(expectedUrlIncludes)) {
    console.log(`No está en ${expectedUrlIncludes} todavía — re-navegando...`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  }

  if (page.url().includes('exec=login') || page.url().includes('page=login')) {
    throw new Error(
      `El login no llegó a ${expectedUrlIncludes || targetUrl} — ` +
        `quedó en ${page.url()}. ` +
        `Verificar KILOMBOTOP_PASSWORD en .env.`
    );
  }
}

export async function withSpipSession(
  fn,
  { targetUrl, expectedUrlIncludes, envPath = DEFAULT_ENV_PATH, timeout = 120000, username = USERNAME }
) {
  const env = loadEnv(envPath);
  const password = getPassword(env);

  if (!password) {
    throw new Error(
      `No se encontró contraseña en ${envPath}. ` +
        `Verificar que KILOMBOTOP_PASSWORD está definido.`
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    timeout,
  });

  try {
    const page = await browser.newPage();
    await login(page, { password, targetUrl, expectedUrlIncludes, username });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
