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
import { clean, cleanBytes, cleanLines, cleanOut, codeAudit, couldAlias, foldName, problemText, shippedCode, shortNameOf } from '../../control-plane/agents/scripts/core/codetrust.mjs';
import { matcherCovers, probeEnv, recordText } from '../../control-plane/agents/scripts/core/doctor.mjs';
import { repo } from './helpers.mjs';
import { sandbox } from './frontend-lib.mjs';
import { launch } from '../lib/winpath.mjs';

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

test('A249 init (route b, R3): hooks that are proofline\'s on disk but staged or committed differently are found; upgrade keeps an active path and says to COMMIT proofline\'s copy', () => {
  const d = sb.copy('route-b');
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'install']);
  assert.deepEqual(audit(d), []);
  // HEAD holds a hostile blob, the working copy is back to proofline's
  const hook = `${d}/.agents/githooks/pre-commit`;
  const good = readFileSync(hook, 'utf8');
  writeExec(hook, HOSTILE); git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'hostile']);
  writeExec(hook, good);
  assert.deepEqual(audit(d), ['head .agents/githooks/pre-commit', 'index .agents/githooks/pre-commit']); // the hostile commit also made the index hostile
  const up = sb.pl(d, ['upgrade', '--yes']);
  assert.match(up.out, /core\.hooksPath already points at \.agents\/githooks, but the code it runs is not proofline's shipped copy: .*pre-commit is committed \(HEAD\)/, up.out);
  // R3: the file on disk is already proofline's: deleting it (the old advice) is not the remedy, committing it is
  assert.match(up.out, /commit proofline's copy of the file\(s\) \(git add \.agents, then git commit\)/, up.out);
  assert.doesNotMatch(up.out, /delete the file\(s\) that differ/, up.out);
  assert.equal(hp(d), '.agents/githooks', 'upgrade must not unset a path that is active (a normal upgrade has the new files uncommitted)');
  // staged only
  git(d, ['checkout', '-q', 'HEAD~1', '--', '.agents/githooks/pre-commit']);
  writeExec(hook, HOSTILE); git(d, ['add', hook]); writeExec(hook, good);
  assert.ok(audit(d).includes('index .agents/githooks/pre-commit'), String(audit(d)));
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

// ---- round 2: tracked extras and terminal control characters in init ----------------------------------------------------------------------------------------

test('A249 init (SEC-2): a TRACKED extra file in .agents/scripts keeps the path unset after the user deleted it from the working tree', () => {
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
});

test('A249 init (SEC-3): a repository-controlled file name with control characters never reaches the terminal as such', () => {
  const evil = 'post-\x1b[31mcheckout';
  const d = cloned('esc', { ...shippedHooks(), [evil]: HOSTILE });
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.ok(!r.text.includes('\x1b'), JSON.stringify(r.text.split('\n').filter((l) => l.includes('post-'))));
  assert.match(r.out, /post-\?\[31mcheckout is not a file proofline ships/, r.out);
});

test('A249 init and upgrade (SEC-A): a name made of letters whose LOW BYTE is a control byte (U+011B = ESC, U+010A = LF, U+010D = CR, U+019B = CSI) cannot erase or forge the NOT set warning; Turkish letters stay readable', () => {
  // written as latin1 these were ESC [1A ESC [2K, a line feed and a carriage return: the sanitiser had run on the text, the writer then cut each letter to its low byte
  const evil = 'x\u011b[1A\u011b[2K\u010aPASS\u010dnothing\u019bK-\u0131\u015f\u011f\u0130\u00fc\u202e\u2066\ufeff\u2028';
  const d = cloned('lowbyte', { ...shippedHooks(), [evil]: HOSTILE });
  for (const args of [INIT, ['upgrade', '--yes']]) {
    const r = sb.pl(d, args);
    assert.equal(r.status, 0, r.text);
    const raw = Buffer.from(r.text, 'utf8');
    assert.doesNotMatch(r.text, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff]/, JSON.stringify(r.text.split('\n').filter((l) => l.includes('x'))));
    assert.ok(!raw.includes(0x1b), 'an ESC byte reached the output');
    assert.match(r.out, /NOT set to \.agents\/githooks/, r.out);
    assert.match(r.out, /x\u011b\[1A\u011b\[2K\u010aPASS\u010dnothing\u019bK-/, 'the letters are shown as the letters they are (UTF-8), not cut to a byte');
    assert.match(r.out, /\?\?\?\?/, 'the direction and separator characters were not replaced');
    assert.ok(!r.out.split('\n').some((l) => l.startsWith('PASS')), 'a forged line');
    assert.match(r.out, /\u0131\u015f\u011f\u0130\u00fc/, 'Turkish letters were mangled');
  }
});

// ---- the decisions, in process (R5: codeAudit is what init and doctor both ask; only a few runs below go through the real doctor) ---------------------------------

/** An installed project (the hooks path set) with the hooks and scripts on disk. */
const installed = (/** @type {string} */ name) => { const d = sb.copy(name); assert.equal(hp(d), '.agents/githooks'); return d; };
/** The audit of a project as `kind path` strings. */
const audit = (/** @type {string} */ d) => { const a = codeAudit(d, repo, sb.env); assert.equal(a.unreadable, false); return a.problems.map((p) => `${p.kind} ${p.rel}`).sort(); };
const SKILL_SCRIPT = [...shippedCode(repo).keys()].find((k) => /^\.agents\/skills\/[^/]+\/scripts\/[^/]+\.mjs$/.test(k)) ?? '';
const crlfOf = (/** @type {string} */ f) => writeFileSync(f, Buffer.from(readFileSync(f, 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1'));

test('A249 codeAudit: a modified hook, script, Node hook or skill script, a link, an extra file, a linked folder and a tracked extra are found; a clean install has no problem', () => {
  assert.ok(SKILL_SCRIPT !== '', 'no shipped skill script found');
  assert.deepEqual(audit(installed('au-clean')), []);
  /** @type {Array<[string, (d: string) => void, string]>} */
  const cases = [
    ['au-hook', (d) => writeExec(`${d}/.agents/githooks/pre-push`, HOSTILE), 'differs .agents/githooks/pre-push'],
    ['au-link', (d) => { copyFileSync(`${SHIPPED}/pre-commit`, `${d}/real-copy`); rmSync(`${d}/.agents/githooks/pre-commit`); symlinkSync(`${d}/real-copy`, `${d}/.agents/githooks/pre-commit`); }, 'link .agents/githooks/pre-commit'],
    ['au-extra', (d) => writeExec(`${d}/.agents/githooks/post-merge`, HOSTILE), 'extra .agents/githooks/post-merge'],
    ['au-dirlink', (d) => { spawnSync('mv', [`${d}/.agents/githooks`, `${d}/hooks-real`]); symlinkSync(`${d}/hooks-real`, `${d}/.agents/githooks`); }, 'link .agents/githooks'],
    ['au-core', (d) => writeExec(`${d}/.agents/scripts/proofline-core.mjs`, coreWriting(marker())), 'differs .agents/scripts/proofline-core.mjs'],
    ['au-nodehook', (d) => writeFileSync(`${d}/.agents/hooks/lib/zz-extra.mjs`, 'export {};\n'), 'extra .agents/hooks/lib/zz-extra.mjs'],
    ['au-skill', (d) => writeExec(`${d}/${SKILL_SCRIPT}`, coreWriting(marker())), `differs ${SKILL_SCRIPT}`],
    ['au-missing', (d) => rmSync(`${d}/${SKILL_SCRIPT}`), `missing ${SKILL_SCRIPT}`],
  ];
  for (const [name, mutate, want] of cases) {
    const d = installed(name); mutate(d);
    const got = audit(d);
    assert.ok(got.includes(want), `${name}: ${want} not in ${JSON.stringify(got)}`);
  }
  // tracked: a file that proofline does not ship, committed, then deleted from the working tree (git restore brings it back)
  const t = installed('au-tracked');
  writeExec(`${t}/.agents/hooks/zz.mjs`, 'export {};\n'); git(t, ['add', '-A']); git(t, ['commit', '-q', '-m', 'extra']);
  rmSync(`${t}/.agents/hooks/zz.mjs`);
  assert.ok(audit(t).includes('extra .agents/hooks/zz.mjs'), String(audit(t)));
});

test('A249 codeAudit (R2): CRLF line ends (core.autocrlf=true) are the same file for JS, JSON and Markdown, in the working tree and in a CRLF blob; a shell script and a git hook stay exact and say line endings', () => {
  const d = installed('au-crlf');
  const rows = readFileSync(`${d}/.agents/.proofline-manifest`, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.replace(/^\S+\s+/, ''));
  for (const rel of new Set([...rows, ...shippedCode(repo).keys()])) if (existsSync(`${d}/${rel}`)) crlfOf(`${d}/${rel}`);
  const a = codeAudit(d, repo, sb.env);
  assert.deepEqual(a.problems.filter((p) => /\.(mjs|js|json|md)$/.test(p.rel)), [], 'a CRLF JS file counted as different');
  const hook = a.problems.find((p) => p.rel === '.agents/githooks/pre-commit');
  assert.equal(hook?.kind, 'differs', 'a shell hook with CR line ends must stay different');
  assert.equal(hook?.eol, true);
  assert.match(problemText(/** @type {any} */ (hook)), /except for its line endings \(CRLF/);
  // the same, committed as CRLF (autocrlf=false at add time): the blobs of JS files are proofline's copy too
  git(d, ['-c', 'core.autocrlf=false', 'add', '-A']); git(d, ['commit', '-q', '-m', 'crlf']);
  assert.deepEqual(audit(d).filter((p) => /\.(mjs|js|json|md)$/.test(p)), []);
  // doctor: the hook says line endings, and the manifest counts only the files that really differ (the shell scripts, configs ...)
  const rd = doctor(d);
  assert.match(rd.out, /^FAIL git hooks: \.agents\/githooks\/pre-commit is proofline's copy except for its line endings/m, rd.out);
  const expected = rows.filter((rel) => !/\.(mjs|js|cjs|json|md)$/.test(rel) && existsSync(`${d}/${rel}`) && readFileSync(`${d}/${rel}`, 'latin1').includes('\r\n')).length;
  assert.match(rd.out, new RegExp(`^WARN manifest: ${expected} installed file\\(s\\) differ`, 'm'), `${expected}: ${rd.out}`);
  // init on that checkout: one summary line instead of one per file, and the cause named with the one-line fix
  rmSync(`${d}/.agents/.proofline-manifest`); // a fresh clone that has no manifest: every differing file counts as the user's
  const r = sb.pl(d, ['init', '--yes', '--runtimes', 'claude,codex']);
  assert.equal(r.status, 0, r.text);
  const kept = r.out.split('\n').filter((l) => /^ {2}= kept/.test(l));
  assert.equal(kept.length, 1, kept.join('\n'));
  assert.match(kept[0], /^ {2}= kept {6}\d+ files differ from proofline's version and are untouched \(first 5: /);
  // exactly the files that cannot be read alike with CRLF (shell scripts, configs ...) are kept; no JS, JSON or Markdown file is among them
  assert.equal(Number(/= kept {6}(\d+) files/.exec(kept[0])?.[1]), expected, kept[0]);
  assert.match(r.out, /git config core\.autocrlf false/, r.out);
  assert.match(r.out, /proofline's copy except for its line endings/, r.out);
});

test('A249 codeAudit: the case-insensitive file system (core.ignorecase=true): a tracked ".agents/Scripts/..." that collides with a shipped path is found even after it was deleted from the working tree', (t) => {
  const d = sb.mkrepo('icase');
  writeFileSync(`${d}/probe-Case`, ''); const folds = existsSync(`${d}/probe-case`);
  if (!folds) { t.skip('this file system is case-sensitive'); return; }
  assert.equal(git(d, ['config', '--get', 'core.ignorecase']).stdout.trim(), 'true');
  writeExec(`${d}/.agents/Scripts/agent.sh`, HOSTILE); writeExec(`${d}/.agents/Scripts/zz-evil.sh`, HOSTILE);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'collide']);
  rmSync(`${d}/.agents/Scripts`, { recursive: true });
  const got = audit(d);
  assert.ok(got.includes('extra .agents/Scripts/agent.sh'), `the colliding shipped name was not found: ${JSON.stringify(got)}`);
  assert.ok(got.includes('extra .agents/Scripts/zz-evil.sh'), `the extra file was not found: ${JSON.stringify(got)}`);
  // init does not set the path over it
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '');
  assert.match(r.out, NOT_SET, r.out);
});

test('A249 matchers: a tool that never fires, a list missing a tool and a regular-expression lookalike are narrower than the shipped matcher; empty, * and the shipped list are wide enough', () => {
  const shortList = SHIPPED_PRE.split('|').slice(0, -1).join('|');
  for (const [have, ok] of /** @type {Array<[string, boolean]>} */ ([['NoSuchTool', false], [shortList, false], [`(?!)(|${SHIPPED_PRE})`, false], ['', true], ['*', true], [SHIPPED_PRE, true]])) {
    assert.equal(matcherCovers(have, SHIPPED_PRE, 'PreToolUse'), ok, `'${have}'`);
  }
});

// ---- the real doctor: a few end-to-end runs ---------------------------------------------------------------------------------------------------------

test('A249 doctor (SECURITY-1): hostile committed hooks AND a hostile proofline-core.mjs are not run by doctor; a clean install\'s probes pass with a minimal environment (the one test with probes)', () => {
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
  assert.match(re.out, /^FAIL code: 1 script or hook file\(s\) of \.agents are not proofline's shipped copy \(\.agents\/scripts\/proofline-core\.mjs differs from proofline's copy\)/m, re.out);
  assert.notEqual(re.status, 0);
  // SEC-1: a committed config.yaml that is a symbolic link to a file outside the project: the probes write nowhere but their own folder; the probes of a clean install pass with
  // SSH_AUTH_SOCK and a token set (neither reaches them)
  const g = installed('doc-cfglink');
  const outside = `${sb.T}/outside-config.yaml`;
  writeFileSync(outside, 'outside: untouched\n');
  rmSync(`${g}/.agents/config.yaml`); symlinkSync(outside, `${g}/.agents/config.yaml`);
  const rg = sb.pl(g, ['doctor'], { SSH_AUTH_SOCK: '/nonexistent/agent', GITHUB_TOKEN: 'secret-token' });
  assert.equal(readFileSync(outside, 'utf8'), 'outside: untouched\n', `a probe wrote through the symlinked config:\n${rg.out}`);
  assert.match(rg.out, /^PASS probe: pre-commit blocks a forbidden identity/m, rg.out);
  assert.match(rg.out, /^PASS probe: pre-push blocks a push without approval/m, rg.out);
  assert.match(rg.out, /^PASS probe: the Claude PreToolUse hook denies a lead edit of product code during a run/m, rg.out);
});

test('A249 doctor (SECURITY-1): the probe environment is an allowlist, HOME is the throwaway folder, no credential or agent socket reaches it', () => {
  const env = probeEnv({ PATH: '/bin', LANG: 'C', HOME: '/home/u', SSH_AUTH_SOCK: '/tmp/agent', GITHUB_TOKEN: 't', GH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', GIT_ASKPASS: 'x', PROOFLINE_CLAUDE_BIN: 'x', ANTHROPIC_API_KEY: 'k', GIT_AUTHOR_EMAIL: 'a@b' }, '/tmp/probe-home');
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH', 'PROOFLINE_NO_TTY']);
  assert.equal(env.HOME, '/tmp/probe-home');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
});

test('A249 doctor (R1): a modified git hook alone does not make doctor skip the config check and the approval timing (it never starts a git hook); the hook itself FAILs', () => {
  const d = installed('doc-hook-only');
  writeExec(`${d}/.agents/githooks/pre-push`, HOSTILE);
  // and, in the same run, a hook that is a link to a file with the shipped content, and an extra hook name
  copyFileSync(`${SHIPPED}/pre-commit`, `${d}/real-copy`); chmodSync(`${d}/real-copy`, 0o755);
  rmSync(`${d}/.agents/githooks/pre-commit`); symlinkSync(`${d}/real-copy`, `${d}/.agents/githooks/pre-commit`);
  writeExec(`${d}/.agents/githooks/post-merge`, HOSTILE);
  const r = doctor(d);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-commit is a symbolic link; git would run its target/m, r.out);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/post-merge is not a file proofline ships/m, r.out);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-push differs from the copy proofline ships \(sha256 mismatch\)[^\n]*If you did not edit it \(an older proofline left it\), run: proofline upgrade; otherwise review it/m, r.out);
  assert.match(r.out, /^PASS config: /m, r.out);
  assert.match(r.out, /^PASS approval path: /m, r.out);
  assert.doesNotMatch(r.out, /^WARN doctor: the config check/m, r.out);
  assert.doesNotMatch(r.out, /^PASS git hooks:/m, r.out);
  assert.notEqual(r.status, 0);
});

test('A249 doctor (R1): a missing shipped file is a broken install (FAIL engine, or WARN for a skill script), never "code"; a hostile manifest that omits its row still shows it; doctor does not crash', () => {
  const d = installed('doc-missing');
  const gone = '.agents/scripts/core/leftover.mjs';
  rmSync(`${d}/${gone}`); rmSync(`${d}/${SKILL_SCRIPT}`);
  const mf = `${d}/.agents/.proofline-manifest`;
  writeFileSync(mf, readFileSync(mf, 'utf8').split('\n').filter((l) => !l.endsWith(`  ${gone}`) && !l.endsWith(`  ${SKILL_SCRIPT}`)).join('\n'));
  const r = doctor(d);
  assert.match(r.out, new RegExp(`^FAIL engine: 1 file\\(s\\) proofline ships are missing from \\.agents \\(${gone.replace(/[.]/g, '\\.')}\\)`, 'm'), r.out);
  assert.match(r.out, new RegExp(`^WARN engine: 1 skill script\\(s\\) proofline ships are missing \\(${SKILL_SCRIPT.replace(/[.]/g, '\\.')}\\)`, 'm'), r.out);
  assert.doesNotMatch(r.out, /^FAIL code:/m, r.out);
  assert.doesNotMatch(r.out, /^PASS engine:/m, r.out);
  assert.match(r.out, /^doctor: \d+ FAIL, \d+ WARN$/m, 'doctor did not finish');
  assert.notEqual(r.status, 0);
});

test('A249 sanitiser (SEC-A, L1, in process): clean, cleanLines and cleanBytes replace C0, DEL, C1, bidi and format characters and the line breaks; Turkish letters pass; a text with a letter above 0xFF is encoded as UTF-8 before it is cleaned', () => {
  const bad = ['\x1b', '\n', '\r', '\x7f', '\x9b', '\u0085', '؜', '​', '‏', ' ', ' ', '‪', '‮', '⁠', '⁦', '⁩', '﻿'];
  for (const c of bad) {
    assert.equal(clean(`a${c}b`), 'a?b', JSON.stringify(c));
    assert.equal(cleanLines(`a${c}b`), 'a?b', JSON.stringify(c));
    assert.equal(cleanBytes(`a${Buffer.from(c, 'utf8').toString('latin1')}b`), 'a?b', `bytes of ${JSON.stringify(c)}`);
    assert.equal(cleanBytes(`a${c}b`), 'a?b', `text ${JSON.stringify(c)}`);
  }
  const tr = 'ışğİüöç';
  assert.equal(clean(tr), tr); assert.equal(cleanLines(tr), tr);
  assert.equal(cleanBytes(Buffer.from(tr, 'utf8').toString('latin1')), Buffer.from(tr, 'utf8').toString('latin1'));
  // U+011B U+010A U+010D U+019B: low bytes ESC LF CR CSI. They are letters: kept as letters, and the bytes that are written contain no control byte
  const letters = 'xě[1AĊčƛ';
  const out = Buffer.from(cleanBytes(letters), 'latin1');
  assert.equal(out.toString('utf8'), letters);
  assert.ok(![...out].some((b) => b < 0x20 || b === 0x7f), 'a control byte was written');
});

test('A249 doctor (SEC-C, in process): a record never carries a line that starts at the left margin except its first; a relayed multi-line report keeps its indentation', () => {
  const forged = "PASS code: every script and hook is proofline's copy";
  assert.equal(recordText(`WARN x: a\n${forged}\r ${forged}\x1b[2K`), `WARN x: a\n    ${forged}??${forged}?[2K`, 'forged lines are indented and cleaned');
  assert.equal(recordText('PASS context:\n      AGENTS.md  12 bytes\n  tail'), 'PASS context:\n      AGENTS.md  12 bytes\n      tail');
  for (const l of recordText(`WARN a\n${forged}\n${forged}`).split('\n').slice(1)) assert.match(l, /^ {4}/);
});

test('A249 codeAudit (SEC-B, in process): a name that a folding file system can resolve to a code path is found by shape, not by a table of folds', () => {
  assert.ok(couldAlias('.agents', '.agents') && couldAlias('.Agents', '.agents') && couldAlias('.agentſ', '.agents') && couldAlias('ſcripts', 'scripts') && couldAlias('Ka', 'ka'));
  assert.ok(!couldAlias('scripts', 'githooks') && !couldAlias('script', 'scripts') && !couldAlias('aſb', 'a/b'), 'a non-ASCII letter must not stand for a slash');
  // R5-1: a non-ASCII character is no wildcard; only known foldings (long s, Kelvin, ligatures, sharp s, Turkish i) and ignorable characters count
  assert.ok(!couldAlias('文档', '.agents') && !couldAlias('şş', 'scripts') && !couldAlias('şş', '.agents') && !couldAlias('Привет', 'githooks') && !couldAlias('é', 'e'));
  assert.ok(couldAlias('sKills', 'skills') && couldAlias('ﬁle', 'file') && couldAlias('stra\u00dfe', 'strasse') && couldAlias('scr\u200bipts', 'scripts') && couldAlias('\u0130', 'i') && couldAlias('ｓｃｒｉｐｔｓ', 'scripts'));
  assert.equal(foldName('\u017fcripts'), 'scripts');
  // SEC-D: NTFS 8.3 short names (a folder gets one; a single file does not matter)
  assert.ok(shortNameOf('AGENTS~1', ['agents']) && shortNameOf('SCRIPT~1', ['scripts']) && shortNameOf('GITHOO~1', ['githooks']) && shortNameOf('ECOSYS~1.MJS', ['ecosystemsmjs']) && shortNameOf('design~1'));
  assert.ok(!shortNameOf('AGENTS~1', ['scripts']) && !shortNameOf('agents') && !shortNameOf('knowledge~') && !shortNameOf('toolongname~1'));
  assert.ok(couldAlias('.agents/scripts/core/codetruſt.mjs', '.agents/scripts/core/codetrust.mjs'));
});

/** Track PATHS (name -> text) in the index and HEAD of D without writing them to the working tree (an alias would collide on a folding disk). */
function trackOnly(/** @type {string} */ d, /** @type {string[]} */ paths, /** @type {string} */ text = HOSTILE) {
  const blob = spawnSync('git', ['-C', d, 'hash-object', '-w', '--stdin'], { env: sb.env, encoding: 'utf8', input: text }).stdout.trim();
  for (const f of paths) assert.equal(git(d, ['update-index', '--add', '--cacheinfo', `100755,${blob},${f}`]).status, 0, f);
  assert.equal(git(d, ['commit', '-q', '--no-verify', '-m', 'track']).status, 0);
}
const extras = (/** @type {string} */ d) => audit(d).filter((x) => x.startsWith('extra ')).map((x) => x.slice(6));

test('A249 codeAudit (R5-1, in process): under core.ignorecase=true a tree of all-non-ASCII names (CJK, Turkish, Cyrillic, also below .agents/knowledge and skills) is NOT blocked; the long s, Kelvin sign, ligature, zero width and sharp s attacks still are', () => {
  const ok = sb.mkrepo('alias-ok'); git(ok, ['config', 'core.ignorecase', 'true']);
  trackOnly(ok, ['文档/说明/x.md', 'şş', 'ş/ş/ş.md', 'Привет/мир/f.txt', '日本語/ファイル', '.agents/knowledge/文档.md', '.agents/knowledge/şş.md', '.agents/skills/mine/说明.md', '.agents/skills/ş/ş.md', 'résumé.txt', '.Agents-notes.txt'], 'data\n');
  assert.deepEqual(extras(ok), [], 'a name with no evidence of an alias was blocked');
  const bad = sb.mkrepo('alias-bad'); git(bad, ['config', 'core.ignorecase', 'true']);
  const attacks = ['.agents/\u017fcripts/proofline-core.mjs', '.agent\u017f/githooks/pre-commit', '.agents/s\u212aills/x/scripts/y.mjs', '.agents/scr\u200bipts/agent.sh', '.agents/\ufb01x/z', '.agents/hooks/Proofline-Hook.mjs',
    '.Agents/knowledge/x', '.agents/Skills/mine/x', 'AGENTS~1/githooks/pre-commit', '.agents/SCRIPT~1/agent.sh', '.agents/GITHOO~1/pre-commit', '.agents/skills/design~1/scripts/x.mjs', '.agents/ECOSYS~1.MJS', '.agents/scripts/\u0131nstall.sh'];
  trackOnly(bad, attacks);
  const got = extras(bad);
  for (const a of attacks.filter((x) => !x.endsWith('\u0131nstall.sh') && !x.includes('\ufb01x'))) assert.ok(got.includes(a), `${a} was not found: ${JSON.stringify(got)}`);
  // without folding (a case-sensitive checkout) the same names are only judged when they sit in a code folder
  const plain = sb.mkrepo('alias-plain'); git(plain, ['config', 'core.ignorecase', 'false']);
  trackOnly(plain, ['.agents/\u017fcripts/proofline-core.mjs', '.agents/knowledge/x']);
  assert.deepEqual(extras(plain), []);
});

test('A249 init (R5-1): a repository with a tracked "文档/说明/x.md" and a "şş" on a folding checkout still gets core.hooksPath; the long s attack does not', () => {
  const d = sb.mkrepo('alias-init'); git(d, ['config', 'core.ignorecase', 'true']);
  trackOnly(d, ['文档/说明/x.md', 'şş'], 'data\n');
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '.agents/githooks', r.text);
  const e = sb.mkrepo('alias-init-bad'); git(e, ['config', 'core.ignorecase', 'true']);
  trackOnly(e, ['.agents/\u017fcripts/proofline-core.mjs']);
  assert.equal(hp(e), '');
  assert.match(sb.pl(e, INIT).out, NOT_SET);
  assert.equal(hp(e), '');
});

test('A249 doctor (SEC-E): a hook-named alias that is only TRACKED (HEAD holds .agents/githooks/pre-commiT, the disk does not list it) is reported while core.hooksPath is active, and the PASS for git hooks is withheld', () => {
  const d = installed('doc-tracked-alias'); git(d, ['config', 'core.ignorecase', 'true']);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '--no-verify', '-m', 'install']);
  trackOnly(d, ['.agents/githooks/pre-commiT', '.agents/githooks/post-checkout']);
  rmSync(`${d}/.agents/githooks/post-checkout`, { force: true });
  const r = doctor(d);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/pre-commiT .*tracked/m, r.out);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/post-checkout .*tracked/m, r.out);
  assert.doesNotMatch(r.out, /^PASS git hooks/m, r.out);
  assert.notEqual(r.status, 0);
});

test('A249 output (SEC-F, in process): cleanOut keeps the line feed and the tab and cleans everything else; CliDie cleans at construction', async () => {
  assert.equal(cleanOut('a\x1b]0;x\x07b\n\tc\x9bd\ne'), 'a?]0;x?b\n\tc?d\ne');
  const { CliDie } = await import('../../control-plane/agents/scripts/core/cliio.mjs');
  assert.equal(new CliDie('bad \x1b[2K value').message, 'proofline: bad ?[2K value');
});

test('A249 init (SEC-F): configuration text, the manifest runtimes line and a prompt default never reach stderr as control bytes (CliDie, errLine, errRaw)', () => {
  const ESC = '\x1b]0;pwned\x07';
  const run = (/** @type {string} */ d, /** @type {string[]} */ args, /** @type {NodeJS.ProcessEnv} */ extra = {}, /** @type {string} */ input = '') => {
    const l = launch(path.join(repo, 'bin', 'proofline'), args);
    const r = spawnSync(l.program, l.args, { cwd: d, env: { ...sb.env, ...extra }, encoding: 'latin1', input });
    return { status: r.status, text: r.stdout + r.stderr };
  };
  const ctl = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
  const a = sb.mkrepo('esc-cfg'); mkdirSync(`${a}/.agents`, { recursive: true });
  writeFileSync(`${a}/.agents/config.yaml`, `runtime:\n  lead: ${ESC}\n`);
  const ra = run(a, INIT);
  assert.notEqual(ra.status, 0, ra.text); assert.match(ra.text, /invalid value for Lead runtime: \?\]0;pwned\?/, ra.text); assert.doesNotMatch(ra.text, ctl, JSON.stringify(ra.text));
  const b = sb.mkrepo('esc-manifest'); mkdirSync(`${b}/.agents`, { recursive: true });
  writeFileSync(`${b}/.agents/.proofline-manifest`, `# runtimes: claude ${ESC}\n`);
  const rb = run(b, ['init', '--yes']);
  assert.notEqual(rb.status, 0, rb.text); assert.match(rb.text, /unknown runtime: \?\]0;pwned\?/, rb.text); assert.doesNotMatch(rb.text, ctl, JSON.stringify(rb.text));
  const c = sb.mkrepo('esc-prompt'); mkdirSync(`${c}/.agents`, { recursive: true });
  writeFileSync(`${c}/.agents/config.yaml`, `runtime:\n  lead: ${ESC}\n`);
  const rc = run(c, ['init', '--runtimes', 'claude'], { PROOFLINE_PROMPT: '1' }, '\n\n\n');
  assert.match(rc.text, /Lead runtime \[\?\]0;pwned\?\]/, rc.text); assert.doesNotMatch(rc.text, ctl, JSON.stringify(rc.text));
});

test('A249 output (SEC-F): the installer sources hold no character above 0xFF in a string literal (the byte-string writer would lose its high byte)', () => {
  for (const f of ['install.mjs', 'proflinecli.mjs', 'doctor.mjs']) {
    const src = readFileSync(path.join(repo, 'control-plane', 'agents', 'scripts', 'core', f), 'utf8');
    const bad = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(String(l)) && /[^\x00-\xff]/.test(String(l)) && /['"`]/.test(String(l)));
    // doctor.mjs prints text through its own UTF-8 writer; the byte-string writers are install.mjs and proflinecli.mjs
    if (f !== 'doctor.mjs') assert.deepEqual(bad, [], `${f} has a wide character in code`);
  }
});

test('A249 codeAudit (SEC-B): on a Unicode-folding file system a tracked ".agents/ſcripts/proofline-core.mjs" and ".agentſ/..." are found in the index and HEAD, and init (with the manifest row of the attack) leaves core.hooksPath unset', (t) => {
  const d = sb.mkrepo('longs');
  mkdirSync(`${d}/probe-ſ`); writeFileSync(`${d}/probe-ſ/f`, '');
  if (!existsSync(`${d}/probe-s/f`)) { t.skip('this file system does not fold U+017F'); return; }
  rmSync(`${d}/probe-ſ`, { recursive: true });
  assert.equal(git(d, ['config', '--get', 'core.ignorecase']).stdout.trim(), 'true');
  const hostile = coreWriting(marker());
  writeExec(`${d}/.agents/ſcripts/proofline-core.mjs`, hostile);
  writeFileSync(`${d}/.agents/.proofline-manifest`, `${sha(hostile)}  .agents/scripts/proofline-core.mjs\n`);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'alias']);
  const got = audit(d);
  assert.ok(got.includes('extra .agents/ſcripts/proofline-core.mjs'), `the aliased script was not found: ${JSON.stringify(got)}`);
  assert.match(problemText(/** @type {any} */ ({ rel: '.agents/ſcripts/x', kind: 'extra', alias: true })), /resolve to a file proofline ships/);
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '', 'the path was set although HEAD tracks aliased code');
  assert.match(r.out, NOT_SET, r.out);
  // the whole code set under an aliased ".agents" (the folder is named with the long s from the start)
  const f = sb.mkrepo('longs-dir');
  writeExec(`${f}/.agentſ/githooks/pre-commit`, HOSTILE); writeExec(`${f}/.agents/scripts/agent.sh`, HOSTILE);
  git(f, ['add', '-A']); git(f, ['commit', '-q', '-m', 'alias dir']);
  const gotF = audit(f).filter((x) => /^extra/.test(x));
  assert.ok(gotF.includes('extra .agentſ/githooks/pre-commit') && gotF.includes('extra .agentſ/scripts/agent.sh'), JSON.stringify(gotF));
  const rf = sb.pl(f, INIT);
  assert.equal(hp(f), '', rf.text);
  // the control: a data file beside ".agents", a user's own skill and an accented name are not code
  const e = sb.mkrepo('longs-ok');
  writeFileSync(`${e}/.Agents-notes.txt`, 'x'); mkdirSync(`${e}/.agents/skills/mine`, { recursive: true }); writeFileSync(`${e}/.agents/skills/mine/SKILL.md`, 'x'); writeFileSync(`${e}/résumé.txt`, 'x');
  git(e, ['add', '-A']); git(e, ['commit', '-q', '-m', 'ok']);
  assert.deepEqual(audit(e).filter((x) => /extra/.test(x)), []);
});

test('A249 doctor (R3): proofline\'s file on disk over an older staged or committed blob (the state right after an upgrade) is a WARN that says to commit; a file that also differs on disk stays a FAIL', () => {
  const d = installed('doc-lag');
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'install']);
  const core = `${d}/.agents/scripts/proofline-core.mjs`; const hook = `${d}/.agents/githooks/pre-commit`; const nodeHook = `${d}/.agents/hooks/proofline-hook.mjs`;
  const goodCore = readFileSync(core, 'utf8'); const goodHook = readFileSync(hook, 'utf8'); const goodNode = readFileSync(nodeHook, 'utf8');
  // the old release: a committed older core and hook, and a committed older Node hook
  writeExec(core, `// older\n${goodCore}`); writeExec(hook, `${goodHook}# older\n`); writeExec(nodeHook, `// older\n${goodNode}`);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'old release']);
  writeExec(core, goodCore); writeExec(hook, goodHook);        // `upgrade` wrote proofline's new files, nobody committed them
  writeExec(nodeHook, `// edited on disk too\n${goodNode}`);     // this one differs on disk as well
  const r = doctor(d);
  assert.match(r.out, /^WARN code: 2 file\(s\) are staged and committed \(HEAD\) with content that is not proofline's copy, while the file on disk is proofline's \(.*proofline-core\.mjs.*\)\. Right after `proofline upgrade` that is expected: commit proofline's copy \(git add \.agents && git commit\)/m, r.out);
  assert.match(r.out, /pre-commit/, r.out);
  assert.doesNotMatch(r.out, /^PASS git hooks:/m, 'the PASS is not printed over a lagging hook');
  const fails = r.out.split('\n').filter((l) => l.startsWith('FAIL code:'));
  assert.equal(fails.length, 1, fails.join('\n'));
  assert.match(fails[0], /1 script or hook file\(s\) of \.agents are not proofline's shipped copy \(\.agents\/hooks\/proofline-hook\.mjs differs/, fails[0]);
  // only the lag: exit status 0
  writeExec(nodeHook, goodNode);
  const ok = doctor(d);
  assert.match(ok.out, /^WARN code: 3 file\(s\) are staged and committed/m, ok.out);
  assert.doesNotMatch(ok.out, /^FAIL /m, ok.out);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /with core\.hooksPath active, the staged or committed content[^.]*runs at the next commit/, ok.out);
  // L2: a SYMBOLIC LINK blob (mode 120000) in HEAD is no lag: a restore would write a link to anywhere. FAIL
  const agent = `${d}/.agents/scripts/agent.sh`; const goodAgent = readFileSync(agent, 'utf8');
  rmSync(agent); symlinkSync('/etc/hosts', agent); git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'link']);
  rmSync(agent); writeExec(agent, goodAgent);
  const lk = audit(d);
  assert.ok(lk.includes('head .agents/scripts/agent.sh'), JSON.stringify(lk));
  const rl = doctor(d);
  assert.match(rl.out, /^FAIL code: \d+ script or hook file\(s\) of \.agents are not proofline's shipped copy \(.*\.agents\/scripts\/agent\.sh is (staged|committed)/m, rl.out);
});

test('A249 doctor and init (SEC-3, round 3): repository text reaches the terminal without control characters on EVERY route: a foreign hook command, a skill folder name, a JSON error, a line relayed from the core, and init\'s own output', () => {
  const esc = '\x1b[2K\x1b[1A\x1b[8m';
  const d = installed('doc-esc-all');
  const sf = `${d}/.claude/settings.json`;
  const j = JSON.parse(readFileSync(sf, 'utf8'));
  const forged = "PASS code: every script and hook is proofline's copy";
  j.hooks.SessionStart.push({ hooks: [{ type: 'command', command: `echo ${esc}hidden` }] }, { hooks: [{ type: 'command', command: `x\n${forged}\r${forged}\u2028${forged}` }] });
  writeExec(`${d}/.agents/githooks/post-\u011b[2K\u202e`, HOSTILE);
  writeFileSync(sf, JSON.stringify(j, null, 2));
  mkdirSync(`${d}/.claude/skills/tdd-${esc}`, { recursive: true });
  mkdirSync(`${d}/.claude/skills/\n${forged}-review`, { recursive: true });
  writeFileSync(`${d}/.claude/settings.local.json`, `[${esc}]`);
  const cfg = `${d}/.agents/config.yaml`;
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\nrules:\n  budget_bytes: 1${esc}x\n`);
  const r = doctor(d);
  assert.doesNotMatch(r.out, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, JSON.stringify(r.out.split('\n').filter((l) => /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(l))));
  assert.doesNotMatch(r.out, /^PASS code: every script/m, 'a forged PASS line stands alone in the output');
  assert.match(r.out, /^WARN foreign hook: SessionStart in \S*\.claude\/settings\.json may add context to the prompt: x\?PASS code: every script and hook is proofline's copy\?PASS code:/m, r.out);
  assert.match(r.out, /^WARN overlapping skill: \?PASS code: every script and hook is proofline's copy-review /m, r.out);
  assert.match(r.out, /^FAIL git hooks: \.agents\/githooks\/post-\u011b\[2K\? is not a file proofline ships/m, r.out);
  assert.match(r.out, /^WARN foreign hook: SessionStart in \S*\.claude\/settings\.json may add context to the prompt: echo \?\[2K\?\[1A\?\[8mhidden/m, r.out);
  assert.match(r.out, /^WARN overlapping skill: tdd-\?\[2K\?\[1A\?\[8m /m, r.out);
  assert.match(r.out, /^FAIL claude hooks: \.claude\/settings\.local\.json is not a valid JSON object \(.*\?\[2K/m, r.out);
  assert.match(r.out, /^FAIL config: agent\.sh config-check failed: .*invalid number for rules\.budget_bytes: 1\?\[2K/m, r.out); // a line relayed from the core
  // the final verdict line cannot be hidden: it is the last line and plain
  assert.match(r.out.trimEnd().split('\n').pop() ?? '', /^doctor: \d+ FAIL, \d+ WARN$/);
  // init and upgrade: a path named by the manifest (the repository's) in the orphan list
  const mf = `${d}/.agents/.proofline-manifest`;
  const rel = `.agents/old${esc}file.txt`;
  writeFileSync(`${d}/${rel}`, 'mine');
  writeFileSync(mf, `${readFileSync(mf, 'utf8')}${'0'.repeat(64)}  ${rel}\n`);
  const up = sb.pl(d, ['upgrade', '--yes']);
  assert.doesNotMatch(up.text, /[\x00-\x09\x0b-\x1f\x7f]/, JSON.stringify(up.text.split('\n').filter((l) => /\x1b/.test(l))));
  assert.match(up.out, /\? \.agents\/old\?\[2K\?\[1A\?\[8mfile\.txt \(modified, no longer shipped; kept\)/, up.out);
});

// ---- settings (item 2 of the review; A238 closed it for the project files, R2 adds the user's and the managed ones) ---------------------------------------------

const SHIPPED_PRE = JSON.parse(readFileSync(path.join(repo, 'adapters', 'claude', 'settings.fragment.json'), 'utf8')).hooks.PreToolUse[0].matcher;

test('A249 settings (item 2): a never-firing matcher and disableAllHooks in the project or local settings FAIL', () => {
  const d = installed('set-never');
  const f = `${d}/.claude/settings.json`;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const groups of Object.values(/** @type {Record<string, any[]>} */ (j.hooks))) for (const g of groups) if (g.matcher !== undefined) g.matcher = 'NoSuchTool';
  j.disableAllHooks = true;
  writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
  writeFileSync(`${d}/.claude/settings.local.json`, '{"disableAllHooks": true}\n');
  const r = doctor(d);
  assert.doesNotMatch(r.out, /^PASS claude hooks: .*wires all 7/m, r.out);
  assert.match(r.out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m, r.out);
  assert.match(r.out, /^FAIL claude hooks: disableAllHooks is true in \.claude\/settings\.json/m, r.out);
  assert.match(r.out, /^FAIL claude hooks: disableAllHooks is true in \.claude\/settings\.local\.json/m, r.out);
  assert.notEqual(r.status, 0);
});

test('A249 settings (R2): disableAllHooks in the user\'s ~/.claude/settings.json or in the managed settings FAILs; false and absent do not', () => {
  const home = mkdtempSync(`${sb.T}/uhome-`);
  mkdirSync(`${home}/.claude`);
  const d = installed('set-user');
  const managed = `${sb.T}/managed-settings.json`;
  writeFileSync(`${home}/.claude/settings.json`, '{"disableAllHooks": true}\n');
  writeFileSync(managed, '{"disableAllHooks": true}\n');
  const r = doctor(d, { HOME: home, PROOFLINE_CLAUDE_MANAGED_SETTINGS: managed });
  assert.match(r.out, /^FAIL claude hooks: disableAllHooks is true in ~\/\.claude\/settings\.json/m, r.out);
  assert.match(r.out, /^FAIL claude hooks: disableAllHooks is true in the managed settings/m, r.out);
  assert.doesNotMatch(r.out, /^PASS claude hooks: .*wires all 7/m, r.out);
  writeFileSync(`${home}/.claude/settings.json`, '{"disableAllHooks": false}\n');
  assert.doesNotMatch(doctor(d, { HOME: home }).out, /disableAllHooks is/);
});

test('A250 doctor (SEC-E carry-over): a tracked hook-folder entry in a SUBFOLDER that is also on disk is not called "not on disk"', () => {
  const d = installed('doc-subfolder-entry');
  git(d, ['add', '-A']); git(d, ['commit', '-q', '--no-verify', '-m', 'install']);
  writeExec(`${d}/.agents/githooks/sub/x`, HOSTILE);
  git(d, ['add', '-f', '.agents/githooks/sub/x']); git(d, ['commit', '-q', '--no-verify', '-m', 'sub']);
  const r = doctor(d);
  const line = r.out.split('\n').find((l) => l.includes('.agents/githooks/sub/x') && l.includes('tracked')) ?? '';
  assert.ok(line !== '', r.out);
  assert.doesNotMatch(line, /not on disk/, line);
});

test('A250 codetrust (carry-over): an 8.3 short-name hit says to rename it; a folding alias keeps its own wording', () => {
  const short = problemText({ rel: '.agents/GITHOO~1/pre-commit', kind: 'extra', alias: true });
  assert.match(short, /looks like an NTFS 8\.3 short name; rename it \(for example notes-1\.md\) and run proofline init/);
  assert.doesNotMatch(short, /delete the file/);
  assert.match(problemText({ rel: '.agents/ſcripts/x', kind: 'extra', alias: true }), /Unicode-folding file system can resolve/);
});

test('A250 codetrust (carry-over): Default_Ignorable_Code_Point characters that casefold kernels before Linux 6.14 drop are ignorable in a name', () => {
  for (const c of ['؜', 'ᅟ', 'ᅠ', '឴', '឵', '᠏', '⁥', 'ㅤ', 'ﾠ', '￰', '￸', '\u{1bca0}', '\u{1bca3}', '\u{1d173}', '\u{1d17a}', '\u{e0000}', '\u{e0fff}']) {
    assert.equal(foldName(`scr${c}ipts`), 'scripts', `U+${c.codePointAt(0)?.toString(16)}`);
  }
  assert.notEqual(foldName('scrกipts'), 'scripts');
});
