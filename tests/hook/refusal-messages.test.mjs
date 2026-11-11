// @ts-check
// A257 (issue #181 item 1): a refusal names the allowed next call, and the name is pinned to the hook's real behaviour. Each scenario runs a refused command, takes the alternative
// the message itself spells out (not a copy in the test), runs that and expects the hook to let it through: two calls until success, and a message that cannot drift from the guard.
// Nothing is loosened: every first command stays refused.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, copyProject, runHook, rmSync } from './harness.mjs';

let withRun = '';
let base = '';
before(() => { withRun = buildTemplate(); base = tempDir('hook-refmsg-'); });
after(() => { rmSync(withRun, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {string} dir @param {string} command @param {Record<string, string>} who */
async function pre(dir, command, who) {
  const r = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }, {});
  if (r.stdout === '') return null;
  return /** @type {string} */ (JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason);
}
const QA = { agent_type: 'proofline-qa', agent_id: 'a1' };
const REVIEWER = { agent_type: 'proofline-reviewer', agent_id: 'a1' };
const IMPL = { agent_type: 'proofline-implementer', agent_id: 'a1' };

test('a write outside the project names the run scratch folder with the run id, and writing there passes', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'echo hi > /tmp/x', QA);
  assert.ok(why, 'refused');
  assert.match(why, /Scratch files go under \.agents\/runs\/LC\/scratch\/ \(mkdir -p it first\)/);
  assert.equal(await pre(d, 'mkdir -p .agents/runs/LC/scratch/ && echo hi > .agents/runs/LC/scratch/out.txt', QA), null);
});

test('mktemp names the exact command that passes', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'mktemp -d', QA);
  assert.ok(why, 'refused');
  const alt = /: (mkdir -p \S+ && mktemp \S+)$/.exec(why)?.[1];
  assert.equal(alt, 'mkdir -p .agents/runs/LC/scratch/ && mktemp .agents/runs/LC/scratch/XXXXXX');
  assert.equal(await pre(d, /** @type {string} */ (alt), QA), null);
});

test('a write through a variable is refused and the message spells the literal target that passes', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'O=$(pwd)/x; echo hi > $O/out.txt', REVIEWER);
  assert.ok(why, 'refused');
  assert.match(why, /which cannot be resolved/);
  const target = /for example > (\S+),/.exec(why)?.[1];
  assert.equal(target, '.agents/runs/LC/scratch/out.txt');
  assert.equal(await pre(d, `mkdir -p .agents/runs/LC/scratch && echo hi > ${target}`, REVIEWER), null);
});

test('a glob over .agents is refused and the message names the literal listing that passes', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'ls .agents/*', REVIEWER);
  assert.ok(why, 'refused');
  assert.match(why, /dispatch nonce/);
  const alt = /Name the folder or file literally: (ls \.agents\/skills)/.exec(why)?.[1];
  assert.equal(alt, 'ls .agents/skills');
  assert.equal(await pre(d, 'ls .agents/skills', REVIEWER), null);
  assert.equal(await pre(d, 'ls .agents/local', REVIEWER), null);
});

test('the role message lists only agent.sh commands the hook lets that role run; a state change stays refused', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'sh .agents/scripts/agent.sh classify LC COMPLEX', REVIEWER);
  assert.ok(why, 'refused');
  const list = /runs only the read-only agent\.sh (.+) \(not classify\)/.exec(why)?.[1];
  assert.ok(list, why);
  const names = list.split(/ and | /).filter((x) => x !== '' && x !== 'submit' && x !== 'verify-*');
  assert.deepEqual(names, ['status', 'pipeline', 'fingerprint', 'build-record', 'plan-section', 'config-get', 'diff-digest', 'next']);
  for (const n of names) assert.equal(await pre(d, `sh .agents/scripts/agent.sh ${n} LC`, REVIEWER), null, `${n} is listed but refused`);
  assert.equal(await pre(d, 'sh .agents/scripts/agent.sh verify-scope LC', REVIEWER), null);
  assert.ok(await pre(d, 'sh .agents/scripts/agent.sh approve LC', REVIEWER), 'approve stays refused');
});

test('the implementer message lists only commands the hook lets the implementer run', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'sh .agents/scripts/agent.sh classify LC COMPLEX', IMPL);
  assert.ok(why, 'refused');
  const list = /the implementer runs only agent\.sh (.+) \(not classify\)/.exec(why)?.[1];
  assert.ok(list, why);
  const names = list.split(' ').filter((x) => x !== 'verify-*' && x !== 'worker-evidence');
  assert.deepEqual(names, ['status', 'pipeline', 'fingerprint', 'build-record', 'plan-section', 'config-get']);
  for (const n of names) assert.equal(await pre(d, `sh .agents/scripts/agent.sh ${n} LC`, IMPL), null, `${n} is listed but refused`);
  assert.ok(await pre(d, 'sh .agents/scripts/agent.sh diff-digest LC', IMPL), 'diff-digest stays refused to the implementer');
});

test('a report body that names node and .agents/scripts is refused; the message points to a report file, which passes', async () => {
  const d = copyProject(withRun, base);
  const body = "AGENT_ROLE=reviewer sh .agents/scripts/agent.sh submit LC --agent a1 --confidence high --report - <<'EOF'\nI ran node -e on .agents/scripts/core\nEOF";
  const why = await pre(d, body, REVIEWER);
  assert.ok(why, 'refused');
  assert.match(why, /write that text to a file under the scratch folder with the Write tool and pass the path \(agent\.sh submit \.\.\. --report <file>\)/);
  assert.equal(await pre(d, 'AGENT_ROLE=reviewer sh .agents/scripts/agent.sh submit LC --agent a1 --confidence high --report .agents/runs/LC/scratch/a1-report.md', REVIEWER), null);
});

test('a variable command word is refused; the message shows the argument form that passes', async () => {
  const d = copyProject(withRun, base);
  const why = await pre(d, 'A=.agents/scripts/agent.sh; $A next LC', {});
  assert.ok(why, 'refused');
  const alt = /plain literal: (ID=T-1; sh \.agents\/scripts\/agent\.sh next \$ID) \(not/.exec(why)?.[1];
  assert.equal(alt, 'ID=T-1; sh .agents/scripts/agent.sh next $ID');
  assert.equal(await pre(d, 'ID=LC; sh .agents/scripts/agent.sh next $ID', {}), null);
});
