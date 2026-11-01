// @ts-check
// The Node hook against the shell hook (the specification) on recorded inputs, event by event: the same stdout, the same exit status, the same
// files (capture, intake, history, records, windows, submissions). The shell hook stays in the repository until stage 10.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, haveJq, pair, cleanEnv, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, existsSync, spawnSync, readFileSync } from './harness.mjs';

const skip = haveJq ? false : 'jq is required for the shell hook';
let template = '';
let base = '';
before(() => { template = buildTemplate(); base = mkdtempSync(join(tmpdir(), 'hook-ev-')); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {ReturnType<typeof pair>} r @param {string} what */
function same(r, what) {
  assert.equal(r.node.stdout, r.sh.stdout, `${what}: stdout`);
  assert.equal(r.node.status, r.sh.status, `${what}: status`);
  assert.deepEqual(r.node.files, r.sh.files, `${what}: files`);
}

test('PostToolUse relays the records of the subagents', { skip }, () => {
  const setup = (/** @type {string} */ d) => { mkdirSync(join(d, '.agents/local/records'), { recursive: true }); writeFileSync(join(d, '.agents/local/records/a1.txt'), 'proofline: one\nproofline: "two"\n'); mkdirSync(join(d, '.agents/local/records/a1.lock')); };
  const r = pair(template, base, 'posttool', () => ({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {} }), { setup });
  same(r, 'records');
  assert.match(r.node.stdout, /additionalContext/);
  same(pair(template, base, 'posttool', () => ({ hook_event_name: 'PostToolUse', tool_name: 'Agent' })), 'no records');
  same(pair(template, base, 'posttool', () => ({ hook_event_name: 'PostToolUse', agent_id: 'a1', agent_type: 'proofline-explorer' }), { setup }), 'a subagent gets nothing');
});

test('SessionStart: the lead is told its skill, the run and the next step', { skip }, () => {
  same(pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' })), 'run LC');
  same(pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { runtime: 'codex' }), 'codex');
  same(pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { setup: (d) => rmSync(join(d, '.agents/local/ACTIVE_RUN')) }), 'no run');
  same(pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { setup: (d) => writeFileSync(join(d, '.agents/local/ACTIVE_RUN'), 'bad id!\n') }), 'malformed ACTIVE_RUN');
  same(pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart', agent_id: 'a1', agent_type: 'proofline-explorer' })), 'a subagent gets nothing');
});

test('SessionStart: plugin and project of different versions', { skip }, () => {
  const plugin = mkdtempSync(join(tmpdir(), 'hook-plugin-'));
  mkdirSync(join(plugin, '.claude-plugin'));
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), '{\n  "name": "proofline",\n  "version": "9.9.9"\n}\n');
  const r = pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { env: { CLAUDE_PLUGIN_ROOT: plugin } });
  rmSync(plugin, { recursive: true, force: true });
  same(r, 'version mismatch');
  assert.match(r.node.stdout, /systemMessage/);
});

test('SessionStart: a slow next is stopped by its budget', { skip }, () => {
  const setup = (/** @type {string} */ d) => {
    spawnSync('mv', [join(d, '.agents/scripts/agent.sh'), join(d, '.agents/scripts/agent-real.sh')]);
    writeFileSync(join(d, '.agents/scripts/agent.sh'), '#!/bin/sh\ncase "$1" in next) sleep 20; exit 0 ;; esac\nexec sh "$(dirname "$0")/agent-real.sh" "$@"\n');
  };
  const t0 = Date.now();
  const r = pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { setup, env: { PROOFLINE_HOOK_NEXT_BUDGET: '1' } });
  assert.ok(Date.now() - t0 < 12000, 'both hooks answer within their budget');
  same(r, 'timed-out next');
  assert.match(r.node.stdout, /the session check did not finish/);
});

test('SubagentStart: window, token and role text', { skip }, () => {
  for (const type of ['proofline-explorer', 'proofline-implementer', 'proofline:proofline-designer', 'proofline-qa', 'general']) {
    same(pair(template, base, 'subagent-start', () => ({ hook_event_name: 'SubagentStart', agent_type: type, agent_id: 'a/1', transcript_path: '/t/x.jsonl' })), type);
  }
  same(pair(template, base, 'subagent-start', () => ({ agent_type: 'proofline-explorer', agent_id: 'a1' }), { setup: (d) => rmSync(join(d, '.agents/local/ACTIVE_RUN')) }), 'no run');
});

test('SubagentStop: sent back once, then recorded', { skip }, () => {
  const status = (/** @type {string} */ body) => (/** @type {string} */ d) => { mkdirSync(join(d, '.agents/local/submissions'), { recursive: true }); writeFileSync(join(d, '.agents/local/submissions/a1.status'), body); };
  const ev = { hook_event_name: 'SubagentStop', agent_type: 'proofline-explorer', agent_id: 'a1', stop_hook_active: false };
  same(pair(template, base, 'subagent-stop', () => ev), 'no result: sent back');
  same(pair(template, base, 'subagent-stop', () => ev, { setup: status('status=error\nerror=bad header\n') }), 'rejection named');
  same(pair(template, base, 'subagent-stop', () => ({ ...ev, stop_hook_active: true })), 'second stop accepted');
  same(pair(template, base, 'subagent-stop', () => ev, { setup: status('status=ok\nrole=explorer\nresult=DONE\ngate=QA\nraw=r.md\n') }), 'recorded');
  same(pair(template, base, 'subagent-stop', () => ({ ...ev, agent_type: 'proofline-implementer' }), { setup: status('status=ok\nrole=implementer\nresult=DONE\nraw=r.md\n') }), 'implementer');
  same(pair(template, base, 'subagent-stop', () => ev, { setup: (d) => { rmSync(join(d, '.agents/local/ACTIVE_RUN')); } }), 'no run');
});
