// @ts-check
// Stage 3: `next-user` (scripts/next-user.sh, A159): the ONE table from (command, project or run state) to the line that ends every
// /proofline command. Read-only, any role. It reads the run state through the commands `status`, `summary --status` and `questions` (run in
// process, each with a context of its own, as separate agent.sh calls were) and the batch through `batch-next --tsv` (still the shell's).
import { readdirSync, statSync } from 'node:fs';
import { fileLines, readBytes, textLines } from './records.mjs';
import * as proc from './proc.mjs';
import { isDir, isFile } from './paths.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** command[,command...] | state[,state...] or * | suggestion; the first matching row wins */
const TABLE = `init|*|/proofline doctor
doctor|*|/proofline task --grill
upgrade|*|commit the changed files yourself, then run /proofline doctor
version|*|/proofline doctor
task|*|{NEW}
design|*|{WORK}
status,resume,queue,run|question|reply in this session to the open question: {Q}
status,resume,queue,run|batchtask|run /proofline batch to continue the batch (it delivers <ID> and goes on)
status,resume,queue,run|codedone,finished|/proofline deliver <ID>
status,resume,queue,run|failed|/proofline reopen <ID>
status,resume,queue,run|active|/proofline resume
status,resume,queue,run|none|{WORK}
deliver|delivered|{WORK}
deliver|merge-open|proofline merge {PR}
deliver|question|reply in this session to the open question: {Q}
deliver|codedone,finished|reply "approve delivery" in this session to deliver <ID>
deliver|failed|/proofline reopen <ID>
deliver|active|/proofline resume
deliver|none|{WORK}
knowledge|failed|/proofline reopen <ID>
knowledge|*|/proofline deliver <ID>
reopen|*|/proofline resume
merge|*|{WORK}
clean|*|{WORK}
debt|*|/proofline task --grill
review|*|/proofline task --grill
audit|*|/proofline task --grill
debug|*|/proofline task --grill
insights|*|/proofline status
explain|*|/proofline status
docs|*|/proofline docs audit
wiki|*|/proofline wiki lint
batch|nobatch|{WORK}
batch|unapproved|reply "approve batch" in this session to start the batch
batch|approved|run /proofline batch to continue the batch; merged tasks are not run again
batch|finished-parked,finished-clean|/proofline batch status
batch-status|nobatch,finished-clean|{WORK}
batch-status|unapproved|reply "approve batch" in this session to start the batch
batch-status|approved|run /proofline batch to continue the batch; merged tasks are not run again
batch-status|finished-parked|{PARKED}
product-prd|*|/proofline product review <SLUG>
product-review|dnship|/proofline product prd <SLUG> to revise the PRD, then /proofline product review <SLUG> again
product-review|dnship2|/proofline product prd <SLUG> if you revise the PRD (both review rounds are used, so what happens next is your call)
product-review|*|/proofline product split <SLUG>
product-split|*|{NEW}
product-discover-frame|*|/proofline product discover research <SLUG>
product-discover-research|*|/proofline product discover interviews <SLUG>
product-discover-interviews|*|/proofline product discover competitors <SLUG>
product-discover-competitors|*|/proofline product discover opportunities <SLUG>
product-discover-opportunities|*|/proofline product assess assumptions <SLUG>
product-assess-assumptions|*|/proofline product assess probes <SLUG>
product-assess-probes|*|/proofline product assess premortem <SLUG>
product-assess-premortem|*|/proofline product assess redteam <SLUG>
product-assess-redteam|*|/proofline product assess decision <SLUG>
product-assess-decision|stop|/proofline product discover frame <SLUG> to frame a different problem (the decision is stop, so no PRD is split)
product-assess-decision|clarify|/proofline product discover research <SLUG> to close what is unclear, then /proofline product assess decision <SLUG> again
product-assess-decision|*|/proofline product prd <SLUG>
product-outcome|*|/proofline status
trace|*|/proofline status`.split('\n').map((l) => l.split('|'));

const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
const tableNames = () => [...new Set(TABLE.flatMap((r) => r[0].split(',')))].sort(cmp);
const commands = () => [...new Set(tableNames().filter((n) => !n.startsWith('batch-')).map((n) => (n.startsWith('product-') ? 'product' : n)))].sort(cmp);

/** `sub TEXT FROM TO` @param {string} s @param {string} from @param {string} to */
const sub = (s, from, to) => s.split(from).join(to);

/** A sibling command of this core in process: its stdout (empty when it failed; stderr dropped). @param {Context} ctx @param {string[]} argv */
function agent(ctx, argv) {
  /** @type {Buffer[]} */ const out = [];
  const io = { env: ctx.env, cwd: ctx.cwd, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: () => true }, scriptPath: ctx.scriptPath, isProcess: false };
  if (ctx.runner === null) return '';
  ctx.runner(argv, io);
  return Buffer.concat(out).toString('latin1');
}

/** The value of a first-level section key of config.yaml (`awk '/^SECTION:/ { i = 1; next } /^[^[:space:]#]/ { i = 0 } i && $1 == "KEY:" ...'`). @param {Context} ctx @param {string} section @param {string} key */
function sectionKey(ctx, section, key) {
  const text = readBytes(`${ctx.root}/.agents/config.yaml`);
  if (text === null) return '';
  let inside = false;
  for (const line of textLines(text)) {
    if (line.startsWith(`${section}:`)) { inside = true; continue; }
    if (/^[^ \t\n\v\f\r#]/.test(line)) inside = false;
    const f = line.split(/[ \t\n\v\f\r]+/).filter((x) => x !== '');
    if (inside && f[0] === `${key}:`) return (f[1] ?? '').replace(/"/g, '');
  }
  return '';
}

/** @param {string} id */
const cleanId = (id) => (id.startsWith('-') || /[^A-Za-z0-9_-]/.test(id) ? '' : id);

/** Names of the `*.md` files of a folder, in byte order. @param {string} d */
function mdFiles(d) { try { return readdirSync(d).filter((n) => n.endsWith('.md')).sort(cmp).map((n) => `${d}/${n}`).filter((f) => isFile(f)); } catch { return []; } }

/** `task_id FILE` @param {string} f */
function taskId(f) {
  const b = f.slice(f.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const m = /^([A-Za-z][A-Za-z]*-[0-9][0-9]*)/.exec(b);
  return m ? m[1] : b;
}

/** @param {Context} ctx */
function tasksDir(ctx) { return `${ctx.root}/${sectionKey(ctx, 'tasks', 'dir').replace(/\/$/, '') || '.agents/tasks'}`; }

/** @param {Context} ctx */
function taskFiles(ctx) { const td = tasksDir(ctx); return [...mdFiles(`${td}/todo`), ...mdFiles(`${td}/backlog`), ...mdFiles(td)]; }

/** `queued` @param {Context} ctx */
function queued(ctx) {
  /** @type {string[]} */ const out = [];
  for (const f of taskFiles(ctx)) {
    const q = taskId(f);
    if (isDir(`${ctx.root}/.agents/runs/${q}`) || isDir(`${ctx.root}/.agents/local/worktrees/${q}/.agents/runs/${q}`)) continue;
    out.push(q);
  }
  return out;
}

/** @param {Context} ctx */
function work(ctx) { const w = queued(ctx)[0]; return w ? `/proofline run ${w}` : '/proofline task --grill'; }

/** @param {Context} ctx */
function newestTask(ctx) {
  const files = taskFiles(ctx);
  if (files.length === 0) return '';
  const withTime = files.map((f) => ({ f, t: statSync(f, { bigint: true }).mtimeNs }));
  withTime.sort((a, b) => (a.t > b.t ? -1 : a.t < b.t ? 1 : cmp(a.f, b.f)));
  return taskId(withTime[0].f);
}

/** `question` @param {Context} ctx @param {string} id */
function question(ctx, id) {
  const first = agent(ctx, ['questions', id]).split('\n').find((l) => !l.startsWith('===') && !/^[ \t\n\v\f\r]*$/.test(l));
  const q = (first ?? '').replace(/`/g, '').slice(0, 120);
  return q === '' ? 'see the question above' : q;
}

/** `batch_state` / `batch_rows` @param {Context} ctx */
function batchNext(ctx) {
  const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, 'batch-next', '--tsv'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  return r.stdout.toString('latin1').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
}
const batchState = (/** @type {string[]} */ lines) => { const f = (lines[0] ?? '').split('\t'); return lines.length > 0 && f[0] === 'state' ? (f[1] ?? '') : 'nobatch'; };

/**
 * @typedef {object} RunState
 * @property {string} state @property {string} ks @property {boolean} inwt
 */
/** `run_state ID` @param {Context} ctx @param {string} id @returns {RunState} */
function runState(ctx, id) {
  let state = 'none'; let ks = ''; let inwt = false; let rsr = ctx.root;
  if (id !== '' && !isDir(`${ctx.root}/.agents/runs/${id}`) && isDir(`${ctx.root}/.agents/local/worktrees/${id}/.agents/runs/${id}`)) { rsr = `${ctx.root}/.agents/local/worktrees/${id}`; inwt = true; }
  if (id !== '' && isDir(`${rsr}/.agents/runs/${id}`)) {
    let st = ''; let hs = '';
    for (const l of agent(ctx, ['summary', id, '--status']).split('\n')) {
      const m = /^STATUS: ([A-Z_a-z]*) \(handoff ([A-Za-z_]*), knowledge ([A-Za-z_]*)\)/.exec(l);
      if (m) { st = m[1]; hs = m[2]; ks = m[3]; break; }
    }
    state = 'active';
    if (st === 'FAILED' || st === 'BLOCKED') state = 'failed';
    else if (hs === 'DONE') state = 'finished';
    else if (st === 'CODE_DONE') state = 'codedone';
    if (state !== 'failed' && fileLines(ctx, `${rsr}/.agents/runs/${id}/RUN.yaml`).some((l) => /^ {2}awaiting_input: "?true/.test(l))) state = 'question';
  }
  return { state, ks, inwt };
}

/** @param {Context} ctx @param {string[]} args */
export function nextUser(ctx, args) {
  let cmd = ''; let id = ''; let id2 = ''; let id3 = ''; let err = false; let kind = '';
  for (const a of args) {
    if (a === '--commands') { ctx.out(`${commands().join('\n')}\n`); return 0; }
    if (a === '--error') err = true;
    else if (a.startsWith('--error=')) { err = true; kind = a.slice(8); } else if (cmd === '') cmd = a; else if (id === '') id = a; else if (id2 === '') id2 = a; else if (id3 === '') id3 = a;
  }
  id = cleanId(id);
  if (cmd === '') cmd = 'help';
  if (cmd === 'batch') { if (id === 'status') { cmd = `batch-${id}`; id = ''; } else if (id === 'run' || id === 'stop') id = ''; }
  if (cmd === 'product') {
    if (['prd', 'review', 'split', 'outcome'].includes(id)) { cmd = `product-${id}`; id = cleanId(id2); } else if (id === 'discover' || id === 'assess') {
      if (id2 === '' || id2.startsWith('-') || /[^a-z]/.test(id2)) { cmd = 'product-prd'; id = ''; } else { cmd = `product-${id}-${id2}`; id = cleanId(id3); }
    } else { cmd = 'product-prd'; id = ''; }
  }
  if (!err && !tableNames().includes(cmd)) { ctx.err(`next-user: unknown command: ${cmd}\n`); return 2; }
  const installed = isFile(`${ctx.root}/.agents/config.yaml`) && isFile(`${ctx.scripts}/agent.sh`);
  let state = 'none'; let ks = ''; let inwt = false; let pr = '';
  if (installed) {
    if (cmd === 'batch' || cmd === 'batch-status') state = batchState(batchNext(ctx));
    else if (cmd.startsWith('product-')) {
      const pd = sectionKey(ctx, 'product', 'dir').replace(/\/$/, '');
      const dir = `${ctx.root}/${pd || 'docs/product'}/${id}`;
      state = 'none';
      if (cmd === 'product-assess-decision' && id !== '') {
        const hits = textLines(readBytes(`${dir}/DECISION.md`) ?? '').filter((l) => new RegExp('^decision:[ \\t\\n\\v\\f\\r]*(build|clarify|stop)[ \\t\\n\\v\\f\\r]*$').test(l));
        const last = hits[hits.length - 1];
        state = last ? last.replace(/^decision:[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r]*$/, '') : 'none';
      }
      const review = textLines(readBytes(`${dir}/REVIEW.md`) ?? '');
      if (cmd === 'product-review' && id !== '' && review.some((l) => /^verdict:[ \t\n\v\f\r]*do-not-ship/.test(l))) {
        state = 'dnship';
        if (review.some((l) => /^round:[ \t\n\v\f\r]*[2-9]/.test(l))) state = 'dnship2';
      }
    } else {
      if (id === '') {
        const line = agent(ctx, ['status']).split('\n').find((l) => l.startsWith('active_task='));
        id = line ? line.slice('active_task='.length) : '';
        if (id === 'none') id = '';
      }
      ({ state, ks, inwt } = runState(ctx, id));
      if (/^(status|resume|queue|run)$/.test(cmd) && (state === 'codedone' || state === 'finished')) {
        const bl = batchNext(ctx);
        if (batchState(bl) === 'approved' && bl.slice(1).some((l) => { const f = l.split('\t'); return f[0] === id && f[1] === 'open'; })) state = 'batchtask';
      }
      if (!err && cmd === 'deliver' && (state === 'codedone' || state === 'finished')) {
        pr = (readBytes(`${ctx.root}/.agents/local/deliver/${id}/PR`) ?? '').replace(/\n+$/, '');
        if (!/^[0-9]+$/.test(pr)) pr = '';
        let consumed = false;
        const ad = `${ctx.root}/.agents/runs/${id}/approvals`;
        try { for (const n of readdirSync(ad).sort(cmp)) if (/^[0-9]{3}-cleanup\.yaml$/.test(n) && fileLines(ctx, `${ad}/${n}`).some((l) => /^consumed: "?true/.test(l))) consumed = true; } catch { /* none */ }
        if (consumed) state = 'delivered'; else if (pr !== '') state = 'merge-open';
      }
    }
  }
  let text;
  if (err) {
    if (kind === '') {
      if (!installed) kind = 'not-installed';
      else if (state === 'failed') kind = 'failed-run';
      else if (state === 'codedone' && ks !== 'KNOWLEDGE_DONE' && ks !== 'not_applicable') kind = 'knowledge';
      else if (cmd === 'doctor') kind = 'doctor';
    }
    switch (kind) {
      case 'not-installed': text = 'proofline init'; break;
      case 'usage': text = 'proofline help'; break;
      case 'dirty-tree': text = `commit or stash your changes yourself, then run /proofline ${cmd}${id !== '' ? ` ${id}` : ''} again`; break;
      case 'knowledge': text = `/proofline knowledge ${id !== '' ? id : '<TASK-ID>'}`; break;
      case 'failed-run': text = `/proofline reopen ${id !== '' ? id : '<TASK-ID>'}`; break;
      case 'doctor': text = 'fix what /proofline doctor reported (each failed check names its fix), then run /proofline doctor again'; break;
      default: text = '/proofline status';
    }
  } else {
    const has = (/** @type {string} */ list, /** @type {string} */ w) => list.split(',').some((x) => x === w || x === '*');
    text = TABLE.find((r) => has(r[0], cmd) && has(r[1], state))?.[2] ?? '';
    if (text.includes('{WORK}')) text = sub(text, '{WORK}', work(ctx));
    if (text.includes('{NEW}')) { const n = newestTask(ctx); text = sub(text, '{NEW}', n !== '' ? `/proofline run ${n}` : '/proofline task --grill'); }
    if (text.includes('{PR}')) text = sub(text, '{PR}', pr);
    if (text.includes('{PARKED}')) {
      const row = batchNext(ctx).slice(1).map((l) => l.split('\t')).find((f) => f[1] === 'parked');
      const pk = row ? row[0] : '';
      if (pk === '') text = work(ctx);
      else {
        const pq = (row?.[3] ?? '').replace(/`/g, '').slice(0, 120);
        id = pk; ({ state, inwt } = runState(ctx, id));
        if (inwt) {
          if (state === 'question') { let q = question(ctx, id); if (q === 'see the question above') q = pq; text = `reply in this session to the open question: ${q === '' ? 'see the question above' : q}, then run /proofline batch`; } else if (state === 'failed') text = `/proofline reopen ${id}, then run /proofline batch`;
          else text = `run /proofline batch: it resumes ${id} in its worktree`;
        } else if (state === 'none') text = `/proofline run ${id}`;
        else if (state === 'question') { let q = question(ctx, id); if (q === 'see the question above') q = pq; text = `/proofline resume ${id}, then reply in this session to the open question: ${q === '' ? 'see the question above' : q}`; } else if (state === 'failed') text = `/proofline reopen ${id}`;
        else if (state === 'codedone' || state === 'finished') text = `/proofline deliver ${id}`;
        else text = `/proofline resume ${id}`;
      }
    }
    if (text.includes('{Q}')) text = sub(text, '{Q}', question(ctx, id));
    if (cmd.startsWith('product-')) text = sub(text, '<SLUG>', id !== '' ? id : '<slug>');
    text = sub(text, '<ID>', id !== '' ? id : '<TASK-ID>');
  }
  ctx.out(`Next step: ${text}\n`);
  return 0;
}
