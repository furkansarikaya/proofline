// @ts-check
// Helpers of tests/core/gates-s5.test.mjs (the validation and evidence-gap scenarios of the retired gates-test.sh): the shell helpers ev_scaffold,
// evidence_gap_fixture, vw, vwc and amend_plan as native code.
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { qaBind, project, repo, worker } from '../lib/harness.mjs';
import { must } from '../lib/harness.mjs';

export const RUN = '.agents/runs/LC';
export const EV_VAL = '- `POST /orders`: accepts a JSON body with items; limits 1-50 items; rejected at the order handler (400)';
export const EV_INV = '- QA-9 (AC-1) [invalid-input]: POST /orders with 51 items\n  input: a body with 51 items\n  expected: 400';
/** @param {string} dir @param {string} f @param {string} text */
export const put = (dir, f, text) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); };
/** @param {string} dir @param {string} f */
export const get = (dir, f) => readFileSync(path.join(dir, f), 'utf8');
export { qaBind, appendFileSync };

/** ev_scaffold: an orchestrated STANDARD run, not yet frozen (manual autonomy). @param {string} planExtra @param {string} [qaExtra] */
export function evScaffold(planExtra, qaExtra = '') {
  return project({ topology: 'orchestrated', cls: 'STANDARD', autonomy: 'manual', planExtra, qaExtra });
}
/** implemented orchestrated. @param {string} dir */
export function implemented(dir) {
  worker(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  worker(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(dir, ['handoff', 'LC', 'IMPLEMENTED']);
}
/** amend_plan N TEXT. @param {string} dir @param {string} n @param {string} text */
export function amendPlan(dir, n, text) {
  put(dir, `${RUN}/amendments/${n}.md`, `# amendment ${n}: destructive migration added to the plan\n`);
  appendFileSync(path.join(dir, RUN, 'PLAN.md'), `${text}\n`);
}
/** evidence_gap_fixture: an orchestrated run whose PLAN names check.sh and quiet.sh as verification commands, the verify-proof skill installed. @param {{ exempt?: boolean }} [o] */
export function evidenceGapFixture(o = {}) {
  const dir = project({ topology: 'orchestrated', exempt: o.exempt, planExtra: '\n## Verification commands\n\n- `sh .agents/local/check.sh`\n- `sh .agents/local/quiet.sh`' });
  implemented(dir);
  mkdirSync(path.join(dir, '.agents/skills'), { recursive: true });
  cpSync(path.join(repo, 'skills/verify-proof'), path.join(dir, '.agents/skills/verify-proof'), { recursive: true });
  cpSync(path.join(repo, 'skills/plan-contract'), path.join(dir, '.agents/skills/plan-contract'), { recursive: true });
  appendFileSync(path.join(dir, '.git/info/exclude'), '.agents/skills/\n');
  put(dir, '.agents/local/check.sh', 'echo ok 3 tests\n'); put(dir, '.agents/local/quiet.sh', ':\n');
  return dir;
}
/** vw VERDICT EXIT OUTPUT STATUS: a self-consistent VERIFY.md claiming check.sh ran with that exit and output. @param {string} dir @param {string} verdict @param {string|number} exit @param {string} output @param {string} status */
export function vw(dir, verdict, exit, output, status) {
  put(dir, `${RUN}/VERIFY.md`, [...verifyHead(`- \`sh .agents/local/check.sh\` | exit=${exit}`, `  output: ${output}`), ...verifyTail(status, `\`sh .agents/local/check.sh\` exit=${exit}`, verdict)].join('\n') + '\n');
}
/** @param {string[]} cmds */
function verifyHead(...cmds) { return ['# Verification: LC', '', '## Commands', '', ...cmds]; }
/** @param {string} status @param {string} evidence @param {string} verdict */
function verifyTail(status, evidence, verdict) {
  return ['', '## AC coverage', '', '| AC | test or command | status | evidence |', '|---|---|---|---|', `| AC-1 | impl_test.txt::lookup | ${status} | ${evidence} |`, '', '## Scope', '', 'verify-scope: exit=0', '',
    '## Design sync', '', 'design-sync: SKIPPED (no design documents)', '', '## Runtime', '', 'runtime: none (no runtime in this test)', '', '## Pre-existing failures', '', 'None', '', '## Failures', '', 'None', '', `Verdict: ${verdict}`];
}
/** VERIFY.md with the given Commands lines and an AC row citing check.sh (vwc of sc_evidence_gap_r2). @param {string} dir @param {string} verdict @param {string} status @param {string[]} cmds */
export function vwc(dir, verdict, status, cmds) {
  put(dir, `${RUN}/VERIFY.md`, [...verifyHead(...cmds), ...verifyTail(status, '`sh .agents/local/check.sh` exit=0', verdict).map((l) => (l === 'design-sync: SKIPPED (no design documents)' ? 'design-sync: SKIPPED (none)' : l))].join('\n') + '\n');
}
/** grep -rq PATTERN over a folder (text). @param {string} dir @param {string} sub @param {string | RegExp} pat */
export function grepTree(dir, sub, pat) {
  /** @param {string} p @returns {boolean} */
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) return readdirSync(p).some((n) => walk(path.join(p, n)));
    const t = readFileSync(p, 'utf8');
    return typeof pat === 'string' ? t.includes(pat) : pat.test(t);
  };
  try { return walk(path.join(dir, sub)); } catch { return false; }
}
