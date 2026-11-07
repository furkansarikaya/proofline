// @ts-check
// `batch-plan [--replace] <ID...|all>` (A157, A200, A202; A225): order the tasks (depends_on, priority), leave out what a batch must not run, ask the questions the
// plans would raise at freeze (plan-lint), write .agents/local/batch/SUMMARY.md, order.tsv, lint.tsv, paths.tsv and accept.tsv, and request the `batch` approval.
// The same approved batch that is not finished is continued instead (nothing written, no new approval); --replace plans anew.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { batchApproval, sharedDirOf } from './approvals.mjs';
import { requestApproval, requireLead } from './approve.mjs';
import { fail } from './errors.mjs';
import { sha256File } from './hash.mjs';
import { shellChild } from './lifeutil.mjs';
import { isFile } from './paths.mjs';
import { PathKinds } from './pathkind.mjs';
import { readBytes, textLines } from './records.mjs';
import { asciiLower } from './shellglob.mjs';
import { scopeEntries, scopeEntryCovers, taskType } from './taskfile.mjs';
import { PLUG_LINE, agentCall, bdOf, bid, deriveState, mdFiles, nextReport, tfile, tid } from './batch.mjs';
import { now } from './clock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const rd = (/** @type {string} */ f) => readBytes(f) ?? '';
const lt = (/** @type {string} */ text) => textLines(text);

/** `cls_of FILE`: the class word of the `## Suggested class` section. @param {string} text */
function clsOf(text) {
  let g = false;
  for (const l of lt(text)) {
    if (/^## Suggested class[ \t\n\v\f\r]*$/.test(l)) { g = true; continue; }
    if (l.startsWith('## ')) g = false;
    if (g) { const m = /(TRIVIAL|STANDARD|COMPLEX|CRITICAL)/.exec(l); if (m) return m[1]; }
  }
  return '';
}
/** `deps_of FILE`: the depends_on front matter value, comma-joined. @param {string} text */
function depsOf(text) {
  let fm = false;
  const rows = lt(text);
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i];
    if (i > 0 && l.startsWith('## ')) return '';
    if (/^---[ \t\n\v\f\r]*$/.test(l)) { fm = !fm; continue; }
    if (fm && l.startsWith('depends_on:')) {
      return l.replace(/^depends_on:[ \t\n\v\f\r]*/, '').replace(/["[\]]/g, '').replace(/[,\s]+/g, ',').replace(/^,/, '').replace(/,$/, '');
    }
  }
  return '';
}
/** `prio_of FILE` (A202): front matter `priority: high|medium|low` as a rank (1 high, 2 medium, 3 low); medium when absent. @param {string} text */
function prioOf(text) {
  let fm = false;
  const rows = lt(text);
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i];
    if (i > 0 && l.startsWith('## ')) break;
    if (/^---[ \t\n\v\f\r]*$/.test(l)) { fm = !fm; continue; }
    if (fm && l.startsWith('priority:')) {
      const v = asciiLower((l.split(/[ \t]+/)[1] ?? '')).replace(/["']/g, '');
      return v === 'high' ? 1 : v === 'low' ? 3 : 2;
    }
  }
  return 2;
}
/** `lint_paths FILE`: the repository-looking paths a task names in backticks, sorted and unique. @param {string} text */
function lintPaths(text) {
  /** @type {Set<string>} */ const out = new Set();
  for (const l of lt(text)) {
    for (const m of l.matchAll(/`[^` ]*`/g)) {
      const p = m[0].replace(/`/g, '');
      if (!/^[A-Za-z0-9_./@-]+$/.test(p)) continue;
      if (/:\/\/|^-|^[.]+$/.test(p)) continue;
      if (!(/\//.test(p) || /[.][A-Za-z][A-Za-z0-9]{0,4}$/.test(p))) continue;
      out.add(p);
    }
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/** Is the section HEAD of the text present with at least one non-empty line? @param {string} text @param {string} head */
function sectionFilled(text, head) {
  let g = false; let f = false;
  for (const l of lt(text)) {
    if (l.startsWith('## ')) { g = l.slice(3) === head; continue; }
    if (g && l !== '') f = true;
  }
  return f;
}
/** The first non-empty line of the `## Suggested class` section, 90 bytes. @param {string} text */
function classWhy(text) {
  let g = false;
  for (const l of lt(text)) {
    if (/^## Suggested class[ \t\n\v\f\r]*$/.test(l)) { g = true; continue; }
    if (l.startsWith('## ')) g = false;
    if (g && /[^\s]/.test(l)) return l.slice(0, 90);
  }
  return '';
}

const DEP_RE = /(new|add(s|ed|ing)?|introduc(e|es|ed|ing)|install(s|ed|ing)?|upgrade|bump)[^.]{0,40}(depend(ency|encies)|librar(y|ies)|package|module|crate|gem)|npm (i|install) |pip install|go get |cargo add|yarn add|pnpm add/i;
const VAGUE = /(^|[^a-z])(better|nicer|improve[sd]?|faster|good|clean(er)?|appropriate(ly)?|as needed|user-friendly|robust|properly|etc|and so on|reasonable|intuitive|nice)([^a-z]|$)/;

/**
 * `lint_task ID FILE CLASS` (A200): the questions a plan would raise at freeze, read from the task file alone (the plan does not exist yet). Rows: id, kind, text, options
 * (a|b|c), recommended letter, param. The recommended option is always the safe one (split, a test, no new dependency, criteria rewritten, class kept).
 * @param {Context} ctx @param {PathKinds} pk @param {string} id @param {string} file @param {string} cls @returns {string[][]}
 */
function lintTask(ctx, pk, id, file, cls) {
  /** @type {string[][]} */ const out = [];
  const text = rd(file);
  const paths = lintPaths(text);
  const kinds = paths.map((p) => [pk.pathKind(p), p]);
  const code = kinds.filter((k) => k[0] === 'code').length;
  const cont = kinds.filter((k) => k[0] === 'content').length;
  const cl = kinds.filter((k) => k[0] === 'content').map((k) => k[1]).slice(0, 4).join(' ');
  let max = Number(ctx.config().get(`pipelines.${cls}.max_scope_paths`, '15'));
  if (!Number.isInteger(max) || max < 1) max = 15;
  if (code > max) {
    const ceil = code + Math.floor((code + 1) / 2);
    out.push([id, 'split', `The task names ${code} code paths (${cont} content or document paths are not counted); the ${cls} limit is ${max}. Split it? Otherwise the freeze would stop and ask.`,
      `a) split it into at least ${Math.floor((code + max - 1) / max)} tasks (task-author) [recommended]|b) proceed without splitting, up to ${ceil} code paths (more than that asks again at freeze)`, 'a', String(ceil)]);
  }
  if (cont > 0) {
    out.push([id, 'exempt', `The task names ${cont} content or document path(s) (${cl}${cont > 4 ? ', ...' : ''}). A document has no RED/GREEN to show, so the plan needs a tdd_exemption for each, or a test. Which?`,
      'a) tdd_exemption with a specific reason per path, verified by the check the task names [recommended]|b) a test for each path (the plan names it)', 'a', '-']);
  }
  if (lt(text).some((l) => DEP_RE.test(l))) {
    out.push([id, 'dep', 'The task reads as if it adds or changes a dependency. A new dependency needs your own approval, which this batch does not cover. Which?',
      'a) no new dependency: the task uses what exists [recommended]|b) a dependency is needed: park the task until you decide it yourself', 'a', '-']);
  }
  // acceptance criteria
  let g = false; let ac = 0; let vague = '';
  for (const l of lt(text)) {
    if (/^## Acceptance criteria[ \t\n\v\f\r]*$/.test(l)) { g = true; continue; }
    if (l.startsWith('## ')) g = false;
    if (!g) continue;
    if (/^[ \t\n\v\f\r]*([-*]|[0-9]+[.])?[ \t\n\v\f\r]*AC-[0-9]+:/.test(l)) ac++;
    if (vague === '' && /AC-[0-9]+:/.test(l) && VAGUE.test(asciiLower(l))) vague = l.replace(/^[ \t\n\v\f\r]*[-*0-9.]*[ \t\n\v\f\r]*/, '').slice(0, 70);
  }
  if (ac === 0) {
    out.push([id, 'ac', 'The task has no acceptance criteria (AC-<n>: ...), so nothing can be tested or reviewed. Which?', 'a) park the task until its criteria are written (task-author) [recommended]|b) run it anyway (the plan stops at freeze)', 'a', '-']);
  } else if (vague !== '') {
    out.push([id, 'ac', `A criterion cannot be measured as written: "${vague}". Which?`, 'a) park the task until it is rewritten with a number, a path or an observable result (task-author) [recommended]|b) run it as written (QA may block on it)', 'a', '-']);
  }
  // A202: a task with an Allowed scope that names a path outside it will get that path in its plan; the freeze refuses it, so the question is asked now
  const allow = scopeEntries(text, 'Allowed scope');
  if (allow.length > 0 && paths.length > 0) {
    const skip = new Set([...scopeEntries(text, 'Forbidden scope'), ...scopeEntries(text, 'Existing pattern references')]);
    let outside = '';
    for (const p of paths) {
      if (skip.has(p)) continue;
      if (!allow.some((e) => e !== '' && scopeEntryCovers(e, p))) outside += ` ${p}`;
    }
    outside = outside.slice(0, 120);
    if (outside.replace(/^ /, '') !== '') {
      out.push([id, 'scope', `The task has an Allowed scope but names path(s) outside it:${outside}. The plan would need them and the freeze refuses a path outside the Allowed scope. Which?`,
        'a) park the task until its Allowed scope is widened or the path is dropped (you edit the task) [recommended]|b) the plan may use paths outside the Allowed scope for this task', 'a', '-']);
    }
  }
  // A202: the task type is an input of the pre-flight
  const ty = taskType(text);
  let miss = '';
  if (ty === 'bug') { for (const s of ['Reproduction steps', 'Expected and actual behaviour', 'Environment']) if (!sectionFilled(text, s)) miss += `, ${s}`; } else if (ty === 'refactor') { if (!sectionFilled(text, 'Behaviour unchanged')) miss = ', Behaviour unchanged'; }
  if (miss !== '') {
    out.push([id, 'type', `The task is typed ${ty} but these sections are empty or missing: ${miss.slice(2)}. The validator refuses such a task. Which?`, 'a) park the task until they are written (task-author) [recommended]|b) run it anyway (the freeze or the review stops on it)', 'a', '-']);
  }
  if ((ty === 'bug' || ty === 'refactor') && cls === 'TRIVIAL') {
    out.push([id, 'type', `The task is typed ${ty} but classified TRIVIAL; a ${ty} changes behaviour or code, so \`classify\` refuses TRIVIAL. Which?`, 'a) park the task until it is classified STANDARD or higher (task-author) [recommended]|b) run it anyway (the classification stops at freeze)', 'a', '-']);
  }
  const n = code + cont;
  if (cls === 'COMPLEX' && n <= 6) {
    const why = classWhy(text);
    out.push([id, 'class', `Classified COMPLEX (${n} path(s) named). Its reason: "${why === '' ? 'none written' : why}". COMPLEX adds an architect, a stricter review and more gates (more time). Keep it?`,
      'a) keep COMPLEX [recommended]|b) STANDARD (you take the lighter review)|c) another class: say which in your answer', 'a', '-']);
  }
  return out;
}

/** The tab-separated rows of an agent command's output. @param {string} out */
const tabRows = (out) => lt(out).map((l) => l.split('\t'));

/** `batch-plan` @param {Context} ctx @param {string[]} argv */
export function batchPlan(ctx, argv) {
  requireLead(ctx);
  mkdirSync(`${ctx.root}/.agents/local`, { recursive: true });
  const rc = plan(ctx, argv);
  if (rc === 3) return 0; // the same approved batch continues: no new plan, no new approval
  requestApproval(ctx, '-', 'batch');
  return 0;
}

/** @param {string} m @returns {never} */
const die = (m) => fail(`batch: ${m}`);
/** @param {string} s */
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {Context} ctx @param {string[]} argv @returns {number} 0, or 3 when the approved batch is continued */
function plan(ctx, argv) {
  const adapter = ctx.config().get('tasks.adapter', 'markdown');
  if (adapter !== 'markdown') die(`night mode runs markdown task files only, but tasks.adapter is ${adapter} (a design decision, A161: the order and the classes are read from the task files, not from network calls). Next step: set tasks.adapter to markdown in .agents/config.yaml, import each task with '/proofline task <issue reference>' (it writes <tasks.dir>/<ID>.md with its Suggested class and depends_on), then run '/proofline batch <ID...>' again`);
  let repl = false;
  /** @type {string[]} */ const args = [];
  for (const a of argv) {
    if (a === '--replace') repl = true;
    else if (a === '--codex-danger-full-access') die('--codex-danger-full-access is gone: night mode runs in your own session (removed in 0.0.32), so the session\'s own permissions apply');
    else args.push(a);
  }
  const td = `${ctx.root}/${ctx.config().get('tasks.dir', '.agents/tasks')}`;
  const bd = bdOf(ctx);
  const allIds = () => [...new Set([...mdFiles(`${td}/todo`), ...mdFiles(td)].map(tid))].sort();
  // the same approved batch, not finished: continue it instead of planning a new one (a new plan has a new summary and needs a new approval)
  if (!repl && isFile(`${bd}/order.tsv`) && batchApproval(ctx) !== null && deriveState(ctx) === 'approved') {
    const sel = args.join(' ') === 'all' ? allIds() : args.join(' ').split(' ').filter((x) => x !== '');
    const order = textLines(rd(`${bd}/order.tsv`));
    const summary = textLines(rd(`${bd}/SUMMARY.md`));
    let outside = '';
    for (const a of sel) if (!(order.some((l) => l.startsWith(`${a}\t`)) || summary.some((l) => l.startsWith(`- ${a}:`)))) outside += ` ${a}`;
    if (outside !== '') die(`batch ${bid(ctx)} is approved and not finished, and it does not contain:${outside}. Continue it with /proofline batch (no task IDs), or plan a new batch that includes them with agent.sh batch-plan --replace <ID...|all> (a new summary and a new approval)`);
    ctx.out(`batch ${bid(ctx)} is approved and not finished: continuing it, no new plan and no new approval (to plan a new batch instead: agent.sh batch-plan --replace <ID...|all>).\n\n`);
    nextReport(ctx);
    return 3;
  }
  if (args.length === 0) die('usage: agent.sh batch-plan [--replace] <ID...|all> (no task IDs: only to continue an approved batch)');
  /** @type {string[]} */ let sel = [];
  if (args[0] === 'all') {
    if (args.length !== 1) die("'all' stands alone");
    sel = allIds();
  } else {
    for (const id of args) {
      if (id === 'run' || id === 'status' || id === 'all' || id === '') die(`'${id}' is a reserved word, not a task ID`);
      if (/[^A-Za-z0-9_-]/.test(id)) die(`invalid task ID: ${id}`);
      if (tfile(td, id) === null) die(`task ${id} not found in ${td} (top level, todo/ or backlog/)`);
      if (!sel.includes(id)) sel.push(id);
    }
  }
  if (sel.length === 0) die(`no task to batch in ${td}`);
  const done = new Set(mdFiles(`${td}/done`).map(tid));
  /** @type {Array<{ id: string, cls: string, dep: string, title: string, pri: number }>} */
  const info = sel.map((id) => {
    const f = /** @type {string} */ (tfile(td, id));
    const text = rd(f);
    const first = lt(text)[0] ?? '';
    const t = /^# Task: *[^ ]* *[-â\u0080\u0094]* */.exec(first);
    return { id, cls: clsOf(text) || '-', dep: depsOf(text) || '-', title: (t ? first.slice(t[0].length) : '').replace(/\t/g, ' '), pri: prioOf(text) };
  });
  // a dependency cycle among the selected tasks refuses the whole batch
  {
    const isSel = new Set(sel);
    /** @type {Map<string, number>} */ const col = new Map();
    /** @type {string[]} */ const stack = [];
    /** @param {string} u */
    const visit = (u) => {
      col.set(u, 1); stack.push(u);
      for (const v of (info.find((x) => x.id === u)?.dep ?? '').split(',')) {
        if (!isSel.has(v)) continue;
        if (col.get(v) === 1) {
          ctx.err(`dependency cycle: ${stack.slice(stack.indexOf(v)).map((x) => `${x} -> `).join('')}${v}\n`);
          die('the batch is refused; nothing was written');
        }
        if (!col.get(v)) visit(v);
      }
      col.set(u, 2); stack.pop();
    };
    for (const x of info) if (!col.get(x.id)) visit(x.id);
  }
  // what a batch never runs: CRITICAL, class unknown, and whatever depends on an excluded task or on a task nobody finishes
  /** @type {Map<string, string>} */ const ex = new Map();
  const inSel = new Set(sel);
  for (const x of info) {
    if (x.cls === 'CRITICAL') ex.set(x.id, 'class CRITICAL (keeps its per-task approvals)');
    else if (x.cls === '-') ex.set(x.id, 'class unknown (fail closed)');
  }
  for (let ch = true; ch;) {
    ch = false;
    for (const x of info) {
      if (ex.has(x.id)) continue;
      for (const v of x.dep.split(',')) {
        if (v === '-' || v === '') continue;
        if (ex.has(v)) { ex.set(x.id, `depends on ${v}, which is not in this batch`); ch = true; break; }
        if (!inSel.has(v) && !done.has(v)) { ex.set(x.id, `dependency ${v} is neither in this batch nor done`); ch = true; break; }
      }
    }
  }
  const kept = info.filter((x) => !ex.has(x.id));
  if (kept.length === 0) {
    for (const x of info) ctx.err(`  ${x.id}: ${ex.get(x.id)}\n`);
    die('no task can be batched; nothing was written');
  }
  // topological order; among the tasks that are ready, the higher priority (A202: front matter priority, high before medium before low) goes first, and ties keep the listed order
  /** @type {typeof kept} */ const orderList = [];
  const emitted = new Set();
  const keptIds = new Set(kept.map((x) => x.id));
  while (orderList.length < kept.length) {
    let best = -1;
    for (let i = 0; i < kept.length; i++) {
      const u = kept[i];
      if (emitted.has(u.id)) continue;
      const ok = u.dep.split(',').every((v) => !(keptIds.has(v) && !emitted.has(v)));
      if (ok && (best < 0 || u.pri < kept[best].pri)) best = i;
    }
    if (best < 0) die('the batch is refused; nothing was written');
    emitted.add(kept[best].id); orderList.push(kept[best]);
  }
  // a batch that did work goes to history; an unworked plan is simply replaced
  mkdirSync(bd, { recursive: true });
  const nonEmpty = (/** @type {string} */ f) => { try { return statSync(f).size > 0; } catch { return false; } };
  if (existsSync(`${bd}/state.tsv`) || nonEmpty(`${bd}/merged.tsv`) || existsSync(`${bd}/ci.tsv`) || existsSync(`${bd}/answers.tsv`)) {
    const hd = `${bd}/history/${isFile(`${bd}/SUMMARY.md`) ? bid(ctx) : 'previous'}`;
    mkdirSync(hd, { recursive: true });
    for (const f of ['SUMMARY.md', 'order.tsv', 'state.tsv', 'merged.tsv', 'ci.tsv', 'lint.tsv', 'answers.tsv', 'paths.tsv', 'accept.tsv']) if (existsSync(`${bd}/${f}`)) renameSync(`${bd}/${f}`, `${hd}/${f}`);
  }
  const cap = ctx.config().get('batch.mutation_budget_cap', '40');
  // A200: plan-lint and the commands proposal, before the summary (the approval is bound to the summary's hash, so to both)
  const pk = new PathKinds(ctx);
  /** @type {string[][]} */ const raw = [];
  for (const x of kept) raw.push(...lintTask(ctx, pk, x.id, /** @type {string} */ (tfile(td, x.id)), x.cls));
  // lint_known (A202, item 27): blocking findings that runs on this machine recorded, whose run did not touch the place and that are not on the user's known-issues list
  const cand = tabRows(shellChild(ctx, ['known-issue-candidates']).out).slice(0, 8);
  for (const c of cand) {
    const [kr, kfid, kg, kp] = c; const kt = c.slice(4).join('\t');
    if (!kr) continue;
    raw.push([kr, 'known', `Run ${kr} recorded the blocking finding ${kfid} (${kg}) at ${kp}: "${kt.slice(0, 100)}". Its run did not touch that file, so it may already be on main, and it is not on the known-issues list: it will stop every task that meets it. Which?`,
      'a) leave it blocking [recommended]|b) list it as a known issue: name its follow-up task (an existing open task) in your answer; I then propose the record and you approve it separately with "approve known issue"', 'a', '-']);
  }
  // lint_accept: the findings and DESIGN.md rationales this batch expects, offered as ONE decision (kind accept, id batch)
  /** @type {string[][]} */ const accept = [];
  for (const c of cand) { const [, , kg, kp] = c; if (kg && kp) accept.push(['K', kg, kp, c.slice(4).join('\t')]); }
  for (const r of tabRows(agentCall(ctx, ['design-rationales', '-']).out)) { const [rp, rs] = r; const rl = r.slice(2).join('\t'); if (rp && rs === 'unapproved' && rl) accept.push(['R', rp, '-', rl]); }
  if (accept.length > 0) {
    raw.push(['batch', 'accept', `Accept for THIS batch only the ${accept.length} expected finding(s) and DESIGN.md rationale(s) listed under "Expected known issues and rationales"? A listed finding then stops no task of the batch that does not touch its file, and a listed rationale is approved when its run asks for it. SECRETS and SECURITY findings are never accepted this way, and anything not listed still asks. One decision for the whole list.`,
      'a) no: each stays blocking and is asked when it appears [recommended]|b) yes: accept the whole list for this batch', 'a', '-']);
  }
  // A200: the code paths each task names (content and document paths are left out): a task that shares one with an earlier task that is not merged waits for it
  /** @type {string[]} */ const pathRows = [];
  for (const x of kept) for (const p of lintPaths(rd(/** @type {string} */ (tfile(td, x.id))))) if (pk.pathKind(p) === 'code') pathRows.push(`${x.id}\t${p}`);
  const lintRows = raw.map((r, i) => ['Q' + (i + 1), ...r]);
  const pf = `${sharedDirOf(ctx, 'commands')}/PROPOSAL.tsv`;
  const cmdEmpty = ['build', 'test', 'lint'].filter((k) => (ctx.config().getRaw(`commands.${k}`) ?? '') === '');
  const cfgv = (/** @type {string} */ k, /** @type {string} */ d) => ctx.config().get(k, d);
  let s = '';
  const o = (/** @type {string} */ t) => { s += t; };
  o(`# Night batch\n\nnonce: ${now().epoch}-${randomBytes(8).toString('hex')}\n\n`);
  const ci = agentCall(ctx, ['ci-check']).out;
  if (lt(ci)[0] === 'ci: absent') {
    const w = `WARNING: ${lt(ci)[1] ?? ''} Every pull request of this batch is merged only after its build and test pass in a clean copy of the commit. To get real checks instead: ${agentCall(ctx, ['ci-task-command']).out.replace(/\n+$/, '')}`;
    o(`## WARNING\n\n${w}\n\n`);
  }
  o('One approval of this summary stands in for the approvals listed below, for the tasks in the table and for nothing else.\nThe batch id is the first 12 hex digits of the sha256 of this file; the approval is bound to that hash.\n\n');
  o('## Order (one task at a time, in this session: run it, deliver it, and only when it is merged the next one; each task in a git worktree of its own)\n\n| # | task | title | class | depends_on |\n|---|------|-------|-------|------------|\n');
  orderList.forEach((x, i) => o(`| ${i + 1} | ${x.id} | ${kept.find((k) => k.id === x.id)?.title} | ${x.cls} | ${x.dep} |\n`));
  o('\n## What the approval covers, per task\n\n');
  o('- plan: the freeze of the plan (kind plan), after classification and the usual checks\n');
  o('- delivery: commit, push, pull request, merge only when CI is green and every gate passed (proofline merge), cleanup\n');
  o('- CI red after the pull request is open: up to 2 CI-fix rounds, each a normal fix round that passes the gates again, pushed to the same pull request branch and nothing else; the delivery approval covers exactly those pushes, then the task is parked with the error and what was tried\n');
  o(`- mutation budget: a raise of test_trust.mutation_budget (now ${cfgv('test_trust.mutation_budget', '20')}) up to the cap batch.mutation_budget_cap = ${cap}\n`);
  o('\n## Expected known issues and rationales (accept for this batch)\n\n');
  if (accept.length > 0) {
    o('Findings that runs on this machine already recorded outside the tasks of this batch (they may be on main) and DESIGN.md pattern justifications nobody approved yet. One answer to the accept question below ("Q<n> b") accepts the whole list for THIS batch only; "all recommended" does not. SECRETS and SECURITY findings are never listed and never accepted this way.\n\n');
    for (const a of accept) { if (a[0] === 'K') o(`- accept K ${a[1]} ${a[2]}: ${a[3]}\n`); else o(`- accept R ${a[1]}: ${a[3]}\n`); }
  } else o('- none\n');
  for (const l of lt(shellChild(ctx, ['known-issue-list']).out)) if (!l.startsWith('known issues: none')) o(`- already on the known-issues list: ${l}\n`);
  o('\n## Pre-flight questions (plan-lint, A200)\n\n');
  if (lintRows.length > 0) {
    o('These are the questions the plan of each task would raise at freeze, asked now so that no task parks on them overnight. Answer with the letters ("Q1 a, Q2 b"), in your own words ("Q1: do not split", "Q3 hayir"), or "all recommended". Your message is recorded as it is (agent.sh batch-answer) and applied when each plan freezes; a question you leave open is asked again at freeze, as before. An answer is never an approval of anything else.\n\n');
    for (const r of lintRows) { o(`- ${r[0]} [${r[1]}, ${r[2]}] ${r[3]}\n`); for (const opt of r[4].split('|')) o(`    ${opt}\n`); }
  } else o('- none: no task raises a question that can be told from its task file\n');
  o('\n## Verification commands (A200)\n\n');
  const names = cmdEmpty.join(', commands.');
  if (cmdEmpty.length === 0) o('- commands.build, commands.test and commands.lint are configured\n');
  else if (isFile(pf) && statSync(pf).size > 0) {
    o(`- commands.${names} are empty. Proven by one run each, proposed for .agents/config.yaml (your approval of this batch covers writing them: proofline doctor --apply-commands):\n`);
    for (const l of lt(rd(pf))) if (!l.startsWith('#')) { const f = l.split('\t'); o(`    commands.${f[0]}: ${f[1]}\n`); }
    o(`commands proposal: ${sha256File(pf).slice(0, 12)}\n`);
  } else o(`- commands.${names} are empty and no proven proposal exists: no build record can be made and the verify gate has nothing to run for them. Before approving, run proofline doctor --commands and plan the batch again (agent.sh batch-plan --replace ...); the proposal then appears here\n`);
  o('\n## Stop rules\n\n');
  o('- a task that needs anything else is parked with its question and the batch goes on; a task that depends on it is skipped\n');
  o('- every task works in its own git worktree (.agents/local/worktrees/<ID>, made from the canonical branch just before the task starts): a parked task, one waiting for its merge and one in a CI-fix round keep theirs and block no task that does not depend on them; the main working tree is never touched. A task starts only when every task it depends on is merged; a merged task\'s worktree is removed\n');
  o(`- after every merge the lead checks the CI run of the merge commit itself (not the latest run, agent.sh batch-ci): the batch stops when that run is red, still running after batch.ci_wait_minutes (${cfgv('batch.ci_wait_minutes', '30')}), or when no run for it appears within batch.ci_appear_minutes (${cfgv('batch.ci_appear_minutes', '10')})\n`);
  o('- the batch stops when the session closes, a usage limit is hit or the computer sleeps; the same approved batch continues with /proofline batch and never runs a merged task again\n');
  o('\n## NOT covered (each stays a question the batch parks on)\n\n');
  o('- a waiver of a finding, a scope expansion, a new dependency, a reopen of a FAILED or BLOCKED run\n');
  o('- a destructive or single_step data change, a rule promotion, sending the friction report, a new fix-round budget\n');
  o('- a mutation budget above the cap, and any CRITICAL task\n');
  o('\n## Not in this batch\n\n');
  if (info.some((x) => ex.has(x.id))) for (const x of info) { if (ex.has(x.id)) o(`- ${x.id}: ${ex.get(x.id)}\n`); } else o('- none\n');
  o('\n## Keep the computer awake and this session open\n\n');
  o(`The batch runs in THIS session, task after task; there is no background process. It stops when the session closes, a usage limit is hit or the computer sleeps. ${PLUG_LINE}\n`);
  o('On macOS the session offers to start caffeinate -i -w <this session\'s pid>, which keeps the Mac awake exactly as long as the session lives (agent.sh batch-awake).\n');
  o('After an interruption run /proofline batch again: the approved batch continues where it stopped and a merged task is never run again.\n');
  const put = (/** @type {string} */ name, /** @type {string} */ text) => { writeFileSync(`${bd}/.${name}.new`, Buffer.from(text, 'latin1')); renameSync(`${bd}/.${name}.new`, `${bd}/${name}`); };
  put('SUMMARY.md', s);
  put('order.tsv', orderList.map((x) => `${x.id}\t${x.cls}\t${x.dep}\n`).join(''));
  put('lint.tsv', lintRows.map((r) => `${r.join('\t')}\n`).join(''));
  put('paths.tsv', pathRows.map((r) => `${r}\n`).join(''));
  put('accept.tsv', accept.map((r) => `${r.join('\t')}\n`).join(''));
  ctx.out(s);
  ctx.out(`\nbatch id: ${bid(ctx)}\n\n`);
  return 0;
}

export const BATCHPLAN_HANDLERS = { 'batch-plan': batchPlan };
