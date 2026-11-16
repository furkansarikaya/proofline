// @ts-check
// The safe layer (adapters/claude/hooks/lib/safefs.mjs): on a Windows host Node aborts the whole process on a path that holds U+10000 or U+10FFFF, and an abort is not a block. The layer judges the TEXT of
// every path before libuv sees it. Part 1 runs on every host with an INJECTED predicate (the private-use code point U+E000 stands for the aborting one, so a POSIX host can prove the behaviour on real files).
// Part 2 asks the real hook process on this host: on Windows with a worktree administration folder and a working directory that are named with the aborting character, elsewhere the same files are ordinary names.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import * as realFsp from 'node:fs/promises';
import * as realCp from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardFs } from '../../adapters/claude/hooks/lib/safefs.mjs';
import { buildTemplate, copyProject, runHook, rmSync, nodeHook } from './harness.mjs';

const BAD = '';
const aborts = (/** @type {string} */ t) => t.includes(BAD);
/** plain copies of the real modules, so the test never patches the real ones */
const fs = /** @type {Record<string, any>} */ ({ ...realFs });
const fsp = /** @type {Record<string, any>} */ ({ ...realFsp });
const cp = /** @type {Record<string, any>} */ ({ ...realCp });

test('safefs (injected predicate): a path that aborts does not exist, it is never listed, never written, never started; every other path is the platform\'s own', async () => {
  const dir = tempDir('safefs-');
  realFs.writeFileSync(join(dir, `a${BAD}.txt`), 'secret');
  realFs.writeFileSync(join(dir, 'b.txt'), 'plain');
  realFs.mkdirSync(join(dir, `d${BAD}`));
  const undo = guardFs({ fs, promises: fsp, cp }, aborts);
  try {
    assert.deepEqual(fs.readdirSync(dir).sort(), ['b.txt'], 'the name is not listed');
    assert.deepEqual(fs.readdirSync(dir, { withFileTypes: true }).map((/** @type {any} */ e) => e.name), ['b.txt']);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }), ['b.txt']);
    assert.equal(fs.readFileSync(join(dir, 'b.txt'), 'utf8'), 'plain');
    for (const f of ['readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'readdirSync', 'accessSync', 'readlinkSync', 'openSync']) {
      assert.throws(() => fs[f](join(dir, `a${BAD}.txt`)), (/** @type {any} */ e) => e.code === 'ENOENT', f);
    }
    assert.throws(() => fs.realpathSync.native(join(dir, `a${BAD}.txt`)), (/** @type {any} */ e) => e.code === 'ENOENT');
    assert.equal(fs.existsSync(join(dir, `a${BAD}.txt`)), false);
    assert.equal(fs.statSync(join(dir, `a${BAD}.txt`), { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(Buffer.from(join(dir, 'b.txt'))).toString(), 'plain');
    assert.throws(() => fs.readFileSync(Buffer.from(join(dir, `a${BAD}.txt`))), (/** @type {any} */ e) => e.code === 'ENOENT', 'a Buffer path');
    assert.throws(() => fs.readFileSync(pathToFileURL(join(dir, `a${BAD}.txt`))), (/** @type {any} */ e) => e.code === 'ENOENT', 'a URL path');
    assert.throws(() => fs.mkdirSync(join(dir, `new${BAD}`)), (/** @type {any} */ e) => e.code === 'ENOENT');
    assert.equal(realFs.existsSync(join(dir, `new${BAD}`)), false, 'nothing was created');
    assert.throws(() => fs.writeFileSync(join(dir, `w${BAD}`), 'x'), (/** @type {any} */ e) => e.code === 'ENOENT');
    assert.throws(() => fs.renameSync(join(dir, 'b.txt'), join(dir, `c${BAD}`)), (/** @type {any} */ e) => e.code === 'ENOENT', 'the second path of a rename');
    assert.equal(realFs.existsSync(join(dir, 'b.txt')), true);
    assert.throws(() => fs.createReadStream(join(dir, `a${BAD}.txt`)), (/** @type {any} */ e) => e.code === 'ENOENT');
    const d = fs.opendirSync(dir);
    const seen = []; for (let e = d.readSync(); e; e = d.readSync()) seen.push(e.name);
    d.closeSync();
    assert.deepEqual(seen.sort(), ['b.txt'], 'a directory handle skips the name');
    assert.throws(() => fs.opendirSync(join(dir, `d${BAD}`)), (/** @type {any} */ e) => e.code === 'ENOENT');
    // the promise API
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['b.txt']);
    await assert.rejects(() => fsp.readFile(join(dir, `a${BAD}.txt`)), (/** @type {any} */ e) => e.code === 'ENOENT');
    assert.equal(await fsp.readFile(join(dir, 'b.txt'), 'utf8'), 'plain');
    // the process module: the command, an argument, the working directory, an environment value
    assert.throws(() => cp.spawnSync(process.execPath, ['-e', '0'], { cwd: join(dir, `d${BAD}`) }), (/** @type {any} */ e) => e.code === 'ENOENT', 'cwd');
    assert.throws(() => cp.spawnSync(process.execPath, ['-e', '0', `x${BAD}`]), (/** @type {any} */ e) => e.code === 'ENOENT', 'argument');
    assert.throws(() => cp.execFileSync(process.execPath, ['-e', '0'], { env: { A: `x${BAD}` } }), (/** @type {any} */ e) => e.code === 'ENOENT', 'environment value');
    assert.throws(() => cp.execSync(`echo ${BAD}`), (/** @type {any} */ e) => e.code === 'ENOENT', 'command line');
    assert.equal(cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: dir, encoding: 'utf8' }).stdout, 'ok');
  } finally { undo(); }
  assert.equal(realFs.existsSync(join(dir, `a${BAD}.txt`)), true, 'the real module was never patched');
  assert.equal(fs.readFileSync(join(dir, `a${BAD}.txt`), 'utf8'), 'secret', 'the originals are back after undo');
});

// ---- Part 2: the real hook, a name built at run time (no event can carry it) ----

const ESC = String.raw`printf '\360\220\200\200'`; // U+10000 as bytes, in a form every sh knows
let template = ''; let base = ''; let dir = '';
before(() => { template = buildTemplate(); base = tempDir('hook-safefs-'); dir = copyProject(template, base); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** Run a sh snippet that makes names with U+10000 (never in this process's own memory: a Windows Node would abort on the path). @param {string} script */
const sh = (script) => spawnSync('sh', ['-c', `n=$(${ESC}); ${script}`, 'sh', dir, base], { encoding: 'utf8' });

test('safefs (hook process): a worktree administration folder named with U+10000 is not read, so a Bash verdict is a normal verdict and the hook does not abort', async () => {
  const who = { agent_type: 'proofline-implementer', agent_id: 'f1' };
  const ask = () => runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short' }, ...who }, { env: { AGENT_ROLE: 'implementer' } });
  const before0 = await ask();
  const made = sh('mkdir -p "$1/.git/worktrees/ev$n" && echo "$2/ev$n/.git" > "$1/.git/worktrees/ev$n/gitdir" && echo made');
  assert.equal(made.stdout.trim(), 'made', made.stderr);
  try {
    const r = await ask();
    assert.equal(r.status, before0.status, `the hook ended with ${r.status} (a Windows abort is 3221226505): ${r.stderr}`);
    assert.equal(r.stdout, before0.stdout, 'the verdict is the one without the folder');
    const second = await ask();
    assert.equal(second.stdout, before0.stdout, 'and it stays so on every later command');
  } finally { sh('rm -rf "$1/.git/worktrees/ev$n"'); }
});

test('safefs (hook process): a UserPromptSubmit event whose working directory is named with U+10000 is handled and the prompt is still captured', async () => {
  const made = sh('mkdir -p "$2/cw$n" && echo made');
  assert.equal(made.stdout.trim(), 'made', made.stderr);
  try {
    // the event is built as text (JSON.stringify of the character), never as a path in this process
    const event = `{"hook_event_name":"UserPromptSubmit","session_id":"sw1","prompt":"plan approved, thanks","cwd":${JSON.stringify(`${base.replaceAll('\\', '/')}/cw\u{10000}`)}}`;
    const r = await runHook('node', dir, 'prompt', event);
    assert.equal(r.status, 0, `the hook ended with ${r.status}: ${r.stderr}`);
    const cap = JSON.parse(realFs.readFileSync(join(dir, '.agents/local/prompts/sw1.json'), 'utf8'));
    assert.equal(cap.text, 'plan approved, thanks', 'the capture of the user message is on disk');
  } finally { sh('rm -rf "$2/cw$n"'); }
});

test('safefs (child process, the installed layer): importing safefs-install first makes a path with U+10000 not exist and a listing skip it, on this host', () => {
  const made = sh('mkdir -p "$2/li$n/x$n" && echo ok > "$2/li$n/y" && echo made');
  assert.equal(made.stdout.trim(), 'made', made.stderr);
  const code = `import('${pathToFileURL(join(nodeHook, '../lib/safefs-install.mjs')).href}').then(async () => {
    const fs = await import('node:fs'); const names = fs.readdirSync(process.argv[1] + '/' + fs.readdirSync(process.argv[1]).find((n) => n.startsWith('li')));
    console.log(JSON.stringify({ names, exists: fs.existsSync(process.argv[1] + '/li\\u{10000}/y'), stat: fs.statSync(process.argv[1] + '/q\\u{10FFFF}', { throwIfNoEntry: false }) ?? null }));
  });`;
  try {
    const r = spawnSync(process.execPath, ['-e', code, base], { encoding: 'utf8' });
    assert.equal(r.status, 0, `status ${r.status} (a Windows abort is 3221226505): ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.exists, process.platform !== 'win32', 'on Windows the name does not exist; elsewhere it is an ordinary name');
    assert.equal(out.stat, null);
    if (process.platform === 'win32') assert.deepEqual(out.names, ['y'], 'the listing does not return the name');
  } finally { sh('rm -rf "$2/li$n"'); }
});
