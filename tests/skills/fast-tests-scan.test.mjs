// @ts-check
// Issue 265 package C (A276): the scan for real waits (AC-6), the REVIEW_TESTS finding kinds and their validators (AC-7), and the fixture of AC-9.
// Nothing here waits, reads a clock or touches the network: the scan reads tiny text files in a per-test temp folder, the validators read JSON, and the fixture's own
// selfcheck takes an injected runner.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { backtracks, flatten, loadEcosystems, validate } from '../../control-plane/agents/ecosystems.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { CLI_COMMANDS } from '../../control-plane/agents/scripts/core/commands/cli.mjs';
import { OVERLAP, WINDOW, applyAllowlist, isTestFile, lineWindows, parseAllowlist, reportJson, reportText, scanFiles, scanRules, scanText, testPathGlobs } from '../../control-plane/agents/scripts/core/waitscan.mjs';
import { parseException, planExceptions } from '../../control-plane/agents/scripts/core/testreview.mjs';
import { build as buildFixture } from '../../fixtures/fast-tests/setup.mjs';
import { checkFast, checkPlanExceptions } from '../../skills/test-trust/scripts/validate-findings.mjs';
import { computeGate } from '../../skills/test-trust/scripts/gate.mjs';
import { testExceptionProblems } from '../../skills/plan-contract/scripts/validate-plan.mjs';
import { tmp } from '../lib/harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const core = path.join(root, 'control-plane/agents/scripts/proofline-core.mjs');
const rows = flatten(loadEcosystems(path.join(root, 'control-plane/agents/ecosystems.json')));
const rules = scanRules(rows);
const hits = (/** @type {string} */ file, /** @type {string} */ text, /** @type {string[]} */ kinds = ['wait']) => scanText(file, text, rules, kinds).map((c) => `${c.line}:${c.pattern}`);

test('the rules come from the data of every ecosystem and nothing else', () => {
  assert.deepEqual(rules.map((r) => r.id), ['cargo', 'dart', 'dotnet', 'go', 'jvm', 'npm', 'php', 'python', 'ruby', 'swift']);
  assert.ok(rules.every((r) => r.files.length > 0 && r.wait.length > 0 && r.clock_read.length > 0));
});

test('each ecosystem family: its sleep calls are candidates in its own files only', () => {
  assert.deepEqual(hits('a.test.js', 'await new Promise((r) => setTimeout(r, 5));\nclearTimeout(x);\nsetInterval(f, 1)'), ['1:setTimeout', '3:setInterval']);
  assert.deepEqual(hits('test_a.py', 'time.sleep(1)\nawait asyncio.sleep(2)\nsleep(3)'), ['1:sleep(', '1:time.sleep', '2:asyncio.sleep', '2:sleep(', '3:sleep(']);
  assert.deepEqual(hits('a_test.go', 'time.Sleep(time.Second)\n<-time.After(d)\ntime.AfterFunc(d, f)'), ['1:time.Sleep', '2:time.After']);
  assert.deepEqual(hits('A.java', 'Thread.sleep(10);'), ['1:Thread.sleep']);
  assert.deepEqual(hits('A.cs', 'await Task.Delay(10); Thread.Sleep(5);'), ['1:Task.Delay', '1:Thread.Sleep']);
  assert.deepEqual(hits('a_spec.rb', 'sleep 1\nusleep 2'), ['1:sleep']);
  assert.deepEqual(hits('lib.rs', 'std::thread::sleep(d); thread::sleep(d);'), ['1:thread::sleep'], 'one candidate per line and name, not two for std::thread::sleep');
  assert.deepEqual(hits('a.test.js', 'sleep(1)'), ['1:sleep('], 'a bare sleep( is a wait in a JS or TS test');
  assert.deepEqual(hits('notes.txt', 'setTimeout'), [], 'a file no ecosystem claims is not scanned');
});

test('a clock read is its own kind; both kinds by default; a name in a string is still a candidate (the reviewer clears it)', () => {
  assert.deepEqual(hits('a.test.js', 'const t = Date.now();\nconst s = "setTimeout";', ['clock_read']), ['1:Date.now']);
  assert.deepEqual(scanText('a.test.js', 'const t = Date.now();\nconst s = "setTimeout";', rules).map((c) => `${c.line}:${c.kind}`), ['1:clock_read', '2:wait']);
  assert.deepEqual(hits('a.test.js', 'new   Date()', ['clock_read']), ['1:new Date()']);
  assert.deepEqual(hits('a.test.js', 'new Date(2020, 1, 1)', ['clock_read']), [], 'a date built from arguments reads no clock');
});

test('adding an ecosystem is data only: a made-up ecosystem row set is scanned with the same code', () => {
  const extra = [...rows, ['zigx', 'fast_tests.files', '*.zigx'], ['zigx', 'fast_tests.sleep', 'std.time.sleep'], ['zigx', 'fast_tests.clock_reads', 'std.time.now']];
  const r = scanRules(extra);
  assert.deepEqual(scanText('t.zigx', 'std.time.sleep(5);\nstd.time.now();', r, ['wait']).map((c) => `${c.line}:${c.source}`), ['1:zigx']);
  assert.deepEqual(scanText('t.zigx', 'std.time.sleep(5);', rules), [], 'without the rows the file is not claimed');
});

test('the allowlist needs a written reason; a listed candidate moves to allowed with it; a stale entry is reported', () => {
  const bad = parseAllowlist('# c\n\ntests/a.test.js\tsetTimeout\t\ntests/b.js\tsetTimeout\tshort\nonly two\tfields\n');
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors[0], /line 3: tests\/a\.test\.js setTimeout has no written reason/);
  const ok = parseAllowlist('tests/a.test.js\tsetTimeout\tthe test awaits a real socket close\ntests/gone/*\t*\tleft over from a removed folder\n');
  assert.deepEqual(ok.errors, []);
  const cands = scanText('tests/a.test.js', 'setTimeout(f, 1); Date.now();', rules);
  const r = applyAllowlist(cands, ok.entries);
  assert.deepEqual(r.open.map((c) => c.pattern), ['Date.now']);
  assert.equal(r.allowed[0].reason, 'the test awaits a real socket close');
  assert.deepEqual(r.unused.map((e) => e.glob), ['tests/gone/*']);
});

test('the report is deterministic: equal input, equal bytes, sorted; the JSON has a fixed key order', () => {
  const text = 'Date.now();\nsetTimeout(f, 1);\nsetTimeout(g, 2);';
  const a = scanText('tests/b.test.js', text, rules).concat(scanText('tests/a.test.js', text, rules));
  const rep = { scanned: ['tests/b.test.js', 'tests/a.test.js'], skipped: [], candidates: a.sort((x, y) => (x.file < y.file ? -1 : 1)), allowed: [], unused: [] };
  assert.equal(reportJson(rep), reportJson(structuredClone(rep)));
  const j = JSON.parse(reportJson(rep));
  assert.deepEqual(Object.keys(j), ['version', 'summary', 'candidates', 'allowed', 'unused_allowlist_entries', 'skipped']);
  assert.deepEqual(Object.keys(j.candidates[0]), ['file', 'line', 'kind', 'pattern', 'source', 'text']);
});

/** The command in this process: the same function the CLI entry runs, with a Context whose output is collected. @param {string[]} args @param {string} cwd */
function inProcess(args, cwd) {
  let out = '';
  const ctx = new Context({ env: {}, cwd, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(root, 'control-plane/agents/scripts/proofline-core.mjs'));
  ctx.out = (t) => { out += t; };
  const status = CLI_COMMANDS['test-scan'](ctx, args);
  return { status, out };
}

/** @param {string[]} args @param {string} cwd */
const cli = (args, cwd) => spawnSync(process.execPath, [core, 'cli', 'test-scan', ...args], { cwd, encoding: 'utf8', input: '' });

test('cli test-scan over a directory (in process): exit 1 with candidates, 0 when the allowlist covers them, 2 on a bad allowlist or a path outside the root', () => {
  const d = tmp();
  mkdirSync(path.join(d, 'tests/sub'), { recursive: true });
  mkdirSync(path.join(d, 'node_modules/x'), { recursive: true });
  writeFileSync(path.join(d, 'tests/b.test.js'), 'setTimeout(f, 1);\n');
  writeFileSync(path.join(d, 'tests/sub/a.test.js'), 'setInterval(f, 1);\n');
  writeFileSync(path.join(d, 'node_modules/x/c.test.js'), 'setTimeout(f, 1);\n');
  const r = inProcess(['tests'], d);
  assert.equal(r.status, 1);
  assert.deepEqual(r.out.split('\n').filter((l) => l.startsWith('candidate:')).map((l) => l.split(' | ')[0]), ['candidate: tests/b.test.js:1 wait setTimeout', 'candidate: tests/sub/a.test.js:1 wait setInterval']);
  assert.equal(inProcess(['tests'], d).out, r.out, 'the same bytes twice');
  assert.equal(inProcess(['.'], d).out.includes('node_modules'), false, 'pruned folders are not walked');
  writeFileSync(path.join(d, 'allow.tsv'), 'tests/*\t*\tlegacy tests, listed for issue 266 to fix\n');
  const ok = inProcess(['--allowlist', 'allow.tsv', '--json', 'tests'], d);
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.out).allowed.length, 2);
  writeFileSync(path.join(d, 'bad.tsv'), 'tests/*\t*\t\n');
  assert.throws(() => inProcess(['--allowlist', 'bad.tsv', 'tests'], d), /no written reason/);
  assert.throws(() => inProcess(['..'], path.join(d, 'tests')), /outside the scan root/);
  assert.throws(() => inProcess([], d), /usage|\[--root/);
});

test('the real command line: exit status and bytes through proofline-core.mjs cli', () => {
  const d = tmp();
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  writeFileSync(path.join(d, 'tests/a.test.js'), 'setTimeout(f, 1);\n');
  const r = cli(['tests'], d);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^candidate: tests\/a\.test\.js:1 wait setTimeout \| /m);
  assert.equal(cli(['--bogus', 'tests'], d).status, 2);
});

test('R5: the names of the common waits are data, one test per name', () => {
  const one = (/** @type {string} */ file, /** @type {string} */ text, /** @type {string} */ want) => assert.ok(hits(file, text).includes(want), `${want} in ${text}`);
  one('a.test.ts', 'await page.waitForTimeout(500);', '1:waitForTimeout');
  one('a.test.ts', 'cy.wait(1000);', '1:cy.wait');
  one('a.test.ts', "import { setTimeout } from 'timers/promises';", '1:timers/promises');
  one('test_a.py', 'from time import sleep', '1:from time import sleep');
  one('test_a.py', 'eventlet.sleep(1)', '1:eventlet.sleep');
  one('test_a.py', 'gevent.sleep(1)', '1:gevent.sleep');
  one('test_a.py', 'await trio.sleep(1)', '1:trio.sleep');
  one('A.java', 'await().atMost(5, SECONDS); Awaitility.await();', '1:Awaitility');
});

test('S1: a test is found by its name, its folder or its text, never by a name that looks like a manifest', () => {
  const globs = testPathGlobs(rows);
  for (const f of ['tests/lock.test.js', 'src/block.test.js', 'tests/config.test.js', 'tests/sleep.config.test.js', 'tests/require.test.js', 'a/depend.spec.ts', 'test_lock.py', 'lock_test.go']) assert.ok(isTestFile(f, '', rules, globs), f);
  assert.equal(isTestFile('src/util.js', 'export const x = 1;', rules, globs), false);
  assert.equal(isTestFile('src/helpers.js', 'describe("x", () => {});', rules, globs), true, 'a test marker in the text');
  assert.equal(isTestFile('src/helpers.js', 'it.skip("x", () => {});', rules, globs), true);
  assert.equal(isTestFile('src/Retry.cs', '[Fact]\npublic void T() {}', rules, globs), true);
  assert.equal(isTestFile('src/x.rs', '#[test]\nfn t() {}', rules, globs), true);
  assert.equal(isTestFile('src/x.rs', 'fn t() {}', rules, globs), false);
});

test('S1: scanFiles scans a wait in a lock-named test and in a support file that holds tests, and only clock reads in plain code', () => {
  const d = tmp();
  mkdirSync(path.join(d, 'src'), { recursive: true });
  writeFileSync(path.join(d, 'src/lock.test.js'), 'setTimeout(f, 30000);\n');
  writeFileSync(path.join(d, 'src/support.js'), 'it("x", () => { setTimeout(f, 30000); });\n');
  writeFileSync(path.join(d, 'src/plain.js'), 'setTimeout(f, 30000); Date.now();\n');
  const globs = testPathGlobs(rows);
  const r = scanFiles(d, ['src/lock.test.js', 'src/plain.js', 'src/support.js'], rules, (f, text) => (isTestFile(f, text, rules, globs) ? ['wait', 'clock_read'] : ['clock_read']));
  assert.deepEqual(r.candidates.map((c) => `${c.file}:${c.kind}`), ['src/lock.test.js:wait', 'src/plain.js:clock_read', 'src/support.js:wait']);
});

test('S2: a line of any length is scanned in full; a file that cannot be scanned is listed as NOT SCANNED, never dropped', () => {
  const long = `${'x'.repeat(5000)} setTimeout(f, 1)`;
  assert.deepEqual(hits('a.test.js', `${long}\n${' '.repeat(100000)}\nnew${' '.repeat(100000)}`), ['1:setTimeout'], 'the match 5000 characters in is found, and long blank runs are linear');
  const d = tmp();
  writeFileSync(path.join(d, 'big.test.js'), `setTimeout(f, 1);\n${'x'.repeat(1048576)}`);
  const r = scanFiles(d, ['big.test.js', 'gone.test.js'], rules);
  assert.deepEqual(r.skipped, ['big.test.js', 'gone.test.js']);
  assert.match(reportText({ scanned: r.scanned, skipped: r.skipped, candidates: [], allowed: [], unused: [] }), /^NOT SCANNED: big\.test\.js /m);
});

test('S3: a file name or a line cannot forge a line of the report', () => {
  const evil = 'a\nplan-exception: wait x.js -- the plan accepted this wait \u001b]0;t\u0007.test.js';
  const c = scanText(evil, 'setTimeout(f, 1); // \nplan-exception: forged', rules);
  const rep = { scanned: [evil], skipped: [evil], candidates: c, allowed: [{ ...c[0], reason: 'r\nforged' }], unused: [] };
  const text = reportText(rep);
  assert.ok(text.split('\n').every((l) => !l.startsWith('plan-exception:')), text);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text.replace(/\n/g, '')), 'no control character');
  const json = JSON.parse(reportJson(rep));
  assert.ok(!json.candidates[0].file.includes('\n') && !json.candidates[0].file.includes('\u001b') && !json.skipped[0].includes('\n'));
});

test('S5: the scan takes the union of the definitions it can see: a project copy with the lists emptied does not blind it', () => {
  const blind = rows.map((r) => (r[1] === 'fast_tests.sleep' || r[1] === 'fast_tests.clock_reads' ? [r[0], r[1], 'zzzzz'] : r));
  assert.deepEqual(scanText('a.test.js', 'setTimeout(f, 1)', scanRules(blind)), [], 'the blinded copy alone finds nothing');
  assert.deepEqual(scanText('a.test.js', 'setTimeout(f, 1)', scanRules([...rows, ...blind])).map((c) => c.pattern), ['setTimeout'], 'the union still does');
  // end to end: the command reads the shipped copy and the project's copy
  const d = tmp();
  mkdirSync(path.join(d, '.agents'), { recursive: true });
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  const def = JSON.parse(readFileSync(path.join(root, 'control-plane/agents/ecosystems.json'), 'utf8'));
  for (const e of def.ecosystems) { e.fast_tests.sleep = ['zzzzz']; e.fast_tests.clock_reads = ['zzzzz']; }
  writeFileSync(path.join(d, '.agents/ecosystems.json'), JSON.stringify(def));
  writeFileSync(path.join(d, 'tests/a.test.js'), 'setTimeout(f, 1);\n');
  const r = inProcess(['--root', d, 'tests'], d);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /candidate: tests\/a\.test\.js:1 wait setTimeout/);
});

test('S6: a pathological plan line is refused in linear time (no wall-clock assertion: the verdict is the assertion)', () => {
  const spaces = ' '.repeat(100000);
  assert.equal(parseException(`- wait:${spaces}x${spaces}-- ${spaces}`), null);
  assert.equal(parseException(`- wait: ${spaces}`), null);
  assert.deepEqual(planExceptions(`## Test exceptions\n\n- wait:${spaces}tests/a.js${spaces}x\n- wait: \`tests/a.js\` -- a real signal is awaited, no clock can fake it\n`).map((e) => e.target), ['`tests/a.js`']);
  assert.equal(testExceptionProblems([`- wait:${spaces}x${spaces}-- ${spaces}`]).length, 1);
  const f = { findings: [F({ kind: 'real_wait', verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified', plan_exception: `- wait:${spaces}t.js${spaces}-- ${spaces}` } })] };
  assert.equal(checkPlanExceptions(f, `## Test exceptions\n\n- wait:${spaces}t.js${spaces}-- ${spaces}\n`).length, 1);
});

test('R4: the allowlist: stale entries are judged for the scanned kind only; --help is usage; unused and skipped files fail the exit status', () => {
  const entries = parseAllowlist('tests/*\tsetTimeout\tlegacy waits, listed for issue 266\ntests/*\tDate.now\tlegacy clock reads, listed for 266\n').entries;
  const cands = scanText('tests/a.test.js', 'setTimeout(f, 1);', rules);
  assert.deepEqual(applyAllowlist(cands, entries, { kinds: ['wait'], rules }).unused, [], 'the clock-read entry is not stale when only waits were scanned');
  assert.deepEqual(applyAllowlist(cands, entries, { kinds: ['wait', 'clock_read'], rules }).unused.map((e) => e.pattern), ['Date.now']);
  const d = tmp();
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  writeFileSync(path.join(d, 'tests/a.test.js'), 'setTimeout(f, 1);\n');
  writeFileSync(path.join(d, 'allow.tsv'), 'tests/*\tsetTimeout\tlegacy waits, listed for issue 266\ntests/gone/*\t*\tleft over from a removed folder\n');
  assert.equal(inProcess(['--allowlist', 'allow.tsv', 'tests'], d).status, 1, 'a stale entry fails');
  assert.equal(inProcess(['--allowlist', 'allow.tsv', '--allow-unused', 'tests'], d).status, 0);
  const h = inProcess(['--help'], d);
  assert.equal(h.status, 0);
  assert.match(h.out, /^usage: proofline-core cli test-scan /);
  writeFileSync(path.join(d, 'tests/big.test.js'), 'x'.repeat(1048577));
  writeFileSync(path.join(d, 'allow2.tsv'), 'tests/a.test.js\tsetTimeout\tlegacy waits, listed for issue 266\n');
  const sk = inProcess(['--allowlist', 'allow2.tsv', 'tests'], d);
  assert.equal(sk.status, 1, 'a file that was not scanned fails');
  assert.match(sk.out, /NOT SCANNED: tests\/big\.test\.js/);
});

test('B2: text the scan cannot read is NOT SCANNED (UTF-16 with or without a byte order mark, NUL bytes); a UTF-8 byte order mark is dropped', () => {
  const d = tmp();
  const src = 'using Xunit;\n[Fact]\npublic void T() { Thread.Sleep(5000); }\n';
  writeFileSync(path.join(d, 'a.cs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(src, 'utf16le')]));
  writeFileSync(path.join(d, 'b.cs'), Buffer.from(src, 'utf16le'));
  writeFileSync(path.join(d, 'c.cs'), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(src, 'utf16le').swap16()]));
  writeFileSync(path.join(d, 'd.cs'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(src)]));
  writeFileSync(path.join(d, 'e.cs'), `${src}\u0000`);
  const r = scanFiles(d, ['a.cs', 'b.cs', 'c.cs', 'd.cs', 'e.cs'], rules);
  assert.deepEqual(r.skipped, ['a.cs', 'b.cs', 'c.cs', 'e.cs']);
  assert.deepEqual(r.candidates.map((c) => `${c.file}:${c.pattern}`), ['d.cs:Thread.Sleep'], 'the UTF-8 file with a byte order mark is read normally');
});

test('B3: every shipped pattern is bounded: the validator rejects backtracking shapes, accepts the shipped markers, and no pattern ever sees more than one window', () => {
  for (const bad of ['(a+)+', '(\\.\\w+)*', '\\w*\\w*', 'a{2,}', '(a{1,3}){2,}', '(x*y)*']) assert.equal(backtracks(bad), true, bad);
  for (const ok of ['\\b(it)(\\.\\w{1,32}){0,3} ?\\(', '\\bdef test_\\w{0,80}\\(', '((a){1,3}){0,3}']) assert.equal(backtracks(ok), false, ok);
  const markers = rows.filter((r) => r[1] === 'fast_tests.test_markers').map((r) => r[2]);
  assert.ok(markers.length >= 10);
  for (const m of markers) { assert.equal(backtracks(m), false, m); new RegExp(m); }
  // the data validator refuses a definition that carries a bad marker
  const def = structuredClone(loadEcosystems(path.join(root, 'control-plane/agents/ecosystems.json')));
  def.ecosystems[0].fast_tests.test_markers = ['\\b(describe|it|test)(\\.\\w+)*\\s*\\('];
  assert.ok(validate(def).some((e) => /can backtrack badly/.test(e)));
  // however a pattern is written, it runs on windows of at most WINDOW characters
  for (const line of ['it.'.repeat(70000), ' '.repeat(200000), 'new '.repeat(50000), 'x'.repeat(200000)]) {
    const w = lineWindows(line);
    assert.ok(w.every((x) => x.length <= WINDOW), 'a window is never longer than WINDOW');
    assert.ok(w.length <= Math.ceil(line.length / (WINDOW - OVERLAP)) + 1);
  }
  assert.equal(lineWindows('a'.repeat(WINDOW * 3)).join('').length >= WINDOW * 3, true, 'the windows cover the line');
  // a pathological file gives a verdict (the old marker took 8.7 s on 60 KB; the structural bounds above are what keep it from coming back)
  assert.equal(isTestFile('support.js', 'it.'.repeat(70000), rules, []), false);
  assert.equal(scanText('a.test.js', `${'it.'.repeat(70000)} setTimeout(f)`, rules, ['wait']).length, 1);
});

test('R-d: Rust inline tests are tests; a project copy cannot prune the scan away; an explicit symlink argument is reported, not ignored', () => {
  const globs = testPathGlobs(rows);
  for (const t of ['#[cfg(test)]\nmod tests {}', '#[tokio::test(flavor = "multi_thread")]\nasync fn t() {}', '#[actix_rt::test]\nasync fn t() {}']) assert.equal(isTestFile('src/lib.rs', t, rules, globs), true, t);
  const d = tmp();
  mkdirSync(path.join(d, '.agents'), { recursive: true });
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  const def = JSON.parse(readFileSync(path.join(root, 'control-plane/agents/ecosystems.json'), 'utf8'));
  def.global.prune = [...def.global.prune, 'tests', 'src'];
  writeFileSync(path.join(d, '.agents/ecosystems.json'), JSON.stringify(def));
  writeFileSync(path.join(d, 'tests/a.test.js'), 'setTimeout(f, 1);\n');
  const r = inProcess(['.'], d);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /candidate: tests\/a\.test\.js:1 wait setTimeout/);
  try { symlinkSync(path.join(d, 'tests'), path.join(d, 'link')); } catch { return; }   // no symbolic links here (a restricted file system): nothing more to prove
  const l = inProcess(['link'], d);
  assert.equal(l.status, 1);
  assert.match(l.out, /NOT SCANNED: link /);
});

// ---- AC-7: the finding kinds and their validators ------------------------------------------------------------------------------------------

const F = (/** @type {Record<string, unknown>} */ o) => ({ id: 'F001', kind: 'real_wait', verdict: 'confirmed', test: { file: 't.js', name: 'x' }, evidence: [], source_commit: null, ...o });
const C = { file: 't.js', line: 2, pattern: 'setTimeout' };

test('a confirmed real wait, clock read, over-budget or unmeasured test blocks the gate; cleared and slow do not', () => {
  for (const kind of ['real_wait', 'clock_not_injected', 'over_budget', 'not_measured']) assert.deepEqual(computeGate([F({ kind })]), { result: 'FAIL', failing: ['F001'] }, kind);
  assert.equal(computeGate([F({ verdict: 'cleared' }), F({ id: 'F002', kind: 'slow' })]).result, 'PASS');
});

test('an untraced candidate stays a confirmed finding; only a false positive with a reason or a plan line clears it', () => {
  const v = (/** @type {Record<string, unknown>} */ o) => checkFast({ findings: [F(o)] });
  assert.deepEqual(v({ observed: { candidate: C, outcome: 'untraced' } }), []);
  assert.match(v({ verdict: 'cleared', observed: { candidate: C, outcome: 'untraced' } })[0], /untraced candidate stays a confirmed finding/);
  assert.match(v({ observed: { candidate: C, outcome: 'traced' } })[0], /needs "trace"/);
  const fp = (/** @type {string} */ reason) => v({ verdict: 'cleared', observed: { candidate: C, outcome: 'false_positive', reason } });
  assert.match(fp('')[0], /at least 30 characters that names the traced path/);
  assert.match(fp('the name is inside a string')[0], /at least 30 characters/, 'too short');
  assert.match(fp('it is only a harmless thing in a string, I looked')[0], /file name t\.js/, 'long enough, but it names neither the file nor the line');
  assert.deepEqual(fp('t.js line 2 holds setTimeout only inside a string literal'), []);
  assert.deepEqual(fp('in t.js the name setTimeout is inside a comment, not code'), [], 'the matched text instead of the line number');
  assert.match(v({ verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified' } })[0], /needs "plan_exception"/);
  assert.match(v({ kind: 'clock_not_injected', verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified', plan_exception: '- wait: x -- y' } })[0], /real_wait only/);
});

test('S4a: a not_measured finding is never cleared by the reviewer; only a plan measure line that quotes it clears it', () => {
  const nm = (/** @type {Record<string, unknown>} */ o) => checkFast({ findings: [F({ kind: 'not_measured', observed: { reason: 'not_double_run', detail: 'double_run=0', ...o }, ...(o.verdict ? { verdict: o.verdict } : {}) })] });
  assert.deepEqual(nm({}), []);
  assert.match(checkFast({ findings: [F({ kind: 'not_measured', verdict: 'cleared', observed: { reason: 'not_double_run', detail: 'x' } })] })[0], /never cleared by the reviewer/);
  assert.match(checkFast({ findings: [F({ kind: 'not_measured', verdict: 'needs_validation', observed: { reason: 'not_double_run', detail: 'x' } })] })[0], /never needs_validation/);
  assert.deepEqual(checkFast({ findings: [F({ kind: 'not_measured', verdict: 'cleared', observed: { reason: 'not_double_run', detail: 'x', plan_exception: '- measure: `t.js` -- no runner can run this test in the sandbox' } })] }), []);
});

test('S4c / B1: a plan line clears a finding only for the target of the OBLIGATION it answers (the candidate file, the BUDGET test name, the subject), not for what the reviewer wrote', () => {
  const plan = '## Test exceptions\n\n- wait: `tests/a.test.js` -- a real signal is awaited, no clock can fake it\n- wait: `B.test.js:7` -- a real signal is awaited, no clock can fake it\n- measure: "slow one" -- the runner cannot report this test in the sandbox\n- budget: "s" -- a real database migration runs in this test\n';
  const wait = (/** @type {string} */ e, cfile = 'tests/B.test.js', line = 7) => ({ findings: [F({ kind: 'real_wait', verdict: 'cleared', test: { file: 'tests/a.test.js', name: 'x' }, observed: { candidate: { file: cfile, line, pattern: 'setTimeout' }, outcome: 'plan_justified', plan_exception: e } })] });
  // the PoC: a wait in B, the reviewer writes test.file = a.test.js and quotes the line for a.test.js
  assert.match(checkPlanExceptions(wait('- wait: `tests/a.test.js` -- a real signal is awaited, no clock can fake it'), plan)[0], /not the target this finding answers \(tests\/B\.test\.js\)/);
  assert.deepEqual(checkPlanExceptions(wait('- wait: `B.test.js:7` -- a real signal is awaited, no clock can fake it'), plan), [], 'a path suffix on a directory boundary, with the line');
  assert.equal(checkPlanExceptions(wait('- wait: `B.test.js:7` -- a real signal is awaited, no clock can fake it', 'tests/B.test.js', 8), plan).length, 1, 'another line');
  assert.equal(checkPlanExceptions(wait('- wait: `B.test.js:7` -- a real signal is awaited, no clock can fake it', 'tests/AB.test.js'), plan).length, 1, 'a suffix that does not start on a directory boundary');
  const nm = (/** @type {string} */ subject, /** @type {string} */ name, /** @type {string} */ e) => ({ findings: [F({ kind: 'not_measured', verdict: 'cleared', test: { file: 'tests/t.js', name }, observed: { reason: 'file_not_scanned', subject, detail: 'x', plan_exception: e } })] });
  const slow = '- measure: "slow one" -- the runner cannot report this test in the sandbox';
  assert.equal(checkPlanExceptions(nm('tests/other.js', 's', slow), plan).length, 1, 'an unrelated measure line clears nothing, whatever name the reviewer gives the test');
  assert.deepEqual(checkPlanExceptions(nm('slow one', 's', slow), plan), []);
  // the LOW: a one-character test name is no longer "contained" in the plan target
  const bud = (/** @type {string} */ name) => ({ findings: [F({ kind: 'over_budget', verdict: 'cleared', test: { file: 't.js', name }, observed: { outcome: 'plan_justified', measured_ms: 1, budget_ms: 1, budget_source: 'plan', plan_exception: '- budget: "s" -- a real database migration runs in this test' } })] });
  assert.equal(checkPlanExceptions(bud('slow one'), plan).length, 1);
  assert.deepEqual(checkPlanExceptions(bud('s'), plan), []);
  assert.match(checkPlanExceptions(wait('- measure: "slow one" -- the runner cannot report this test in the sandbox'), plan)[0], /"- wait: \.\.\." line/);
});

test('over_budget: the measured duration must exceed the budget, and only a plan line justifies it', () => {
  const v = (/** @type {Record<string, unknown>} */ o) => checkFast({ findings: [F({ kind: 'over_budget', ...o })] });
  assert.deepEqual(v({ observed: { measured_ms: 3500, budget_ms: 200, budget_source: 'plan', outcome: 'over' } }), []);
  assert.match(v({ observed: { measured_ms: 100, budget_ms: 200, budget_source: 'plan', outcome: 'over' } })[0], /not above budget_ms/);
  assert.match(v({ verdict: 'cleared', observed: { measured_ms: 3500, budget_ms: 200, budget_source: 'plan', outcome: 'over' } })[0], /does not match verdict/);
});

test('with the plan: a quoted plan_exception must be a line of ## Test exceptions of the matching kind', () => {
  const plan = '## Tests\n\n- regression: `t.js`\n\n## Test exceptions\n\n- wait: `t.js` -- a real signal is awaited, no clock can fake it\n';
  const f = (/** @type {string} */ e, kind = 'real_wait') => ({ findings: [F({ kind, verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified', plan_exception: e } })] });
  assert.deepEqual(checkPlanExceptions(f('- wait: `t.js` -- a real signal is awaited, no clock can fake it'), plan), []);
  assert.match(checkPlanExceptions(f('- wait: `t.js` -- invented after the freeze, not in the plan'), plan)[0], /is not a "- wait: \.\.\." line of PLAN/);
  assert.match(checkPlanExceptions(f('- wait: `t.js` -- a real signal is awaited, no clock can fake it', 'over_budget'), plan)[0], /"- budget: \.\.\."/);
});

test('plan-contract: ## Test exceptions lines need wait|budget, a target and a reason of 20 or more characters', () => {
  assert.deepEqual(testExceptionProblems(['- wait: `tests/a.js` -- a real child process signal is awaited here', '- budget: "slow one" — a real database migration runs in this test', '']), []);
  assert.equal(testExceptionProblems(['- wait: `tests/a.js` -- too short']).length, 1);
  assert.equal(testExceptionProblems(['- sleep: `tests/a.js` -- a real child process signal is awaited here']).length, 1);
  assert.equal(testExceptionProblems(['wait without a dash and no reason']).length, 1);
});

// ---- AC-9: the fixture ------------------------------------------------------------------------------------------------------------------------

test('the fast-tests fixture builds in-process and its selfcheck proves the four cases', () => {
  const d = tmp();
  const target = path.join(d, 'ft');
  buildFixture(target);
  const r = spawnSync(process.execPath, [path.join(root, 'fixtures/fast-tests/selfcheck.mjs'), target], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'selfcheck: fast-tests ok\n');
  assert.match(readFileSync(path.join(target, 'sleepy/tests/retry.test.js'), 'utf8'), /setTimeout/);
});
