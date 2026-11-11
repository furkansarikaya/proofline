// @ts-check
// `proofline-core.mjs cli config ...` (A232; the former bin/lib/config.sh): reading, writing and merging .agents/config.yaml for the CLI front end. Absolute expectations: the
// merge texts below are what the shell `cfg_merge_new` printed for the same inputs (0.0.65), recorded once.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cfgMergeNew } from '../../control-plane/agents/scripts/core/cfgcli.mjs';
import { scriptsDir } from './helpers.mjs';

const core = path.join(scriptsDir, 'proofline-core.mjs');
const dir = tempDir('cfgcli-');
const cli = (/** @type {string[]} */ ...args) => {
  const r = spawnSync(process.execPath, [core, 'cli', 'config', ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const put = (/** @type {string} */ name, /** @type {string} */ text) => { const f = path.join(dir, name); writeFileSync(f, text); return f; };

const USER = 'profile: balanced\nbudgets:\n  tokens: 10\ngit:\n  protected_branches: main\ncommands:\n  build:\n    - make\n  test: jest\n';
const DEFAULT = '# top comment\nprofile: economy\nbudgets:\n  tokens: 5\n  # why\n  new_budget: 7\ngit:\n  protected_branches:\n  push_requires_approval: true\nhook:\n  # block comment\n  approve_budget_seconds: 20\n  lock_wait_seconds: 8\ncommands:\n  build:\n    - a\n    - b\n  test:\n  lint: eslint .\nrisk:\n  log_sensitive:\n    words: x\n';
const MERGED = 'profile: balanced\nbudgets:\n  tokens: 10\n  # why\n  new_budget: 7\ngit:\n  protected_branches: main\n  push_requires_approval: true\ncommands:\n  build:\n    - make\n  test: jest\n  lint: eslint .\nhook:\n  # block comment\n  approve_budget_seconds: 20\n  lock_wait_seconds: 8\nrisk:\n  log_sensitive:\n    words: x\n';

test('merge-new adds the missing keys: a block at its end, a 2-level key at the end of its block with its comment; user values and lists stay', () => {
  assert.equal(cfgMergeNew(USER, DEFAULT), MERGED);
  const u = put('user.yaml', USER); const d = put('default.yaml', DEFAULT);
  const r = cli('merge-new', u, d);
  assert.equal(r.code, 0);
  assert.equal(r.out, MERGED);
  assert.equal(readFileSync(u, 'utf8'), USER, 'the user file is not written');
});

test('merge-new with an empty user file prints the default file as it is (the shell program read it as the user file)', () => {
  assert.equal(cfgMergeNew('', DEFAULT), DEFAULT);
  assert.equal(cfgMergeNew(DEFAULT, USER), DEFAULT, 'a default that only has keys the user file already has adds nothing');
});

test('merge-new: a user file without a final newline gets one; a key deeper than two levels is added only with its parent', () => {
  assert.equal(cfgMergeNew('a:\n  b: 1', 'a:\n  b: 2\n  c:\n    d: 3\n'), 'a:\n  b: 1\n  c:\n    d: 3\n');
  assert.equal(cfgMergeNew('a:\n  b:\n    x: 1\n', 'a:\n  b:\n    x: 2\n    y: 3\n'), 'a:\n  b:\n    x: 1\n');
});

test('val: the value, or the default when the key is absent, empty or the file missing', () => {
  const f = put('c.yaml', 'profile: economy\nruntime:\n  lead: codex\n  worker:\ncommands:\n  build:\n    - a\n    - b\n');
  assert.equal(cli('val', f, 'runtime.lead', 'claude').out, 'codex\n');
  assert.equal(cli('val', f, 'runtime.worker', 'none').out, 'none\n');
  assert.equal(cli('val', f, 'nope.key').out, '\n');
  assert.equal(cli('val', path.join(dir, 'missing.yaml'), 'profile', 'balanced').out, 'balanced\n');
  assert.equal(cli('val', f, 'profile').code, 0);
});

test('get: the value, status 1 when the key is absent; lines and cmds show a block list', () => {
  const f = put('g.yaml', 'a: "q"  # note\nb:\n  c: 2\ncommands:\n  build:\n    - one\n    - "two words"\n  test: jest\n');
  assert.deepEqual([cli('get', f, 'a').code, cli('get', f, 'a').out], [0, 'q\n']);
  assert.equal(cli('get', f, 'b.c').out, '2\n');
  assert.equal(cli('get', f, 'b.zz').code, 1);
  assert.equal(cli('lines', f).out, 'a=q\nb=\nb.c=2\ncommands=\ncommands.build=\ncommands.build.0=one\ncommands.build.1=two words\ncommands.test=jest\n');
  assert.equal(cli('cmds', f, 'commands.build').out, 'one\ntwo words\n');
  assert.equal(cli('cmds', f, 'commands.test').out, 'jest\n');
  assert.equal(cli('cmds', f, 'commands.lint').out, '');
});

test('get: a list key has no value of its own (empty, status 0), a missing file is status 1 like the shell program', () => {
  const f = put('l.yaml', 'commands:\n  build:\n    - one\n    - two\n');
  assert.deepEqual([cli('get', f, 'commands.build').code, cli('get', f, 'commands.build').out], [0, '\n']);
  assert.equal(cli('get', f, 'commands.build.0').out, 'one\n');
  assert.equal(cli('get', path.join(dir, 'missing.yaml'), 'a').code, 1);
});

test('set: replaces, adds a new key right under its section line, writes a block list for a value of several lines, and fails with nothing written for a 3-level key without its parent', () => {
  const f = put('s.yaml', 'profile: economy  # why\ngit:\n  protected_branches: main\n');
  assert.equal(cli('set', f, 'profile', 'max').code, 0);
  assert.equal(cli('set', f, 'git.push_requires_approval', 'true').code, 0);
  assert.equal(cli('set', f, 'commands.build', 'make\nmake lint').code, 0);
  assert.equal(readFileSync(f, 'utf8'), 'profile: max\ngit:\n  push_requires_approval: true\n  protected_branches: main\ncommands:\n  build:\n    - make\n    - make lint\n');
  const before = readFileSync(f, 'utf8');
  assert.equal(cli('set', f, 'risk.log.words', 'x').code, 1);
  assert.equal(readFileSync(f, 'utf8'), before);
  assert.equal(cli('set', path.join(dir, 'missing.yaml'), 'a', 'b').code, 1);
  const u = put('u.yaml', 'name: x\n');
  cli('set', u, 'name', 'caf\u00e9');
  assert.equal(readFileSync(u, 'utf8'), 'name: caf\u00e9\n', 'a non-ASCII value is written as the UTF-8 bytes it was given in');
});

test('an unknown operation or a missing argument is a usage error (status 2) that names the forms', () => {
  for (const args of [[], ['frob', 'x'], ['val'], ['get', 'f'], ['set', 'f', 'k'], ['merge-new', 'f']]) {
    const r = cli(...args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /merge-new USER DEFAULT/);
  }
});

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
