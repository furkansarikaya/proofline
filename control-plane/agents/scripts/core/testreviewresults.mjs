// @ts-check
// The mutation results of the tests review (A359, issue 338 C1), kept by the CONTROL PLANE so that a result survives from round to round but is never a file an agent can write.
//   agent.sh build-record <ID> mutant-known <file> <mutant-id>      KNOWN killed|survived <unit> | NEW   (any role; read only)
//   agent.sh build-record <ID> mutant-record <file> <mutant-id> killed|survived [--unit U] [--class base|new]   (the reviewer only)
//   agent.sh build-record <ID> mutant-summary                        per unit what ran, and the ADEQUACY line (any role; read only)
// A record is a row of the run's SEALED ledger (event `mutant-result`, role as the control plane saw it); a plain file is never read. The KEY of a result is the sha256 of
//   (the product file's bytes, EVERY file the task owns, product and test, as `path|fingerprint` lines): changing the product file or any owned file of the task (a helper the test also runs, weakening or adding the killing test) is
// a new key (conservative: a test that exercises another file of a multi-file unit is covered too), so a recorded kill is never trusted for different code or different tests, and a survivor is re-evaluated once the tests changed. A row counts only with role reviewer.
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';
import { taskOwnedPaths, testReviewClock, testReviewMinutesCap } from './gates.mjs';
import { now } from './clock.mjs';
import { securityGlobOf, securityGlobs } from './testreview.mjs';
import { sha256, sha256File } from './hash.mjs';
import { led } from './lifeutil.mjs';
import { gatesEnforced, ledgerRows } from './records.mjs';
import { runDir } from './runs.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const NAME = /^[A-Za-z0-9_.:/@#+-]{1,100}$/;

/** The key of a result for a source file now: its bytes and the task's test files. @param {Context} ctx @param {string} id @param {string} file repository-relative */
export function mutantKey(ctx, id, file) {
  if (file === '' || path.isAbsolute(file) || file.split('/').includes('..') || !NAME.test(file)) fail(`mutant: ${file === '' ? 'a source file' : file} must be a path inside the repository (letters, digits and . _ : / @ # + -)`);
  const full = `${ctx.root}/${file}`;
  let st;
  try { st = lstatSync(full); } catch { fail(`mutant: ${file} does not exist`); }
  if (!st.isFile()) fail(`mutant: ${file} is not a regular file (a link or a folder is not a unit's source)`);
  const dir = runDir(ctx, id);
  const tests = taskOwnedPaths(ctx, dir).map(([p, h]) => `${p}|${h}`).sort().join('\n');
  return sha256(`${sha256File(full)}\n${tests}`).slice(0, 32);
}

/** @param {Context} ctx @param {string} id @returns {Array<{ key: string, id: string, unit: string, result: string, cls: string }>} */
function results(ctx, id) {
  /** @type {Array<{ key: string, id: string, unit: string, result: string, cls: string }>} */ const out = [];
  for (const r of ledgerRows(ctx, runDir(ctx, id), 'mutant-result')) {
    if (r.role !== 'reviewer') continue;
    const m = /^key=([0-9a-f]{32}) id=(\S+) unit=(\S+) result=(killed|survived) class=(base|new)$/.exec(r.detail);
    if (m) out.push({ key: m[1], id: m[2], unit: m[3], result: m[4], cls: m[5] });
  }
  return out;
}

/**
 * The lines of the summary. A379: the units with a result on a security-relevant file (its key is in SECURITY) come first, marked `(security-relevant)`; byte order inside each group.
 * @param {Array<{ unit: string, result: string, cls: string, key?: string }>} rows @param {Set<string>} [security] the current keys of the task's security-relevant files
 */
export function summarize(rows, security = new Set()) {
  /** @type {Map<string, { killed: number, survived: number, newClass: number, sec: boolean }>} */ const units = new Map();
  for (const r of rows) {
    const u = units.get(r.unit) ?? { killed: 0, survived: 0, newClass: 0, sec: false };
    if (r.result === 'survived') u.survived++; else u.killed++;
    if (r.cls === 'new') u.newClass++;
    if (r.key !== undefined && security.has(r.key)) u.sec = true;
    units.set(r.unit, u);
  }
  const get = (/** @type {string} */ n) => /** @type {{ killed: number, survived: number, newClass: number, sec: boolean }} */ (units.get(n));
  const sorted = [...units.keys()].sort();
  const names = [...sorted.filter((n) => get(n).sec), ...sorted.filter((n) => !get(n).sec)];
  const lines = names.map((n) => { const u = get(n); return `unit ${n}${u.sec ? ' (security-relevant)' : ''}: ${u.killed + u.survived} run, ${u.killed} killed, ${u.survived} survived${u.newClass ? `, ${u.newClass} of class new` : ''}`; });
  const open = names.filter((n) => get(n).survived > 0);
  const closed = names.filter((n) => get(n).survived === 0);
  const nw = rows.filter((r) => r.cls === 'new' && r.result === 'survived').length;
  lines.push(`ADEQUACY: ${closed.length} unit(s) closed${closed.length ? ` (${closed.join(', ')})` : ''}; ${open.length} with survivors${open.length ? ` (${open.join(', ')})` : ''}; ${nw} survivor(s) found by widening the mutant set, labelled \`new class\`, not new findings`);
  return lines;
}

/**
 * The TIME line of the summary (A379): the minutes of the loop by the control plane's clock, against the minutes cap. @param {Context} ctx @param {string} dir @param {number} nowEpoch
 */
export function timeLine(ctx, dir, nowEpoch) {
  const c = testReviewClock(ctx, dir, nowEpoch); const cap = testReviewMinutesCap(ctx, dir);
  if (c.start === null) return `TIME: not recorded (no test review dispatch or mutant result is in the ledger since the last reopen or REVIEW_TESTS pass; the minutes cap of ${cap} is not counted and the round cap still holds)`;
  const m = Math.floor(c.seconds / 60);
  return `TIME: ${m} of ${cap} minutes since the first test review dispatch of this loop (ledger row ${c.seq})${m >= cap ? '; the minutes cap is used: start no more mutants, a failing REVIEW_TESTS stops the loop' : ''}`;
}

/** The current keys of the task's security-relevant owned files (A379). @param {Context} ctx @param {string} id */
function securityKeys(ctx, id) {
  const globs = securityGlobs(ctx);
  /** @type {Set<string>} */ const out = new Set();
  for (const [p] of taskOwnedPaths(ctx, runDir(ctx, id))) {
    if (securityGlobOf(p, globs) === '') continue;
    try { out.add(mutantKey(ctx, id, p)); } catch { /* a removed or odd path has no key: nothing to order by */ }
  }
  return out;
}

/** `build-record ID mutant-known|mutant-record|mutant-summary ...` @param {Context} ctx @param {string} id @param {string} op @param {string[]} args @returns {number} */
export function mutantCommand(ctx, id, op, args) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) fail(`${op} needs the lifecycle_gates policy (the results are rows of the sealed ledger)`);
  if (op === 'mutant-summary') {
    if (args.length !== 0) fail('usage: agent.sh build-record <ID> mutant-summary');
    // each (unit, mutant) counts once, by its latest row: a mutant re-run after a change of the code or the tests replaces the older result
    /** @type {Map<string, { unit: string, result: string, cls: string, key: string }>} */ const latest = new Map();
    for (const r of results(ctx, id)) latest.set(`${r.unit}/${r.id}`, r);
    for (const l of summarize([...latest.values()], securityKeys(ctx, id))) ctx.out(`${l}\n`);
    ctx.out(`${timeLine(ctx, dir, now().epoch)}\n`);
    return 0;
  }
  if (op === 'mutant-known') {
    if (args.length !== 2) fail('usage: agent.sh build-record <ID> mutant-known <file> <mutant-id>');
    const key = mutantKey(ctx, id, args[0]);
    const have = results(ctx, id).filter((r) => r.key === key && r.id === args[1]).pop();
    ctx.out(have ? `KNOWN ${have.result} ${have.unit}: this product file and these tests already ran this mutant, run nothing and spend no budget\n` : 'NEW\n');
    return 0;
  }
  // mutant-record
  if (ctx.role !== 'reviewer') fail(`mutant-record is the reviewer's (the role of REVIEW_TESTS); this is ${ctx.role}`);
  const pos = []; let unit = '-'; let cls = 'base';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--unit') unit = args[++i] ?? ''; else if (args[i] === '--class') cls = args[++i] ?? ''; else pos.push(args[i]);
  }
  if (pos.length !== 3 || !['killed', 'survived'].includes(pos[2]) || !['base', 'new'].includes(cls) || !NAME.test(pos[1]) || !(unit === '-' || NAME.test(unit))) fail('usage: agent.sh build-record <ID> mutant-record <file> <mutant-id> killed|survived [--unit U] [--class base|new]');
  const key = mutantKey(ctx, id, pos[0]);
  led(ctx, id, 'mutant-result', '-', '-', `key=${key} id=${pos[1]} unit=${unit} result=${pos[2]} class=${cls}`);
  ctx.out(`recorded ${pos[2]} ${pos[1]} (unit ${unit})\n`);
  return 0;
}
