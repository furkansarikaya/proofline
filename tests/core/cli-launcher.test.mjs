// @ts-check
// bin/proofline is a launcher (A233, ADR 0001 section 9): a shebang and one dynamic import of the Node module that holds the CLI; bin/lib is gone. The CLI names that write files
// or run programs are not reachable through agent.sh (tests/core/cli-agent-path.test.mjs); the installer is not a `cli` name at all.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLI_COMMANDS } from '../../control-plane/agents/scripts/core/commands/cli.mjs';
import { PL, sandbox } from './frontend-lib.mjs';
import { repo } from './helpers.mjs';

const sb = sandbox();

test('bin/proofline is executable and holds a shebang, comments and the one dynamic import of the CLI module, nothing else', () => {
  // POSIX: the file's execute bit. Windows (A266): NTFS has none (Node reports 0666), so the mode the repository committed is the shipped execute bit (100755 in the index of the checkout)
  if (process.platform === 'win32') assert.match(spawnSync('git', ['-C', repo, 'ls-files', '-s', '--', 'bin/proofline'], { encoding: 'utf8' }).stdout, /^100755 /, 'not executable in the index');
  else assert.ok(statSync(PL).mode & 0o100, 'not executable');
  const lines = readFileSync(PL, 'utf8').split('\n').filter((l) => l !== '');
  assert.equal(lines[0], '#!/usr/bin/env node');
  const code = lines.filter((l) => !l.startsWith('#') && !l.startsWith('//'));
  assert.equal(code.length, 1, code.join('\n'));
  assert.match(code[0], /^import\('\.\.\/control-plane\/agents\/scripts\/core\/proflinecli\.mjs'\)\.then\(\(m\) => \{ process\.exitCode = m\.main\(process\.argv\.slice\(2\)\); \}\);$/);
  assert.ok(lines.length <= 6);
});

test('bin/lib is gone: no shell library of the CLI is left', () => {
  assert.ok(!existsSync(`${repo}/bin/lib`));
});

test('neither the installer nor the front end is a name of the `cli` family that agent.sh can reach', () => {
  for (const n of ['init', 'upgrade', 'install', 'clean', 'status', 'main']) assert.ok(!Object.hasOwn(CLI_COMMANDS, n), n);
});

test('the CLI module exports main and the version, and nothing starts when it is imported', () => {
  const r = spawnSync('node', ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(`${repo}/control-plane/agents/scripts/core/proflinecli.mjs`).href)}); console.log(typeof m.main, m.PROOFLINE_VERSION);`], { encoding: 'utf8' });
  assert.match(r.stdout, /^function \d+\.\d+\.\d+\n$/, r.stderr);
});

test('an older Node than 22.13 stops with the status 127 and the message of the core\'s Node check (a fake version, no real old node needed)', () => {
  const r = spawnSync('node', ['--input-type=module', '-e', `Object.defineProperty(process.versions, 'node', { value: '20.1.0' }); await import(${JSON.stringify(pathToFileURL(`${repo}/control-plane/agents/scripts/core/node-check.mjs`).href)});   // a file URL: a Windows drive path is no module specifier`], { encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /Node 22\.13 or newer is required \(found 20\.1\.0\)/);
});

test('main runs in process through injected sinks: version, help, and an unknown command with its status and next step', async () => {
  const { main, PROOFLINE_VERSION } = await import('../../control-plane/agents/scripts/core/proflinecli.mjs');
  const d = sb.mkrepo('inproc');
  /** @param {string[]} argv */
  const run = (argv) => {
    /** @type {string[]} */ const out = []; /** @type {string[]} */ const err = [];
    const code = main(argv, { stdout: { write: (b) => out.push(Buffer.from(b).toString('latin1')) }, stderr: { write: (b) => err.push(Buffer.from(b).toString('latin1')) }, cwd: d, env: sb.env, interactive: false });
    return { code, out: out.join(''), err: err.join('') };
  };
  assert.deepEqual(run(['version']), { code: 0, out: `proofline ${PROOFLINE_VERSION}\n`, err: '' });
  assert.equal(run(['help']).out.split('\n')[0], 'proofline: a deterministic engineering team for coding agents');
  const u = run(['nonsense']);
  assert.equal(u.code, 1);
  assert.ok(u.err.endsWith('proofline: unknown command: nonsense\nNext step: proofline help\n'), u.err.slice(-100));
});
