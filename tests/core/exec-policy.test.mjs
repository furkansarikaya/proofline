// @ts-check
// The execution-policy resolver and the runtime detection in Node (A222; the shell files exec-policy.sh, exec-policy-test.sh and runtime-detect.sh are gone).
//  - golden: 700 calls recorded once from the shell resolver of 0.0.52 against ten config variants (golden/exec-policy-record.mjs); the Node resolver
//    must give the recorded stdout, stderr and status. Nothing compares with a shell at test time.
//  - the rules exec-policy-test.sh stated, as absolute assertions (precedence, floors, caps, escalation, failover label, lead base, runtime table);
//  - the fixture stub: while .agents/scripts/exec-policy.sh exists the core runs it; without it no environment value changes a decision (D14);
//  - runtime detection: the two built-in binaries, a command template, the version line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { policyCommand } from '../../control-plane/agents/scripts/core/execpolicy.mjs';
import { runtimeDetect } from '../../control-plane/agents/scripts/core/runtimedetect.mjs';
import { makeProject, memoryIo, repo, scriptsDir } from './helpers.mjs';

const gold = path.join(import.meta.dirname, 'golden/exec-policy');
const core = path.join(scriptsDir, 'proofline-core.mjs');
const made = /** @type {string[]} */ ([]);
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A context on a project whose config and roles table are the given files. @param {string} [config] @param {Record<string, string>} [env] */
function project(config = 'base', env = {}) {
  const root = makeProject(readFileSync(path.join(gold, `config-${config}.yaml`), 'utf8'));
  made.push(root);
  copyFileSync(path.join(gold, 'roles.conf'), path.join(root, '.agents/roles.conf'));
  const { io } = memoryIo(root, env);
  return { root, ctx: new Context(io, io.scriptPath) };
}
/** @param {Context} ctx @param {string[]} args */
const policy = (ctx, args) => policyCommand(ctx, args);
const kvOf = (/** @type {string} */ out, /** @type {string} */ k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out) ?? [])[1];

describe('golden: the answers of the shell resolver', () => {
  /** @type {Array<{ config: string, args: string[], stdin?: string, status: number, stdout: string, stderr: string }>} */
  const cases = JSON.parse(gunzipSync(readFileSync(path.join(gold, 'cases.json.gz'))).toString('utf8'));
  test(`${cases.length} recorded calls give the recorded stdout, stderr and status`, () => {
    const { ctx } = project();
    let bad = 0;
    for (const c of cases) {
      const cfg = c.config === '(missing)' ? path.join(gold, 'no-such-config.yaml') : path.join(gold, `config-${c.config}.yaml`);
      const r = policyCommand(ctx, ['--config', cfg, ...c.args], c.stdin ?? '');
      const got = { status: r.status, stdout: r.out.split(gold).join('<DIR>'), stderr: r.err.split(gold).join('<DIR>') };
      try { assert.deepEqual(got, { status: c.status, stdout: c.stdout, stderr: c.stderr }, `${c.config}: ${c.args.join(' ')}`); } catch (e) { if (bad++ < 5) console.error(String(/** @type {Error} */ (e).message).slice(0, 800)); }
    }
    assert.equal(bad, 0, `${bad} calls differ from the recording`);
  });
  test('the corpus holds every exit status of the resolver (0, 2, 3, 4)', () => {
    assert.deepEqual([...new Set(cases.map((c) => c.status))].sort(), [0, 2, 3, 4]);
  });
});

describe('the rules of the resolver', () => {
  const R = (/** @type {Context} */ ctx, /** @type {string[]} */ extra, role = 'implementer', cls = 'STANDARD') => policy(ctx, ['resolve', '--role', role, '--class', cls, '--tier', 'full', ...extra]);

  test('the default decision names its reasons; an operator override wins and is labelled', () => {
    const { ctx } = project();
    const d = R(ctx, []);
    assert.equal(d.status, 0);
    assert.match(d.out, /^profile_reason=CONFIG_PROFILE$/m);
    assert.match(d.out, /^runtime_reason=CONFIG_RUNTIME_GROUP$/m);
    const o = R(ctx, ['--runtime', 'codex', '--model', 'gpt-6-sol']);
    assert.equal(kvOf(o.out, 'runtime'), 'codex');
    assert.equal(kvOf(o.out, 'model'), 'gpt-6-sol');
    assert.equal(kvOf(o.out, 'model_reason'), 'OPERATOR_OVERRIDE');
    assert.equal(kvOf(o.out, 'runtime_reason'), 'OPERATOR_OVERRIDE');
  });
  test('hard limits: a model below the role floor, a forbidden or unknown effort, a bad override are refused with their own statuses', () => {
    const { ctx } = project();
    const below = R(ctx, ['--model', 'haiku'], 'security_reviewer', 'STANDARD');
    assert.equal(below.status, 4); assert.match(below.err, /UNRESOLVABLE CAPABILITY_FLOOR_UNMET/);
    const forbidden = R(ctx, ['--effort', 'ultra']);
    assert.equal(forbidden.status, 3); assert.match(forbidden.err, /REJECTED FORBIDDEN_EFFORT/);
    assert.equal(R(ctx, ['--effort', 'zz']).status, 3);
    assert.equal(R(ctx, ['--model', 'nope']).status, 3);
    assert.equal(R(ctx, ['--context-bytes', '0']).status, 3);
    assert.equal(R(ctx, ['--profile', 'zzz']).status, 3);
    assert.equal(R(ctx, ['--bogus', 'x']).status, 2);
    assert.equal(R(ctx, ['--signal', 'bogus']).status, 2);
  });
  test('the context budget: the class budget, halved for docs, capped by the hard limit', () => {
    const { ctx } = project();
    assert.equal(kvOf(policy(ctx, ['resolve', '--role', 'implementer', '--class', 'STANDARD', '--tier', 'full']).out, 'context_bytes'), '49152');
    assert.equal(kvOf(policy(ctx, ['resolve', '--role', 'implementer', '--class', 'STANDARD', '--tier', 'docs']).out, 'context_bytes'), '24576');
    const capped = R(ctx, ['--context-bytes', '99999999']);
    assert.equal(kvOf(capped.out, 'context_bytes'), '262144'); assert.match(capped.out, /context_reason=OPERATOR_OVERRIDE,CAPPED_AT_HARD_LIMIT/);
  });
  test('escalation: a signal raises one step, the budget stops it, a CRITICAL class carries its own signal, ui_persuade is a placement', () => {
    const { ctx } = project();
    const plain = R(ctx, []);
    const up = R(ctx, ['--signal', 'large_diff']);
    assert.equal(kvOf(up.out, 'escalated'), 'yes');
    assert.notEqual(kvOf(up.out, 'model'), kvOf(plain.out, 'model'));
    const spent = R(ctx, ['--signal', 'large_diff', '--escalations-used', '2']);
    assert.equal(kvOf(spent.out, 'escalation_reason'), 'ESCALATION_BUDGET_EXHAUSTED'); assert.equal(kvOf(spent.out, 'model'), kvOf(plain.out, 'model'));
    assert.match(R(ctx, [], 'implementer', 'CRITICAL').out, /^signals=critical_class$/m);
    const ui = R(ctx, ['--signal', 'ui_persuade']);
    assert.equal(kvOf(ui.out, 'model'), 'opus'); assert.match(ui.out, /UI_PERSUADE_STRONGEST/); assert.equal(kvOf(ui.out, 'escalated'), 'no');
    assert.equal(kvOf(R(ctx, ['--signal', 'ui_persuade'], 'reviewer').out, 'model_reason'), 'ROLE_PROFILE');
  });
  test('the failover label is for an automatic failover only, and needs the runtime it fails over to', () => {
    const { ctx } = project();
    assert.equal(kvOf(R(ctx, ['--runtime', 'codex', '--runtime-reason', 'AUTOMATIC_FAILOVER']).out, 'runtime_reason'), 'AUTOMATIC_FAILOVER');
    assert.equal(kvOf(R(ctx, ['--runtime-reason', 'AUTOMATIC_FAILOVER']).out, 'runtime_reason'), 'CONFIG_RUNTIME_GROUP');
    assert.equal(R(ctx, ['--runtime-reason', 'OTHER']).status, 3);
  });
  test('the runtime table: runtime.roles.<role> over runtime.<group> over claude', () => {
    const { ctx } = project('role-codex');
    assert.equal(policy(ctx, ['runtime', 'implementer']).out, 'codex\n');
    assert.equal(policy(ctx, ['runtime', 'qa']).out, 'codex\n');
    assert.equal(policy(ctx, ['runtime', 'reviewer']).out, 'claude\n');
    assert.equal(policy(ctx, ['runtime', 'implementation_worker']).out, 'codex\n', 'a source role name is accepted');
  });
  test('a Codex lead needs the base model: a cheaper model and an unset model are refused', () => {
    const { ctx } = project();
    assert.equal(policy(ctx, ['lead-base', 'codex']).out, 'gpt-6-sol\n');
    assert.equal(policy(ctx, ['lead-base', 'claude']).out, '');
    assert.equal(policy(ctx, ['check-lead', '--runtime', 'codex', '--model', 'gpt-6-sol']).status, 0);
    assert.equal(policy(ctx, ['check-lead', '--runtime', 'codex', '--model', 'gpt-6-astra']).status, 0);
    assert.match(policy(ctx, ['check-lead', '--runtime', 'codex', '--model', 'gpt-6-luna']).err, /LEAD_BELOW_BASE/);
    assert.match(policy(ctx, ['check-lead', '--runtime', 'codex']).err, /LEAD_MODEL_UNSET/);
    assert.equal(policy(ctx, ['check-lead', '--runtime', 'claude']).status, 0, 'only codex is enforced');
    // an older config without the key: the base is derived from the ladder and the lead floor of roles.conf
    assert.equal(policy(project('no-lead-base').ctx, ['lead-base', 'codex']).out, 'gpt-6-sol\n');
  });
  test('check-capabilities compares the ladder with the local Codex model cache and says so without one', () => {
    const { ctx, root } = project();
    const none = policy(ctx, ['check-capabilities']);
    assert.match(none.out, /no local Codex model cache at/);
    const cache = path.join(root, 'models_cache.json');
    const level = (/** @type {string[]} */ e) => e.map((effort) => ({ effort }));
    writeFileSync(cache, JSON.stringify({ models: [
      { slug: 'gpt-6-luna', supported_reasoning_levels: level(['none', 'low', 'medium', 'high', 'xhigh']) },
      { slug: 'gpt-6-sol', supported_reasoning_levels: level(['none', 'low', 'medium', 'high']) },
    ] }));
    const { io } = memoryIo(root, { CODEX_MODELS_CACHE: cache });
    const r = policyCommand(new Context(io, io.scriptPath), ['check-capabilities']);
    assert.equal(r.status, 1);
    assert.match(r.out, /UNSUPPORTED effort xhigh for gpt-6-sol/);
    assert.match(r.out, /MISSING model in local Codex cache: gpt-6-astra/);
  });
});

describe('the shipped tables (control-plane/agents/config.yaml and roles.conf)', () => {
  /** A context on the shipped config and roles table, with the given edits of the two files. @param {(t: string) => string} [cfgEdit] @param {(t: string) => string} [rolesEdit] */
  function shipped(cfgEdit = (t) => t, rolesEdit = (t) => t) {
    const root = makeProject(cfgEdit(readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'utf8'))); made.push(root);
    writeFileSync(path.join(root, '.agents/roles.conf'), rolesEdit(readFileSync(path.join(repo, 'control-plane/agents/roles.conf'), 'utf8')));
    const { io } = memoryIo(root);
    return new Context(io, io.scriptPath);
  }
  const base = ['--class', 'STANDARD', '--tier', 'full'];
  const res = (/** @type {Context} */ ctx, /** @type {string[]} */ a) => policyCommand(ctx, ['resolve', ...a]);

  test('every role, profile and runtime resolves; security stays on tier 3; the economy profile does not use opus (but for security)', () => {
    const ctx = shipped();
    const bad = [];
    for (const r of ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier']) {
      for (const pr of ['balanced', 'max', 'economy']) {
        for (const rt of ['claude', 'codex']) {
          const d = res(ctx, ['--role', r, ...base, '--profile', pr, '--runtime', rt]);
          if (d.status !== 0) { bad.push(`${r}/${pr}/${rt}`); continue; }
          if (r === 'security_reviewer' && kvOf(d.out, 'capability_tier') !== '3') bad.push(`${r}/${pr}/${rt}:tier`);
          if (pr === 'economy' && r !== 'security_reviewer' && kvOf(d.out, 'model') === 'opus') bad.push(`${r}/economy:opus`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
  test('the shipped lead row is the base model or stronger; a lead on the cheapest model is unresolvable, a worker on it is fine', () => {
    const ctx = shipped();
    for (const [pr, tier] of [['balanced', '3'], ['max', '3'], ['economy', '2']]) assert.equal(kvOf(res(ctx, ['--role', 'lead', ...base, '--profile', pr, '--runtime', 'codex']).out, 'capability_tier'), tier, pr);
    assert.match(res(ctx, ['--role', 'lead', ...base, '--runtime', 'codex', '--model', 'gpt-6-luna']).err, /CAPABILITY_FLOOR_UNMET/);
    assert.equal(kvOf(res(ctx, ['--role', 'explorer', ...base, '--profile', 'economy', '--runtime', 'codex', '--model', 'gpt-6-luna']).out, 'model'), 'gpt-6-luna');
  });
  test('a runtime whose ladder lacks the top model cannot serve a tier-3 role, and a role model above the top is unresolvable', () => {
    const ctx = shipped((t) => t.replace('models: gpt-6-luna gpt-6-sol gpt-6-astra', 'models: gpt-6-luna gpt-6-sol'));
    assert.match(res(ctx, ['--role', 'security_reviewer', ...base, '--runtime', 'codex']).err, /CAPABILITY_FLOOR_UNMET/);
    assert.match(res(ctx, ['--role', 'architect', ...base, '--runtime', 'codex']).err, /NO_MODEL_AT_TIER/);
    assert.match(res(ctx, ['--role', 'reviewer', ...base, '--runtime', 'nosuch']).err, /NO_LADDER/);
  });
  test('a missing runtime row in roles.conf is mapped by capability tier; a missing role is unresolvable', () => {
    const ctx = shipped((t) => t, (t) => t.split('\n').filter((l) => !l.startsWith('reviewer balanced codex')).join('\n'));
    const d = res(ctx, ['--role', 'reviewer', ...base, '--runtime', 'codex']);
    assert.equal(kvOf(d.out, 'model'), 'gpt-6-sol'); assert.equal(kvOf(d.out, 'model_reason'), 'ROLE_TIER_MAPPED');
    const none = shipped((t) => t, (t) => t.split('\n').filter((l) => !l.startsWith('reviewer ')).join('\n'));
    assert.match(res(none, ['--role', 'reviewer', ...base]).err, /NO_ROLE_POLICY/);
  });
  test('usage errors, a determinate answer and `runtime <role>` agreeing with resolve', () => {
    const ctx = shipped();
    assert.match(res(ctx, ['--role', 'wizard', ...base]).err, /unknown role/);
    assert.match(res(ctx, ['--role', 'reviewer', '--class', 'HUGE', '--tier', 'full']).err, /classes/);
    assert.equal(res(ctx, ['--role', 'reviewer', ...base]).out, res(ctx, ['--role', 'reviewer', ...base]).out);
    for (const r of ['explorer', 'architect', 'implementer', 'reviewer', 'security_reviewer', 'verifier']) {
      assert.equal(kvOf(res(ctx, ['--role', r, ...base]).out, 'runtime'), policyCommand(ctx, ['runtime', r]).out.trim(), r);
    }
  });
});

describe('the fixture stub and the environment (D14)', () => {
  const STUB = '#!/bin/sh\n[ "${1:-}" = resolve ] || exit 2\nprintf "runtime=stub\\nmodel=stubmodel\\n"\n';
  test('while .agents/scripts/exec-policy.sh exists the core runs it and relays its output and status', () => {
    const { ctx, root } = project();
    writeFileSync(path.join(root, '.agents/scripts/exec-policy.sh'), STUB);
    const r = policyCommand(ctx, ['resolve', '--role', 'lead', '--class', 'STANDARD', '--tier', 'full']);
    assert.deepEqual([r.status, r.out], [0, 'runtime=stub\nmodel=stubmodel\n']);
    assert.equal(policyCommand(ctx, ['runtime', 'lead']).status, 2, 'the stub knows only resolve');
  });
  test('without a stub, no PROOFLINE_TEST* (or resolver-named) environment value changes a decision', () => {
    const args = ['resolve', '--role', 'implementer', '--class', 'COMPLEX', '--tier', 'full', '--signal', 'large_diff'];
    const plain = policyCommand(project().ctx, args);
    assert.equal(plain.status, 0);
    const odd = { PROOFLINE_TEST: '1', PROOFLINE_TEST_RUNTIME: 'codex', PROOFLINE_TEST_MODEL: 'haiku', PROOFLINE_TEST_PROFILE: 'economy', PROOFLINE_TESTING: 'yes',
      EXEC_POLICY_CONFIG: path.join(gold, 'config-profile-max.yaml'), EXEC_POLICY_ROLES: '/nonexistent', STUB_ARGS: '/dev/null', PROOFLINE_CODEX_BIN: '/bin/true', PROOFLINE_CLAUDE_BIN: '/bin/false' };
    assert.deepEqual(policyCommand(project('base', odd).ctx, args), plain);
  });
  test('the command is reachable from the process entry as `cli exec-policy` and `cli runtime-detect`, with the exit status of the resolver', () => {
    const { root } = project();
    const scripts = path.join(root, '.agents/scripts');
    copyFileSync(core, path.join(scripts, 'proofline-core.mjs'));
    cpSync(path.join(scriptsDir, 'core'), path.join(scripts, 'core'), { recursive: true });
    const cli = (/** @type {string[]} */ a, /** @type {string} */ input = '') => spawnSync(process.execPath, [path.join(scripts, 'proofline-core.mjs'), 'cli', ...a], { cwd: root, encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '' } });
    const ok = cli(['exec-policy', 'resolve', '--role', 'implementer', '--class', 'STANDARD', '--tier', 'full']);
    assert.equal(ok.status, 0); assert.match(ok.stdout, /^model=/m);
    assert.equal(cli(['exec-policy', 'resolve', '--role', 'implementer', '--class', 'STANDARD', '--tier', 'full', '--effort', 'ultra']).status, 3);
    assert.equal(cli(['exec-policy', 'bogus']).status, 2);
    assert.match(cli(['exec-policy', 'explain'], 'model_reason=ESCALATED\n').stdout, /^model_reason: ESCALATED - one step up/m);
    assert.equal(cli(['runtime-detect', 'has', 'definitely-not-installed']).status, 1);
  });
});

describe('runtime detection', () => {
  /** A project with a fake claude on the PATH. */
  function withBin(/** @type {string} */ config = 'canonical_branch: main\n') {
    const root = makeProject(config); made.push(root);
    const bin = mkdtempSync(path.join(tmpdir(), 'rt-bin-')); made.push(bin);
    const fake = path.join(bin, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\necho "fake 1.2.3"\necho second\n'); chmodSync(fake, 0o755);
    return { root, bin, fake };
  }
  const ctxOf = (/** @type {string} */ root, /** @type {Record<string, string>} */ env) => { const { io } = memoryIo(root, env); return new Context(io, io.scriptPath); };

  test('has and bin: the default names, PROOFLINE_CLAUDE_BIN / PROOFLINE_CODEX_BIN, a name that is not installed', () => {
    const { root, bin, fake } = withBin();
    const ctx = ctxOf(root, { PATH: bin, PROOFLINE_CLAUDE_BIN: 'fake-claude' });
    assert.deepEqual(runtimeDetect(ctx, ['bin', 'claude']), { status: 0, out: 'fake-claude\n', err: '' });
    assert.equal(runtimeDetect(ctx, ['has', 'claude']).status, 0);
    assert.equal(runtimeDetect(ctx, ['has', 'codex']).status, 1);
    assert.equal(runtimeDetect(ctxOf(root, { PATH: bin, PROOFLINE_CODEX_BIN: fake }), ['has', 'codex']).status, 0, 'a path with a slash counts when it is executable');
    assert.equal(runtimeDetect(ctx, ['has', 'nothing']).status, 1);
    assert.equal(runtimeDetect(ctx, ['has']).status, 2);
    assert.equal(runtimeDetect(ctx, ['frob']).status, 2);
  });
  test('the list: one line per built-in runtime with the path and the first line of --version', () => {
    const { root, bin, fake } = withBin();
    const r = runtimeDetect(ctxOf(root, { PATH: bin, PROOFLINE_CLAUDE_BIN: 'fake-claude' }), []);
    assert.equal(r.out, `claude installed=yes path=${bin}/fake-claude version=fake 1.2.3\ncodex installed=no path=- version=-\n`);
    void fake;
  });
  test('a runtime with a dispatch.command_template counts as installed when the first word is on PATH', () => {
    const { root, bin } = withBin('dispatch:\n  timeout_seconds: 5400\n  command_template:\n    mycli: fake-claude run --model {model}\n    other: nope-cli x\n  claude_permission_mode: acceptEdits\n');
    const ctx = ctxOf(root, { PATH: bin });
    assert.deepEqual(runtimeDetect(ctx, ['bin', 'mycli']), { status: 0, out: 'fake-claude\n', err: '' });
    assert.equal(runtimeDetect(ctx, ['has', 'mycli']).status, 0);
    assert.equal(runtimeDetect(ctx, ['has', 'other']).status, 1);
    assert.equal(runtimeDetect(ctx, ['bin', 'unlisted']).status, 1);
    mkdirSync(path.join(root, 'x'), { recursive: true });
  });
});
