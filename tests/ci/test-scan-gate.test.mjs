// @ts-check
// Issue 266 package 3a (A277), AC-4: the scan gate. CI runs `test-scan --kind wait` on tests/ with ONE allowlist and fails on an open candidate or a stale entry. These tests pin
// the CI step, the single allowlist file (the three per-package files are gone, every entry has its reason and the file is sorted) and the behaviour of the command on seeded input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from '../lib/harness.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const core = path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs');
const ci = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
// the name of the wait is assembled so that this very file is not a candidate of the scan it tests
const WAIT = ['set', 'Timeout'].join('');
const STEP = 'node control-plane/agents/scripts/proofline-core.mjs cli test-scan --kind wait --allowlist tests/ci/test-scan-allowlist.tsv tests';
/** @param {string} name */
const job = (name) => (new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, 'm').exec(ci) ?? [])[1] ?? '';
/** @param {string} cwd @param {string[]} args */
const scan = (cwd, args) => spawnSync(process.execPath, [core, 'cli', 'test-scan', '--kind', 'wait', ...args], { cwd, encoding: 'utf8' });

test('the static job has the scan step: one line, this command and this allowlist, not conditional on the changed paths', () => {
  const m = /      - name: test scan[^\n]*\n((?:        [^\n]*\n)+)/.exec(job('static'));
  assert.ok(m, 'no test scan step in the static job');
  assert.equal(m[1], `        run: ${STEP}\n`);
});

test('one allowlist file: the three package files are gone, every entry has a path, a pattern and a written reason, the entries are sorted and unique', () => {
  for (const old of ['skills', 'core', 'atomics']) assert.ok(!existsSync(path.join(repo, `tests/ci/test-scan-allowlist-${old}.tsv`)), old);
  const rows = readFileSync(path.join(repo, 'tests/ci/test-scan-allowlist.tsv'), 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  assert.ok(rows.length >= 10);
  const keys = rows.map((r) => { const [p, pat, ...why] = r.split('\t'); assert.ok(p && pat && why.join('\t').length >= 10, r.slice(0, 60)); return `${p}\t${pat}`; });
  assert.deepEqual(keys, [...keys].sort(), 'sorted by path then pattern (byte order)');
  assert.equal(new Set(keys).size, keys.length);
  for (const f of ['CONTRIBUTING.md', 'tests/core/poll-lib.mjs']) assert.ok(!/test-scan-allowlist-(skills|core|atomics)/.test(readFileSync(path.join(repo, f), 'utf8')), f);
});

test('the repository is clean under the gate command: exit 0, no open candidate, no stale entry', () => {
  const r = scan(repo, ['--allowlist', 'tests/ci/test-scan-allowlist.tsv', 'tests']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /test-scan: 0 candidate\(s\) in \d+ scanned file\(s\), \d+ allowed/);
});

test('seeded input: an unlisted real wait fails (1); the same wait listed with a reason passes (0); an entry that matches nothing is stale and fails (1)', () => {
  const d = tmp('scan-gate-');
  mkdirSync(path.join(d, 'tests'));
  writeFileSync(path.join(d, 'tests/a.test.mjs'), `await new Promise((r) => ${WAIT}(r, 50));\n`);
  const open = scan(d, ['tests']);
  assert.equal(open.status, 1);
  assert.match(open.stdout, new RegExp(`candidate: tests/a\\.test\\.mjs:1 wait ${WAIT}`));
  writeFileSync(path.join(d, 'allow.tsv'), `tests/a.test.mjs\t${WAIT}\tfalse positive for the seeded gate test\n`);
  const listed = scan(d, ['--allowlist', 'allow.tsv', 'tests']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  writeFileSync(path.join(d, 'allow.tsv'), `tests/a.test.mjs\t${WAIT}\tfalse positive for the seeded gate test\ntests/gone.test.mjs\t${WAIT}\tthis file does not exist any more\n`);
  const stale = scan(d, ['--allowlist', 'allow.tsv', 'tests']);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout + stale.stderr, /unused-allowlist-entry: line 2/);
});
