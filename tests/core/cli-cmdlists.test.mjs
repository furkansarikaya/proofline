// @ts-check
// commands.build|test|lint as a list (A176; the former scenario sc_cmd_lists of tests/cli/cli-test.sh): the build record, config-check, discovery through `proofline init` and
// the idempotence of init and upgrade on a list. The project is the one the real `proofline init` makes.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cfgSet } from '../../control-plane/agents/scripts/core/configset.mjs';
import { cfgv, sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const base = sb.copy('cmdl');
const setc = (/** @type {string} */ d, /** @type {string} */ key, /** @type {string} */ value) => assert.ok(cfgSet(`${d}/.agents/config.yaml`, `commands.${key}`, value));
/** The record of `agent.sh build-record BR run` and its exit status. @param {string} d */
function br(d) {
  mkdirSync(`${d}/.agents/runs/BR`, { recursive: true });
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'build-record', 'BR', 'run'], { cwd: d, env: sb.env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** The `exit:` line after the step line `LABEL: ` of a record. @param {string} out @param {string} label */
function stepExit(out, label) {
  let f = false;
  for (const l of out.split('\n')) { if (l.startsWith(`${label}: `)) { f = true; continue; } if (f && l.startsWith('exit: ')) return l.slice(6); }
  return '';
}
const NL = '\n';

test('a scalar command records as before: plain labels, no list summary, steps build and test', () => {
  setc(base, 'build', 'echo b1; echo built-line'); setc(base, 'test', 'echo t1');
  const { code, out } = br(base);
  assert.equal(code, 0, out);
  assert.ok(out.includes('build: echo b1; echo built-line') && out.includes('test: echo t1'));
  assert.equal(stepExit(out, 'build'), '0');
  assert.equal(stepExit(out, 'test'), '0');
  assert.ok(out.includes('  built-line'));
  assert.ok(!out.includes('[') && !out.includes('failed:') && !out.includes('all commands passed'));
  const key = /^key: (.*)$/m.exec(out)?.[1];
  assert.equal(readFileSync(`${base}/.agents/local/builds/${key}/steps`, 'utf8').replace(/\n$/, '').replace(/\n/g, ',').replace(/\t/g, ':'), 'build:build,test:test');
});

test('a list whose second build command fails: its own exit and tail, the first OK, a failed: line names it, the next key is not run', () => {
  setc(base, 'build', `echo first-ok${NL}sh -c 'echo second-out; exit 4'`); setc(base, 'test', 'echo never-run');
  const { code, out } = br(base);
  assert.equal(code, 1, out);
  assert.equal(stepExit(out, 'build[1/2]'), '0');
  assert.equal(stepExit(out, 'build[2/2]'), '4');
  assert.ok(out.includes('  second-out') && out.includes('failed: build[2/2] (exit 4)'));
  assert.ok(!out.includes('never-run') && !out.includes('failed: build[1/2]'));
});

test('a failing test in a list does not stop the other tests; a list in which every command passes says so', () => {
  setc(base, 'build', 'echo b'); setc(base, 'test', `sh -c 'echo broke; exit 1'${NL}echo other-test-ran`);
  let { code, out } = br(base);
  assert.equal(code, 1, out);
  assert.equal(stepExit(out, 'test[1/2]'), '1');
  assert.equal(stepExit(out, 'test[2/2]'), '0');
  assert.ok(out.includes('  other-test-ran') && out.includes('failed: test[1/2] (exit 1)'));
  setc(base, 'test', `echo one${NL}echo two`);
  ({ code, out } = br(base));
  assert.equal(code, 0, out);
  assert.ok(out.includes('all commands passed'));
});

test('config-check: a list of two commands is valid; a value plus a list, an empty item, a duplicate, an inline list and a list under install or secret_scan are rejected', () => {
  const pristine = readFileSync(`${base}/.agents/config.yaml`, 'utf8');
  /** @param {string} key @param {string} text */
  const withKey = (key, text) => { const lines = pristine.split('\n').flatMap((l) => (l.startsWith(`  ${key}:`) ? text.split('|') : [l])); writeFileSync(`${sb.T}/cfg.try`, lines.join('\n')); };
  const cc = () => spawnSync('sh', ['.agents/scripts/agent.sh', 'config-check', `${sb.T}/cfg.try`], { cwd: base, env: sb.env, encoding: 'utf8' });
  withKey('test', '  test:|    - a|    - b');
  let r = cc();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  /** @param {string} key @param {string} text @param {string} msg */
  const bad = (key, text, msg) => { withKey(key, text); const x = cc(); assert.notEqual(x.status, 0, msg); assert.ok((x.stdout + x.stderr).includes(msg), `${msg}\n${x.stdout}${x.stderr}`); };
  bad('build', '  build: x|    - y', 'commands.build');
  bad('build', '  build:|    - a|    -', 'empty command in the commands.build list');
  bad('lint', '  lint:|    - a|    - a', 'duplicate command in the commands.lint list');
  bad('test', '  test: [a, b]', 'inline list');
  bad('install', '  install:|    - a', 'commands.install takes one command, not a list');
  bad('secret_scan', '  secret_scan:|    - a', 'commands.secret_scan takes one command, not a list');
  r = cc();
  assert.ok(r.status !== 0);
});

test('discovery through init: a root .slnx and a nested npm app become a list of two, written as a block list; init and upgrade again leave the config byte-identical', () => {
  const poly = sb.mkrepo('poly');
  writeFileSync(`${poly}/App.slnx`, ''); mkdirSync(`${poly}/web`);
  writeFileSync(`${poly}/web/package.json`, '{"scripts":{"build":"b","test":"t"}}\n');
  const r = sb.pl(poly, ['init', '--yes', '--runtimes', 'claude']);
  assert.equal(r.status, 0, r.text);
  assert.equal(cfgv(poly, 'commands.build'), `dotnet build App.slnx${NL}npm --prefix web run build`);
  assert.equal(cfgv(poly, 'commands.test'), `dotnet test App.slnx${NL}npm --prefix web test`);
  const cfg = readFileSync(`${poly}/.agents/config.yaml`, 'utf8');
  assert.ok(/^ {2}build:$/m.test(cfg) && /^ {4}- dotnet build App\.slnx$/m.test(cfg));
  assert.equal(spawnSync('sh', ['.agents/scripts/agent.sh', 'config-check'], { cwd: poly, env: sb.env }).status, 0);
  sb.pl(poly, ['init', '--yes', '--runtimes', 'claude']); sb.pl(poly, ['upgrade']);
  assert.equal(readFileSync(`${poly}/.agents/config.yaml`, 'utf8'), cfg);
});

test('two ambiguous solutions and an npm app: only the npm command is written, and init names .NET as the ecosystem it proposed nothing for', () => {
  const amb = sb.mkrepo('amb');
  writeFileSync(`${amb}/App.sln`, ''); writeFileSync(`${amb}/Other.sln`, ''); mkdirSync(`${amb}/web`);
  writeFileSync(`${amb}/web/package.json`, '{"scripts":{"build":"b","test":"t"}}\n');
  const r = sb.pl(amb, ['init', '--yes', '--runtimes', 'claude']);
  assert.equal(r.status, 0, r.text);
  assert.equal(cfgv(amb, 'commands.build'), 'npm --prefix web run build');
  assert.ok(r.out.includes('no command proposed for .NET'), r.out);
});
