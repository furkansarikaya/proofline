// @ts-check
// The Node hook tests honour HOOK_UNDER_TEST (mutation checks of the replays use a sabotaged copy of the hook); the default is the shipped hook.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';

const probe = "import('./tests/hook/harness.mjs').then((m) => process.stdout.write(m.nodeHook))";
const repo = path.resolve(import.meta.dirname, '../..');
/** @param {Record<string, string>} env */
const hookOf = (env) => spawnSync(process.execPath, ['-e', probe], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOOK_UNDER_TEST: '', ...env } }).stdout;

test('HOOK_UNDER_TEST selects the hook of the harness; unset it is the shipped hook', () => {
  assert.equal(hookOf({}), path.join(repo, 'adapters/claude/hooks/proofline-hook.mjs'));
  assert.equal(hookOf({ HOOK_UNDER_TEST: '/x/mutated-hook.mjs' }), '/x/mutated-hook.mjs');
});
