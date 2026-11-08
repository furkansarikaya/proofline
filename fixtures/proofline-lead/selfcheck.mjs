// Checks that every state built by setup.mjs is real: `agent.sh next LK-7` prints the expected first step.
// Usage: node selfcheck.mjs <dir-built-by-setup.mjs>   (all states, as tests/fixtures/check-fixtures.mjs builds them)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../../tests/lib/fixture.mjs';

if (process.argv.length !== 3) { console.error('usage: node selfcheck.mjs <dir>'); process.exit(2); }
const base = process.argv[2];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
delete env.AGENT_ROLE;
let rc = 0;
const agent = (/** @type {string} */ state, /** @type {string[]} */ ...args) => run('sh', ['.agents/scripts/agent.sh', ...args], { cwd: path.join(base, state), env });
/** @param {string} state @param {string} first the first `next=` line @param {string} [line] a line `pipeline` must print; a state that was not built is skipped (PROOFLINE_SLOW_TESTS unset) */
function want(state, first, line) {
  if (!existsSync(path.join(base, state))) { console.log(`SKIP ${state} (not built)`); return; }
  const got = (agent(state, 'next', 'LK-7').out.split('\n').find((l) => l.startsWith('next=')) ?? '').replace(/^next=/, '');
  if (got !== first) { console.log(`FAIL ${state}: next is '${got}', want '${first}'`); rc = 1; return; }
  if (line && !agent(state, 'pipeline', 'LK-7').out.split('\n').includes(line)) { console.log(`FAIL ${state}: pipeline lacks ${line}`); rc = 1; return; }
  console.log(`PASS ${state}`);
}
want('review-rules-fail', 'agent.sh handoff LK-7 IMPLEMENTING (fix round 1; findings of: REVIEW_RULES)', 'gate.REVIEW_RULES=fail');
want('needs-input', 'agent.sh questions LK-7');
want('destructive-approval', 'agent.sh request-approval LK-7 destructive (relay verbatim)');
want('security-pass-low', 'dispatch.sh LK-7 security_reviewer', 'gate.SECURITY=pass_low');
want('fix-rounds-exhausted', 'agent.sh terminate LK-7 FAILED (reason and evidence on stdin)', 'fix_round=3');
process.exitCode = rc;
