// @ts-check
// C2 rest (issue 338, A362): no strongest model for REPEATED work. A role re-run on the same task (a fix round, a re-review, a redispatch) gets at most
// `execution_policy.repeat_model_cap.<runtime>` and never a higher model than its first attempt; a role's tier floor still wins (a security reviewer stays on tier 3).
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { policyCommand } from '../../control-plane/agents/scripts/core/execpolicy.mjs';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { dispatcherIo } from '../../control-plane/agents/scripts/core/decide.mjs';
import { fixture } from './dispatch-lib.mjs';
import { makeProject, memoryIo } from './helpers.mjs';

const gold = path.join(import.meta.dirname, 'golden/exec-policy');
const CAP = '  repeat_model_cap:\n    claude: sonnet\n    codex: gpt-6-sol\n';

/** @param {boolean} withCap */
function project(withCap) {
  const root = makeProject(readFileSync(path.join(gold, 'config-base.yaml'), 'utf8').replace(/^( {2}forbidden_efforts:.*\n)/m, `$1${withCap ? CAP : ''}`));
  copyFileSync(path.join(gold, 'roles.conf'), path.join(root, '.agents/roles.conf'));
  const { io } = memoryIo(root, {});
  return new Context(io, io.scriptPath);
}
const pick = (/** @type {{ model: string, reason: string }} */ r) => ({ model: r.model, reason: r.reason });
/** @param {Context} ctx @param {string[]} extra */
function resolve(ctx, extra) {
  const r = policyCommand(ctx, ['resolve', '--tier', 'full', '--class', 'COMPLEX', ...extra]);
  assert.equal(r.status, 0, r.err);
  const get = (/** @type {string} */ k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(r.out) ?? [])[1];
  return { model: get('model'), reason: get('model_reason'), escalated: get('escalated'), xreason: get('escalation_reason') };
}

test('c2_repeat: the first attempt keeps its model, a repeat is capped by the ladder cap and by the first attempt', () => {
  const ctx = project(true);
  assert.deepEqual(pick(resolve(ctx, ['--role', 'architect'])), { model: 'opus', reason: 'ROLE_PROFILE' });
  assert.deepEqual(pick(resolve(ctx, ['--role', 'architect', '--repeat-of', 'opus'])), { model: 'sonnet', reason: 'ROLE_PROFILE,REPEAT_CAPPED' });
  // never above the first attempt, whatever the cap says
  assert.equal(resolve(ctx, ['--role', 'explorer', '--profile', 'economy', '--repeat-of', 'haiku']).model, 'haiku');
  assert.equal(resolve(ctx, ['--role', 'reviewer', '--profile', 'max', '--repeat-of', 'sonnet']).model, 'sonnet');
  // an escalation signal does not lift a repeat above the cap
  const esc = resolve(ctx, ['--role', 'reviewer', '--signal', 'fix_round_2', '--repeat-of', 'sonnet']);
  assert.equal(esc.model, 'sonnet');
  // the cap took the escalation back: it is no escalation and spends no budget
  assert.equal(esc.escalated, 'no');
  assert.equal(esc.xreason, 'REPEAT_CAPPED');
  assert.equal(esc.reason, 'ROLE_PROFILE,REPEAT_CAPPED');
  // without the cap the same signal is an escalation (the first attempt on sonnet may go up)
  assert.equal(resolve(ctx, ['--role', 'reviewer', '--signal', 'fix_round_2']).escalated, 'yes');
});

test('c2_repeat_floor: a security reviewer is never lowered below its tier floor; an explicit operator model wins', () => {
  const ctx = project(true);
  assert.equal(resolve(ctx, ['--role', 'security_reviewer', '--repeat-of', 'opus']).model, 'opus');
  assert.equal(resolve(ctx, ['--role', 'architect', '--repeat-of', 'opus', '--model', 'opus']).model, 'opus');
});

test('c2_repeat_off: a config without the key keeps the old behaviour for the cap, but a repeat is still never above its first attempt', () => {
  const ctx = project(false);
  assert.equal(resolve(ctx, ['--role', 'architect', '--repeat-of', 'opus']).model, 'opus');
  assert.equal(resolve(ctx, ['--role', 'reviewer', '--profile', 'max', '--repeat-of', 'sonnet']).model, 'sonnet');
});

test('c2_repeat_decide: the first decision of a role keeps its model, the next one for the same role and focus is repeated work', () => {
  const fx = fixture();
  const cfg = path.join(fx.dir, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^( {2}forbidden_efforts:.*\n)/m, `$1${CAP}`));
  /** @param {string[]} argv @param {boolean} [dispatcher] */
  const cmd = (argv, dispatcher = false) => {
    /** @type {Buffer[]} */ const out = [];
    const base = { env: fx.env, cwd: fx.dir, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: () => true }, scriptPath: path.join(fx.dir, '.agents/scripts/proofline-core.mjs') };
    const code = run(argv, dispatcher ? dispatcherIo(base) : base);
    return { code, out: Buffer.concat(out).toString('latin1') };
  };
  const first = cmd(['decide', 'LC', 'architect', '--dry']);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /^model=gpt-6-astra$/m);
  assert.doesNotMatch(first.out, /REPEAT_CAPPED/);
  assert.equal(cmd(['decide', 'LC', 'architect'], true).code, 0);
  const again = cmd(['decide', 'LC', 'architect', '--dry']);
  assert.match(again.out, /^model=gpt-6-sol$/m, again.out);
  assert.match(again.out, /^model_reason=ROLE_PROFILE,REPEAT_CAPPED$/m, again.out);
  assert.equal(cmd(['decide', 'LC', 'security_reviewer'], true).code, 0);
  assert.match(cmd(['decide', 'LC', 'security_reviewer', '--dry']).out, /^model=opus$/m, 'the security floor holds on a repeat');
});
