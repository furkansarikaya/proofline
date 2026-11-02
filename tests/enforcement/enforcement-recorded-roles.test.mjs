// @ts-check
// Absolute Node tests for the enforcement scenarios read_roles_tree (A143) and knowledge_stage (A159): the recorded corpora (tests/enforcement/recorded/)
// replayed against the Node hook. Verdicts and reason texts are literals recorded once from the shell hook.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project } from '../core/legacy-lib.mjs';
import { corpus, replay } from './recorded.mjs';
import { fixtureRecipe, setState } from './recorded-fixture.mjs';

const base = mkdtempSync(join(tmpdir(), 'enf-rec-'));
after(() => rmSync(base, { recursive: true, force: true }));

test('read_roles_tree (A143): the read-only roles (qa, reviewer, security-reviewer, verifier) never change the project working tree; the evidence worktree and scratch stay writable', async () => {
  const dir = project(fixtureRecipe());
  mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src/ro.txt'), 'a\n');
  const wt = spawnSync('git', ['worktree', 'add', '-q', '--detach', join(base, 'wt-ro'), 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(wt.status, 0, `A143 fixture worktree: ${wt.stderr}`);
  mkdirSync(join(base, 'wt-ro/src'), { recursive: true }); writeFileSync(join(base, 'wt-ro/src/ro.txt'), 'a\n');
  mkdirSync(join(dir, '.agents/runs/LC/scratch'), { recursive: true });
  const steps = corpus('read_roles_tree');
  // the lead, the implementer and an explorer get no read-role denial for the same commands (the last twelve calls)
  for (const s of steps.slice(-12)) s.not = 'read-only in the project working tree';
  await replay({ steps, dir, base });
});

test('knowledge_stage (A159): the lead writes the wiki and the design documents only after CODE_DONE (or on a FAILED/BLOCKED run), never product code or RUN.yaml', async () => {
  const steps = corpus('knowledge_stage');
  const seg = (/** @type {string} */ n, /** @type {string} */ recipe, /** @type {number} */ from, /** @type {number} */ to, /** @type {(d: string) => void} */ fix = () => {}) => ({ n, recipe, from, to, fix });
  const segments = [
    seg('implementing', fixtureRecipe(), 0, 3),
    seg('planning', fixtureRecipe('planning'), 3, 5),
    seg('code_done', fixtureRecipe('code_done'), 5, 15),
    seg('done', fixtureRecipe('code_done'), 15, 17, (d) => setState(d, 'handoff', 'DONE')),
    seg('blocked', fixtureRecipe(), 17, 19, (d) => setState(d, 'execution', 'BLOCKED')),
  ];
  for (const s of segments) {
    const dir = project(s.recipe);
    s.fix(dir);
    await replay({ steps, dir, base, only: [s.from, s.to] });
  }
});
