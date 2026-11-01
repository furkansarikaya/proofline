// @ts-check
// The lead's normal flow for a run that lives in a run worktree (.agents/local/worktrees/<ID>): the commands work from the main tree with the run id and
// from inside the worktree through its own ./.agents/scripts/agent.sh, and the code that runs is the PROJECT's (main tree's), never the worktree's copy
// (security round 3: a task can rewrite the worktree's tracked scripts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildTemplate, copyProject, cleanEnv, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join } from './harness.mjs';

let template = ''; let base = ''; let d = ''; let wt = '';
const git = (/** @type {string[]} */ ...a) => spawnSync('git', a, { cwd: d, env: cleanEnv(), encoding: 'utf8' });
before(() => {
  template = buildTemplate({ run: false });
  base = mkdtempSync(join(tmpdir(), 'hook-wf-'));
  d = copyProject(template, base);
  git('add', '-A', '-f', '.agents/scripts'); git('commit', '-qm', 'scripts');
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'worktree-add', 'T-2'], { cwd: d, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  wt = r.stdout.trim();
  // the run of the worktree: the scaffolded run LC, renamed
  cpSync(join(d, '.agents/runs/LC'), join(wt, '.agents/runs/T-2'), { recursive: true });
  const f = join(wt, '.agents/runs/T-2/RUN.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replaceAll('LC', 'T-2'));
  writeFileSync(join(wt, '.agents/local/ACTIVE_RUN'), 'T-2\n');
});
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const fromMain = (/** @type {string[]} */ args) => spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: d, env: cleanEnv(), encoding: 'utf8' });
const fromWorktree = (/** @type {string[]} */ args) => spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: wt, env: cleanEnv(), encoding: 'utf8' });

test('moved commands find the run from the main tree and from the worktree', () => {
  for (const args of [['next', 'T-2'], ['summary', 'T-2'], ['pipeline', 'T-2'], ['digest', 'T-2'], ['status']]) {
    for (const [where, run] of /** @type {Array<[string, typeof fromMain]>} */ ([['main', fromMain], ['worktree', fromWorktree]])) {
      const r = run(args);
      assert.equal(r.status, 0, `${where}: ${args.join(' ')}: ${r.stderr}${r.stdout}`);
      assert.doesNotMatch(r.stderr, /run worktree's copy|run not found/, `${where}: ${args.join(' ')}`);
    }
  }
  assert.match(fromWorktree(['status']).stdout, /active_task=T-2/);
  assert.match(fromWorktree(['open-runs']).stdout, /^T-2/m);
});

test('the shell commands of the batch flow run from the worktree (the run is found there)', () => {
  const r = fromWorktree(['batch-cover', 'T-2', 'delivery']);
  assert.doesNotMatch(r.stderr + r.stdout, /run worktree's copy|run not found/, 'it got as far as the batch checks');
  assert.match(r.stderr + r.stdout, /batch approval/);
});

test('a rewritten worktree core, queue module or script never runs; the commands still work', () => {
  const marks = [];
  for (const f of ['proofline-core.mjs', 'core/queue.mjs', 'core/next.mjs', 'core/proc.mjs', 'core/context.mjs']) {
    const file = join(wt, '.agents/scripts', f);
    const mark = join(d, `MARK-${f.replace('/', '-')}`);
    writeFileSync(file, `import { writeFileSync as w } from 'node:fs';\nw(${JSON.stringify(mark)}, 'x');\n${readFileSync(file, 'utf8')}`);
    marks.push(mark);
  }
  const helper = join(wt, '.agents/scripts/platform.sh');
  const hm = join(d, 'MARK-platform.sh');
  writeFileSync(helper, `: > ${JSON.stringify(hm)}\n${readFileSync(helper, 'utf8')}`);
  marks.push(hm);
  for (const run of [fromMain, fromWorktree]) {
    const r = run(['next', 'T-2']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^task=T-2/m);
    assert.equal(run(['config-check']).status, 0);
  }
  for (const m of marks) assert.ok(!existsSync(m), `${m} ran`);
});
