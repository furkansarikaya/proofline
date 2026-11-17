// @ts-check
// Stage 4, package 4C: `knowledge-done` (agent.sh 0.0.47 `knowledge_done`, `knowledge_na_signal`, `wiki_lint_run`, `require_no_knowledge_drift`). Messages and
// the order of the checks are those of the shell; a run that cannot be proven right is refused (the safe side).
import { lessonProposals, lessonsValidate } from './lessons.mjs';
import { batchKnowledgeRun, DEFAULT_REASON, imitatesBatchDefault, plainLine } from './ksuggest.mjs';
import { bdOf, tsvText } from './batch.mjs';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fail } from './errors.mjs';
import { latin1Buf } from './wirebytes.mjs';
import { forgetFiles, requireLead } from './approve.mjs';
import { hashFile } from './fingerprint.mjs';
import { taskOwnedPaths } from './gates.mjs';
import { verifySeal } from './ledger.mjs';
import { localTaskSourceRun, setRunValue } from './lifecycle.mjs';
import { justificationOk, led, must, need, quietly } from './lifeutil.mjs';
import { git, untrackedPaths } from './git.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { fileText, sectionKeyPresent, sectionValue, textLines, gatesEnforced } from './records.mjs';
import { knownControlArtifact, requireRun, runDir } from './runs.mjs';
import { designDocPaths, inKnowledgeScope } from './scope.mjs';
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

/** The batch folder's list of suggestions (one `ID<TAB>text` row per suggestion), kept after the run's own folder is gone: the rows of this task are replaced. @param {Context} ctx @param {string} id @param {string[]} list */
function recordSuggestions(ctx, id, list) {
  const file = `${bdOf(ctx)}/suggestions.tsv`;
  let old = '';
  try { old = readFileSync(file, 'latin1'); } catch { old = ''; }
  const keep = old.split('\n').filter((l) => l !== '' && l.split('\t')[0] !== id);
  for (const t of list) keep.push(`${id}\t${tsvText(t)}`);
  writeFileSync(`${file}.tmp`, latin1Buf(keep.length > 0 ? `${keep.join('\n')}\n` : ''));
  renameSync(`${file}.tmp`, file);
}

/** The files of the wiki that the step and its scripts maintain, at the wiki's own root only (A139: `docs/wiki/`); the same name in any other folder is a topic page (A326). */
const BOOKKEEPING = /^docs\/wiki\/(index\.md|log\.md|log-archive\.md|lint-report\.md|lessons\/observations\.md|concepts\/shortcut-debt\.md)$/;

/**
 * The topic pages this knowledge step OPENED (A326, A322.5): the knowledge-scope files ADDED since the run's base (staged or already committed on the task branch, `git diff --diff-filter=A`
 * against `repository.base_sha`) and the untracked ones, without the wiki root's own bookkeeping files and the run's control artifacts. An existing page that was updated is not listed; a task
 * whose topic already has a page updates it. FAILS CLOSED: a base that is not recorded or that git cannot diff against stops the command (the pages cannot be counted).
 * @param {Context} ctx @param {string} id @returns {string[]}
 */
export function newKnowledgePages(ctx, id) {
  const dir = runDir(ctx, id);
  const base = sectionValue(ctx, dir, 'repository', 'base_sha');
  if (!/^[0-9a-f]{7,64}$/.test(base)) fail(`knowledge-done blocked (A326): the run has no recorded base commit (repository.base_sha is '${base}'), so the pages this step opened cannot be counted; run agent.sh baseline ${id} first`);
  const r = git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '--diff-filter=A', '-z', base, '--']);
  if (r.status !== 0) fail(`knowledge-done blocked (A326): git could not compare the working tree with the run's base commit ${base}, so the pages this step opened cannot be counted`);
  /** @type {Set<string>} */ const fresh = new Set(untrackedPaths(ctx));
  for (const p of r.out.split('\0')) if (p !== '') fresh.add(p);
  return [...fresh].sort().filter((p) => inKnowledgeScope(ctx, p) && !BOOKKEEPING.test(p) && !knownControlArtifact(ctx, id, p));
}

/** `knowledge-done ID [KNOWLEDGE_DONE|not_applicable [REASON]]` @param {Context} ctx @param {string[]} args */
export function knowledgeDoneCommand(ctx, args) {
  const id = need(args, 0);
  let state = args[1] === undefined || args[1] === '' ? 'KNOWLEDGE_DONE' : args[1];
  let reason = args[2] ?? '';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  const batchRun = batchKnowledgeRun(ctx, id);
  /** @type {string[]} */ const suggestions = [];
  let tookDefault = false;
  let pageReason = '';
  if (state !== 'KNOWLEDGE_DONE' && state !== 'not_applicable') fail(`invalid knowledge state: ${state}`);
  const rs = sectionValue(ctx, dir, 'execution', 'state');
  let term;
  if (rs === 'CODE_DONE') term = false; else if (rs === 'FAILED' || rs === 'BLOCKED') term = true; else fail('knowledge-done requires CODE_DONE (or a FAILED/BLOCKED run) first');
  if (!sectionKeyPresent(ctx, dir, 'execution', 'knowledge_state')) fail('run schema has no execution.knowledge_state field to set');
  if (state === 'not_applicable') {
    if (!justificationOk(reason)) fail(`not_applicable needs a reason: agent.sh knowledge-done ${id} not_applicable "<one specific sentence: why the wiki and the design documents need nothing>" (>=20 chars, not a stock phrase)`);
    if (!sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) fail('run predates 0.0.17 (no knowledge_reason field): do the real knowledge step, then knowledge-done without not_applicable');
    if (/["\\#]/.test(reason)) fail('the not_applicable reason must not contain a double quote, a backslash or a #');
    if (imitatesBatchDefault(reason)) fail(`the not_applicable reason must not start with 'batch default' (A291): omit that text; the script writes it only for the default of an approved batch`);
    const rl = reason.split('\n');
    if (rl.filter((l) => l !== '').length > 1 || rl.some((l) => /[.!?][ \t\n\v\f\r]+[^ \t\n\v\f\r]/.test(l))) fail('the not_applicable reason must be one sentence on one line');
    const sig = knowledgeNaSignal(ctx, id);
    if (sig !== '') fail(`not_applicable refused: ${sig}.${batchRun ? ` This run is in the approved batch: nothing is asked here; run agent.sh knowledge-done ${id} (no reason, no page): the safe default records a suggestion to the user in the report and the batch goes on.` : ''} Run the knowledge step instead: a one-page note under docs/wiki/ is enough and does not change the tier or any gate (knowledge files the plan does not name are not task output); then 'agent.sh knowledge-done ${id}'`);
  }
  verifySeal(ctx, id, dir);
  requireNoKnowledgeDrift(ctx, id, 'knowledge-done blocked');
  if (!term && state === 'KNOWLEDGE_DONE') {
    const own = knowledgeOwnedPaths(ctx, id);
    if (own.length === 0 && reason !== '') fail('a reason is only for not_applicable, or for a step that opened more than one new page (A326)');
    if (own.length === 0 && batchRun && sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) {
      // A291: the unattended batch never asks where a note should go and never parks: the safe default (no page, nothing under docs/ or in skills/rules) and a suggestion to the user
      const sig = knowledgeNaSignal(ctx, id);
      suggestions.push(plainLine(`${id}: no knowledge note was written and nothing was changed under docs/, in skills or in rules; ${sig !== '' ? `${sig}; ` : ''}if you want it kept, write a wiki page or a design-document change yourself, or ask for a documentation task`));
      state = 'not_applicable'; reason = DEFAULT_REASON; tookDefault = true;
    } else if (own.length === 0) fail(`knowledge-done blocked (A200): no knowledge page was written. KNOWLEDGE_DONE records pages: write the wiki page, the ADR or the design document change the step is for (under ${ctx.config().get('knowledge_scope_root', 'docs/design/ docs/adr/ docs/wiki/ docs/product/')}), run the wiki lint, then run knowledge-done again; or, when the task needs no knowledge, agent.sh knowledge-done ${id} not_applicable "<one specific sentence>" (refused with the signal when the task changed behaviour or a contract)`);
    else {
      // A326 (A322.5): one new topic page per task. A second NEW page needs a recorded reason (update the existing page of the topic otherwise)
      const opened = newKnowledgePages(ctx, id);
      if (opened.length > 1) {
        if (reason === '') fail(`knowledge-done blocked (A326): this step opened ${opened.length} new pages (${opened.join(' ')}). A task keeps one page per topic: update the existing page of the topic instead of opening a second one. When the second page is a different topic, say why: agent.sh knowledge-done ${id} KNOWLEDGE_DONE "<one sentence: why each new page is a separate topic>"`);
        if (!justificationOk(reason) || /["\\#]/.test(reason) || reason.split('\n').filter((l) => l !== '').length > 1) fail('the reason for more than one new page must be one specific sentence of at least 20 characters without a double quote, a backslash or a #');
      }
      pageReason = opened.length > 1 ? `${opened.join(' ')}: ${reason}` : '';
      scanKnowledgeSecrets(ctx, id);
      wikiLintRun(ctx, own);
      forgetFiles(ctx); ctx.forget('changed:'); // the lint wrote its report into the wiki: the knowledge paths below are read again
    }
  }
  if (state === 'KNOWLEDGE_DONE' && reason !== '' && pageReason === '') fail('a reason is only for not_applicable, or for a step that opened more than one new page (A326)');
  if (!term && localTaskSourceRun(ctx, id)) quietly(ctx, () => must(freshness(ctx, id)));
  {
    const v = lessonsValidate(ctx);
    if (v.err !== '') ctx.err(v.err);
    if (!v.ok) fail('knowledge-done blocked: a lesson candidate has no valid source (agent.sh lessons validate names it)');
  }
  if (batchRun) {
    // A291: a lesson worth proposing is a suggestion to the user too (the script lists it from the records; no approval is requested, nothing is promoted, no agent text is involved)
    for (const p of lessonProposals(ctx, id)) suggestions.push(plainLine(`${id}: the finding kind ${p.kind} appeared in ${p.runs} runs; promoting it to a project rule in AGENTS.md needs your approval and was not requested here, nothing was promoted`));
  }
  if (state === 'KNOWLEDGE_DONE') reason = '';   // the page reason is recorded in its own ledger row; knowledge_reason stays the not_applicable reason
  setRunValue(ctx, id, 'execution', 'knowledge_state', state);
  if (sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) setRunValue(ctx, id, 'execution', 'knowledge_reason', reason);
  if (gatesEnforced(ctx, dir)) {
    led(ctx, id, 'knowledge-done', sectionValue(ctx, dir, 'handoff', 'state'), state, reason);
    if (state === 'KNOWLEDGE_DONE') {
      const l = knowledgeOwnedPaths(ctx, id).filter((p) => isFile(`${ctx.root}/${p}`)).map((p) => `${p}@${hashFile(`${ctx.root}/${p}`)}`);
      if (l.length > 0) led(ctx, id, 'knowledge-paths', '-', '-', l.join(' '));
      if (pageReason !== '') led(ctx, id, 'knowledge-pages-reason', '-', '-', pageReason);
    }
  }
  // A291: written AFTER the knowledge-done row; the reader takes the rows after the LAST knowledge-done row, so a retry (or a later run in any mode) never shows a duplicate or an old one
  const shown = gatesEnforced(ctx, dir) ? suggestions : []; // without gates there is no knowledge-done row, so no row that could start the list: none is written
  if (tookDefault && gatesEnforced(ctx, dir)) led(ctx, id, 'knowledge-default', '-', '-', 'A291'); // only this path writes it: the report and batch-status key on it
  for (const t of shown) led(ctx, id, 'knowledge-suggestion', '-', '-', t);
  if (batchRun || existsSync(`${bdOf(ctx)}/suggestions.tsv`)) recordSuggestions(ctx, id, shown); // any mode replaces the task's rows
  ctx.out(`knowledge state recorded: ${id} ${state}\n`);
  return 0;
}
