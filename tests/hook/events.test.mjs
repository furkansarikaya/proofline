// @ts-check
// The Node hook against the shell hook (the specification) on recorded inputs, event by event: the same stdout, the same exit status, the same
// files (capture, intake, history, records, windows, submissions). The shell hook stays in the repository until stage 10.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, haveJq, pair, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, spawnSync, readFileSync } from './harness.mjs';

const skip = haveJq ? false : 'jq is required for the shell hook';
let template = '';
let base = '';
before(() => { template = buildTemplate(); base = mkdtempSync(join(tmpdir(), 'hook-ev-')); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {Awaited<ReturnType<typeof pair>>} r @param {string} what */
function same(r, what) {
  assert.equal(r.node.stdout, r.sh.stdout, `${what}: stdout`);
  assert.equal(r.node.status, r.sh.status, `${what}: status`);
  assert.deepEqual(r.node.files, r.sh.files, `${what}: files`);
}

test('PostToolUse relays the records of the subagents', { skip }, async () => {
  const setup = (/** @type {string} */ d) => { mkdirSync(join(d, '.agents/local/records'), { recursive: true }); writeFileSync(join(d, '.agents/local/records/a1.txt'), 'proofline: one\nproofline: "two"\n'); mkdirSync(join(d, '.agents/local/records/a1.lock')); };
  const r = await pair(template, base, 'posttool', () => ({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {} }), { setup });
  same(r, 'records');
  assert.match(r.node.stdout, /additionalContext/);
  same(await pair(template, base, 'posttool', () => ({ hook_event_name: 'PostToolUse', tool_name: 'Agent' })), 'no records');
  same(await pair(template, base, 'posttool', () => ({ hook_event_name: 'PostToolUse', agent_id: 'a1', agent_type: 'proofline-explorer' }), { setup }), 'a subagent gets nothing');
});

test('SessionStart: the lead is told its skill, the run and the next step', { skip }, async () => {
  same(await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' })), 'run LC');
  same(await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { runtime: 'codex' }), 'codex');
  same(await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { setup: (d) => rmSync(join(d, '.agents/local/ACTIVE_RUN')) }), 'no run');
  same(await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { setup: (d) => writeFileSync(join(d, '.agents/local/ACTIVE_RUN'), 'bad id!\n') }), 'malformed ACTIVE_RUN');
  same(await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart', agent_id: 'a1', agent_type: 'proofline-explorer' })), 'a subagent gets nothing');
});

test('SessionStart: plugin and project of different versions', { skip }, async () => {
  const plugin = mkdtempSync(join(tmpdir(), 'hook-plugin-'));
  mkdirSync(join(plugin, '.claude-plugin'));
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), '{\n  "name": "proofline",\n  "version": "9.9.9"\n}\n');
  const r = await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { env: { CLAUDE_PLUGIN_ROOT: plugin } });
  rmSync(plugin, { recursive: true, force: true });
  same(r, 'version mismatch');
  assert.match(r.node.stdout, /systemMessage/);
});

test('SessionStart: a slow next is stopped by its budget', { skip }, async () => {
  const setup = (/** @type {string} */ d) => {
    spawnSync('mv', [join(d, '.agents/scripts/agent.sh'), join(d, '.agents/scripts/agent-real.sh')]);
    writeFileSync(join(d, '.agents/scripts/agent.sh'), '#!/bin/sh\ncase "$1" in next) sleep 20; exit 0 ;; esac\nexec sh "$(dirname "$0")/agent-real.sh" "$@"\n');
  };
  const t0 = Date.now();
  const r = await pair(template, base, 'session', () => ({ hook_event_name: 'SessionStart' }), { setup, env: { PROOFLINE_HOOK_NEXT_BUDGET: '1' } });
  assert.ok(Date.now() - t0 < 12000, 'both hooks answer within their budget');
  same(r, 'timed-out next');
  assert.match(r.node.stdout, /the session check did not finish/);
});

test('SubagentStart: window, token and role text', { skip }, async () => {
  await Promise.all(['proofline-explorer', 'proofline-implementer', 'proofline:proofline-designer', 'proofline-qa', 'general'].map(async (type) => {
    same(await pair(template, base, 'subagent-start', () => ({ hook_event_name: 'SubagentStart', agent_type: type, agent_id: 'a/1', transcript_path: '/t/x.jsonl' })), type);
  }));
  same(await pair(template, base, 'subagent-start', () => ({ agent_type: 'proofline-explorer', agent_id: 'a1' }), { setup: (d) => rmSync(join(d, '.agents/local/ACTIVE_RUN')) }), 'no run');
});

test('SubagentStop: sent back once, then recorded', { skip }, async () => {
  const status = (/** @type {string} */ body) => (/** @type {string} */ d) => { mkdirSync(join(d, '.agents/local/submissions'), { recursive: true }); writeFileSync(join(d, '.agents/local/submissions/a1.status'), body); };
  const ev = { hook_event_name: 'SubagentStop', agent_type: 'proofline-explorer', agent_id: 'a1', stop_hook_active: false };
  same(await pair(template, base, 'subagent-stop', () => ev), 'no result: sent back');
  same(await pair(template, base, 'subagent-stop', () => ev, { setup: status('status=error\nerror=bad header\n') }), 'rejection named');
  same(await pair(template, base, 'subagent-stop', () => ({ ...ev, stop_hook_active: true })), 'second stop accepted');
  same(await pair(template, base, 'subagent-stop', () => ev, { setup: status('status=ok\nrole=explorer\nresult=DONE\ngate=QA\nraw=r.md\n') }), 'recorded');
  same(await pair(template, base, 'subagent-stop', () => ({ ...ev, agent_type: 'proofline-implementer' }), { setup: status('status=ok\nrole=implementer\nresult=DONE\nraw=r.md\n') }), 'implementer');
  same(await pair(template, base, 'subagent-stop', () => ev, { setup: (d) => { rmSync(join(d, '.agents/local/ACTIVE_RUN')); } }), 'no run');
});

/** The capture of the user's last prompt, as the prompt hook writes it. @param {string} text */
const captured = (text) => (/** @type {string} */ d) => {
  mkdirSync(join(d, '.agents/local/prompts'), { recursive: true });
  writeFileSync(join(d, '.agents/local/prompts/s1.json'), `{"session":"s1","time":1,"sha256":"x","text":"${text}"}\n`);
};
const reportTurn = (/** @type {string} */ d) => { mkdirSync(join(d, '.agents/local/report-turn'), { recursive: true }); writeFileSync(join(d, '.agents/local/report-turn/s1'), ''); };

test('Stop: identifiers of the final report, the Next step line', { skip }, async () => {
  const stop = (/** @type {string} */ msg, extra = {}) => () => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg, ...extra });
  same(await pair(template, base, 'stop', stop('done')), 'ordinary answer');
  same(await pair(template, base, 'stop', stop('all finished, nothing else'), { setup: reportTurn }), 'final report without identifiers');
  same(await pair(template, base, 'stop', stop('PLANNING COMPLEX LC'), { setup: reportTurn }), 'report with some identifiers');
  same(await pair(template, base, 'stop', stop('done'), { setup: captured('/proofline status LC') }), 'next-user line added');
  same(await pair(template, base, 'stop', stop('done\nNext step: /proofline status'), { setup: captured('/proofline status LC') }), 'next step present');
  same(await pair(template, base, 'stop', stop('done'), { setup: captured('$proofline next') }), 'codex command');
  same(await pair(template, base, 'stop', stop('x'), { setup: (d) => { reportTurn(d); captured('/proofline next LC')(d); } }), 'both');
  same(await pair(template, base, 'stop', () => ({ hook_event_name: 'Stop', agent_id: 'a1', agent_type: 'proofline-qa', last_assistant_message: 'x' }), { setup: reportTurn }), 'a subagent');
});

test('Stop: requests the lead must not make of the user', { skip }, async () => {
  const stop = (/** @type {string} */ msg, active = false) => () => ({ hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: msg });
  const cases = [
    'Please run agent.sh approve LC plan in your terminal.',
    'To continue:\n```\nsh .agents/scripts/agent.sh approve LC plan\n```',
    'You can run: git commit --no-verify -m x',
    'Please edit .agents/config.yaml by hand and set the value',
    'I ran agent.sh next and it said fine',
    'Please run uptime and tell me the result',
    'Run this:\n```\ngit status\n```\nthanks',
    'I looked at git status myself.',
    'Error: disable-model-invocation, so run /proofline:proofline-lead',
    'Use the "push" command: git push origin main',
    '> run: agent.sh answer LC 1',
  ];
  await Promise.all(cases.flatMap((c) => [
    pair(template, base, 'stop', stop(c)).then((r) => same(r, c)),
    pair(template, base, 'stop', stop(c, true)).then((r) => same(r, `${c} (second time)`)),
  ]));
  same(await pair(template, base, 'stop', stop(cases[0]), { setup: (d) => rmSync(join(d, '.agents/local/ACTIVE_RUN')) }), 'without a run');
});

test('Stop: the message from the session log when the event has none', { skip }, async () => {
  const setup = (/** @type {string} */ d) => writeFileSync(join(d, 'log.jsonl'), '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"Please run agent.sh approve LC plan"},{"type":"tool_use"}]}}\n');
  same(await pair(template, base, 'stop', (d) => ({ hook_event_name: 'Stop', transcript_path: join(d, 'log.jsonl') }), { setup }), 'transcript');
});

test('Stop: a finished run names its identifiers, appended verbatim from the summary', { skip }, async () => {
  const done = (/** @type {string} */ d) => {
    const f = join(d, '.agents/runs/LC/RUN.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/  state: PLANNING/, '  state: DONE'));
    reportTurn(d);
  };
  const r = await pair(template, base, 'stop', () => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All done, shipped.' }), { setup: done });
  same(r, 'identifiers missing');
  assert.match(r.node.stdout, /the final report lacks these identifiers: DONE COMPLEX/);
  same(await pair(template, base, 'stop', () => ({ hook_event_name: 'Stop', last_assistant_message: 'DONE COMPLEX LC commit push REVIEW_PLAN' }), { setup: done }), 'identifiers present');
});
