// @ts-check
// A325: a run in the state the evidence-only repair starts from: IMPLEMENTED with two plan-named tests, every gate passed except REVIEW_TESTS, which failed on a plan test with no
// recorded duration, and the lead has reopened it (handoff IMPLEMENTING). Built once per code version and copied. No test here waits or reads a clock: the "test runner" is a fixed script
// that prints fixed lines, and its mode (ok | fail | nodur) is a file.
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { testCmdPin } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { A, accepted, approveAsUser, cached, codeKey, copyOf, git, gfail, gpass, must, pipe, project, rec, sha256, wclose, wev, wopen } from '../lib/harness.mjs';

export const RUN = 'node .git/er-run.mjs';
export const PLAN = '\n## Tests\n\n- AC-1: `impl_test.txt` "slow one" — it is slow (test_kind: unit)\n- AC-2: `impl_test.txt` "fast one" — it is fast (test_kind: unit)\n\n## Verification commands\n\n- `node .git/er-run.mjs`\n';
export const SCRIPT = "import { appendFileSync, readFileSync } from 'node:fs';\nfunction test() {}\ntest('slow one', () => {});\ntest('fast one', () => {});\nconst mode = readFileSync(new URL('er-mode', import.meta.url), 'utf8').trim();\nappendFileSync(new URL('er-runs', import.meta.url), 'x');\nif (mode === 'touch') appendFileSync('other.txt', 'changed by the test command\\n');\nif (mode === 'dirty') appendFileSync('impl.txt', 'changed by the test command\\n');\nif (mode === 'fail') { console.log('not ok 1 - slow one'); process.exit(1); }\nconsole.log('\\u2714 slow one (5.5ms)');\nif (mode === 'dup') console.log('\\u2714 fast one (0.1ms)');\nif (mode !== 'nodur') console.log('\\u2714 fast one (0.75ms)');\nelse console.log('\\u2714 something else (1ms)');\n";

/** @param {string} d @param {string} mode ok | fail | nodur */
export const setMode = (d, mode) => writeFileSync(path.join(d, '.git/er-mode'), `${mode}\n`);

/** The finding of the tests review: a plan test with no recorded duration (or the given document). @param {string} d @param {unknown} [doc] */
export function writeFindings(d, doc = null) {
  const f = doc ?? { findings: [{ id: 'F001', kind: 'not_measured', verdict: 'confirmed', test: { file: 'impl_test.txt', name: 'fast one' }, observed: { reason: 'no_recorded_duration', subject: 'fast one', detail: 'fast one' } }] };
  const dir = path.join(d, '.agents/runs/LC/reviews/test-trust/tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'findings.json'), `${JSON.stringify(f, null, 1)}\n`);
}

/** Take the duration of one test out of every GREEN record (the state the reviewer found). @param {string} d @param {string} name */
export function stripDuration(d, name) {
  const ev = path.join(d, '.agents/runs/LC/worker-evidence');
  for (const n of readdirSync(ev).filter((x) => x.startsWith('GREEN-'))) {
    const t = readFileSync(path.join(ev, n), 'utf8').split('\n').map((l) => (l.startsWith('test_durations: ') ? `test_durations: ${l.slice(16).split('; ').filter((e) => !e.startsWith(`${name}=`)).join('; ') || 'x=0'}` : l)).join('\n');
    writeFileSync(path.join(ev, n), t);
  }
}

/** Every gate passes except REVIEW_TESTS, which fails (and the gates in alsoFail). @param {string} d @param {string[]} [alsoFail] */
export function passAllButTests(d, alsoFail = []) {
  const extra = alsoFail.includes('ROW') ? ['REVIEW_TESTS-2|blocking|impl_test.txt:2|the test asserts nothing about the empty key (hollow)|traced: empty key -> nil'] : [];
  for (const g of pipe(d, 'gates').split(/\s+/).filter(Boolean)) {
    if (g === 'VERIFY') continue;
    if (g === 'SECRETS') must(d, ['secret-scan', 'LC']);
    else if (g === 'REVIEW_TESTS') rec(d, g, 'FAIL', ['REVIEW_TESTS-1|blocking|impl_test.txt:1|the plan test fast one has no recorded duration|NOT MEASURED', ...extra]);
    else if (alsoFail.includes(g)) gfail(d, g, 'impl.txt');
    else gpass(d, g);
  }
}

/** The run at the start of a fix round that only has an evidence finding (also: more gates that failed on the same content). @param {string[]} [also] @returns {string} a fresh copy of the project */
export function template(also = /** @type {string[]} */ ([]), exception = '', scope = '') {
  const key = `er-${codeKey()}-${sha256(PLAN + also.join(',') + exception + scope).slice(0, 10)}`;
  return cached(key, (work) => {
    // exception: 'approved' | 'unapproved' puts a `- measure:` line for "fast one" in the plan, frozen after the user's scope approval (or without it)
    // scope: 'clean' | 'new' adds other.txt to the plan scope (a previously clean in-scope file; 'new': not tracked, so a command that writes it creates a new in-scope file)
    const wide = scope === '' ? {} : { scopeExtra: 'AC-1' };
    const b = exception === ''
      ? project({ topology: 'orchestrated', cls: 'CRITICAL', ...wide, planExtra: PLAN })
      : project({ topology: 'orchestrated', cls: 'CRITICAL', ...wide, autonomy: 'manual', planExtra: `${PLAN}\n## Test exceptions\n\n- measure: \`fast one\` -- the project runner prints no duration for this test\n` });
    if (exception !== '') {
      if (exception === 'approved') approveAsUser(b, 'scope', 'approve scope');
      approveAsUser(b, 'plan', 'approve plan');
      accepted(A(b, ['freeze', 'LC'], { bind: true }), 'freeze');
      must(b, ['handoff', 'LC', 'IMPLEMENTING']);
    }
    ledgerAppend(path.join(b, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
    ledgerAppend(path.join(b, '.agents/runs/LC'), 'lead', 'test-cmd-pin', '-', '-', `testcmd=${testCmdPin([])}`);
    writeFileSync(path.join(b, '.git/er-run.mjs'), SCRIPT);
    setMode(b, 'ok');
    const w = wopen(b);
    if (scope === 'new') git(b, ['rm', '-q', 'other.txt']);   // staged deletion in scope: a file the command writes shows up as a NEW untracked in-scope path
    appendFileSync(path.join(b, 'impl_test.txt'), 'test: lookup returns the stored value\n');
    wev(b, 'RED', 'fail');
    appendFileSync(path.join(b, 'impl.txt'), 'impl: lookup returns the stored value\n');
    must(b, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `command: ${RUN}\ntarget: impl.txt,impl_test.txt\ntest_durations: slow one=5.5; fast one=0.75\n` });
    wclose(b, w);
    accepted(A(b, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
    passAllButTests(b, [...also.filter((g) => g !== 'VERIFY'), ...(exception === 'unapproved' ? ['ROW'] : [])]);
    if (also.includes('VERIFY')) rec(b, 'VERIFY', 'FAIL', ['VERIFY-1|blocking|impl.txt:1|the claim is not shown|re-ran: it does not hold']);
    stripDuration(b, 'fast one');
    if (exception !== '') stripDuration(b, 'slow one');
    writeFindings(b, exception === '' ? null : { findings: [{ id: 'F001', kind: 'not_measured', verdict: 'confirmed', test: { file: 'impl_test.txt', name: 'slow one' }, observed: { reason: 'no_recorded_duration', subject: 'slow one', detail: 'slow one' } }, ...(exception === 'unapproved' ? [{ id: 'F002', kind: 'not_measured', verdict: 'confirmed', test: { file: 'impl_test.txt', name: 'fast one' }, observed: { reason: 'no_recorded_duration', subject: 'fast one', detail: 'fast one' } }] : [])] });
    must(b, ['handoff', 'LC', 'IMPLEMENTING']);
    cpSync(b, work, { recursive: true });
    rmSync(b, { recursive: true, force: true });
  });
}

/** A fresh copy of the project of a variant (see `template`). @param {string[]} [also] @param {string} [exception] @param {string} [scope] */
export function reopened(also = /** @type {string[]} */ ([]), exception = '', scope = '') { return copyOf(template(also, exception, scope)); }

/** Build the templates of some variants in a `before` hook: the cold build is paid once, outside any test (the per-test budget is for the scenario, as in the port rig, A311). @param {Array<[string[]?, string?, string?]>} variants */
export function warm(variants) { for (const v of variants) template(v[0] ?? [], v[1] ?? '', v[2] ?? ''); }

/** @param {string} d @param {Record<string, unknown>} [o] */
export const rerun = (d, o = {}) => A(d, ['worker-evidence', 'LC', 'GREEN', 'rerun'], { role: 'implementer', ...o });
/** @param {string} d */
export const ledger = (d) => readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8');
/** @param {string} d @param {string} sub */
export const count = (d, sub) => { try { return readdirSync(path.join(d, '.agents/runs/LC', sub)).length; } catch { return 0; } };
export { accepted, gpass, must, rec };
/** The number of times the fixed runner was started (it appends a byte per start). @param {string} d */
export const runnerStarts = (d) => { try { return readFileSync(path.join(d, '.git/er-runs'), 'utf8').length; } catch { return 0; } };
