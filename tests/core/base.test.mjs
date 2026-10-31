// @ts-check
// proc.mjs (the only child_process importer, counted), errors, clock, hash, paths, context.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { now } from '../../control-plane/agents/scripts/core/clock.mjs';
import { Context, canonRole, validRole } from '../../control-plane/agents/scripts/core/context.mjs';
import { ProoflineError, fail } from '../../control-plane/agents/scripts/core/errors.mjs';
import { sha256, sha256File } from '../../control-plane/agents/scripts/core/hash.mjs';
import { normalizeInputPath, projectRoot, sharedRoot, toPosix } from '../../control-plane/agents/scripts/core/paths.mjs';
import * as proc from '../../control-plane/agents/scripts/core/proc.mjs';
import { scriptsDir } from './helpers.mjs';

describe('proc.mjs', () => {
  test('counts every child per program and logs to PROOFLINE_SPAWN_LOG', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-proc-'));
    try {
      proc.resetSpawnCounts();
      const log = path.join(dir, 'spawn.log');
      const env = { ...process.env, PROOFLINE_SPAWN_LOG: log };
      const r = proc.run('sh', ['-c', 'printf out; printf err >&2; exit 3'], { env });
      assert.equal(r.status, 3); assert.equal(r.stdout.toString(), 'out'); assert.equal(r.stderr.toString(), 'err');
      proc.run('sh', ['-c', 'exit 0'], { env });
      assert.deepEqual(proc.spawnCounts(), { total: 2, byProgram: { sh: 2 } });
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^sh\t\d+$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('a program that is not found gives 127, input reaches stdin, a signal gives 128 + n, runUserCommand uses sh -c', async () => {
    assert.equal(proc.run('no-such-program-xyz', []).status, 127);
    assert.equal(proc.run('cat', [], { input: 'hello' }).stdout.toString(), 'hello');
    assert.equal(proc.run('sh', ['-c', 'kill -TERM $$']).status, 143);
    assert.equal(proc.runUserCommand('echo x | tr a-z A-Z').stdout.toString(), 'X\n');
    const a = await proc.runAsync('sh', ['-c', 'printf hi; exit 4']);
    assert.equal(a.status, 4); assert.equal(a.stdout.toString(), 'hi');
    assert.equal((await proc.runAsync('no-such-program-xyz', [])).status, 127);
  });
  test('it is the only module of the core, the commands and the entry that imports node:child_process', () => {
    /** @param {string} dir @returns {string[]} */
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.mjs') ? [path.join(dir, e.name)] : []));
    const files = walk(scriptsDir);
    assert.ok(files.length >= 10);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      assert.ok(text.startsWith('// @ts-check') || text.startsWith('// @ts-check\n'), `${f} starts with // @ts-check`);
      const imports = /from ['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)|import\(['"](node:)?child_process['"]\)/.test(text);
      assert.equal(imports, path.basename(f) === 'proc.mjs', f);
    }
  });
});

describe('small modules', () => {
  test('ProoflineError and fail carry the shell message and exit status 1', () => {
    assert.throws(() => fail('boom'), (e) => e instanceof ProoflineError && e.message === 'boom' && e.exitCode === 1);
  });
  test('now: one reading, ts and epoch name the same second', () => {
    const t = now();
    assert.match(t.iso, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(Date.parse(t.iso) / 1000, t.epoch);
  });
  test('sha256 of bytes, of a byte string, of a file; an unreadable file gives the empty string', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256('\u00c3\u00a9'), sha256(Buffer.from('\u00e9', 'utf8')));
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-hash-'));
    try {
      writeFileSync(path.join(dir, 'f'), 'abc');
      assert.equal(sha256File(path.join(dir, 'f')), sha256('abc'));
      assert.equal(sha256File(path.join(dir, 'missing')), '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('roles: aliases and the valid set', () => {
    assert.equal(canonRole('full_lifecycle'), 'lead'); assert.equal(canonRole('independent_qa'), 'qa'); assert.equal(canonRole('x'), 'x');
    assert.ok(validRole('lead')); assert.ok(!validRole('independent_qa')); assert.ok(!validRole('')); assert.ok(!validRole('Lead'));
  });
});

describe('paths.mjs', () => {
  test('Windows input paths, tested with the Windows rules on every platform', () => {
    assert.equal(normalizeInputPath('C:\\Users\\x\\proj'), 'C:/Users/x/proj');
    assert.equal(normalizeInputPath('c:/a/../b'), 'C:/b');
    assert.equal(normalizeInputPath('/c/Users/x', 'win32'), 'C:/Users/x');
    assert.equal(normalizeInputPath('/c/Users/x', 'linux'), '/c/Users/x');
    assert.equal(normalizeInputPath('/usr/bin'), '/usr/bin');
    assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  });
  test('the project root is two folders above the script, in the working directory\'s own spelling', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-root-'));
    try {
      mkdirSync(path.join(dir, 'real', '.agents', 'scripts'), { recursive: true });
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
      const real = path.join(dir, 'real');
      const script = path.join(real, '.agents', 'scripts', 'agent.sh');
      assert.equal(projectRoot(script, {}, real), real);
      // PWD names the working directory through a link; the script was given relative to it
      assert.equal(projectRoot(script, { PWD: path.join(dir, 'link') }, real), path.join(dir, 'link'));
      // the script path is given in the link's spelling: kept
      const viaLink = path.join(dir, 'link', '.agents', 'scripts', 'agent.sh');
      assert.equal(projectRoot(viaLink, { PWD: path.join(dir, 'link') }, real), path.join(dir, 'link'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('sharedRoot is the root outside a linked worktree', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-shared-'));
    try { assert.equal(sharedRoot(dir, process.env), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('context.mjs', () => {
  test('output is collected in order and written on flush; a discarded command wrote nothing', () => {
    /** @type {string[]} */ const seen = [];
    const io = { env: {}, cwd: '/x', stdout: { write: (/** @type {Buffer} */ b) => seen.push(`o:${b}`) }, stderr: { write: (/** @type {Buffer} */ b) => seen.push(`e:${b}`) } };
    const ctx = new Context(io, '/x/.agents/scripts/agent.sh');
    assert.equal(ctx.root, '/x'); assert.equal(ctx.configFile, '/x/.agents/config.yaml'); assert.equal(ctx.role, 'lead');
    ctx.out('a'); ctx.err('b'); ctx.out('c');
    assert.deepEqual(seen, []);
    ctx.flush();
    assert.deepEqual(seen, ['o:a', 'e:b', 'o:c']);
    ctx.out('dropped'); ctx.discard(); ctx.flush();
    assert.equal(seen.length, 3);
  });
  test('the role comes from AGENT_ROLE, empty means lead, aliases are canonical', () => {
    const mk = (/** @type {Record<string,string>} */ env) => new Context({ env, cwd: '/x', stdout: { write() {} }, stderr: { write() {} } }, '/x/.agents/scripts/agent.sh');
    assert.equal(mk({}).role, 'lead'); assert.equal(mk({ AGENT_ROLE: '' }).role, 'lead'); assert.equal(mk({ AGENT_ROLE: 'independent_reviewer' }).role, 'reviewer');
  });
});

describe('fail closed', () => {
  test('an unexpected exception in a moved command prints the error and exits 70; it is not answered by the shell code', async () => {
    const { run } = await import('../../control-plane/agents/scripts/proofline-core.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'pl-fc-'));
    try {
      mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
      /** @type {Buffer[]} */ const err = [];
      proc.resetSpawnCounts();
      const io = { env: { PATH: process.env.PATH ?? '' }, cwd: root, scriptPath: path.join(root, '.agents', 'scripts', 'agent.sh'),
        stdout: { write() { throw new Error('boom'); } }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) } };
      assert.equal(run(['role'], io), 70);
      assert.match(Buffer.concat(err).toString(), /^proofline: internal error in role: Error: boom/);
      assert.equal(proc.spawnCounts().total, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
