// @ts-check
// Fixture states of the Stage 2 scenario cases (issue #167): every gate state of the gates-test fixtures, the risk-test fixtures and the scaling
// fixture (0/20/60 changed files). Each state is a shell snippet run after test-lib.sh `scaffold`; a state is built once per process, on first
// use (building one takes seconds, and a pull request replays only the touched commands), and copied into every case that names it.
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCore, agentsSrc, baseEnv, installedFixture, run, scriptsSrc } from '../fixture.mjs';

/** @typedef {import('../fixture.mjs').Fixture} Fixture */

// the helpers of risk-test.sh that the risk states need (copied: that file is a suite, not a library)
const RISK = `
rrun() {
  scaffold standalone no "$1" manual
  { printf '%s\\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl_test.txt' '    criteria: [AC-1]'
    for rr_p in $2; do printf '  - path: %s\\n    new: true\\n    criteria: [AC-1]\\n    tdd_exemption: "static artifact with no executable behavior; the risk focus checks it"\\n' "$rr_p"; done
    printf '%s\\n' '---' '# Plan' '' '## Assumptions' 'none' '' '## Architecture' 'one storage map; no new module'
    [ -z "\${3:-}" ] || printf '%s\\n' "$3"; } > .agents/runs/LC/PLAN.md
}
frozen() {
  case "$(rv pipeline classification)" in COMPLEX|CRITICAL) approve_as_user plan 'approve the plan' ;; esac
  A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
}
implement() {
  solo RED fail impl_test.txt 'test: lookup returns the stored value'
  mkdir -p "$(dirname "$1")"; printf '%s\\n' "$2" > "$1"
  solo GREEN pass impl.txt 'impl: lookup returns the stored value' "impl.txt,impl_test.txt,$1"
  A handoff LC IMPLEMENTED >/dev/null
}
risk_open() { rrun COMPLEX 'src/b.go'; frozen; implement src/b.go 'logger.info("login", user.Password)'; }
`;
const IMPL = `worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null`;
const files = (/** @type {number} */ n) => `mkdir -p src; i=0; while [ "$i" -lt ${n} ]; do printf "line %s\\\\n" "$i" > "src/f$i.txt"; i=$((i + 1)); done`;

// the intake of a run, in lifecycle order (what `next` prints first: classify, then branch, then baseline): one scaffolded run, its RUN.yaml put back
// to the state before each of these steps
const INTAKE = (/** @type {string} */ undo) => `SC_BRANCH=1 scaffold standalone no STANDARD manual
sed ${undo} .agents/runs/LC/RUN.yaml > .agents/runs/LC/RUN.tmp && mv .agents/runs/LC/RUN.tmp .agents/runs/LC/RUN.yaml`;
const UNDO_BASELINE = "-e 's/^  status: captured/  status: pending/'";
const UNDO_BRANCH = `-e 's/^  task_branch:.*/  task_branch: PENDING/' ${UNDO_BASELINE}`;
const UNDO_CLASSIFY = `-e 's/^  classification:.*/  classification: PENDING/' ${UNDO_BRANCH}`;

/** state name -> the shell that builds it (cwd is the new fixture after it). */
export const STATES = /** @type {Record<string, string>} */ ({
  // gates-test: a frozen orchestrated COMPLEX run and the gate states a run passes through
  'gates-frozen': 'scaffold orchestrated no COMPLEX',
  'gates-implemented': `scaffold orchestrated no COMPLEX; ${IMPL}`,
  'gates-partial': `scaffold orchestrated no COMPLEX; ${IMPL}; A secret-scan LC >/dev/null; gpass REVIEW_SMALL`,
  'gates-failed': `scaffold orchestrated no COMPLEX; ${IMPL}; A secret-scan LC >/dev/null; gfail REVIEW_SMALL impl.txt`,
  // a risky path makes the tier full: the full gate set (plan, rules, tests, security reviews), one passed, one failed
  'gates-full': `scaffold orchestrated no COMPLEX; ${IMPL}; printf '{}\\n' > package.json; A tier LC >/dev/null; A secret-scan LC >/dev/null; gpass REVIEW_PLAN; gfail REVIEW_RULES impl.txt`,
  'gates-allpass': `scaffold orchestrated no COMPLEX; ${IMPL}; pass_all`,
  'gates-stale': `scaffold orchestrated no COMPLEX; ${IMPL}; pass_all; printf 'edit after the gates\\n' >> impl.txt`,
  'gates-codedone': `scaffold orchestrated no COMPLEX; ${IMPL}; pass_all; A handoff LC CODE_DONE >/dev/null`,
  'gates-done': `scaffold orchestrated no COMPLEX; ${IMPL}; pass_all; A handoff LC CODE_DONE >/dev/null; finish_done`,
  'gates-standalone': 'scaffold standalone no STANDARD',
  'intake-unclassified': INTAKE(UNDO_CLASSIFY),
  'intake-classified': INTAKE(UNDO_BRANCH),
  'intake-branched': INTAKE(UNDO_BASELINE),
  'intake-planned': 'SC_BRANCH=1 scaffold standalone no STANDARD manual',
  // risk-test: a run whose diff opens the logging focus, that focus passed, and a run before its freeze
  'risk-unfrozen': `${RISK}
rrun COMPLEX 'src/b.go'`,
  'risk-open': `${RISK}
risk_open`,
  'risk-passed': `${RISK}
risk_open; pass_all`,
  // the scaling fixture of tests/bench/agent-procs.mjs: the frozen run plus N untracked changed files
  'scale-0': `scaffold orchestrated no COMPLEX; ${files(0)}`,
  'scale-20': `scaffold orchestrated no COMPLEX; ${files(20)}`,
  'scale-60': `scaffold orchestrated no COMPLEX; ${files(60)}`,
});
export const RUN_STATES = Object.keys(STATES);
export const SCALE_STATES = ['scale-0', 'scale-20', 'scale-60'];

/** @type {Map<string, Fixture>} */ const built = new Map();

/** True when a ledger line of the tree has ts= and epoch= naming different seconds: the 0.0.40 shell read `date` twice across a second boundary (see isShellFlake in rig.mjs). */
function ledgerStraddles(/** @type {string} */ dir) {
  const runs = join(dir, '.agents/runs');
  if (!existsSync(runs)) return false;
  for (const r of readdirSync(runs)) {
    const f = join(runs, r, 'LEDGER.log');
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'latin1').matchAll(/ ts=(\S+) epoch=(\d+)/g)) if (Date.parse(m[1]) / 1000 !== Number(m[2])) return true;
  }
  return false;
}

/** What an installed project has beside agent.sh (what `proofline init` copies): every non-test script, the data files; test-lib fixtures hold only a few of them. */
function installLikeProject(/** @type {string} */ out) {
  const a = join(out, '.agents');
  for (const f of readdirSync(scriptsSrc)) {
    if (f.endsWith('-test.sh') || f === 'test-lib.sh' || f === 'core' || f === 'proofline-core.mjs') continue;
    if (!existsSync(join(a, 'scripts', f))) cpSync(join(scriptsSrc, f), join(a, 'scripts', f), { recursive: true });
  }
  for (const f of ['ecosystems.json', 'ecosystems.mjs', 'ecosystems.tsv', 'owns.conf', 'roles.conf', 'tools.conf']) if (existsSync(join(agentsSrc, f)) && !existsSync(join(a, f))) copyFileSync(join(agentsSrc, f), join(a, f));
  for (const d of ['modes', 'templates', 'task-integrations', 'githooks']) if (!existsSync(join(a, d))) cpSync(join(agentsSrc, d), join(a, d), { recursive: true });
  for (const f of readdirSync(join(a, 'scripts'))) if (f.endsWith('.sh')) chmodSync(join(a, 'scripts', f), 0o755);
  // the added files are not part of the project's history: the scope checks must not list them
  const ex = join(out, '.git/info/exclude');
  if (existsSync(join(out, '.git'))) appendFileSync(ex, '.agents/scripts/\n.agents/ecosystems.*\n.agents/*.conf\n');
}

function buildState(/** @type {string} */ name, /** @type {string} */ script) {
  const out = mkdtempSync(join(tmpdir(), `eq-s2-${name}.`)); const builtAt = Math.floor(Date.now() / 1000);
  const r = run('sh', ['-c', `. "$EQ_LIB"; ${script}\ncp -R "$PWD/." "$EQ_OUT/"`, join(scriptsSrc, 'x.sh')],
    { env: { ...baseEnv(out), EQ_OUT: out, EQ_LIB: join(scriptsSrc, 'test-lib.sh') } });
  if (r.code !== 0) throw new Error(`fixture state ${name} failed (${r.code}): ${r.stderr}${r.stdout}`);
  return { out, builtAt };
}

/** @returns {Fixture} the state's fixture (built on first use; rebuilt once when the known shell flake straddled a second while building). */
export function stateFixture(/** @type {string} */ name) {
  if (name === 'empty') return installedFixture();
  const hit = built.get(name); if (hit) return hit;
  const script = STATES[name]; if (!script) throw new Error(`unknown fixture state ${name}`);
  let b = buildState(name, script);
  if (ledgerStraddles(b.out)) { rmSync(b.out, { recursive: true, force: true }); b = buildState(name, script); }
  const { out, builtAt } = b;
  if (ledgerStraddles(out)) throw new Error(`fixture state ${name}: a ledger line names different seconds in ts= and epoch= twice in a row`);
  installLikeProject(out);
  addCore(out);
  for (const k of ['gc.auto', 'maintenance.auto']) run('git', ['config', k, k === 'gc.auto' ? '0' : 'false'], { cwd: out, env: baseEnv(out) });
  const f = { dir: out, builtAt }; built.set(name, f); return f;
}
