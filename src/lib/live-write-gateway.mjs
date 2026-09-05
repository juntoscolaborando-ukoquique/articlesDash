/**
 * src/lib/live-write-gateway.mjs
 *
 * Punto único de control para toda acción que muta el sitio vivo en
 * www.kilombo.top. Toda escritura en SPIP DEBE pasar por guardedWrite().
 *
 * QUÉ HACE HOY (v1 — intencionalmente permisivo):
 *   - Registra cada intento en live-write-audit.log.jsonl (JSONL).
 *   - checkPolicy() es un pass-through: no bloquea nada.
 *
 * QUÉ HABILITA EN EL FUTURO sin tocar los puntos de llamada:
 *   - Confirmación humana antes de ejecutar.
 *   - Rate limiting / ventanas de cooldown.
 *   - Bloqueo por variable de entorno (e.g. READONLY_MODE=true).
 *   - Scoping de credenciales por tipo de acción.
 *
 * Adaptado de KILOMBO-BUILD/KILOMBO/scripts/lib/live-write-gateway.mjs.
 * Cambios respecto al original:
 *   - AUDIT_LOG_PATH apunta a la raíz de este proyecto.
 *   - Comentarios actualizados al contexto de este proyecto.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const AUDIT_LOG_PATH = path.join(PROJECT_ROOT, 'live-write-audit.log.jsonl');

/**
 * @typedef {Object} LiveWriteRequest
 * @property {string}   action         - Nombre de la acción, e.g. `'article.create'`
 * @property {string}   [script]       - Nombre del script invocante (se detecta automáticamente)
 * @property {Record<string, unknown>} [target] - Datos identificativos del objetivo
 *                                       (e.g. `{ id, title }` para un artículo)
 * @property {boolean}  [dryRun]       - Si es true, la ejecución es de prueba
 * @property {() => Promise<unknown>} execute - La operación real a ejecutar
 */

/**
 * Política de acceso. v1: todo permitido.
 * Este es el único lugar que hay que tocar para añadir lógica de bloqueo.
 *
 * @param {LiveWriteRequest} _req
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkPolicy(_req) {
  return { allowed: true };
}

/**
 * Añade una entrada al log de auditoría.
 * Los errores de escritura en el log nunca detienen la operación principal.
 *
 * @param {Record<string, unknown>} entry
 */
function appendAuditEntry(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error(`[live-write-gateway] no se pudo escribir en el audit log: ${err.message}`);
  }
}

/**
 * Punto único de control para toda escritura en el sitio vivo.
 * Registra el intento, verifica la política y ejecuta (o bloquea).
 *
 * @param {LiveWriteRequest} req
 * @returns {Promise<unknown>} El valor de retorno de req.execute()
 * @throws Si la política bloquea la acción, o si execute() lanza un error
 */
export async function guardedWrite(req) {
  const {
    action,
    script = path.basename(process.argv[1] || 'unknown'),
    target = {},
    dryRun = false,
    execute,
  } = req;

  if (!action) throw new Error('guardedWrite: falta el campo "action"');
  if (typeof execute !== 'function') {
    throw new Error('guardedWrite: falta la función "execute"');
  }

  const timestamp = new Date().toISOString();
  const decision = checkPolicy(req);
  const baseEntry = { timestamp, action, script, target, dryRun };

  if (!decision.allowed) {
    appendAuditEntry({ ...baseEntry, result: 'blocked', reason: decision.reason });
    throw new Error(`[live-write-gateway] bloqueado "${action}": ${decision.reason}`);
  }

  if (dryRun) {
    appendAuditEntry({ ...baseEntry, result: 'dry-run' });
    return execute();
  }

  try {
    const result = await execute();
    const resultFields =
      result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    appendAuditEntry({ ...baseEntry, result: 'success', ...resultFields });
    return result;
  } catch (err) {
    appendAuditEntry({ ...baseEntry, result: 'error', error: err.message });
    throw err;
  }
}
