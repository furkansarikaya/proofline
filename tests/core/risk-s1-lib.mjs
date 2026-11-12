// @ts-check
// Helpers of tests/core/risk-s1.test.mjs (risk-test.sh lines 1-516: the shell helpers snap/has/rrun/frozen/implement/uns_*/ue_*). Only what harness.mjs does not have.
//
// The capability probes (A102, A214) read the PATH of the process. The shell suite ran with a PATH that holds every tool of the host except the browsers, so no
// browser of the test machine leaks in; a scenario plants one in the probe folder. The same is done here, deterministically: at import the PATH of this test
// process is replaced by a folder of symlinks to every executable of the old PATH (first one wins, as the shell loop did) minus the Chromium-family names.
// Every child of the harness (cleanEnv reads process.env.PATH) then runs with that PATH. The standard macOS application folders cannot be hidden: a scenario that
// needs "no browser" is skipped on a host that has one there (HOST_BROWSER), with the reason stated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, AS, accepted, approveAsUser, base, cleanEnv, git, gpass, must, pipe, project, rv, scripts, solo, tmp } from '../lib/harness.mjs';

/** @typedef {import('../lib/harness.mjs').Result} Result */

export const RUN = '.agents/runs/LC';
export const repoRoot = path.resolve(scripts, '..', '..', '..');
/** The skill sources (`$tl_agents/../../skills`), or '' when absent. */
export const SKD = existsSync(path.join(repoRoot, 'skills')) ? path.join(repoRoot, 'skills') : '';

const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge', 'microsoft-edge-stable', 'msedge', 'brave-browser'];
export const HOST_BROWSER = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser']
  .some((a) => { try { return (statSync(`/Applications/${a}`).mode & 0o111) !== 0; } catch { return false; } });
// Windows (A263): the scenarios run. `probeVisual` looks for the extension-less names (chrome, google-chrome ...) and the hosted runner's browsers are chrome.exe/msedge.exe, so "no browser" holds there.
/** The `skip` option of a scenario that needs "no browser" (the probe cannot hide the application folder, A214). */
export const NO_BROWSER_SKIP = HOST_BROWSER ? 'a browser is installed in the application folder of this host (the probe cannot be hidden from it, A214)' : false;

/** The probe folder: symlinks to every executable of the PATH the process started with, minus the browsers. */
function buildProbeBin() {
  const dir = path.join(base(), 'probe', 'bin');
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') return dir;
  for (const d of (process.env.PATH ?? '').split(':')) {
    let names;
    try { names = readdirSync(d).sort(); } catch { continue; }
    for (const n of names) {
      if (BROWSER_NAMES.includes(n)) continue;
      const f = path.join(d, n);
      try { if ((statSync(f).mode & 0o111) === 0 || statSync(f).isDirectory()) continue; } catch { continue; }
      if (existsSync(path.join(dir, n))) continue;
      try { symlinkSync(f, path.join(dir, n)); } catch { /* the first one wins */ }
    }
  }
  return dir;
}
export const probeBin = buildProbeBin();
// Windows (A263): the links cannot be made (the list is `;`-separated and `mklink` needs a privilege), so the probe folder is an empty first PATH entry and the rest of the PATH stays
process.env.PATH = process.platform === 'win32' ? `${probeBin}${path.delimiter}${process.env.PATH ?? ''}` : probeBin;

// ---- the shell helpers ---------------------------------------------------------------------------------------------------------------------
/** A with the QA plan bound before a freeze (the `A` of the shell library). @param {string} d @param {string[]} args @param {{ role?: string, input?: string, env?: Record<string, string> }} [o] */
export const Z = (d, args, o = {}) => A(d, args, { ...o, bind: true });

/** `snap`: one `pipeline` per state. @param {string} d */
export const snap = (d) => A(d, ['pipeline', 'LC']).out;
/** `pv`: a `key=value` line of the snapshot. @param {string} po @param {string} key */
export function pv(po, key) { const m = new RegExp(`^${key.replace(/[.]/g, '\\.')}=(.*)$`, 'm').exec(po); return m ? m[1] : ''; }
/** @param {string} po @param {string} s */
export function has(po, s) { assert.ok(po.includes(s), `pipeline lacks '${s}': ${po.split('\n').filter((l) => /^(signal|missing_flag|focus|gates)/.test(l)).join(';')}`); }
/** @param {string} po @param {string} s */
export function hasnt(po, s) { assert.ok(!po.includes(s), `pipeline has '${s}'`); }
/** @param {string} d @param {string} g */
export const gateSt = (d, g) => pipe(d, `gate.${g}`);
/** @param {string} d @param {string} g @param {string} f */
export const focusSt = (d, g, f) => pipe(d, `focus.${g}.${f}`);

/** A file of the project. @param {string} d @param {string} f */
export const rd = (d, f) => readFileSync(path.join(d, f), 'utf8');
/** Write a file of the project, parents made. @param {string} d @param {string} f @param {string} t */
export function wr(d, f, t) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); }
/** A scratch file outside the project. @param {string} name @param {string} text */
export function scratch(name, text) { const f = path.join(tmp('s'), name); writeFileSync(f, text); return f; }
/** `$(printf '%s\n' LINES...)`: the lines joined, the trailing newline gone. @param {string[]} l */
export const lines = (...l) => l.join('\n');
/** The newest gate record of a gate (`ls gates/*-GATE.yaml | tail -1`): path in the project. @param {string} d @param {string} gate */
export function lastGate(d, gate) {
  const dir = path.join(d, RUN, 'gates');
  const n = readdirSync(dir).filter((x) => x.endsWith(`-${gate}.yaml`)).sort();
  assert.ok(n.length > 0, `no gate record for ${gate}`);
  return path.join(dir, /** @type {string} */ (n.at(-1)));
}
/** The newest file of a folder with a name suffix (`ls dir/*-suffix | tail -1`). @param {string} d @param {string} rel @param {string} suffix */
export function lastFile(d, rel, suffix) {
  const dir = path.join(d, rel);
  const n = readdirSync(dir).filter((x) => x.endsWith(suffix)).sort();
  assert.ok(n.length > 0, `no ${suffix} in ${rel}`);
  return path.join(dir, /** @type {string} */ (n.at(-1)));
}
/** sed on the run's RUN.yaml base_sha: the run's base is the current HEAD. @param {string} d */
export function rebase(d) {
  const f = path.join(d, RUN, 'RUN.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^ {2}base_sha:.*$/m, `  base_sha: "${git(d, ['rev-parse', 'HEAD'])}"`));
}

/**
 * `rrun CLASS "NEW-PATH..." [PLAN-BODY]`: an unfrozen standalone run whose scope adds new paths. @param {string} cls @param {string} newPaths @param {string} [body]
 * @returns {string} the project
 */
export function rrun(cls, newPaths, body) {
  const d = project({ topology: 'standalone', layout: 'no', cls, autonomy: 'manual' });
  const out = ['---', 'scope:', '  - path: impl.txt', '    criteria: [AC-1]', '  - path: impl_test.txt', '    criteria: [AC-1]'];
  for (const p of newPaths.split(/\s+/).filter(Boolean)) out.push(`  - path: ${p}`, '    new: true', '    criteria: [AC-1]', '    tdd_exemption: "static artifact with no executable behavior; the risk focus checks it"');
  out.push('---', '# Plan', '', '## Assumptions', 'none', '', '## Architecture', 'one storage map; no new module');
  if (body) out.push(body);
  writeFileSync(path.join(d, RUN, 'PLAN.md'), `${out.join('\n')}\n`);
  installCore(d);   // the project is an installed one: every command runs in the Node core, the live path (the shell arm of agent.sh is not what ships)
  return d;
}
/** The user's approval as the shell `approve_as_user`: request, the user's message (harness `say`, stamped after every record of the project), approve. @param {string} d @param {string} kind @param {string} text */
export function approve(d, kind, text) { approveAsUser(d, kind, text); }
/** `frozen`: approve when supervised, freeze, IMPLEMENTING. @param {string} d */
export function frozen(d) {
  if (['COMPLEX', 'CRITICAL'].includes(rv(d, 'pipeline', 'classification'))) approve(d, 'plan', 'approve the plan');
  accepted(Z(d, ['freeze', 'LC']), 'freeze'); accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'handoff IMPLEMENTING');
}
/** `implement FILE CONTENT`: RED/GREEN by the lead (standalone) with FILE created at GREEN; then IMPLEMENTED. @param {string} d @param {string} file @param {string} content */
export function implement(d, file, content) {
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  wr(d, file, `${content}\n`);
  solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value', `impl.txt,impl_test.txt,${file}`);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'handoff IMPLEMENTED');
}
/** `pass_all >/dev/null 2>&1 || true`: every step is tried, a refusal does not stop the rest (errexit is off in that context). @param {string} d */
export function passAllLoose(d) {
  const t = (/** @type {() => unknown} */ f) => { try { f(); } catch { /* tolerated, as the shell did */ } };
  for (const g of pipe(d, 'gates').split(/\s+/).filter(Boolean)) {
    if (g === 'VERIFY') continue;
    if (g === 'SECRETS') t(() => must(d, ['secret-scan', 'LC'])); else t(() => gpass(d, g));
  }
  for (const m of A(d, ['pipeline', 'LC']).out.matchAll(/^focus\.([A-Z_]*)\.([a-z]*)=.*$/gm)) t(() => gpass(d, m[1], { focus: m[2] }));
  t(() => gpass(d, 'VERIFY'));
}

/** `risk_report`. @param {string} f */
export const riskReport = (f) => /** @type {Record<string, string>} */ ({
  contract: 'reviews/contract-proof/REPORT.md', concurrency: 'reviews/concurrency-proof/REPORT.md', performance: 'reviews/performance-proof/REPORT.md', config: 'reviews/proof-review/config/REPORT.md',
  migration: 'reviews/data-migration/REPORT.md', visual: 'reviews/visual-proof/REPORT.md', dependencies: 'security/dependencies/REPORT.md', logging: 'security/logging/REPORT.md',
})[f] ?? '';

// ---- UNSUPPORTED helpers -------------------------------------------------------------------------------------------------------------------
/** `uns_report [RESULT]`: the report and validate-visual.mjs output. @param {string} d @param {string} [result] */
export function unsReport(d, result = 'UNSUPPORTED') {
  wr(d, `${RUN}/reviews/visual-proof/REPORT.md`, '# visual\n\nNo headless browser in the project.\n');
  wr(d, `${RUN}/reviews/visual-proof/validator.txt`, `RESULT: ${result}\nSUMMARY: no browser tooling\n`);
}
/** `uns_visual REASON`: the qa visual focus submits UNSUPPORTED (an INCONCLUSIVE reason gets INCONCLUSIVE evidence). @param {string} d @param {string} reason */
export function unsVisual(d, reason) {
  if (reason.includes('INCONCLUSIVE:')) unsReport(d, 'INCONCLUSIVE'); else unsReport(d);
  return AS(d, 'qa', ['submit', 'LC', '--focus', 'visual', '--result', 'UNSUPPORTED', '--reason', reason, '--confidence', 'high', '--artifact', 'reviews/visual-proof/REPORT.md', '--evidence', 'reviews/visual-proof/validator.txt']);
}
/** `uns_run [CONFIG-SED]`: a COMPLEX UI run with every other focus passing, frozen under the (edited) config. @param {(cfg: string) => string} [edit] @returns {string} */
export function unsRun(edit) {
  const d = rrun('COMPLEX', 'web/index.html', lines('', '## UI', '', 'one status badge', 'visual_writes: DB_PATH=:memory:'));
  if (edit) {   // the project's own config, committed at the run's base
    const f = path.join(d, '.agents/config.yaml');
    writeFileSync(f, edit(readFileSync(f, 'utf8')));
    git(d, ['add', '.agents/config.yaml']); git(d, ['commit', '-q', '-m', 'project config']);
    rebase(d);
  }
  frozen(d); implement(d, 'web/index.html', '<main></main>');
  passAllLoose(d);
  return d;
}

/** `ue_submit FOCUS EVIDENCE`: a reviewer UNSUPPORTED submission citing EVIDENCE. @param {string} d @param {string} focus @param {string} evidence */
export function ueSubmit(d, focus, evidence) {
  return AS(d, 'reviewer', ['submit', 'LC', '--focus', focus, '--result', 'UNSUPPORTED', '--reason', 'no machine-readable contract or temp-db capability in the project', '--confidence', 'low', '--artifact', riskReport(focus), '--evidence', evidence]);
}
/** `ue_run SCOPE-PATH CONTENT PLAN-LINES`: a frozen COMPLEX run with that change, every gate's own focus passing. @param {string} p @param {string} content @param {string} planLines @returns {string} */
export function ueRun(p, content, planLines) {
  const d = rrun('COMPLEX', p, planLines); frozen(d); implement(d, p, content); passAllLoose(d);
  return d;
}
/** A skill script run in the project (node SCRIPT ARGS), stdout returned; it must succeed (the shell ran under `set -e`). @param {string} d @param {string[]} args */
export function node(d, args) {
  const r = spawnSync('node', args, { cwd: d, env: cleanEnv({}), encoding: 'utf8' });
  assert.equal(r.status, 0, `node ${args.join(' ')} failed (${r.status}): ${r.stdout}${r.stderr}`);
  return r.stdout;
}
/** `install_core`: a real `proofline upgrade` installs the Node core with the manifest. @param {string} d */
export function installCore(d) {
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(d, '.agents/scripts/proofline-core.mjs'));
  rmSync(path.join(d, '.agents/scripts/core'), { recursive: true, force: true });
  cpSync(path.join(scripts, 'core'), path.join(d, '.agents/scripts/core'), { recursive: true });
}
/** `ue_move N`: an upgrade-style control-plane commit, then an accepted freshness check (records base-moved). @param {string} d @param {number} n */
export function ueMove(d, n) {
  wr(d, '.claude/agents/proofline-x.md', `agent ${n}\n`); wr(d, '.agents/.proofline-manifest', `# version: 0.0.${n}\n`); installCore(d);
  git(d, ['add', '.claude']); git(d, ['add', '-f', '.agents/.proofline-manifest']); git(d, ['commit', '-q', '-m', `chore: upgrade ${n}`]);
  const r = A(d, ['freshness', 'LC']);
  assert.equal(r.status, 0, `a control-plane-only commit staled the plan: ${r.text.trim().split('\n').pop()}`);
}
