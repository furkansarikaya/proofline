// @ts-check
// The scope selection of a pull request run (scope.mjs; ADR 0001 section 6: "replay only touched commands per pull request, full replay nightly").
// A shared file (a library, the rig, a case table) must NOT select every command: it selects one command per family on the light states.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movedCommandCases } from './cases/moved-commands.mjs';
import { stage2Cases } from './cases/stage2-commands.mjs';
import { ALL_COMMANDS, caseInScope, LIGHT_STATES, REPRESENTATIVE, selectScope } from './scope.mjs';

// stage3Cases() is not used here: it derives its fixtures eagerly (about two minutes), and its cases name no fixture state, so the state rule does not apply to them
const allCases = () => [...movedCommandCases(), ...stage2Cases()];

test('a shared file (rig, library, case table, bench) selects the representative set, never every command', () => {
  for (const f of ['tests/equivalence/rig.mjs', 'tests/equivalence/cases-lib.mjs', 'tests/equivalence/normalise.mjs', 'control-plane/agents/scripts/core/proc.mjs', 'control-plane/agents/scripts/proofline-core.mjs', 'tests/bench/agent-procs.mjs']) {
    const s = selectScope([f]);
    assert.deepEqual(s.full, [], f);
    assert.deepEqual(s.representative, [...REPRESENTATIVE], f);
    assert.ok(s.representative.length < ALL_COMMANDS.length / 1.5, `${f}: a small set, not ${s.representative.length} of ${ALL_COMMANDS.length}`);
  }
});
test('a file of one command selects that command on every state; a family file selects its family', () => {
  assert.deepEqual(selectScope(['control-plane/agents/scripts/core/commands/next.mjs']), { full: ['next'], representative: [] });
  assert.deepEqual(selectScope(['control-plane/agents/scripts/core/timeouts.mjs']).full, ['timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled']);
  assert.deepEqual(selectScope(['README.md', 'docs/x.md', 'tests/ci/x.mjs']), { full: [], representative: [] }, 'files outside the control plane, the rig and the bench select nothing');
});
test('a command file plus a shared file: that command on every state, the other representatives on the light states', () => {
  const s = selectScope(['control-plane/agents/scripts/core/commands/next.mjs', 'tests/equivalence/rig.mjs']);
  assert.deepEqual(s.full, ['next']);
  assert.ok(!s.representative.includes('next') && s.representative.includes('summary'));
});
test('the representative set has one command of every family and only known commands', () => {
  for (const c of REPRESENTATIVE) assert.ok(ALL_COMMANDS.includes(c), c);
  for (const fam of [['role', 'config-get', 'config-check', 'db-config', 'hook-config', 'timeouts'], ['status', 'effective', 'pipeline', 'next', 'summary'], ['verify-gates', 'verify-seal', 'verify-freeze'], ['request-approval', 'approve', 'next-user']])
    assert.ok(fam.some((c) => REPRESENTATIVE.includes(c)), `no representative of ${fam.join('/')}`);
});
test('the representative selection runs only light-state cases, and a small number of them', () => {
  const sel = selectScope(['tests/equivalence/rig.mjs']);
  const picked = allCases().filter((c) => caseInScope(c, sel));
  assert.ok(picked.length > 20, `${picked.length} cases`);
  assert.ok(picked.length <= 140, `${picked.length} cases is more than the budget of a pull request run`);
  for (const c of picked) {
    const state = /^[a-z-]+: ([a-z0-9-]+)/.exec(c.name)?.[1];
    if (state && /^(gates|risk|scale|intake|empty)/.test(state)) assert.ok(LIGHT_STATES.includes(state), `${c.name} is a heavy state`);
  }
  for (const heavy of ['gates-done', 'risk-passed', 'scale-60', 'gates-allpass', 'gates-waived']) assert.ok(!picked.some((c) => c.name.endsWith(`: ${heavy}`)), heavy);
});
test('a touched command keeps all of its states, and an untouched command none', () => {
  const sel = selectScope(['control-plane/agents/scripts/core/commands/summary.mjs']);
  const picked = allCases().filter((c) => caseInScope(c, sel));
  assert.ok(picked.length > 0 && picked.every((c) => c.steps.some((s) => s.args?.[0] === 'summary')));
  assert.ok(picked.some((c) => c.name.endsWith(': gates-done')), 'summary on a heavy state');
  assert.deepEqual(allCases().filter((c) => caseInScope(c, { full: [], representative: [] })), []);
});
test('the light states exist in the fixtures and are cheap ones', () => {
  const names = new Set(stage2Cases().map((c) => c.name.split(': ')[1]));
  for (const s of LIGHT_STATES) assert.ok(names.has(s), s);
  assert.ok(LIGHT_STATES.length <= 4);
});
