// Tests of tests/ci/no-shell-logic.mjs (the strict check, A251) on small throwaway git repositories: a clean repository passes, every rule fails on its planted violation.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { check, stepStrictProblem, runSteps, launcherOk, hookStrictProblem, parseLauncherTemplates, LAUNCHERS, nodeSpawnProblems, stripComments, trackedFiles, nodeSourceFile } from './no-shell-logic.mjs';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'tests/ci/no-shell-logic.mjs');
const TEMPLATES = readFileSync(join(repo, 'tests/ci/launcher-templates.txt'), 'utf8');
const HOOK_TEMPLATES = readFileSync(join(repo, 'tests/ci/hook-templates.txt'), 'utf8');

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
const CLEAN_CI = CI.replace(/ {6}- name: legacy\n {8}run: \|\n {10}if \[ -f x \]; then echo a; fi\n {10}echo b\n/, '');
const HOOK = 'node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" pretool claude || test ! -f "$CLAUDE_PROJECT_DIR/.agents/config.yaml" || { echo "proofline: the hook did not start (node 22.13 or newer must be on PATH); failing closed" >&2; exit 2; }';
const WIRING = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: HOOK, timeout: 30 }] }] } }, null, 2);

function git(dir, ...a) { return spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); }
function put(dir, rel, text, mode) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); if (mode) chmodSync(join(dir, rel), mode); }
function run(dir, ...args) { return spawnSync('node', [script, '--root', dir, ...args], { encoding: 'utf8' }); }
/** The Node-scan problems of one file (a throwaway repository would cost a git init per case; the scan reads tracked files, so it is run on a one-file stand-in). */
function nodeSpawnProblemsOf(code) {
  const d = sharedFixture();
  try { put(d, 'lib/probe.mjs', code); git(d, 'add', '-A'); return nodeSpawnProblems(d); } finally { reset(d); }
}
const cleanup = (d) => rmSync(d, { recursive: true, force: true });

// A clean repository: the four launchers and their templates (the real ones), a hook wiring file with a pinned string, one-command CI steps, a Node file.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nsl-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, text] of parseLauncherTemplates(TEMPLATES)) put(dir, f, text, 0o755);
  put(dir, 'tests/ci/launcher-templates.txt', TEMPLATES);
  put(dir, 'tests/ci/hook-templates.txt', HOOK_TEMPLATES);
  put(dir, 'README.md', '```sh\nif true; then echo md; fi\n```\n');
  put(dir, 'lib/x.mjs', "import { spawnSync } from 'node:child_process';\nexport const v = () => spawnSync('git', ['--version']);\n");
  put(dir, '.github/workflows/ci.yml', CLEAN_CI);
  put(dir, 'adapters/claude/hooks/hooks.json', WIRING);
  git(dir, 'add', '-A');
  return dir;
}
// One committed clean fixture for the planted-violation cases of this file (they run one after the other); every case plants into it and resets it afterwards, so the
// `git init`, the file writes and the first `git add` are paid once, not once per case (A251 round 3).
/** @type {string | undefined} */ let shared;
function sharedFixture() {
  if (!shared) { shared = fixture(); git(shared, 'commit', '-q', '-m', 'clean'); }
  return shared;
}
after(() => { if (shared) cleanup(shared); });
const reset = (d) => { git(d, 'reset', '-q', '--hard', 'HEAD'); git(d, 'clean', '-q', '-fdx'); };
/** Plant a violation in the shared clean fixture, check it is refused with a message matching RE, and reset the fixture. */
function refuses(plant, re, label) {
  const d = sharedFixture();
  try {
    plant(d);
    git(d, 'add', '-A');
    const problems = check(d);
    assert.notEqual(problems.length, 0, `${label}: nothing was refused`);
    assert.match(problems.join('\n'), re, label);
  } finally { reset(d); }
}

describe('strict mode: the clean state and a planted violation of every rule', () => {
  test('the shared fixture is clean (checked once; every planted case starts from it)', () => assert.deepEqual(check(sharedFixture()), []));
  test('a clean repository passes (Markdown snippets are not code); --strict is still accepted', () => {
    const d = fixture();
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok \(strict\)/);
    assert.equal(run(d, '--strict').status, 0);
    cleanup(d);
  });
  test('an unknown argument is refused, the ratchet flags are gone', () => {
    const d = fixture();
    for (const a of ['--base', '--print-snapshot', '--print-allowlist']) assert.equal(run(d, a, 'HEAD').status, 2, a);
    cleanup(d);
  });

  test('rule 1: a new .sh file', () => refuses((d) => put(d, 'scripts/new.sh', '#!/bin/sh\necho new\n'), /scripts\/new\.sh: a shell file that is not in the launcher list/, 'new .sh'));
  test('rule 1: a new file with a shell shebang and no extension (also ksh, csh, fish)', () => {
    for (const sb of ['#!/usr/bin/env zsh', '#!/bin/ksh', '#!/bin/csh -f', '#!/usr/bin/env -S fish']) refuses((d) => put(d, 'bin/other', `${sb}\necho z\n`, 0o755), /bin\/other: a shell file that is not in the launcher list/, sb);
  });
  test('rule 1: any file under a githooks, .githooks or .husky folder', () => {
    for (const f of ['control/githooks/post-merge', '.husky/pre-commit', '.githooks/pre-push', '.husky/_/helper']) refuses((d) => put(d, f, 'npm test\n'), /a shell file that is not in the launcher list/, f);
  });
  test('rule 1: an .awk file', () => refuses((d) => put(d, 'lib/prog.awk', '{ print }\n'), /lib\/prog\.awk: an \.awk file/, 'awk file'));

  test('rule 2: an `if` in a plain launcher (dispatch.sh and a git hook)', () => {
    refuses((d) => { const f = join(d, 'control-plane/agents/scripts/dispatch.sh'); writeFileSync(f, readFileSync(f, 'utf8').replace('exec node', 'if true; then :; fi\nexec node')); },
      /dispatch\.sh: a launcher must be byte-equal to its template/, 'if in dispatch.sh');
    refuses((d) => writeFileSync(join(d, 'control-plane/agents/githooks/pre-push'), '#!/bin/sh\n[ -n "$X" ] || exit 0\nexec node "$(dirname "$0")/../scripts/proofline-core.mjs" cli pre-push\n'),
      /pre-push: a launcher must be byte-equal/, 'logic in pre-push');
  });
  test('rule 2: any change of agent.sh, even one that keeps the redirect (an added command, the exit-127 tightening dropped, the redirect loosened, a trailing newline)', () => {
    const f = 'control-plane/agents/scripts/agent.sh';
    const text = parseLauncherTemplates(TEMPLATES).get(f) ?? '';
    const tighten = /^case \$\(cd "\$root" && pwd -P\) in .*\n/m;
    assert.match(text, tighten, 'the template carries the tightening');
    assert.ok(text.includes(' [ -z "$main" ] ||'));
    refuses((d) => writeFileSync(join(d, f), text.replace('exec node', 'rm -rf /tmp/x\nexec node')), /agent\.sh: a launcher must be byte-equal/, 'added command');
    refuses((d) => writeFileSync(join(d, f), text.replace(tighten, '')), /agent\.sh: a launcher must be byte-equal/, 'the exit-127 tightening dropped');
    refuses((d) => writeFileSync(join(d, f), text.replace(' [ -z "$main" ] ||', '')), /agent\.sh: a launcher must be byte-equal/, 'the redirect loosened');
    refuses((d) => writeFileSync(join(d, f), `${text}\n`), /agent\.sh: a launcher must be byte-equal/, 'a trailing newline');
  });
  test('rule 2: the template is the pin: a launcher without a template, a template for a stranger, a plain launcher template with logic, a missing launcher, no template file, a duplicate section', () => {
    refuses((d) => put(d, 'tests/ci/launcher-templates.txt', TEMPLATES.replace(/^@@ control-plane\/agents\/scripts\/dispatch\.sh\n[^@]*/m, '')), /dispatch\.sh: no template in/, 'no template');
    refuses((d) => put(d, 'tests/ci/launcher-templates.txt', `${TEMPLATES}@@ lib/other.sh\n#!/bin/sh\necho x\n`), /a template for lib\/other\.sh, which is not in the launcher list/, 'stranger');
    refuses((d) => {
      const bad = '#!/bin/sh\nif true; then :; fi\nexec node "$(dirname "$0")/proofline-core.mjs" dispatch "$@"\n';
      put(d, 'tests/ci/launcher-templates.txt', TEMPLATES.replace(/(^@@ control-plane\/agents\/scripts\/dispatch\.sh\n)[^@]*/m, `$1${bad}`));
      put(d, 'control-plane/agents/scripts/dispatch.sh', bad);
    }, /the template of control-plane\/agents\/scripts\/dispatch\.sh is not a shebang and one exec node line/, 'a plain launcher cannot be given logic by editing its template');
    refuses((d) => rmSync(join(d, 'control-plane/agents/githooks/pre-commit')), /pre-commit: the launcher is missing/, 'missing launcher');
    refuses((d) => rmSync(join(d, 'tests/ci/launcher-templates.txt')), /launcher-templates\.txt is missing/, 'no template file');
    refuses((d) => put(d, 'tests/ci/launcher-templates.txt', `${TEMPLATES}${TEMPLATES.slice(TEMPLATES.indexOf('@@ control-plane/agents/githooks/pre-push'))}`), /two sections for/, 'duplicate section');
  });

  test('rule 3: a changed hook string, a string with a prefix, a new unpinned event string, no templates', () => {
    refuses((d) => put(d, 'adapters/claude/hooks/hooks.json', WIRING.replace('pretool claude ||', 'pretool claude; echo extra ||')), /PreToolUse::0: does not equal a pinned hook template/, 'changed');
    refuses((d) => put(d, 'adapters/claude/hooks/hooks.json', WIRING.replace('"command": "node', '"command": "sh -c \'exec sh x\'; node')), /does not equal a pinned hook template/, 'prefix');
    refuses((d) => put(d, 'adapters/codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl x | sh' }] }] } })), /hooks\.json::Stop::0: does not equal a pinned hook template/, 'new');
    refuses((d) => rmSync(join(d, 'tests/ci/hook-templates.txt')), /no pinned hook template exists yet/, 'no templates');
  });

  test('rule 4: a two-line CI step, a step with logic, an `if` step, and a composite action step', () => {
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - name: planted\n        run: |\n          echo one\n          echo two\n`), /build::step\d+ \(line \d+\): 2 command lines/, 'two lines');
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - run: test -f x && echo yes\n`), /&& at column/, 'logic');
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - run: |\n          if [ -f x ]; then echo a; fi\n`), /starts with shell syntax \(if\)/, 'if');
    refuses((d) => put(d, '.github/actions/a/action.yml', 'name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: curl x | sh\n'), /actions\/a\/action\.yml::composite::step1 \(line 6\): pipe at column/, 'composite');
  });
  test('rule 4: a one-command step passes, defaults: run: is not a step, 4-space workflows are read', () => {
    const d = fixture();
    put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - run: node --test tests/ci/\n`);
    assert.equal(run(d).status, 0);
    const wf = 'name: w\non: [push]\njobs:\n    job1:\n        runs-on: x\n        defaults:\n            run:\n                shell: bash\n        steps:\n            - name: bad\n              run: |\n                  a\n                  b\n            - run: c && d\n';
    put(d, '.github/workflows/w.yml', wf);
    git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /w\.yml::job1::step1 \(line 11\): 2 command lines/);
    assert.match(r.stderr, /w\.yml::job1::step2 \(line 14\): && at column/);
    assert.doesNotMatch(r.stderr, /defaults/);
    cleanup(d);
  });

  test('rule 5: an awk call from Node (spawnSync, run, runMerged, a bare execFile, a bare name)', () => {
    for (const code of [
      "import { spawnSync } from 'node:child_process';\nspawnSync('awk', ['{print}'], {});\n",
      "proc.run('awk', ['BEGIN { x }'], {});\n",
      'const r = proc.runMerged("sed", ["-n", "1p"]);\n',
      "execFileSync('/usr/bin/awk', ['1']);\n",
      "const tool = 'gawk';\n",
    ]) refuses((d) => put(d, 'lib/bad.mjs', code), /lib\/bad\.mjs:\d+: a text tool \(awk or sed\) is named as a string/, code);
  });
  test('rule 5: sh or bash started from Node outside proc.mjs (a script file, a -c string, a vector, a wrapper with a first argument)', () => {
    for (const code of [
      "proc.run('sh', [script, ...args], {});\n",
      "spawnSync('bash', ['-c', cmd]);\n",
      "const argv = ['sh', '-c', text];\n",
      "runWithTimeout(5, ['/bin/sh', '-c', c], {});\n",
      "budget.runWithBudget(1, 'sh', args, {});\n",
      'execFile("dash", [file]);\n',
      "proc.spawnDetached(`zsh`, ['x']);\n",
    ]) refuses((d) => put(d, 'control-plane/agents/scripts/core/bad.mjs', code), /bad\.mjs:\d+: a shell is started from Node outside core\/proc\.mjs/, code);
  });
  test('rule 5: what is allowed: proc.mjs itself, runScript / runUserCommand callers, comments, plain word lists, tests and docs, and hook guards that name awk as data', () => {
    const d = fixture();
    put(d, 'control-plane/agents/scripts/core/proc.mjs', "export const SCRIPT_SHELL = 'sh';\nexport function userShellArgv(t) { return ['/bin/sh', '-c', t]; }\nrun('awk', []);\n");
    put(d, 'control-plane/agents/scripts/core/ok.mjs', "// proc.run('sh', ['-c', x]) is how the shell did it; awk and sed are gone\n/**\n * proc.run('bash', [a])\n */\nproc.runScript([agent, 'next']);\nproc.runUserCommand(text);\nconst names = ['sh', 'bash', 'zsh'].includes(w);\nconst n = shellName.endsWith('zsh');\n");
    put(d, 'adapters/claude/hooks/guards/kill.mjs', "const L = ['awk', 'gawk', 'sed'];\nruns.push(['sh', path]);\n");
    put(d, 'tests/core/x.test.mjs', "spawnSync('awk', ['1']); spawnSync('sh', ['-c', 'x']);\n");
    put(d, 'docs/x.mjs', "spawnSync('awk', []);\n");
    git(d, 'add', '-A');
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    cleanup(d);
  });
  test('rule 5: a guard module does not get to start a shell either', () => refuses((d) => put(d, 'adapters/claude/hooks/guards/x.mjs', "proc.run('sh', ['-c', 'x']);\n"), /guards\/x\.mjs:1: a shell is started from Node/, 'guard'));
  test('rule 5 (round 1): implicit shells and lines the first version missed: execSync, exec, shell option, a call head over several lines, powershell, cmd.exe, .ts files', () => {
    for (const [file, code] of /** @type {[string, string][]} */ ([
      ['lib/a.mjs', "import { execSync } from 'node:child_process';\nexecSync('ls | wc');\n"],
      ['lib/a.mjs', "import { exec } from 'node:child_process';\nexec('ls | wc', cb);\n"],
      ['lib/a.mjs', "import cp from 'node:child_process';\ncp.exec('ls | wc');\n"],
      ['lib/a.mjs', "spawn('ls', [], { shell: true });\n"],
      ['lib/a.mjs', "spawnSync('ls', [], { shell: '/bin/zsh' });\n"],
      ['lib/a.mjs', "spawnSync(\n  'sh',\n  ['x.sh']\n);\n"],
      ['lib/a.mjs', "proc.run(\n  cwd,\n  'bash', ['-c', c]);\n"],
      ['lib/a.mjs', "spawnSync('powershell', ['-Command', c]);\n"],
      ['lib/a.mjs', "spawnSync('cmd.exe', ['/c', c]);\n"],
      ['lib/a.ts', "spawnSync('sh', ['x']);\n"],
      ['lib/a.mts', "spawnSync('awk', ['1']);\n"],
    ])) refuses((d) => put(d, file, code), /lib\/a\.m?ts?:\d+|lib\/a\.mjs:\d+/, `${file}: ${code}`);
  });
  test('rule 5 (round 1): what stays allowed: RegExp exec, an exec alias of execFile, shell: false, a URL in a string, a spawn named in a whole-line comment', () => {
    const d = fixture();
    put(d, 'lib/ok.mjs', "const m = /a/.exec(s);\nimport { execFile as exec } from 'node:child_process';\nexec(bin, args, { shell: false });\nconst u = 'https://example.com/x';\n// spawnSync('awk')\n/* execSync('x') */\n");
    git(d, 'add', '-A');
    assert.deepEqual(check(d), []);
    cleanup(d);
  });
  test('rule 3 (round 1): a fourth hooks file or a settings file is scanned, not only the three of 0.0.40', () => {
    const wire = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stop codex; id' }] }] } });
    refuses((d) => put(d, 'adapters/codex/hooks2.json', wire), /hooks2\.json::Stop::0: does not equal a pinned hook template/, 'hooks2');
    refuses((d) => put(d, 'extra/settings.local.json', wire), /settings\.local\.json::Stop::0/, 'settings');
    refuses((d) => put(d, 'extra/hooks.json', '{ not json'), /hooks\.json::file::0: does not equal a pinned hook template/, 'not json');
  });
  test('rule 4 (round 1): CRLF, flow style, double-quoted \\n, github-script and shell templates are refused, not passed', () => {
    refuses((d) => put(d, '.github/workflows/ci.yml', CLEAN_CI.replace(/\n/g, '\r\n') + '      - run: |\r\n          echo one\r\n          echo two\r\n'), /2 command lines/, 'CRLF');
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - run: "echo a\\necho b"\n`), /2 command lines/, 'quoted newline');
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - {name: a, run: "a && b"}\n`), /run: inside a flow mapping/, 'flow item');
    refuses((d) => put(d, '.github/workflows/ci.yml', CLEAN_CI.replace('    steps:\n', '    steps: [{run: "a && b"}]\n')), /flow-style steps list/, 'flow steps');
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - uses: actions/github-script@v7\n        with:\n          script: |\n            if (x) { y(); }\n`), /script: key/, 'github-script');
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - run: x\n        shell: bash -e {0}\n`), /shell: template/, 'shell template');
  });
  test('rule 2 (round 1): a launcher that lost its executable bit in the index is refused', () => {
    refuses((d) => chmodSync(join(d, 'control-plane/agents/githooks/pre-commit'), 0o644), /pre-commit: a launcher must be executable in the index \(mode 100755, found 100644\)/, 'chmod -x');
  });
  test('round 3: stripComments blanks only whole-line comments; everything else stays visible (the gate errs toward visibility)', () => {
    const keep = (/** @type {string} */ src) => assert.equal(stripComments(src), src, src);
    // real code after a regex literal that follows =>, return, else, + : each of these hid the rest of the line before
    keep("const t = (p) => /a\\//.test(p); execSync('ls | wc');\n");
    keep("function f(p) { return /a\\//.test(p) || execSync('x'); }\n");
    keep("const n = 1 + /x\\//.source; execSync('x');\n");
    keep("if (a) b(); else /x\\//.test(c); execSync('x');\n");
    // an odd quote or backtick inside a regex, nested templates, a template that holds //
    keep("const r = (p) => /it's/.test(p); execSync('x');\n");
    keep("const r = (p) => /`/.test(p); // note\nexecSync('x');\n");
    keep("const s = `a${`b${1}//`}c`; execSync('r');\n");
    keep("const u = 'http://x'; execSync('r');\n");
    // trailing comments and a mid-line block comment are not blanked (false-positive direction, documented)
    keep("x = 1; // execSync('x')\n");
    keep("x = 1; /* execSync('x') */\n");
    keep("const a = 'x/*y'; execSync('z');\n");
    // whole-line comments are blanked, line breaks kept
    assert.equal(stripComments('// <slug>/*.md\nexecSync(a);\n'), '              \nexecSync(a);\n');
    assert.equal(stripComments("  // execSync('x')\ny"), "                  \ny");
    assert.equal(stripComments("/* execSync('x') */\ny"), "                   \ny");
    assert.equal(stripComments("/*\n * execSync('x')\n */\ny"), "  \n" + " ".repeat(16) + "\n   \ny");
    assert.equal(stripComments("/* a */ execSync('x');"), "        execSync('x');");
    assert.equal(stripComments("/*\n x\n*/ execSync('x');"), "  \n  \n   execSync('x');");
    assert.equal(stripComments('x /* open\nmore'), 'x /* open\nmore');
    assert.equal(stripComments('/* open'), '       ');
  });
  test('round 3: a block comment alone on its lines hides its text, a mid-line one does not; hidden real code is never the result', () => {
    const tail = "import { execSync } from 'node:child_process';\n";
    assert.deepEqual(nodeSpawnProblemsOf(`${tail}/* execSync('x') */\n// execSync('y')\n`), []);
    assert.match(nodeSpawnProblemsOf(`${tail}x = 1; /* execSync('x') */\n`).join(), /exec \/ execSync/);
    assert.match(nodeSpawnProblemsOf(`${tail}x = 1; // execSync('x')\n`).join(), /exec \/ execSync/);
    for (const code of ["const t = (p) => /a\\//.test(p); execSync('ls | wc');", "const f = (p) => { return /a\\//.test(p) || execSync('x'); };", "const s = `a${`b${1}//`}c`; execSync('r');", "const r = (p) => /`/.test(p); execSync('x');", "const r = (p) => /it's/.test(p);\nexecSync('x');"]) {
      assert.match(nodeSpawnProblemsOf(`${tail}${code}\n`).join(), /exec \/ execSync/, code);
    }
  });
  test('round 3: differential: for every file the scan covers, stripping removes only whole comment lines or blocks that open a line (every other line is kept as it is)', () => {
    let seen = 0;
    for (const f of trackedFiles(repo).filter(nodeSourceFile)) {
      let text;
      try { text = readFileSync(join(repo, f), 'utf8'); } catch { continue; }
      const orig = text.split('\n');
      const code = stripComments(text).split('\n');
      assert.equal(code.length, orig.length, f);
      // the lines an independent pass calls comment: a line starting with // , and the lines of a block comment that opens a line (through its closing line)
      const comment = new Set();
      for (let i = 0; i < orig.length; i++) {
        const t = orig[i].trimStart();
        if (t.startsWith('//')) comment.add(i);
        else if (t.startsWith('/*')) { let j = i; while (j < orig.length && !(j === i ? orig[j].indexOf('*/', orig[j].length - t.length + 2) >= 0 : orig[j].includes('*/'))) j++; for (let k = i; k <= Math.min(j, orig.length - 1); k++) comment.add(k); i = j; }
      }
      for (let i = 0; i < orig.length; i++) {
        if (!comment.has(i)) assert.equal(code[i], orig[i], `${f}:${i + 1}: a non-comment line changed`);
        else assert.equal(code[i].length, orig[i].length, `${f}:${i + 1}`);
      }
      seen++;
    }
    assert.ok(seen > 100, `only ${seen} files seen`);
  });
  test('round 2: a quoted script: key, a Hooks.json (case), and bin/proofline (no extension) are not evasions', () => {
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - uses: actions/github-script@v7\n        with:\n          'script': |\n            if (x) { y(); }\n`), /script: key/, "'script'");
    refuses((d) => put(d, '.github/workflows/ci.yml', `${CLEAN_CI}      - uses: actions/github-script@v7\n        with:\n          "script": x\n`), /script: key/, '"script"');
    const wire = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stop codex; id' }] }] } });
    refuses((d) => put(d, 'adapters/codex/Hooks.json', wire), /Hooks\.json::Stop::0/, 'Hooks.json');
    refuses((d) => put(d, 'extra/SETTINGS.json', wire), /SETTINGS\.json::Stop::0/, 'SETTINGS.json');
    refuses((d) => put(d, 'bin/proofline', "#!/usr/bin/env node\nimport { execSync } from 'node:child_process';\nexecSync('ls | wc');\n"), /bin\/proofline:\d+: exec/, 'bin/proofline');
  });
  test('rule 5 on this checkout: no Node source starts a shell or a text tool outside core/proc.mjs', () => assert.deepEqual(nodeSpawnProblems(repo), []));
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
});

describe('the repository itself', () => {
  test('the strict check passes on this checkout, and there is no ratchet file left', () => {
    const r = spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['tests/ci/shell-allowlist.txt', 'tests/ci/inline-shell-snapshot.txt', 'tests/ci/shellcheck.mjs']) assert.ok(!existsSync(join(repo, f)), f);
  });
  test('the launcher list is the four launchers and each has exactly one template section', () => {
    const sections = [...parseLauncherTemplates(TEMPLATES).keys()].sort();
    assert.deepEqual(sections, [...LAUNCHERS].sort());
    assert.equal(LAUNCHERS.size, 4);
    assert.ok(!LAUNCHERS.has('bin/proofline'), 'bin/proofline is a Node program since A233');
  });
  test('the templates equal the launchers byte for byte, and the three plain ones are a shebang and one exec line', () => {
    for (const [f, t] of parseLauncherTemplates(TEMPLATES)) {
      assert.equal(readFileSync(join(repo, f), 'utf8'), t, f);
      if (!f.endsWith('/agent.sh')) assert.ok(launcherOk(t), f);
    }
  });
});
