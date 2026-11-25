// @ts-check
// A358 (issue 338 item B9; retro items R1-8, R2-3, R3-8, R4-13): `handoff IMPLEMENTED` runs the plan-listed Verification command ITSELF once and records the GREEN result and the per-test
// durations keyed by the plan's quoted test names. The implementer's own durations are a claim; the control plane's run is the evidence (Core invariant 4). Only a listed command that FAILS
// refuses; a command that exits 0 but ran none of the plan-named tests is not GREEN. The "test runner" is a fixed script (tests/core/evidence-repair-lib.mjs); no clock, no wait.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { testCmdPin } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { A, accepted, must, project, refused, wclose, wev, wopen } from '../lib/harness.mjs';
import { PLAN, RUN, SCRIPT, ledger, setMode } from './evidence-repair-lib.mjs';

// the cold build of the project template (after any change of the code) is paid here, outside every test's budget (A311)
before(() => { project({ topology: 'orchestrated', cls: 'CRITICAL', planExtra: PLAN }); });

/**
 * A run with RED and an implementer GREEN that names only "slow one" (the state that used to be refused for "fast one"), not yet IMPLEMENTED.
 * @param {string} mode what the fixed runner does: ok | fail | nodur | dup @param {string} [claim] an unlisted command the implementer records a GREEN for ("fast one") @param {string} [script] the runner's source
 * @param {{ plan?: string, setup?: (b: string) => void, testText?: string }} [more] another plan, files written before the window opens, text added to the task's own test file
 */
function ready(mode, claim = '', script = SCRIPT, more = {}) {
  const b = project({ topology: 'orchestrated', cls: 'CRITICAL', planExtra: more.plan ?? PLAN });
  ledgerAppend(path.join(b, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
  ledgerAppend(path.join(b, '.agents/runs/LC'), 'lead', 'test-cmd-pin', '-', '-', `testcmd=${testCmdPin([])}`);
  more.setup?.(b);
  writeFileSync(path.join(b, '.git/er-run.mjs'), script);
  setMode(b, mode);
  const w = wopen(b);
  appendFileSync(path.join(b, 'impl_test.txt'), `test: lookup returns the stored value\n${more.testText ?? ''}`);
  wev(b, 'RED', 'fail');
  appendFileSync(path.join(b, 'impl.txt'), 'impl: lookup returns the stored value\n');
  must(b, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `command: ${RUN}\ntarget: impl.txt,impl_test.txt\ntest_durations: slow one=5.5\n` });
  if (claim !== '') must(b, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `command: ${claim}\ntarget: impl.txt,impl_test.txt\ntest_durations: fast one=1\n` });
  wclose(b, w);
  return b;
}
const greens = (/** @type {string} */ d) => readdirSync(path.join(d, '.agents/runs/LC/worker-evidence')).filter((n) => n.startsWith('GREEN-')).sort().map((n) => readFileSync(path.join(d, '.agents/runs/LC/worker-evidence', n), 'utf8'));

test('B9: a plan test missing from the implementer GREEN no longer refuses IMPLEMENTED: the control plane runs the command and records both durations under the plan names', () => {
  const d = ready('ok');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  const own = greens(d).filter((g) => /^role: "lead"/m.test(g));
  assert.equal(own.length, 1, 'one GREEN record made by the control plane');
  assert.match(own[0], /^command: node \.git\/er-run\.mjs$/m);
  assert.match(own[0], /^test_durations: slow one=5\.5; fast one=0\.75$/m);
  assert.match(ledger(d), /event=green-control .*tests=2\/2/);
});

test('B9: a plan-listed command that fails (a listed test fails) refuses IMPLEMENTED and records nothing', () => {
  const d = ready('fail');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a failing listed command', 'a listed test fails');
  assert.equal(greens(d).length, 1, 'the control plane recorded no GREEN for a failing run');
});

test('B9: a plan test whose duration the output never shows is not GREEN: it is not recorded and the old refusal stands', () => {
  const d = ready('nodur');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'no duration for a plan test', 'no recorded GREEN duration');
  assert.ok(!greens(d).some((g) => g.includes('fast one')), 'a duration was invented for a test the output does not show');
});

test('B9: the control plane covers only "slow one"; the implementer\'s own unlisted command claims "fast one": that claim is still no evidence and IMPLEMENTED is refused', () => {
  const d = ready('nodur', 'echo claimed');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a claim for a test the control plane did not run', 'echo claimed');
  assert.doesNotMatch(ledger(d), /event=green-control/, 'a partial run is not recorded as covering the content');
});

test('B9: a result line echoed next to the real one makes the name ambiguous: it is not recorded', () => {
  const d = ready('dup');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a duplicated result line', 'no recorded GREEN duration');
  assert.ok(!greens(d).some((g) => g.includes('fast one')), 'a duration was taken from an ambiguous output');
});

test('B9: a result line for a name that is no test title in any file of the task or the command is not recorded', () => {
  const hidden = "import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('er-runs', import.meta.url), 'x');\nconsole.log(['\\u2714', 'slow', 'one', '(5.5ms)'].join(' '));\nconsole.log(['\\u2714', 'fast', 'one', '(0.75ms)'].join(' '));\n";
  const d = ready('ok', '', hidden);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'names that are no title', 'no recorded GREEN duration');
  assert.ok(!greens(d).some((g) => /^role: "lead"/m.test(g)), 'the control plane recorded a name it cannot find as a test title');
});

const HEAD = "import { test, it } from 'node:test';\n";
/** A runner whose source declares exactly the given tests (inside a branch it never takes, so node:test does not run them); it prints both result lines. @param {string} decls @param {string} [head] */
const runner = (decls, head = HEAD) => `import { appendFileSync } from 'node:fs';\n${head}appendFileSync(new URL('er-runs', import.meta.url), 'x');\nif (process.argv.length > 99) {\n${decls}}\nconsole.log('\\u2714 slow one (5.5ms)');\nconsole.log('\\u2714 fast one (0.75ms)');\n`;
const SLOW = "test('slow one', () => {});\n";
const ownRecords = (/** @type {string} */ d) => greens(d).filter((g) => /^role: "lead"/m.test(g));
/** The run is refused for "fast one" and nothing was recorded for it. @param {string} d @param {string} why */
function notFast(d, why) {
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, why, 'no recorded GREEN duration');
  assert.ok(!ownRecords(d).some((g) => g.includes('fast one')), `${why}: a duration was taken for a test that is not declared`);
  return r;
}

test('B9: a printed result line and a quoted comment are no test declaration: "fast one" is not recorded and the note says why', () => {
  const r = notFast(ready('ok', '', runner(`${SLOW}// test('fast one', () => {})\n/* test("fast one") */\nconsole.log("test('fast one')");\n`)), 'a name that is only printed or commented');
  assert.match(r.text, /does not stand for "fast one" \(it is not declared exactly once as a test/);
});

test('B9: a real declaration is accepted, also with a template literal title, `it(`, `.only` and a regex literal before it', () => {
  const d = ready('ok', '', runner(`${SLOW.replace('test(', 'test.only(')}const r = /'"\`/;\nit(\`fast one\`, () => {});\n`));
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED with declared tests');
  assert.match(ownRecords(d)[0] ?? '', /^test_durations: slow one=5\.5; fast one=0\.75$/m);
});

test('B9: a title declared twice is ambiguous and is not recorded', () => {
  notFast(ready('ok', '', runner(`${SLOW}test('fast one', () => {});\nit('fast one', () => {});\n`)), 'a title declared twice');
});

test('B9 hole 1: a call on another object (`foo.test(`) is no declaration', () => {
  notFast(ready('ok', '', runner(`${SLOW}foo.test('fast one', () => {});\n`)), 'foo.test(');
});

test('B9 hole 2: a fake declaration on its own line inside a multi-line template literal is no declaration', () => {
  notFast(ready('ok', '', runner(`${SLOW}const s = \`\ntest('fast one', () => {})\n\`;\n`)), 'a template literal');
});

const DIR_RUNNER = runner('', HEAD);
const dirTests = (/** @type {string} */ b) => {
  mkdirSync(path.join(b, '.git/tdir/deep'), { recursive: true });
  writeFileSync(path.join(b, '.git/tdir/a.test.mjs'), `${HEAD}${SLOW}`);
  writeFileSync(path.join(b, '.git/tdir/deep/b.test.mjs'), `${HEAD}test('fast one', () => {});\n`);
};
const planWith = (/** @type {string} */ cmd) => PLAN.replace('`node .git/er-run.mjs`', `\`${cmd}\``);

test('B9 hole 4: a command that runs a directory or a glob is resolved to the real files under the project and nothing else', () => {
  for (const arg of ["'.git/tdir/**/*.test.mjs'"]) {
    const d = ready('ok', '', DIR_RUNNER, { plan: planWith(`node .git/er-run.mjs ${arg}`), setup: dirTests });
    accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), `a command that runs ${arg}`);
    assert.match(ownRecords(d)[0] ?? '', /^test_durations: slow one=5\.5; fast one=0\.75$/m);
  }
});

test('B9 hole 4: a command that names no test file does not fall back to the changed test files', () => {
  const cmd = `node -e "console.log('\\u2714 slow one (5.5ms)'); console.log('\\u2714 fast one (0.75ms)')"`;
  const d = ready('ok', '', runner('', ''), { plan: planWith(cmd), testText: `${HEAD}${SLOW}test('fast one', () => {});\n` });
  notFast(d, 'a changed test file that the command does not run');
});
