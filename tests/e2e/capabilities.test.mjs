// @ts-check
// Self-test (A95) of the e2e harness: a dry run records the global git config and creates the collected files, with no runtime call.
// E2E_RUNNER (e.g. `sh tests/e2e/run.sh`) runs the same assertions against another runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { here, repo, runE2e } from './runner.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'e2e-cap-'));
after(() => rmSync(root, { recursive: true, force: true }));
/** @param {string} dir @param {string} name @returns {string} the first directory called name under dir, or '' */
function findDir(dir, name) {
  if (!existsSync(dir)) return '';
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (!statSync(p).isDirectory()) continue;
    if (n === name) return p;
    const f = findDir(p, name);
    if (f) return f;
  }
  return '';
}
/** @param {string} dir @param {string} name */
function findFile(dir, name) {
  if (!existsSync(dir)) return '';
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) { const f = findFile(p, name); if (f) return f; } else if (n === name) return p;
  }
  return '';
}
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const dry = (/** @type {string[]} */ args, /** @type {Record<string, string | undefined>} */ env = {}) => runE2e([...args, '--dry-run'], env);
const policy = (/** @type {string[]} */ a) => execFileSync(process.execPath, [path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs'), 'cli', 'exec-policy', '--config', path.join(repo, 'control-plane/agents/config.yaml'), ...a], { encoding: 'utf8' }).trim();

test('a dry run records the global git config before and after and creates the collected files', () => {
  const r = dry(['TRIVIAL', 'claude'], { E2E_ROOT: root });
  assert.equal(r.status, 0, `dry run failed: ${r.out}`);
  const out = findDir(root, 'out');
  assert.ok(out, 'no out directory');
  for (const f of ['git-global-before.txt', 'git-global-after.txt', 'agent-pipeline.txt', 'insights.txt', 'visual-artifacts.txt', 'replies-log.txt', 'metrics']) assert.ok(existsSync(path.join(out, f)), `missing out/${f}`);
  assert.equal(read(path.join(out, 'git-global-before.txt')), read(path.join(out, 'git-global-after.txt')), 'global git config record differs between before and after');
  assert.match(read(path.join(out, 'git-global-before.txt')), /sha256=|absent/, 'global config not recorded as a hash or absent');
  assert.match(read(path.join(out, 'insights.txt')), /not collected/, 'dry run called insights');
});

test('with no global config at all the record says absent and the harness writes none', () => {
  const empty = mkdtempSync(path.join(root, 'home.'));
  const r = dry(['TRIVIAL', 'claude'], { HOME: empty, XDG_CONFIG_HOME: path.join(empty, 'x'), GIT_CONFIG_NOSYSTEM: '1', E2E_ROOT: path.join(root, 'b') });
  assert.equal(r.status, 0, 'dry run without global config failed');
  const b = findFile(path.join(root, 'b'), 'git-global-before.txt');
  assert.ok((read(b).match(/absent/g) ?? []).length >= 3, `absent not recorded: ${read(b)}`);
  assert.ok(!existsSync(path.join(empty, '.gitconfig')), 'harness wrote a global config');
});

test('A100/A135: the Codex lead command carries the base model, and the effort only when asked; a cheaper model is refused', () => {
  const lines = (/** @type {string} */ out) => out.split('\n').filter((l) => /^lead( resume)?:/.test(l));
  const plain = lines(dry(['TRIVIAL', 'codex'], { E2E_ROOT: path.join(root, 'c') }).out);
  assert.equal(plain.length, 2, `no codex lead lines: ${plain.join('\n')}`);
  assert.equal(policy(['lead-base', 'codex']), 'gpt-6-sol', 'lead-base codex is not gpt-6-sol');
  assert.equal(plain.filter((l) => l.includes("-m 'gpt-6-sol'")).length, 2, `Codex lead without E2E_CODEX_MODEL must still pass the base model: ${plain.join('\n')}`);
  assert.ok(!plain.some((l) => l.includes('model_reasoning_effort')), 'effort flag present with the env unset');
  const cfg = read(path.join(repo, 'control-plane/agents/config.yaml'));
  const base = (/^  lead_base_model:[\s\S]*?^ {4}codex:\s*(\S+)/m.exec(cfg) ?? [])[1];
  assert.ok(base, 'no lead_base_model.codex in the policy table');
  const refused = dry(['TRIVIAL', 'codex'], { E2E_CODEX_MODEL: 'gpt-6-luna', E2E_ROOT: path.join(root, 'e') });
  assert.notEqual(refused.status, 0, 'cheapest model accepted for a Codex lead');
  assert.ok(refused.out.includes(base), `refusal does not name the base model: ${refused.out}`);
  assert.notEqual(dry(['FAILOVER', 'mixed'], { E2E_CODEX_MODEL: 'gpt-6-luna', E2E_ROOT: path.join(root, 'e2') }).status, 0, 'cheapest model accepted for the FAILOVER resume lead');
  const cheap = lines(dry(['TRIVIAL', 'codex'], { E2E_CODEX_MODEL: base, E2E_CODEX_EFFORT: 'none', E2E_ROOT: path.join(root, 'd') }).out);
  assert.equal(cheap.filter((l) => l.includes(`-m '${base}'`)).length, 2, `model flag missing: ${cheap.join('\n')}`);
  assert.equal(cheap.filter((l) => l.includes('model_reasoning_effort="none"')).length, 2, `effort flag missing: ${cheap.join('\n')}`);
  // A135: the cheapest model stays allowed where Claude leads and Codex only works (mixed).
  assert.equal(dry(['TRIVIAL', 'mixed'], { E2E_CODEX_MODEL: 'gpt-6-luna', E2E_ROOT: path.join(root, 'm') }).status, 0, 'cheap Codex worker model refused in a mixed run');
});

test('A117/A121: cleanup after a dry run, --keep, and the database probe evidence', () => {
  const out = findDir(root, 'out');
  const runDir = path.dirname(out);
  assert.ok(!existsSync(path.join(runDir, 'project')) && !existsSync(path.join(runDir, 'codexhome')), 'dry run left the project copy or codexhome behind');
  assert.ok(existsSync(path.join(out, 'git-global-before.txt')) && statSync(path.join(out, 'git-global-before.txt')).size > 0 && statSync(path.join(out, 'prepare.txt')).size > 0, 'out/ not intact after cleanup');
  assert.equal(dry(['TRIVIAL', 'claude', '--keep'], { E2E_ROOT: path.join(root, 'k') }).status, 0, 'dry run --keep failed');
  const k = path.join(root, 'k', readdirSync(path.join(root, 'k'))[0] ?? '');
  for (const d of ['project', 'codexhome', 'out']) assert.ok(existsSync(path.join(k, d)), `--keep did not keep ${d}`);
  for (const f of ['db-probe-before.txt', 'db-probe.txt', 'db-probe-diff.txt', 'summary.txt']) assert.ok(existsSync(path.join(out, f)) && statSync(path.join(out, f)).size > 0, `missing out/${f}`);
  assert.match(read(path.join(out, 'summary.txt')), /^db_unchanged=yes$/m, 'db_unchanged is not yes on an untouched copy');
  assert.equal(read(path.join(out, 'db-probe-before.txt')), read(path.join(out, 'db-probe.txt')), 'db probe differs on an untouched copy');
  const before = read(path.join(out, 'db-probe-before.txt'));
  for (const re of [/^columns=.*legacy_notes/m, /^legacy_notes_non_null=3$/m, /^legacy_notes_sha256=/m, /^legacy_notes_values=/m, /^table=books .*rows=[0-9]+$/m, /^migrations=001_create_books\.sql,002_add_notes\.sql$/m, /^db_file_sha256=/m]) assert.match(before, re, `db-probe-before.txt lacks ${re}`);
  assert.match(before, /^db_wal_sha256=/m, 'db-probe-before.txt lacks db_wal_sha256');
  // A probe that cannot run is marked, and the verdict is unknown, never yes.
  const r = dry(['TRIVIAL', 'claude'], { E2E_PROBE_NODE: '/nonexistent/node', E2E_ROOT: path.join(root, 'p') });
  assert.equal(r.status, 0, 'dry run with a failing probe failed');
  const p = findDir(path.join(root, 'p'), 'out');
  assert.match(read(path.join(p, 'db-probe-before.txt')), /^probe failed:/m, 'failed probe not marked');
  assert.match(read(path.join(p, 'summary.txt')), /^db_unchanged=unknown$/m, 'failed probe did not give db_unchanged=unknown');
});

test('the usage and the exit codes: 2 for a wrong call, FAILOVER needs mixed', () => {
  assert.equal(runE2e([]).status, 2);
  assert.equal(runE2e(['TRIVIAL']).status, 2);
  assert.equal(runE2e(['NOPE', 'claude']).status, 2);
  assert.equal(runE2e(['TRIVIAL', 'nope']).status, 2);
  const f = runE2e(['FAILOVER', 'claude']);
  assert.equal(f.status, 2);
  assert.match(f.out, /FAILOVER requires mixed/);
  assert.equal(runE2e(['TRIVIAL', 'claude', '--bogus'], { E2E_ROOT: path.join(root, 'u') }).status, 2);
  assert.match(runE2e([]).out, /usage: .*<TRIVIAL\|STANDARD\|STANDARD\.tr\|COMPLEX\|CRITICAL\|FAILOVER> <claude\|codex\|mixed> \[--dry-run\] \[--keep\]/);
});
void here;
