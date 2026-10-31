// @ts-check
// Seam safety (issue #166, D14): with no fixture stub present, setting every PROOFLINE_TEST* and PROOFLINE_ENGINE* value leaves the SECRETS result,
// the execution-policy decisions and the approval results unchanged, on both engines. The fixture is the frozen test-lib run with the three stubs
// (secret-scan.sh, exec-policy.sh, markdown.sh) replaced by the real files of the checkout.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsSrc, scaffoldFixture, scriptsSrc } from './fixture.mjs';
import { compareSides, formatDiffs, isShellFlake, runSide } from './rig.mjs';
import { sha256 } from './normalise.mjs';

/** @typedef {import('./rig.mjs').Step} Step */
const SECRET_FILE = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1"\nPLANTED_SECRET\n';
const capture = (/** @type {string} */ text, /** @type {number} */ time) => /** @type {Step} */ ({ write: { path: '.agents/local/prompts/s1.json', content: `${JSON.stringify({ session: 's1', time, sha256: sha256(text), text })}\n` } });
const A = (/** @type {string[]} */ args, /** @type {Partial<Step>} */ o = {}) => /** @type {Step} */ ({ args, ...o });
const FUTURE = Math.floor(Date.now() / 1000) + 3600; // one value for every run, so the capture ids are equal

/** @returns {Step[]} */
function steps(/** @type {Record<string,string>} */ env) {
  const e = (/** @type {Step} */ s) => ({ ...s, env: { ...(s.env ?? {}), ...env } });
  return [
    { exec: ['cp', join(scriptsSrc, 'secret-scan.sh'), '.agents/scripts/secret-scan.sh'] }, { exec: ['cp', join(scriptsSrc, 'exec-policy.sh'), '.agents/scripts/exec-policy.sh'] },
    { exec: ['cp', join(agentsSrc, 'task-integrations/markdown.sh'), '.agents/task-integrations/markdown.sh'] },
    ...['roles.conf', 'tools.conf', 'owns.conf'].map((f) => /** @type {Step} */ ({ exec: ['cp', join(agentsSrc, f), `.agents/${f}`] })),
    { exec: ['grep', '-c', 'test stub', '.agents/scripts/secret-scan.sh', '.agents/scripts/exec-policy.sh', '.agents/task-integrations/markdown.sh'] }, // 0 matches in each: no stub is left
    { write: { path: 'impl.txt', content: SECRET_FILE } },
    // SECRETS
    e(A(['secret-scan', 'LC'])), e({ exec: ['sh', '.agents/scripts/secret-scan.sh', 'impl.txt', 'impl_test.txt'] }),
    // execution-policy decisions
    e({ exec: ['sh', '.agents/scripts/exec-policy.sh', 'resolve', '--role', 'reviewer', '--class', 'COMPLEX', '--tier', 'full', '--profile', 'balanced', '--runtime', 'claude', '--context-bytes', '1000', '--escalations-used', '0'] }),
    e({ exec: ['sh', '.agents/scripts/exec-policy.sh', 'resolve', '--role', 'security_reviewer', '--class', 'CRITICAL', '--tier', 'full', '--profile', 'max', '--runtime', 'claude', '--signal', 'critical_class'] }),
    e(A(['decide', 'LC', 'reviewer', '--dry', '--focus', 'rules'])), e(A(['decide', 'LC', 'qa', '--dry'])), e(A(['decide', 'LC', 'implementer', '--dry'])),
    // approval results: refused (no capture), refused (words), refused (stale), recorded, single-use refusal
    e(A(['request-approval', 'LC', 'push'])), e(A(['approve', 'LC', 'push'])),
    capture('what is the weather', FUTURE), e(A(['approve', 'LC', 'push'])),
    capture('approve push', 1000), e(A(['approve', 'LC', 'push'])),
    capture('approve push', FUTURE), e(A(['approve', 'LC', 'push'])), e(A(['approve', 'LC', 'push'])),
    e(A(['approval-consume', 'LC', 'push'])), e(A(['approval-consume', 'LC', 'push'])), e(A(['request-approval', 'LC', 'nosuchkind'])),
  ];
}

const ENGINE_VALUES = ['sh', 'node', 'garbage', ''];
const SEAMS = {
  PROOFLINE_TEST: '1', PROOFLINE_TEST_NOW: '1', PROOFLINE_TEST_CLOCK: '2000000000', PROOFLINE_TEST_STUB: '1', PROOFLINE_TEST_SECRET_SCAN: '/usr/bin/true', PROOFLINE_TEST_EXEC_POLICY: '/usr/bin/true',
  PROOFLINE_TEST_APPROVE: '1', PROOFLINE_TEST_APPROVAL: 'yes', PROOFLINE_TEST_SKIP_GUARDS: '1', PROOFLINE_UNAME: 'Plan9', PROOFLINE_BATCH_INHIBIT: 'none', PROOFLINE_SESSION_PID: '1',
  PROOFLINE_GH: '/usr/bin/false', PROOFLINE_PGMETHOD: 'x', PROOFLINE_ENGINE_SH: 'secret-scan,decide,approve,request-approval,approval-consume', PROOFLINE_ENGINE_NODE: 'all', PROOFLINE_ENGINE_FORCE: 'node',
};

test('with no fixture stub, every PROOFLINE_TEST* and PROOFLINE_ENGINE* value leaves SECRETS, execution-policy and approval results unchanged', { timeout: 600000 }, () => {
  const fixture = scaffoldFixture('orchestrated', 'COMPLEX');
  const run = (/** @type {Record<string,string>} */ env, /** @type {'sh'|'default'} */ eng) => runSide({ name: 'seam', fixture, steps: steps(env) }, { name: eng, engineFor: () => eng });
  const base = run({}, 'default');
  // the baseline really exercised the three results (a stub-less run: the real scanner found the planted secret, the policy resolved, an approval was recorded)
  const o = base.outputs;
  const at = (/** @type {number} */ i) => o[i + 5]; // the first six steps copy the real files; write steps give no output
  assert.equal(at(1).stdout, '.agents/scripts/secret-scan.sh:0\n.agents/scripts/exec-policy.sh:0\n.agents/task-integrations/markdown.sh:0\n', 'no stub text is left');
  assert.match(at(2).stdout + at(2).stderr, /secret|planted|AKIA|aws/i, 'secret-scan LC reported the planted secret');
  assert.match(at(4).stdout, /^role=reviewer\n[\s\S]*^runtime=claude\n[\s\S]*^model=/m, 'the real exec-policy resolved a decision');
  assert.ok(o.some((x) => /approval|approved/i.test(x.stdout + x.stderr)), 'approval steps produced output');
  const variants = [['seams only', { ...SEAMS }], ...ENGINE_VALUES.map((v) => [`seams + PROOFLINE_ENGINE=${JSON.stringify(v)}`, { ...SEAMS, PROOFLINE_ENGINE: v }])];
  for (const [name, env] of /** @type {[string, Record<string,string>][]} */ (variants)) {
    for (const eng of /** @type {('default'|'sh')[]} */ (name === 'seams only' ? ['default', 'sh'] : ['default'])) { // PROOFLINE_ENGINE itself picks the engine of the others
      let b = base; let v = run(env, eng); let d = compareSides(b, v, ['no seams', `${name}, ${eng} engine`]);
      if (isShellFlake(d, [b, v])) { b = run({}, 'default'); v = run(env, eng); d = compareSides(b, v, ['no seams', `${name}, ${eng} engine`]); } // a known 0.0.40 shell flake: once more
      assert.equal(d.length, 0, `${name} (${eng}):\n${formatDiffs(d)}`);
    }
  }
});
