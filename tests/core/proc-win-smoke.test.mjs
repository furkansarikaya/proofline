// @ts-check
// A320: the Windows branches of proc.mjs, run on every platform in a fresh process with a win32 platform stub and no env, so that an entry point that did not hand
// the environment over (A315) fails on a pull request and not only in the Windows gate that runs on dispatch and nightly. Each public function that takes the
// default environment is called without setOwnEnv (a clear error) and, where it can run without a Windows host, again after setOwnEnv.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const procPath = path.join(root, 'control-plane/agents/scripts/core/proc.mjs');
const procUrl = pathToFileURL(procPath).href;
const GONE = 'the entry point did not hand over the environment';

/** A fresh process: the hand-over is state of the module, per process. @param {string} code */
function inFreshNode(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as proc from ${JSON.stringify(procUrl)};\n${code}`], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

const FS = "{ isFile: () => false, real: (p) => p, refusedDir: () => false }";
const SPEC = JSON.stringify({ cwd: '.', remove: [], close: ['true'], note: ['true'], noteText: 'x', set: {} });
// name -> [the call that needs the default environment, the call after the hand-over (null: it would start a process or wait)]
/** @type {Record<string, [string, string | null]>} */
const CALLS = {
  resolveProgram: [`proc.resolveProgram('git', undefined, 'C:\\\\p', 'win32', ${FS})`, `proc.resolveProgram('git', undefined, 'C:\\\\p', 'win32', ${FS})`],
  killWindowsTree: ["proc.killWindowsTree(5, true, () => ({ status: 0 }))", "proc.killWindowsTree(5, true, () => ({ status: 0 }))"],
  startLeader: ["proc.startLeader('git', [], { stdio: ['ignore', 'ignore', 'ignore'], platform: 'win32', warn: () => {} })", "proc.startLeader('git', [], { stdio: ['ignore', 'ignore', 'ignore'], platform: 'win32', warn: () => {} })"],
  runCloser: [`proc.runCloser(['99999999', ${JSON.stringify(SPEC)}])`, null],
};

for (const [name, [call, after]] of Object.entries(CALLS)) {
  test(`proc on win32: ${name} without setOwnEnv is a clear error, not an empty environment`, () => {
    const r = inFreshNode(`try { ${call}; console.log('no error'); } catch (e) { console.log(e.message); }`);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, new RegExp(GONE), `${name}: ${r.out}`);
    if (after === null) return;
    const ok = inFreshNode(`proc.setOwnEnv({ SystemRoot: 'C:\\\\Windows', PATH: '' }); ${after}; console.log('ok');`);
    assert.equal(ok.status, 0, ok.err);
    assert.equal(ok.out, 'ok', `${name} after setOwnEnv: ${ok.out}`);
  });
}

test('proc on win32: every site that takes the default environment has a case above', () => {
  const src = readFileSync(procPath, 'utf8');
  // the functions whose body or default parameter calls ownEnvOrThrow
  const using = [];
  const parts = src.split(/^(?=(?:export )?function \w+\()/m);
  for (const p of parts) {
    const m = /^(?:export )?function (\w+)\(/.exec(p);
    if (m && m[1] !== 'ownEnvOrThrow' && p.includes('ownEnvOrThrow()')) using.push(m[1]);
  }
  // resolveProgram is reached by startLeader and run; each user of the default environment is itself named in CALLS
  assert.deepEqual(using.sort(), ['killWindowsTree', 'resolveProgram', 'runCloser'], 'a new function that takes the default environment needs a case in CALLS');
  for (const u of using) assert.ok(u in CALLS, u);
});
