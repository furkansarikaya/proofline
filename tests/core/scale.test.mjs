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
import { applyHookTimeouts, suggestScale } from '../../control-plane/agents/scripts/core/scale.mjs';
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

test('a machine that is not slow: no proposal, the old one is removed, and nothing is asked', () => {
  const d = project(RECIPE);
  const r = cli(d, ['doctor-scale', 'propose']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^timing: approval path \d+ ms \(reference 500\), agent\.sh start \d+ ms \(reference 250\); timeouts\.scale is 1\.0 now\nscale: this machine is not slow \(within 1\.5 times the reference\); timeouts\.scale 1\.0 fits, nothing to change\n$/);
  assert.equal(existsSync(proposal(d)), false);
});

test('a slow machine: one proposal bound to the value alone, one question, the approval request recorded; the config is untouched until the reply', () => {
  const d = project(RECIPE);
  const real = readFileSync(agentSh(d), 'utf8');
  writeFileSync(agentSh(d), '#!/bin/sh\nsleep 0.6\n');   // a start of agent.sh that takes 0.6 s: the approval path 1.2 s, the start 0.6 s
  let r;
  try { r = cli(d, ['doctor-scale', 'propose']); } finally { writeFileSync(agentSh(d), real); }
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^timing: approval path 1[0-9]{3} ms \(reference 500\), agent\.sh start [5-9][0-9]{2} ms \(reference 250\); timeouts\.scale is 1\.0 now\n\nscale proposal [0-9a-f]{12}: timeouts\.scale 1\.0 -> ([0-9]+(?:\.5)?) \(every step time, build and test limit, lock wait and hook limit grows by that factor; the approval budget does not\)\nQUESTION \(one\): write timeouts\.scale: ([0-9]+(?:\.5)?) into \.agents\/config\.yaml\? Reply "approve scale"\. Nothing is written without your reply\./);
  assert.match(r.out, /\n {2}after your reply: proofline doctor --apply-scale\n$/);
  assert.match(readFileSync(proposal(d), 'utf8'), /^scale\t([0-9]+(?:\.5)?)\n$/);
  assert.equal(scaleOf(d), '1.0');
  // no reply yet
  const early = cli(d, ['doctor-scale', 'apply']);
  assert.equal(early.status, 1);
  assert.match(early.err, /proofline: doctor --apply-scale: the user has not agreed to this proposal yet; ask the one question and wait for the reply "approve scale"\n$/);
  assert.equal(scaleOf(d), '1.0');
});

test('the user\'s own "approve scale" writes the value once and puts the new limits into the settings files, and nothing else in them changes', () => {
  const d = project(RECIPE);
  const real = readFileSync(agentSh(d), 'utf8');
  settings(d, '.claude/settings.json', HOOKS);
  settings(d, '.codex/hooks.json', { hooks: { Stop: [{ hooks: [{ command: 'node .agents/hooks/proofline-hook.mjs stop', timeout: 1 }] }] } });
  writeFileSync(agentSh(d), '#!/bin/sh\nsleep 0.6\n');
  try { assert.equal(cli(d, ['doctor-scale', 'propose']).status, 0); } finally { writeFileSync(agentSh(d), real); }
  const want = (/^scale\t(.*)$/m.exec(readFileSync(proposal(d), 'utf8')) ?? [])[1];
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
  const real = readFileSync(agentSh(d), 'utf8');
  writeFileSync(agentSh(d), '#!/bin/sh\nsleep 0.6\n');
  let r;
  try { r = cli(d, ['doctor-scale', 'propose']); } finally { writeFileSync(agentSh(d), real); }
  assert.match(r.out, /timeouts\.scale is 2 now\n/);
  // measured 2 (or a neighbour): when it is the one set the user is told so; otherwise a proposal exists, which the next lines turn into garbage
  if (existsSync(proposal(d))) {
    writeFileSync(proposal(d), 'scale\t2x\n');
    assert.equal(A(d, ['request-approval', '-', 'scale']).status, 0);
    say(d, 'approve scale');
    assert.equal(A(d, ['approve-pending']).status, 0);
    const bad = cli(d, ['doctor-scale', 'apply']);
    assert.equal(bad.status, 1);
    assert.match(bad.err, /proofline: doctor --apply-scale: the proposal holds no valid scale\n$/);
    assert.equal(scaleOf(d), '2');
  } else assert.match(r.out, /scale: the measured value 2 is the one set already\n$/);
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

test('cli hook-timeouts-apply <ROOT> <REL> prints the state and a tab, nothing when there is nothing to do, and refuses a path outside the project', () => {
  const d = project(RECIPE);
  settings(d, '.claude/settings.json', HOOKS);
  const core = ['hook-timeouts-apply', d, '.claude/settings.json'];
  assert.equal(cli(d, core).out, 'merged\t.claude/settings.json (hook timeouts from the config; other settings kept)\n');
  assert.equal(cli(d, core).out, 'same\t.claude/settings.json (hook timeouts)\n');
  assert.equal(cli(d, ['hook-timeouts-apply', d, '.codex/hooks.json']).out, '');
  assert.equal(cli(d, ['hook-timeouts-apply', d, '../x.json']).status, 2);
  assert.equal(cli(d, ['hook-timeouts-apply', d, '/etc/passwd']).status, 2);
  assert.equal(cli(d, ['hook-timeouts-apply', d]).status, 2);
});
