// @ts-check
// The maintainer's decisions of 2026-11-08 (A238): `core.hooksPath` that is already set is never overwritten by init or upgrade (A233), and `doctor` FAILs on a broken
// `.claude/settings.json` (A232). The delivery part is in run6-merged.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const git = (/** @type {string} */ d, /** @type {string[]} */ a) => spawnSync('git', ['-C', d, ...a], { env: sb.env, encoding: 'utf8' });
const hp = (/** @type {string} */ d) => git(d, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim();
const INIT = ['init', '--yes', '--runtimes', 'claude'];

// ---- A233: an existing core.hooksPath ---------------------------------------------------------------------------------------------------------------------

test('A238 hooksPath: unset is set to .agents/githooks; the same folder (also as an absolute, a relative-with-dot and a symlinked spelling) is idempotent and silent', () => {
  const d = sb.mkrepo('hp-unset');
  const r = sb.pl(d, INIT);
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '.agents/githooks');
  const again = sb.pl(d, INIT);
  assert.ok(!again.out.includes('NOT overwritten'), again.out);
  for (const spelling of [`${d}/.agents/githooks`, './.agents/githooks', '.agents/../.agents/githooks', `${d}/.agents/githooks/`]) {
    git(d, ['config', '--local', 'core.hooksPath', spelling]);
    const up = sb.pl(d, ['upgrade', '--yes']);
    assert.equal(up.status, 0, `${spelling}: ${up.text}`);
    assert.equal(hp(d), spelling, `${spelling} was rewritten`);
    assert.ok(!/NOT overwritten/.test(up.text), `${spelling}: ${up.text}`);
    assert.match(sb.pl(d, ['doctor']).out, /^PASS git hooks: core\.hooksPath = \.agents\/githooks/m, spelling);
  }
  // a link to the folder
  symlinkSync(`${d}/.agents/githooks`, `${d}/hooks-link`);
  git(d, ['config', '--local', 'core.hooksPath', `${d}/hooks-link`]);
  const lk = sb.pl(d, INIT);
  assert.ok(!/NOT overwritten/.test(lk.text), lk.text);
  assert.equal(hp(d), `${d}/hooks-link`);
  assert.match(sb.pl(d, ['doctor']).out, /^PASS git hooks: /m);
});

test('A238 hooksPath: a local value for another folder is not overwritten by init or upgrade; the message names the path, the origin and the remedy; doctor WARNs and exits 1', () => {
  const d = sb.mkrepo('hp-local');
  git(d, ['config', '--local', 'core.hooksPath', '.husky']);
  for (const args of [INIT, ['upgrade', '--yes']]) {
    const r = sb.pl(d, args);
    assert.equal(r.status, 0, `${args[0]}: ${r.text}`);
    assert.equal(hp(d), '.husky', `${args[0]} overwrote the value`);
    assert.match(r.out, /core\.hooksPath is '\.husky' \(local git config [^)]*\) and is NOT overwritten; the proofline git hooks \(\.agents\/githooks\) are NOT active\. To use them, run: git config --local core\.hooksPath \.agents\/githooks/, `${args[0]}: ${r.out}`);
  }
  const doc = sb.pl(d, ['doctor']);
  assert.match(doc.out, /^WARN git hooks: core\.hooksPath is '\.husky' \(local git config /m, doc.out);
  assert.match(doc.out, /^FAIL git hooks: core\.hooksPath is '\.husky', not \.agents\/githooks/m, doc.out);
  assert.notEqual(doc.status, 0);
});

test('A238 hooksPath: a global value is not overwritten and not overridden by a local one; the message says global and where; doctor WARNs', () => {
  const gh = `${sb.T}/home/.gitconfig-hp2`;
  writeFileSync(gh, `${readFileSync(`${sb.T}/home/.gitconfig-global`, 'utf8')}[core]\n\thooksPath = /nonexistent/g2\n`);
  const d = sb.mkrepo('hp-global');
  const r = sb.pl(d, INIT, { GIT_CONFIG_GLOBAL: gh });
  assert.equal(r.status, 0, r.text);
  assert.equal(hp(d), '');
  assert.match(r.out, /a global\/system git core\.hooksPath \('\/nonexistent\/g2'\) exists \(global git config [^)]*\.gitconfig-hp2\) and is NOT overwritten; .*git config --local core\.hooksPath \.agents\/githooks \(this repository only/, r.out);
  const doc = sb.pl(d, ['doctor'], { GIT_CONFIG_GLOBAL: gh });
  assert.match(doc.out, /^WARN git hooks: a global\/system git core\.hooksPath \('\/nonexistent\/g2'\)/m, doc.out);
  // the global value equal to proofline's own folder (relative spelling is resolved against the repository): nothing to say
  writeFileSync(gh, `${readFileSync(`${sb.T}/home/.gitconfig-global`, 'utf8')}[core]\n\thooksPath = .agents/githooks\n`);
  const e = sb.mkrepo('hp-global-same');
  const re = sb.pl(e, INIT, { GIT_CONFIG_GLOBAL: gh });
  assert.ok(!/NOT overwritten/.test(re.text), re.text);
  assert.equal(hp(e), '');
});

test('A238 hooksPath: init in a directory that is not a git repository still refuses as before and --dry-run sets nothing', () => {
  const dir = `${sb.T}/not-a-repo`;
  mkdirSync(dir, { recursive: true });
  const r = sb.pl(dir, INIT);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /is not a git repository; run git init first/);
  const d = sb.mkrepo('hp-dry');
  git(d, ['config', '--local', 'core.hooksPath', '.husky']);
  const dry = sb.pl(d, [...INIT, '--dry-run']);
  assert.equal(dry.status, 0, dry.text);
  assert.equal(hp(d), '.husky');
  assert.ok(!existsSync(`${d}/.agents`));
});

// ---- A232: a broken .claude/settings.json is a FAIL -----------------------------------------------------------------------------------------------------------

/** @param {string} d @param {string} rel @param {(j: any) => void} [mut] @returns {any} */
function settings(d, rel, mut) {
  const f = `${d}/${rel}`;
  const j = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  if (mut) { mut(j); writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`); }
  return j;
}
const doctor = (/** @type {string} */ d) => sb.pl(d, ['doctor']);

test('A238 settings: an intact install PASSes the claude hooks line', () => {
  const r = doctor(sb.copy('s-ok'));
  assert.match(r.out, /^PASS claude hooks: \.claude\/settings\.json wires all 7 proofline events$/m, r.out);
  assert.doesNotMatch(r.out, /^FAIL claude hooks/m);
});

test('A238 settings: a file that is not JSON (or not an object) FAILs with a clear message and a non-zero exit; init does not overwrite it', () => {
  for (const [name, text] of [['junk', '{ not json'], ['array', '[]'], ['null', 'null'], ['empty', '']]) {
    const d = sb.copy(`s-${name}`);
    writeFileSync(`${d}/.claude/settings.json`, text);
    const r = doctor(d);
    assert.match(r.out, /^FAIL claude hooks: \.claude\/settings\.json is not a valid JSON object/m, `${name}: ${r.out}`);
    assert.notEqual(r.status, 0, name);
    const up = sb.pl(d, ['upgrade', '--yes']);
    assert.equal(readFileSync(`${d}/.claude/settings.json`, 'utf8'), text, `${name}: the broken file was rewritten`);
    assert.match(up.out, /not merged \(invalid JSON\)/, `${name}: ${up.text}`);
  }
});

test('A238 settings: one missing event FAILs and names it', () => {
  const d = sb.copy('s-miss');
  settings(d, '.claude/settings.json', (j) => { delete j.hooks.Stop; });
  const r = doctor(d);
  assert.match(r.out, /^FAIL claude hooks: \.claude\/settings\.json lacks proofline hooks for: Stop /m, r.out);
  assert.notEqual(r.status, 0);
});

test('A238 settings: a narrowed matcher FAILs and names the event; init adds the shipped group alongside and says so; a wider matcher stays PASS', () => {
  const d = sb.copy('s-narrow');
  settings(d, '.claude/settings.json', (j) => { j.hooks.PreToolUse[0].matcher = 'NeverFires'; j.hooks.PostToolUse[0].matcher = 'Bash'; j.hooks.SessionStart[0].matcher = 'startup'; });
  const r = doctor(d);
  assert.match(r.out, /^FAIL claude hooks: \.claude\/settings\.json wires proofline hooks with a narrower matcher than proofline's for: SessionStart PreToolUse PostToolUse;/m, r.out);
  assert.notEqual(r.status, 0);
  const up = sb.pl(d, ['upgrade', '--yes']);
  assert.match(up.out, /\.claude\/settings\.json \(proofline hooks added, existing keys kept; the group for SessionStart PreToolUse PostToolUse has a narrower matcher than proofline's, so proofline's group was added beside it\)/, up.out);
  assert.equal(settings(d, '.claude/settings.json').hooks.PreToolUse.length, 2, 'the shipped group sits beside the narrowed one');
  assert.match(doctor(d).out, /^PASS claude hooks: /m);
  const again = sb.pl(d, ['upgrade', '--yes']);
  assert.equal(settings(d, '.claude/settings.json').hooks.PreToolUse.length, 2, `a second upgrade adds nothing: ${again.out}`);
  // a wider matcher is fine
  const w = sb.copy('s-wide');
  settings(w, '.claude/settings.json', (j) => { j.hooks.PreToolUse[0].matcher = '.*'; });
  assert.match(doctor(w).out, /^PASS claude hooks: /m);
  // a pipe list that contains the shipped tools plus more is fine, one that lacks a tool is not
  settings(w, '.claude/settings.json', (j) => { j.hooks.PreToolUse[0].matcher = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob|Skill|WebFetch'; });
  assert.match(doctor(w).out, /^PASS claude hooks: /m);
  settings(w, '.claude/settings.json', (j) => { j.hooks.PreToolUse[0].matcher = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob'; });
  assert.match(doctor(w).out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m);
});

test('A238 settings: disableAllHooks true in settings.json or settings.local.json FAILs; false does not; a command that is not text FAILs', () => {
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const d = sb.copy(`s-dis-${rel.includes('local') ? 'l' : 'p'}`);
    settings(d, rel, (j) => { j.disableAllHooks = true; });
    const r = doctor(d);
    assert.match(r.out, new RegExp(`^FAIL claude hooks: disableAllHooks is true in ${rel.replace(/[.]/g, '\\.')}`, 'm'), r.out);
    assert.notEqual(r.status, 0);
    settings(d, rel, (j) => { j.disableAllHooks = false; });
    assert.match(doctor(d).out, /^PASS claude hooks: /m, 'false is fine');
  }
  const n = sb.copy('s-cmd');
  settings(n, '.claude/settings.json', (j) => { j.hooks.Stop[0].hooks[0].command = ['node proofline-hook.mjs stop']; });
  const r = doctor(n);
  assert.match(r.out, /^FAIL claude hooks: .*lacks proofline hooks for: Stop /m, r.out);
});

test('A238 settings: settings.local.json that is broken FAILs; hooks wired there count; a local narrowed group does not hide a missing event', () => {
  const b = sb.copy('s-lbroken');
  writeFileSync(`${b}/.claude/settings.local.json`, '{ nope');
  assert.match(doctor(b).out, /^FAIL claude hooks: \.claude\/settings\.local\.json is not a valid JSON object/m);
  const l = sb.copy('s-local-hooks');
  const full = settings(l, '.claude/settings.json');
  const stop = full.hooks.Stop;
  settings(l, '.claude/settings.json', (j) => { delete j.hooks.Stop; });
  assert.match(doctor(l).out, /^FAIL claude hooks: .*lacks proofline hooks for: Stop /m);
  writeFileSync(`${l}/.claude/settings.local.json`, JSON.stringify({ hooks: { Stop: stop } }));
  assert.match(doctor(l).out, /^PASS claude hooks: /m, 'a hook wired in the local settings counts');
});
