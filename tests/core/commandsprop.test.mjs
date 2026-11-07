// @ts-check
// `proofline doctor --commands` / `--apply-commands` (A200, A230; the former bin/lib/commands.sh, whose end-to-end test sc_commands of tests/cli/cli-test.sh stays as the
// check of the launcher): the empty commands.* keys are discovered, proven by one run, proposed with one question; only the user's own yes writes, only proven commands.
// Absolute expectations; the real control plane in a throwaway project, the project's own `.agents/scripts/proofline-core.mjs` run as `bin/proofline` runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanEnv } from '../hook/harness.mjs';
import { cfgCmds, cfgSet } from '../../control-plane/agents/scripts/core/configset.mjs';
import { A, project, say } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';
import { RECIPE, setCmd } from './helper-lib.mjs';

/** A project with the ecosystem definition (the template copies the core and the scripts, the installer copies the whole control plane). */
function proj() {
  const d = project(RECIPE);
  cpSync(path.join(repo, 'control-plane/agents/ecosystems.json'), path.join(d, '.agents/ecosystems.json'));
  return d;
}
/** A stub program on a folder of its own, put first on the PATH. @param {string} d @param {string} name @param {number} status */
function stub(d, name, status) {
  const dir = path.join(d, `.stub-${name}-${status}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `#!/bin/sh\nexit ${status}\n`);
  chmodSync(path.join(dir, name), 0o755);
  return dir;
}
/** One `cli` call of the project's own core. @param {string} d @param {string[]} args @param {string} [stubDir] */
function cli(d, args, stubDir) {
  const env = cleanEnv({});
  if (stubDir) env.PATH = `${stubDir}:${env.PATH}`;
  const r = spawnSync('node', ['.agents/scripts/proofline-core.mjs', 'cli', ...args], { cwd: d, env, encoding: 'utf8', input: '', timeout: 120000 });
  return { status: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}
const cfg = (/** @type {string} */ d) => path.join(d, '.agents/config.yaml');
const proposal = (/** @type {string} */ d) => path.join(d, '.agents/local/commands/PROPOSAL.tsv');

test('empty keys: a fresh project has all three empty, a configured one only the rest; doctor-commands empty prints them', () => {
  const d = proj();
  assert.deepEqual(cli(d, ['doctor-commands', 'empty']).out, 'build test lint\n');
  setCmd(d, 'test', 'npm test');
  assert.equal(cli(d, ['doctor-commands', 'empty']).out, 'build lint\n');
  setCmd(d, 'build', 'make');
  setCmd(d, 'lint', 'make lint');
  assert.equal(cli(d, ['doctor-commands', 'empty']).out, '\n');
  const r = cli(d, ['doctor-commands', 'propose']);
  assert.deepEqual([r.status, r.out], [0, 'commands: build, test and lint are configured\n']);
  assert.equal(cli(d, ['doctor-commands']).status, 2);
  assert.equal(cli(d, ['doctor-commands', 'bogus']).status, 2);
});

test('nothing can be discovered: the proposal is removed and the user is told to set the commands by hand', () => {
  const d = proj();
  mkdirSync(path.dirname(proposal(d)), { recursive: true });
  writeFileSync(proposal(d), 'test\told\n');
  const r = cli(d, ['doctor-commands', 'propose']);
  assert.equal(r.status, 0, r.text);
  assert.equal(r.out, 'commands: empty in .agents/config.yaml: build test lint, and nothing could be discovered from this project; set them by hand (commands.build, commands.test, commands.lint)\n');
  assert.equal(existsSync(proposal(d)), false);
});

test('a command whose run failed is not proven, and no proposal is written for it', () => {
  const d = proj();
  writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"jest"}}');
  const r = cli(d, ['doctor-commands', 'propose'], stub(d, 'npm', 1));
  assert.equal(r.status, 0, r.text);
  assert.equal(r.out, "proving the discovered commands, one run each...\n  commands.test trial failed, left empty: npm test\ncommands: none of the discovered commands could be proven (a failed trial run is not written): fix the project's build, or set commands.* by hand\n");
  assert.equal(existsSync(proposal(d)), false);
});

test('a proven command is proposed with one question, nothing is written before the user answers, only the user\'s own "approve commands" writes it, once', () => {
  const d = proj();
  writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"jest"}}');
  const r = cli(d, ['doctor-commands', 'propose'], stub(d, 'npm', 0));
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^proving the discovered commands, one run each\.\.\.\n {2}verified commands\.test: npm test\n\ncommands proposal [0-9a-f]{12} \(each command ran once and passed\):\n {2}commands\.test: npm test\nQUESTION \(one\): write these into \.agents\/config\.yaml\? Reply "approve commands"\. Nothing is written without your reply\.\n/);
  assert.match(r.out, /\n {2}in a night batch the summary names this proposal and your batch approval covers it \(A200\); then: proofline doctor --apply-commands\n$/);
  assert.equal(readFileSync(proposal(d), 'utf8'), 'test\tnpm test\n');
  assert.deepEqual(cfgCmds(cfg(d), 'commands.test'), []);
  // no reply yet: the apply is refused and writes nothing
  const early = cli(d, ['doctor-commands', 'apply']);
  assert.equal(early.status, 1);
  assert.match(early.err, /proofline: doctor --apply-commands: the user has not agreed to this proposal yet; ask the one question and wait for the reply\n$/);
  assert.deepEqual(cfgCmds(cfg(d), 'commands.test'), []);
  // the user's reply, as the runtime records it, then the apply
  say(d, 'approve commands');
  assert.equal(A(d, ['approve-pending']).status, 0);
  const done = cli(d, ['doctor-commands', 'apply']);
  assert.equal(done.status, 0, done.text);
  assert.equal(done.out, 'wrote commands.test: npm test\nconfig valid: .agents/config.yaml\n');
  assert.deepEqual(cfgCmds(cfg(d), 'commands.test'), ['npm test']);
  assert.deepEqual(cfgCmds(cfg(d), 'commands.build'), []);
  assert.equal(existsSync(proposal(d)), false);
  assert.equal(readdirSync(path.join(d, '.agents/local/commands')).filter((f) => /^applied-[0-9]+\.tsv$/.test(f)).length, 1);
  const approvals = readdirSync(path.join(d, '.agents/local/approvals')).filter((f) => /^[0-9]{3}-commands\.yaml$/.test(f));
  assert.equal(approvals.length, 1);
  assert.match(readFileSync(path.join(d, '.agents/local/approvals', approvals[0]), 'utf8'), /^consumed: "true"$/m);
  // the proposal is used up
  const again = cli(d, ['doctor-commands', 'apply']);
  assert.equal(again.status, 1);
  assert.match(again.err, /proofline: doctor --apply-commands: no commands proposal \(run: proofline doctor --commands\)\n$/);
});

test('a key that is configured by the time of the apply is left as it is, and a list of commands is written as a block list the config accepts', () => {
  const d = proj();
  mkdirSync(path.dirname(proposal(d)), { recursive: true });
  writeFileSync(proposal(d), 'build\tmake a\nbuild\tmake b\ntest\tnpm test\n');
  const q = A(d, ['request-approval', '-', 'commands']);
  assert.equal(q.status, 0, q.text);
  setCmd(d, 'test', 'cargo test');
  say(d, 'approve commands');
  assert.equal(A(d, ['approve-pending']).status, 0);
  const done = cli(d, ['doctor-commands', 'apply']);
  assert.equal(done.status, 0, done.text);
  assert.equal(done.out, 'wrote commands.build: make a;make b\ncommands.test is configured now; left as it is\nconfig valid: .agents/config.yaml\n');
  assert.deepEqual(cfgCmds(cfg(d), 'commands.build'), ['make a', 'make b']);
  assert.deepEqual(cfgCmds(cfg(d), 'commands.test'), ['cargo test']);
  assert.match(readFileSync(cfg(d), 'utf8'), /^ {2}build:\n {4}- make a\n {4}- make b\n/m);
});

// ---- cfgSet (the former cfg_set): the one writer of the config ----
const cfgFile = (/** @type {string} */ text) => { const d = project(RECIPE); const f = path.join(d, 'cfg.yaml'); writeFileSync(f, text); return f; };

test('cfgSet replaces a value and drops its comment and its old list items, adds a missing key right under its section line (as the shell cfg_set did), and creates a missing section', () => {
  const f = cfgFile('# top\ncommands:\n  build: old # note\n  test:\n    - a\n    - b\n  lint:\nother: 1\n');
  assert.equal(cfgSet(f, 'commands.build', 'new'), true);
  assert.equal(cfgSet(f, 'commands.test', 'x\ny'), true);
  assert.equal(cfgSet(f, 'commands.install', 'npm ci'), true);
  assert.equal(cfgSet(f, 'timeouts.scale', '2.5'), true);
  assert.equal(cfgSet(f, 'top', 'v'), true);
  assert.equal(readFileSync(f, 'utf8'), '# top\ncommands:\n  install: npm ci\n  build: new\n  test:\n    - x\n    - y\n  lint:\nother: 1\ntimeouts:\n  scale: 2.5\ntop: v\n');
  assert.deepEqual(cfgCmds(f, 'commands.test'), ['x', 'y']);
  assert.deepEqual(cfgCmds(f, 'commands.build'), ['new']);
  assert.deepEqual(cfgCmds(f, 'commands.lint'), []);
  assert.deepEqual(cfgCmds(path.join(path.dirname(f), 'missing.yaml'), 'commands.lint'), []);
});

test('cfgSet adds a 3-level key under its 2-level parent, and refuses (writing nothing) one without it', () => {
  const f = cfgFile('a:\n  b:\n    c: 1\nd:\n  e: 2\n');
  assert.equal(cfgSet(f, 'a.b.z', '9'), true);
  assert.equal(readFileSync(f, 'utf8'), 'a:\n  b:\n    z: 9\n    c: 1\nd:\n  e: 2\n');
  const before = readFileSync(f, 'utf8');
  assert.equal(cfgSet(f, 'd.q.r', '1'), false);
  assert.equal(readFileSync(f, 'utf8'), before);
});
