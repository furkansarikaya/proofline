// @ts-check
// Helpers of tests/core/risk-s2.test.mjs (risk-test.sh scenarios sc_frozen .. sc_gate_deps, lines 517-996). Only what harness.mjs does not have: the
// shell suite's own helpers (snap/pv/has/hasnt, rrun, frozen, implement) and a sed for the config edits.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, approveAsUser, commitAll, git, must, project, rv, solo } from '../lib/harness.mjs';

/** @typedef {import('../lib/harness.mjs').Result} Result */

export const RUN = '.agents/runs/LC';
/** @param {string} d @param {string} f */
export const rd = (d, f) => readFileSync(path.join(d, f), 'utf8');
/** write a file (the folder is made). @param {string} d @param {string} f @param {string} t */
export const wr = (d, f, t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };
/** append to a file. @param {string} d @param {string} f @param {string} t */
export const ap = (d, f, t) => appendFileSync(path.join(d, f), t);

/** `A` as the shell library has it: a freeze or refreeze binds the QA plan first. @param {string} d @param {string[]} args @param {Parameters<typeof A>[2]} [o] */
export const Af = (d, args, o) => A(d, args, { ...o, bind: true });

/** `sed 's/RE/TO/'` over every line of a text (the patterns are anchored line patterns). @param {string} text @param {RegExp} re @param {string} to */
export function sed(text, re, to) { return text.replace(new RegExp(re.source, `${re.flags.replace(/[gm]/g, '')}gm`), () => to); }
/** sed in place on a project file; returns the new text. @param {string} d @param {string} f @param {RegExp} re @param {string} to */
export function sedFile(d, f, re, to) { const t = sed(rd(d, f), re, to); wr(d, f, t); return t; }

/** run_id snapshot: one `pipeline` per state. @param {string} d */
export const snap = (d) => A(d, ['pipeline', 'LC']).out;
/** `pv KEY` of a snapshot (first line `KEY=value`). @param {string} po @param {string} key */
export function pv(po, key) { for (const l of po.split('\n')) if (l.startsWith(`${key}=`)) return l.slice(key.length + 1); return ''; }
/** @param {string} po @param {string} s */
export function has(po, s) {
  assert.ok(po.includes(s), `pipeline lacks '${s}': ${po.split('\n').filter((l) => /^(signal|missing_flag|focus|gates)/.test(l)).join(';')}`);
}
/** @param {string} po @param {string} s */
export function hasnt(po, s) { assert.ok(!po.includes(s), `pipeline has '${s}'`); }
/** The pipeline value of focus/gate after one fresh snapshot. @param {string} d @param {string} key */
export const stOf = (d, key) => pv(snap(d), key);

/**
 * The harness fixture installs the Node core in .agents/core4a and a prologue that sends only the verbs it lists there; every other verb (pipeline, tier, next,
 * verify-freeze, config-check, fingerprint ...) would fall to the SHELL arm of agent.sh, because agent.sh finds no `core/` folder beside itself. A real install
 * has that folder, and then every verb execs the Node core. This makes the fixture the live path: `.agents/scripts/core` -> the core (excluded from git).
 * @param {string} d
 */
export function live(d) {
  const link = path.join(d, '.agents/scripts/core');
  if (!existsSync(link)) symlinkSync('../core4a/core', link);
  const ex = path.join(d, '.git/info/exclude');
  if (!readFileSync(ex, 'utf8').split('\n').includes('.agents/scripts/core')) appendFileSync(ex, '.agents/scripts/core\n');
  return d;
}
/** A scaffolded standalone run on the live path. @param {Parameters<typeof project>[0]} o */
export const proj = (o) => live(project({ topology: 'standalone', layout: 'no', autonomy: 'manual', ...o }));

/**
 * rrun CLASS "NEW-PATH...": an unfrozen standalone run (manual autonomy) whose scope adds new paths; the optional text is appended to PLAN.md.
 * @param {string} cls @param {string} newPaths @param {string} [body]
 */
export function rrun(cls, newPaths, body) {
  const d = proj({ cls });
  const out = ['---', 'scope:', '  - path: impl.txt', '    criteria: [AC-1]', '  - path: impl_test.txt', '    criteria: [AC-1]'];
  for (const p of newPaths.split(/\s+/).filter(Boolean)) out.push(`  - path: ${p}`, '    new: true', '    criteria: [AC-1]', '    tdd_exemption: "static artifact with no executable behavior; the risk focus checks it"');
  out.push('---', '# Plan', '', '## Assumptions', 'none', '', '## Architecture', 'one storage map; no new module');
  if (body) out.push(body);
  wr(d, `${RUN}/PLAN.md`, `${out.join('\n')}\n`);
  return d;
}

/** `approve_as_user KIND TEXT`: request, the user's message captured after it (the core refuses a capture stamped ahead of the clock), approve. @param {string} d @param {string} kind @param {string} text */
export const appr = approveAsUser;

/** frozen: approve when supervised (COMPLEX, CRITICAL), freeze, IMPLEMENTING. @param {string} d */
export function frozen(d) {
  if (['COMPLEX', 'CRITICAL'].includes(rv(d, 'pipeline', 'classification'))) appr(d, 'plan', 'approve the plan');
  must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
}
/** implement FILE CONTENT: RED/GREEN by the lead (standalone) with FILE created at GREEN; then IMPLEMENTED. @param {string} d @param {string} file @param {string} content */
export function implement(d, file, content) {
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  wr(d, file, `${content}\n`);
  solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value', `impl.txt,impl_test.txt,${file}`);
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
}
/** Point repository.base_sha of the run at a commit (the run's base). @param {string} d @param {string} sha */
export function setBase(d, sha) { sedFile(d, `${RUN}/RUN.yaml`, /^ {2}base_sha:.*/, `  base_sha: "${sha}"`); }
/** `git add -A; git commit` and the new HEAD. @param {string} d @param {string} msg */
export function commitHead(d, msg) { commitAll(d, msg); return git(d, ['rev-parse', 'HEAD']); }
/** classify STANDARD review, freeze, IMPLEMENTING (an unsupervised class). @param {string} d */
export function freezeStandard(d) {
  must(d, ['classify', 'LC', 'STANDARD', 'review']); must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
}
/** The trimmed stdout of `tier`. @param {string} d */
export function tierOf(d) { const r = A(d, ['tier', 'LC']); assert.equal(r.status, 0, `tier failed: ${r.text}`); return r.out.replace(/\n+$/, ''); }
