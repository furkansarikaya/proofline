// @ts-check
// Package C2 (stage 2), the states that change the repository or write RUN.yaml: a moved base (freshness records and rewrites), a product commit
// (stale plan), DESIGN.md rationale lines, plan-exemption shapes, and the CI workflow reader against the shell's awk. Each comparison runs on
// its own copy of the tree for each engine (freshness writes). The shell is the specification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { workflowHasPr } from '../../control-plane/agents/scripts/core/commands/checks.mjs';
import { agentSh } from './helpers.mjs';
import { build, exec } from './verify-helpers.mjs';

const GIT_ENV = { PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
/** @param {string} fx @param {string[]} a */
const git = (fx, a) => spawnSync('git', ['-C', fx, ...a], { env: GIT_ENV, encoding: 'utf8' });
const base = () => build('scaffold orchestrated no COMPLEX; A handoff LC IMPLEMENTED >/dev/null');

/** Run the same command through each engine on its own copy of the tree; the output and the resulting RUN.yaml and ledger must agree. @param {string} fx @param {string[]} args */
function sameOnCopies(fx, args) {
  /** @type {Array<{ out: string, err: string, code: number | null, run: string, ledger: string }>} */ const res = [];
  for (const engine of /** @type {const} */ (['node', 'sh'])) {
    const copy = mkdtempSync(path.join(tmpdir(), 'pl-vfslow-'));
    cpSync(fx, copy, { recursive: true, verbatimSymlinks: true });
    const r = exec(copy, args, engine);
    const rd = (/** @type {string} */ f) => { try { return readFileSync(path.join(copy, '.agents/runs/LC', f), 'latin1'); } catch { return ''; } };
    res.push({ ...r, run: rd('RUN.yaml'), ledger: rd('LEDGER.log').replace(/ts=\S+ epoch=\S+/g, 'ts=T epoch=E') });
    rmSync(copy, { recursive: true, force: true });
  }
  assert.deepEqual(res[0], res[1], `agent.sh ${args.join(' ')}`);
  return res[0];
}

describe('freshness and the moved base', () => {
  test('a control-plane commit moves the base; a product commit makes the plan stale; AGENTS.md text is a product change', () => {
    const fx = base();
    mkdirSync(path.join(fx, '.agents/extra'), { recursive: true });
    writeFileSync(path.join(fx, '.agents/extra/cp.txt'), 'c\n');
    git(fx, ['add', '-f', '.agents/extra/cp.txt']); git(fx, ['commit', '-q', '-m', 'cp']);
    const moved = sameOnCopies(fx, ['freshness', 'LC']);
    assert.match(moved.out, /base_sha moved/);
    for (const c of ['validate', 'verify-handoff', 'verify-scope']) sameOnCopies(fx, [c, 'LC']);
    writeFileSync(path.join(fx, 'product.txt'), 'p\n');
    git(fx, ['add', 'product.txt']); git(fx, ['commit', '-q', '-m', 'product']);
    const stale = sameOnCopies(fx, ['freshness', 'LC']);
    assert.match(stale.err, /stale plan/);
    sameOnCopies(fx, ['validate', 'LC']);
  });

  test('AGENTS.md outside the block, and a task file edit', () => {
    const fx = base();
    writeFileSync(path.join(fx, 'AGENTS.md'), '# P\n\nrules\n');
    git(fx, ['add', 'AGENTS.md']); git(fx, ['commit', '-q', '-m', 'agents']);
    sameOnCopies(fx, ['freshness', 'LC']);
    sameOnCopies(fx, ['verify-scope', 'LC']);
    appendFileSync(path.join(fx, '.agents/runs/LC/TASK.md'), 'edit\n');
    sameOnCopies(fx, ['verify-freeze', 'LC']);
    sameOnCopies(fx, ['freshness', 'LC']);
  });
});

describe('design-rationales', () => {
  test('lines, an approval-less run and the json form', () => {
    const fx = base();
    mkdirSync(path.join(fx, 'docs/design'), { recursive: true });
    writeFileSync(path.join(fx, 'docs/design/DESIGN.md'), '# D\n\n## Pattern justifications\n\n- tiny-text: used for legal notes\n- `wide-card`: dense table\n* empty:\n  text\n\n## Other\n- x: y\n');
    for (const a of [['LC'], ['LC', '--json'], ['-'], ['-', '--json'], ['LC', 'docs/design/DESIGN.md'], ['LC', '--json', 'docs/design/DESIGN.md'], ['LC', 'missing.md']]) sameOnCopies(fx, ['design-rationales', ...a]);
  });
});

describe('plan exemptions and worker evidence', () => {
  test('content task type, generic reasons, topology', () => {
    const fx = base();
    const plan = path.join(fx, '.agents/runs/LC/PLAN.md');
    const text = readFileSync(plan, 'latin1');
    writeFileSync(plan, text.replace(/(  - path: impl\.txt\n)/, '$1    tdd_exemption: n/a\n'), 'latin1');
    sameOnCopies(fx, ['verify-worker-evidence', 'LC']);
    writeFileSync(plan, text.replace(/(  - path: impl\.txt\n)/, '$1    tdd_exemption: the documentation text has no executable behaviour\n'), 'latin1');
    sameOnCopies(fx, ['verify-worker-evidence', 'LC']);
    writeFileSync(path.join(fx, '.agents/runs/LC/TASK.md'), `${readFileSync(path.join(fx, '.agents/runs/LC/TASK.md'), 'latin1')}\n**Type:** docs\n`, 'latin1');
    sameOnCopies(fx, ['verify-worker-evidence', 'LC']);
  });
});

describe('workflow reader', () => {
  const awk = (/** @type {string} */ text) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-wf-'));
    const f = path.join(dir, 'w.yml'); writeFileSync(f, text);
    const fn = agentSh.slice(agentSh.indexOf('ci_workflow_has_pr() {'), agentSh.indexOf('\nci_check() {'));
    const r = spawnSync('sh', ['-c', `${fn}\nci_workflow_has_pr "$1"`, 'x', f]);
    rmSync(dir, { recursive: true, force: true });
    return r.status === 0;
  };
  for (const t of ['on: pull_request\n', 'on: [push, pull_request]\n', 'on:\n  push:\n  pull_request:\n', 'on:\n  - push\n  - pull_request_target\n', 'on: push\njobs:\n  pull_request:\n', '# on: pull_request\non: push\n',
    '"on":\n  pull_request: {}\n', 'on: {pull_request: {}}\r\n', 'on:\n    push:\n      branches: [pull_request]\n    schedule:\n', 'name: x\non:\n  workflow_dispatch:\n', "'on':\n  pull_request: # c\n", 'on:\n  pull_request_target:\n']) {
    test(JSON.stringify(t), () => assert.equal(workflowHasPr(t.split('\n').slice(0, t.endsWith('\n') ? -1 : undefined)), awk(t)));
  }
});
