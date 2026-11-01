// @ts-check
// The Node hook against the shell hook (the specification) on recorded inputs, event by event: the same stdout, the same exit status, the same
// files (capture, intake, history, records, windows, submissions). The shell hook stays in the repository until stage 10.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, haveJq, pair, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, existsSync } from './harness.mjs';

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
