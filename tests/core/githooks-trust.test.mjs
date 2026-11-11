// @ts-check
// A249 (independent security review of 173-C2, issue comment 6716526633): `init` sets `core.hooksPath` to `.agents/githooks` only when every file in that folder was
// installed by proofline or found identical to its own copy in this run, and none is a link; `doctor` compares the installed hooks with the shipped sha256 and reports
// links and extra files. A cloned hostile repository can commit `.agents/githooks/pre-commit`, and git runs every executable file in the folder it is pointed to.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repo } from './helpers.mjs';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const git = (/** @type {string} */ d, /** @type {string[]} */ a) => spawnSync('git', ['-C', d, ...a], { env: sb.env, encoding: 'utf8' });
const hp = (/** @type {string} */ d) => git(d, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim();
const INIT = ['init', '--yes', '--runtimes', 'claude'];
const SHIPPED = path.join(repo, 'control-plane', 'agents', 'githooks');
const HOSTILE = '#!/bin/sh\necho hostile > "$HOME/pwned"\nexit 0\n';
const NOT_SET = /core\.hooksPath was NOT set to \.agents\/githooks \(proofline's commit and push locks are NOT active\): /;

/** A repository that already holds a committed `.agents/githooks` with the given files (name -> text), then `init --yes`. */
function cloned(/** @type {string} */ name, /** @type {Record<string, string>} */ files) {
  const d = sb.mkrepo(name);
  mkdirSync(`${d}/.agents/githooks`, { recursive: true });
  for (const [f, text] of Object.entries(files)) { writeFileSync(`${d}/.agents/githooks/${f}`, text); chmodSync(`${d}/.agents/githooks/${f}`, 0o755); }
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'cloned']);
  return d;
}

test('A249 init: a committed pre-commit that differs from proofline\'s is kept as the user\'s own and core.hooksPath is NOT set; the note says what to do; the install does not fail', () => {
  const d = cloned('hostile', { 'pre-commit': HOSTILE });
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '', 'the hooks path was set to a folder that holds the hostile file');
  assert.equal(readFileSync(`${d}/.agents/githooks/pre-commit`, 'utf8'), HOSTILE, 'the user\'s file was overwritten');
  assert.match(r.out, NOT_SET, r.out);
  assert.match(r.out, /\.agents\/githooks\/pre-commit differs from proofline's and was kept as your own file\. Review the file\(s\); to use proofline's hooks, delete them and run proofline init again, or after reviewing run: git config --local core\.hooksPath \.agents\/githooks/, r.out);
  // a commit does not run the hostile file
  writeFileSync(`${d}/a.txt`, 'a\n'); git(d, ['add', 'a.txt']);
  assert.equal(git(d, ['commit', '-q', '-m', 'x']).status, 0);
  assert.equal(spawnSync('test', ['-e', `${sb.T}/home/pwned`]).status, 1, 'the hostile hook ran');
  // upgrade does not set it either; and once the user deleted the file, init sets it
  assert.match(sb.pl(d, ['upgrade', '--yes']).out, NOT_SET);
  assert.equal(hp(d), '');
  // the upgrade left proofline's copy beside the user's file; that extra file keeps the folder untrusted as well
  assert.match(sb.pl(d, INIT).out, /pre-commit\.proofline-new is not a file proofline ships|differs from proofline's and was kept/);
  spawnSync('rm', [`${d}/.agents/githooks/pre-commit`, `${d}/.agents/githooks/pre-commit.proofline-new`]);
  const fixed = sb.pl(d, INIT);
  assert.equal(fixed.status, 0, fixed.text);
  assert.equal(hp(d), '.agents/githooks');
  assert.ok(!NOT_SET.test(fixed.text), fixed.text);
});

test('A249 init: a committed pre-commit and pre-push identical to proofline\'s are confirmed and the path is set; a dry run says so and sets nothing', () => {
  const same = { 'pre-commit': readFileSync(`${SHIPPED}/pre-commit`, 'utf8'), 'pre-push': readFileSync(`${SHIPPED}/pre-push`, 'utf8') };
  const dry = cloned('same-dry', same);
  const rd = sb.pl(dry, [...INIT, '--dry-run']);
  assert.equal(rd.status, 0, rd.text);
  assert.match(rd.out, /git config --local core\.hooksPath \.agents\/githooks/, rd.out);
  assert.equal(hp(dry), '');
  const d = cloned('same', same);
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '.agents/githooks');
  assert.ok(!NOT_SET.test(r.text), r.text);
  assert.match(sb.pl(d, ['doctor']).out, /^PASS git hooks: core\.hooksPath = \.agents\/githooks, pre-commit and pre-push executable and identical to the shipped copies/m);
  // the dry run of the hostile case predicts the refusal
  const h = cloned('hostile-dry', { 'pre-commit': HOSTILE });
  assert.match(sb.pl(h, [...INIT, '--dry-run']).out, NOT_SET);
});

test('A249 init: a symbolic link in the folder (a hook with identical content, an extra hook name, the folder itself) and an extra file are not trusted', () => {
  // a link whose target has proofline's exact content: the content check passes, the link check must not
  const a = sb.mkrepo('link-same');
  mkdirSync(`${a}/.agents/githooks`, { recursive: true });
  copyFileSync(`${SHIPPED}/pre-commit`, `${a}/target-hook`); chmodSync(`${a}/target-hook`, 0o755);
  symlinkSync(`${a}/target-hook`, `${a}/.agents/githooks/pre-commit`);
  const ra = sb.pl(a, INIT);
  assert.equal(ra.status, 0, ra.text);
  assert.equal(hp(a), '');
  assert.match(ra.out, NOT_SET, ra.out);
  // an extra hook that proofline does not ship (git would run post-checkout)
  const b = cloned('extra', { 'post-checkout': HOSTILE });
  const rb = sb.pl(b, INIT);
  assert.equal(rb.status, 0, rb.text);
  assert.equal(hp(b), '');
  assert.match(rb.out, /\.agents\/githooks\/post-checkout is not a file proofline ships/, rb.out);
  // an extra file that is a link
  const c = sb.mkrepo('link-extra');
  mkdirSync(`${c}/.agents/githooks`, { recursive: true });
  symlinkSync('/bin/true', `${c}/.agents/githooks/post-commit`);
  const rc = sb.pl(c, INIT);
  assert.equal(rc.status, 0, rc.text);
  assert.equal(hp(c), '');
  assert.match(rc.out, /\.agents\/githooks\/post-commit is a symbolic link/, rc.out);
  // the folder is a link
  const e = sb.mkrepo('link-dir');
  mkdirSync(`${e}/elsewhere`);
  mkdirSync(`${e}/.agents`);
  symlinkSync(`${e}/elsewhere`, `${e}/.agents/githooks`);
  const re = sb.pl(e, INIT);
  assert.equal(re.status, 0, re.text);
  assert.equal(hp(e), '');
});

test('A249 init: an existing core.hooksPath the user set is still never overwritten, and a clean install still sets it', () => {
  const d = sb.mkrepo('keep-user');
  git(d, ['config', '--local', 'core.hooksPath', '.husky']);
  assert.equal(sb.pl(d, INIT).status, 0);
  assert.equal(hp(d), '.husky');
  const fresh = sb.mkrepo('fresh');
  assert.equal(sb.pl(fresh, INIT).status, 0);
  assert.equal(hp(fresh), '.agents/githooks');
});

// ---- doctor ---------------------------------------------------------------------------------------------------------------------------------------------

/** An installed project (the hooks path set) and its `doctor` output. */
const installed = (/** @type {string} */ name) => { const d = sb.copy(name); assert.equal(hp(d), '.agents/githooks'); return d; };
const hooksLines = (/** @type {string} */ out) => out.split('\n').filter((l) => /^(PASS|WARN|FAIL) git hooks:/.test(l));

test('A249 doctor: a hook that differs from the shipped sha256 FAILs; a restored copy passes again', () => {
  const d = installed('doc-mod');
  assert.match(hooksLines(sb.pl(d, ['doctor']).out).join('\n'), /^PASS git hooks: .*identical to the shipped copies/);
  writeFileSync(`${d}/.agents/githooks/pre-push`, HOSTILE); chmodSync(`${d}/.agents/githooks/pre-push`, 0o755);
  const r = sb.pl(d, ['doctor']);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-push differs from the copy proofline ships \(sha256 mismatch\)/m, r.out);
  assert.notEqual(r.status, 0);
  copyFileSync(`${SHIPPED}/pre-push`, `${d}/.agents/githooks/pre-push`); chmodSync(`${d}/.agents/githooks/pre-push`, 0o755);
  assert.match(sb.pl(d, ['doctor']).out, /^PASS git hooks: /m);
});

test('A249 doctor: a hook that is a symbolic link FAILs even when its target has the shipped content; so does an extra file and a linked folder', () => {
  const d = installed('doc-link');
  copyFileSync(`${SHIPPED}/pre-commit`, `${d}/real-copy`); chmodSync(`${d}/real-copy`, 0o755);
  spawnSync('rm', [`${d}/.agents/githooks/pre-commit`]);
  symlinkSync(`${d}/real-copy`, `${d}/.agents/githooks/pre-commit`);
  const r = sb.pl(d, ['doctor']);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-commit is a symbolic link; git would run its target/m, r.out);
  assert.doesNotMatch(r.out, /^PASS git hooks:/m);

  const e = installed('doc-extra');
  writeFileSync(`${e}/.agents/githooks/post-merge`, HOSTILE); chmodSync(`${e}/.agents/githooks/post-merge`, 0o755);
  const re = sb.pl(e, ['doctor']);
  assert.match(re.out, /^FAIL git hooks: \.agents\/githooks\/post-merge is not a file proofline ships/m, re.out);
  assert.doesNotMatch(re.out, /^PASS git hooks:/m);

  const f = installed('doc-dirlink');
  spawnSync('mv', [`${f}/.agents/githooks`, `${f}/hooks-real`]);
  symlinkSync(`${f}/hooks-real`, `${f}/.agents/githooks`);
  const rf = sb.pl(f, ['doctor']);
  assert.match(rf.out, /^FAIL git hooks: \.agents\/githooks is a symbolic link or not a folder/m, rf.out);
});

test('A249 doctor and init (item 2, closed by A238): a hostile settings.json whose matchers name a tool that never fires, or disableAllHooks, is a FAIL, never a PASS "wires all 7 events"', () => {
  const d = installed('doc-settings');
  const f = `${d}/.claude/settings.json`;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const groups of Object.values(/** @type {Record<string, any[]>} */ (j.hooks))) for (const g of groups) if (g.matcher !== undefined) g.matcher = 'NoSuchTool';
  j.disableAllHooks = true;
  writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
  const r = sb.pl(d, ['doctor']);
  assert.doesNotMatch(r.out, /^PASS claude hooks: .*wires all 7/m, r.out);
  assert.match(r.out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m, r.out);
  assert.match(r.out, /^FAIL claude hooks: disableAllHooks is true in \.claude\/settings\.json/m, r.out);
  assert.notEqual(r.status, 0);
});
