// @ts-check
// Test recipes: a project built by a few lines of sh text over the fixture verbs (`scaffold orchestrated no COMPLEX; worker RED fail impl_test.txt 'x'; A handoff LC IMPLEMENTED`).
// This is the Node home of what control-plane/agents/scripts/test-lib.sh offered to the Node suites (issue #176 package E1, A244): the verbs are tests/lib/verbs.mjs (the harness
// functions as a command line), `A`/`AS` call the installed agent.sh, and sh only glues the lines together (`set -e`, loops over `required`, `sed -i`). Nothing here sources a shell
// library of the repository. The project is built in a private folder under the temp directory, and the recipe's last directory is copied out.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentsSrc, cleanEnv } from './harness.mjs';

const verbsFile = path.join(import.meta.dirname, 'verbs.mjs');
/** The knobs of the verbs; exported once so that `SC_BRANCH=1 scaffold ...` reaches the verb process in every shell. */
const KNOBS = ['SC_BRANCH', 'SC_TASK_FM', 'SC_TASK_EXTRA', 'SC_TEST_CRIT', 'SC_SCOPE_OTHER', 'SC_SCOPE_EXTRA', 'SC_SCOPE_AGENTS', 'SC_SCOPE_NAMED', 'SC_EXEMPT', 'SC_QA_EXTRA', 'SC_PLAN_EXTRA', 'SC_KIND_CLAIM', 'SC_AGENTS_MD', 'RF_FOCUS', 'RF_EXTRA', 'WEV_EF', 'QA_NO_BIND', 'RID', 'tl_template'];
/** Verbs that print a value (called as `$(verb ...)`) and verbs that work in place. */
const PLAIN = ['to_code_done', 'worker', 'solo', 'wev', 'rec', 'gpass', 'gfail', 'pass_all', 'finish_done', 'write_report', 'tc_status', 'capture', 'approve_as_user', 'install_githooks', 'qa_bind', 'rv', 'pipe_val', 'tsha', 'required', 'result_for'];
/** Verbs that make a project: the sh function changes into the directory they print. */
const MAKERS = ['new_repo', 'scaffold'];

/** The sh text that defines the verbs as functions. */
export const PRELUDE = [
  `PL_VERBS='${verbsFile}'; tl_agents='${agentsSrc}'; RID=LC; base="$PL_HARNESS_BASE"; export RID tl_agents`,
  `export ${KNOBS.join(' ')}`,
  ...MAKERS.map((v) => `${v}() { pl_d=$(node "$PL_VERBS" ${v} "$@") && cd "$pl_d"; }`),
  ...PLAIN.map((v) => `${v}() { node "$PL_VERBS" ${v} "$@"; }`),
  'tl_ensure_template() { [ -n "${tl_template:-}" ] || tl_template=$(node "$PL_VERBS" template); }',   // a recipe that prepares its own template starts from the default one
  'wopen() { W=$(node "$PL_VERBS" wopen); }',
  'wclose() { node "$PL_VERBS" wclose "$W"; }',
  'A() { case "${1:-}" in freeze|refreeze) [ -n "${QA_NO_BIND:-}" ] || node "$PL_VERBS" qa_bind "${2:-}" ;; esac; sh ./.agents/scripts/agent.sh "$@"; }',
  'AS() { as_r=$1; shift; AGENT_ROLE=$as_r sh ./.agents/scripts/agent.sh "$@"; }',
].join('\n');

/**
 * Run recipe text in a new project folder OUT: the recipe starts in no project (it makes one with `new_repo` or `scaffold`), and the directory it ends in is copied to OUT.
 * @param {string} recipe sh text @param {string} out an existing empty folder @param {{ prelude?: string, timeout?: number, errexit?: boolean }} [o] prelude: more sh text defined before the recipe; errexit: false lets a failing step go on (the former fixture builders of the equivalence rigs ran without `set -e`, and some recipes end in a step the control plane refuses on purpose)
 */
export function buildRecipe(recipe, out, o = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'proofline-recipe-'));
  try {
    const start = path.join(work, 'start'); mkdirSync(start);
    const script = path.join(work, 'recipe.sh');
    writeFileSync(script, `${o.errexit === false ? '' : 'set -e\n'}${PRELUDE}\n${o.prelude ?? ''}\n${recipe}\ncp -R "$PWD/." "$PL_OUT/"\n`);
    const r = spawnSync('sh', [script], { cwd: start, env: cleanEnv({ PL_HARNESS_BASE: work, PL_OUT: out }), encoding: 'utf8', timeout: o.timeout ?? 900000 });
    if (r.status !== 0) throw new Error(`recipe failed (${r.status}): ${recipe}\n${r.stderr}${r.stdout}`);
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

/**
 * Run fixture verbs and other sh text INSIDE an existing project (state building; the asserted action is the caller's). Fails like a recipe does: with the output.
 * @param {string} dir @param {string} snippet @param {{ prelude?: string, timeout?: number }} [o] @returns {{ status: number | null, out: string, err: string, text: string }}
 */
export function runIn(dir, snippet, o = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'proofline-recipe-'));
  try {
    const script = path.join(work, 'snippet.sh');
    writeFileSync(script, `${PRELUDE}\n${o.prelude ?? ''}\ncd "$PL_DIR"\n${snippet}\n`);
    const r = spawnSync('sh', [script], { cwd: dir, env: cleanEnv({ PL_HARNESS_BASE: work, PL_DIR: dir, DIR: dir }), encoding: 'utf8', timeout: o.timeout ?? 600000 });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', text: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

