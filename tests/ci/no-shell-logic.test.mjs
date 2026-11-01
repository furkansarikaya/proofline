// Tests of tests/ci/no-shell-logic.mjs (ratchet mode and the strict rule) on small throwaway git repositories.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { stepStrictProblem, runSteps, launcherOk, hookStrictProblem } from './no-shell-logic.mjs';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'tests/ci/no-shell-logic.mjs');

const CI = `name: t
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - name: legacy
        run: |
          if [ -f x ]; then echo a; fi
          echo b
      - name: simple
        run: node tests/ci/no-shell-logic.mjs
      - run: echo "\${{ github.sha }}"
`;
const WIRING = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: "sh -c 'exec sh \"$h\" pretool claude'", timeout: 30 }] }] } }, null, 2);

function git(dir, ...a) { return spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); }
function put(dir, rel, text, mode) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); if (mode) chmodSync(join(dir, rel), mode); }
function run(dir, ...args) { return spawnSync('node', [script, '--root', dir, ...args], { encoding: 'utf8' }); }

// A repository in the state of "0.0.40": two shell files, a legacy multi-line step, a hook string, and both snapshots recorded.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nsl-'));
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'scripts/a.sh', '#!/bin/sh\necho a\n');
  put(dir, 'bin/tool', '#!/usr/bin/env bash\necho tool\n', 0o755);
  put(dir, 'githooks/pre-commit', '#!/bin/sh\nexit 0\n');
  put(dir, 'README.md', '```sh\nif true; then echo md; fi\n```\n');
  put(dir, 'lib/x.mjs', 'export default 1;\n');
  put(dir, '.github/workflows/ci.yml', CI);
  put(dir, 'adapters/claude/hooks/hooks.json', WIRING);
  git(dir, 'add', '-A');
  const allow = run(dir, '--print-allowlist').stdout;
  const snap = run(dir, '--print-snapshot').stdout;
  put(dir, 'tests/ci/shell-allowlist.txt', allow);
  put(dir, 'tests/ci/inline-shell-snapshot.txt', snap);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const cleanup = (d) => rmSync(d, { recursive: true, force: true });

describe('ratchet mode', () => {
  test('passes on the recorded state, ignoring Markdown snippets and non-shell files', () => {
    const d = fixture();
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    cleanup(d);
  });

  test('the recorded state lists the shell files by extension, shebang and githooks folder', () => {
    const d = fixture();
    assert.equal(readFileSync(join(d, 'tests/ci/shell-allowlist.txt'), 'utf8'), 'bin/tool\ngithooks/pre-commit\nscripts/a.sh\n');
    cleanup(d);
  });

  test('fails on a planted new shell file (extension)', () => {
    const d = fixture();
    put(d, 'scripts/new.sh', '#!/bin/sh\necho new\n'); git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scripts\/new\.sh: a new shell file/);
    cleanup(d);
  });
  test('fails on a planted new shell file (shebang only, no extension)', () => {
    const d = fixture();
    put(d, 'bin/other', '#!/usr/bin/env zsh\necho z\n', 0o755); git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bin\/other: a new shell file/);
    cleanup(d);
  });
  test('fails on a planted new file under a githooks folder', () => {
    const d = fixture();
    put(d, 'control/githooks/post-merge', 'anything\n'); git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /githooks\/post-merge: a new shell file/);
    cleanup(d);
  });
  test('an allowlist entry whose file is gone must be removed', () => {
    const d = fixture();
    git(d, 'rm', '-q', '-f', 'scripts/a.sh');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"scripts\/a\.sh" is no longer a shell file; remove the entry/);
    writeFileSync(join(d, 'tests/ci/shell-allowlist.txt'), 'bin/tool\ngithooks/pre-commit\n');
    assert.equal(run(d).status, 0);
    cleanup(d);
  });

  test('fails on a planted new multi-line run: step', () => {
    const d = fixture();
    put(d, '.github/workflows/ci.yml', CI + '      - name: planted\n        run: |\n          echo one\n          echo two\n');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /build::step\d+ \(line \d+\): a new or changed run: step must meet the strict rule: 2 command lines/);
    cleanup(d);
  });
  test('fails on a planted new single-line step that has logic in it', () => {
    const d = fixture();
    put(d, '.github/workflows/ci.yml', CI + '      - run: test -f x && echo yes\n');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /&& at column/);
    cleanup(d);
  });
  test('a new single-command step passes, and defaults: run: is not a step', () => {
    const d = fixture();
    put(d, '.github/workflows/ci.yml', CI + '      - run: node --test tests/ci/\n');
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    cleanup(d);
  });
  test('a changed legacy step fails twice: its new text is not strict, its old entry matches nothing', () => {
    const d = fixture();
    put(d, '.github/workflows/ci.yml', CI.replace('echo b', 'echo c'));
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must meet the strict rule: 2 command lines/);
    assert.match(r.stderr, /matches no step or string any more; remove the entry/);
    cleanup(d);
  });
  test('a legacy step made strict passes once its snapshot line is removed', () => {
    const d = fixture();
    put(d, '.github/workflows/ci.yml', CI.replace(/ {8}run: \|\n {10}if \[ -f x \]; then echo a; fi\n {10}echo b\n/, '        run: sh tests/legacy.sh\n'));
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /remove the entry/);
    const kept = readFileSync(join(d, 'tests/ci/inline-shell-snapshot.txt'), 'utf8').split('\n').filter((l) => l && !l.includes('::step2'));
    writeFileSync(join(d, 'tests/ci/inline-shell-snapshot.txt'), kept.join('\n') + '\n');
    const r2 = run(d);
    assert.equal(r2.status, 0, r2.stderr);
    cleanup(d);
  });
  test('moving a recorded step inside its job is not a change', () => {
    const d = fixture();
    const moved = CI.replace('      - uses: actions/checkout@v4\n', '      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n');
    put(d, '.github/workflows/ci.yml', moved);
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    cleanup(d);
  });

  test('fails on a planted changed hook string', () => {
    const d = fixture();
    put(d, 'adapters/claude/hooks/hooks.json', WIRING.replace('pretool claude', 'pretool claude; echo extra'));
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PreToolUse::0: a new or changed hook command string must meet the strict rule: no pinned hook template exists yet/);
    cleanup(d);
  });
  test('a hook string that equals a pinned template passes and its old entry is then removed', () => {
    const d = fixture();
    const next = `node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" pretool claude`;
    put(d, 'adapters/claude/hooks/hooks.json', WIRING.replace(/"command": "[^\n]*",/, `"command": ${JSON.stringify(next)},`));
    put(d, 'tests/ci/hook-templates.txt', '# pinned by stage 3\nnode "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" <event> <runtime>\n');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /strict rule/);
    assert.match(r.stderr, /remove the entry/);
    writeFileSync(join(d, 'tests/ci/inline-shell-snapshot.txt'), readFileSync(join(d, 'tests/ci/inline-shell-snapshot.txt'), 'utf8').split('\n').filter((l) => l && !l.includes('hooks.json')).join('\n') + '\n');
    assert.equal(run(d).status, 0);
    cleanup(d);
  });
  test('a deleted hook string leaves a stale entry', () => {
    const d = fixture();
    put(d, 'adapters/claude/hooks/hooks.json', JSON.stringify({ hooks: {} }));
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hooks\.json::PreToolUse::0" matches no step or string any more/);
    cleanup(d);
  });

  test('F4: a new shell file with a ksh, csh or fish shebang is refused', () => {
    for (const sb of ['#!/bin/ksh', '#!/usr/bin/env ksh', '#!/bin/csh -f', '#!/usr/bin/env -S fish']) {
      const d = fixture();
      put(d, 'bin/odd', `${sb}\necho x\n`, 0o755); git(d, 'add', '-A');
      const r = run(d);
      assert.equal(r.status, 1, sb);
      assert.match(r.stderr, /bin\/odd: a new shell file/, sb);
      cleanup(d);
    }
  });
  test('F4: .husky and .githooks files are shell files even without a shebang', () => {
    for (const f of ['.husky/pre-commit', '.githooks/pre-push', '.husky/_/helper']) {
      const d = fixture();
      put(d, f, 'npm test\n'); git(d, 'add', '-A');
      const r = run(d);
      assert.equal(r.status, 1, f);
      assert.match(r.stderr, new RegExp(`${f.replace(/[.\/]/g, '\\$&')}: a new shell file`), f);
      cleanup(d);
    }
  });
  test('F4: a composite action run: step is scanned (indented by 4)', () => {
    const d = fixture();
    put(d, '.github/actions/a/action.yml', 'name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: curl x | sh\n'); git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /actions\/a\/action\.yml::composite::step1 \(line 6\): .*pipe at column/);
    put(d, '.github/actions/a/action.yml', 'name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node tests/ci/x.mjs\n');
    assert.equal(run(d).status, 0);
    cleanup(d);
  });
  test('F4: run: keys are found at any indentation (4-space workflow)', () => {
    const d = fixture();
    const wf = 'name: w\non: [push]\njobs:\n    job1:\n        runs-on: x\n        defaults:\n            run:\n                shell: bash\n        steps:\n            - name: bad\n              run: |\n                  a\n                  b\n            - run: c && d\n';
    put(d, '.github/workflows/w.yml', wf); git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /w\.yml::job1::step1 \(line 11\): .*2 command lines/);
    assert.match(r.stderr, /w\.yml::job1::step2 \(line 14\): .*&& at column/);
    assert.doesNotMatch(r.stderr, /defaults/);
    cleanup(d);
  });

  test('--base: an entry added to a snapshot since the base is refused', () => {
    const d = fixture();
    put(d, 'scripts/new.sh', '#!/bin/sh\necho new\n');
    writeFileSync(join(d, 'tests/ci/shell-allowlist.txt'), readFileSync(join(d, 'tests/ci/shell-allowlist.txt'), 'utf8') + 'scripts/new.sh\n');
    git(d, 'add', '-A');
    assert.equal(run(d).status, 0);
    const r = run(d, '--base', 'HEAD');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"scripts\/new\.sh" was added since HEAD; entries may only disappear/);
    cleanup(d);
  });
  test('--base: a snapshot line that was changed since the base is refused, a removal is fine', () => {
    const d = fixture();
    const f = join(d, 'tests/ci/inline-shell-snapshot.txt');
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    writeFileSync(f, ['0'.repeat(64) + ' .github/workflows/ci.yml::build::step9', ...lines].join('\n') + '\n');
    const r = run(d, '--base', 'HEAD');
    assert.match(r.stderr, /was added or changed since HEAD/);
    writeFileSync(f, lines.slice(0, 1).join('\n') + '\n');
    const r2 = run(d, '--base', 'HEAD');
    assert.doesNotMatch(r2.stderr, /since HEAD/);
    cleanup(d);
  });
  test('a missing snapshot file fails', () => {
    const d = fixture();
    rmSync(join(d, 'tests/ci/inline-shell-snapshot.txt'));
    git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /inline-shell-snapshot\.txt is missing/);
    cleanup(d);
  });
});

describe('the strict rule', () => {
  const ok = ['node tests/ci/x.mjs', 'sh tests/selftest.sh', 'echo "a|b; c && d"', "grep -E 'a|b' file", 'echo ${{ github.sha }} > $GITHUB_OUTPUT', 'node --test a \\\n  b', 'echo a >&2'];
  /** @type {[string, RegExp][]} */
  const bad = [
    ['if [ -f x ]; then echo; fi', /shell syntax/],
    ['for f in a b; do echo $f; done', /shell syntax/],
    ['a && b', /&&/],
    ['a || b', /\|\|/],
    ['a | b', /pipe/],
    ['a; b', /;/],
    ['echo $(date)', /substitution/],
    ['echo "$(date)"', /substitution/],
    ['echo `date`', /substitution/],
    ['a &', /&/],
    ['one\ntwo', /2 command lines/],
    ['', /empty/],
  ];
  for (const t of ok) test(`passes: ${JSON.stringify(t)}`, () => assert.equal(stepStrictProblem(t), ''));
  for (const [t, re] of bad) test(`fails: ${JSON.stringify(t)}`, () => assert.match(stepStrictProblem(t), re));

  test('launchers: a shebang and one exec node line', () => {
    assert.ok(launcherOk('#!/bin/sh\nexec node "$(dirname "$0")/proofline-core.mjs" "$@"\n'));
    assert.ok(launcherOk('#!/bin/sh\n# comment\n\nexec node "$(dirname "$0")/proofline-core.mjs" dispatch "$@"\n'));
    assert.ok(!launcherOk('#!/bin/sh\nset -u\nexec node "$(dirname "$0")/proofline-core.mjs" "$@"\n'));
    assert.ok(!launcherOk('#!/bin/sh\nif true; then exec node "$(dirname "$0")/x.mjs" "$@"; fi\n'));
    assert.ok(!launcherOk('#!/bin/sh\nexec node /abs/proofline-core.mjs "$@"\n'));
    // the git hook form (no "$@", the core in ../scripts/) and planted launchers that carry extra logic
    assert.ok(launcherOk('#!/bin/sh\nexec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit\n'));
    for (const bad of [
      'exec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit; rm -rf x',
      'exec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit && true',
      'exec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli $(id)',
      'exec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit | tee x',
      'exec node "$(dirname "$0")/../../x.mjs" cli pre-commit',
      'exec node "$(dirname "$0")/../scripts/../x.mjs" cli pre-commit',
      'exec node "$(dirname "$0")/../scripts/a/b.mjs" cli pre-commit',
      'exec node "$(dirname "$0")/../other/proofline-core.mjs" cli pre-commit',
      'exec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit "$@" "$@"',
      'exec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit > /dev/null',
      '[ -n "$X" ] || exit 0',
      'node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-commit',
    ]) assert.ok(!launcherOk(`#!/bin/sh\n${bad}\n`), bad);
    assert.ok(!launcherOk('#!/bin/sh\nexec node "$(dirname "$0")/../scripts/a.mjs" cli pre-commit\nexec node "$(dirname "$0")/../scripts/b.mjs"\n'));
  });
  test('hook templates', () => {
    assert.match(hookStrictProblem('x', []), /no pinned hook template/);
    assert.equal(hookStrictProblem('node a.mjs pretool claude', ['node a.mjs <event> <runtime>']), '');
    assert.match(hookStrictProblem('node a.mjs pretool claude; rm', ['node a.mjs <event> <runtime>']), /pinned/);
  });
  test('the step scanner reads inline, block and quoted run: values and skips defaults: run:', () => {
    const steps = runSteps('f.yml', CI);
    assert.deepEqual(steps.map((s) => s.index), [2, 3, 4]);
    assert.equal(steps[0].text, 'if [ -f x ]; then echo a; fi\necho b');
    assert.equal(steps[1].text, 'node tests/ci/no-shell-logic.mjs');
    assert.equal(steps[2].text, 'echo "${{ github.sha }}"');
  });
  test('strict mode: every shell file outside the launcher list fails, a clean tree passes', () => {
    const d = fixture();
    const r = run(d, '--strict');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scripts\/a\.sh: a shell file that is not in the launcher list/);
    assert.match(r.stderr, /step\d+ \(?.*|step\d+: 2 command lines/);
    cleanup(d);
  });
});

describe('the repository itself', () => {
  test('the ratchet passes on this checkout', () => {
    const r = spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
  test('the committed allowlist names only tracked shell files and the 0.0.40 launchers are in it', () => {
    const t = readFileSync(join(repo, 'tests/ci/shell-allowlist.txt'), 'utf8').split('\n').filter(Boolean);
    for (const f of ['control-plane/agents/scripts/agent.sh', 'control-plane/agents/scripts/dispatch.sh', 'control-plane/agents/githooks/pre-commit', 'control-plane/agents/githooks/pre-push', 'bin/proofline', 'adapters/claude/hooks/proofline-hook.sh']) assert.ok(t.includes(f), f);
  });
});
