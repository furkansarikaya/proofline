// @ts-check
// A pull request that changes certain files must say why (CI step "changed only with a reason").
//   node tests/ci/change-reason.mjs invariants       a file under tests/invariants/ or tests/invariants-node/ changed: the description needs a line
//                                                    `Invariant-test-change: <reason, at least 12 characters>` (CONTRIBUTING.md, Core invariants)
//   node tests/ci/change-reason.mjs context-budget   tests/context/budget.tsv changed: the description needs a line
//                                                    `Context-budget-change: <reason, at least 12 characters>` (A202)
// The changed paths come from stdin (one per line), or from `git diff --name-only --no-renames BASE HEAD` with --base BASE --head HEAD.
// The description comes from, in this order: $PR_BODY; the file $PR_BODY_FILE; the live description with --repo OWNER/NAME --pr N (`gh api`, GH_TOKEN
// from the environment; a failure falls through); the pull_request.body field of the event payload $GITHUB_EVENT_PATH. A run that is not a pull
// request (GITHUB_EVENT_NAME other than pull_request) has no description to check and passes.
// Exit 0: nothing guarded changed, or the line is there. Exit 1: changed without the line. Exit 2: usage.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @type {Record<string, { name: string, guarded: RegExp, line: string, what: string, help: string[] }>} */
export const RULES = {
  invariants: {
    name: 'invariants', guarded: /^tests\/invariants(-node)?\//, line: 'Invariant-test-change',
    what: 'no file under tests/invariants/ changed',
    help: ['invariants: this pull request changes files under tests/invariants/, so its description must contain a line',
      '  Invariant-test-change: <why the invariant test changed, at least 12 characters>',
      '  and the review must approve that change separately (CONTRIBUTING.md, Core invariants). Changed:'],
  },
  'context-budget': {
    name: 'context budget', guarded: /^tests\/context\/budget\.tsv$/, line: 'Context-budget-change',
    what: 'tests/context/budget.tsv did not change',
    help: ['context budget: this pull request changes tests/context/budget.tsv, so its description must contain a line',
      '  Context-budget-change: <why the context budget changed, at least 12 characters>'],
  },
};

/** @param {string} line the label @param {string} body */
export function hasReasonLine(line, body) {
  return new RegExp(`^${line}:[ \\t\\v\\f]*\\S.{11,}$`, 'm').test(body.replace(/\r/g, ''));
}

/**
 * @param {string} rule invariants | context-budget
 * @param {string[]} changed
 * @param {{ env: NodeJS.ProcessEnv, liveBody?: () => string | null }} o
 * @returns {{ status: number, out: string[], err: string[] }}
 */
export function evaluate(rule, changed, { env, liveBody }) {
  const r = RULES[rule];
  const guarded = changed.filter((p) => r.guarded.test(p));
  if (guarded.length === 0) return { status: 0, out: [`${r.name === 'invariants' ? 'invariants' : 'context budget'}: ${r.what}`], err: [] };
  const ev = env.GITHUB_EVENT_NAME ?? 'pull_request';
  if (ev !== 'pull_request' && ev !== 'pull_request_target') return { status: 0, out: [`${r.name === 'invariants' ? 'invariants' : 'context budget'}: ${ev} is not a pull request; nothing to check`], err: [] };
  let body = '';
  if (env.PR_BODY !== undefined) body = env.PR_BODY;
  else if (env.PR_BODY_FILE) {
    if (!existsSync(env.PR_BODY_FILE)) return { status: 2, out: [], err: [`${r.name === 'invariants' ? 'invariants' : 'context budget'}: PR_BODY_FILE does not exist: ${env.PR_BODY_FILE}`] };
    body = readFileSync(env.PR_BODY_FILE, 'utf8');
  } else {
    const live = liveBody?.() ?? null;
    if (live !== null) body = live;
    else if (env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
      try { body = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.body ?? ''; } catch { body = ''; }
    }
  }
  if (hasReasonLine(r.line, body)) {
    return { status: 0, out: [rule === 'invariants' ? 'invariants: the pull request explains the change of tests/invariants/ (a reviewer approves it separately)' : 'context budget: the pull request explains the change of the budget'], err: [] };
  }
  return { status: 1, out: [], err: [...r.help, ...(rule === 'invariants' ? guarded.map((g) => `    ${g}`) : [])] };
}

/** @param {string[]} argv @param {{ env?: NodeJS.ProcessEnv, stdin?: () => string, write?: (s: string) => void }} [o] @returns {number} */
export function main(argv, o = {}) {
  const env = o.env ?? process.env;
  const write = o.write ?? ((s) => process.stdout.write(s));
  const rule = argv[0];
  if (!rule || !(rule in RULES)) { console.error('usage: change-reason.mjs invariants|context-budget [--base SHA --head SHA] [--repo OWNER/NAME --pr N]'); return 2; }
  /** @type {Record<string, string>} */ const opt = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!['--base', '--head', '--repo', '--pr'].includes(argv[i]) || argv[i + 1] === undefined) { console.error(`change-reason: bad argument: ${argv[i]}`); return 2; }
    opt[argv[i].slice(2)] = argv[i + 1];
  }
  let text;
  if (opt.base && opt.head) {
    try { text = execFileSync('git', ['diff', '--name-only', '--no-renames', opt.base, opt.head], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch (e) { console.error(`change-reason: git diff failed: ${/** @type {Error} */ (e).message}`); return 2; }
  } else text = (o.stdin ?? (() => readFileSync(0, 'utf8')))();
  const liveBody = opt.repo && opt.pr
    ? () => { try { return execFileSync('gh', ['api', `repos/${opt.repo}/pulls/${opt.pr}`, '--jq', '.body // ""'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, ''); } catch { return null; } }
    : undefined;
  const r = evaluate(rule, text.split('\n').filter((x) => x !== ''), { env, liveBody });
  for (const l of r.out) write(`${l}\n`);
  for (const l of r.err) console.error(l);
  return r.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
