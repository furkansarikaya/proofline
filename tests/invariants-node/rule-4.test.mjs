// @ts-check
// Core invariant 4: evidence is reproduced independently; an agent's claim (a self-consistent report) is not evidence. Worker evidence is checked
// against the tree: a GREEN record with no change since RED is refused.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repo } from '../core/helpers.mjs';
import { A, IMPLEMENTED, accepted, project, refused, verbs } from '../core/legacy-lib.mjs';

test('inv4: a self-consistent but false report is re-derived and rejected; an unplanned command is never run', () => {
  const d = project(`SC_PLAN_EXTRA='
## Verification commands

- \`sh .agents/local/check.sh\`' scaffold orchestrated; ${IMPLEMENTED}`);
  mkdirSync(`${d}/.agents/skills`, { recursive: true });
  for (const s of ['verify-proof', 'plan-contract']) cpSync(path.join(repo, 'skills', s), `${d}/.agents/skills/${s}`, { recursive: true });
  writeFileSync(`${d}/.git/info/exclude`, '.agents/skills/\n.agents/local/\n.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n', { flag: 'a' });
  writeFileSync(`${d}/.agents/local/check.sh`, 'echo ok 3 tests\n');
  const vw = (/** @type {string} */ output) => writeFileSync(`${d}/.agents/runs/LC/VERIFY.md`, ['# Verification: LC', '', '## Commands', '', '- `sh .agents/local/check.sh` | exit=0', `  output: ${output}`, '', '## AC coverage', '', '| AC | test or command | status | evidence |', '|---|---|---|---|',
    '| AC-1 | impl_test.txt::lookup | PASS | `sh .agents/local/check.sh` exit=0 |', '', '## Scope', '', 'verify-scope: exit=0', '', '## Design sync', '', 'design-sync: SKIPPED (no design documents)', '', '## Runtime', '', 'runtime: none (no runtime in this test)', '',
    '## Pre-existing failures', '', 'None', '', '## Failures', '', 'None', '', 'Verdict: PASS', ''].join('\n'));
  // the claim matches what the command really prints: recorded PASS (the control)
  vw('ok 3 tests');
  const honest = accepted(A(d, ['submit', 'LC', '--confidence', 'high', '--findings', 'none', '--agent', 'iv0'], { role: 'verifier' }), 'an honest report was refused');
  assert.match(honest.text, /submitted: LC verifier PASS/);
  // the claim is internally consistent but false: the control plane re-runs the command and records FAIL
  vw('ok 412 tests, 0 failed');
  const fake = accepted(A(d, ['submit', 'LC', '--confidence', 'high', '--validator-result', 'PASS', '--findings', 'none', '--agent', 'iv1'], { role: 'verifier' }), 'the fabricated report was refused instead of recorded FAIL');
  assert.match(fake.text, /submitted: LC verifier FAIL/, 'a fabricated but self-consistent report passed');
  // a command the plan never listed is never run on a report's say-so
  writeFileSync(`${d}/.agents/local/other.sh`, 'touch .agents/local/ran-unplanned\n');
  const v = `${d}/.agents/runs/LC/VERIFY.md`;
  writeFileSync(`${v}.tmp`, readFileSync(v, 'utf8').split('sh .agents/local/check.sh').join('sh .agents/local/other.sh')); renameSync(`${v}.tmp`, v);
  const unplanned = A(d, ['submit', 'LC', '--confidence', 'high', '--findings', 'none', '--agent', 'iv2'], { role: 'verifier' });
  assert.ok(!existsSync(`${d}/.agents/local/ran-unplanned`), 'the control plane ran a command nobody planned');
  assert.doesNotMatch(unplanned.text, /submitted: LC verifier PASS/, 'a PASS whose command could not be re-run was accepted');
  void verbs;
});

test('inv4b: GREEN evidence needs a real change in the tree, not the worker\'s word', () => {
  const d = project("scaffold orchestrated; worker RED fail impl_test.txt 'test: lookup returns the stored value'; wopen");
  refused(A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: 'command: go test ./...\ntarget: impl.txt\n' }), 'GREEN recorded with no implementation change', 'no implementation file changed');
});
