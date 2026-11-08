// @ts-check
// Tests tests/ci/change-reason.mjs: the pull request description rules for changes of tests/invariants/ and of the context budget, and the
// classification step of tests/ci/ci-steps.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { evaluate, hasReasonLine, main } from './change-reason.mjs';
import { main as steps } from './ci-steps.mjs';

const T = mkdtempSync(path.join(tmpdir(), 'reason-test-'));
after(() => rmSync(T, { recursive: true, force: true }));
/** @param {string} rule @param {string[]} paths @param {NodeJS.ProcessEnv} env */
const run = (rule, paths, env) => evaluate(rule, paths, { env });
const INV = 'invariants';

describe('invariants', () => {
  /** @type {Array<[number, string, string, string[]]>} */
  const rows = [
    [0, 'no invariant file changed', '', ['README.md', 'docs/a.md']],
    [1, 'invariant test changed, empty description', '', ['tests/invariants/invariants-test.sh']],
    [1, 'Node invariant test changed, empty description', '', ['tests/invariants-node/rule-3.test.mjs']],
    [1, 'invariant test changed, description without the line', 'Fixes the lookup.', ['tests/invariants/invariants-test.sh']],
    [0, 'invariant test changed, reason given', 'Fixes x.\n\nInvariant-test-change: the fixture now installs the stub scanner', ['tests/invariants/invariants-test.sh', 'README.md']],
    [0, 'reason with CRLF line endings', 'Intro\r\nInvariant-test-change: the fixture now installs the stub scanner\r', ['tests/invariants/x.sh']],
    [1, 'line present but no reason', 'Invariant-test-change:', ['tests/invariants/invariants-test.sh']],
    [1, 'line present, reason too short', 'Invariant-test-change: fix', ['tests/invariants/invariants-test.sh']],
    [1, 'the phrase inside a sentence is not the line', 'see Invariant-test-change: the fixture now installs the stub', ['tests/invariants/invariants-test.sh']],
    [1, 'indented line does not count', '  Invariant-test-change: the fixture now installs the stub', ['tests/invariants/invariants-test.sh']],
    [1, 'a reason on the next line does not count', 'Invariant-test-change:\nthe fixture now installs the stub scanner', ['tests/invariants/invariants-test.sh']],
    [1, 'a deleted invariant test is a change', '', ['tests/invariants/removed-test.sh']],
    [0, 'a sibling path is not under tests/invariants/', '', ['tests/invariants-extra/x.sh', 'tests/other/invariants/x.sh']],
  ];
  for (const [want, desc, body, paths] of rows) test(desc, () => assert.equal(run(INV, paths, { PR_BODY: body }).status, want));
  test('the failure names the changed files and the line to add', () => {
    const r = run(INV, ['tests/invariants/invariants-test.sh'], { PR_BODY: '' });
    assert.match(r.err.join('\n'), /Invariant-test-change: <why the invariant test changed/);
    assert.ok(r.err.includes('    tests/invariants/invariants-test.sh'));
  });
  test('the event payload (CI), a body file, and runs that are not pull requests', () => {
    const ok = path.join(T, 'event-ok.json'); writeFileSync(ok, JSON.stringify({ pull_request: { body: 'x\n\nInvariant-test-change: payload carries the reason' } }));
    const empty = path.join(T, 'event-empty.json'); writeFileSync(empty, '{"pull_request":{"body":null}}');
    const p = ['tests/invariants/invariants-test.sh'];
    assert.equal(run(INV, p, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: ok }).status, 0);
    assert.equal(run(INV, p, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: empty }).status, 1);
    assert.equal(run(INV, p, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path.join(T, 'nope.json') }).status, 1);
    writeFileSync(path.join(T, 'bad.json'), '{ not json'); assert.equal(run(INV, p, { GITHUB_EVENT_PATH: path.join(T, 'bad.json') }).status, 1);
    const body = path.join(T, 'body.txt'); writeFileSync(body, 'Invariant-test-change: the body file carries the reason\n');
    assert.equal(run(INV, p, { PR_BODY_FILE: body }).status, 0);
    assert.equal(run(INV, p, { PR_BODY_FILE: path.join(T, 'missing.txt') }).status, 2, 'a missing body file is a usage error');
    assert.equal(run(INV, p, { GITHUB_EVENT_NAME: 'push' }).status, 0, 'a push has no description to check');
    assert.equal(run(INV, p, { GITHUB_EVENT_NAME: 'schedule' }).status, 0);
    assert.equal(run(INV, p, { GITHUB_EVENT_NAME: 'pull_request_target', PR_BODY: '' }).status, 1);
  });
  test('PR_BODY (even empty) wins over the file and the payload; the live description wins over the payload', () => {
    const body = path.join(T, 'b2.txt'); writeFileSync(body, 'Invariant-test-change: the body file carries the reason\n');
    const p = ['tests/invariants/invariants-test.sh'];
    assert.equal(run(INV, p, { PR_BODY: '', PR_BODY_FILE: body }).status, 1);
    const ev = path.join(T, 'ev3.json'); writeFileSync(ev, JSON.stringify({ pull_request: { body: 'Invariant-test-change: from the payload, stale' } }));
    assert.equal(evaluate(INV, p, { env: { GITHUB_EVENT_PATH: ev }, liveBody: () => 'edited, no line' }).status, 1, 'a re-run sees the edited description');
    assert.equal(evaluate(INV, p, { env: { GITHUB_EVENT_PATH: ev }, liveBody: () => null }).status, 0, 'a failed fetch falls back to the payload');
  });
});

describe('context budget', () => {
  const CB = 'context-budget';
  /** @type {Array<[number, string, string, string[]]>} */
  const rows = [
    [0, 'budget unchanged', '', ['README.md', 'control-plane/agents/scripts/core/contextsize.mjs']],
    [1, 'budget changed, empty description', '', ['tests/context/budget.tsv']],
    [1, 'budget changed, a different reason line', 'Invariant-test-change: this is not the right line', ['tests/context/budget.tsv']],
    [0, 'budget changed, reason given', 'Adds a section.\n\nContext-budget-change: the entry skill gains the status block table', ['tests/context/budget.tsv']],
    [1, 'reason too short', 'Context-budget-change: more', ['tests/context/budget.tsv']],
    [1, 'the phrase inside a sentence is not the line', 'see Context-budget-change: the entry skill gains a table', ['tests/context/budget.tsv']],
    [0, 'a sibling file is not the budget', '', ['tests/context/budget.tsv.bak', 'tests/context/rule-map.tsv']],
  ];
  for (const [want, desc, body, paths] of rows) test(desc, () => assert.equal(run(CB, paths, { PR_BODY: body }).status, want));
  test('a push is not checked', () => assert.equal(run(CB, ['tests/context/budget.tsv'], { GITHUB_EVENT_NAME: 'push' }).status, 0));
  test('the failure names the line to add', () => assert.match(run(CB, ['tests/context/budget.tsv'], { PR_BODY: '' }).err.join('\n'), /Context-budget-change: <why the context budget changed/));
});

describe('the command', () => {
  test('reads the changed paths from stdin, or from git with --base and --head; exit codes follow the rules', () => {
    let out = '';
    assert.equal(main(['invariants'], { env: { PR_BODY: '' }, stdin: () => 'README.md\n', write: (s) => { out += s; } }), 0);
    assert.match(out, /no file under tests\/invariants\/ changed/);
    const origErr = console.error; console.error = () => {};
    try {
      assert.equal(main(['invariants'], { env: { PR_BODY: '' }, stdin: () => 'tests/invariants/a.sh\n', write: () => {} }), 1);
      assert.equal(main([], { env: {}, stdin: () => '' }), 2);
      assert.equal(main(['nope'], { env: {}, stdin: () => '' }), 2);
      assert.equal(main(['invariants', '--bogus', 'x'], { env: {}, stdin: () => '' }), 2);
    } finally { console.error = origErr; }
    // git mode, on a throwaway repository
    const g = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: T, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    g(['init', '-q', '-b', 'main']); writeFileSync(path.join(T, 'a.txt'), 'a'); g(['add', '-A']); g(['commit', '-q', '-m', 'a']);
    const base = g(['rev-parse', 'HEAD']);
    execFileSync('mkdir', ['-p', path.join(T, 'tests/context')]); writeFileSync(path.join(T, 'tests/context/budget.tsv'), 'x'); g(['add', '-A']); g(['commit', '-q', '-m', 'b']);
    const head = g(['rev-parse', 'HEAD']);
    const cwd = process.cwd(); process.chdir(T);
    console.error = () => {};
    try {
      assert.equal(main(['context-budget', '--base', base, '--head', head], { env: { PR_BODY: '' }, write: () => {} }), 1);
      assert.equal(main(['context-budget', '--base', base, '--head', head], { env: { PR_BODY: 'Context-budget-change: the table gained a row' }, write: () => {} }), 0);
      assert.equal(main(['context-budget', '--base', head, '--head', head], { env: { PR_BODY: '' }, write: () => {} }), 0, 'nothing changed between the same commits');
    } finally { process.chdir(cwd); console.error = origErr; }
  });
  test('hasReasonLine wants twelve characters or more, starting with a non-space', () => {
    assert.ok(hasReasonLine('X', 'X: twelve chars'));
    assert.ok(!hasReasonLine('X', 'X: eleven char'));
    assert.ok(!hasReasonLine('X', 'X:            '));
  });
});

describe('ci-steps classify', () => {
  test('a pull request that changes only plain documentation is code=false; anything else is code=true; other events are code=true', () => {
    const out = path.join(T, 'gh-output'); writeFileSync(out, '');
    const env = { GITHUB_OUTPUT: out };
    let printed = '';
    const write = (/** @type {string} */ s) => { printed += s; };
    assert.equal(steps(['classify', '--event', 'pull_request', '--base', 'b', '--head', 'h'], { env, write, changed: () => ['README.md', 'docs/a.md'] }), 0);
    assert.equal(printed, 'code=false\n'); assert.equal(readFileSync(out, 'utf8'), 'code=false\n');
    assert.equal(steps(['classify', '--event', 'pull_request', '--base', 'b', '--head', 'h'], { env, write, changed: () => ['README.md', 'src/a.mjs'] }), 0);
    assert.match(readFileSync(out, 'utf8'), /code=true\n$/);
    assert.equal(steps(['classify', '--event', 'push'], { env, write, changed: () => { throw new Error('not asked'); } }), 0);
    assert.match(readFileSync(out, 'utf8'), /code=true\ncode=true\n$/);
  });
  test('a pull request without base and head, and an unknown step, are usage errors', () => {
    const origErr = console.error; console.error = () => {};
    try {
      assert.equal(steps(['classify', '--event', 'pull_request'], { env: {} }), 2);
      assert.equal(steps(['bogus'], { env: {} }), 2);
      assert.equal(steps([], { env: {} }), 2);
    } finally { console.error = origErr; }
  });
});

describe('ci-steps windows-timing', () => {
  test('the benchmark table is fenced in the job summary; the fence is closed when the benchmark fails; its status is the step\'s', () => {
    const sum = path.join(T, 'summary.md'); writeFileSync(sum, '');
    const env = { GITHUB_STEP_SUMMARY: sum, PATH: process.env.PATH };
    assert.equal(steps(['windows-timing'], { env, write: () => {}, bench: ['sh', ['-c', 'echo "pretool-read execs=3 ms=40"']] }), 0);
    assert.equal(readFileSync(sum, 'utf8'), '### Node hook per event (Windows, Git Bash fixtures)\n```\npretool-read execs=3 ms=40\n```\n');
    writeFileSync(sum, '');
    const origErr = process.stderr.write; process.stderr.write = () => true;
    try { assert.equal(steps(['windows-timing'], { env, write: () => {}, bench: ['sh', ['-c', 'echo partial; echo broken >&2; exit 3']] }), 1); } finally { process.stderr.write = origErr; }
    assert.equal(readFileSync(sum, 'utf8'), '### Node hook per event (Windows, Git Bash fixtures)\n```\npartial\n```\n', 'the table is closed after a failure');
    writeFileSync(sum, '');
    assert.equal(steps(['windows-timing'], { env, write: () => {}, bench: ['no-such-command-176', []] }), 1, 'a missing interpreter fails and still closes the fence');
    assert.match(readFileSync(sum, 'utf8'), /```\n$/);
  });
});
