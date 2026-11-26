// @ts-check
// U5 (A374, issue 338): the shipped config.yaml is split into a BASICS part (the few settings a user is expected to change) and an ADVANCED part, without a key or a value changing;
// `proofline doctor --config` lists the basics read-only from a built-in list (never from banners, so a project file without them works). Absolute expectations.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../lib/tempdir.mjs';
import { configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { doctorCommand } from '../../control-plane/agents/scripts/core/doctor.mjs';
import { BASIC_KEYS, basicsLines } from '../../control-plane/agents/scripts/core/configbasics.mjs';
import { USAGE_LINES } from '../../control-plane/agents/scripts/core/cliusage.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const shipped = readFileSync(path.join(root, 'control-plane/agents/config.yaml'), 'latin1');
const old = readFileSync(path.join(import.meta.dirname, 'golden/config/shipped-0.0.195.cfg'), 'latin1');
const BASICS = '# ===== BASICS: the few settings a user is expected to change =====';
const ADVANCED = '# ===== ADVANCED: defaults for the control plane; change only with a decision (A-record) =====';
/** @param {string} t the parsed keys and values, the version line left out (it moves with every release) */
const parsed = (t) => configLines(t).filter((l) => !l.startsWith('proofline_version=')).sort();

test('the shipped config parses to exactly the keys and values of 0.0.195 (no key renamed, moved or changed)', () => {
  assert.deepEqual(parsed(shipped), parsed(old));
  assert.equal(configLines(shipped).length, configLines(old).length);
});

test('the shipped config has the two banners once, BASICS first, and every basic key sits in the BASICS part', () => {
  const lines = shipped.split('\n');
  assert.equal(lines.filter((l) => l === BASICS).length, 1);
  assert.equal(lines.filter((l) => l === ADVANCED).length, 1);
  const b = lines.indexOf(BASICS); const a = lines.indexOf(ADVANCED);
  assert.ok(b >= 0 && a > b);
  const basicPart = configLines(lines.slice(b, a).join('\n'));
  const advPart = configLines(lines.slice(a).join('\n'));
  for (const [key] of BASIC_KEYS) assert.ok(basicPart.some((l) => l.startsWith(`${key}=`)), `${key} is not in the BASICS part`);
  // each top-level block is in one place
  const top = (/** @type {string[]} */ ls) => new Set(ls.map((l) => /** @type {string} */ (l.split(/[.=]/)[0])));
  const advTop = top(advPart);
  for (const k of top(basicPart)) assert.ok(!advTop.has(k), `block ${k} is in both parts`);
});

test('every built-in basic key exists in the shipped config and has a one-line meaning', () => {
  const have = new Set(configLines(shipped).map((l) => l.slice(0, l.indexOf('='))));
  assert.ok(BASIC_KEYS.length >= 8 && BASIC_KEYS.length <= 20);
  for (const [key, meaning] of BASIC_KEYS) {
    assert.ok(have.has(key), `${key} is not a shipped key`);
    assert.ok(meaning.length > 10 && !meaning.includes('\n'), key);
  }
});

test('basicsLines: now, default and meaning per key; a key the project lacks says the default applies; a changed value is marked', () => {
  const user = ['runtime.lead=codex', 'commands.test=npm test', 'output_cap_bytes=6000'];
  const def = ['runtime.lead=claude', 'runtime.worker=claude', 'commands.test=', 'output_cap_bytes=6000'];
  const out = basicsLines(user, def).join('\n');
  assert.match(out, /^runtime\.lead: codex \(default claude, changed\) .+$/m);
  assert.match(out, /^runtime\.worker: not in your file, the default applies \(default claude\) .+$/m);
  assert.match(out, /^commands\.test: npm test \(default empty, changed\) .+$/m);
  assert.match(out, /^output_cap_bytes: 6000 \(default 6000\) .+$/m);
  assert.ok(basicsLines(user, null).some((l) => l.startsWith('runtime.lead: codex (shipped default not found)')));
});

/** @param {string} cfgText @param {string} [home] */
function doctorConfig(cfgText, home = root) {
  const d = tempDir('basics');
  mkdirSync(path.join(d, '.agents/scripts'), { recursive: true });
  writeFileSync(path.join(d, '.agents/config.yaml'), cfgText);
  writeFileSync(path.join(d, '.agents/scripts/agent.sh'), '');
  /** @type {Buffer[]} */ const out = [];
  const io = { env: { PL_HOME: home, PATH: process.env.PATH ?? '' }, cwd: d, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => out.push(b) } };
  const ctx = new Context(/** @type {any} */ (io), path.join(d, '.agents/scripts/agent.sh'));
  const status = doctorCommand(ctx, ['--config']);
  ctx.flush();
  assert.equal(readFileSync(path.join(d, '.agents/config.yaml'), 'utf8'), cfgText, 'read-only');
  return { status, out: Buffer.concat(out).toString('utf8') };
}

test('doctor --config lists only the basics of a project config that has no banner, read-only, with the advanced pointer', () => {
  const r = doctorConfig('runtime:\n  lead: codex\ncommands:\n  test: npm test\nreview:\n  risky_paths: "x/**"\n');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^runtime\.lead: codex \(default claude, changed\)/m);
  assert.match(r.out, /^commands\.test: npm test \(default empty, changed\)/m);
  assert.ok(!r.out.includes('risky_paths'), 'an advanced key is not listed');
  assert.match(r.out, /Everything else is advanced/);
  assert.match(r.out, /codex\.sandbox\.network/);
  assert.match(r.out, /not from the banners/);
});

test('doctor --config without the shipped copy (no PL_HOME) still lists the project values', () => {
  const r = doctorConfig('runtime:\n  lead: codex\n', '');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^runtime\.lead: codex \(shipped default not found\)/m);
});

test('proofline help names doctor --config', () => {
  assert.ok(USAGE_LINES.some((l) => l.includes('--config')));
});
