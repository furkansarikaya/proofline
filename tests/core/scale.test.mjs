// @ts-check
// `proofline doctor --scale` / `--apply-scale` (A202 item 29, A230; the former bin/lib/timeouts.sh and `hook_timeouts_apply` of bin/lib/install.sh): this machine is measured,
// a value for timeouts.scale is proposed with one question, and only the user's own "approve scale" writes it, once, together with the hook limits of the settings files.
// Absolute expectations; the real control plane in a throwaway project, the project's own core run as `bin/proofline` runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanEnv } from '../hook/harness.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { applyHookTimeouts, measureMachine, proposeScale, suggestScale } from '../../control-plane/agents/scripts/core/scale.mjs';
import { A, project, say } from './legacy-lib.mjs';
import { RECIPE } from './helper-lib.mjs';

/** @param {string} d @param {string[]} args */
function cli(d, args) {
  const r = spawnSync('node', ['.agents/scripts/proofline-core.mjs', 'cli', ...args], { cwd: d, env: cleanEnv({}), encoding: 'utf8', input: '', timeout: 120000 });
  return { status: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}
const proposal = (/** @type {string} */ d) => path.join(d, '.agents/local/scale/PROPOSAL.tsv');
const agentSh = (/** @type {string} */ d) => path.join(d, '.agents/scripts/agent.sh');
const scaleOf = (/** @type {string} */ d) => (/^ {2}scale: *(.*)$/m.exec(readFileSync(path.join(d, '.agents/config.yaml'), 'utf8')) ?? [])[1];

const HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node .agents/hooks/proofline-hook.mjs session', timeout: 5 }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .agents/hooks/proofline-hook.mjs pretool', timeout: 5 }, { type: 'command', command: 'other-tool check', timeout: 7 }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'node .agents/hooks/proofline-hook.mjs session', timeout: 1 }] }],
  },
  permissions: { allow: ['Bash(ls)'] },
};
/** @param {string} d @param {string} rel @param {unknown} json */
function settings(d, rel, json) { mkdirOf(path.join(d, rel)); writeFileSync(path.join(d, rel), `${JSON.stringify(json, null, 2)}\n`); }
/** @param {string} f */
function mkdirOf(f) { spawnSync('mkdir', ['-p', path.dirname(f)]); }

test('suggestScale: nothing below 1.5 times the reference, rounded up to a half, at most 10', () => {
  // reference 500 + 250 ms
  assert.equal(suggestScale(500, 250), '');
  assert.equal(suggestScale(1000, 100), '1.5');   // 1100 / 750 = 1.47, rounded up to the half 1.5
  assert.equal(suggestScale(1125, 0), '1.5');     // 1.5 exactly
  assert.equal(suggestScale(1126, 0), '2');       // just above 1.5 rounds up to 2
  assert.equal(suggestScale(900, 600), '2');      // 2.0 exactly
  assert.equal(suggestScale(1500, 750), '3');
  assert.equal(suggestScale(2000, 1000), '4');
  assert.equal(suggestScale(1800, 0), '2.5');
  assert.equal(suggestScale(100000, 100000), '10');
  assert.equal(suggestScale(0, 0), '');
});

/** The propose step in this process with a measurement given by the test (A253): nothing is timed. @param {string} d @param {[number, number]} ms @returns {{ status: number, out: string }} */
function propose(d, ms) {
  /** @type {Buffer[]} */ const out = [];
  const io = { env: cleanEnv({}), cwd: d, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => out.push(b) } };
  const ctx = new Context(io, agentSh(d));
  const status = proposeScale(ctx, { measure: () => ms });
  ctx.flush();
  return { status, out: Buffer.concat(out).toString('latin1') };
}

test('measureMachine: the steps it starts, and the smaller of two measurements for each of the two quantities, by the clock it is given', () => {
  const calls = /** @type {string[]} */ ([]);
  let t = 0;
  // cost of each start of agent.sh, in order: fingerprint, approve-pending, config-check, fingerprint, approve-pending, config-check
  const steps = [100, 300, 250, 50, 150, 400];   // approval path: 400 then 200; start: 250 then 400
  const r = measureMachine(/** @type {any} */ ({ root: '/p', env: {} }), { now: () => t, run: (argv) => { calls.push(argv.slice(1).join(' ')); t += steps[calls.length - 1]; } });
  assert.deepEqual(calls, ['fingerprint', 'approve-pending -', 'config-check', 'fingerprint', 'approve-pending -', 'config-check']);
  assert.deepEqual(r, [200, 250]);
});

test('a machine that is not slow: no proposal, the old one is removed, and nothing is asked', () => {
  const d = project(RECIPE);
  mkdirOf(proposal(d)); writeFileSync(proposal(d), 'scale\t3\n');
  const r = propose(d, [400, 200]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, 'timing: approval path 400 ms (reference 500), agent.sh start 200 ms (reference 250); timeouts.scale is 1.0 now\nscale: this machine is not slow (within 1.5 times the reference); timeouts.scale 1.0 fits, nothing to change\n');
  assert.equal(existsSync(proposal(d)), false);
});

test('the boundary of "not slow" is the sum of the two references; one millisecond more proposes 1.5', () => {
  const d = project(RECIPE);
  assert.match(propose(d, [500, 250]).out, /not slow/);
  assert.equal(existsSync(proposal(d)), false);
  assert.match(propose(d, [500, 251]).out, /timeouts\.scale 1\.0 -> 1\.5 /);
  assert.equal(readFileSync(proposal(d), 'utf8'), 'scale\t1.5\n');
});

test('the real command prints the timing line in the documented shape (the numbers are the machine\'s and are not asserted)', () => {
  const d = project(RECIPE);
  const r = cli(d, ['doctor-scale', 'propose']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^timing: approval path \d+ ms \(reference 500\), agent\.sh start \d+ ms \(reference 250\); timeouts\.scale is 1\.0 now\n/);
});

test('a slow machine: one proposal bound to the value alone, one question, the approval request recorded; the config is untouched until the reply', () => {
  const d = project(RECIPE);
  const r = propose(d, [1200, 600]);
  assert.equal(r.status, 0, r.out);
  // (1200 + 600) / 750 = 2.4, rounded up to the half 2.5
  assert.match(r.out, /^timing: approval path 1200 ms \(reference 500\), agent\.sh start 600 ms \(reference 250\); timeouts\.scale is 1\.0 now\n\nscale proposal [0-9a-f]{12}: timeouts\.scale 1\.0 -> 2\.5 \(every step time, build and test limit, lock wait and hook limit grows by that factor; the approval budget does not\)\nQUESTION \(one\): write timeouts\.scale: 2\.5 into \.agents\/config\.yaml\? Reply "approve scale"\. Nothing is written without your reply\./);
  assert.match(r.out, /\n {2}after your reply: proofline doctor --apply-scale\n$/);
  assert.equal(readFileSync(proposal(d), 'utf8'), 'scale\t2.5\n');
  assert.equal(scaleOf(d), '1.0');
  // no reply yet
  const early = cli(d, ['doctor-scale', 'apply']);
  assert.equal(early.status, 1);
  assert.match(early.err, /proofline: doctor --apply-scale: the user has not agreed to this proposal yet; ask the one question and wait for the reply "approve scale"\n$/);
  assert.equal(scaleOf(d), '1.0');
});

test('the user\'s own "approve scale" writes the value once and puts the new limits into the settings files, and nothing else in them changes', () => {
  const d = project(RECIPE);
  settings(d, '.claude/settings.json', HOOKS);
  settings(d, '.codex/hooks.json', { hooks: { Stop: [{ hooks: [{ command: 'node .agents/hooks/proofline-hook.mjs stop', timeout: 1 }] }] } });
  assert.equal(propose(d, [1200, 600]).status, 0);
  const want = (/^scale\t(.*)$/m.exec(readFileSync(proposal(d), 'utf8')) ?? [])[1];
  assert.equal(want, '2.5');
  say(d, 'approve scale');
  assert.equal(A(d, ['approve-pending']).status, 0);
  const done = cli(d, ['doctor-scale', 'apply']);
  assert.equal(done.status, 0, done.text);
  assert.equal(done.out, `wrote timeouts.scale: ${want}\nconfig valid: .agents/config.yaml\n`);
  assert.equal(scaleOf(d), want);
  const factor = Number(want);
  const j = JSON.parse(readFileSync(path.join(d, '.claude/settings.json'), 'utf8'));
  assert.equal(j.hooks.SessionStart[0].hooks[0].timeout, 30 * factor);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].timeout, 30 * factor);
  assert.equal(j.hooks.PreToolUse[0].hooks[1].timeout, 7);                        // not a proofline hook
  assert.equal(j.hooks.Notification[0].hooks[0].timeout, 1);                      // not a proofline event
  assert.deepEqual(j.permissions, HOOKS.permissions);
  assert.equal(JSON.parse(readFileSync(path.join(d, '.codex/hooks.json'), 'utf8')).hooks.Stop[0].hooks[0].timeout, 30 * factor);
  assert.equal(existsSync(proposal(d)), false);
  assert.equal(readdirSync(path.join(d, '.agents/local/scale')).filter((f) => /^applied-[0-9]+\.tsv$/.test(f)).length, 1);
  const again = cli(d, ['doctor-scale', 'apply']);
  assert.equal(again.status, 1);
  assert.match(again.err, /proofline: doctor --apply-scale: no scale proposal \(run: proofline doctor --scale\)\n$/);
});

test('a proposal that holds no valid scale is refused even with the reply, and the value already set is not proposed again', () => {
  const d = project(RECIPE);
  writeFileSync(path.join(d, '.agents/config.yaml'), readFileSync(path.join(d, '.agents/config.yaml'), 'utf8').replace(/^ {2}scale: .*$/m, '  scale: 2'));
  // measured 2.0 exactly: the value set already
  const same = propose(d, [1000, 500]);
  assert.match(same.out, /timeouts\.scale is 2 now\n/);
  assert.match(same.out, /scale: the measured value 2 is the one set already\n$/);
  assert.equal(existsSync(proposal(d)), false);
  // measured 2.5: a proposal, which the next lines turn into garbage
  assert.match(propose(d, [1200, 600]).out, /timeouts\.scale 2 -> 2\.5 /);
  writeFileSync(proposal(d), 'scale\t2x\n');
  assert.equal(A(d, ['request-approval', '-', 'scale']).status, 0);
  say(d, 'approve scale');
  assert.equal(A(d, ['approve-pending']).status, 0);
  const bad = cli(d, ['doctor-scale', 'apply']);
  assert.equal(bad.status, 1);
  assert.match(bad.err, /proofline: doctor --apply-scale: the proposal holds no valid scale\n$/);
  assert.equal(scaleOf(d), '2');
  assert.equal(cli(d, ['doctor-scale']).status, 2);
  assert.equal(cli(d, ['doctor-scale', 'bogus']).status, 2);
});

// ---- the hook limits of a settings file (the former hook_timeouts_apply) ----
test('applyHookTimeouts: sets only proofline hooks of the seven events from the config, is idempotent, and leaves a file that already holds the values alone', () => {
  const d = project(RECIPE);
  settings(d, '.claude/settings.json', HOOKS);
  const r1 = applyHookTimeouts(d, '.claude/settings.json');
  assert.deepEqual(r1, { state: 'merged', text: '.claude/settings.json (hook timeouts from the config; other settings kept)' });
  const after1 = readFileSync(path.join(d, '.claude/settings.json'), 'utf8');
  const j = JSON.parse(after1);
  assert.equal(j.hooks.SessionStart[0].hooks[0].timeout, 30);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].timeout, 30);
  assert.equal(j.hooks.PreToolUse[0].hooks[1].timeout, 7);
  assert.equal(j.hooks.Notification[0].hooks[0].timeout, 1);
  assert.deepEqual(applyHookTimeouts(d, '.claude/settings.json'), { state: 'same', text: '.claude/settings.json (hook timeouts)' });
  assert.equal(readFileSync(path.join(d, '.claude/settings.json'), 'utf8'), after1);
  assert.deepEqual(applyHookTimeouts(d, '.codex/hooks.json'), { state: 'absent', text: '' });
  mkdirOf(path.join(d, '.codex/hooks.json'));
  writeFileSync(path.join(d, '.codex/hooks.json'), '{ not json');
  assert.deepEqual(applyHookTimeouts(d, '.codex/hooks.json'), { state: 'warn', text: '.codex/hooks.json: hook timeouts not set (invalid JSON)' });
  assert.equal(readFileSync(path.join(d, '.codex/hooks.json'), 'utf8'), '{ not json');
});

