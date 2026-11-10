// @ts-check
// The fixture verbs of the former shell library (control-plane/agents/scripts/test-lib.sh, retired by issue #176 package E1, A244) as a command line, for the test recipes
// that are written as a few lines of sh text (`scaffold orchestrated no COMPLEX; worker RED fail ...; A handoff LC IMPLEMENTED`; tests/lib/recipe.mjs defines the sh functions
// that call this file). Each verb works in the current directory, which is a project of the harness (the Node core installed beside agent.sh); the knobs of the old
// library are the environment variables it had (SC_* for `scaffold`, RF_FOCUS and RF_EXTRA for gate results, WEV_EF, QA_NO_BIND). A verb that the control plane refuses
// exits non-zero with the control plane's message (the recipes run under `set -e`, as the library did).
//   node tests/lib/verbs.mjs VERB [ARG...]
import { pathToFileURL } from 'node:url';
import {
  approveAsUser, copyOf, defaultTemplate, installGithooks, finishDone, gfail, gpass, newRepo, passAll, pipe, qaBind, rec, resultFor, rv, say, scaffold, solo, tcStatus, toCodeDone, tsha, wclose, wev, wopen, worker, writeReport,
} from './harness.mjs';

/** @param {string} n */ const env = (n) => process.env[n] || '';
/** The scaffold options from the SC_* variables. @param {string[]} a @returns {import('./harness.mjs').ScaffoldOptions} */
function scaffoldOptions(a) {
  /** @type {import('./harness.mjs').ScaffoldOptions} */
  const o = { topology: a[0], layout: a[1] === 'yes' ? 'yes' : 'no' };
  if (a[2]) o.cls = a[2];
  if (a[3]) o.autonomy = a[3];
  if (env('SC_BRANCH')) o.branch = true;
  if (env('SC_TASK_FM')) o.taskFm = env('SC_TASK_FM');
  if (env('SC_TASK_EXTRA')) o.taskExtra = env('SC_TASK_EXTRA');
  if (env('SC_TEST_CRIT')) o.testCrit = env('SC_TEST_CRIT');
  if (env('SC_SCOPE_OTHER')) o.scopeOther = env('SC_SCOPE_OTHER');
  if (env('SC_SCOPE_EXTRA')) o.scopeExtra = env('SC_SCOPE_EXTRA');
  if (env('SC_SCOPE_AGENTS')) o.scopeAgents = true;
  if (env('SC_SCOPE_NAMED')) o.scopeNamed = env('SC_SCOPE_NAMED');
  if (env('SC_EXEMPT')) o.exempt = true;
  if (env('SC_QA_EXTRA')) o.qaExtra = env('SC_QA_EXTRA');
  if (env('SC_PLAN_EXTRA')) o.planExtra = env('SC_PLAN_EXTRA');
  if (env('SC_KIND_CLAIM')) o.kindClaim = env('SC_KIND_CLAIM');
  if (env('tl_template')) o.template = env('tl_template');   // a recipe that prepared its own template (tpl_tasks: task files, scripts)
  if (env('SC_AGENTS_MD')) o.agentsMd = env('SC_AGENTS_MD') === '2' ? 2 : 1;
  return o;
}
/** The options of a gate result: the risk focus and the extra report text of the environment. @param {string} [confidence] */
const gateOptions = (confidence) => ({ ...(env('RF_FOCUS') ? { focus: env('RF_FOCUS') } : {}), ...(env('RF_EXTRA') ? { extra: env('RF_EXTRA') } : {}), ...(confidence ? { confidence } : {}) });

/**
 * One verb. Verbs that make a project print its directory (the sh function changes into it); verbs that print a value print it.
 * @param {string} verb @param {string[]} a @returns {string}
 */
export function runVerb(verb, a) {
  const dir = process.cwd();
  switch (verb) {
    case 'new_repo': return env('tl_template') ? copyOf(env('tl_template')) : newRepo();
    case 'template': return defaultTemplate();
    case 'scaffold': return scaffold(scaffoldOptions(a));
    case 'to_code_done': toCodeDone(dir, a[0] ?? 'orchestrated', env('RF_EXTRA') ? { extra: env('RF_EXTRA') } : {}); return '';
    case 'worker': worker(dir, a[0], a[1], a[2], a[3]); return '';
    case 'solo': solo(dir, a[0], a[1], a[2], a[3], a[4]); return '';
    case 'wopen': return wopen(dir);
    case 'wclose': wclose(dir, a[0]); return '';
    case 'wev': wev(dir, a[0], a[1], { ...(a[2] ? { target: a[2] } : {}), ...(env('WEV_EF') ? { ef: env('WEV_EF') } : {}) }); return '';
    case 'rec': rec(dir, a[0], a[1], a.slice(3), gateOptions(a[2])); return '';
    case 'result_for': return resultFor(dir, a[0], a[1], a.slice(3), gateOptions(a[2]));
    case 'gpass': gpass(dir, a[0], gateOptions()); return '';
    case 'gfail': gfail(dir, a[0], a[1]); return '';
    case 'pass_all': passAll(dir, env('RF_EXTRA') ? { extra: env('RF_EXTRA') } : {}); return '';
    case 'required': return pipe(dir, 'gates');
    case 'finish_done': finishDone(dir, ...a); return '';
    case 'write_report': writeReport(dir, ...a); return '';
    case 'tc_status': tcStatus(a[0], a[1]); return '';
    case 'capture': say(dir, a[0], a[1] ? { time: Number(a[1]) } : {}); return '';   // stamped after every record of the project (the core ignores a capture dated more than 5 seconds ahead)
    case 'approve_as_user': approveAsUser(dir, a[0], a[1]); return '';
    case 'install_githooks': installGithooks(dir, a[0]); return '';
    case 'qa_bind': qaBind(dir, a[0] ?? ''); return '';
    case 'rv': return rv(dir, a[0], a[1], env('RID') || 'LC');
    case 'pipe_val': return pipe(dir, a[0], env('RID') || 'LC');
    case 'tsha': return tsha(a[0]);
    default: throw new Error(`verbs: unknown verb ${verb}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const out = runVerb(process.argv[2], process.argv.slice(3));
    if (out) process.stdout.write(`${out}\n`);
  } catch (e) {
    process.stderr.write(`${/** @type {Error} */ (e).message}\n`);
    process.exitCode = 1;
  }
}
