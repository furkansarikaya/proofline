// @ts-check
// A315: proc.mjs reads no environment itself; every entry point hands it the process environment (setOwnEnv) before it can be needed, and a missing hand-over is a
// clear error, never a silent empty environment. The census lists the entry points that reach proc.mjs and fails for a new one that does not call setOwnEnv.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  'adapters/codex/install.mjs': 'setOwnEnv(process.env)',
});

test('proc: every entry point that reaches proc.mjs hands the environment over', () => {
  for (const [f, call] of Object.entries(ENTRIES)) assert.ok(readFileSync(path.join(root, f), 'utf8').includes(call), `${f} does not call ${call}`);
  assert.match(readFileSync(path.join(root, 'bin/proofline'), 'utf8'), /core\/proflinecli\.mjs/);
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
