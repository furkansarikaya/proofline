// @ts-check
// A371 (issue 338 item U6): every state change since 0.0.173 is ADDITIVE, so the new core must read a project whose config lacks every key added since then. The old shape: the
// project's own config.yaml minus the keys the 0.0.173 default (the fixture, a copy of `git show v0.0.173:control-plane/agents/config.yaml`) did not have. An in-flight run on it is
// driven to CODE_DONE by the new core and `config-check` accepts it; `configDelta` says which keys the upgrade adds and which it does not (docs/concepts/upgrading.md has the table).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { configDelta } from '../../control-plane/agents/scripts/core/upgradesafe.mjs';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { PL } from './frontend-lib.mjs';
import { A, agentsSrc, cleanEnv, project, toCodeDone, warmDefaultTemplate } from '../lib/harness.mjs';

const old = readFileSync(new URL('../fixtures/upgrade/config-v0.0.173.cfg', import.meta.url), 'latin1');
const shipped = readFileSync(join(agentsSrc, 'config.yaml'), 'latin1');
const keys = (/** @type {string} */ t) => new Set(configLines(t).map((l) => l.slice(0, l.indexOf('='))));

/** The text of a config without the keys the 0.0.173 default did not have. @param {string} cfg */
function strip(cfg) {
  const had = keys(old);
  /** @type {string[]} */ const out = []; /** @type {string[]} */ const path = [];
  for (const l of cfg.split('\n')) {
    const m = /^( *)([A-Za-z0-9_.-]+):(.*)$/.exec(l);
    if (!m || l.trim().startsWith('#')) { out.push(l); continue; }
    path.length = m[1].length / 2; path.push(m[2]);
    if (had.has(path.join('.'))) out.push(l);
  }
  return out.join('\n');
}

test('the keys added since 0.0.173 are the ones docs/concepts/upgrading.md lists; the upgrade adds every one of them, at any depth', () => {
  const added = [...keys(shipped)].filter((k) => !keys(old).has(k) && k !== 'proofline_version').sort();
  for (const k of ['output_cap_bytes', 'profiles', 'profiles.light.types', 'test_trust.review_rounds', 'test_trust.review_minutes', 'execution_policy.repeat_model_cap', 'pipelines.COMPLEX.max_fix_rounds', 'pipelines.CRITICAL.mutation_budget']) assert.ok(added.includes(k), `${k} is not new since 0.0.173`);
  const d = configDelta(strip(shipped), shipped);
  assert.ok(d.added.includes('output_cap_bytes') && d.added.includes('profiles.light.types'), d.added.join(' '));
  assert.ok(d.added.includes('pipelines.COMPLEX.max_fix_rounds') && d.added.includes('pipelines.CRITICAL.mutation_budget'), d.added.join(' '));
  assert.deepEqual(d.notMerged, [], 'nothing is left unmerged');
  assert.equal(d.added.length, added.length, 'every new key is added');
});

test('an in-flight run of a project with the 0.0.173 config shape goes to CODE_DONE on the new core', () => {
  warmDefaultTemplate();
  const dir = project();
  const cf = join(dir, '.agents/config.yaml');
  const oldShape = strip(readFileSync(cf, 'latin1'));
  assert.ok(!keys(oldShape).has('output_cap_bytes') && !keys(oldShape).has('profiles.light.types') && !keys(oldShape).has('pipelines.COMPLEX.max_fix_rounds'));
  assert.ok(keys(oldShape).has('review.max_fix_rounds') && keys(oldShape).has('test_trust.mutation_budget'));
  writeFileSync(cf, oldShape);
  const c = A(dir, ['config-check']);
  assert.equal(c.status, 0, c.text);
  toCodeDone(dir);
  const s = A(dir, ['status']);
  assert.equal(s.status, 0, s.text);
  const p = A(dir, ['pipeline', 'LC']).out;
  assert.match(p, /^gate\.VERIFY=pass$/m);
  assert.match(p, /^max_fix_rounds=2$/m, 'a class key that is absent means the global default (a COMPLEX run of the new default would have 3)');
});

test('proofline status says that the active run crossed an upgrade', () => {
  const dir = project();
  const status = () => spawnSync(process.execPath, [PL, 'status'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
  assert.doesNotMatch(status().stdout, /crossed/);
  ledgerAppend(join(dir, '.agents/runs/LC'), 'user', 'upgrade', '-', '-', 'old=0.0.173 new=0.0.193 state_format=1');
  const r = status();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /upgrade: this run crossed 1 upgrade\(s\) \(0\.0\.173 -> 0\.0\.193\); gate results recorded before it came from the older core/);
});
