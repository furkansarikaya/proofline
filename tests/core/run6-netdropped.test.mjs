// @ts-check
// A220, user decision of 2026-11-07: (1) REQUESTS_CA_BUNDLE and GIT_SSL_CAINFO pass the allowlist with the SAME check as the other certificate variables, for
// gh, glab, az and the merge-proof git; every other proxy or certificate variable stays dropped; (2) `proofline doctor` lists the variables that were dropped,
// NAME and reason only, never a value (a proxy address may hold credentials).
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanToolEnv, droppedNetVars } from '../../control-plane/agents/scripts/core/platform.mjs';
import { repo } from './helpers.mjs';
import { launch } from '../lib/winpath.mjs';

/** A context as far as the platform module reads one. @param {string} cwd @param {Record<string, string>} [env] */
function ctxOf(cwd, env = {}) {
  const e = { PATH: '/usr/bin:/bin', ...env };
  return /** @type {any} */ ({ env: e, cwd, root: cwd, childEnv: () => ({ ...e, LC_ALL: 'C' }), sharedMain: () => cwd });
}
const work = tempDir('pf-netdrop-');
const CA = '/etc/passwd'; // a regular file outside every folder a model can write
const NEW_NAMES = ['REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO'];

test('the two new certificate variables pass the same check as SSL_CERT_FILE (also for the merge-proof git); a bad value is dropped; the others stay dropped', () => {
  const inTmp = path.join(work, 'ca.pem'); wf(inTmp, 'x');
  const linkToTmp = path.join(work, 'ca-link.pem'); symlinkSync(inTmp, linkToTmp);
  for (const name of NEW_NAMES) {
    for (const opt of [{}, { remote: true }]) {
      assert.equal(cleanToolEnv(ctxOf(work, { [name]: CA }), opt)[name], CA, `${name} with ${JSON.stringify(opt)}`);
    }
    for (const bad of [inTmp, linkToTmp, work, '/etc', 'etc/passwd', './passwd', '', '/nonexistent/ca.pem', `${CA}\n`, `${CA}\u0000`, '/dev/null', `/tmp/../${CA}`]) {
      assert.ok(!(name in cleanToolEnv(ctxOf(work, { [name]: bad }), { remote: true })), `${name} kept ${JSON.stringify(bad)}`);
      // the same verdict as the variable that was always allowed
      assert.equal(name in cleanToolEnv(ctxOf(work, { [name]: bad })), 'SSL_CERT_FILE' in cleanToolEnv(ctxOf(work, { SSL_CERT_FILE: bad })), `${name} and SSL_CERT_FILE disagree on ${JSON.stringify(bad)}`);
    }
    // a file inside the project root or the working directory is refused although it is no temporary folder
    assert.ok(!(name in cleanToolEnv({ ...ctxOf('/etc', { [name]: CA }), root: '/etc' })), `${name}: a file inside the project root`);
    assert.ok(!(name in cleanToolEnv({ ...ctxOf('/etc', { [name]: CA }), root: work })), `${name}: a file inside the working directory`);
  }
  const e = cleanToolEnv(ctxOf(work, {
    ALL_PROXY: 'http://other:1', all_proxy: 'http://other:1', SSL_CERT_DIR: '/etc', CURL_CA_BUNDLE: CA, GIT_SSL_CAPATH: '/etc', GIT_SSL_CERT: CA, GIT_SSL_KEY: CA, GIT_SSL_NO_VERIFY: '1',
    NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '--require /x', GIT_SSL_CAINFO: CA, REQUESTS_CA_BUNDLE: CA,
  }), { remote: true });
  assert.deepEqual(Object.keys(e).filter((k) => /PROXY|SSL|CERT|CA_|NODE_/.test(k)).sort(), ['GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE']);
});

test('droppedNetVars: the names that were dropped and a reason, never a value; what passes is not listed; the GIT_SSL_ family is read by a strict name pattern', () => {
  const SECRET = 'SECRETPASSWORD123';
  const ctx = ctxOf(work, {
    HTTPS_PROXY: `http://user:${SECRET}@proxy.corp.example:3128/a b`, https_proxy: 'http://proxy.corp.example:3128', HTTP_PROXY: `socks5://u:${SECRET}@p:1`, NO_PROXY: `a b ${SECRET}`,
    SSL_CERT_FILE: CA, NODE_EXTRA_CA_CERTS: `relative-${SECRET}.pem`, REQUESTS_CA_BUNDLE: path.join(work, `ca-${SECRET}.pem`), GIT_SSL_CAINFO: CA,
    ALL_PROXY: `http://${SECRET}@x:1`, SSL_CERT_DIR: '/etc', CURL_CA_BUNDLE: CA, GIT_SSL_NO_VERIFY: '1', GIT_SSL_CAPATH: '/etc', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    'GIT_SSL_X;touch pwned': '1', 'GIT_SSL_lower': '1', GIT_SSL_: '1', GH_HOST: 'evil.example',
  });
  const d = droppedNetVars(ctx);
  const names = d.map((x) => x.name).sort();
  assert.deepEqual(names, ['ALL_PROXY', 'CURL_CA_BUNDLE', 'GIT_SSL_CAPATH', 'GIT_SSL_NO_VERIFY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NO_PROXY', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_DIR']);
  assert.ok(!JSON.stringify(d).includes(SECRET), 'a value reached the list');
  assert.ok(!JSON.stringify(d).includes('pwned'), 'a name outside the pattern reached the list');
  for (const x of d) assert.match(x.reason, /^[A-Za-z0-9 ,.()_/:-]{1,200}$/, `${x.name}: the reason is plain text`);
  assert.deepEqual(droppedNetVars(ctxOf(work, { HTTPS_PROXY: 'http://proxy.corp.example:3128', SSL_CERT_FILE: CA, GIT_SSL_CAINFO: CA, PATH: '/usr/bin' })), [], 'good values are not listed');
  assert.deepEqual(droppedNetVars(ctxOf(work)), [], 'an environment without the variables lists nothing');
  // an empty value (`HTTPS_PROXY=`) is harmless: dropped as before, never listed
  const empty = Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO', 'ALL_PROXY', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'GIT_SSL_NO_VERIFY', 'NODE_TLS_REJECT_UNAUTHORIZED'].map((k) => [k, '']));
  assert.deepEqual(droppedNetVars(ctxOf(work, empty)), [], 'an empty value gives no warning');
  const ec = cleanToolEnv(ctxOf(work, empty), { remote: true });
  assert.ok(Object.keys(empty).every((k) => !(k in ec)), 'an empty value still does not reach the tools');
});

/** `bin/proofline` through `launch` (a Node script cannot be started by its path on Windows, A261). @param {string[]} args @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} o */
const plRun = (args, o) => { const l = launch(path.join(repo, 'bin', 'proofline'), args); return spawnSync(l.program, l.args, o); };

test('proofline doctor lists the dropped variables (names and reasons) and never a value; it is silent when nothing was dropped', () => {
  const root = tempDir('pl-doc-net-');
  try {
    spawnSync('git', ['init', '-q', root]);
    spawnSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i']);
    assert.equal(plRun(['init', '--yes', '--runtimes', 'claude'], { cwd: root, encoding: 'utf8' }).status, 0);
    const SECRET = 'SECRETPASSWORD123';
    const quiet = plRun(['doctor'], { cwd: root, encoding: 'utf8', env: withoutNet(process.env) });
    assert.doesNotMatch(quiet.stdout, /^WARN network:/m);
    const r = plRun(['doctor'], {
      cwd: root, encoding: 'utf8',
      env: { ...withoutNet(process.env), HTTPS_PROXY: `http://user:${SECRET}@proxy.corp.example:3128/a b`, ALL_PROXY: `http://${SECRET}@x:1`, GIT_SSL_NO_VERIFY: '1', GIT_SSL_CAINFO: `/nonexistent/${SECRET}.pem`, REQUESTS_CA_BUNDLE: CA, SSL_CERT_FILE: CA },
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('WARN network:')) ?? '';
    assert.ok(line !== '', r.stdout);
    for (const n of ['HTTPS_PROXY', 'ALL_PROXY', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO']) assert.ok(line.includes(`${n} (`), `${n} not listed: ${line}`);
    assert.ok(!/REQUESTS_CA_BUNDLE \(|SSL_CERT_FILE \(/.test(line), 'a variable that passes was listed as dropped');
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'a value was printed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** The environment without any proxy or certificate variable of the machine running the tests. @param {NodeJS.ProcessEnv} env */
function withoutNet(env) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/PROXY|_proxy$|^SSL_|CA_BUNDLE|CA_CERTS|^GIT_SSL_|^NODE_TLS/.test(k)) out[k] = v;
  return out;
}
