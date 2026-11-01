// Tests of the temporary fast mode (tests/ci/fast-mode.mjs) and of the way ci.yml wires it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decide, parseFile, touchesFastMode } from './fast-mode.mjs';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'tests/ci/fast-mode.mjs');
const FILE = `# comment
name: demo
reason: because
owner: someone
expires: 2026-11-07
removal: delete the file
`;

describe('decide', () => {
  test('no file: nothing is skipped, on every event', () => {
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const d = decide({ event, text: null, today: '2026-11-01' });
      assert.deepEqual([d.ok, d.fast], [true, false], event);
    }
  });
  test('file present, not expired, pull_request: fast mode with a loud notice', () => {
    const d = decide({ event: 'pull_request', text: FILE, today: '2026-11-01' });
    assert.deepEqual([d.ok, d.fast], [true, true]);
    assert.match(d.notice, /^FAST MODE \(temporary, expires 2026-11-07, owner someone\)/);
    assert.match(d.notice, /SKIPPED/);
    assert.match(d.notice, /Invariants, equivalence, the Node tests and the static checks still ran/);
    assert.ok(!d.notice.includes('\n'));
  });
  test('the last day (the expiry date itself) still runs fast mode', () => {
    assert.equal(decide({ event: 'pull_request', text: FILE, today: '2026-11-07' }).fast, true);
  });
  test('push to main, schedule and workflow_dispatch always run everything', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      const d = decide({ event, text: FILE, today: '2026-11-01' });
      assert.deepEqual([d.ok, d.fast], [true, false], event);
    }
  });
  test('after the expiry date the job fails while the file exists, on every event', () => {
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const d = decide({ event, text: FILE, today: '2026-11-08' });
      assert.equal(d.ok, false, event);
      assert.match(d.errors[0], /FAST MODE EXPIRED on 2026-11-07/);
    }
  });
  test('a malformed file fails: a missing field, a bad date, a line that is no key', () => {
    assert.equal(decide({ event: 'pull_request', text: FILE.replace(/^owner:.*\n/m, ''), today: '2026-11-01' }).ok, false);
    assert.equal(decide({ event: 'pull_request', text: FILE.replace('2026-11-07', '2026-13-45'), today: '2026-11-01' }).ok, false);
    assert.equal(decide({ event: 'pull_request', text: FILE.replace('2026-11-07', 'next week'), today: '2026-11-01' }).ok, false);
    assert.equal(decide({ event: 'pull_request', text: FILE + 'garbage line\n', today: '2026-11-01' }).ok, false);
    assert.equal(decide({ event: 'pull_request', text: FILE.replace('removal: delete the file', 'removal:'), today: '2026-11-01' }).ok, false);
  });
  test('a pull request that changes the fast-mode file or any tests/ci/fast-mode.* file runs the full suite', () => {
    for (const f of ['tests/ci/fast-mode.txt', 'tests/ci/fast-mode.mjs', 'tests/ci/fast-mode.test.mjs']) {
      const d = decide({ event: 'pull_request', text: FILE, today: '2026-11-01', changed: ['README.md', f] });
      assert.deepEqual([d.ok, d.fast], [true, false], f);
    }
    assert.equal(decide({ event: 'pull_request', text: FILE, today: '2026-11-01', changed: ['README.md', 'tests/ci/classify.sh'] }).fast, true);
    assert.equal(touchesFastMode('tests/ci/fast-mode.txt'), true);
    assert.equal(touchesFastMode('tests/ci/other.mjs'), false);
  });
  test('a pull request that touches the files cannot be failed by an expired file (it is the way to remove it) and still runs everything', () => {
    const d = decide({ event: 'pull_request', text: FILE, today: '2027-01-01', changed: ['tests/ci/fast-mode.txt'] });
    assert.deepEqual([d.ok, d.fast], [true, false]);
  });
  test('parseFile skips comments and blank lines', () => {
    assert.deepEqual(Object.keys(parseFile(FILE)), ['name', 'reason', 'owner', 'expires', 'removal']);
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-'));
  const f = join(dir, 'fast-mode.txt');
  writeFileSync(f, FILE);
  const run = (...a) => spawnSync('node', [script, ...a], { encoding: 'utf8' });

  test('writes fast= and notice= to the GitHub output file and prints the banner', () => {
    const out = join(dir, 'out1');
    const r = run('--event', 'pull_request', '--file', f, '--today', '2026-11-02', '--github-output', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FAST MODE IS ACTIVE/);
    assert.match(r.stdout, /::warning title=FAST MODE::/);
    const o = readFileSync(out, 'utf8');
    assert.match(o, /^fast=true$/m);
    assert.match(o, /^notice=FAST MODE \(temporary/m);
  });
  test('fast=false on a push', () => {
    const out = join(dir, 'out2');
    const r = run('--event', 'push', '--file', f, '--today', '2026-11-02', '--github-output', out);
    assert.equal(r.status, 0);
    assert.match(readFileSync(out, 'utf8'), /^fast=false$/m);
  });
  test('exit 1 with an error annotation after the expiry date', () => {
    const r = run('--event', 'pull_request', '--file', f, '--today', '2026-11-08');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error title=FAST MODE::FAST MODE EXPIRED/);
  });
  test('--changed-file: a pull request that changes the fast-mode reader is fast=false', () => {
    const ch = join(dir, 'changed.txt');
    writeFileSync(ch, 'README.md\ntests/ci/fast-mode.mjs\n');
    const out = join(dir, 'out4');
    const r = run('--event', 'pull_request', '--file', f, '--today', '2026-11-02', '--changed-file', ch, '--github-output', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /changes the fast-mode files: full suite/);
    assert.match(readFileSync(out, 'utf8'), /^fast=false$/m);
    writeFileSync(ch, 'README.md\n');
    const out2 = join(dir, 'out5');
    assert.equal(run('--event', 'pull_request', '--file', f, '--today', '2026-11-02', '--changed-file', ch, '--github-output', out2).status, 0);
    assert.match(readFileSync(out2, 'utf8'), /^fast=true$/m);
  });
  test('a missing file is fast=false and exit 0', () => {
    const out = join(dir, 'out3');
    const r = run('--event', 'pull_request', '--file', join(dir, 'none.txt'), '--today', '2030-01-01', '--github-output', out);
    assert.equal(r.status, 0);
    assert.match(readFileSync(out, 'utf8'), /^fast=false$/m);
  });
  test('the committed file is valid and expires on 2026-11-07', () => {
    const text = readFileSync(join(repo, 'tests/ci/fast-mode.txt'), 'utf8');
    const kv = parseFile(text);
    assert.equal(kv.expires, '2026-11-07');
    assert.equal(decide({ event: 'pull_request', text, today: '2026-11-01' }).ok, true);
    assert.equal(decide({ event: 'pull_request', text, today: '2026-11-08' }).ok, false);
  });
  test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); assert.ok(!existsSync(dir)); });
});

// The workflow wiring: which jobs read the fast output, and which never may.
describe('ci.yml wiring', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  /** @param {string} name */
  const job = (name) => {
    const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(ci);
    assert.ok(m, `job ${name} exists`);
    return m[1];
  };
  test('the changes job decides fast mode from the BASE, not from the pull request tree', () => {
    const j = job('changes');
    assert.match(j, /notice: \$\{\{ steps\.mode\.outputs\.notice \|\| steps\.modeboot\.outputs\.notice \|\| steps\.modepush\.outputs\.notice \}\}/);
    assert.match(j, /git worktree add --detach "\$RUNNER_TEMP\/base" \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.match(j, /git cat-file -e \$\{\{ github\.event\.pull_request\.base\.sha \}\}:tests\/ci\/fast-mode\.mjs/);
    // the pull request step runs the base's script on the base's file with the changed paths
    assert.match(j, /node "\$RUNNER_TEMP\/base\/tests\/ci\/fast-mode\.mjs" --event pull_request --file "\$RUNNER_TEMP\/base\/tests\/ci\/fast-mode\.txt" --changed-file "\$RUNNER_TEMP\/fm-changed\.txt"/);
    const prStep = /- id: mode\n[\s\S]*?(?=\n      # Bootstrap)/.exec(j);
    assert.ok(prStep);
    assert.ok(!/run: node tests\/ci\/fast-mode/.test(prStep[0]), 'the pull request step never runs the pull request tree copy');
    // push, schedule and manual runs use the branch's own copy: fast=false there, expiry enforced
    assert.match(j, /- id: modepush\n[\s\S]*?if: github\.event_name != 'pull_request'\n\s+run: node tests\/ci\/fast-mode\.mjs/);
    assert.match(j, /name: FAST MODE ACTIVE/);
  });
  test('bootstrap: the head reader is used only when the base has no reader at all', () => {
    const j = job('changes');
    assert.match(j, /fast: \$\{\{ steps\.mode\.outputs\.fast \|\| steps\.modeboot\.outputs\.fast \|\| steps\.modepush\.outputs\.fast \}\}/);
    const boot = /- id: modeboot\n([\s\S]*?)(?=\n      - id: modepush)/.exec(j);
    assert.ok(boot);
    assert.match(boot[1], /if: github\.event_name == 'pull_request' && steps\.basehas\.outcome != 'success'/);
    assert.match(boot[1], /run: node tests\/ci\/fast-mode\.mjs --event pull_request --github-output/);
    const base = /- id: mode\n([\s\S]*?)(?=\n      # Bootstrap)/.exec(j);
    assert.ok(base);
    assert.match(base[1], /steps\.basehas\.outcome == 'success'/);
    assert.ok(!base[1].includes('run: node tests/ci/fast-mode'), 'the base rule never runs the head copy');
  });
  test('once the base has the reader, a head change to the fast-mode files means the full suite (script rule); the head file is not consulted', () => {
    const d = decide({ event: 'pull_request', text: FILE.replace('2026-11-07', '2099-01-01'), today: '2026-11-01', changed: ['tests/ci/fast-mode.txt'] });
    assert.equal(d.fast, false);
    const e = decide({ event: 'pull_request', text: FILE, today: '2026-11-01', changed: [] });
    assert.equal(e.fast, true);
  });
  test('the committed removal condition matches the CHANGELOG, CONTRIBUTING and A205 wording', () => {
    const kv = parseFile(readFileSync(join(repo, 'tests/ci/fast-mode.txt'), 'utf8'));
    assert.equal(kv.removal, 'expires 2026-11-07, or when Stage 12 (#177) lands, whichever is first; remove by deleting this file');
  });
  test('CODEOWNERS puts .github/ and tests/ci/ under the repository owner', () => {
    const co = readFileSync(join(repo, '.github/CODEOWNERS'), 'utf8');
    assert.match(co, /^\/\.github\/ @furkansarikaya$/m);
    assert.match(co, /^\/tests\/ci\/ @furkansarikaya$/m);
  });
  test('node --test gets globs, never a bare directory, in the jobs of this stage; the equivalence job has full history', () => {
    assert.match(job('equivalence'), /run: node --test "tests\/equivalence\/\*\.test\.mjs"/);
    assert.match(job('equivalence'), /actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
    assert.match(job('node-tests'), /node --test "tests\/ci\/\*\.test\.mjs" "tests\/enforcement\/\*\.test\.mjs" "tests\/core\/\*\.test\.mjs"/);
    for (const n of ['equivalence', 'node-tests', 'hook-node', 'types']) assert.ok(!/node --test tests\/[a-z]+\/(\s|$)/m.test(job(n)), n);
  });
  test('the equivalence job also runs the Core invariants with the engine switched to sh', () => {
    const j = job('equivalence');
    assert.match(j, /PROOFLINE_ENGINE: sh\n\s+run: sh tests\/invariants\/invariants-test\.sh/);
  });
  test('the heavy legacy jobs and the skill tests step are skipped by fast mode', () => {
    assert.match(job('selftest'), /needs\.changes\.outputs\.fast != 'true'/);
    assert.match(job('fixtures'), /needs\.changes\.outputs\.fast != 'true'/);
    const skill = /- name: skill tests\n([\s\S]*?)run:/.exec(job('static'));
    assert.ok(skill);
    assert.match(skill[1], /needs\.changes\.outputs\.fast != 'true'/);
  });
  test('invariants, equivalence, the Node tests, the type check and the static checks never read the fast output', () => {
    for (const n of ['invariants', 'equivalence', 'node-tests', 'hook-node', 'types']) assert.ok(!/outputs\.fast/.test(job(n)), n);
    const staticJob = job('static');
    const refs = staticJob.match(/^.*outputs\.fast.*$/gm) ?? [];
    assert.equal(refs.length, 1, 'only the skill tests step of the static job reads it');
    assert.match(refs[0], /needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.fast != 'true'/);
  });
  test('the checks job needs the new jobs and prints the notice in its summary', () => {
    const j = job('checks');
    for (const n of ['equivalence', 'node-tests', 'hook-node', 'types']) assert.match(j, new RegExp(`needs: \\[[^\\]]*\\b${n}\\b`), n);
    assert.match(j, /GITHUB_STEP_SUMMARY/);
    assert.match(j, /needs\.changes\.outputs\.notice/);
  });
});

describe('the Node hook is a pull request gate (hook-node)', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const j = (/^  hook-node:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n)/m.exec(ci) ?? [])[1] ?? '';
  test('the job exists, runs on Linux, is never skipped (no if: on the job, no fast output) and is in the checks needs', () => {
    assert.ok(j, 'job hook-node exists');
    assert.match(j, /runs-on: ubuntu-latest/);
    assert.ok(!/^    if:/m.test(j), 'the job has no job-level if');
    assert.ok(!/outputs\.fast|needs\.changes/.test(j), 'fast mode and the classifier are not read');
    assert.match(/^  checks:\n([\s\S]*)/m.exec(ci)?.[1] ?? '', /needs: \[[^\]]*\bhook-node\b/);
  });
  test('it runs the hook tests, the guard tests with GUARDS_HOOK, the wiring tests and the six shell suites with HOOK_UNDER_TEST on the .mjs hook', () => {
    assert.match(j, /HOOK_UNDER_TEST: \$\{\{ github\.workspace \}\}\/adapters\/claude\/hooks\/proofline-hook\.mjs/);
    assert.match(j, /GUARDS_HOOK: \$\{\{ github\.workspace \}\}\/adapters\/claude\/hooks\/proofline-hook\.mjs/);
    assert.match(j, /run: node --test "tests\/hook\/\*\.test\.mjs"/);
    assert.match(j, /run: node --test tests\/enforcement\/guards\.test\.mjs/);
    assert.match(j, /run: node --test tests\/enforcement\/wiring\.test\.mjs/);
    for (const s of ['enforcement-test', 'timeouts-test', 'kill-guard-test', 'merge-guard-test', 'platform-test', 'approval-load-test']) assert.match(j, new RegExp(`- suite: ${s}\\n\\s+node: '22\\.13\\.0'`), s);
    assert.match(j, /SELFTEST_ONLY: \$\{\{ matrix\.suite \}\}\n\s+run: sh tests\/selftest\.sh/);
  });
  test('the Node tests run on Node 22.13.0 and the active LTS', () => {
    assert.match(j, /- suite: node-tests\n\s+node: '22\.13\.0'/);
    assert.match(j, /- suite: node-tests\n\s+node: 'lts\/\*'/);
    assert.ok(!/\{suite:/.test(j), 'block style only: the repository YAML check rejects inline flow mappings with ": "');
  });
  test('every suite named in the matrix exists and honours HOOK_UNDER_TEST', () => {
    for (const s of ['enforcement-test', 'timeouts-test', 'kill-guard-test', 'merge-guard-test', 'platform-test', 'approval-load-test'])
      assert.match(readFileSync(join(repo, 'tests/enforcement', `${s}.sh`), 'utf8'), /HOOK_UNDER_TEST:-/, s);
  });
});
