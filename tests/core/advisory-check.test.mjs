// @ts-check
// `agent.sh advisory-check` (A373, issue 338 C10): the control plane, not the SECURITY role, asks the registry's advisory service ONCE about the lock file when the diff touches dependencies.
// No npm and no project file runs or is read but the lock (parsed as JSON): the request is a bulk POST of names and versions to the fixed url of the control plane's own ecosystems.json. The HTTP
// function is the seam `io.http`: every test here injects a fake, so nothing touches the network. Tried here: hostile lock entries, batch splitting and caps, every failure of the request
// (redirect, timeout, non-200, oversized, malformed), hostile answers, a second request for the same lock, the retry and per-run caps counted in ledger rows, a role that runs the command.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, cleanEnv } from '../lib/harness.mjs';
import { run as coreRun } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { BATCH, MAX_ATTEMPTS, MAX_LOCK, MAX_PACKAGES, MAX_RESPONSE, MAX_SETS, buildBatches, httpPost, lockPackages, parseNpmBulk, tooManySkipped } from '../../control-plane/agents/scripts/core/advisory.mjs';
import { frozen, implement, rrun, sedFile, wr } from './risk-s2-lib.mjs';

const REC = '.agents/runs/LC/ADVISORY_CHECK.json';
const URL_OWN = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const ADV = [{ id: 1106913, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'SECRET-TITLE Command Injection', severity: 'high', vulnerable_versions: '<4.17.21', cwe: ['CWE-77'], cvss: { score: 7.2, vectorString: 'CVSS:3.1/X' }, leak: 'RAW-LEAK' }];

/** @param {Record<string, unknown>} [packages] extra `packages` entries @returns {string} */
function lockText(packages = {}) {
  return `${JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app', dependencies: { lodash: '^4' } }, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/@scope/pkg': { version: '1.0.0-rc.1' }, ...packages } })}\n`;
}
/** @typedef {import('../../control-plane/agents/scripts/core/advisory.mjs').HttpRequest} Req */
/**
 * A fake HTTP function that logs every request and answers `answer` (a function of the request and its index, or a fixed result).
 * @param {unknown} [answer] @returns {((r: Req) => any) & { calls: Req[] }}
 */
function fake(answer = { status: 200, body: JSON.stringify({ lodash: ADV }) }) {
  /** @type {Req[]} */ const calls = [];
  const f = (/** @type {Req} */ r) => { calls.push(r); const a = typeof answer === 'function' ? answer(r, calls.length - 1) : answer; if (a instanceof Error) throw a; return a; };
  return Object.assign(f, { calls });
}
/** @param {string} d */
const record = (d) => JSON.parse(readFileSync(path.join(d, REC), 'utf8'));
/** @param {string} d */
const ledgerRows = (d) => readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8').split('\n').filter((l) => / event=advisory-check /.test(l));

/** A frozen, implemented run whose diff touches package.json, with the lock file at the root; `on` turns the setting on before the freeze. @param {{ on?: boolean, lock?: string | false, files?: string }} [o] */
function run(o = {}) {
  const d = rrun('COMPLEX', o.files ?? 'package.json src/a.js');
  if (o.on !== false) sedFile(d, '.agents/config.yaml', /^ {2}advisory_check:.*$/, '  advisory_check: on');
  frozen(d);
  implement(d, (o.files ?? 'package.json').split(' ')[0], '{ "name": "x" }');
  if (o.lock !== false) wr(d, 'package-lock.json', o.lock ?? lockText());
  return d;
}
/** `agent.sh advisory-check LC` in this process with the fake as `io.http`. @param {string} d @param {(r: Req) => any} http @param {Record<string, string>} [env] */
function check(d, http, env = {}) {
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const before = process.cwd();
  let status;
  try {
    process.chdir(d);
    status = coreRun(['advisory-check', 'LC'], { env: /** @type {NodeJS.ProcessEnv} */ (cleanEnv(env)), cwd: d, stdout: { write: (b) => out.push(b) }, stderr: { write: (b) => err.push(b) }, scriptPath: path.join(d, '.agents/scripts/agent.sh'), http });
  } finally { process.chdir(before); }
  const o = Buffer.concat(out).toString('utf8'); const e = Buffer.concat(err).toString('utf8');
  return { status, out: o, err: e, text: o + e };
}

test('off by default: the record says the check is not enabled and no request is made', () => {
  const http = fake(); const d = run({ on: false });
  const r = check(d, http);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /not_run: advisory check not enabled: set security\.advisory_check: on/);
  assert.equal(record(d).status, 'not_run');
  assert.equal(http.calls.length, 0);
});

test('on: one POST to the fixed url, only valid lock entries in the body; the record holds ids, packages, severities, counts and bounded strings, never the raw answer', () => {
  const http = fake();
  const hostile = {
    'node_modules/__proto__': { version: '1.0.0' }, 'node_modules/../x': { version: '1.0.0' }, 'node_modules/git+https://evil.invalid/x.git': { version: '1.0.0' },
    'node_modules/linked': { version: '1.0.0', link: true }, 'node_modules/nover': { resolved: 'https://evil.invalid/x.tgz' }, 'node_modules/Upper': { version: '1.0.0' },
    'node_modules/badver': { version: 'latest' }, 'node_modules/spec': { version: 'git+https://evil.invalid/x.git' }, 'node_modules/ok/node_modules/nested': { version: '2.0.0' },
    'packages/workspace': { version: '1.0.0' }, 'node_modules/withdeps': { version: '3.0.0', dependencies: { x: 'git+https://evil.invalid/y.git' }, resolved: 'git+https://evil.invalid/w.git#abc' },
  };
  const d = run({ lock: lockText(hostile) });
  const r = check(d, http, { HTTPS_PROXY: 'http://proxy.invalid:3128', NODE_AUTH_TOKEN: 'MYSECRET-token' });
  assert.equal(r.status, 0, r.text);
  assert.equal(http.calls.length, 1);
  const req = http.calls[0];
  assert.deepEqual(Object.keys(req).sort(), ['body', 'maxBytes', 'timeoutMs', 'url']);
  assert.equal(req.url, URL_OWN);
  assert.equal(req.timeoutMs, 30000);
  assert.deepEqual(JSON.parse(req.body), { '@scope/pkg': ['1.0.0-rc.1'], Upper: ['1.0.0'], lodash: ['4.17.20'], nested: ['2.0.0'] });
  assert.ok(!/evil\.invalid|MYSECRET|proxy\.invalid|__proto__|\.\.\//.test(req.body), req.body);
  const rec = record(d);
  assert.equal(rec.status, 'partial', 'nine of thirteen entries were not checked: never `measured`');
  assert.equal(rec.requests, 1);
  assert.equal(rec.packages, 4);
  assert.equal(rec.skipped, 9); assert.equal(rec.total, 13);
  assert.deepEqual(rec.skipped_reasons, { invalid: 5, 'non-registry': 3, 'outside-node_modules': 1 });
  assert.match(r.out, /PARTIAL, not a clean check by POST .*skipped 9 of 13 entries \(invalid 5, non-registry 3, outside-node_modules 1\)/);
  assert.equal(rec.http_requests, 1);
  assert.deepEqual(rec.counts, { critical: 0, high: 1, moderate: 0, low: 0, info: 0, unknown: 0 });
  assert.deepEqual(rec.advisories, [{ id: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', severity: 'high', affects: ['lodash'], title: 'SECRET-TITLE Command Injection', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', vulnerable_versions: '<4.17.21' }]);
  const text = readFileSync(path.join(d, REC), 'utf8');
  assert.ok(!/RAW-LEAK|CWE-77|CVSS|vectorString|MYSECRET|evil\.invalid/.test(text), 'the raw answer or a secret reached the record');
  assert.match(rec.sent, /^the package names and versions of package-lock\.json \(4 packages, 4 versions\) to registry\.npmjs\.org over HTTPS, 1 POST request$/);
});

test('lockPackages: the real name of an alias is asked about, non-registry entries are skipped with their reason, legacy names pass, hostile ones are skipped, duplicates merge', () => {
  const reg = (/** @type {string} */ n, /** @type {string} */ v) => `https://registry.npmjs.org/${n}/-/${n.split('/').pop()}-${v}.tgz`;
  const p = /** @type {any} */ (lockPackages(lockText({
    'node_modules/foo': { name: 'lodash', version: '4.17.0', resolved: reg('lodash', '4.17.0') }, 'node_modules/bad-alias': { name: '../x', version: '1.0.0' }, 'node_modules/num-alias': { name: 5, version: '1.0.0' },
    'node_modules/JSONStream': { version: '1.3.5', resolved: reg('JSONStream', '1.3.5') }, 'node_modules/a/node_modules/lodash': { version: '3.0.0' }, 'node_modules/a/node_modules/@s/t': { version: '0.0.1' },
    'node_modules/@s/t/x': { version: '1.0.0' }, 'node_modules/.hidden': { version: '1.0.0' }, 'node_modules/_u': { version: '1.0.0' }, 'node_modules/x y': { version: '1.0.0' },
    ['node_modules/a'.padEnd(300, 'a')]: { version: '1.0.0' }, 'node_modules/v': { version: '01.0.0' }, 'node_modules/w': { version: `1.0.0-${'a'.repeat(70)}` },
    'node_modules/gitdep': { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/r.git#abc' }, 'node_modules/filedep': { version: '1.0.0', resolved: 'file:../x' }, 'node_modules/httpdep': { version: '1.0.0', resolved: 'http://evil.invalid/x.tgz' },
    'node_modules/tarball': { version: '1.0.0', resolved: 'https://codeload.github.com/o/r/tar.gz/abc' }, 'node_modules/lnk': { version: '1.0.0', link: true }, 'node_modules/novers': {},
  })));
  assert.deepEqual([...p.packages.entries()], [['@s/t', ['0.0.1']], ['@scope/pkg', ['1.0.0-rc.1']], ['JSONStream', ['1.3.5']], ['lodash', ['3.0.0', '4.17.0', '4.17.20']]]);
  assert.ok(!p.packages.has('foo'), 'the alias name is never asked about');
  assert.equal(p.reasons.invalid, 9); assert.equal(p.reasons['non-registry'], 5); assert.equal(p.reasons['no-version'], 1);
  assert.equal(p.skipped, 15); assert.equal(p.total, 21);
  for (const bad of ['{', '[]', 'null', '{"lockfileVersion":1,"dependencies":{}}', '{"packages":[]}']) assert.ok('error' in /** @type {any} */ (lockPackages(bad)), bad);
  assert.equal(tooManySkipped(1, 31), false); assert.equal(tooManySkipped(2, 31), true); assert.equal(tooManySkipped(25, 1000), false); assert.equal(tooManySkipped(26, 1000), true);
});

test('batches: at most 500 names a request, every name once, a body under 2 MiB, at most 10 requests; more is refused with a note', () => {
  const many = (/** @type {number} */ n) => new Map(Array.from({ length: n }, (_, i) => [`p${String(i).padStart(5, '0')}`, ['1.0.0']]));
  const b = /** @type {any} */ (buildBatches(many(1203), 1203));
  assert.equal(b.bodies.length, 3);
  const sets = b.bodies.map((/** @type {string} */ x) => Object.keys(JSON.parse(x)));
  assert.deepEqual(sets.map((/** @type {string[]} */ s) => s.length), [BATCH, BATCH, 203]);
  assert.equal(new Set(sets.flat()).size, 1203);
  assert.equal(/** @type {any} */ (buildBatches(many(MAX_PACKAGES), MAX_PACKAGES)).bodies.length, 10);
  assert.match(/** @type {any} */ (buildBatches(many(MAX_PACKAGES + 1), MAX_PACKAGES + 1)).error, /more than 5000 packages/);
  const wide = new Map([['x', Array.from({ length: 10 }, (_, i) => `1.0.${i}`)]]);
  assert.ok('bodies' in /** @type {any} */ (buildBatches(wide, 10)));
});

test('a lock of 1200 packages is sent in three requests; one that fails makes the whole set failed and records no advisory', () => {
  /** @type {Record<string, unknown>} */ const pk = {};
  for (let i = 0; i < 1200; i++) pk[`node_modules/p${i}`] = { version: '1.0.0' };
  let http = fake({ status: 200, body: '{}' }); let d = run({ lock: lockText(pk) });
  check(d, http);
  assert.deepEqual(http.calls.map((c) => Object.keys(JSON.parse(c.body)).length), [500, 500, 202]);
  assert.equal(record(d).http_requests, 3);
  http = fake((_r, i) => (i === 1 ? { status: 503, body: 'x' } : { status: 200, body: JSON.stringify({ p1: ADV }) })); d = run({ lock: lockText(pk) });
  check(d, http);
  assert.equal(http.calls.length, 2);
  const rec = record(d);
  assert.equal(rec.status, 'failed');
  assert.match(rec.reason, /HTTP 503 \(request 2 of 3\)/);
  assert.equal(rec.advisories, undefined);
});

test('a lock beyond the caps is refused with a note and no request: more than 5000 packages, larger than 16 MiB, a link, not JSON, no packages map', () => {
  /** @type {Record<string, unknown>} */ const pk = {};
  for (let i = 0; i <= MAX_PACKAGES; i++) pk[`node_modules/p${i}`] = { version: '1.0.0' };
  const http = fake();
  let d = run({ lock: lockText(pk) });
  assert.match(check(d, http).out, /not_run: the lock file lists more than 5000 packages/);
  d = run({ lock: false });
  writeFileSync(path.join(d, 'package-lock.json'), Buffer.alloc(MAX_LOCK + 1, 0x20));
  assert.match(check(d, http).out, /not_run: package-lock\.json is larger than 16 MiB/);
  d = run({ lock: false });
  wr(d, 'real.json', lockText()); symlinkSync(path.join(d, 'real.json'), path.join(d, 'package-lock.json'));
  assert.match(check(d, http).out, /not_run: package-lock\.json is not a regular file \(a link is never followed\): the lock is not read/);
  assert.match(check(run({ lock: '{ not json' }), http).out, /not_run: the lock file is not valid JSON/);
  assert.match(check(run({ lock: '{"lockfileVersion":1,"dependencies":{}}' }), http).out, /not_run: the lock file has no `packages` map/);
  assert.equal(http.calls.length, 0);
});

test('every failure of the request is a failed record with a reason and nothing recorded as clean', () => {
  /** @type {Array<[unknown, RegExp]>} */
  const cases = [
    [{ error: 'redirect' }, /network error: the service answered with a redirect, which is refused/], [{ error: 'timeout' }, /network error: no answer within 30 seconds/],
    [{ error: 'network' }, /network error: the request could not be made .*proxy/], [{ error: 'too_large' }, /larger than 8 MiB/], [{ error: 'scheme' }, /network error/], [{ error: 'unsupported' }, /^advisory check is not supported on Windows \(not run\)$/],
    [{ status: 302, body: '' }, /HTTP 302/], [{ status: 429, body: '{}' }, /HTTP 429/], [{ status: 500, body: '{}' }, /HTTP 500/],
    [{ status: 200, body: Buffer.alloc(MAX_RESPONSE + 1, 0x20) }, /larger than 8 MiB/], [{ status: 200, body: '<html>proxy login</html>' }, /not the JSON/], [{ status: 200, body: '[]' }, /not the JSON/],
    [{ status: 200, body: 'null' }, /not the JSON/], [new Error('boom with a secret'), /network error/],
  ];
  for (const [answer, want] of cases) {
    const http = fake(answer); const d = run();
    const r = check(d, http);
    const rec = record(d);
    assert.equal(rec.status, 'failed', JSON.stringify(answer));
    assert.match(rec.reason, want);
    assert.match(r.out, /^advisory-check: failed: /);
    assert.equal(rec.advisories, undefined); assert.equal(rec.counts, undefined);
    assert.ok(!/secret/.test(JSON.stringify(rec)));
    assert.equal(http.calls.length, 1);
  }
});

test('a hostile answer is reduced: severities mapped, urls filtered, titles one bounded line, unasked packages and __proto__ ignored, other fields dropped', () => {
  const answer = JSON.parse(`{
    "lodash": [
      {"id": 1, "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", "title": "line one\\nline two\\u202e\\u0007${'x'.repeat(300)}", "severity": "CRITICAL", "vulnerable_versions": "<1.0.0\\n>2"},
      {"id": 2, "url": "https://nvd.nist.gov/vuln/detail/CVE-2024-0001", "title": "t", "severity": "moderate"},
      {"id": 3, "url": "https://evil.invalid/advisories/GHSA-xxxx-yyyy-zzzz", "title": "t", "severity": "catastrophic"},
      {"id": 4, "url": "https://github.com/advisories/GHSA-eeee-ffff-gggg\\nHost: x", "severity": "low"},
      {"id": "str-5", "severity": "info"}, {"id": {"a": 1}, "severity": "high"}, {"severity": "high"}, null, 7, "x"
    ],
    "@scope/pkg": {"not": "a list"},
    "unasked": [{"id": 9, "severity": "critical"}],
    "__proto__": [{"id": 10, "severity": "critical"}],
    "constructor": [{"id": 11, "severity": "critical"}]
  }`);
  const p = /** @type {any} */ (parseNpmBulk(answer, new Set(['lodash', '@scope/pkg'])));
  assert.deepEqual(p.advisories.map((/** @type {any} */ a) => [a.package, a.id, a.severity]), [
    ['lodash', 'GHSA-aaaa-bbbb-cccc', 'critical'], ['lodash', 'npm:3', 'unknown'], ['lodash', 'npm:4', 'low'], ['lodash', 'CVE-2024-0001', 'moderate'], ['lodash', 'str-5', 'info'],
  ].sort((x, y) => ['critical', 'high', 'moderate', 'low', 'info', 'unknown'].indexOf(x[2]) - ['critical', 'high', 'moderate', 'low', 'info', 'unknown'].indexOf(y[2]) || (x[0] + x[1] < y[0] + y[1] ? -1 : 1)));
  const a0 = p.advisories[0];
  assert.equal(a0.title.length, 200); assert.ok(!/[\u0000-\u001f‮]/.test(a0.title)); assert.match(a0.title, /^line one line two x+$/);
  assert.equal(a0.vulnerable_versions, '<1.0.0 >2');
  assert.equal(p.advisories.find((/** @type {any} */ a) => a.id === 'npm:3').url, '');
  assert.equal(p.advisories.find((/** @type {any} */ a) => a.id === 'npm:4').url, '', 'a url with a line break is dropped');
  assert.ok(!p.advisories.some((/** @type {any} */ a) => a.package !== 'lodash'));
  assert.ok('error' in /** @type {any} */ (parseNpmBulk(null, new Set())) && 'error' in /** @type {any} */ (parseNpmBulk([], new Set())));
  const many = Object.fromEntries([['lodash', Array.from({ length: 150 }, (_, i) => ({ id: i + 1, severity: 'low' }))], ['@scope/pkg', Array.from({ length: 150 }, (_, i) => ({ id: i + 1, severity: 'low' }))]]);
  const q = /** @type {any} */ (parseNpmBulk(many, new Set(['lodash', '@scope/pkg'])));
  assert.equal(q.advisories.length, 300, 'the cut is made on the merged list, not per answer');
});

test('the 200 kept advisories are the worst of ALL batches: severity order on the merged list before the cut', () => {
  /** @type {Record<string, unknown>} */ const pk = {};
  for (let i = 0; i < 998; i++) pk[`node_modules/p${String(i).padStart(5, '0')}`] = { version: '1.0.0' };
  const list = (/** @type {number} */ n, /** @type {string} */ sev) => Array.from({ length: n }, (_, i) => ({ id: i + 1, severity: sev }));
  const http = fake((_r, i) => ({ status: 200, body: JSON.stringify(i === 0 ? { p00001: list(150, 'low') } : { p00600: list(100, 'critical'), p00601: list(100, 'low') }) }));
  const d = run({ lock: lockText(pk) });
  check(d, http);
  const rec = record(d);
  assert.equal(rec.status, 'measured');
  assert.equal(rec.advisories.length, 200); assert.equal(rec.truncated, true);
  assert.deepEqual(rec.counts, { critical: 100, high: 0, moderate: 0, low: 100, info: 0, unknown: 0 });
  assert.ok(rec.advisories.slice(0, 100).every((/** @type {any} */ a) => a.severity === 'critical'));
});

test('skipped entries are shown, and too many make the record partial, never measured', () => {
  const reg = (/** @type {string} */ n) => `https://registry.npmjs.org/${n}/-/${n}-1.0.0.tgz`;
  /** @type {Record<string, unknown>} */ const pk = {};
  for (let i = 0; i < 30; i++) pk[`node_modules/q${i}`] = { version: '1.0.0', resolved: reg(`q${i}`) };
  pk['node_modules/lnk'] = { version: '1.0.0', link: true };
  let http = fake({ status: 200, body: '{}' }); let d = run({ lock: lockText(pk) });
  let r = check(d, http);
  assert.equal(record(d).status, 'measured');
  assert.match(r.out, /^advisory-check: measured by .*; skipped 1 of 33 entries \(non-registry 1\);/);
  for (let i = 0; i < 26; i++) pk[`node_modules/x${i}`] = { version: '1.0.0', resolved: `git+https://h.invalid/${i}.git` };
  for (let i = 0; i < 600; i++) pk[`node_modules/r${i}`] = { version: '1.0.0' };
  http = fake({ status: 200, body: '{}' }); d = run({ lock: lockText(pk) });
  r = check(d, http);
  assert.equal(record(d).status, 'partial'); assert.equal(record(d).skipped, 27); assert.match(r.out, /PARTIAL, not a clean check/);
  assert.match(ledgerRows(d)[0], / status=partial$/);
  assert.match(check(d, http).out, /already recorded for this lock file/);
  assert.equal(http.calls.length, 2, 'two batches, and no second request set for the same lock');
});

test('once per lock content: a measured record is reused; a changed lock file is a new request', () => {
  const http = fake(); const d = run();
  check(d, http);
  const again = check(d, http);
  assert.match(again.out, /already recorded for this lock file: no second request/);
  assert.equal(http.calls.length, 1);
  wr(d, 'package-lock.json', lockText({ 'node_modules/extra': { version: '1.0.0' } }));
  check(d, http);
  assert.equal(http.calls.length, 2);
  assert.equal(record(d).requests, 2);
});

test('a failed request set may be repeated, but never more than three times for one lock file (counted in ledger rows)', () => {
  const http = fake({ error: 'network' }); const d = run();
  for (let i = 0; i < 3; i++) check(d, http);
  assert.match(check(d, http).out, /already recorded for this lock file: no second request/);
  assert.equal(http.calls.length, MAX_ATTEMPTS);
  assert.equal(ledgerRows(d).length, MAX_ATTEMPTS);
  // a record edited by hand (it no longer matches its ledger row) does not give more attempts: the rows are the counter
  const rec = record(d); rec.attempts = 0; rec.requests = 0; writeFileSync(path.join(d, REC), JSON.stringify(rec));
  assert.match(check(d, http).out, /not_run: 3 requests were already made for this lock file/);
  assert.equal(http.calls.length, MAX_ATTEMPTS);
});

test('the run caps the request sets at six, whatever the lock file; edits of the record do not reset any counter', () => {
  const http = fake({ error: 'timeout' }); const d = run();
  for (let i = 0; i < MAX_SETS; i++) { wr(d, 'package-lock.json', lockText({ [`node_modules/n${i}`]: { version: '1.0.0' } })); check(d, http); }
  assert.equal(http.calls.length, MAX_SETS);
  wr(d, 'package-lock.json', lockText({ 'node_modules/another': { version: '1.0.0' } }));
  const rec = record(d); rec.requests = 0; rec.attempts = 0; writeFileSync(path.join(d, REC), JSON.stringify(rec));
  assert.match(check(d, http).out, /not_run: 6 request sets were already made in this run/);
  assert.equal(http.calls.length, MAX_SETS);
});

test('the record is bound to the ledger: a row is written with it, and a record edited by hand is not reused', () => {
  const http = fake(); const d = run();
  check(d, http);
  assert.equal(ledgerRows(d).length, 1);
  const sha = createHash('sha256').update(readFileSync(path.join(d, REC))).digest('hex');
  assert.match(ledgerRows(d)[0], new RegExp(` detail=record=${sha} lock=[0-9a-f]{64} status=measured$`));
  const rec = record(d); rec.advisories = []; writeFileSync(path.join(d, REC), JSON.stringify(rec));
  assert.doesNotMatch(check(d, http).out, /no second request/);
  assert.equal(http.calls.length, 2);
  assert.equal(ledgerRows(d).length, 2);
});

test('no lock file, a diff without a dependency manifest, a role that runs the command', () => {
  const http = fake();
  assert.match(check(run({ lock: false }), http).out, /not_run: no npm-shrinkwrap\.json, package-lock\.json, pnpm-lock\.yaml, yarn\.lock or bun\.lock/);
  const d = run({ files: 'src/a.js', lock: false });
  assert.match(check(d, http).out, /not_applicable: no dependency manifest or lock file changed/);
  assert.equal(http.calls.length, 0);
  for (const role of ['security_reviewer', 'reviewer', 'qa', 'implementer']) {
    const r = AS(d, role, ['advisory-check', 'LC']);
    assert.notEqual(r.status, 0, role);
    assert.match(r.text, /command denied for/);
  }
});

test('`next` offers the request before the dependencies focus only when the setting is on', () => {
  for (const on of [true, false]) {
    const d = run({ on });
    const n = A(d, ['next', 'LC']);
    assert.equal(/agent\.sh advisory-check LC/.test(n.out), on, n.out);
    if (on) assert.ok(n.out.indexOf('advisory-check LC') < n.out.indexOf('--focus dependencies'), n.out);
  }
});

test('config-check knows the key and refuses another value', () => {
  const d = run({ on: false });
  sedFile(d, '.agents/config.yaml', /^ {2}advisory_check:.*$/, '  advisory_check: maybe');
  const r = A(d, ['config-check']);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /invalid value for security\.advisory_check: maybe \(want on\|off\)/);
});

test('the default HTTP function (no network here): http is refused, a closed local port is a network error, neither starts from the project', () => {
  assert.deepEqual(httpPost({ url: 'http://127.0.0.1:1/x', body: '{}', timeoutMs: 5000, maxBytes: 1024 }), { error: 'scheme' });
  const srv = createServer();
  const port = /** @type {Promise<number>} */ (new Promise((res) => srv.listen(0, '127.0.0.1', () => res(/** @type {any} */ (srv.address()).port))));
  return port.then((n) => new Promise((resolve) => srv.close(() => {
    assert.deepEqual(httpPost({ url: `https://127.0.0.1:${n}/x`, body: '{}', timeoutMs: 5000, maxBytes: 1024 }), { error: 'network' });
    resolve(undefined);
  })));
});

test('the ecosystem definition carries the fixed url and no tool: no argv, no environment, no project settings file', () => {
  const j = JSON.parse(readFileSync(new URL('../../control-plane/agents/ecosystems.json', import.meta.url), 'utf8'));
  const a = j.ecosystems.find((/** @type {any} */ e) => e.advisory).advisory;
  assert.deepEqual(a, {
    kind: 'npm-bulk', url: URL_OWN, locks: ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'], formats: ['npm-json', 'npm-json', 'pnpm-yaml', 'yarn', 'bun-jsonc'],
    refused: ['bun.lockb'], watch: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'],
  });
});
