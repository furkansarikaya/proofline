// @ts-check
// The equivalence rig runner (ADR 0001 section 6): one case runs once per side from identical copies of its fixture; stdout, stderr, exit code,
// every file and its mode, and the git state are compared after the closed normalisation of normalise.mjs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baseEnv, copyTree, gitState, snapshot } from './fixture.mjs';
import { normaliseSide, rankConflicts } from './normalise.mjs';

/**
 * @typedef {{ args?: string[], role?: string, env?: Record<string,string>, stdin?: string, cwd?: string, engine?: 'sh'|'default'|'side',
 *   write?: { path: string, content: string | (() => string), mode?: number }, exec?: string[] }} Step
 * @typedef {{ name: string, fixture: import('./fixture.mjs').Fixture, steps: Step[] }} Case
 * @typedef {{ name: string, engineFor: (i: number) => 'sh'|'default' }} SideSpec
 * @typedef {{ kind: string, where: string, detail: string }} Diff
 */
export const SH_SIDE = /** @type {SideSpec} */ ({ name: 'sh', engineFor: () => 'sh' });
export const DEFAULT_SIDE = /** @type {SideSpec} */ ({ name: 'default', engineFor: () => 'default' });

/** Run a case on one side; returns the raw side (not yet normalised). */
export function runSide(/** @type {Case} */ c, /** @type {SideSpec} */ spec, /** @type {{ work?: string, timeoutMs?: number }} */ o = {}) {
  const base = o.work ?? mkdtempSync(join(tmpdir(), 'eq-work.')); const fx = join(base, 'fx'); const home = join(base, 'home'); const tmp = join(base, 'tmp');
  copyTree(c.fixture.dir, fx); for (const d of [home, tmp]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
  /** @type {import('./normalise.mjs').Output[]} */ const outputs = [];
  const t0 = Math.floor(Date.now() / 1000);
  c.steps.forEach((s, i) => {
    if (s.write) { const p = join(fx, s.write.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof s.write.content === 'function' ? s.write.content() : s.write.content); if (s.write.mode !== undefined) chmodSync(p, s.write.mode); return; }
    const eng = s.engine && s.engine !== 'side' ? s.engine : spec.engineFor(i);
    /** @type {Record<string,string>} */ const env = baseEnv(home, { TMPDIR: tmp, ...(s.role ? { AGENT_ROLE: s.role } : {}), ...(eng === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), ...(s.env ?? {}) });
    const [cmd, args] = s.exec ? [s.exec[0], s.exec.slice(1)] : ['sh', ['./.agents/scripts/agent.sh', ...(s.args ?? [])]];
    const r = spawnSync(cmd, args, { cwd: join(fx, s.cwd ?? ''), env, input: s.stdin ?? '', encoding: 'latin1', timeout: o.timeoutMs ?? 120000 });
    outputs.push({ code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') });
  });
  const t1 = Math.floor(Date.now() / 1000);
  const side = { outputs, files: snapshot(fx), window: /** @type {[number, number]} */ ([Math.min(c.fixture.builtAt, t0), t1]), tmpdir: tmp, git: gitState(fx) };
  if (!o.work) rmSync(base, { recursive: true, force: true });
  return side;
}

/** Compare two raw sides after the closed normalisation; an empty list means equivalent. @returns {Diff[]} */
export function compareSides(/** @type {import('./normalise.mjs').Side} */ a, /** @type {import('./normalise.mjs').Side} */ b, names = ['A', 'B'], opts = {}) {
  /** @type {Diff[]} */ const d = [];
  const na = normaliseSide(a, names[0], opts); const nb = normaliseSide(b, names[1], opts);
  for (const p of [...na.problems, ...nb.problems]) d.push({ kind: 'check', where: '', detail: p });
  if (na.outputs.length !== nb.outputs.length) d.push({ kind: 'steps', where: '', detail: `${na.outputs.length} outputs against ${nb.outputs.length}` });
  na.outputs.forEach((x, i) => {
    const y = nb.outputs[i]; if (!y) return;
    if (x.code !== y.code) d.push({ kind: 'exit-code', where: `step ${i}`, detail: `${x.code} against ${y.code}` });
    if (x.stdout !== y.stdout) d.push({ kind: 'stdout', where: `step ${i}`, detail: firstDiff(x.stdout, y.stdout) });
    if (x.stderr !== y.stderr) d.push({ kind: 'stderr', where: `step ${i}`, detail: firstDiff(x.stderr, y.stderr) });
  });
  for (const p of na.files.keys()) if (!nb.files.has(p)) d.push({ kind: 'missing-file', where: p, detail: `only on ${names[0]}` });
  for (const p of nb.files.keys()) if (!na.files.has(p)) d.push({ kind: 'missing-file', where: p, detail: `only on ${names[1]}` });
  for (const [p, x] of na.files) {
    const y = nb.files.get(p); if (!y) continue;
    if (x.mode !== y.mode) d.push({ kind: 'mode', where: p, detail: `${x.mode.toString(8)} against ${y.mode.toString(8)}` });
    if (!x.data.equals(y.data)) d.push({ kind: 'content', where: p, detail: firstDiff(x.data.toString('latin1'), y.data.toString('latin1')) });
  }
  if (na.git !== nb.git) d.push({ kind: 'git', where: '', detail: firstDiff(na.git ?? '', nb.git ?? '') });
  for (const m of rankConflicts(na.ranks, nb.ranks)) d.push({ kind: 'time-order', where: '', detail: m });
  return d;
}

function firstDiff(/** @type {string} */ x, /** @type {string} */ y) {
  let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const cut = (/** @type {string} */ s) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 40));
  return `first difference at byte ${i}: ${cut(x)} against ${cut(y)}`;
}

/**
 * Run a case on both sides and compare; the raw sides come back for further assertions. A scenario whose ONLY differences are the 0.0.40 shell's known
 * flakes (isShellFlake) is run once more; the checks are not loosened and a second occurrence fails.
 */
export function runPair(/** @type {Case} */ c, /** @type {[SideSpec, SideSpec]} */ sides = [SH_SIDE, DEFAULT_SIDE], /** @type {{ pendingApproval?: boolean }} */ opts = {}) {
  // both sides run at the same absolute path, so no path needs masking
  const work = mkdtempSync(join(tmpdir(), 'eq-work.'));
  try {
    const names = [sides[0].name, sides[1].name];
    let a = runSide(c, sides[0], { work }); let b = runSide(c, sides[1], { work });
    let d = compareSides(a, b, names, opts);
    if (isShellFlake(d, [a, b])) { a = runSide(c, sides[0], { work }); b = runSide(c, sides[1], { work }); d = compareSides(a, b, names, opts); } // see isShellFlake
    return { a, b, d };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Run a case on both sides and compare. */
export function runCase(/** @type {Case} */ c, /** @type {[SideSpec, SideSpec]} */ sides = [SH_SIDE, DEFAULT_SIDE], /** @type {{ pendingApproval?: boolean }} */ opts = {}) {
  return runPair(c, sides, opts).d;
}

export const formatDiffs = (/** @type {Diff[]} */ d) => d.map((x) => `${x.kind}${x.where ? ` ${x.where}` : ''}: ${x.detail}`).join('\n');

/**
 * Differences that the 0.0.40 shell can produce between two correct runs of the same scenario, none of which the closed list may hide:
 * a ledger line whose ts= and epoch= were read from `date` across a second boundary, and a `printf ... | grep -q` whose printf lost the race with grep
 * (stderr "write error: Broken pipe"). A scenario whose ONLY differences are these is run once more by its test; anything else fails at once, and
 * a second occurrence fails too. The checks themselves are not loosened.
 * @param {Diff[]} diffs
 * @param {import('./normalise.mjs').Side[]} sides the raw sides compared
 */
export function isShellFlake(diffs, sides) {
  const pipe = sides.some((s) => s.outputs.some((o) => /write error|Broken pipe/.test(o.stderr)));
  return diffs.length > 0 && diffs.every((d) =>
    (d.kind === 'check' && /ts=.* and epoch=\d+ name different seconds/.test(d.detail))
    || (d.kind === 'content' && /LEDGER\.log$/.test(d.where))
    || (d.kind === 'stderr' && pipe));
}
