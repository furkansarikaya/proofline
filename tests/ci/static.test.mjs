// @ts-check
// Self-test wiring for tests/shared/check-static.mjs (A162): the repository itself passes the static rules, and each rule breaks on a scratch repository
// that violates it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { README_MAX_BYTES, README_MAX_LINES, check, main } from '../shared/check-static.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const T = mkdtempSync(path.join(tmpdir(), 'static-test-'));
after(() => rmSync(T, { recursive: true, force: true }));
let n = 0;
const git = (/** @type {string} */ dir, /** @type {string[]} */ ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
const w = (/** @type {string} */ dir, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), t); };

/** A git repository with a README and one code file; every scratch repository carries the repository's own ecosystem table (rule 5 fails without it). */
function scratch(opt = { git: true }) {
  const dir = path.join(T, `s${++n}`);
  w(dir, 'README.md', '# x\n'); w(dir, 'src/a.sh', 'x=1\n');
  mkdirSync(path.join(dir, 'control-plane/agents'), { recursive: true });
  cpSync(path.join(repo, 'control-plane/agents/ecosystems.json'), path.join(dir, 'control-plane/agents/ecosystems.json'));
  if (opt.git) { git(dir, 'init', '-q'); git(dir, 'add', '-A'); }
  return dir;
}
const add = (/** @type {string} */ dir) => git(dir, 'add', '-A');
/** @param {string} dir @param {{ foreignTags?: string }} [o] */
const run = (dir, o) => { const r = check(dir, o); return { status: r.status, text: r.lines.join('\n') }; };

describe('the repository itself', () => {
  test('passes every rule', () => {
    const r = run(repo);
    assert.equal(r.status, 0, r.text);
    for (const rule of ['shortcut labels', 'README size', 'third-party names', 'no personal paths', 'no ecosystem branching']) assert.ok(r.text.includes(`PASS ${rule}`), `${rule}\n${r.text}`);
  });
  test('the command prints the rules and exits with the status; --root and bad arguments', () => {
    let out = '';
    assert.equal(main([], { write: (s) => { out += s; } }), 0);
    assert.match(out, /^PASS shortcut labels/m);
    const err = console.error; console.error = () => {};
    try {
      assert.equal(main(['--root'], {}), 2); assert.equal(main(['--root', path.join(T, 'nope')], {}), 2); assert.equal(main(['--bogus'], {}), 2);
    } finally { console.error = err; }
    const d = scratch(); out = '';
    assert.equal(main(['--root', d], { write: (s) => { out += s; } }), 0, out);
  });
});

describe('rule 1: shortcut labels', () => {
  test('a clean scratch repository passes', () => { const r = run(scratch()); assert.equal(r.status, 0, r.text); assert.match(r.text, /^PASS shortcut labels/m); });
  test('a foreign label in a code comment fails, naming the rule and the file; each comment style is caught', () => {
    const d = scratch(); w(d, 'src/b.c', '// ponytail: x, y\nint a;\n'); add(d);
    const r = run(d);
    assert.equal(r.status, 1); assert.match(r.text, /^FAIL shortcut labels/m); assert.match(r.text, /src\/b\.c/);
    for (const c of ['# ponytail: x', '-- PONYTAIL: x', '/* ponytail: x */']) { w(d, 'src/b.c', `${c}\n`); add(d); assert.equal(run(d).status, 1, c); }
  });
  test('markdown and tests/ may quote the label', () => {
    const d = scratch(); w(d, 'NOTES.md', 'a ponytail: label is quoted here\n# ponytail: quoted\n'); w(d, 'tests/t.sh', '# ponytail: fixture\n'); add(d);
    assert.equal(run(d).status, 0, run(d).text);
  });
  test('evasion forms of a foreign label fail (A162)', () => {
    for (const c of ['# TODO ponytail: x', '// note: see ponytail: x', '/*\n ponytail: x\n */', '  ponytail: continued', '% ponytail: x', '(* ponytail: x *)', "' ponytail: x", ' * ponytail: x', 'int a; // fix later ponytail: x', 'ponytail: this prose line starts with the tag']) {
      const d = scratch(); w(d, 'src/b.txt', `${c}\n`); add(d);
      const r = run(d); assert.equal(r.status, 1, c); assert.match(r.text, /^FAIL shortcut labels/m);
    }
  });
  test('FOREIGN_TAGS is extendable', () => {
    const d = scratch(); w(d, 'src/b.sh', '# kludge: x\n'); add(d);
    assert.equal(run(d).status, 0, 'an unlisted tag passes');
    assert.equal(run(d, { foreignTags: 'ponytail kludge' }).status, 1, 'an added entry is enforced');
  });
  test('a directory that is not a git repository is scanned too (tests/, .claude/ and .agents/ at any depth are skipped)', () => {
    const d = scratch({ git: false }); w(d, 'src/b.c', '// ponytail: x\n'); assert.equal(run(d).status, 1);
    rmSync(path.join(d, 'src/b.c')); w(d, 'x/tests/b.c', '// ponytail: x\n'); assert.equal(run(d).status, 0);
  });
});

describe('rule 2: README size', () => {
  const real = readFileSync(path.join(repo, 'README.md'), 'utf8');
  test('the real README fits; one past the line bound, one past the byte bound, or a missing README fails', () => {
    const d = scratch(); w(d, 'README.md', real); add(d);
    assert.equal(run(d).status, 0, run(d).text);
    const lines = real.split('\n').length - 1;
    w(d, 'README.md', real + 'extra line\n'.repeat(README_MAX_LINES - lines + 1)); add(d);
    const r = run(d); assert.equal(r.status, 1); assert.match(r.text, /^FAIL README size/m);
    w(d, 'README.md', real + 'x'.repeat(README_MAX_BYTES - Buffer.byteLength(real) + 10)); add(d);
    assert.ok(readFileSync(path.join(d, 'README.md'), 'utf8').split('\n').length - 1 <= README_MAX_LINES, 'the byte case stays within the line bound');
    assert.match(run(d).text, /^FAIL README size/m);
    rmSync(path.join(d, 'README.md')); assert.equal(run(d).status, 1);
  });
});

describe('rule 3: third-party names', () => {
  test('a source name outside the notices file fails; inside it, passes', () => {
    const d = scratch(); w(d, 'skills/ui-design/library/THIRD_PARTY_NOTICES.md', '## Sources\n\n- source-1 | acme-widgets | https://example.invalid/acme-widgets\n'); add(d);
    assert.equal(run(d).status, 0, run(d).text);
    w(d, 'README.md', '# x\nInspired by acme-widgets.\n'); add(d);
    const r = run(d); assert.equal(r.status, 1); assert.match(r.text, /^FAIL third-party names/m);
    for (const spelling of ['Acme Widgets', 'acmewidgets', 'ACME_WIDGETS']) { w(d, 'README.md', `# x\n${spelling}\n`); add(d); assert.equal(run(d).status, 1, spelling); }
  });
  test('a byte-identical data copy listed in the notices file is skipped', () => {
    const d = scratch(); w(d, 'skills/ui-design/library/THIRD_PARTY_NOTICES.md', '- source-1 | acme-widgets | u\n\n  - `data.json` sha256 abc\n'); w(d, 'skills/ui-design/library/data.json', '{"from":"acme-widgets"}\n'); add(d);
    assert.equal(run(d).status, 0, run(d).text);
  });
});

describe('rule 4: personal paths in captured tool output', () => {
  test('a clean fixture passes; each personal path fails with the rule named', () => {
    const d = scratch(); const f = 'tests/skills/fixtures/tdd-proof-output/ok.txt';
    w(d, f, 'tool: x\n=== OUTPUT ===\n at /work/a.ts and /home/user\na bare /home/user and /work/x/y are fine\n'); add(d);
    assert.match(run(d).text, /^PASS no personal paths/m);
    for (const bad of ['/Users/jane/x', '/home/jane/x', '/home/user/x', '/private/var/folders/ab/T/x', '/var/folders/ab/T/x', '/opt/homebrew/Cellar/go/1.2/libexec', '/opt/homebrew/bin/node', 'C:\\Users\\jane\\x']) {
      w(d, 'tests/skills/fixtures/tdd-proof-output/bad.txt', `tool: x\n=== OUTPUT ===\n at ${bad}\n`); add(d);
      const r = run(d); assert.equal(r.status, 1, bad); assert.match(r.text, /^FAIL personal paths/m);
    }
  });
});

describe('rule 5: ecosystem branching in shared shell scripts (A187)', () => {
  const dispatch = readFileSync(path.join(repo, 'control-plane/agents/scripts/dispatch.sh'), 'utf8');
  test('a copy of the shared script passes; an ecosystem branch added to it fails and names the file; eco-ok exempts a marked line', () => {
    const d = scratch(); w(d, 'control-plane/agents/scripts/dispatch.sh', dispatch); add(d);
    assert.match(run(d).text, /^PASS no ecosystem branching/m);
    for (const l of ['case "$x" in go) y=1 ;; esac', '[ "$eco" = dotnet ] && y=1', 'case $e in npm|pnpm) y=1 ;; esac']) {
      w(d, 'control-plane/agents/scripts/dispatch.sh', `${dispatch}${l}\n`); add(d);
      const r = run(d); assert.equal(r.status, 1, l); assert.match(r.text, /^FAIL ecosystem branching/m); assert.match(r.text, /dispatch\.sh/);
    }
    w(d, 'control-plane/agents/scripts/dispatch.sh', `${dispatch}# eco-ok: an interpreter name, not an ecosystem\ncase "$x" in python) y=1 ;; esac\n`); add(d);
    assert.match(run(d).text, /^PASS no ecosystem branching/m);
  });
  test('a plain manifest file name in a shared script fails; a comment line, a test and an excluded folder do not', () => {
    const d = scratch(); w(d, 'bin/tool.sh', '#!/bin/sh\n# reads package.json in a comment\necho hi\n'); add(d);
    assert.equal(run(d).status, 0, run(d).text);
    w(d, 'bin/tool.sh', '#!/bin/sh\ncat package.json\n'); add(d);
    assert.equal(run(d).status, 1);
    w(d, 'bin/tool.sh', '#!/bin/sh\necho hi\n'); w(d, 'bin/x-test.sh', 'cat package.json\n'); w(d, 'bin/fixtures/y.sh', 'cat go.mod\n'); add(d);
    assert.equal(run(d).status, 0, run(d).text);
  });
  test('fails when ecosystems.json is missing or lists no ids (it used to pass)', () => {
    const d = path.join(T, `noeco${++n}`); w(d, 'README.md', '# x\n');
    const r = run(d); assert.equal(r.status, 1); assert.match(r.text, /^FAIL ecosystem branching: no ecosystem ids/m);
    w(d, 'control-plane/agents/ecosystems.json', '{"global":{},"ecosystems":[]}\n');
    assert.match(run(d).text, /^FAIL ecosystem branching: no ecosystem ids/m);
  });
});
