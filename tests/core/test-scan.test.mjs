// @ts-check
// Issue 265 package C (A276): `agent.sh build-record <ID> scan` hands the REVIEW_TESTS reviewer the scan candidates of the files the task changed, the plan's
// `## Test exceptions` and the measurement facts of package B. No test here waits or reads a clock; the files are tiny text, the GREEN durations are fixed strings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { ecosystemRowsAll } from '../../control-plane/agents/scripts/core/ecodata.mjs';
import { scanRules, scanText } from '../../control-plane/agents/scripts/core/waitscan.mjs';
import { missingFindings } from '../../control-plane/agents/scripts/core/testreview.mjs';
import { A, accepted, project, tmp } from '../lib/harness.mjs';

const PLAN = '\n## Tests\n\n- AC-1: `impl_test.txt` "retries after the delay" — it retries (test_kind: unit)\n\n## Test budgets\n\n- unit: test 100 ms; suite 1000 ms\n\n## Test exceptions\n\n- wait: `tests/sleepy.test.js` -- a real child process signal is awaited here, no clock can fake it\n';
const SLEEPY = 'test("retries after the delay", async () => {\n  await new Promise((r) => setTimeout(r, 500));\n  const started = Date.now();\n});\n';

/** A run whose scope names tests/sleepy.test.js and src/clock.js, with the files written after the scaffold (so the task changed them). @param {string} text */
function run(text = SLEEPY) {
  const d = project({ topology: 'orchestrated', scopeNamed: 'tests/sleepy.test.js', scopeExtra: 'AC-1', planExtra: PLAN });
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  writeFileSync(path.join(d, 'tests/sleepy.test.js'), text);
  return d;
}

test('scan lists the wait and the clock read of a changed test file with file:line and the pattern, sorted, exit 1', () => {
  const d = run();
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.equal(r.status, 1, r.text);
  assert.match(r.out, /^candidate: tests\/sleepy\.test\.js:2 wait setTimeout \| /m);
  assert.match(r.out, /^candidate: tests\/sleepy\.test\.js:3 clock_read Date\.now \| /m);
  assert.ok(r.out.indexOf(':2 wait') < r.out.indexOf(':3 clock_read'), 'sorted by line');
  assert.match(r.out, /^task-test-files: tests\/sleepy\.test\.js$/m);
  assert.match(r.out, /^plan-exception: wait `tests\/sleepy\.test\.js` -- a real child process signal/m);
  assert.equal(A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' }).out, r.out, 'the same bytes twice');
});

test('scan of a test that takes a fake clock lists no candidate and exits 0', () => {
  const d = run('test("retries after the delay", () => {\n  const clock = fakeClock(1000);\n  retry(clock);\n  clock.advance(500);\n});\n');
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^test-scan: 0 candidate\(s\) in 1 scanned file\(s\)$/m);
});

test('scan prints the measurement facts: a run nothing was measured for says NOT MEASURED, and the plan test with no recorded duration is named', () => {
  const d = run();
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.match(r.out, /^ {2}test-measure-row: none/m);
  assert.match(r.out, /^ {2}NOT MEASURED: no GREEN command was run twice/m);
  assert.match(r.out, /^ {2}NOT MEASURED: the plan names the test "retries after the delay" and no recorded duration matches it$/m);
});

test('scan --json has the same facts as JSON; a bad argument is a usage error', () => {
  const d = run();
  const r = A(d, ['build-record', 'LC', 'scan', '--json'], { role: 'reviewer' });
  const j = JSON.parse(r.out);
  assert.deepEqual(j.candidates.map((/** @type {any} */ c) => `${c.line}:${c.kind}:${c.pattern}`), ['2:wait:setTimeout', '3:clock_read:Date.now']);
  assert.equal(j.measurement.not_measured, true);
  assert.equal(j.plan_exceptions[0].kind, 'wait');
  assert.equal(A(d, ['build-record', 'LC', 'scan', '--bogus'], { role: 'reviewer' }).status, 2);
  assert.equal(A(d, ['build-record', 'LC', 'show'], { role: 'reviewer' }).status, 3, 'show is untouched: no record yet');
});

// ---- fix round 1 (A276): the name of a file, a long line, a missing finding, a refreeze --------------------------------------------------------

/** A run whose scope names one more file, written after the scaffold. @param {string} file @param {string} text */
function runWith(file, text) {
  const d = project({ topology: 'orchestrated', scopeNamed: file, scopeExtra: 'AC-1', planExtra: PLAN });
  mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
  writeFileSync(path.join(d, file), text);
  return d;
}

test('S1: test-path calls a test named after a lock, a config, a dependency or a requirement a test; the scan finds the wait in it', () => {
  const d = run();
  const names = ['tests/clock.test.js', 'tests/block.test.js', 'tests/lock.test.js', 'tests/config.test.js', 'tests/sleep.config.test.js', 'tests/require.test.js'];
  const kinds = A(d, ['test-path', ...names]).out.trim().split('\n').map((l) => l.split('\t')[1] ?? l);
  assert.ok(kinds.every((k) => k.trim() === 'test' || k.includes('test')), kinds.join(','));
  assert.equal(A(d, ['test-path', 'package-lock.json', 'jest.config.js', 'requirements.txt']).out.includes('test\t'), false, 'real manifests and settings stay product');
  const e = runWith('tests/sleep.config.test.js', 'setTimeout(r, 30000);\n');
  const r = A(e, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.equal(r.status, 1);
  assert.match(r.out, /^candidate: tests\/sleep\.config\.test\.js:1 wait setTimeout /m);
});

test('S1: a support file that holds tests is scanned for waits; plain code only for clock reads', () => {
  const t = A(runWith('lib/support.js', 'it("x", () => { setTimeout(f, 30000); });\n'), ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.match(t.out, /^candidate: lib\/support\.js:1 wait setTimeout /m);
  const p = A(runWith('lib/plain.js', 'setTimeout(f, 30000); Date.now();\n'), ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.doesNotMatch(p.out, /wait setTimeout/);
  assert.match(p.out, /^candidate: lib\/plain\.js:1 clock_read Date\.now /m);
});

test('S2: a wait after 5000 characters on one line is found; a file over the size cap is NOT SCANNED, exit 1, in text and JSON', () => {
  const d = runWith('tests/long.test.js', `${'x'.repeat(5000)} setTimeout(f, 1);\n`);
  assert.match(A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' }).out, /^candidate: tests\/long\.test\.js:1 wait setTimeout /m);
  const big = runWith('tests/big.test.js', 'x'.repeat(1048577));
  const r = A(big, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.equal(r.status, 1);
  assert.match(r.out, /^NOT SCANNED: tests\/big\.test\.js /m);
  assert.deepEqual(JSON.parse(A(big, ['build-record', 'LC', 'scan', '--json'], { role: 'reviewer' }).out).measurement.unscanned, ['tests/big.test.js']);
});

/** A context in the project, as the control plane builds it. @param {string} d */
const ctxOf = (d) => new Context({ env: {}, cwd: d, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: `${d}/.agents/scripts/agent.sh` }, `${d}/.agents/scripts/agent.sh`);

test('S4d: in a measured run every candidate and every NOT MEASURED fact needs a finding of its own; an unmeasured (older) run is not asked', () => {
  const d = run();
  const need = () => missingFindings(ctxOf(d), 'LC', { findings: [] });
  assert.deepEqual(need(), [], 'a run with no measurement stamp keeps the old rules');
  ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
  const m = need();
  assert.ok(m.some((x) => /no real_wait finding for the wait candidate tests\/sleepy\.test\.js:2 setTimeout/.test(x)), m.join('|'));
  assert.ok(m.some((x) => /no clock_not_injected finding for the clock_read candidate tests\/sleepy\.test\.js:3 Date\.now/.test(x)));
  assert.ok(m.some((x) => /no not_measured finding for the missing test-measure ledger row/.test(x)));
  assert.ok(m.some((x) => /no not_measured finding for the plan test "retries after the delay"/.test(x)));
  const f = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ observed, extra = {}) => ({ id: 'F', kind, verdict: 'confirmed', test: { file: 'tests/sleepy.test.js', name: 'retries after the delay' }, observed, ...extra });
  const answered = { findings: [
    f('real_wait', { candidate: { file: 'tests/sleepy.test.js', line: 2, pattern: 'setTimeout' }, outcome: 'traced', trace: 'x' }),
    f('clock_not_injected', { candidate: { file: 'tests/sleepy.test.js', line: 3, pattern: 'Date.now' }, outcome: 'untraced' }),
    f('not_measured', { reason: 'no_test_measure_row', subject: 'no_test_measure_row', detail: 'none' }),
    f('not_measured', { reason: 'no_recorded_duration', subject: 'retries after the delay', detail: 'retries after the delay' }),
  ] };
  assert.deepEqual(missingFindings(ctxOf(d), 'LC', answered), []);
  assert.equal(missingFindings(ctxOf(d), 'LC', { findings: answered.findings.slice(1) }).length, 1, 'dropping one finding is one error');
});

test('S3: the report of a run cleans what the repository wrote (a plan exception line cannot forge a row)', () => {
  const d = project({ topology: 'orchestrated', scopeNamed: 'tests/a.test.js', scopeExtra: 'AC-1', planExtra: `${PLAN}- wait: tests/x.js\u001b[31m -- a real signal is awaited and nothing can fake it\n` });
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  writeFileSync(path.join(d, 'tests/a.test.js'), 'setTimeout(f, 1); // \u001b]0;t\u0007\n');
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.ok(!/\u001b/.test(r.out), 'no escape character reaches the reviewer');
});

test('S4e: a refreeze that adds or changes a ## Test exceptions line is refused; one that leaves the section alone passes', () => {
  const frozen = () => { const d = project({ topology: 'orchestrated', cls: 'STANDARD', autonomy: 'manual', planExtra: PLAN }); accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze'); return d; };
  let d = frozen();
  mkdirSync(path.join(d, '.agents/runs/LC/amendments'), { recursive: true });
  writeFileSync(path.join(d, '.agents/runs/LC/amendments/001.md'), '# amendment 001: another exception\n');
  appendFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), '- wait: `tests/other.test.js` -- a real child process signal is awaited here, nothing fakes it\n');
  const r = A(d, ['refreeze', 'LC', '001.md'], { bind: true });
  assert.notEqual(r.status, 0);
  assert.match(r.text, /adds or changes a line of PLAN\.md ## Test exceptions/);
  d = frozen();
  mkdirSync(path.join(d, '.agents/runs/LC/amendments'), { recursive: true });
  writeFileSync(path.join(d, '.agents/runs/LC/amendments/001.md'), '# amendment 001: a note\n');
  appendFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), '\n## Risk\n\nperformance_critical: no\n');
  accepted(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'a refreeze that leaves the exceptions alone');
});

test('B1 / R-c: file_not_scanned has its own obligation per file; one finding whose detail lists several paths answers none of them; a wrong subject answers nothing', () => {
  const d = runWith('tests/big.test.js', 'x'.repeat(1048577));
  writeFileSync(path.join(d, 'tests/sleepy.test.js'), SLEEPY);
  ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
  const f = (/** @type {Record<string, unknown>} */ observed) => ({ id: 'F', kind: 'not_measured', verdict: 'confirmed', test: { file: 'tests/big.test.js', name: 'x' }, observed });
  const others = [
    { id: 'F1', kind: 'real_wait', verdict: 'confirmed', test: { file: 'x', name: 'x' }, observed: { candidate: { file: 'tests/sleepy.test.js', line: 2, pattern: 'setTimeout' }, outcome: 'untraced' } },
    { id: 'F2', kind: 'clock_not_injected', verdict: 'confirmed', test: { file: 'x', name: 'x' }, observed: { candidate: { file: 'tests/sleepy.test.js', line: 3, pattern: 'Date.now' }, outcome: 'untraced' } },
    f({ reason: 'no_test_measure_row', subject: 'no_test_measure_row', detail: 'n' }),
    f({ reason: 'no_recorded_duration', subject: 'retries after the delay', detail: 'n' }),
  ];
  const left = (/** @type {unknown[]} */ extra) => missingFindings(ctxOf(d), 'LC', { findings: [...others, ...extra] });
  assert.match(left([])[0], /no not_measured finding for the file tests\/big\.test\.js that nobody could scan/);
  assert.equal(left([f({ reason: 'file_not_scanned', subject: 'tests/other.test.js', detail: 'tests/big.test.js tests/sleepy.test.js' })]).length, 1, 'a detail that lists the path, with another subject, answers nothing');
  assert.deepEqual(left([f({ reason: 'file_not_scanned', subject: 'tests/big.test.js', detail: 'too large' })]), []);
});

test('R-b: in a run worktree the union keeps the shipped names under a blinded worktree copy (the trusted copy of the main tree); with no other copy the project copy alone is read (A276)', () => {
  const main = realpathSync(tmp());   // git reports the physical path
  const g = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => { const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-C', cwd, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  mkdirSync(path.join(main, '.agents/scripts'), { recursive: true });
  const shipped = readFileSync(path.join(import.meta.dirname, '../../control-plane/agents/ecosystems.json'), 'utf8');
  writeFileSync(path.join(main, '.agents/ecosystems.json'), shipped);
  writeFileSync(path.join(main, '.agents/scripts/proofline-core.mjs'), '// stand-in\n');
  g(main, 'init', '-q', '-b', 'main'); g(main, 'add', '.'); g(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(main, '.agents/local/worktrees/W');
  g(main, 'worktree', 'add', '-q', '-b', 'w', wt);
  const def = JSON.parse(shipped);
  for (const e of def.ecosystems) { e.fast_tests.sleep = ['zzzzz']; e.fast_tests.clock_reads = ['zzzzz']; }
  writeFileSync(path.join(wt, '.agents/ecosystems.json'), JSON.stringify(def));   // the task rewrote its tracked copy
  const mk = (/** @type {string} */ root) => new Context({ env: { PATH: process.env.PATH ?? '' }, cwd: root, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(root, '.agents/scripts/proofline-core.mjs'));
  const names = (/** @type {Context} */ ctx) => scanRules(ecosystemRowsAll(ctx)).find((r) => r.id === 'npm')?.wait ?? [];
  const inRun = mk(wt);
  assert.equal(inRun.agents, path.join(wt, '.agents'), 'the blinded copy is the one this context reads as the project');
  assert.ok(names(inRun).includes('zzzzz') && names(inRun).includes('setTimeout'), `the blinded names AND the shipped ones: ${names(inRun)}`);
  // the installed layout, in the main tree: scripts and definition are one folder, so there is no other copy; the defence there is codeAudit, the eco-pin and the owns guard
  writeFileSync(path.join(main, '.agents/ecosystems.json'), JSON.stringify(def));
  assert.deepEqual(names(mk(main)), ['zzzzz'], 'only the project copy');
});

test('R-b: the run start records the hash of .agents/ecosystems.json; a scan after it changed lists it as NOT MEASURED, exit 1, and submit requires a finding', () => {
  const d = run();
  const file = path.join(d, '.agents/ecosystems.json');
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
  ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'eco-pin', '-', '-', `sha=${sha}`);
  const before = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.doesNotMatch(before.out, /ecosystems\.json changed/);
  appendFileSync(file, '\n');
  const after = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.match(after.out, /NOT MEASURED: ecosystems\.json changed since the run started/);
  assert.ok(missingFindings(ctxOf(d), 'LC', { findings: [] }).some((m) => /ecosystems\.json changed since the run started \(subject: ecosystems\.json\)/.test(m)));
  const answered = { findings: [{ id: 'F', kind: 'not_measured', verdict: 'confirmed', test: { file: 'x', name: 'x' }, observed: { reason: 'definition_changed', subject: 'ecosystems.json', detail: 'hash differs' } }] };
  assert.equal(missingFindings(ctxOf(d), 'LC', answered).some((m) => /ecosystems\.json changed/.test(m)), false);
});
