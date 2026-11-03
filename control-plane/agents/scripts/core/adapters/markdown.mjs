// @ts-check
// The markdown task-integration adapter in Node (stage 6B, A216; the former task-integrations/markdown.sh). Contract: task-integrations/README.md.
//   import <task-file|TASK-ID> <out TASK.md> | publish <ID> <report> | verify <ID> <receipt|report> | followup <ID> <waiver-file>
//   status <ID> <backlog|todo|in-progress|done> [task-path] | create <ID> <title> <body-file> | statusblock <ID> <block-file>
// Task files live in `tasks.dir`, usually in lifecycle folders backlog/ todo/ in-progress/ done/ with a `**Status:**` line. The completion report and the
// status block are the two blocks the task-source contract of the control plane excludes from the frozen contract hash.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bytes } from '../config.mjs';
import { slug as slugOf } from '../slug.mjs';
import { AdapterExit, checkId, die, fsPath, importEngine, isFile, joinLines, lines, link, readText, sha, statusCheck, usage } from './lib.mjs';

/** @typedef {import('./lib.mjs').Adapter} Adapter */

const BLANK = /^[ \t\n\v\f\r]*$/;

/** `run_task_path ID`: task_source.path of the run's RUN.yaml, or ''. @param {Adapter} a @param {string} id */
function runTaskPath(a, id) {
  const t = readText(`${a.root}/.agents/runs/${id}/RUN.yaml`);
  if (t === null) return '';
  let inside = false;
  for (const l of lines(t)) {
    if (l === 'task_source:') { inside = true; continue; }
    if (inside && /^[^ \t\n\v\f\r]/.test(l)) return '';
    if (inside && /^[ \t\n\v\f\r]*path:/.test(l)) return l.replace(/^[^:]*:[ \t\n\v\f\r]*/, '').replace(/"/g, '');
  }
  return '';
}

/** Names in a folder, sorted bytewise (a shell glob). @param {string} dir */
function names(dir) { try { return readdirSync(dir).sort(); } catch { return []; } }

/**
 * `find_task ID`: the relative path of the task file (first match across the lifecycle folders), or null. T-1 never resolves to its follow-up T-1-FU1.
 * @param {Adapter} a @param {string} id
 */
function findTask(a, id) {
  const td = a.tasksDir;
  const dirs = names(`${a.root}/${td}`).filter((n) => { try { return statSync(`${a.root}/${td}/${n}`).isDirectory(); } catch { return false; } });
  /** @type {Array<(n: string) => boolean>} */
  const tests = [(n) => n === `${id}.md`, (n) => n.startsWith(`${id}-`) && n.endsWith('.md') && n.length >= id.length + 4];
  /** @type {string[]} */ const cands = [];
  for (const t of tests) for (const d of dirs) for (const n of names(`${a.root}/${td}/${d}`)) if (t(n)) cands.push(`${td}/${d}/${n}`);
  for (const t of tests) for (const n of names(`${a.root}/${td}`)) if (t(n)) cands.push(`${td}/${n}`);
  for (const rel of cands) {
    if (!isFile(`${a.root}/${rel}`)) continue;
    const b = path.basename(rel);
    if (b.startsWith(`${id}-FU`) && /[0-9]/.test(b.charAt(id.length + 3)) && b !== `${id}.md`) continue;
    return rel;
  }
  return null;
}

/** `strip_plan`: the task file without the planning block and the Status lines. @param {string} text */
function stripPlan(text) {
  /** @type {string[]} */ const out = [];
  let f = false; let st = 0; let d = false;
  for (const l of lines(text)) {
    if (!f && BLANK.test(l)) continue;
    if (!f) { f = true; if (l === '---') { st = 1; continue; } }
    if (st === 1) { if (l === '---') st = 0; continue; }
    if (!d && /^# /.test(l)) { d = true; st = 2; continue; }
    if (st === 2 && BLANK.test(l)) continue;
    if (st === 2 && /^\*\*Status:\*\*/.test(l)) continue;
    if (st === 2 && l === '---') { st = 3; continue; }
    if (st === 3) { if (l === '---') st = 0; continue; }
    if (st === 2) st = 0;
    if (/^\*\*Status:\*\*/.test(l)) continue;
    out.push(l);
  }
  return joinLines(out);
}

/** `get_plan`: the planning block including both --- lines, or ''. @param {string} text */
function getPlan(text) {
  /** @type {string[]} */ const out = [];
  let f = false; let st = 0; let d = false;
  for (const l of lines(text)) {
    if (!f && BLANK.test(l)) continue;
    if (!f) { f = true; if (l === '---') { st = 1; out.push(l); continue; } }
    if (st === 1) { out.push(l); if (l === '---') break; continue; }
    if (!d && /^# /.test(l)) { d = true; st = 2; continue; }
    if (st === 2 && BLANK.test(l)) continue;
    if (st === 2 && /^\*\*Status:\*\*/.test(l)) continue;
    if (st === 2 && l === '---') { st = 3; out.push(l); continue; }
    if (st === 3) { out.push(l); if (l === '---') break; continue; }
    break;
  }
  return joinLines(out);
}

/** The plan block when it is complete (its last line is ---), without the trailing newline. @param {string} plan */
function planBlock(plan) {
  const p = plan.replace(/\n+$/, '');
  return p.split('\n').pop() === '---' ? p : '';
}

/** The first line `# X` of a text, X. @param {string} t */
function firstH1(t) { for (const l of t.split('\n')) if (l.startsWith('# ')) return l.slice(2); return ''; }

/** @param {string} t @param {string} line */
const hasLine = (t, line) => t.split('\n').includes(line);

/**
 * One operation. Throws AdapterExit for a nonzero end.
 * @param {Adapter} a @param {string[]} argv the operation and its arguments
 */
export function runMarkdown(a, argv) {
  const op = argv[0] ?? '';
  const n = argv.length; // $# + 1
  const tdir = a.tasksDir;
  if (tdir.startsWith('/') || tdir.includes('..')) die(a, `tasks.dir must be a relative path inside the project: ${tdir}`);
  const root = a.root;
  switch (op) {
    case 'create': {
      if (n !== 4) usage(a, 'markdown.sh create <TASK-ID> <title> <body-file>');
      const [, id, title0, bodyFile] = argv;
      const title = bytes(title0);
      checkId(a, id);
      const bodyText = isFile(bodyFile) ? readText(bodyFile) : null;
      if (bodyText === null) die(a, `task body missing: ${bodyFile}`);
      if (title === '') die(a, 'task title is required');
      const sl = slugOf(title); // A202: ASCII transliteration first, always <ID>-<slug>.md
      if (sl === '') die(a, 'task title needs a usable slug');
      if (findTask(a, id) !== null) die(a, `task file already exists for ${id}`);
      const rel = `${tdir}/in-progress/${id}-${sl}.md`;
      if (existsSync(`${root}/${rel}`)) die(a, `task file already exists: ${rel}`);
      const imported = importEngine(a, 'markdown', stripPlan(bodyText), id, title, `markdown ${rel}`);
      mkdirSync(`${root}/${tdir}/in-progress`, { recursive: true });
      // the planning block stays right after the H1, behind the Status line (import reads both)
      const fm = planBlock(getPlan(bodyText));
      const il = imported.split('\n');
      const first = `${il[0]}\n`;
      const rest = il.slice(1).join('\n');
      writeFileSync(`${root}/${rel}`, `${first}\n**Status:** in-progress\n${fm === '' ? '' : `\n${fm}\n`}${rest}`, 'latin1');
      a.out(`${rel}\n`);
      return;
    }
    case 'import': {
      if (n !== 3) usage(a, 'markdown.sh import <task-file|TASK-ID> <out TASK.md>');
      const [, ref, out] = argv;
      let src; // as the shell adapter kept it: the reference as typed when that file exists (read from the caller's directory), else the project path
      let srcFile;
      if (isFile(path.resolve(a.cwd, ref))) { src = ref; srcFile = path.resolve(a.cwd, ref); }
      else if (isFile(`${root}/${ref}`)) { src = `${root}/${ref}`; srcFile = src; }
      else { checkId(a, ref); const rel = findTask(a, ref); if (rel === null) die(a, `no task file for ${ref} in ${tdir}`); src = `${root}/${rel}`; srcFile = src; }
      const text = readText(srcFile) ?? '';
      let h1 = firstH1(text);
      if (h1.startsWith('Task: ')) h1 = h1.slice(6);
      let id = ''; let title = h1;
      const EM = ' \xe2\x80\x94 ';
      if (h1.includes(EM)) { id = h1.slice(0, h1.indexOf(EM)); title = h1.slice(h1.indexOf(EM) + EM.length); }
      if (id === '' || /[^A-Za-z0-9._-]/.test(id)) {
        const b = path.basename(src, '.md');
        const m = /^([A-Za-z][A-Za-z0-9]*-[0-9][0-9]*)/.exec(b);
        id = m ? m[1] : b;
      }
      checkId(a, id);
      // planning block (`---` ... `---`) directly after the H1, or leading in a hand-written file: not copied into the body
      let result = importEngine(a, 'markdown', stripPlan(text), id, title, `markdown ${src}`);
      // keep the optional planning front matter (size, sprint, assignee, depends_on) parseable at the top of the run's TASK.md
      const fm = planBlock(getPlan(text));
      if (fm !== '') { const il = result.split('\n'); result = `${il[0]}\n\n${fm}\n${il.slice(1).join('\n')}`; }
      writeFileSync(path.resolve(a.cwd, out), result, 'latin1');
      return;
    }
    case 'publish': {
      if (n !== 3) usage(a, 'markdown.sh publish <TASK-ID> <report-file>');
      const [, id, report] = argv;
      checkId(a, id);
      const p = runTaskPath(a, id);
      if (p === '') die(a, `no task_source.path for ${id}`);
      const target = `${root}/${fsPath(p)}`;
      const text = isFile(target) ? readText(target) : null;
      if (text === null) die(a, `task source file missing: ${p}`);
      const rep = isFile(report) ? readText(report) : null;
      if (rep === null) die(a, `report file missing: ${report}`);
      const begin = `<!-- COMPLETION-REPORT:BEGIN:${id} -->`; const end = `<!-- COMPLETION-REPORT:END:${id} -->`;
      const tl = text.split('\n');
      if (tl.includes(begin) && !tl.includes(end)) die(a, `${p} has ${begin} but no ${end}; refusing to publish (it would truncate the file); restore the end marker`);
      let result;
      if (tl.includes(begin)) {
        /** @type {string[]} */ const o = [];
        let skip = false;
        for (const l of lines(text)) {
          if (l === begin) { o.push(l, ...lines(rep)); skip = true; continue; }
          if (l === end) { o.push(l); skip = false; continue; }
          if (skip) continue;
          o.push(l);
        }
        result = joinLines(o);
      } else result = `${text}\n## Completion Report\n\n${begin}\n${rep}${end}\n`;
      writeFileSync(target, result, 'latin1');
      a.out(`${p}#${sha(rep)}\n`);
      return;
    }
    case 'verify': {
      if (n !== 3) usage(a, 'markdown.sh verify <TASK-ID> <receipt>');
      const [, id, rc0] = argv;
      let receipt = rc0;
      checkId(a, id);
      if (isFile(receipt)) receipt = `${runTaskPath(a, id)}#${sha(readText(receipt) ?? '')}`; // a report file instead of a receipt
      const hashAt = receipt.indexOf('#');
      const p = hashAt < 0 ? receipt : receipt.slice(0, hashAt);
      const want = hashAt < 0 ? receipt : receipt.slice(hashAt + 1);
      if (p === '' || want === '' || p === receipt) die(a, `malformed receipt: ${receipt}`);
      const target = `${root}/${fsPath(p)}`;
      const text = isFile(target) ? readText(target) : null;
      if (text === null) die(a, `task source file missing: ${p}`);
      const begin = `<!-- COMPLETION-REPORT:BEGIN:${id} -->`; const end = `<!-- COMPLETION-REPORT:END:${id} -->`;
      if (!hasLine(text, begin) || !hasLine(text, end)) die(a, `no completion-report block found for ${id} in ${p}`);
      /** @type {string[]} */ const inner = [];
      let inside = false;
      for (const l of lines(text)) { if (l === begin) { inside = true; continue; } if (l === end) { inside = false; continue; } if (inside) inner.push(l); }
      if (sha(joinLines(inner)) !== want) die(a, `completion-report content in ${p} no longer matches the published receipt`);
      return;
    }
    case 'followup': {
      if (n !== 3) usage(a, 'markdown.sh followup <TASK-ID> <waiver-file>');
      const [, id, wf] = argv;
      checkId(a, id);
      const w = isFile(wf) ? readText(wf) : null;
      if (w === null) die(a, `waiver file missing: ${wf}`);
      let k = 1;
      while (findTask(a, `${id}-FU${k}`) !== null) k++;
      const nid = `${id}-FU${k}`;
      let title = firstH1(w);
      if (title === '') title = `Follow-up of ${id}`;
      const rel = `${tdir}/backlog/${nid}.md`;
      mkdirSync(`${root}/${tdir}/backlog`, { recursive: true });
      let t = `# Task: ${nid} \xe2\x80\x94 ${title}\n\n**Status:** backlog\n\n---\norigin: ${id}\n\n---\n\n`; // A202: the source is written, not remembered
      let d = false;
      for (const l of lines(w)) { if (!d && l.startsWith('# ')) { d = true; continue; } t += `${l}\n`; }
      for (const h of ['Acceptance criteria', 'Out of scope', 'Constraints', 'Risks', 'Suggested class', 'Verification commands']) if (!hasLine(w, `## ${h}`)) t += `\n## ${h}\n\nTBD (task-author completes this follow-up)\n`;
      writeFileSync(`${root}/${rel}`, t, 'latin1');
      link(`${root}/${tdir}/links.tsv`, id, nid, 'followup'); // A202: the back link (the source task file stays untouched, its hash too)
      a.out(`${rel}\n`);
      return;
    }
    case 'status': {
      if (n !== 3 && n !== 4) usage(a, 'markdown.sh status <TASK-ID> <backlog|todo|in-progress|done> [task-path]');
      const [, id, state, given] = argv;
      checkId(a, id);
      if (!['backlog', 'todo', 'in-progress', 'done'].includes(state)) die(a, `unknown status: ${state} (backlog|todo|in-progress|done)`);
      let rel;
      if (n === 4) {
        rel = given.replace(/^\.\//, '');
        if (!rel.startsWith(`${tdir}/`)) die(a, `task path must be under ${tdir}: ${rel}`);
        if (rel.includes('..')) die(a, `invalid task path: ${rel}`);
        if (!isFile(`${root}/${rel}`)) die(a, `task file missing: ${rel}`);
        const b = path.basename(rel);
        if (!(b === `${id}.md` || (b.startsWith(`${id}-`) && b.endsWith('.md')))) die(a, `task path does not match ${id}: ${rel}`);
      } else { const f = findTask(a, id); if (f === null) die(a, `no task file for ${id} in ${tdir}`); rel = f; }
      if (runTaskPath(a, id) === rel) die(a, `${id} has an active run bound to ${rel}; move the file, then use 'agent.sh task-source-relocate' and 'agent.sh task-source-status'`);
      mkdirSync(`${root}/${tdir}/${state}`, { recursive: true });
      const dest = `${tdir}/${state}/${path.basename(rel)}`;
      const text = readText(`${root}/${rel}`) ?? '';
      const ls = lines(text);
      let result;
      if (ls.some((l) => l.startsWith('**Status:**'))) result = joinLines(ls.map((l) => (l.startsWith('**Status:**') ? `**Status:** ${state}` : l)));
      else result = joinLines(ls.flatMap((l, i) => (i === 0 ? [l, '', `**Status:** ${state}`] : [l])));
      writeFileSync(`${root}/${rel}`, result, 'latin1');
      if (rel !== dest) renameSync(`${root}/${rel}`, `${root}/${dest}`);
      a.out(`${dest}\n`);
      return;
    }
    case 'statusblock': {
      if (n !== 3) usage(a, 'markdown.sh statusblock <TASK-ID> <block-file>');
      const [, id, blk] = argv;
      const block = statusCheck(a, id, blk);
      let p = runTaskPath(a, id);
      if (p === '') { const f = findTask(a, id); if (f === null) die(a, `no task file for ${id} in ${tdir}`); p = f; }
      const target = `${root}/${fsPath(p)}`;
      const text = isFile(target) ? readText(target) : null;
      if (text === null) die(a, `task source file missing: ${p}`);
      const begin = `<!-- PROOFLINE-STATUS:BEGIN:${id} -->`; const end = `<!-- PROOFLINE-STATUS:END:${id} -->`;
      const tl = text.split('\n');
      if (tl.includes(begin) && !tl.includes(end)) die(a, `${p} has ${begin} but no ${end}; refusing to update the status block`);
      let result;
      if (tl.includes(begin)) {
        /** @type {string[]} */ const o = [];
        const bl = lines(block);
        let skip = false; let done = false;
        for (const l of lines(text)) {
          if (skip) { if (l === end) skip = false; continue; }
          if (l === begin) { if (done) { skip = true; continue; } o.push(l, ...bl, end); done = true; skip = true; continue; }
          o.push(l);
        }
        result = joinLines(o);
      } else result = `${text}\n## Proofline Status\n\n${begin}\n${block}${end}\n`;
      writeFileSync(target, result, 'latin1');
      a.out(`${p}\n`);
      return;
    }
    default:
      usage(a, 'markdown.sh <import|publish|verify|followup|status|statusblock> ...');
  }
}

void [AdapterExit, copyFileSync];
