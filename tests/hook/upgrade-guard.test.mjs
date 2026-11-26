// @ts-check
// A371 (attack review): `proofline upgrade` (and --check, --rollback) replaces the control plane and its enforcement files, so it is the user's command. The PreToolUse hook refuses it
// for every dispatched specialist (a subagent, or a session whose role is not the lead) and lets the lead's own session run it, so Core invariant 6 does not rest on marker files alone.
// The hook only judges the command text; nothing is executed. Other `proofline` commands stay allowed for a specialist.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, rmSync, nodeHook, cleanEnv } from './harness.mjs';

const hookDir = dirname(nodeHook);
const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);

let template = '';
let base = '';
let dir = '';
before(() => { template = buildTemplate(); base = tempDir('hook-upgrade-'); dir = copyProject(template, base); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @type {Array<[string, Record<string, string>, Record<string, string>]>} */
const SPECIALISTS = [
  ['implementer', { agent_type: 'proofline-implementer', agent_id: 'u1' }, { AGENT_ROLE: 'implementer' }],
  ['designer', { agent_type: 'proofline-designer', agent_id: 'u1' }, { AGENT_ROLE: 'designer' }],
  ['reviewer', { agent_type: 'proofline-reviewer', agent_id: 'u1' }, { AGENT_ROLE: 'reviewer' }],
  ['security_reviewer', { agent_type: 'proofline-security-reviewer', agent_id: 'u1' }, { AGENT_ROLE: 'security_reviewer' }],
  ['qa', { agent_type: 'proofline-qa', agent_id: 'u1' }, { AGENT_ROLE: 'qa' }],
  ['verifier', { agent_type: 'proofline-verifier', agent_id: 'u1' }, { AGENT_ROLE: 'verifier' }],
  ['explorer', { agent_type: 'proofline-explorer', agent_id: 'u1' }, { AGENT_ROLE: 'explorer' }],
  ['a dispatched worker session (role only, no subagent id)', {}, { AGENT_ROLE: 'implementer' }],
];

/** @param {string} command @param {Record<string, string>} who @param {Record<string, string>} env @returns {Promise<string | null>} the refusal text, or null when allowed */
async function pre(command, who, env) {
  const raw = Buffer.from(JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }));
  const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: dir, TMPDIR: '/var/proofline-upgrade-tmp', ...env }));
  assert.ok(c, 'no hook context');
  try {
    const out = await handle(c);
    if (typeof out !== 'string' || out === '') return null;
    return /** @type {string} */ (JSON.parse(out).hookSpecificOutput.permissionDecisionReason);
  } finally { finish(c); }
}

const UPGRADES = [
  'proofline upgrade', 'proofline upgrade --check', 'proofline upgrade --rollback', 'proofline upgrade --dry-run', 'bin/proofline upgrade', '/opt/p/bin/proofline upgrade --yes',
  'cd . && proofline upgrade', 'echo ok; proofline upgrade', 'env PL_HOME=/x proofline upgrade', 'sudo proofline upgrade', "sh -c 'proofline upgrade --rollback'", '(proofline upgrade)', 'true | proofline upgrade',
];
const OTHERS = ['proofline status', 'proofline doctor', 'proofline version', 'echo proofline upgrade is the user command', 'git log --oneline -3'];

for (const [name, who, env] of SPECIALISTS) {
  test(`${name}: every spelling of proofline upgrade is refused; the other proofline commands are not`, async () => {
    for (const c of UPGRADES) {
      const r = await pre(c, who, env);
      assert.ok(r !== null && /proofline upgrade/.test(r) && /user's/.test(r), `${c}: ${r}`);
    }
    for (const c of OTHERS) {
      const r = await pre(c, who, env);
      assert.ok(r === null || !/proofline upgrade replaces/.test(r), `${c}: ${r}`);
    }
  });
}

test("the lead's own session may run proofline upgrade (it is the user's terminal command, run by the lead on the user's yes)", async () => {
  for (const c of UPGRADES.slice(0, 5)) {
    const r = await pre(c, {}, {});
    assert.ok(r === null || !/proofline upgrade replaces/.test(r), `${c}: ${r}`);
  }
});
