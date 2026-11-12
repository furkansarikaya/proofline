// @ts-check
// `decide`, `ledger-note` and `metrics-dispatch` in Node (A226), and the rule that decides who may record a decision (A171): the dispatcher in process, or a live
// ancestor named by a one-use nonce file (Linux /proc, macOS ps; Windows refuses). The scenarios of gates-test.sh sc_decide (shell, through agent.sh) stay as the
// end-to-end check of the same commands; these tests hold the Node implementation to them one by one, in process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { dispatcherIo, isLiveAncestor, nonceAccepted, parentPid } from '../../control-plane/agents/scripts/core/decide.mjs';
import { fixture } from './dispatch-lib.mjs';

/**
 * One command in process. @param {import('./dispatch-lib.mjs').Fixture} fx @param {string[]} argv @param {{ role?: string, env?: Record<string, string>, dispatcher?: boolean }} [o]
 */
function cmd(fx, argv, o = {}) {
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const env = { ...fx.env, ...(o.role ? { AGENT_ROLE: o.role } : {}), ...(o.env ?? {}) };
  const base = { env, cwd: fx.dir, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: path.join(fx.dir, '.agents/scripts/proofline-core.mjs') };
  const code = run(argv, o.dispatcher ? dispatcherIo(base) : base);
  return { code, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString('latin1') };
}
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const decisions = (fx) => { try { return readdirSync(path.join(fx.dir, '.agents/runs/LC/decisions')).sort(); } catch { return []; } };

describe('decide: who may record a decision (A171)', () => {
  const fx = fixture();
  test('a bare decide, called ahead of a dispatch, is refused and writes nothing; --dry reads without writing, the first line is the summary', () => {
    const n = decisions(fx).length;
    const ledgerBefore = fx.ledger();
    const bare = cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'rules+tests']);
    assert.equal(bare.code, 1);
    assert.match(bare.err, /decide refused \(A171\): it records the decision of a dispatch and is not called ahead of one/);
    assert.equal(decisions(fx).length, n);
    const dry = cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--dry']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out.split('\n')[0], /^decision: role=reviewer runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ reason=[A-Za-z_,]+ \(dry run: nothing recorded\)$/);
    assert.match(dry.out, /^model=/m);
    assert.equal(decisions(fx).length, n);
    assert.equal(fx.ledger(), ledgerBefore);
  });
  test('the dispatcher\'s authority (an io only in-process code can make) records the decision: file, ledger event, the output shape', () => {
    const n = decisions(fx).length;
    const r = cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], { dispatcher: true });
    assert.equal(r.code, 0, r.err);
    assert.equal(decisions(fx).length, n + 1);
    const lines = r.out.split('\n');
    assert.match(lines[0], /^decision: role=reviewer runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ reason=[A-Za-z_,]+$/);
    assert.match(r.out, /^focus=rules\+tests\nclass=STANDARD\ntier=[a-z]+\nprofile=balanced\nsignals=\ndecided_at=\d+\n/m);
    assert.match(r.out, /decision_file=\.agents\/runs\/LC\/decisions\/\d{3}-reviewer-rules-tests\.decision\n$/);
    assert.match(fx.ledger(), /event=decide role=lead from=- to=- .*detail=\d{3}-reviewer-rules-tests\.decision runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ signals=$/m);
  });
  test('a plain copy of an authorised io is not authorised, and a hand-set PROOFLINE_DISPATCH does nothing', () => {
    const base = { env: fx.env, cwd: fx.dir, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: path.join(fx.dir, '.agents/scripts/proofline-core.mjs') };
    const authorised = dispatcherIo(base);
    assert.equal(run(['decide', 'LC', 'reviewer', '--focus', 'plan'], { ...authorised }), 1, 'a spread copy is a new object');
    for (const v of ['1', 'abc', '0123456789abcdef', '0123456789abcdef0123456789abcdef']) {
      assert.equal(cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'plan'], { env: { PROOFLINE_DISPATCH: v } }).code, 1, v);
    }
  });
  test('--runtime-reason is the dispatcher\'s alone; a reviewer cannot call decide at all', () => {
    const lead = cmd(fx, ['decide', 'LC', 'reviewer', '--agent-path', '--runtime', 'codex', '--runtime-reason', 'AUTOMATIC_FAILOVER']);
    assert.equal(lead.code, 1); assert.match(lead.err, /dispatch\.sh's alone/);
    assert.match(cmd(fx, ['decide', 'LC', 'reviewer', '--dry', '--runtime', 'codex', '--runtime-reason', 'AUTOMATIC_FAILOVER']).err, /dispatch\.sh's alone/);
    const ok = cmd(fx, ['decide', 'LC', 'reviewer', '--runtime', 'codex', '--runtime-reason', 'AUTOMATIC_FAILOVER'], { dispatcher: true });
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /^runtime_reason=AUTOMATIC_FAILOVER$/m);
    const denied = cmd(fx, ['decide', 'LC', 'reviewer'], { role: 'reviewer' });
    assert.equal(denied.code, 1); assert.match(denied.err, /command denied for reviewer: decide/);
  });
  test('--agent-path records once per step: a second one is refused until a result of that role and focus is recorded; --redecide may decide again', () => {
    const args = ['decide', 'LC', 'reviewer', '--focus', 'rules', '--agent-path'];
    const first = cmd(fx, args);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^via=agent-path\nresults_n=0$/m);
    const second = cmd(fx, args);
    assert.equal(second.code, 1); assert.match(second.err, /no result has been recorded since/); assert.match(second.err, /--redecide/);
    const results = path.join(fx.dir, '.agents/runs/LC/results');
    mkdirSync(results, { recursive: true });
    writeFileSync(path.join(results, '097-reviewer.result.md'), 'FOCUS: plan\n');
    writeFileSync(path.join(results, '096-verifier.result.md'), 'FOCUS: rules\n');
    assert.equal(cmd(fx, args).code, 1, 'a result of another focus or of another role does not release the step');
    writeFileSync(path.join(results, '098-reviewer.result.md'), 'FOCUS: rules\n');
    assert.equal(cmd(fx, args).code, 0, 'a result of this role and focus since the first decision does');
    const redo = cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'rules', '--redecide']);
    assert.equal(redo.code, 0, redo.err);
    assert.match(fx.ledger(), /detail=decide --redecide reviewer focus=rules: the earlier Agent-route decision stays in decisions\//);
    rmSync(results, { recursive: true, force: true });
  });
  test('the Agent path is Claude Code\'s: a role configured for Codex is refused there and sent to dispatch.sh; the refused decision is not persisted', () => {
    const n = decisions(fx).length;
    const r = cmd(fx, ['decide', 'LC', 'implementer', '--agent-path']);
    assert.equal(r.code, 1);
    assert.match(r.err, /decide --agent-path refused \(A200\): the role implementer is configured for the runtime codex, not Claude Code/);
    assert.equal(decisions(fx).length, n);
    assert.equal(cmd(fx, ['decide', 'LC', 'implementer', '--dry']).out.split('\n')[0].includes('runtime=codex'), true, '--dry still reads the codex decision');
  });
  test('usage errors: an unknown flag, a flag without its value, --dry with --agent-path, a role that does not exist, an override the policy refuses', () => {
    for (const a of [['--turbo', 'yes'], ['--focus'], ['--dry', '--agent-path'], ['--model']]) assert.equal(cmd(fx, ['decide', 'LC', 'reviewer', ...a]).code, 1, a.join(' '));
    assert.match(cmd(fx, ['decide', 'LC', 'wizard', '--dry']).err, /invalid role: wizard/);
    const bad = cmd(fx, ['decide', 'LC', 'reviewer', '--agent-path', '--model', 'bogus']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /decision refused by the execution policy \(exit \d\)/);
    assert.equal(cmd(fx, ['decide']).code, 1);
  });
});

describe('decide: the signals it hands the resolver and records', () => {
  const fx = fixture();
  /** the last signals= line: the resolver's own is first, the control plane's record follows it */
  const signals = (/** @type {string[]} */ args) => [...cmd(fx, ['decide', 'LC', ...args, '--dry']).out.matchAll(/^signals=(.*)$/gm)].pop()?.[1];
  test('ui_persuade: the lead names the surface (--ui-mode) or PLAN.md ## UI says visitor_mode; only the designer and the implementer take it', () => {
    assert.equal(signals(['implementer']), '');
    assert.equal(signals(['implementer', '--ui-mode', 'persuade']), 'ui_persuade');
    assert.equal(signals(['designer', '--ui-mode', 'experience']), 'ui_persuade');
    assert.equal(signals(['reviewer', '--ui-mode', 'persuade']), '');
    assert.equal(signals(['implementer', '--ui-mode', 'inform']), '');
    const plan = path.join(fx.dir, '.agents/runs/LC/PLAN.md');
    const keep = readFileSync(plan, 'utf8');
    writeFileSync(plan, `${keep}\n## UI\n\n- visitor_mode: persuade\n`);
    try { assert.equal(signals(['implementer']), 'ui_persuade'); } finally { writeFileSync(plan, keep); }
  });
  test('large_diff: more than 15 changed files', () => {
    for (let i = 0; i < 16; i++) writeFileSync(path.join(fx.dir, `bulk-${i}.txt`), 'x\n');
    try { assert.equal(signals(['implementer']), 'large_diff'); } finally { for (let i = 0; i < 16; i++) rmSync(path.join(fx.dir, `bulk-${i}.txt`)); }
    assert.equal(signals(['implementer']), '');
  });
});

describe('decide: explorer slots (A132)', () => {
  const fx = fixture();
  test('a delivered explorer report holds the slot of a STANDARD run (max_explorers 1): the next explorer is refused, naming what holds it', () => {
    assert.equal(cmd(fx, ['decide', 'LC', 'explorer', '--dry']).code, 0);
    mkdirSync(path.join(fx.dir, '.agents/runs/LC/results'), { recursive: true });
    writeFileSync(path.join(fx.dir, '.agents/runs/LC/results/001-explorer.result.md'), 'RESULT: DONE\n');
    const r = cmd(fx, ['decide', 'LC', 'explorer', '--dry']);
    assert.equal(r.code, 1);
    assert.match(r.err, /decide refused \(A132\): class STANDARD allows 1 explorer slot\(s\) \(pipelines\.STANDARD\.max_explorers\) and run LC holds 1 delivered result\(s\) \( 001-explorer\.result\.md \)and 0 running explorer dispatch\(es\)\./);
    rmSync(path.join(fx.dir, '.agents/runs/LC/results'), { recursive: true, force: true });
  });
  test('a running explorer dispatch holds a slot too; a marker whose process is gone does not', () => {
    const dir = path.join(fx.dir, '.agents/runs/LC/dispatch');
    mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, '001-explorer-claude.running');
    writeFileSync(marker, `pid=${process.pid}\nrole=explorer\ntimeout=60\n`);
    assert.match(cmd(fx, ['decide', 'LC', 'explorer', '--dry']).err, /and 1 running explorer dispatch/);
    writeFileSync(marker, 'pid=999999\nrole=explorer\ntimeout=60\n');
    assert.equal(cmd(fx, ['decide', 'LC', 'explorer', '--dry']).code, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the nonce of another process (A171): a live ancestor, one use', () => {
  const fx = fixture();
  const nn = '0123456789abcdef0123456789abcdef';
  const noAncestor = process.platform === 'win32' ? 'no ancestor can be proven on Windows (no /proc, no ps): the product fails closed, covered by the win32 test below (A171, A262)' : false;
  const file = path.join(fx.dir, '.agents/local/dispatch', `nonce-${nn}`);
  const put = (/** @type {string | number} */ pid) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${pid}\n`); };
  const decide = () => cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], { env: { PROOFLINE_DISPATCH: nn } });
  test('a nonce naming an ancestor (here: this very process) is accepted and consumed; a replay is refused', { skip: noAncestor }, () => {
    put(process.pid);
    const ok = decide();
    assert.equal(ok.code, 0, ok.err);
    assert.equal(existsSync(file), false, 'the nonce is spent');
    assert.equal(decide().code, 1, 'a replayed nonce');
  });
  test('--dry and --agent-path do not consume it', () => {
    put(process.pid);
    assert.equal(cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'plan', '--dry'], { env: { PROOFLINE_DISPATCH: nn } }).code, 0);
    assert.equal(existsSync(file), true);
    rmSync(file);
  });
  test('the pid of a live process that is not an ancestor, pid 1, a dead pid and a file without a pid are refused', async () => {
    const sleeper = spawn('sleep', ['30']);
    try {
      for (const pid of [sleeper.pid ?? 0, 1, 999999, 'x', '']) {
        put(pid);
        assert.equal(decide().code, 1, `pid ${pid}`);
        assert.equal(existsSync(file), true, 'a refused nonce is not consumed');
      }
    } finally { sleeper.kill(); rmSync(file, { force: true }); }
  });
  test('a nonce shorter than 16 characters or not hexadecimal does not count', () => {
    for (const bad of ['0123456789abcde', '0123456789abcdeg0123456789abcdef']) {
      const f = path.join(fx.dir, '.agents/local/dispatch', `nonce-${bad}`);
      mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, `${process.pid}\n`);
      assert.equal(cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'plan'], { env: { PROOFLINE_DISPATCH: bad } }).code, 1, bad);
      rmSync(f);
    }
  });
  test('an ancestor is found through /proc or ps: the parent of this process is its parent, and a child of ours has us as its ancestor', { skip: noAncestor }, async () => {
    assert.equal(parentPid(process.pid), process.ppid);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    try {
      assert.equal(parentPid(/** @type {number} */ (child.pid)), process.pid);
      assert.equal(isLiveAncestor(process.pid, process.platform, /** @type {number} */ (child.pid)), true);
      assert.equal(isLiveAncestor(/** @type {number} */ (child.pid), process.platform, process.pid), false, 'a child is not an ancestor');
    } finally { child.kill(); }
  });
  test('Windows: no ancestor can be proven, so a call from another process fails closed; only the in-process dispatcher records', () => {
    assert.equal(isLiveAncestor(process.pid, 'win32', process.pid), false);
    assert.equal(parentPid(process.pid, 'win32'), null);
    put(process.pid);
    const ctx = new Context({ env: { ...fx.env, PROOFLINE_DISPATCH: nn }, cwd: fx.dir, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(fx.dir, '.agents/scripts/proofline-core.mjs'));
    assert.equal(nonceAccepted(ctx, false, 'win32'), false);
    assert.equal(nonceAccepted(ctx, false, 'linux'), true);
    rmSync(file, { force: true });
    assert.equal(cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'plan'], { dispatcher: true }).code, 0, 'in process it works on every platform');
  });
  test('the old sweep of stale nonce files is gone: nothing writes a nonce any more, and nothing here removes another one\'s', () => {
    put(process.pid);
    utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
    cmd(fx, ['decide', 'LC', 'reviewer', '--focus', 'plan', '--dry']);
    assert.equal(existsSync(file), true);
    rmSync(file, { force: true });
  });
});

describe('ledger-note and metrics-dispatch', () => {
  const fx = fixture();
  test('ledger-note: lead only, needs text, ledgers a note in the run\'s state; the text is cleaned of tabs and newlines', () => {
    const r = cmd(fx, ['ledger-note', 'LC', 'a note\twith\ttabs']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'ledger note recorded: LC\n');
    assert.match(fx.ledger(), /event=note role=lead from=IMPLEMENTING to=IMPLEMENTING .*detail=a note with tabs$/m);
    assert.equal(cmd(fx, ['ledger-note', 'LC', '   ']).code, 1);
    assert.match(cmd(fx, ['ledger-note', 'LC', '   ']).err, /ledger-note needs text/);
    assert.equal(cmd(fx, ['ledger-note', 'LC', 'x'], { role: 'reviewer' }).code, 1);
    assert.equal(cmd(fx, ['ledger-note', 'NOPE', 'x']).code, 1);
    assert.equal(cmd(fx, ['ledger-note', 'LC']).code, 1);
  });
  test('metrics-dispatch: numbers kept, strings cut to [A-Za-z0-9._+:-] (a secret in a model name does not reach the file), absent or non-numeric usage is null, non-lead refused', () => {
    const f = path.join(fx.dir, '.agents/local/metrics/records.jsonl');
    rmSync(path.dirname(f), { recursive: true, force: true });
    assert.equal(cmd(fx, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet"; sk-LIVE secret', '12', '100', '50', '150', '3', '1', 'submitted']).code, 0);
    assert.match(readFileSync(f, 'utf8').trim(), /"kind":"dispatch","time":"[0-9T:Z-]*","task":"LC","role":"reviewer","focus":"rules","gate":"REVIEW_RULES","runtime":"claude","model":"sonnetsk-LIVEsecret","duration_s":12,"tokens_in":100,"tokens_out":50,"tokens_total":150,"turns":3,"retries":1,"delegations":null,"fix_rounds":null,"result":"submitted"/);
    cmd(fx, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet', '12', '', '', '', 'abc', '0', 'submitted']);
    assert.match(readFileSync(f, 'utf8').trim().split('\n').pop() ?? '', /"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":0/);
    assert.equal(cmd(fx, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet', '1', '-', '-', '-', '-', '0', 'submitted'], { role: 'reviewer' }).code, 1);
    assert.match(cmd(fx, ['metrics-dispatch', 'LC', 'reviewer']).err, /usage: agent\.sh metrics-dispatch/);
  });
  test('metrics: off writes nothing', () => {
    const f = path.join(fx.dir, '.agents/local/metrics/records.jsonl');
    rmSync(path.dirname(f), { recursive: true, force: true });
    fx.setConfig({ extra: {} });
    const cfg = path.join(fx.dir, '.agents/config.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^metrics: on$/m, 'metrics: off'));
    cmd(fx, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet', '12', '1', '1', '2', '1', '0', 'submitted']);
    assert.equal(existsSync(f), false);
  });
});
