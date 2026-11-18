// @ts-check
// A333: the lead cannot launch the implementer subagent while its write window cannot be opened, and a long `next` answer ends with its first step.
// The real hook (PreToolUse on the Agent tool) and the real dispatcher run on real projects; no runtime is started for a refused launch.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { A, copyOf, must, project, gfail, gpass, rec } from '../lib/harness.mjs';
import { implemented } from '../core/gates-s1-lib.mjs';
import { fixture as dispatchFixture } from '../core/dispatch-lib.mjs';
import { launchRole, launchVerdict } from '../../adapters/claude/hooks/guards/launch.mjs';
import { H, allowed, denied, fixture } from './lib.mjs';

const RUN = '.agents/runs/LC/RUN.yaml';
/**
 * The fix-round tests (2 and 3) start from an implemented orchestrated run with failing gates: about 3.5 s of `agent.sh` calls, 11 s on a loaded CI box. Built once in
 * `before` (the hook's time is no test's time), the secret scan and the implemented run shared, then one copy per test state; each test runs its own assertions on the real state.
 * @type {{ fixRound: string, longNext: string }}
 */
const runs = /** @type {any} */ ({});
before(() => {
  const base = project({ topology: 'orchestrated' });
  implemented(base, 'orchestrated');
  must(base, ['secret-scan', 'LC']);
  const derive = (/** @type {(d: string) => void} */ steps) => { const d = copyOf(base); steps(d); return d; };
  runs.fixRound = derive((d) => { gfail(d, 'REVIEW_SMALL', 'impl.txt'); gpass(d, 'QA'); gpass(d, 'VERIFY'); });
  runs.longNext = derive((d) => { for (const g of ['REVIEW_SMALL', 'QA', 'VERIFY'])
    rec(d, g, 'FAIL', [1, 2, 3].map((n) => `${g}-${n}|blocking|impl.txt:${n}|lookup returns the wrong value for an empty key|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single`), { confidence: 'high' }); });
});

/** PreToolUse of the Agent tool. @param {string} dir @param {string} type @param {string} [tool] @param {string} [callerType] */
const launch = (dir, type, tool = 'Agent', callerType = undefined) => H(dir, 'pretool', JSON.stringify({
  hook_event_name: 'PreToolUse', session_id: 's1', cwd: dir, tool_name: tool, tool_input: { subagent_type: type, description: 'x', prompt: 'x' },
  ...(callerType ? { agent_type: callerType, agent_id: 'c1' } : {}) }));
/** The handoff state of the run, rewritten in RUN.yaml (the seal is checked only after the state, so a refusal is the state's own). @param {string} dir @param {string} state */
const setHandoff = (dir, state) => {
  const f = path.join(dir, RUN);
  writeFileSync(f, readFileSync(f, 'utf8').replace(/(handoff:\n {2}state: )"[A-Z_]+"/, `$1"${state}"`));
};

/** The fixture of the three launch tests, built (and its template warmed) once in `before`; a test takes a copy. @type {string} */
let launchBase = '';
before(() => { launchBase = fixture(); });

test('A333 hook: the implementer is launched at IMPLEMENTING, by either tool name', () => {
  const d = copyOf(launchBase);
  for (const [tool, type] of [['Agent', 'proofline:proofline-implementer'], ['Task', 'proofline-implementer'], ['Agent', 'proofline:proofline-implementer']])
    allowed(`${tool} ${type} at IMPLEMENTING`, launch(d, type, tool));
});

test('A333 hook: the implementer is denied at PLANNED with the missing step named, and allowed again after the handoff', () => {
  const d = copyOf(launchBase);
  setHandoff(d, 'PLANNED');
  for (const [tool, type] of [['Agent', 'proofline:proofline-implementer'], ['Task', 'proofline-implementer']]) {
    const out = launch(d, type, tool);
    denied(`${tool} ${type} at PLANNED`, out, 'the implementer is not launched');
    assert.ok(out.includes('agent.sh handoff LC IMPLEMENTING first'), `the missing step is not named: ${out.slice(0, 700)}`);
    assert.ok(out.includes('only while handoff state is IMPLEMENTING'), `the reason of window-open is not shown: ${out.slice(0, 700)}`);
  }
  setHandoff(d, 'IMPLEMENTING');
  allowed('the implementer after the handoff', launch(d, 'proofline:proofline-implementer'));
});

test('A333 hook: the other roles are never judged at PLANNED, and a subagent is not the lead', () => {
  const d = copyOf(launchBase);
  setHandoff(d, 'PLANNED');
  // designer, QA, explorer, reviewer, verifier, any other subagent, and a subagent that launches: not judged
  for (const t of ['proofline:proofline-designer', 'proofline:proofline-qa', 'proofline:proofline-explorer', 'proofline:proofline-reviewer', 'proofline:proofline-verifier', 'general-purpose', 'Explore'])
    allowed(`${t} at PLANNED`, launch(d, t));
  allowed('a subagent is not the lead', launch(d, 'proofline:proofline-implementer', 'Agent', 'proofline-explorer'));
});

test('A333 hook: a fix round names the exact `next` line, and the launch is allowed once that handoff is made', () => {
  const d = runs.fixRound;
  const out = launch(d, 'proofline:proofline-implementer');
  denied('implementer launched at IMPLEMENTED with a failing gate', out, 'the implementer is not launched');
  assert.ok(out.includes('exactly: agent.sh handoff LC IMPLEMENTING (fix round 1; findings of: REVIEW_SMALL)'), `the fix round line is not named: ${out.slice(0, 900)}`);
  assert.ok(out.includes('never cut its output with tail or head'), 'no warning against a cut');
  allowed('designer is not judged in a fix round', launch(d, 'proofline:proofline-designer'));
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  allowed('the implementer after the fix round handoff', launch(d, 'proofline:proofline-implementer'));
});

test('A333 next: a long answer ends with its first step, so a tail cannot lose the handoff line; a short one is unchanged', () => {
  const d = runs.longNext;
  const lines = A(d, ['next', 'LC']).out.split('\n').filter((l) => l !== '');
  assert.ok(lines.length > 13, `the fixture answer is not long: ${lines.length} lines`);
  const first = /** @type {string} */ (lines.find((l) => l.startsWith('next=')));
  assert.match(first, /^next=agent\.sh handoff LC IMPLEMENTING \(fix round 1/);
  assert.equal(lines.at(-1), `NEXT: ${first.slice(5)}`, 'the last line is not the first step');
  assert.equal(lines.filter((l) => l.startsWith('NEXT:')).length, 1);
  // the short answers keep their recorded form (tests/core/golden/next-order.txt)
  const s = project({ topology: 'orchestrated' });
  assert.ok(!A(s, ['next', 'LC']).out.includes('NEXT:'), 'a short answer got a last line');
});

test('A333 headless: dispatch.sh refuses the implementer without an openable window and starts no runtime', async () => {
  const fx = dispatchFixture();
  setHandoff(fx.dir, 'PLANNED');
  const r = await fx.dispatch(['LC', 'implementer']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /window-open refused; implementer not started/);
  assert.match(r.err, /only while handoff state is IMPLEMENTING/);
  assert.equal(fx.has('.agents/local/codex.argv', ''), false, 'a runtime was started');
  setHandoff(fx.dir, 'IMPLEMENTING');
  assert.equal((await fx.dispatch(['LC', 'implementer'])).code, 0, 'the dispatch after the handoff');
});

test('A333 hook: a plain PLANNED denial says nothing of a fix round; the aliases SubagentStart reads as the implementer are judged; a destructive plan names only its approval', () => {
  const d = fixture();
  setHandoff(d, 'PLANNED');
  const out = launch(d, 'proofline:proofline-implementer');
  denied('plain PLANNED', out, 'agent.sh handoff LC IMPLEMENTING first');
  assert.ok(!out.includes('fix round'), `a plain denial talks of a fix round: ${out.slice(0, 700)}`);
  for (const t of ['proofline:proofline-implementation-worker', 'proofline-implementation_worker']) denied(`alias ${t}`, launch(d, t), 'the implementer is not launched');
  assert.equal(launchRole('proofline:proofline-implementation-worker'), 'implementer');
  assert.equal(launchRole('proofline:proofline-qa'), '');
  assert.equal(launchRole('implementer'), '');
  appendFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), '\n## Data\n\ndestructive: yes\n');
  const dd = launch(d, 'proofline:proofline-implementer');
  denied('destructive plan at PLANNED', dd, 'the implementer is not launched');
  assert.ok(dd.includes('request-approval LC destructive'), `the approval step is not named: ${dd.slice(0, 900)}`);
  assert.ok(!dd.includes('handoff LC IMPLEMENTING first'), 'the handoff is named for a destructive plan');
});

test('A333 hook: a window-open that does not answer in the budget denies the launch (fail closed)', async () => {
  const ctx = /** @type {any} */ ({
    installed: true, sub: false, act: 'LC', nextBudget: 1, agents: { coreDir: path.join(import.meta.dirname, '../../control-plane/agents/scripts') }, input: {},
    get: (/** @type {string} */ k) => (k === 'tool_name' ? 'Agent' : 'proofline:proofline-implementer'),
    agent: () => new Promise(() => {}),   // never answers
  });
  const v = await launchVerdict({ tool_name: 'Agent' }, ctx, 0.05);
  assert.equal(v?.decision, 'deny');
  assert.match(v?.reason ?? '', /ran out of time/);
  // an answer in time is passed through
  ctx.agent = async () => ({ status: 0, stdout: 'fp\n', stderr: '', timedOut: false });
  assert.equal(await launchVerdict({ tool_name: 'Agent' }, ctx, 5), null);
});
