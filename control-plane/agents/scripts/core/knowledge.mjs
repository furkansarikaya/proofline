// @ts-check
// Stage 4, package 4C: `knowledge-done` (agent.sh 0.0.47 `knowledge_done`, `knowledge_na_signal`, `wiki_lint_run`, `require_no_knowledge_drift`). Messages and
// the order of the checks are those of the shell; a run that cannot be proven right is refused (the safe side).
import { lessonsValidate } from './lessons.mjs';
import { existsSync } from 'node:fs';
import { fail } from './errors.mjs';
import { forgetFiles, requireLead } from './approve.mjs';
import { hashFile } from './fingerprint.mjs';
import { taskOwnedPaths } from './gates.mjs';
import { verifySeal } from './ledger.mjs';
import { localTaskSourceRun, setRunValue } from './lifecycle.mjs';
import { justificationOk, led, must, need, quietly } from './lifeutil.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { fileText, sectionKeyPresent, sectionValue, textLines, gatesEnforced } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { designDocPaths } from './scope.mjs';
import { knowledgeDrift, scanKnowledgeSecrets } from './commands/runcmds.mjs';
import { freshness, knowledgeOwnedPaths } from './commands/verify.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WORDS = /(?<![A-Za-z0-9_])(commands?|flags?|options?|config(?:uration)?|outputs?|error messages?|APIs?|endpoints?)(?![A-Za-z0-9_])/i;

/** The lines of a `## Heading` section of a document (up to the next `## `). @param {string[]} lines @param {RegExp} head */
function sectionLines(lines, head) {
  /** @type {string[]} */ const out = [];
  let inside = false;
  for (const l of lines) {
    if (head.test(l)) { inside = true; continue; }
    if (l.startsWith('## ')) inside = false;
    if (inside) out.push(l);
  }
  return out;
}

/** `knowledge_na_signal ID`: why `not_applicable` is refused ('' when it is not). @param {Context} ctx @param {string} id */
export function knowledgeNaSignal(ctx, id) {
  const dir = runDir(ctx, id);
  const docs = designDocPaths(ctx);
  let owned = [];
  try { owned = taskOwnedPaths(ctx, dir).map(([p]) => p); } catch { owned = []; }
  for (const p of owned) {
    if (p.startsWith('docs/')) return `the task changed ${p}, a documentation path`;
    if (docs.includes(p)) return `the task changed the design document ${p}`;
  }
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (plan !== null) {
    const lines = textLines(plan);
    if (sectionLines(lines, /^## Contracts[ \t\n\v\f\r]*$/).some((l) => /[^ \t]/.test(l) && !/^none/i.test(l))) return 'PLAN.md lists a contract change';
    if (lines.some((l) => /^contract_change:[ \t\n\v\f\r]*yes/.test(l))) return 'PLAN.md flags contract_change: yes';
    if (sectionLines(lines, /^## Data[ \t\n\v\f\r]*$/).filter((l) => /[^ \t]/.test(l)).length > 1) return 'PLAN.md has a Data section (a durable contract)';
    for (const q of docs) if (plan.includes(q)) return `PLAN.md names the design document ${q}`;
  }
  const task = fileText(ctx, `${dir}/TASK.md`);
  if (task !== null) {
    for (const l of sectionLines(textLines(task), /^## Acceptance criteria[ \t\n\v\f\r]*$/)) {
      const m = WORDS.exec(l);
      if (m !== null) return `the acceptance criteria mention '${m[1]}' (user-visible behaviour)`;
    }
  }
  return '';
}

/** `require_no_knowledge_drift ID WHAT` @param {Context} ctx @param {string} id @param {string} what */
export function requireNoKnowledgeDrift(ctx, id, what) {
  const rnk = knowledgeDrift(ctx, id).slice(0, 5).join(';');
  if (rnk !== '') fail(`${what}: design-sync drift in knowledge-scope documents is still there (${rnk}); the knowledge step must fix it (update the document or the code claim), then 'agent.sh knowledge-done ${id}'. No waiver or scope change applies to these documents`);
}

/** `wiki_lint_run ID PATHS` (A200): the llm-wiki lint of every wiki folder the knowledge step changed. @param {Context} ctx @param {string[]} owned */
function wikiLintRun(ctx, owned) {
  const dirs = [...new Set(owned.map((p) => /^((?:.*\/)?wiki)\/.*/s.exec(p)?.[1] ?? '').filter((d) => d !== ''))].sort();
  if (dirs.length === 0) return;
  if (!isFile(`${ctx.root}/.agents/skills/llm-wiki/scripts/validate-wiki.mjs`)) fail('knowledge-done blocked (A200): the wiki lint cannot run because .agents/skills/llm-wiki/scripts/validate-wiki.mjs is missing. Install the llm-wiki skill into .agents/skills/llm-wiki/ (its scripts/validate-wiki.mjs), then run knowledge-done again');
  for (const d of dirs) {
    if (!existsSync(`${ctx.root}/${d}`)) continue;
    const r = proc.run(process.execPath, ['.agents/skills/llm-wiki/scripts/validate-wiki.mjs', d, '--root', '.'], { cwd: ctx.root, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const text = Buffer.concat([r.stdout, r.stderr]).toString('latin1').replace(/\n+$/, '');
    if (r.status === 0) continue;
    if (r.status === 1) {
      ctx.err(text.split('\n').slice(0, 12).map((l) => `  ${l}\n`).join(''));
      fail(`knowledge-done blocked (A200): the wiki lint of ${d} found errors (listed above; ${d}/lint-report.md has them all). Fix the pages, then run knowledge-done again`);
    }
    fail(`knowledge-done blocked (A200): the wiki lint of ${d} could not run (exit ${r.status}): ${text.split('\n').slice(0, 2).join(' ')}`);
  }
}

/** `knowledge-done ID [KNOWLEDGE_DONE|not_applicable [REASON]]` @param {Context} ctx @param {string[]} args */
export function knowledgeDoneCommand(ctx, args) {
  const id = need(args, 0);
  const state = args[1] === undefined || args[1] === '' ? 'KNOWLEDGE_DONE' : args[1];
  const reason = args[2] ?? '';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  if (state !== 'KNOWLEDGE_DONE' && state !== 'not_applicable') fail(`invalid knowledge state: ${state}`);
  const rs = sectionValue(ctx, dir, 'execution', 'state');
  let term;
  if (rs === 'CODE_DONE') term = false; else if (rs === 'FAILED' || rs === 'BLOCKED') term = true; else fail('knowledge-done requires CODE_DONE (or a FAILED/BLOCKED run) first');
  if (!sectionKeyPresent(ctx, dir, 'execution', 'knowledge_state')) fail('run schema has no execution.knowledge_state field to set');
  if (state === 'not_applicable') {
    if (!justificationOk(reason)) fail(`not_applicable needs a reason: agent.sh knowledge-done ${id} not_applicable "<one specific sentence: why the wiki and the design documents need nothing>" (>=20 chars, not a stock phrase)`);
    if (!sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) fail('run predates 0.0.17 (no knowledge_reason field): do the real knowledge step, then knowledge-done without not_applicable');
    if (/["\\#]/.test(reason)) fail('the not_applicable reason must not contain a double quote, a backslash or a #');
    const rl = reason.split('\n');
    if (rl.filter((l) => l !== '').length > 1 || rl.some((l) => /[.!?][ \t\n\v\f\r]+[^ \t\n\v\f\r]/.test(l))) fail('the not_applicable reason must be one sentence on one line');
    const sig = knowledgeNaSignal(ctx, id);
    if (sig !== '') fail(`not_applicable refused: ${sig}. Run the knowledge step instead: a one-page note under docs/wiki/ is enough and does not change the tier or any gate (knowledge files the plan does not name are not task output); then 'agent.sh knowledge-done ${id}'`);
  } else if (reason !== '') fail('a reason is only for not_applicable');
  verifySeal(ctx, id, dir);
  requireNoKnowledgeDrift(ctx, id, 'knowledge-done blocked');
  if (!term && state === 'KNOWLEDGE_DONE') {
    const own = knowledgeOwnedPaths(ctx, id);
    if (own.length === 0) fail(`knowledge-done blocked (A200): no knowledge page was written. KNOWLEDGE_DONE records pages: write the wiki page, the ADR or the design document change the step is for (under ${ctx.config().get('knowledge_scope_root', 'docs/design/ docs/adr/ docs/wiki/ docs/product/')}), run the wiki lint, then run knowledge-done again; or, when the task needs no knowledge, agent.sh knowledge-done ${id} not_applicable "<one specific sentence>" (refused with the signal when the task changed behaviour or a contract)`);
    scanKnowledgeSecrets(ctx, id);
    wikiLintRun(ctx, own);
    forgetFiles(ctx); ctx.forget('changed:'); // the lint wrote its report into the wiki: the knowledge paths below are read again
  }
  if (!term && localTaskSourceRun(ctx, id)) quietly(ctx, () => must(freshness(ctx, id)));
  {
    const v = lessonsValidate(ctx);
    if (v.err !== '') ctx.err(v.err);
    if (!v.ok) fail('knowledge-done blocked: a lesson candidate has no valid source (agent.sh lessons validate names it)');
  }
  setRunValue(ctx, id, 'execution', 'knowledge_state', state);
  if (sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) setRunValue(ctx, id, 'execution', 'knowledge_reason', reason);
  if (gatesEnforced(ctx, dir)) {
    led(ctx, id, 'knowledge-done', sectionValue(ctx, dir, 'handoff', 'state'), state, reason);
    if (state === 'KNOWLEDGE_DONE') {
      const l = knowledgeOwnedPaths(ctx, id).filter((p) => isFile(`${ctx.root}/${p}`)).map((p) => `${p}@${hashFile(`${ctx.root}/${p}`)}`);
      if (l.length > 0) led(ctx, id, 'knowledge-paths', '-', '-', l.join(' '));
    }
  }
  ctx.out(`knowledge state recorded: ${id} ${state}\n`);
  return 0;
}
