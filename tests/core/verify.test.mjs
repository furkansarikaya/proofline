// @ts-check
// Package C2 (stage 2): the verify-* family, freshness, validate and the checks give the same stdout, stderr and exit status through the Node
// core and through the shell code (PROOFLINE_ENGINE=sh), on fixture runs built with the self-test helpers. The shell is the specification.
// Each state builds its own tree (tests run in parallel). The slow states (moved base, many files) are in verify-slow.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { build, exec } from './verify-helpers.mjs';

export const SHAPES = [['verify-freeze'], ['verify-scope'], ['verify-knowledge-scope'], ['freshness'], ['verify-handoff'], ['verify-qa-plan'], ['verify-worker-evidence'], ['validate'], ['design-rationales'],
  ['verify-freeze', 'NOPE'], ['verify-scope', 'NOPE'], ['freshness', 'NOPE'], ['validate', 'NOPE'], ['verify-qa-plan', 'NOPE'], ['design-rationales', 'NOPE'], ['design-rationales', '-'], ['design-rationales', '-', '--json'],
  ['ci-check'], ['ci-task-command'], ['commands-check'], ['scale-check'], ['batch-check']];
export const STATE_COMMANDS = [['verify-freeze', 'LC'], ['verify-scope', 'LC'], ['verify-knowledge-scope', 'LC'], ['freshness', 'LC'], ['verify-handoff', 'LC'], ['verify-qa-plan', 'LC'],
  ['verify-worker-evidence', 'LC'], ['validate', 'LC'], ['design-rationales', 'LC'], ['design-rationales', 'LC', '--json']];
let shapesDone = false;

/** @param {string} fx @param {string} label @param {string[][]} [extra] */
export function allSame(fx, label, extra = []) {
  const list = shapesDone ? [...STATE_COMMANDS, ...extra] : [...SHAPES, ...STATE_COMMANDS, ...extra];
  shapesDone = true;
  for (const c of list) {
    const a = exec(fx, c, 'node'); const b = exec(fx, c, 'sh');
    assert.deepEqual(a, b, `${label}: agent.sh ${c.join(' ')}`);
  }
}

const GATES_PARTIAL = `scaffold orchestrated no COMPLEX
worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null`;

const STATES = /** @type {Record<string, string>} */ ({
  planning: 'scaffold orchestrated no COMPLEX',
  implemented: GATES_PARTIAL,
  'all gates pass': `${GATES_PARTIAL}\npass_all`,
  'code done': 'scaffold orchestrated no COMPLEX; to_code_done orchestrated',
  'pass then edited (stale)': `${GATES_PARTIAL}\npass_all; printf 'more\\n' >> impl.txt`,
  'standalone standard': 'scaffold standalone no STANDARD; solo RED fail impl_test.txt "test: lookup"; solo GREEN pass impl.txt "impl: lookup"; A handoff LC IMPLEMENTED >/dev/null',
  trivial: 'scaffold standalone no TRIVIAL',
  'untracked, control plane and installed files': `scaffold orchestrated no COMPLEX; mkdir -p src docs .agents/extra; printf 'x\\n' > src/new.txt; printf 'd\\n' > docs/a.md; printf 'c\\n' > .agents/extra/f; printf '# P\\n\\n<!-- proofline:begin -->\\nb\\n<!-- proofline:end -->\\n' > AGENTS.md`,
});

describe('verify family equals the shell', () => {
  for (const [name, snippet] of Object.entries(STATES)) {
    test(name, () => { const fx = build(snippet); allSame(fx, name); });
  }

  test('a stray run artifact, a symlink in the run folder and an edited plan', () => {
    const fx = build(GATES_PARTIAL);
    writeFileSync(path.join(fx, '.agents/runs/LC/stray.txt'), 'x\n');
    allSame(fx, 'stray file');
    rmSync(path.join(fx, '.agents/runs/LC/stray.txt'));
    mkdirSync(path.join(fx, '.agents/runs/LC/scratch'), { recursive: true });
    spawnSync('ln', ['-s', '/etc/hosts', path.join(fx, '.agents/runs/LC/scratch/l')]);
    allSame(fx, 'symlink');
    rmSync(path.join(fx, '.agents/runs/LC/scratch'), { recursive: true });
    appendFileSync(path.join(fx, '.agents/runs/LC/PLAN.md'), 'edit\n');
    allSame(fx, 'edited plan');
  });
});
