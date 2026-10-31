// @ts-check
// next before the freeze (plan mutations) and with dispatch markers, against the shell. Each case changes a file of one fixture, compares
// the Node core with the shell code, and restores the file. Markers are removed by `next` itself, so each engine gets its own copy.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { build, exec, GATES_PARTIAL } from './states.mjs';

const CMDS = [['next', 'LC'], ['digest', 'LC']];

/** @param {string} fx @param {string} label */
function same(fx, label) {
  for (const c of CMDS) assert.deepEqual(exec(fx, c, 'node'), exec(fx, c, 'sh'), `${label}: ${c.join(' ')}`);
}

describe('next before the freeze', () => {
  test('plan mutations', () => {
    const fx = build('scaffold orchestrated no COMPLEX supervised');
    const d = path.join(fx, '.agents/runs/LC');
    /** @param {string} f @param {(t: string) => string | null} edit @param {string} label */
    const mutate = (f, edit, label) => {
      const p = path.join(d, f); const orig = readFileSync(p, 'latin1');
      const t = edit(orig);
      if (t === null) rmSync(p); else writeFileSync(p, t, 'latin1');
      try { same(fx, label); } finally { writeFileSync(p, orig, 'latin1'); }
    };
    same(fx, 'plan approval required');
    mutate('EVIDENCE.md', () => null, 'no evidence');
    mutate('PLAN.md', () => null, 'no plan');
    mutate('QA_PLAN.md', () => null, 'no qa plan');
    mutate('PLAN.md', (t) => t.replace('## Architecture', '## Other'), 'no architecture');
    mutate('PLAN.md', (t) => `${t}\n## Data\ndestructive: yes\n`, 'destructive without steps');
    mutate('PLAN.md', (t) => `${t}\n## Data\ndestructive: yes\nsingle_step: yes\n`, 'single step not asked for');
    mutate('PLAN.md', (t) => `${t}\n## Data\ndestructive: yes\n| step | phase | operation | object | destructive | x |\n|---|---|---|---|---|---|\n| 1 | expand | add | t | no | |\n| 2 | contract | drop | t | yes | |\n`, 'expand and contract');
    mutate('PLAN.md', (t) => t.replace('## Assumptions\nnone', '## Assumptions\nsome text'), 'assumptions not a table');
    mutate('PLAN.md', (t) => t.replace('## Assumptions\nnone', '## Assumptions\n| id | assumption | source | risk | verification | status | decisions |\n|---|---|---|---|---|---|---|\n| AS-1 | the db is empty | user | high | check | unverified | d |'), 'high-risk unverified');
    mutate('PLAN.md', (t) => t.replace('## Assumptions\nnone', '## Assumptions\n| id | assumption | source | risk | verification | status | decisions |\n|---|---|---|---|---|---|---|\n| AS-1 | x | user | low | none | verified | d |'), 'verified without method');
    mutate('PLAN.md', (t) => t.replace('## Assumptions\nnone\n', ''), 'no assumptions section');
    mutate('TASK.md', (t) => `${t}\n## Context\n\nthis fixes a bug in lookup\n`, 'task mentions a defect');
    mutate('TASK.md', (t) => `${t}\n## Pre-existing defects\n\n- a.go:f: broken\n`, 'defect without decision');
    mutate('TASK.md', (t) => `${t}\n## Pre-existing defects\n\n- a.go:f: broken -- decision: fix\n`, 'defect to fix');
    mutate('RUN.yaml', (t) => t.replace('autonomy: supervised', 'autonomy: autonomous'), 'autonomous, ready to freeze');
    mutate('RUN.yaml', (t) => t.replace('awaiting_input: false', 'awaiting_input: true'), 'question pending');
    mutate('RUN.yaml', (t) => t.replace('status: captured', 'status: pending'), 'baseline missing');
    mutate('RUN.yaml', (t) => t.replace('classification: COMPLEX', 'classification: PENDING'), 'not classified');
    mutate('RUN.yaml', (t) => t.replace('state: PLANNING', 'state: FAILED'), 'terminal');
  });

  test('a standing request, then an approval, then the freeze', () => {
    const fx = build('scaffold orchestrated no COMPLEX supervised');
    spawnAgent(fx, ['request-approval', 'LC', 'plan']);
    same(fx, 'request standing');
    spawnAgent(fx, ['request-approval', 'LC', 'plan']);
    same(fx, 'request asked twice');
  });

  test('risk signal without its plan flag, before the freeze', () => {
    const fx = build(`SC_SCOPE_NAMED=db/migrations/001.sql SC_PLAN_EXTRA='${'\n## Data\ndestructive: no\n'}' scaffold orchestrated no COMPLEX supervised`);
    same(fx, 'missing flag');
  });
});

/** @param {string} fx @param {string[]} args */
function spawnAgent(fx, args) { exec(fx, args, 'sh'); }

describe('next with dispatch markers', () => {
  /** @param {string} name @param {(dir: string) => void} make */
  function markerCase(name, make) {
    test(name, () => {
      const fx = build(GATES_PARTIAL);
      const a = `${fx}-a`; const b = `${fx}-b`;
      cpSync(fx, a, { recursive: true }); cpSync(fx, b, { recursive: true });
      for (const x of [a, b]) { mkdirSync(path.join(x, '.agents/runs/LC/dispatch'), { recursive: true }); make(path.join(x, '.agents/runs/LC/dispatch')); }
      for (const c of CMDS) {
        const n = exec(a, c, 'node'); const s = exec(b, c, 'sh');
        assert.equal(n.out.replaceAll(a, b), s.out, `${name}: ${c.join(' ')}`);
        assert.equal(n.code, s.code);
        assert.deepEqual(readdirSync(path.join(a, '.agents/runs/LC/dispatch')), readdirSync(path.join(b, '.agents/runs/LC/dispatch')), `${name}: markers left`);
      }
      rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
    });
  }
  markerCase('a stale marker is removed and named', (dir) => writeFileSync(path.join(dir, '001-reviewer-claude.running'), 'pid=999999\nrole=reviewer\n'));
  markerCase('a marker without a pid is stale', (dir) => writeFileSync(path.join(dir, '001-x.running'), 'role=x\n'));
  markerCase('a live dispatch is waited for', (dir) => writeFileSync(path.join(dir, '001-reviewer-claude.running'), `pid=${process.pid}\nrole=reviewer\n`));
  markerCase('a live dispatch without a role', (dir) => writeFileSync(path.join(dir, '001-x.running'), `pid=${process.pid}\n`));
  markerCase('a live and a stale marker', (dir) => { writeFileSync(path.join(dir, '001-a.running'), 'pid=999999\nrole=a\n'); writeFileSync(path.join(dir, '002-b.running'), `pid=${process.pid}\nrole=b\n`); });
  markerCase('a dispatch past most of its time (note)', (dir) => writeFileSync(path.join(dir, '001-reviewer-claude.running'), `pid=${process.pid}\nrole=reviewer\ntimeout=5400\nstarted_epoch=${Math.floor(Date.now() / 1000) - 5000}\n`));
  markerCase('a dispatch early in its time (no note)', (dir) => writeFileSync(path.join(dir, '001-reviewer-claude.running'), `pid=${process.pid}\nrole=reviewer\ntimeout=5400\nstarted_epoch=${Math.floor(Date.now() / 1000) - 100}\n`));
});
