// @ts-check
// A249 (independent security review of 173-C2, issue comment 6716526633, and round 1 of PR #240): `init` sets `core.hooksPath` to `.agents/githooks` only when ALL the code git
// will run is proofline's shipped code: the two git hooks, the scripts they start (`.agents/scripts/**`), the Node hook tree, each compared with the SHIPPED sha256 (never the
// manifest, which a cloned repository writes), no link, nothing else in those folders, and every tracked file also staged and committed as the shipped bytes. `doctor` compares the
// same way, never RUNS project code that differs (its probes use the shipped hooks in a throwaway repository with a minimal environment), and reads `disableAllHooks` from
// the user's and the managed settings too.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { shippedCode } from '../../control-plane/agents/scripts/core/codetrust.mjs';
import { probeEnv } from '../../control-plane/agents/scripts/core/doctor.mjs';
import { repo } from './helpers.mjs';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const git = (/** @type {string} */ d, /** @type {string[]} */ a) => spawnSync('git', ['-C', d, ...a], { env: sb.env, encoding: 'utf8' });
const hp = (/** @type {string} */ d) => git(d, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim();
const INIT = ['init', '--yes', '--runtimes', 'claude'];
const SHIPPED = path.join(repo, 'control-plane', 'agents', 'githooks');
const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const HOSTILE = '#!/bin/sh\necho hostile > "$HOME/pwned"\nexit 0\n';
const NOT_SET = /core\.hooksPath was NOT set to \.agents\/githooks \(proofline's commit and push locks are NOT active\): /;
/** doctor without the live probes (they cost ~4 s); the one test that needs them says so */
const doctor = (/** @type {string} */ d, /** @type {NodeJS.ProcessEnv} */ extra = {}) => sb.pl(d, ['doctor'], { PROOFLINE_DOCTOR_PROBES: '0', ...extra });
let marks = 0;
/** a fresh marker path: a hostile file that runs writes it */
const marker = () => `${sb.T}/mark-${++marks}`;
const writeExec = (/** @type {string} */ f, /** @type {string} */ text) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); chmodSync(f, 0o755); };
const hookWriting = (/** @type {string} */ m) => `#!/bin/sh\necho hostile > ${m}\nexit 0\n`;
const coreWriting = (/** @type {string} */ m) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(m)}, 'hostile');\n`;

/** A repository that already holds a committed `.agents/githooks` with the given files (name -> text), then `init --yes`. */
function cloned(/** @type {string} */ name, /** @type {Record<string, string>} */ files) {
  const d = sb.mkrepo(name);
  for (const [f, text] of Object.entries(files)) writeExec(`${d}/.agents/githooks/${f}`, text);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'cloned']);
  return d;
}
const shippedHooks = () => ({ 'pre-commit': readFileSync(`${SHIPPED}/pre-commit`, 'utf8'), 'pre-push': readFileSync(`${SHIPPED}/pre-push`, 'utf8') });

test('A249 init: a committed pre-commit that differs from proofline\'s is kept as the user\'s own and core.hooksPath is NOT set; the note says what to do; the install does not fail', () => {
  const d = cloned('hostile', { 'pre-commit': HOSTILE });
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '', 'the hooks path was set to a folder that holds the hostile file');
  assert.equal(readFileSync(`${d}/.agents/githooks/pre-commit`, 'utf8'), HOSTILE, 'the user\'s file was overwritten');
  assert.match(r.out, NOT_SET, r.out);
  assert.match(r.out, /\.agents\/githooks\/pre-commit differs from proofline's copy and was kept as your own file\. Review the file\(s\); to use proofline's hooks, delete the file\(s\) that differ and run proofline init again \(or run proofline upgrade\) and commit the result, or after reviewing run: git config --local core\.hooksPath \.agents\/githooks/, r.out);
  // a commit does not run the hostile file
  writeFileSync(`${d}/a.txt`, 'a\n'); git(d, ['add', 'a.txt']);
  assert.equal(git(d, ['commit', '-q', '-m', 'x']).status, 0);
  assert.equal(existsSync(`${sb.T}/home/pwned`), false, 'the hostile hook ran');
  // upgrade does not set it either, and says the other cause when proofline's copy sits beside the user's file
  const up = sb.pl(d, ['upgrade', '--yes']);
  assert.match(up.out, NOT_SET);
  assert.equal(hp(d), '');
  assert.match(sb.pl(d, INIT).out, /pre-commit\.proofline-new is not a file proofline ships|differs from proofline's copy/);
  // once the user deleted the file and the copy beside it and committed, init sets it
  spawnSync('rm', [`${d}/.agents/githooks/pre-commit`, `${d}/.agents/githooks/pre-commit.proofline-new`]);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'drop the hook']);
  const fixed = sb.pl(d, INIT);
  assert.equal(fixed.status, 0, fixed.text);
  assert.ok(!NOT_SET.test(fixed.text), fixed.text);
});

test('A249 init: committed hooks identical to proofline\'s are confirmed and the path is set once the rest of the code is proofline\'s too; a dry run says so and sets nothing', () => {
  const dry = cloned('same-dry', shippedHooks());
  const rd = sb.pl(dry, [...INIT, '--dry-run']);
  assert.equal(rd.status, 0, rd.text);
  assert.match(rd.out, /git config --local core\.hooksPath \.agents\/githooks/, rd.out);
  assert.equal(hp(dry), '');
  const d = cloned('same', shippedHooks());
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '.agents/githooks');
  assert.ok(!NOT_SET.test(r.text), r.text);
  const h = cloned('hostile-dry', { 'pre-commit': HOSTILE });
  assert.match(sb.pl(h, [...INIT, '--dry-run']).out, NOT_SET);
});

test('A249 init: a symbolic link in the folder (a hook with identical content, an extra hook name, the folder itself) and an extra file are not trusted', () => {
  const a = sb.mkrepo('link-same');
  mkdirSync(`${a}/.agents/githooks`, { recursive: true });
  copyFileSync(`${SHIPPED}/pre-commit`, `${a}/target-hook`); chmodSync(`${a}/target-hook`, 0o755);
  symlinkSync(`${a}/target-hook`, `${a}/.agents/githooks/pre-commit`);
  const ra = sb.pl(a, INIT);
  assert.equal(ra.status, 0, ra.text);
  assert.equal(hp(a), '');
  assert.match(ra.out, NOT_SET, ra.out);
  const b = cloned('extra', { 'post-checkout': HOSTILE });
  const rb = sb.pl(b, INIT);
  assert.equal(rb.status, 0, rb.text);
  assert.equal(hp(b), '');
  assert.match(rb.out, /\.agents\/githooks\/post-checkout is not a file proofline ships/, rb.out);
  const c = sb.mkrepo('link-extra');
  mkdirSync(`${c}/.agents/githooks`, { recursive: true });
  symlinkSync('/bin/true', `${c}/.agents/githooks/post-commit`);
  const rc = sb.pl(c, INIT);
  assert.equal(rc.status, 0, rc.text);
  assert.equal(hp(c), '');
  assert.match(rc.out, /\.agents\/githooks\/post-commit is not a file proofline ships/, rc.out);
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

// ---- SECURITY-2: the trust decision does not depend on the committed manifest or on the working copy alone ------------------------------------------------

test('A249 init (route a): a committed manifest row that names the hostile hook\'s hash does not make it proofline\'s: the working copy is replaced, HEAD still holds the hostile blob, the path stays unset', () => {
  const d = sb.mkrepo('manifest-route');
  writeExec(`${d}/.agents/githooks/pre-commit`, HOSTILE);
  writeFileSync(`${d}/.agents/.proofline-manifest`, `# proofline manifest\n# version: 0.0.1\n${sha(HOSTILE)}  .agents/githooks/pre-commit\n`);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'cloned']);
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(readFileSync(`${d}/.agents/githooks/pre-commit`, 'utf8'), readFileSync(`${SHIPPED}/pre-commit`, 'utf8'), 'the manifest row made the working copy proofline\'s (update)');
  assert.equal(hp(d), '', 'the path was set although HEAD holds the hostile blob');
  assert.match(r.out, NOT_SET, r.out);
  assert.match(r.out, /\.agents\/githooks\/pre-commit is committed \(HEAD\) with content that is not proofline's copy, so a checkout, restore or reset would bring it back/, r.out);
  // what the attack relies on: restoring brings the hostile hook back
  git(d, ['checkout', '--', '.agents/githooks/pre-commit']);
  assert.equal(readFileSync(`${d}/.agents/githooks/pre-commit`, 'utf8'), HOSTILE);
});

test('A249 init and doctor (route b): hooks that are proofline\'s in the working tree but staged or committed differently are flagged; upgrade says so while the path is active', () => {
  const d = sb.copy('route-b');
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'install']);
  assert.match(doctor(d).out, /^PASS git hooks: .*identical to the shipped copies/m);
  // HEAD holds a hostile blob, the working copy is back to proofline's
  const hook = `${d}/.agents/githooks/pre-commit`;
  const good = readFileSync(hook, 'utf8');
  writeExec(hook, HOSTILE); git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'hostile']);
  writeExec(hook, good);
  const r = doctor(d);
  assert.match(r.out, /^FAIL code: \.agents\/githooks\/pre-commit is committed \(HEAD\) with content that is not proofline's copy/m, r.out);
  assert.doesNotMatch(r.out, /^PASS git hooks:/m, r.out);
  assert.notEqual(r.status, 0);
  const up = sb.pl(d, ['upgrade', '--yes']);
  assert.match(up.out, /core\.hooksPath already points at \.agents\/githooks, but the code it runs is not proofline's shipped copy: .*pre-commit is committed \(HEAD\)/, up.out);
  assert.equal(hp(d), '.agents/githooks', 'upgrade must not unset a path that is active (a normal upgrade has the new files uncommitted)');
  // staged only
  git(d, ['checkout', '-q', 'HEAD~1', '--', '.agents/githooks/pre-commit']);
  writeExec(hook, HOSTILE); git(d, ['add', hook]); writeExec(hook, good);
  assert.match(doctor(d).out, /^FAIL code: \.agents\/githooks\/pre-commit is staged with content that is not proofline's copy/m);
});

// ---- R1: the scripts the hooks start --------------------------------------------------------------------------------------------------------------------

test('A249 init (R1): identical hooks but a committed proofline-core.mjs that differs: the path is not set and the note names the script; with the path set by hand, a commit really runs it', () => {
  const m = marker();
  const d = cloned('hostile-core', shippedHooks());
  writeExec(`${d}/.agents/scripts/proofline-core.mjs`, coreWriting(m));
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'core']);
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '');
  assert.match(r.out, NOT_SET, r.out);
  assert.match(r.out, /\.agents\/scripts\/proofline-core\.mjs differs from proofline's copy and was kept as your own file/, r.out);
  assert.match(r.out, /Note: the proofline hook of Claude Code loads \.agents\/scripts\/proofline-core\.mjs and the skill scripts too, so a script kept as yours runs there even without core\.hooksPath/, r.out);
  assert.equal(readFileSync(`${d}/.agents/scripts/proofline-core.mjs`, 'utf8'), coreWriting(m));
  // control: this is what the refusal prevents
  git(d, ['config', '--local', 'core.hooksPath', '.agents/githooks']);
  writeFileSync(`${d}/b.txt`, 'b\n'); git(d, ['add', 'b.txt']);
  git(d, ['commit', '-q', '-m', 'y']);
  assert.equal(existsSync(m), true, 'control: the hostile core did not run, so the case proves nothing');
});

test('A249 init (R1): an extra module in the Node hook folder and a linked script keep the path unset', () => {
  const a = sb.mkrepo('extra-hook-module');
  writeExec(`${a}/.agents/hooks/zz-evil.mjs`, 'export {};\n');
  const ra = sb.pl(a, INIT);
  assert.equal(ra.status, 0, ra.text);
  assert.match(ra.out, /\.agents\/hooks\/zz-evil\.mjs is not a file proofline ships/, ra.out);
  assert.equal(hp(a), '');
  const b = sb.mkrepo('link-script');
  mkdirSync(`${b}/.agents/scripts`, { recursive: true });
  symlinkSync('/etc/hosts', `${b}/.agents/scripts/proofline-core.mjs`);
  const rb = sb.pl(b, INIT);
  assert.equal(rb.status, 0, rb.text);
  assert.equal(hp(b), '');
  assert.match(rb.out, /\.agents\/scripts\/proofline-core\.mjs is a symbolic link/, rb.out);
});

// ---- doctor ---------------------------------------------------------------------------------------------------------------------------------------------

/** An installed project (the hooks path set) with the hooks and scripts committed. */
const installed = (/** @type {string} */ name) => { const d = sb.copy(name); assert.equal(hp(d), '.agents/githooks'); return d; };
const hooksLines = (/** @type {string} */ out) => out.split('\n').filter((l) => /^(PASS|WARN|FAIL) git hooks:/.test(l));

test('A249 doctor: a hook that differs from the shipped sha256 FAILs (and names proofline upgrade for the stale case); a restored copy passes again', () => {
  const d = installed('doc-mod');
  assert.match(hooksLines(doctor(d).out).join('\n'), /^PASS git hooks: .*identical to the shipped copies/);
  writeExec(`${d}/.agents/githooks/pre-push`, HOSTILE);
  const r = doctor(d);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-push differs from the copy proofline ships \(sha256 mismatch\)[^\n]*If you did not edit it \(an older proofline left it\), run: proofline upgrade; otherwise review it/m, r.out);
  assert.notEqual(r.status, 0);
  copyFileSync(`${SHIPPED}/pre-push`, `${d}/.agents/githooks/pre-push`); chmodSync(`${d}/.agents/githooks/pre-push`, 0o755);
  assert.match(doctor(d).out, /^PASS git hooks: /m);
});

test('A249 doctor: a hook that is a symbolic link FAILs even when its target has the shipped content; so does an extra file and a linked folder', () => {
  const d = installed('doc-link');
  copyFileSync(`${SHIPPED}/pre-commit`, `${d}/real-copy`); chmodSync(`${d}/real-copy`, 0o755);
  spawnSync('rm', [`${d}/.agents/githooks/pre-commit`]);
  symlinkSync(`${d}/real-copy`, `${d}/.agents/githooks/pre-commit`);
  const r = doctor(d);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-commit is a symbolic link; git would run its target/m, r.out);
  assert.doesNotMatch(r.out, /^PASS git hooks:/m);
  const e = installed('doc-extra');
  writeExec(`${e}/.agents/githooks/post-merge`, HOSTILE);
  const re = doctor(e);
  assert.match(re.out, /^FAIL git hooks: \.agents\/githooks\/post-merge is not a file proofline ships/m, re.out);
  assert.doesNotMatch(re.out, /^PASS git hooks:/m);
  const f = installed('doc-dirlink');
  spawnSync('mv', [`${f}/.agents/githooks`, `${f}/hooks-real`]);
  symlinkSync(`${f}/hooks-real`, `${f}/.agents/githooks`);
  assert.match(doctor(f).out, /^FAIL git hooks: \.agents\/githooks is a symbolic link or not a folder/m);
});

test('A249 doctor (R1): a modified script or Node hook, and a kept file the manifest does not list, FAIL; "manifest: every installed file matches" cannot pass over them', () => {
  const d = installed('doc-core');
  const core = `${d}/.agents/scripts/proofline-core.mjs`;
  writeExec(core, coreWriting(marker()));
  const r = doctor(d);
  assert.match(r.out, /^FAIL code: 1 script or hook file\(s\) of \.agents are not proofline's shipped copy \(\.agents\/scripts\/proofline-core\.mjs differs from proofline's copy\)/m, r.out);
  assert.doesNotMatch(r.out, /^PASS manifest: every installed file matches/m);
  assert.notEqual(r.status, 0);
  // the manifest does not list it (a kept file is never recorded): the manifest line must not pass either
  const e = installed('doc-unlisted');
  const mf = `${e}/.agents/.proofline-manifest`;
  writeFileSync(mf, readFileSync(mf, 'utf8').split('\n').filter((l) => !l.endsWith('  .agents/scripts/proofline-core.mjs')).join('\n'));
  assert.doesNotMatch(doctor(e).out, /^PASS manifest: every installed file matches/m);
  // a Node hook file
  const f = installed('doc-nodehook');
  writeFileSync(`${f}/.agents/hooks/lib/zz-extra.mjs`, 'export {};\n');
  assert.match(doctor(f).out, /^FAIL code: .*\.agents\/hooks\/lib\/zz-extra\.mjs is not a file proofline ships/m);
});

// ---- SECURITY-1: doctor runs no project code that differs ----------------------------------------------------------------------------------------------

test('A249 doctor (SECURITY-1): hostile committed hooks AND a hostile proofline-core.mjs are not run by doctor, probes included; a clean install\'s probes still pass (the one test with probes)', () => {
  const m = marker();
  const d = installed('doc-hostile');
  writeExec(`${d}/.agents/githooks/pre-commit`, hookWriting(m));
  writeExec(`${d}/.agents/githooks/pre-push`, hookWriting(m));
  writeExec(`${d}/.agents/scripts/proofline-core.mjs`, coreWriting(m));
  // control: a plain commit in this repository runs the hostile hook
  git(d, ['commit', '-q', '--allow-empty', '-m', 'control']);
  assert.equal(existsSync(m), true, 'control: the hostile hook did not run');
  rmSync(m);
  const r = sb.pl(d, ['doctor']);
  assert.equal(existsSync(m), false, `doctor ran project code:\n${r.out}`);
  assert.match(r.out, /^WARN probes: skipped, because the project's own hooks or scripts are not proofline's shipped copy/m, r.out);
  assert.match(r.out, /^WARN doctor: the config check, the approval timing, the rules report, the time limits and the lead model check were not run/m, r.out);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-commit differs/m, r.out);
  // hostile core only (the hooks are proofline's): still not run
  const e = installed('doc-hostile-core');
  writeExec(`${e}/.agents/scripts/proofline-core.mjs`, coreWriting(m));
  const re = sb.pl(e, ['doctor']);
  assert.equal(existsSync(m), false, `doctor ran the project's core:\n${re.out}`);
  assert.match(re.out, /^WARN probes: skipped/m, re.out);
  // SEC-1: a committed config.yaml that is a symbolic link to a file outside the project: the probes write nowhere but their own folder
  const g = installed('doc-cfglink');
  const outside = `${sb.T}/outside-config.yaml`;
  writeFileSync(outside, 'outside: untouched\n');
  rmSync(`${g}/.agents/config.yaml`); symlinkSync(outside, `${g}/.agents/config.yaml`);
  const rg = sb.pl(g, ['doctor']);
  assert.equal(readFileSync(outside, 'utf8'), 'outside: untouched\n', `a probe wrote through the symlinked config:\n${rg.out}`);
  assert.match(rg.out, /^PASS probe: pre-commit blocks a forbidden identity/m, rg.out);
  // a clean install: the probes run the shipped hooks and pass, with a minimal environment
  const c = installed('doc-clean');
  const rc = sb.pl(c, ['doctor'], { SSH_AUTH_SOCK: '/nonexistent/agent', GITHUB_TOKEN: 'secret-token' });
  assert.match(rc.out, /^PASS probe: pre-commit blocks a forbidden identity/m, rc.out);
  assert.match(rc.out, /^PASS probe: pre-push blocks a push without approval/m, rc.out);
  assert.match(rc.out, /^PASS probe: the Claude PreToolUse hook denies a lead edit of product code during a run/m, rc.out);
  assert.doesNotMatch(rc.out, /^FAIL /m, rc.out);
});

test('A249 doctor (SECURITY-1): the probe environment is an allowlist, HOME is the throwaway folder, no credential or agent socket reaches it', () => {
  const env = probeEnv({ PATH: '/bin', LANG: 'C', HOME: '/home/u', SSH_AUTH_SOCK: '/tmp/agent', GITHUB_TOKEN: 't', GH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', GIT_ASKPASS: 'x', PROOFLINE_CLAUDE_BIN: 'x', ANTHROPIC_API_KEY: 'k', GIT_AUTHOR_EMAIL: 'a@b' }, '/tmp/probe-home');
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH', 'PROOFLINE_NO_TTY']);
  assert.equal(env.HOME, '/tmp/probe-home');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
});

// ---- settings (item 2 of the review; A238 closed it for the project files, R2 adds the user's and the managed ones) ---------------------------------------------

/** Rewrite the project's settings.json with FN and run doctor. */
function withSettings(/** @type {string} */ name, /** @type {(j: any) => void} */ fn, /** @type {string} */ file = 'settings.json', /** @type {NodeJS.ProcessEnv} */ extra = {}) {
  const d = installed(name);
  const f = `${d}/.claude/${file}`;
  /** @type {any} */ let j = {};
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { /* a new file */ }
  fn(j);
  writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
  return doctor(d, extra);
}
const SHIPPED_PRE = JSON.parse(readFileSync(path.join(repo, 'adapters', 'claude', 'settings.fragment.json'), 'utf8')).hooks.PreToolUse[0].matcher;
const everyMatcher = (/** @type {any} */ j, /** @type {string} */ m) => { for (const groups of Object.values(/** @type {Record<string, any[]>} */ (j.hooks))) for (const g of groups) if (g.matcher !== undefined) g.matcher = m; };

test('A249 settings (item 2): a matcher that names a tool that never fires, a list missing a tool, a regular-expression lookalike and disableAllHooks FAIL; empty and * matchers are wide enough', () => {
  const never = withSettings('set-never', (j) => { everyMatcher(j, 'NoSuchTool'); j.disableAllHooks = true; });
  assert.doesNotMatch(never.out, /^PASS claude hooks: .*wires all 7/m, never.out);
  assert.match(never.out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m, never.out);
  assert.match(never.out, /^FAIL claude hooks: disableAllHooks is true in \.claude\/settings\.json/m, never.out);
  assert.notEqual(never.status, 0);
  const missing = withSettings('set-missing', (j) => { j.hooks.PreToolUse[0].matcher = SHIPPED_PRE.split('|').slice(0, -1).join('|'); });
  assert.match(missing.out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m, missing.out);
  const regex = withSettings('set-regex', (j) => { j.hooks.PreToolUse[0].matcher = `(?!)(|${SHIPPED_PRE})`; });
  assert.match(regex.out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m, regex.out);
  for (const wide of ['', '*']) {
    const ok = withSettings(`set-wide-${wide === '' ? 'empty' : 'star'}`, (j) => { j.hooks.PreToolUse[0].matcher = wide; });
    assert.doesNotMatch(ok.out, /narrower matcher/, `'${wide}': ${ok.out}`);
    assert.match(ok.out, /^PASS claude hooks: .*wires all 7/m, `'${wide}': ${ok.out}`);
  }
  const local = withSettings('set-local', (j) => { j.disableAllHooks = true; }, 'settings.local.json');
  assert.match(local.out, /^FAIL claude hooks: disableAllHooks is true in \.claude\/settings\.local\.json/m, local.out);
});

test('A249 settings (R2): disableAllHooks in the user\'s ~/.claude/settings.json or in the managed settings FAILs; false and absent do not', () => {
  const home = mkdtempSync(`${sb.T}/uhome-`);
  mkdirSync(`${home}/.claude`);
  const d = installed('set-user');
  writeFileSync(`${home}/.claude/settings.json`, '{"disableAllHooks": true}\n');
  const r = doctor(d, { HOME: home });
  assert.match(r.out, /^FAIL claude hooks: disableAllHooks is true in ~\/\.claude\/settings\.json/m, r.out);
  assert.doesNotMatch(r.out, /^PASS claude hooks: .*wires all 7/m, r.out);
  writeFileSync(`${home}/.claude/settings.json`, '{"disableAllHooks": false}\n');
  assert.doesNotMatch(doctor(d, { HOME: home }).out, /disableAllHooks is/);
  const managed = `${sb.T}/managed-settings.json`;
  writeFileSync(managed, '{"disableAllHooks": true}\n');
  const rm = doctor(d, { HOME: home, PROOFLINE_CLAUDE_MANAGED_SETTINGS: managed });
  assert.match(rm.out, /^FAIL claude hooks: disableAllHooks is true in the managed settings/m, rm.out);
});

// ---- round 2: tracked extras, skill scripts, terminal control characters ------------------------------------------------------------------------------------

test('A249 init and doctor (SEC-2): a TRACKED extra file in .agents/scripts keeps the path unset after the user deleted it from the working tree; doctor FAILs', () => {
  const d = cloned('tracked-extra', shippedHooks());
  writeExec(`${d}/.agents/scripts/secret-scan.sh`, HOSTILE);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'scanner']);
  rmSync(`${d}/.agents/scripts/secret-scan.sh`);
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '', 'the path was set although HEAD tracks a script that proofline does not ship');
  assert.match(r.out, /\.agents\/scripts\/secret-scan\.sh is not a file proofline ships/, r.out);
  git(d, ['checkout', '--', '.agents/scripts/secret-scan.sh']);
  assert.equal(readFileSync(`${d}/.agents/scripts/secret-scan.sh`, 'utf8'), HOSTILE, 'what the attack relies on: a restore brings it back');
  const i = installed('doc-tracked-extra');
  git(i, ['add', '-A']); git(i, ['commit', '-q', '-m', 'install']);
  writeExec(`${i}/.agents/hooks/zz.mjs`, 'export {};\n');
  git(i, ['add', '-A']); git(i, ['commit', '-q', '-m', 'extra']);
  rmSync(`${i}/.agents/hooks/zz.mjs`);
  const rd = doctor(i);
  assert.match(rd.out, /^FAIL code: .*\.agents\/hooks\/zz\.mjs is not a file proofline ships/m, rd.out);
});

test('A249 doctor: a modified skill script that the core starts FAILs and is not run', () => {
  const rel = [...shippedCode(repo).keys()].find((k) => /^\.agents\/skills\/[^/]+\/scripts\/[^/]+\.mjs$/.test(k));
  assert.ok(rel, 'no shipped skill script found');
  const d = installed('doc-skill-script');
  const m = marker();
  writeExec(`${d}/${rel}`, coreWriting(m));
  const r = doctor(d);
  assert.match(r.out, new RegExp(`^FAIL code: .*${rel.replace(/[.]/g, '\\.')} differs from proofline's copy`, 'm'), r.out);
  assert.equal(existsSync(m), false);
});

test('A249 messages (SEC-3): a repository-controlled file name with control characters never reaches the terminal as such, in init and in doctor', () => {
  const evil = 'post-\x1b[31mcheckout';
  const d = cloned('esc', { ...shippedHooks(), [evil]: HOSTILE });
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.ok(!r.text.includes('\x1b'), JSON.stringify(r.text.split('\n').filter((l) => l.includes('post-'))));
  assert.match(r.out, /post-\?\[31mcheckout is not a file proofline ships/, r.out);
  const i = installed('doc-esc');
  writeExec(`${i}/.agents/githooks/${evil}`, HOSTILE);
  const rd = doctor(i);
  assert.ok(!rd.text.includes('\x1b'), 'doctor printed the escape character');
  assert.match(rd.out, /^FAIL git hooks: \.agents\/githooks\/post-\?\[31mcheckout is not a file proofline ships/m, rd.out);
});
