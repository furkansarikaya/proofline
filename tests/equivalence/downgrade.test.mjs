// @ts-check
// The downgrade test (issue #166, ADR 5.4 step 2): a project installed from THIS checkout with `proofline init`, a run in flight (CODE_DONE), then
// `proofline upgrade` from the previous release's checkout (0.0.40, commit bc072f3, unpacked with git archive), and the run continues to DONE
// with the old code. `proofline upgrade` installs the tree of the checkout it runs from, whatever its version.
// EQ_PREVIOUS_REF (read by this test only) names another commit or tag; the history must contain it (CI: fetch-depth 0).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseEnv, repoRoot, run, scriptsSrc } from './fixture.mjs';

const REF = process.env.EQ_PREVIOUS_REF || 'bc072f3';
// Every step has its own generous limit: on a CI runner the unmoved shell commands of the 0.0.40 code that finishes the run (publish-completion-report,
// handoff DONE) take several minutes, 2.5 times their time on a developer machine. A killed step names itself and prints the per-call table below.
const STEP_TIMEOUT_MS = 1800000;
// `sh ./.agents/scripts/agent.sh` calls made by the test-lib helpers are timed: "<n> <seconds> <rc> <args>" lines in $EQ_TIMES
const TIMER = `sh() { case "\${1:-}" in ./.agents/scripts/agent.sh) eq_t0=$(date +%s); command sh "$@"; eq_rc=$?; printf '%s %s %s %s %s\\n' "$(date +%s)" "$(( $(date +%s) - eq_t0 ))" "$eq_rc" "$2" "$3" >> "$EQ_TIMES"; return "$eq_rc" ;; *) command sh "$@" ;; esac; }; `;
const table = (/** @type {string} */ f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10).map((x) => `${x[1]}s rc=${x[2]} ${x[3]} ${x[4] ?? ''}`).join('\n'); } catch { return '(no call was timed)'; } };
const shell = (/** @type {string} */ script, /** @type {string} */ cwd, /** @type {Record<string,string>} */ env) => run('sh', ['-c', script, join(scriptsSrc, 'x.sh')], { cwd, env, timeout: STEP_TIMEOUT_MS });

test(`a project installed from this checkout is upgraded from ${REF}'s checkout with a run in flight, and the run continues to DONE`, { timeout: 5400000 }, () => {
  const have = run('git', ['cat-file', '-e', `${REF}^{commit}`], { cwd: repoRoot });
  assert.equal(have.code, 0, `the previous release (${REF}) is not in this clone's history: fetch it (git fetch --unshallow), or set EQ_PREVIOUS_REF`);
  const base = mkdtempSync(join(tmpdir(), 'eq-down.')); const old = join(base, 'previous'); const proj = join(base, 'project'); mkdirSync(old); mkdirSync(proj);
  const tar = spawnSync('sh', ['-c', `git -C "${repoRoot}" archive "${REF}" | tar -x -C "${old}"`], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  // the scaffold commits its baseline the way the self-tests do, outside the installed git hooks (they would block a commit while a run is open)
  const env = baseEnv(base, { EQ_PROJ: proj, EQ_TIMES: join(base, 'times') });
  const noHooks = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };
  const git = (/** @type {string[]} */ ...a) => run('git', a, { cwd: proj, env });
  git('init', '-q', '-b', 'main'); git('config', 'commit.gpgsign', 'false');

  // 1. install from THIS checkout
  const init = run('sh', [join(repoRoot, 'bin/proofline'), 'init', '--yes', '--runtimes', 'claude'], { cwd: proj, env, timeout: STEP_TIMEOUT_MS });
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const newAgent = readFileSync(join(proj, '.agents/scripts/agent.sh'));
  assert.ok(newAgent.equals(readFileSync(join(scriptsSrc, 'agent.sh'))), 'init installs this checkout\'s agent.sh');
  const hadCore = existsSync(join(proj, '.agents/scripts/proofline-core.mjs'));

  // 2. a run in flight: the self-test scaffold (fixture stubs included, as the suites use them) driven to CODE_DONE, on this checkout's engine
  const common = `. "$EQ_LIB"; ${TIMER}new_repo() { cd "$EQ_PROJ" || exit 1; }; `;
  const lib = (/** @type {string} */ root) => ({ ...env, ...noHooks, EQ_LIB: join(root, 'control-plane/agents/scripts/test-lib.sh') });
  const flight = shell(`${common}install_control_plane "$EQ_PROJ"; printf '.agents/runs/\\n.agents/local/\\n.agents/skills/\\n.claude/\\n.codex/\\n' >> .gitignore; scaffold orchestrated no COMPLEX autonomous && to_code_done orchestrated`, proj, lib(repoRoot));
  assert.equal(flight.code, 0, `${flight.signal ? `flight step killed by ${flight.signal}; ` : ''}slowest calls:\n${table(join(base, 'times'))}\n${flight.stdout}${flight.stderr}`);
  const inFlight = readFileSync(join(proj, '.agents/runs/LC/RUN.yaml'), 'utf8');
  assert.match(inFlight, /state: "?CODE_DONE"?/);
  const ledgerBefore = readFileSync(join(proj, '.agents/runs/LC/LEDGER.log'), 'utf8');

  // 3. downgrade: `proofline upgrade` from the previous release's checkout
  const up = run('sh', [join(old, 'bin/proofline'), 'upgrade'], { cwd: proj, env, timeout: STEP_TIMEOUT_MS });
  assert.equal(up.code, 0, up.stdout + up.stderr);
  const oldAgent = readFileSync(join(old, 'control-plane/agents/scripts/agent.sh'));
  assert.ok(readFileSync(join(proj, '.agents/scripts/agent.sh')).equals(oldAgent), 'upgrade installed the previous release\'s agent.sh');
  if (hadCore) assert.ok(!existsSync(join(proj, '.agents/scripts/proofline-core.mjs')), 'the previous release does not ship proofline-core.mjs: an unmodified copy is removed');
  assert.equal(readFileSync(join(proj, '.agents/runs/LC/LEDGER.log'), 'utf8'), ledgerBefore, 'the upgrade does not touch run state');
  assert.match(readFileSync(join(proj, '.agents/runs/LC/RUN.yaml'), 'utf8'), /state: "?CODE_DONE"?/);

  // 4. the run continues on the old code, to DONE; the seal still verifies
  const status = run('sh', ['./.agents/scripts/agent.sh', 'verify-seal', 'LC'], { cwd: proj, env });
  assert.equal(status.code, 0, status.stdout + status.stderr);
  const finish = shell(`${common}RID=LC; finish_done`, proj, lib(old));
  assert.equal(finish.code, 0, `${finish.signal ? `finish step killed by ${finish.signal} after ${STEP_TIMEOUT_MS / 1000} s; ` : ''}slowest calls (seconds rc command ID):\n${table(join(base, 'times'))}\n${finish.stdout}${finish.stderr}`);
  if (process.env.EQ_TIMES) process.stderr.write(`downgrade slowest calls:\n${table(join(base, 'times'))}\n`);
  assert.match(readFileSync(join(proj, '.agents/runs/LC/RUN.yaml'), 'utf8'), /state: "?DONE"?/);
  assert.equal(run('sh', ['./.agents/scripts/agent.sh', 'verify-seal', 'LC'], { cwd: proj, env }).code, 0);
  rmSync(base, { recursive: true, force: true });
});
