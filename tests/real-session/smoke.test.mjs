// @ts-check
// The real-session smoke (tests/real-session/smoke.mjs) calls a model and is never part of CI; what CI can check is its table format, its pure helpers and its
// exit semantics with a stub `claude` that starts no session: the setup rows are real (init of a fixture project), every model step FAILS, the exit status is 1.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { a202BranchRow, a202StatusRow, codexConfigCommit, codexDispatchSeen, doctorRow, expand, fixtureCommands, skillDetourRow, renderTable, sessionIdOf, statusBlock, tableLine, testState } from './smoke.mjs';

const smoke = path.join(import.meta.dirname, 'smoke.mjs');
const base = tempDir('smoke-test-');
after(() => rmSync(base, { recursive: true, force: true }));

test('the table keeps the format of the shell smoke: header, separator, one line per row', () => {
  assert.equal(tableLine(['a', 'PASS', '3', 'note']), '| a | PASS | 3 | note |');
  const t = renderTable('haiku', '0.0.74', [['setup', 'PASS', '1', 'ok'], ['batch', 'FAIL', '2', 'bad']]);
  assert.equal(t, '\nproofline real-session smoke (model haiku, proofline 0.0.74)\n| step | result | seconds | note |\n|---|---|---|---|\n| setup | PASS | 1 | ok |\n| batch | FAIL | 2 | bad |\n');
});

test('sessionIdOf takes the first line that holds a session id (the last on that line)', () => {
  assert.equal(sessionIdOf('{"type":"x"}\n{"session_id":"s1","a":{"session_id":"s2"}}\n{"session_id":"s3"}\n'), 's2');
  assert.equal(sessionIdOf('nothing'), '');
});

test('expand and statusBlock', () => {
  const d = path.join(base, 'g'); mkdirSync(path.join(d, 'x/sub'), { recursive: true }); mkdirSync(path.join(d, 'y/sub'), { recursive: true });
  writeFileSync(path.join(d, 'x/sub/T-2.md'), ''); writeFileSync(path.join(d, 'y/sub/T-2.md'), ''); writeFileSync(path.join(d, 'x/sub/T-3.md'), '');
  assert.deepEqual(expand(`${d}/*/sub/T-2.md`), [`${d}/x/sub/T-2.md`, `${d}/y/sub/T-2.md`]);
  assert.deepEqual(expand(`${d}/*/nope/*.md`), []);
  const text = 'a\n<!-- PROOFLINE-STATUS:BEGIN:T-2 -->\n- run: T-2\n- stage: MERGED\n<!-- PROOFLINE-STATUS:END:T-2 -->\nz\n';
  assert.equal(statusBlock(text, 'T-2'), '- run: T-2\n- stage: MERGED');
  assert.equal(statusBlock(text, 'T-3'), '');
});

/** @param {Record<string, string>} extra */
const runSmoke = (extra) => spawnSync(process.execPath, [smoke], { encoding: 'utf8', env: { ...process.env, TMPDIR: base, SMOKE_STEP_TIMEOUT: '20', ...extra }, timeout: 280000 });

test('without claude the smoke exits 127 and says so', () => {
  const empty = path.join(base, 'empty'); mkdirSync(empty, { recursive: true });
  const r = runSmoke({ PATH: empty });
  assert.equal(r.status, 127); assert.match(r.stderr, /smoke: claude is not installed/);
});

test('a stub claude that starts no session: real setup rows, failing model rows, a table, exit 1; SMOKE_KEEP keeps the work folder', () => {
  const bin = path.join(base, 'stubbin'); mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(bin, 'claude'), 0o755);
  const r = runSmoke({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, SMOKE_ONLY: 'a196', SMOKE_KEEP: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /\| step \| result \| seconds \| note \|\n\|---\|---\|---\|---\|\n/);
  assert.match(r.stdout, /\| a196 setup: init, local bare origin \| PASS \| \d+ \| installed proofline /);
  assert.match(r.stdout, /\| a196 user answer bound to the asking session \(positive\) \| FAIL \| \d+ \| no session id in /);
  assert.match(r.stdout, /smoke: 1 step\(s\) FAILED/);
  const kept = /kept: (.+)/.exec(r.stdout)?.[1];
  assert.ok(kept, 'the kept path is printed');
  rmSync(kept, { recursive: true, force: true });
});

// The A202 rows read files the control plane wrote. Each sabotage below is the thing one criterion of the row checks (the mutation checks of the port).
/** @param {string} id @param {string} stage @param {string} [extra] */
const block = (id, stage, extra = '') => `# Task\n\n## Proofline Status\n\n<!-- PROOFLINE-STATUS:BEGIN:${id} -->\n- run: ${id}\n- stage: ${stage}\n${extra}<!-- PROOFLINE-STATUS:END:${id} -->\n`;
/** @param {string} name @param {string} taskText @param {string[]} branches */
function synthetic(name, taskText, branches) {
  const p = path.join(base, name, 'project'); const o = path.join(base, name, 'origin.git'); const w = path.join(base, name, 'work');
  mkdirSync(path.join(p, '.agents/tasks'), { recursive: true }); mkdirSync(w, { recursive: true });
  writeFileSync(path.join(p, '.agents/tasks/T-2.md'), taskText);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', o]);
  const c = path.join(base, name, 'c'); spawnSync('git', ['clone', '-q', o, c]);
  spawnSync('git', ['-C', c, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']); spawnSync('git', ['-C', c, 'push', '-q', 'origin', 'HEAD:main']);
  for (const b of branches) spawnSync('git', ['-C', c, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`]);
  return testState(p, o, w);
}
test('a202 status row: PASS on a merged block, FAIL when the block is doubled, not MERGED, holds a local path, or is missing', () => {
  const rs = synthetic('s1', block('T-2', 'MERGED'), []); a202StatusRow('t', 'T-2');
  assert.equal(rs[0][1], 'PASS', rs[0][3]); assert.match(rs[0][0], /^t batch status block \(T-2\): one section, updated in place, MERGED, no local path$/);
  for (const [name, text, why] of /** @type {[string, string, RegExp][]} */ ([
    ['s2', block('T-2', 'MERGED') + block('T-2', 'MERGED'), /status sections and 2 blocks/],
    ['s3', block('T-2', 'PR OPEN'), /stage is 'PR OPEN', not MERGED/],
    ['s4', block('T-2', 'MERGED', '- worktree: /Users/someone/x\n'), /holds a local path: - worktree: \/Users\/someone\/x/],
    ['s5', '# Task\nno block\n', /no task file of T-2 holds a status block/],
    ['s6', '# Task\n\n## Proofline Status\n\n<!-- PROOFLINE-STATUS:BEGIN:T-2 -->\n- run: T-9\n- stage: MERGED\n<!-- PROOFLINE-STATUS:END:T-2 -->\n', /the block of T-2 is empty or names another run/],
  ])) { const r = synthetic(name, text, []); a202StatusRow('t', 'T-2'); assert.equal(r[0][1], 'FAIL', name); assert.match(r[0][3], why, name); }
});
test('a202 branch row: PASS on proofline/<ID>-<slug> from the title, FAIL on a bare id, an id slug or a slug not from the title', () => {
  let r = synthetic('b1', '', ['proofline/T-2-whisper-text']); a202BranchRow('t', 'T-2', 'whisper'); assert.equal(r[0][1], 'PASS', r[0][3]);
  for (const [name, branch, why] of /** @type {[string, string, RegExp][]} */ ([['b3', 'proofline/T-2-t-2', /repeats the id as its slug/], ['b4', 'proofline/T-2-other-words', /does not come from the task title/], ['b6', 'proofline/T-2-Whisper_Text', /not proofline\/T-2-<slug>/], ['b7', 'proofline/T-2-whisper--text', /not proofline\/T-2-<slug>/]])) {
    r = synthetic(name, '', [branch]); a202BranchRow('t', 'T-2', 'whisper'); assert.equal(r[0][1], 'FAIL', name); assert.match(r[0][3], why, name);
  }
  // a bare id on the origin is no match; a bare id RECORDED by the control plane is the failure the row names
  r = synthetic('b2', '', []); mkdirSync(path.join(base, 'b2/project/.agents/local/deliver/T-2'), { recursive: true });
  writeFileSync(path.join(base, 'b2/project/.agents/local/deliver/T-2/SUMMARY.md'), 'branch: proofline/T-2\n'); a202BranchRow('t', 'T-2', 'whisper');
  assert.equal(r[0][1], 'FAIL'); assert.match(r[0][3], /not proofline\/T-2-<slug>/);
  r = synthetic('b5', '', []); a202BranchRow('t', 'T-2', 'whisper'); assert.match(r[0][3], /no proofline\/T-2-\* branch on the origin and none recorded/);
});

// ---- the former tests/ci/smoke-fixture-test.sh (A202 smoke run 3, A226) ----------------------------------------------------------------------------
/** @param {string} dir @param {string[]} a */
const g = (dir, a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
test('the fixture has build and lint scripts and fixtureCommands leaves no empty commands.build|test|lint (the batch pre-flight would stop at the first NEXT line)', () => {
  const src = readFileSync(smoke, 'utf8');
  assert.ok(src.includes('"build": "node --check src/greet.js", "lint": "node --check tests/greet.test.js"'), 'the smoke fixture package.json has no build and lint scripts');
  const p = path.join(base, 'fc/p'); mkdirSync(p, { recursive: true });
  g(p, ['init', '-q', '-b', 'main']); writeFileSync(path.join(p, 'package.json'), '{ "name": "x", "scripts": { "test": "node --test" } }\n'); g(p, ['add', '-A']); g(p, ['commit', '-q', '-m', 'base']);
  const init = spawnSync(path.join(import.meta.dirname, '../../bin/proofline'), ['init', '--yes', '--runtimes', 'claude', '--lead', 'claude', '--worker', 'claude', '--reviewers', 'claude', '--profile', 'economy', '--task-adapter', 'markdown'], { cwd: p, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  testState(p, path.join(base, 'fc/o.git'), path.join(base, 'fc/w'));
  fixtureCommands();
  const cfg = readFileSync(path.join(p, '.agents/config.yaml'), 'utf8');
  for (const k of ['build', 'test', 'lint']) assert.match(cfg, new RegExp(`^  ${k}: *\\S`, 'm'), `commands.${k} is empty after fixtureCommands`);
});

test('codexDispatchSeen reads a real signal: a claude-only batch is not a Codex batch (A226); a dispatch line, a metrics record or a dispatch file is', () => {
  const d = path.join(base, 'cd'); mkdirSync(path.join(d, '.agents/local/worktrees/T-2/.agents'), { recursive: true }); mkdirSync(path.join(d, '.agents/local/metrics'), { recursive: true });
  testState(d, path.join(base, 'cd.git'), path.join(base, 'cdw'));
  writeFileSync(path.join(d, '.agents/local/worktrees/T-2/.agents/roles.conf'), 'implementer balanced codex tier2 high 2\n');   // the old text match passed on this
  const claudeOnly = path.join(base, 'claude-only.jsonl'); writeFileSync(claudeOnly, 'dispatch: T-2 implementer runtime=claude model=sonnet effort=high (ROLE_PROFILE) writes_code=yes\n');
  assert.equal(codexDispatchSeen(claudeOnly), false, 'a claude-only batch with a roles.conf that names codex');
  const rec = path.join(d, '.agents/local/metrics/records.jsonl');
  writeFileSync(rec, '{"kind":"dispatch","task":"T-2","role":"implementer","focus":null,"gate":null,"runtime":"claude","model":"sonnet"}\n');
  assert.equal(codexDispatchSeen(claudeOnly), false, 'a claude metrics record');
  const codex = path.join(base, 'codex.jsonl'); writeFileSync(codex, 'dispatch: T-3 implementer runtime=codex model=gpt-6-sol effort=high (ROLE_PROFILE) writes_code=yes\n');
  assert.equal(codexDispatchSeen(codex), true, 'a codex dispatch line in the transcript');
  writeFileSync(rec, '{"kind":"dispatch","task":"T-3","role":"implementer","focus":null,"gate":null,"runtime":"codex","model":"gpt-6-sol"}\n', { flag: 'a' });
  assert.equal(codexDispatchSeen(claudeOnly), true, 'a codex metrics record');
  rmSync(rec); mkdirSync(path.join(d, '.agents/local/worktrees/T-3/.agents/runs/T-3/dispatch'), { recursive: true });
  assert.equal(codexDispatchSeen(claudeOnly), false);
  writeFileSync(path.join(d, '.agents/local/worktrees/T-3/.agents/runs/T-3/dispatch/001-implementer-codex.log'), '');
  assert.equal(codexDispatchSeen(claudeOnly), true, 'a dispatch file of a Codex implementer');
});

test('codexConfigCommit puts the Codex config on the origin main and on the project main with the task branch checked out and a dirty tree; idempotent; fast-forwards from main', () => {
  const t = path.join(base, 'cc'); mkdirSync(path.join(t, 'bin'), { recursive: true });
  writeFileSync(path.join(t, 'bin/codex'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(t, 'bin/codex'), 0o755);
  const O = path.join(t, 'origin.git'); const P = path.join(t, 'p2');
  g(t, ['init', '-q', '--bare', '-b', 'main', O]); g(t, ['init', '-q', '-b', 'main', P]);
  mkdirSync(path.join(P, '.agents'), { recursive: true });
  writeFileSync(path.join(P, '.agents/config.yaml'), 'runtime:\n  lead: claude\n  roles:\n'); writeFileSync(path.join(P, '.agents/T-1.md'), 'a\n');
  g(P, ['add', '-A']); g(P, ['commit', '-q', '-m', 'base']); g(P, ['remote', 'add', 'origin', O]); g(P, ['push', '-q', 'origin', 'main']); g(P, ['checkout', '-q', '-b', 'proofline/T-1-x']);
  writeFileSync(path.join(P, '.agents/T-1.md'), 'b\n'); g(P, ['commit', '-q', '-am', 'feat: task branch']); writeFileSync(path.join(P, '.agents/T-1.md'), 'c\n');
  assert.notEqual(g(P, ['checkout', '-q', 'main']).status, 0, 'the fixture does not reproduce a refused checkout of main');
  g(t, ['clone', '-q', O, 'user']); writeFileSync(path.join(t, 'user/merged.txt'), 'merged\n'); g(path.join(t, 'user'), ['add', '-A']); g(path.join(t, 'user'), ['commit', '-q', '-m', 'the users merge']); g(path.join(t, 'user'), ['push', '-q', 'origin', 'main']);
  testState(P, O, t);
  const oldPath = process.env.PATH; process.env.PATH = `${path.join(t, 'bin')}${path.delimiter}${oldPath}`;
  try {
    assert.equal(codexConfigCommit(), true, 'failed with the task branch checked out and a dirty tree');
    assert.match(g(t, ['--git-dir', O, 'show', 'main:.agents/config.yaml']).stdout, /^ {4}implementer: codex/m, 'the Codex config is not on the origin main');
    assert.equal(g(t, ['--git-dir', O, 'show', 'main:merged.txt']).status, 0, "the config commit lost the user's merge");
    assert.match(g(P, ['show', 'main:.agents/config.yaml']).stdout, /^ {4}implementer: codex/m, 'the project main did not learn the Codex config');
    assert.equal(g(P, ['symbolic-ref', '--short', 'HEAD']).stdout.trim(), 'proofline/T-1-x'); assert.equal(readFileSync(path.join(P, '.agents/T-1.md'), 'utf8'), 'c\n', "the project's tree was touched");
    assert.doesNotMatch(g(P, ['show', 'proofline/T-1-x:.agents/config.yaml']).stdout, /implementer: codex/, 'the Codex config landed on the task branch');
    assert.equal(codexConfigCommit(), true, 'not idempotent');
    g(t, ['clone', '-q', O, 'user2']); writeFileSync(path.join(t, 'user2/more.txt'), 'more\n'); g(path.join(t, 'user2'), ['add', '-A']); g(path.join(t, 'user2'), ['commit', '-q', '-m', 'more']); g(path.join(t, 'user2'), ['push', '-q', 'origin', 'main']);
    g(P, ['checkout', '-q', '-f', 'main']);
    assert.equal(codexConfigCommit(), true, 'failed on main');
    assert.ok(existsSync(path.join(P, 'more.txt')), 'the project main was not fast-forwarded');
  } finally { process.env.PATH = oldPath; }
});

test('the skill-tool row: no call is a PASS; up to three rejected calls pass only while every step above passed (a failed step above fails it); more than three fail', () => {
  const w = path.join(base, 'sk'); mkdirSync(w, { recursive: true });
  /** @param {number} n @param {number} failed */
  const rowFor = (n, failed) => { writeFileSync(path.join(w, 'x.jsonl'), '{"name":"Skill"}\n'.repeat(n)); const r = testState(path.join(base, 'p'), path.join(base, 'o'), w, failed); skillDetourRow(); return r[0]; };
  assert.deepEqual(rowFor(0, 0).slice(0, 2), ['skill tool not used', 'PASS']);
  assert.deepEqual(rowFor(2, 0).slice(0, 2), ['skill tool: the lead recovered', 'PASS']);
  const afterFail = rowFor(2, 1); assert.deepEqual(afterFail.slice(0, 2), ['skill tool: the lead recovered', 'FAIL']); assert.match(afterFail[3], /2 Skill-tool call\(s\) and a failed step above/);
  assert.equal(rowFor(4, 0)[1], 'FAIL');
});

test('the doctor row: exit 0 is PASS with the last line, any other exit is FAIL with the first FAIL line', () => {
  let rs = testState(path.join(base, 'p'), path.join(base, 'o'), path.join(base, 'w'));
  doctorRow('hermetic', { status: 0, text: 'ok a\nNext step: x\n' }, Math.floor(Date.now() / 1000));
  assert.deepEqual([rs[0][0], rs[0][1], rs[0][3]], ['hermetic doctor', 'PASS', 'Next step: x']);
  rs = testState(path.join(base, 'p'), path.join(base, 'o'), path.join(base, 'w'));
  doctorRow('hermetic', { status: 1, text: 'ok a\nFAIL hooks missing\nNext step: x\n' }, Math.floor(Date.now() / 1000));
  assert.deepEqual([rs[0][1], rs[0][3]], ['FAIL', 'FAIL hooks missing']);
});

test('a claude call that ignores TERM is stopped with its whole process group after the timeout; the row FAILs (no session id)', () => {
  const bin = path.join(base, 'stubterm'); mkdirSync(bin, { recursive: true });
  const pidFile = path.join(base, 'child.pid');
  // the stub and its child both ignore TERM; the child's pid is written down so the test can see it die
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ntrap '' TERM\n( trap '' TERM; echo $$ > "${pidFile}"; exec sleep 300 ) &\nwhile [ ! -s "${pidFile}" ]; do sleep 0.1; done\nwhile :; do sleep 1; done\n`); chmodSync(path.join(bin, 'claude'), 0o755);
  const r = spawnSync(process.execPath, [smoke], { encoding: 'utf8', env: { ...process.env, TMPDIR: base, SMOKE_STEP_TIMEOUT: '1', SMOKE_ONLY: 'a196', SMOKE_KEEP: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` }, timeout: 120000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /\(positive\) \| FAIL \| \d+ \| no session id in /);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the TERM-ignoring child of the stub survived the timeout');
  const kept = /kept: (.+)/.exec(r.stdout)?.[1]; if (kept) { assert.ok(readdirSync(kept).some((n) => n.endsWith('.note')), 'the timeout note is written'); rmSync(kept, { recursive: true, force: true }); }
});
