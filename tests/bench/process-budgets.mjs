// @ts-check
// Process-count budgets (issue #167, C4): the most external processes (the PATH shim of agent-procs.mjs counts them: no clock is read) a command may start
// on a benchmark fixture with the default engine (the Node core where the command has moved), kept in process-budgets.tsv next to output-budgets.tsv.
// Each row is the measured count after the stage 2 move plus a margin. agent-procs.mjs --compare checks every measured command, and process-budgets.test.mjs
// checks the cheap fixtures live in the node-tests CI job.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROCESS_BUDGET_FILE = join(import.meta.dirname, 'process-budgets.tsv');

/** @typedef {{ command: string, fixture: string, max: number, measured: number }} ProcessBudget */

/** Parse `command<TAB>fixture<TAB>max_processes<TAB>measured`; `#` lines and blank lines are ignored. Throws on a malformed row. @returns {ProcessBudget[]} */
export function loadProcessBudgets(/** @type {string} */ file = PROCESS_BUDGET_FILE) {
  /** @type {ProcessBudget[]} */ const rows = []; const seen = new Set();
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line || line.startsWith('#')) return;
    const f = line.split('\t');
    if (f.length !== 4) throw new Error(`${file}:${i + 1}: expected 4 tab-separated fields, got ${f.length}`);
    const [command, fixture, max, measured] = f;
    if (!/^[0-9]+$/.test(max) || !/^[0-9]+$/.test(measured)) throw new Error(`${file}:${i + 1}: the maximum and the measured count must be numbers: ${max} ${measured}`);
    if (Number(max) < Number(measured)) throw new Error(`${file}:${i + 1}: the maximum ${max} is below the measured count ${measured}`);
    if (seen.has(`${command}\t${fixture}`)) throw new Error(`${file}:${i + 1}: ${command} on ${fixture} appears twice`);
    seen.add(`${command}\t${fixture}`);
    rows.push({ command, fixture, max: Number(max), measured: Number(measured) });
  });
  return rows;
}

/** The commands of a measurement (fixture -> command -> { execs }) that start more processes than their budget; a command that was not measured is not judged. @returns {string[]} */
export function checkProcessBudgets(/** @type {Record<string, Record<string, { execs: number }>>} */ fixtures, /** @type {ProcessBudget[]} */ budgets) {
  /** @type {string[]} */ const over = [];
  for (const b of budgets) {
    const m = fixtures[b.fixture]?.[b.command];
    if (m && m.execs > b.max) over.push(`${b.command} on ${b.fixture}: ${m.execs} processes, budget ${b.max} (measured after the move: ${b.measured})`);
  }
  return over;
}
