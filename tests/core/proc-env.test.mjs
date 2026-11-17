// @ts-check
// A315: proc.mjs reads no environment itself; every entry point hands it the process environment (setOwnEnv) before it can be needed, and a missing hand-over is a
// clear error, never a silent empty environment. The census lists the entry points that reach proc.mjs and fails for a new one that does not call setOwnEnv.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from '../lib/tempdir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const procUrl = pathToFileURL(`${root}/control-plane/agents/scripts/core/proc.mjs`).href;

/** A fresh process: the module state (the environment handed over or not) is per process. @param {string} code */
function inFreshNode(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as proc from ${JSON.stringify(procUrl)};\n${code}`], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('proc: without setOwnEnv the default environment is a clear error, with it the environment is the one handed over', () => {
  const none = inFreshNode("try { proc.killWindowsTree(5, true, () => ({ status: 0 })); console.log('no error'); } catch (e) { console.log(e.message); }");
  assert.equal(none.status, 0, none.err);
  assert.match(none.out, /the entry point did not hand over the environment/);
  const given = inFreshNode("proc.setOwnEnv({ SystemRoot: 'C:\\\\Windows' }); let c = ''; proc.killWindowsTree(5, true, (cmd) => { c = cmd; return { status: 0 }; }); console.log(c);");
  assert.equal(given.status, 0, given.err);
  assert.match(given.out, /taskkill/i);
  // an explicit env needs no hand-over
  const explicit = inFreshNode("proc.killWindowsTree(5, true, () => ({ status: 0 }), {}); console.log('ok');");
  assert.equal(explicit.out.trim(), 'ok', explicit.err);
});

/** Every file the entry point imports, by static relative imports, as repository-relative paths. @param {string} f */
function imports(f) {
  const out = [];
  let s = '';
  try { s = readFileSync(path.join(root, f), 'utf8'); } catch { return out; }
  for (const m of s.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const p = path.posix.join(path.posix.dirname(f), m[1]);
    if (existsSync(path.join(root, p))) out.push(p);
  }
  return out;
}
const PROC = 'control-plane/agents/scripts/core/proc.mjs';
/** @param {string} f @param {Set<string>} [seen] */
function reachesProc(f, seen = new Set()) {
  if (f === PROC) return true;
  if (seen.has(f)) return false;
  seen.add(f);
  return imports(f).some((g) => reachesProc(g, seen));
}
/** @param {string} dir @returns {string[]} */
function mjsUnder(dir) {
  const out = [];
  for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...mjsUnder(rel));
    else if (e.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

// the files that start a process of their own and reach proc.mjs, and what hands the environment over in each
const ENTRIES = /** @type {Record<string, string>} */ ({
  'control-plane/agents/scripts/proofline-core.mjs': 'proc.setOwnEnv(process.env)',
  'control-plane/agents/scripts/core/guardian.mjs': 'setOwnEnv(process.env)',
  'control-plane/agents/scripts/core/proflinecli.mjs': 'proc.setOwnEnv(process.env)',   // bin/proofline loads it and calls main
  'adapters/claude/hooks/lib/agent.mjs': 'm.setOwnEnv?.(process.env)',   // the hook imports the project's proc.mjs here
  'adapters/claude/hooks/lib/worker.mjs': 'setOwnEnv?.(process.env)',   // a core command on a worker thread, which has its own copy of proc.mjs
  'adapters/codex/install.mjs': 'setOwnEnv(process.env)',
});

test('proc: every entry point that reaches proc.mjs hands the environment over', () => {
  for (const [f, call] of Object.entries(ENTRIES)) assert.ok(readFileSync(path.join(root, f), 'utf8').includes(call), `${f} does not call ${call}`);
  assert.match(readFileSync(path.join(root, 'bin/proofline'), 'utf8'), /core\/proflinecli\.mjs/);
});

test('proc: a hook or adapter file that runs core code without main() (core.run, or an import of proofline-core.mjs) hands the environment over', () => {
  const files = mjsUnder('adapters').filter((f) => /^[^/*\n]*(?:\bcore\.run\(|import\([^)\n]*proofline-core\.mjs)/m.test(readFileSync(path.join(root, f), 'utf8')) && !f.endsWith('generate.mjs'));
  assert.ok(files.length >= 2, `expected the hook files that run the core: ${files}`);
  for (const f of files) assert.ok(readFileSync(path.join(root, f), 'utf8').includes('setOwnEnv'), `${f} runs core code without main() and does not call setOwnEnv`);
});

test('proc: the hook worker thread and the in-process core hand the environment to the core\'s proc.mjs', () => {
  const dir = tempDir('pl-procenv-');
  try {
    mkdirSync(`${dir}/.agents/scripts/core`, { recursive: true });
    writeFileSync(`${dir}/.agents/scripts/core/proc.mjs`, `export * from ${JSON.stringify(procUrl)};\n`);   // the same module instance as the real one
    writeFileSync(`${dir}/.agents/scripts/proofline-core.mjs`, "import * as proc from './core/proc.mjs';\nexport function run() { try { proc.killWindowsTree(1, false, () => ({ status: 0 })); return 0; } catch { return 9; } }\n");
    mkdirSync(`${dir}/.agents/scripts/core`, { recursive: true });
    const coreUrl = pathToFileURL(`${dir}/.agents/scripts/proofline-core.mjs`).href;
    const worker = pathToFileURL(`${root}/adapters/claude/hooks/lib/worker.mjs`).href;
    const agent = pathToFileURL(`${root}/adapters/claude/hooks/lib/agent.mjs`).href;
    const viaWorker = spawnSync(process.execPath, ['--input-type=module', '-e', `import { Worker } from 'node:worker_threads';
const w = new Worker(new URL(${JSON.stringify(worker)}), { execArgv: [], workerData: { coreUrl: ${JSON.stringify(coreUrl)}, argv: [], io: {}, cancel: new SharedArrayBuffer(4) } });
w.on('message', (m) => console.log('status', m.status));`], { encoding: 'utf8' });
    assert.match(viaWorker.stdout, /status 0/, `worker: ${viaWorker.stdout}${viaWorker.stderr}`);
    const inProc = spawnSync(process.execPath, ['--input-type=module', '-e', `import { Agents } from ${JSON.stringify(agent)};
const a = new Agents({ root: ${JSON.stringify(dir)}, mainRoot: ${JSON.stringify(dir)}, agentPath: '', env: {}, lockWait: 1, cwd: ${JSON.stringify(dir)} });
const core = await a.core(); console.log('status', core.run([], {}));`], { encoding: 'utf8' });
    assert.match(inProc.stdout, /status 0/, `in process: ${inProc.stdout}${inProc.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proc: a new file that starts a process (a shebang or a main on process.argv) and reaches proc.mjs is in the entry list', () => {
  const known = new Set(Object.keys(ENTRIES));
  // not entry points of their own: batch.mjs names process.argv inside a script string; netmain.mjs and the hook events do not reach proc.mjs on their own
  const files = [...mjsUnder('control-plane'), ...mjsUnder('adapters')].filter((f) => !known.has(f) && f !== PROC);
  const missing = files.filter((f) => {
    const s = readFileSync(path.join(root, f), 'utf8');
    const isEntry = s.startsWith('#!') || /^if \(process\.argv\[\d\]/m.test(s) || /^[a-z].*process\.argv\.slice\(/m.test(s) && !/^\s*(\/\/|\*|const [A-Z_]+ =)/.test(s);
    return isEntry && reachesProc(f);
  });
  assert.deepEqual(missing.filter((f) => !f.endsWith('core/batch.mjs')), [], 'a file that starts a process and reaches proc.mjs must call setOwnEnv(process.env) and be listed in ENTRIES');
});
