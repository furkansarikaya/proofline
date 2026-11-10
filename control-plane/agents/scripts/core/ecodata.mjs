// @ts-check
// The ecosystem definition as flat rows `[id, path, value]` (A245). ecosystems.json is the single source (A173); the flat tsv copy and its sh reader are
// gone, so every reader of the risky/dependency globs, the worktree dependency folders and the capability probes goes through here.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** @typedef {import('./context.mjs').Context} Context */

/** @param {unknown} v */
const scalar = (v) => v === null || typeof v !== 'object';

/**
 * The flat rows `[id, path, value]` of a parsed definition: the same walk as `flatten` of ecosystems.mjs (a test compares the two on the shipped file). It is kept
 * here, not imported, so that a project whose `.agents/ecosystems.mjs` was removed still runs every command (doctor reports the missing file).
 * @param {any} data @returns {string[][]}
 */
export function flattenDefinition(data) {
  /** @type {string[][]} */ const rows = [];
  /** @param {string} id @param {string} p @param {any} v */
  const walk = (id, p, v) => {
    if (Array.isArray(v)) {
      if (v.every(scalar)) for (const x of v) rows.push([id, p, String(x)]);
      else v.forEach((o, i) => { if (scalar(o)) throw new Error(`${id} ${p}: mixed array`); walk(id, `${p}.${i}`, o); });
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(id, p ? `${p}.${k}` : k, x);
    } else rows.push([id, p, String(v)]);
  };
  walk('*', '', Object.fromEntries(Object.entries(data.global)));
  for (const e of data.ecosystems) {
    const { id, ...rest } = e;
    rows.push([id, 'id', id]);
    walk(id, '', rest);
  }
  return rows;
}

/** @param {string} f */
function size(f) { try { return statSync(f).size; } catch { return 0; } }

/** The rows of one ecosystems.json, or null when it is missing, empty, not JSON or not a definition. @param {string} file @returns {string[][] | null} */
export function rowsOf(file) {
  if (size(file) === 0) return null;
  try { return flattenDefinition(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}

/**
 * The project's definition (`<agents>/ecosystems.json`), else the control plane's own (the folder above the scripts folder): a project without its own
 * definition, or with an unreadable one, still gets the shipped data. Null when neither is readable (a missing definition grants nothing).
 * @param {string} agents the project's .agents folder @param {string} shipped the control plane's own folder (holds ecosystems.json) @returns {string[][] | null}
 */
export function ecosystemRowsAt(agents, shipped) {
  const own = rowsOf(`${agents}/ecosystems.json`);
  if (own) return own;
  if (path.resolve(shipped) !== path.resolve(agents) && existsSync(`${shipped}/ecosystems.json`)) return rowsOf(`${shipped}/ecosystems.json`);
  return null;
}

/** The rows for this invocation. @param {Context} ctx @returns {string[][] | null} */
export function ecosystemRows(ctx) {
  return ctx.once('eco-rows', () => ecosystemRowsAt(ctx.agents, path.resolve(ctx.scriptDir, '..')));
}
