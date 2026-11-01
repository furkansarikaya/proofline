// @ts-check
// proc.mjs starts no shell script of a run worktree (stage 3 security rounds 2 and 3): a copy compared and then run leaves a window for a rewrite
// in between, so the core runs the project's own code for a worktree's run instead. Only `allowEqualTree` (the hook's rollback mode) runs one, while
// its whole tree equals the project's.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as proc from '../../control-plane/agents/scripts/core/proc.mjs';
import { refuseUntrustedScript, sameTree } from '../../control-plane/agents/scripts/core/tree.mjs';

/** A project with a worktree whose scripts are copies; MARK is the file every script creates when it runs. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pl-tree-'));
  const wt = path.join(root, '.agents/local/worktrees/T-1');
  const mark = path.join(root, 'MARK');
  for (const dir of [path.join(root, '.agents/scripts'), path.join(wt, '.agents/scripts/core')]) mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, '.agents/scripts/core'), { recursive: true });
  for (const base of [root, wt]) {
    for (const f of ['agent.sh', 'lessons.sh', 'platform.sh']) writeFileSync(path.join(base, '.agents/scripts', f), `#!/bin/sh\n: > "${mark}"\n`);
    writeFileSync(path.join(base, '.agents/scripts/core/x.mjs'), 'export {};\n');
  }
  return { root, wt, mark, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('no worktree script runs, identical tree or not; the project\'s own scripts do; allowEqualTree runs an identical tree only', () => {
  const f = fixture();
  try {
    assert.ok(sameTree(path.join(f.root, '.agents/scripts'), path.join(f.wt, '.agents/scripts')));
    let r = proc.run('sh', [path.join(f.wt, '.agents/scripts/agent.sh')], { cwd: f.wt });
    assert.equal(r.status, 126, 'an identical copy is not run either');
    assert.ok(!existsSync(f.mark));
    r = proc.run('sh', [path.join(f.wt, '.agents/scripts/agent.sh')], { cwd: f.wt, allowEqualTree: true });
    assert.equal(r.status, 0, 'the rollback mode runs an identical tree');
    assert.ok(existsSync(f.mark));
    rmSync(f.mark);
    appendFileSync(path.join(f.wt, '.agents/scripts/core/x.mjs'), '// planted\n'); // a rewritten core file: agent.sh itself is untouched
    for (const [script, cwd] of /** @type {Array<[string, string]>} */ ([
      [path.join(f.wt, '.agents/scripts/agent.sh'), f.root], [path.join(f.wt, '.agents/scripts/lessons.sh'), f.root], [path.join(f.wt, '.agents/scripts/platform.sh'), f.root],
      ['.agents/scripts/agent.sh', f.wt], ['./.agents/scripts/../scripts/agent.sh', f.wt],
    ])) {
      r = proc.run('sh', [script, 'x'], { cwd });
      assert.equal(r.status, 126, script);
      assert.match(r.stderr.toString(), /run worktree's copy/);
      r = proc.run('sh', [script, 'x'], { cwd, allowEqualTree: true });
      assert.equal(r.status, 126, `${script} (rewritten tree, rollback mode)`);
      assert.ok(!existsSync(f.mark), `${script} ran`);
    }
    assert.equal(refuseUntrustedScript('sh', ['-c', 'true'], f.wt), null);
    const main = proc.run('sh', [path.join(f.root, '.agents/scripts/agent.sh')], { cwd: f.root });
    assert.equal(main.status, 0, 'the project\'s own scripts run');
  } finally { f.clean(); }
});

test('a swap between the comparison and the start cannot run: the identical copy is refused before any start', () => {
  const f = fixture();
  try {
    // rollback mode compares, then starts; the swap happens when the shell has opened the compared file: the script it reads is still the project's text
    const script = path.join(f.wt, '.agents/scripts/agent.sh');
    const r = proc.run('sh', [script], { cwd: f.wt });
    assert.equal(r.status, 126);
    assert.ok(!existsSync(f.mark), 'the default never starts a worktree script, so there is nothing to swap');
  } finally { f.clean(); }
});

test('the same refusal for the asynchronous spawn and for a script added to the worktree', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.wt, '.agents/scripts/extra.sh'), `: > "${f.mark}"\n`);
    const r = await proc.runAsync('sh', [path.join(f.wt, '.agents/scripts/extra.sh')], { cwd: f.wt });
    assert.equal(r.status, 126);
    assert.ok(!existsSync(f.mark));
  } finally { f.clean(); }
});
