// @ts-check
// proc.mjs starts no shell script of a run worktree whose script tree differs from the project's own (stage 3 security round 2): the bridge to the
// shell code, the helper scripts (lessons.sh, platform.sh, ...) and the worktree re-exec all go through proc.run.
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

test('an identical worktree script tree runs; a rewritten one never does, for every script and spelling', () => {
  const f = fixture();
  try {
    assert.ok(sameTree(path.join(f.root, '.agents/scripts'), path.join(f.wt, '.agents/scripts')));
    let r = proc.run('sh', [path.join(f.wt, '.agents/scripts/agent.sh')], { cwd: f.wt });
    assert.equal(r.status, 0);
    assert.ok(existsSync(f.mark));
    rmSync(f.mark);
    appendFileSync(path.join(f.wt, '.agents/scripts/core/x.mjs'), '// planted\n'); // a rewritten core file: agent.sh itself is untouched
    for (const [script, cwd] of /** @type {Array<[string, string]>} */ ([
      [path.join(f.wt, '.agents/scripts/agent.sh'), f.root], [path.join(f.wt, '.agents/scripts/lessons.sh'), f.root], [path.join(f.wt, '.agents/scripts/platform.sh'), f.root],
      ['.agents/scripts/agent.sh', f.wt], ['./.agents/scripts/../scripts/agent.sh', f.wt],
    ])) {
      r = proc.run('sh', [script, 'x'], { cwd });
      assert.equal(r.status, 126, script);
      assert.match(r.stderr.toString(), /differs from the project's own/);
      assert.ok(!existsSync(f.mark), `${script} ran`);
    }
    assert.notEqual(refuseUntrustedScript('sh', ['-c', 'true'], f.wt), 'x');
    const main = proc.run('sh', [path.join(f.root, '.agents/scripts/agent.sh')], { cwd: f.root });
    assert.equal(main.status, 0, 'the project\'s own scripts run');
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
