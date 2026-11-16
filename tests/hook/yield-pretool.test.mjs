// @ts-check
// A299: the plugin yields PreToolUse to the project's wiring (ADR 0001 section 9, one event is handled once) when .claude/settings.json holds the CURRENT project string
// (the one that keeps the exit status of the hook), the string of the releases before A299 (an upgrade leaves it), or both; any other command, one character off, does not make it yield.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../lib/tempdir.mjs';
import { installMinimal, repoRoot } from '../core/lib/fixture.mjs';
import { knownStrings, yieldsToOtherWiring } from '../../adapters/claude/hooks/lib/yield.mjs';

const HOOKS = join(repoRoot, 'adapters/claude/hooks');
const frag = JSON.parse(readFileSync(join(repoRoot, 'adapters/claude/settings.fragment.json'), 'utf8'));
const CURRENT = /** @type {string} */ (frag.hooks.PreToolUse[0].hooks[0].command);
const MATCHER = /** @type {string} */ (frag.hooks.PreToolUse[0].matcher);
const OLD = 'node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" pretool claude || test ! -f "$CLAUDE_PROJECT_DIR/.agents/config.yaml" || { echo "proofline: the hook did not start (node 22.13 or newer must be on PATH); failing closed" >&2; exit 2; }';

/** A project holding the genuine hook tree and core, with the given PreToolUse commands in .claude/settings.json. @param {string[]} cmds */
function project(cmds) {
  const dir = tempDir('yield-pretool.');
  installMinimal(dir);
  mkdirSync(join(dir, '.agents/hooks'), { recursive: true });
  for (const f of ['proofline-hook.mjs', 'command-scan.mjs']) cpSync(join(HOOKS, f), join(dir, '.agents/hooks', f));
  for (const d of ['events', 'guards', 'lib']) cpSync(join(HOOKS, d), join(dir, '.agents/hooks', d), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: MATCHER, hooks: cmds.map((command) => ({ type: 'command', command })) }] } }));
  return dir;
}
const yields = (/** @type {string[]} */ cmds, ev = 'pretool') => { const dir = project(cmds); return yieldsToOtherWiring(`${HOOKS}/`, ev, 'claude', { CLAUDE_PROJECT_DIR: dir }); };

test('the shipped fragment string is a known project string, and so is the one before A299', () => {
  assert.ok(knownStrings('pretool', 'claude').newProject.includes(CURRENT));
  assert.ok(knownStrings('pretool', 'claude').newProject.includes(OLD));
  assert.deepEqual(knownStrings('pretool', 'codex').newProject, []);
});

test('the plugin yields to the current string, to the old string, and to both', () => {
  assert.equal(yields([CURRENT]), true);
  assert.equal(yields([OLD]), true);
  assert.equal(yields([OLD, CURRENT]), true);
});

test('a changed string does not make the plugin yield: one character off, the exit-status handling removed, `|| true` appended, a prefix', () => {
  for (const c of [CURRENT.replace('rc -eq 0', 'rc -eq 1'), `${CURRENT} || true`, `${CURRENT}; true`, CURRENT.replace('test $rc -eq 2 || ', ''), CURRENT.replace('exit 2; }', 'exit 0; }'), `true; ${CURRENT}`, `${OLD} || true`, OLD.replace('exit 2', 'exit 0'), 'node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" pretool claude']) {
    assert.equal(yields([c]), false, c);
  }
  assert.equal(yields([`${CURRENT} || true`, 'echo x']), false);
});

test('an event is judged by its own wiring: a PreToolUse entry does not make PostToolUse yield', () => {
  assert.equal(yields(['node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" posttool claude'], 'posttool'), false, 'wired under PreToolUse, asked for PostToolUse');
});
