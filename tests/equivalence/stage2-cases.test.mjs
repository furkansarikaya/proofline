// @ts-check
// The Stage 2 case table itself (no fixtures are built here): every one of the 41 commands has cases, the list is the ADR's command map, every
// gate-sensitive command is checked on every gate state, the performance commands on the 0/20/60 scaling fixture, and every state is in one bucket.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from './fixture.mjs';
import { BUCKETS, ROWS, STAGE2 } from './cases/stage2-commands.mjs';
import { MOVED } from './cases/moved-commands.mjs';
import { RUN_STATES, SCALE_STATES, STATES } from './cases/stage2-fixtures.mjs';
import { ALL_COMMANDS, touchedCommands } from './scope.mjs';

const commands = readFileSync(join(repoRoot, 'tests/equivalence/commands.txt'), 'utf8').split('\n').filter(Boolean);

test('the stage 2 list is the 41 commands of the ADR command map', () => {
  const adr = readFileSync(join(repoRoot, 'docs/adr/0001-stages.md'), 'utf8');
  const row = /^\| 2 \(41\) \| (.*) \|$/m.exec(adr);
  assert.ok(row, 'no stage 2 row in the command map');
  const mapped = [...(row?.[1] ?? '').matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
  assert.deepEqual([...STAGE2].sort(), mapped.sort());
  assert.equal(new Set(STAGE2).size, 41);
  for (const c of STAGE2) assert.ok(commands.includes(c), `${c} is not an agent.sh command (commands.txt)`);
  assert.equal(MOVED.filter((c) => STAGE2.includes(c)).length, 0, 'a stage 1 command is in the stage 2 list');
});

test('every stage 2 command has cases, each call starts with its command, and a case is attached to one command', () => {
  for (const c of STAGE2) assert.ok(ROWS.some((r) => r.cmd === c), `no case row for ${c}`);
  assert.equal(new Set(ROWS.map((r) => r.cmd)).size, ROWS.length, 'two rows for one command');
  for (const r of ROWS) {
    assert.ok(r.states.length > 0, r.cmd);
    for (const s of r.states) assert.ok(s === 'empty' || s in STATES, `${r.cmd}: unknown state ${s}`);
    const calls = r.calls.filter((x) => x.args);
    assert.ok(calls.length > 0, `${r.cmd}: no call`);
    for (const x of calls) assert.equal(x.args?.[0], r.cmd, `${r.cmd}: a call of another command`);
  }
});

test('the gate-sensitive commands run on every gate and risk state; the performance commands also on 0/20/60 changed files', () => {
  const gateStates = RUN_STATES.filter((s) => !s.startsWith('scale-'));
  for (const c of ['effective', 'fingerprint', 'pipeline', 'next', 'summary', 'digest', 'verify-gates', 'verify-seal', 'verify-handoff', 'validate', 'verify-scope', 'freshness', 'status']) {
    const r = ROWS.find((x) => x.cmd === c);
    for (const s of gateStates) assert.ok(r?.states.includes(s), `${c} misses ${s}`);
  }
  for (const c of ['fingerprint', 'summary', 'next', 'pipeline', 'digest', 'verify-scope', 'validate']) {
    const r = ROWS.find((x) => x.cmd === c);
    for (const s of SCALE_STATES) assert.ok(r?.states.includes(s), `${c} misses ${s}`);
  }
  const named = ['gates-full', 'intake-unclassified', 'intake-classified', 'intake-branched', 'intake-planned', 'gates-frozen', 'gates-implemented', 'gates-partial', 'gates-failed', 'gates-allpass', 'gates-stale', 'gates-codedone', 'gates-done', 'risk-unfrozen', 'risk-open', 'risk-passed'];
  for (const s of named) assert.ok(s in STATES, s);
});

test('every fixture state is in exactly one test file bucket, and the case table is reachable by the touched-command selection', () => {
  const flat = BUCKETS.flat();
  assert.equal(new Set(flat).size, flat.length);
  for (const s of ['empty', ...RUN_STATES]) assert.ok(flat.includes(s), `${s} is in no bucket`);
  for (const s of flat) assert.ok(s === 'empty' || s in STATES, s);
  for (const c of STAGE2) assert.ok(ALL_COMMANDS.includes(c), `scope.mjs does not know ${c}`);
  assert.ok(touchedCommands().every((c) => ALL_COMMANDS.includes(c)));
});
