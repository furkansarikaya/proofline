// @ts-check
// Helpers of tests/core/lifecycle-s3.test.mjs (lifecycle-test.sh scenarios scenario_fingerprint_excludes_agents .. scenario_completion_response).
// Only what harness.mjs does not have.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, accepted, approveAsUser, cached, codeKey, copyOf, git, gfail, gpass, scaffold, scripts, sha256, toCodeDone, worker } from '../lib/harness.mjs';

/** @typedef {import('../lib/harness.mjs').Result} Result */

export const ST = 'stale plan: repository.base_sha changed';
export const BLK = '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n';

/** File names in a project folder (empty when it does not exist). @param {string} dir @param {string} rel */
export function lsDir(dir, rel) { const p = path.join(dir, rel); return existsSync(p) ? readdirSync(p).sort() : []; }
/** Write a project file. @param {string} d @param {string} f @param {string} t */
export const wr = (d, f, t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };
/** @param {string} d @param {string} f @param {string} t */
export const ap = (d, f, t) => appendFileSync(path.join(d, f), t);
/** @param {string} d @param {string} f */
export const rd = (d, f) => readFileSync(path.join(d, f), 'utf8');
/** `sed 's/^FROM$/TO/'` on a project file. @param {string} d @param {string} f @param {string} from @param {string} to */
export function swapLine(d, f, from, to) { wr(d, f, rd(d, f).split('\n').map((l) => (l === from ? to : l)).join('\n')); }

/** `A fingerprint LC`, as the shell `$(...)` captured it. @param {string} d @param {Record<string, string>} [env] */
export function fp(d, env) { const r = A(d, ['fingerprint', 'LC'], env ? { env } : {}); if (r.status !== 0) throw new Error(`fingerprint failed: ${r.text}`); return r.out.replace(/\n+$/, ''); }
/** The `gate.` lines of `pipeline LC`. @param {string} d */
export const gateLines = (d) => A(d, ['pipeline', 'LC']).out.split('\n').filter((l) => l.startsWith('gate.'));
/** `A pipeline LC | grep '^gate\.' | grep -q '=stale'`. @param {string} d */
export const anyStale = (d) => gateLines(d).some((l) => l.includes('=stale'));
/** `A pipeline LC | grep -v '^gate\.'`. @param {string} d */
export const nonGate = (d) => A(d, ['pipeline', 'LC']).out.split('\n').filter((l) => !l.startsWith('gate.')).join('\n');
/** Number of base-moved ledger lines (`base_moves`). @param {string} d */
export const baseMoves = (d) => (rd(d, '.agents/runs/LC/LEDGER.log').match(/^.*base-moved.*$/gm) ?? []).length;

/** `ro CMD`: the command with the reason on stdin. @param {string} d @param {string[]} args @param {string} [role] */
export function ro(d, args, role) {
  return A(d, args, { input: 'reason: the budget decision was made and the verifier false alarm is fixed\n', ...(role ? { role } : {}) });
}
/** `ro_approve`: the request, the user's reply (one timestamp, after the request), the approval. @param {string} d */
export function roApprove(d) { approveAsUser(d, 'reopen:LC', 'I approve the reopen of LC'); }

/** A state built once per key and copied per test (the same mechanism as the harness's `project`). @param {string} name @param {unknown} o @param {() => string} build */
function snap(name, o, build) {
  const key = `lcs3-${name}-${codeKey()}-${sha256(JSON.stringify(o)).slice(0, 12)}`;
  return copyOf(cached(key, (work) => { const built = build(); cpSync(built, work, { recursive: true }); rmSync(built, { recursive: true, force: true }); }));
}
/** A scaffolded orchestrated run driven to CODE_DONE (`scaffold orchestrated; to_code_done orchestrated`). @param {import('../lib/harness.mjs').ScaffoldOptions} [o] */
export function codeDoneRun(o = {}) {
  return snap('codedone', o, () => { const d = scaffold({ topology: 'orchestrated', ...o }); toCodeDone(d, 'orchestrated'); return d; });
}
/** An orchestrated run driven to FAILED (`reopen_failed_run`). @param {import('../lib/harness.mjs').ScaffoldOptions} [o] */
export function reopenFailedRun(o = {}) { return snap('failed', o, () => buildFailedRun(o)); }
/** @param {import('../lib/harness.mjs').ScaffoldOptions} o */
function buildFailedRun(o) {
  const d = scaffold({ topology: 'orchestrated', testCrit: 'AC-2', taskExtra: '- AC-2: second behavior', ...o });
  const must = (/** @type {string[]} */ a) => accepted(A(d, a), a.join(' '));
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(['handoff', 'LC', 'IMPLEMENTED']); gfail(d, 'REVIEW_SMALL', 'impl_test.txt'); must(['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl_test.txt', 'test: default for an empty key'); must(['handoff', 'LC', 'IMPLEMENTED']); gfail(d, 'QA', 'impl.txt'); must(['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt'); must(['handoff', 'LC', 'IMPLEMENTED']); gpass(d, 'REVIEW_SMALL'); gpass(d, 'QA'); gfail(d, 'VERIFY', 'impl.txt');
  accepted(A(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gates/*-VERIFY.yaml fail on the third content\n' }), 'terminate FAILED');
  return d;
}

/** `upgrade_files` + `install_core`: what a real `proofline upgrade` installs outside .agents/. @param {string} d */
export function upgradeFiles(d) {
  wr(d, '.claude/agents/proofline-x.md', 'agent\n'); wr(d, '.codex/agents/proofline-x.toml', 'agent\n'); wr(d, '.claude/skills/proofline/SKILL.md', 'skill\n');
  wr(d, '.agents/.proofline-manifest', '# version: 0.0.17\n0000  .claude/skills/proofline/SKILL.md\n');
  installCore(d);
}
/** @param {string} d */
export function installCore(d) {
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(d, '.agents/scripts/proofline-core.mjs'));
  rmSync(path.join(d, '.agents/scripts/core'), { recursive: true, force: true });
  cpSync(path.join(scripts, 'core'), path.join(d, '.agents/scripts/core'), { recursive: true });
}
/** Commit an upgrade-style change: installed files, a manifest and the proofline block (`cp_commit`). @param {string} d */
export function cpCommit(d) {
  upgradeFiles(d); swapLine(d, 'AGENTS.md', 'block v1', 'block v2');
  git(d, ['add', '.claude', '.codex', 'AGENTS.md']); git(d, ['commit', '-q', '-m', 'chore: upgrade']);
}
