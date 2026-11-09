// @ts-check
// Helpers of tests/core/gates-s3.test.mjs (the Node form of the fixture helpers gates-test.sh used in its middle part): everything is native, no shell library.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { A, must, project, repo, resultFor, worker, passAll, wev, wopen, wclose } from '../lib/harness.mjs';

export { repo };

/** The report file of a gate (report_path of the shell library). @param {string} g */
export const reportPath = (g) => ({
  REVIEW_PLAN: 'reviews/proof-review/plan/REPORT.md', REVIEW_RULES: 'reviews/proof-review/rules/REPORT.md', REVIEW_SMALL: 'reviews/proof-review/small/REPORT.md',
  REVIEW_TESTS: 'reviews/test-trust/tests/REPORT.md', REVIEW_DATA: 'reviews/data-design/REVIEW.md', SECURITY: 'security/REPORT.md', QA: 'QA_REPORT.md', VERIFY: 'VERIFY.md',
})[g] ?? '';
/** The focus of a review gate (gate_focus of the shell library). @param {string} g */
export const gateFocus = (g) => ({ REVIEW_SMALL: 'rules+tests', REVIEW_PLAN: 'plan', REVIEW_RULES: 'rules', REVIEW_TESTS: 'tests', REVIEW_DATA: 'data' })[g] ?? '';

/** The scaffolded run, implemented (RED fail, GREEN pass, handoff IMPLEMENTED). @param {Parameters<typeof project>[0]} o scaffold options @param {'orchestrated' | 'standalone'} [topology] */
export function implementedProject(o = {}, topology = 'orchestrated') {
  const dir = project({ ...o, topology });
  implemented(dir, topology);
  return dir;
}
/** @param {string} dir @param {string} [topology] */
export function implemented(dir, topology = 'orchestrated') {
  if (topology === 'orchestrated') {
    worker(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  } else {
    appendFileSync(path.join(dir, 'impl_test.txt'), 'test: lookup returns the stored value\n'); wev(dir, 'RED', 'fail', { role: null });
    appendFileSync(path.join(dir, 'impl.txt'), 'impl: lookup returns the stored value\n'); wev(dir, 'GREEN', 'pass', { role: null });
  }
  must(dir, ['handoff', 'LC', 'IMPLEMENTED']);
}
/** The gates the pipeline requires. @param {string} dir */
export const required = (dir) => (A(dir, ['pipeline', 'LC']).out.match(/^gates=(.*)$/m)?.[1] ?? '').split(/\s+/).filter(Boolean);
/** The number of gate records. @param {string} dir */
export const nGates = (dir) => { const d = path.join(dir, '.agents/runs/LC/gates'); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.yaml')).length : 0; };
/** Lines of a text file (no trailing empty). @param {string} dir @param {string} f */
export const lines = (dir, f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
/** Record a gate result with extra environment (the shell exported PROOFLINE_STEP_AGENT etc. around `rec`). @param {string} dir @param {string} gate @param {string} res @param {string[]} rows @param {Record<string, string>} env */
export function recEnv(dir, gate, res, rows, env) {
  const f = resultFor(dir, gate, res, rows);
  const role = gate.startsWith('REVIEW_') ? 'reviewer' : ({ SECURITY: 'security_reviewer', QA: 'qa', VERIFY: 'verifier' })[gate] ?? '';
  return must(dir, ['record', 'LC', '--file', f], { role, env });
}
/** Install a skill folder of the repository into the fixture (outside git, as the shell suite did). @param {string} dir @param {string} skill */
export function installSkill(dir, skill) {
  mkdirSync(path.join(dir, '.agents/skills'), { recursive: true });
  cpSync(path.join(repo, 'skills', skill), path.join(dir, '.agents/skills', skill), { recursive: true });
}
/** Install only the wiki lint script. @param {string} dir */
export function installWikiLint(dir) {
  mkdirSync(path.join(dir, '.agents/skills/llm-wiki/scripts'), { recursive: true });
  cpSync(path.join(repo, 'skills/llm-wiki/scripts/validate-wiki.mjs'), path.join(dir, '.agents/skills/llm-wiki/scripts/validate-wiki.mjs'));
}
export { appendFileSync, writeFileSync, mkdirSync, wopen, wclose, passAll };
