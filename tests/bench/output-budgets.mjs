// @ts-check
// Output budgets (ADR 0001 section 8.3): the named maximum number of stdout bytes of a command on a benchmark fixture, kept in output-budgets.tsv.
// tests/bench/agent-procs.mjs --compare checks every measured command against it, and output-budgets.test.mjs checks the same on a live run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUDGET_FILE = join(import.meta.dirname, 'output-budgets.tsv');
export const CLASSES = Object.freeze(['HOT', 'STEP']);

/** @typedef {{ klass: string, command: string, fixture: string, max: number }} Budget */

/** Parse the table: `class<TAB>command<TAB>fixture<TAB>max_stdout_bytes`, `#` lines and blank lines ignored. Throws on a malformed row. @returns {Budget[]} */
export function loadBudgets(/** @type {string} */ file = BUDGET_FILE) {
  /** @type {Budget[]} */ const rows = []; const seen = new Set();
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line || line.startsWith('#')) return;
    const f = line.split('\t');
    if (f.length !== 4) throw new Error(`${file}:${i + 1}: expected 4 tab-separated fields, got ${f.length}`);
    const [klass, command, fixture, n] = f;
    if (!CLASSES.includes(klass)) throw new Error(`${file}:${i + 1}: unknown class ${klass}`);
    if (!/^[0-9]+$/.test(n)) throw new Error(`${file}:${i + 1}: the maximum must be a number of bytes: ${n}`);
    if (seen.has(`${command}\t${fixture}`)) throw new Error(`${file}:${i + 1}: ${command} on ${fixture} appears twice`);
    seen.add(`${command}\t${fixture}`);
    rows.push({ klass, command, fixture, max: Number(n) });
  });
  return rows;
}

/**
 * The commands of a measurement (fixture -> command -> { stdout_bytes }) that print more than their budget. A budget row of a command that was
 * not measured (a partial run) is not judged. @returns {string[]} one message per excess
 */
export function checkBudgets(/** @type {Record<string, Record<string, { stdout_bytes: number }>>} */ fixtures, /** @type {Budget[]} */ budgets) {
  /** @type {string[]} */ const over = [];
  for (const b of budgets) {
    const m = fixtures[b.fixture]?.[b.command];
    if (m && m.stdout_bytes > b.max) over.push(`${b.klass} ${b.command} on ${b.fixture}: ${m.stdout_bytes} stdout bytes, budget ${b.max}`);
  }
  return over;
}
