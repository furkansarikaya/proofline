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

// ---- fix round 1 (review and security review of the pull request) ------------------------------------------------------------------------------------------

import { hookCommandShape, matcherCovers } from '../../control-plane/agents/scripts/core/doctor.mjs';

const SHIPPED_PRE = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob|Skill';

test('B1 matcher: Claude Code reads a matcher as a regular expression; only the plain list form is read as names', () => {
  const exploit = `(?!)(|${SHIPPED_PRE}|)`;
  assert.equal(matcherCovers(exploit, SHIPPED_PRE, 'PreToolUse'), false, 'a regular expression that never matches is not a list of every tool');
  assert.equal(matcherCovers('Bash|Edit', SHIPPED_PRE, 'PreToolUse'), false);
  assert.equal(matcherCovers('Bash', SHIPPED_PRE, 'PreToolUse'), false);
  assert.equal(matcherCovers('Bash.*', SHIPPED_PRE, 'PreToolUse'), false);
  for (const wide of ['*', '', '.*', undefined, SHIPPED_PRE, `${SHIPPED_PRE}|WebFetch`]) assert.equal(matcherCovers(wide, SHIPPED_PRE, 'PreToolUse'), true, String(wide));
  assert.equal(matcherCovers(exploit, exploit, 'PreToolUse'), true, 'the exact shipped string is the shipped matcher');
  // SessionStart: the shipped group has no matcher; a plain list of every source is as wide, a shorter list or an expression is not
  assert.equal(matcherCovers('startup|resume|clear|compact', undefined, 'SessionStart'), true);
  assert.equal(matcherCovers('startup|resume', undefined, 'SessionStart'), false);
  assert.equal(matcherCovers('startup', undefined, 'SessionStart'), false);
  assert.equal(matcherCovers('(?!)(startup|resume|clear|compact)', undefined, 'SessionStart'), false);
  assert.equal(matcherCovers('Bash|Edit', undefined, 'PreToolUse'), false, 'an event without a known list needs a wildcard');
});

test('B1 command shape: only the hook invocation counts, not a command that mentions the script name', () => {
  const ok = 'node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" stop claude';
  for (const c of [ok, 'node "${CLAUDE_PROJECT_DIR}/.agents/hooks/proofline-hook.mjs" stop claude', 'node /abs/proj/.agents/hooks/proofline-hook.mjs stop claude', 'node .agents/hooks/proofline-hook.mjs stop claude'])
    assert.equal(hookCommandShape(c), 'node <HOOK> stop claude', c);
  // a newline or a shell metacharacter in the path part, a single quote, trailing garbage: not the hook invocation
  for (const c of ['node --version\nexit\n/.agents/hooks/proofline-hook.mjs" stop claude', 'node "a b/.agents/hooks/proofline-hook.mjs" stop claude', 'node "x;exit 0;/.agents/hooks/proofline-hook.mjs" stop claude',
    'node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs stop claude', 'node $CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" stop claude', 'node x||true/.agents/hooks/proofline-hook.mjs stop claude'])
    assert.notEqual(hookCommandShape(c), 'node <HOOK> stop claude', JSON.stringify(c));
  assert.equal(hookCommandShape('node $CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs stop claude'), 'node <HOOK> stop claude', 'both quotes or none');
  assert.equal(hookCommandShape('node "$(git rev-parse --show-toplevel)/.agents/hooks/proofline-hook.mjs" stop codex'), 'node <HOOK> stop codex');
  for (const c of ['echo "proofline-hook.mjs"', 'true # node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" stop claude', 'node other.mjs proofline-hook.mjs stop claude', 5, null])
    assert.notEqual(hookCommandShape(c), 'node <HOOK> stop claude', String(c));
});

test('B1 settings: the regular-expression exploit, an echo of the hook name, the SessionStart sources and a truthy disableAllHooks', () => {
  const x = sb.copy('b1-exploit');
  settings(x, '.claude/settings.json', (j) => { j.hooks.PreToolUse[0].matcher = `(?!)(|${SHIPPED_PRE}|)`; });
  const r = doctor(x);
  assert.match(r.out, /^FAIL claude hooks: .*narrower matcher.*PreToolUse/m, r.out);
  assert.notEqual(r.status, 0);
  const up = sb.pl(x, ['upgrade', '--yes']);
  assert.match(up.out, /the group for PreToolUse has a narrower matcher/, up.out);
  assert.equal(settings(x, '.claude/settings.json').hooks.PreToolUse.length, 2);
  assert.match(doctor(x).out, /^PASS claude hooks: /m);
  const e = sb.copy('b1-echo');
  settings(e, '.claude/settings.json', (j) => { j.hooks.Stop[0].hooks[0].command = 'echo "proofline-hook.mjs"'; });
  assert.match(doctor(e).out, /^FAIL claude hooks: .*lacks proofline hooks for: Stop /m);
  const s = sb.copy('b1-sources');
  settings(s, '.claude/settings.json', (j) => { j.hooks.SessionStart[0].matcher = 'startup|resume|clear|compact'; });
  assert.match(doctor(s).out, /^PASS claude hooks: /m, 'all sources named: no false FAIL');
  settings(s, '.claude/settings.json', (j) => { j.hooks.SessionStart[0].matcher = 'startup'; });
  assert.match(doctor(s).out, /^FAIL claude hooks: .*narrower matcher.*SessionStart/m);
  for (const v of ['true', 1, 'yes', {}, null]) {
    const d = sb.copy(`b1-dis-${typeof v}-${String(v)}`);
    settings(d, '.claude/settings.local.json', (j) => { j.disableAllHooks = v; });
    const r2 = doctor(d);
    assert.match(r2.out, /^FAIL claude hooks: disableAllHooks is /m, `${JSON.stringify(v)}: ${r2.out}`);
    assert.notEqual(r2.status, 0);
  }
});

test('B2 hooksPath: the value is read expanded by git (%(prefix), ~, ~user); a spelling that git expands to proofline\'s folder is the same, one that only looks like it is not', () => {
  const d = sb.mkrepo('b2');
  assert.equal(sb.pl(d, INIT).status, 0);
  // ~/githooks with HOME = the project's .agents is proofline's folder, as git expands it
  git(d, ['config', '--local', 'core.hooksPath', '~/githooks']);
  const home = { HOME: `${d}/.agents` };
  const same = sb.pl(d, ['doctor'], home);
  assert.match(same.out, /^PASS git hooks: core\.hooksPath = \.agents\/githooks/m, same.out);
  const up = sb.pl(d, ['upgrade', '--yes'], home);
  assert.ok(!/NOT overwritten/.test(up.text), up.text);
  // %(prefix)/githooks is under git's own prefix, whatever links point there: another folder
  git(d, ['config', '--local', 'core.hooksPath', '%(prefix)/githooks']);
  const pf = sb.pl(d, ['doctor']);
  assert.match(pf.out, /^FAIL git hooks: core\.hooksPath is '[^']*\/githooks', not \.agents\/githooks/m, pf.out);
  assert.match(pf.out, /^WARN git hooks: core\.hooksPath is '[^']*\/githooks' \(local git config /m, pf.out);
  const upf = sb.pl(d, ['upgrade', '--yes']);
  assert.equal(git(d, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim(), '%(prefix)/githooks');
  assert.match(upf.out, /NOT overwritten/);
  // ~user: the home of another user is another folder
  git(d, ['config', '--local', 'core.hooksPath', '~root/githooks']);
  assert.match(sb.pl(d, ['doctor']).out, /^WARN git hooks: core\.hooksPath is '[^']*root[^']*\/githooks'/m);
  // the command line scope names itself
  const cl = sb.pl(d, ['doctor'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/somewhere/else' });
  assert.match(cl.out, /^WARN git hooks: core\.hooksPath is '\/somewhere\/else' \((command|the git command) line/m, cl.out);
  assert.ok(!/command line:/.test(cl.out), cl.out);
});

test('R4 settings: a command that hides the script behind a newline gets no PASS', () => {
  const d = sb.copy('r4-newline');
  settings(d, '.claude/settings.json', (j) => { j.hooks.PreToolUse[0].hooks[0].command = j.hooks.PreToolUse[0].hooks[0].command.replace('node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs"', 'node --version\nexit\n/.agents/hooks/proofline-hook.mjs"'); });
  assert.ok(settings(d, '.claude/settings.json').hooks.PreToolUse[0].hooks[0].command.startsWith('node --version\nexit'));
  const r = doctor(d);
  assert.match(r.out, /^FAIL claude hooks: .*lacks proofline hooks for: PreToolUse /m, r.out);
});

test('R5 hooksPath: a path from a config file cannot forge a line or an escape sequence', () => {
  const gh = `${sb.T}/home/.gitconfig-forge`;
  writeFileSync(gh, `${readFileSync(`${sb.T}/home/.gitconfig-global`, 'utf8')}[core]\n\thooksPath = "/a\\nPASS forged line\\t\x1b[2J"\n`);
  const d = sb.mkrepo('r5');
  const init = sb.pl(d, INIT, { GIT_CONFIG_GLOBAL: gh });
  const doc = sb.pl(d, ['doctor'], { GIT_CONFIG_GLOBAL: gh });
  for (const t of [init.text, doc.text]) {
    assert.ok(!/^PASS forged line/m.test(t), t);
    assert.ok(!t.includes('\x1b[2J'), 'an escape sequence reached the output');
  }
  assert.match(doc.out, /^WARN git hooks: a global\/system git core\.hooksPath \('\/a\?PASS forged line\?\?\[2J'\)/m, doc.out);
});
