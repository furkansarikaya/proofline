// The file list of the CI shellcheck step (tests/ci/shellcheck.mjs, A233): every tracked shell file, and neither the Node launcher bin/proofline nor a Markdown or Node file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const list = spawnSync('node', [`${import.meta.dirname}/shellcheck.mjs`, '--list'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

test('the list holds the shell scripts and the git hook launchers', () => {
  for (const f of ['control-plane/agents/scripts/agent.sh', 'control-plane/agents/githooks/pre-commit', 'control-plane/agents/githooks/pre-push', 'control-plane/agents/scripts/dispatch.sh']) assert.ok(list.includes(f), f);
});

test('the list holds no Node program, not even bin/proofline (a Node launcher since A233)', () => {
  assert.ok(!list.includes('bin/proofline'));
  assert.deepEqual(list.filter((f) => /\.(mjs|md|json|ya?ml)$/.test(f)), []);
});
