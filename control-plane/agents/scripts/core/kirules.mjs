// @ts-check
// Known issues (A202, item 27; A222: the data rules moved here from known-issues.sh). Findings that were already there before a task and that the task
// does not touch must not stop it, but only the USER decides which ones. Nothing here is read into a session's context: the file is read by the core and
// by the user. knownissues.mjs decides what a match means (the gate status, the Facts block); commands/kicmds.mjs has the commands.
//
// File: .agents/local/known-issues/LIST.tsv (the main tree's, shared by every worktree; local like the approvals, never auto-loaded).
// One record per line, tab separated:
//   KI-<n> <gate[:focus]> <place> <finding text> <follow-up task id> <approval file> <date>
// gate[:focus] and the text are the finding's own (whitespace squeezed); place is `path` or `path:line` of a tracked file. A record is valid only while
// ALL of these hold; any doubt makes it ignored and the finding stays blocking (the safe side):
//   - gate is not SECRETS or SECURITY, nor a focus naming either (those are never listed, whatever the file says);
//   - the approval file named in the record is the user's: kind known-issue, answered_by user, source prompt_capture or tty, consumed, with a request file
//     next to it, and its `bound` is the sha256 of "<gate>\t<place>\t<text>\t<follow-up>\n" (an edited or invented record has no approval for its content;
//     one approval backs one record);
//   - the follow-up task exists as a markdown task file and is not done (a closed follow-up drops the record: it moves to CLOSED.tsv).
// Matching is exact on gate, place and text.
import { appendFileSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { sha256 } from './hash.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { fileText, readBytes, textLines } from './records.mjs';
import { asciiLower, asciiUpper, caseMatch } from './shellglob.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** A refusal of the data rules; the command prints it as `known-issues: <message>` and fails. */
export class KiError extends Error {}

/** The places the rules read (the known-issues folder, the approvals, the tasks folder, the task adapter, the main tree). @param {Context} ctx */
export function kiPlaces(ctx) {
  const main = ctx.sharedMain();
  return {
    main, dir: `${main}/.agents/local/known-issues`, approvals: `${main}/.agents/local/approvals`,
    tasks: `${main}/${ctx.config().get('tasks.dir', '.agents/tasks')}`, adapter: ctx.config().get('tasks.adapter', 'markdown'),
  };
}

/** `gate_refused`: the gate or its focus names SECRETS or SECURITY (never listable, ignored when found in the file). @param {string} g */
export function gateRefused(g) { return /secret|secur/.test(asciiLower(g)); }

/** `place_path`. @param {string} p */
export function placePath(p) { const i = p.indexOf(':'); return i < 0 ? p : p.slice(0, i); }

/** `place_ok`: a repository-relative path with an optional :line, in one spelling only. @param {string} p */
export function placeOk(p) {
  if (!/^[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*(:[0-9]+(-[0-9]+)?)?$/.test(p)) return false;
  const pp = placePath(p);
  // no .. , no empty or . segment (a//b, a/./b, ./a, a/.), no trailing slash, so the touch check cannot be walked around by how a path is written
  return !(pp.includes('..') || pp.endsWith('/') || pp.startsWith('./') || pp.includes('//') || pp.includes('/./') || pp.endsWith('/.'));
}

/** The whitespace squeeze of a finding text: tab, CR and newline become blanks, runs of blanks one, one blank off each end. @param {string} s */
function norm(s) { return s.replace(/[\t\r\n]/g, ' ').replace(/ {2,}/g, ' ').replace(/^ /, '').replace(/ $/, ''); }

/** @param {string} s */
const trimBlank = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/**
 * `canon RECORD FINDING-ID`: gate[:focus], place and text of a blocking finding of a gate record (the last such finding line, the last gate and focus
 * lines); null when the record has no such blocking finding or when one of the three is empty (a record cannot be made from it).
 * @param {Context} ctx @param {string} rec @param {string} fid @returns {{ gate: string, place: string, text: string } | null}
 */
export function canon(ctx, rec, fid) {
  const text = fileText(ctx, rec);
  if (text === null) return null;
  let g = ''; let f = ''; let found = false; let pl = ''; let tx = '';
  const want = asciiUpper(fid);
  for (const line of textLines(text)) {
    if (line.startsWith('gate: ')) g = line.replace(/^gate: *"?/, '').replace(/"?[ \t]*$/, '');
    if (line.startsWith('focus: ')) f = line.replace(/^focus: *"?/, '').replace(/"?[ \t]*$/, '');
    if (line.startsWith('finding: ')) {
      const p = line.slice('finding: '.length).split('|');
      if (asciiUpper(trimBlank(p[0] ?? '')) === want && trimBlank(p[1] ?? '') === 'blocking') { found = true; pl = trimBlank(p[2] ?? ''); tx = trimBlank(p[3] ?? ''); }
    }
  }
  if (!found) return null;
  const out = { gate: f === '' || f === '-' ? g : `${g}:${f}`, place: pl, text: norm(tx) };
  return out.gate === '' || out.place === '' || out.text === '' ? null : out;
}

/**
 * `listable GATE PLACE`: null when the finding can be listed, else the reason. SECRETS/SECURITY never; a place that is not a repository path or not a
 * tracked file of the project never.
 * @param {Context} ctx @param {string} gate @param {string} place @returns {string | null}
 */
export function listable(ctx, gate, place) {
  if (gateRefused(gate)) return `${gate} findings are never listed as known issues (SECRETS and SECURITY always stop the task)`;
  if (!placeOk(place)) return `the place '${place}' is not a repository path (path or path:line of a tracked file): a finding whose place cannot be computed stays blocking`;
  const r = proc.run('git', ['-C', kiPlaces(ctx).main, 'ls-files', '--error-unmatch', '--', placePath(place)], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0 ? null : `the place ${placePath(place)} is not a tracked file of the project`;
}

/** The sorted names in a folder, or []. @param {string} dir */
function names(dir) { try { return readdirSync(dir).sort(); } catch { return []; } }

/** @param {string} p */
function isDirectory(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

/**
 * `followup-state TASK-ID`: backlog | todo | in-progress | done | unknown. The task is a markdown task file `<ID>.md` or `<ID>-*.md` (not an `-FU<n>`
 * file) in the tasks folder or one folder below it; a closed status or the folder `done` means done.
 * @param {Context} ctx @param {string} id
 */
export function followupState(ctx, id) {
  const k = kiPlaces(ctx);
  if (k.adapter !== 'markdown') return 'unknown';
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return 'unknown';
  /** @type {string[]} */ const cands = [];
  const dirs = names(k.tasks).filter((n) => !n.startsWith('.') && isDirectory(`${k.tasks}/${n}`));
  const prefixed = (/** @type {string} */ n) => n.startsWith(`${id}-`) && n.endsWith('.md') && n.length >= id.length + 4;
  for (const d of dirs) if (names(`${k.tasks}/${d}`).includes(`${id}.md`)) cands.push(`${k.tasks}/${d}/${id}.md`);
  for (const d of dirs) for (const n of names(`${k.tasks}/${d}`).filter(prefixed)) cands.push(`${k.tasks}/${d}/${n}`);
  if (names(k.tasks).includes(`${id}.md`)) cands.push(`${k.tasks}/${id}.md`);
  for (const n of names(k.tasks).filter(prefixed)) cands.push(`${k.tasks}/${n}`);
  for (const f of cands) {
    let regular = false;
    try { regular = lstatSync(f).isFile(); } catch { /* gone */ }
    if (!regular) continue;
    const b = f.slice(f.lastIndexOf('/') + 1, -3);
    if (b.startsWith(`${id}-FU`) && /^[0-9]/.test(b.slice(id.length + 3))) continue;
    const parent = f.slice(0, f.lastIndexOf('/'));
    const d = parent.slice(parent.lastIndexOf('/') + 1);
    let st = '';
    for (const l of textLines(readBytes(f) ?? '')) {
      const m = /^\*\*Status:\*\*[ \t\n\v\f\r]*(.*)$/.exec(l);
      if (m) { st = asciiLower(m[1]).replace(/[^a-z-]/g, ''); break; }
    }
    if (['done', 'closed', 'complete', 'completed'].includes(st)) return 'done';
    if (d === 'done') return 'done';
    if (['backlog', 'todo', 'in-progress'].includes(d)) return d;
    return ['backlog', 'todo', 'in-progress'].includes(st) ? st : 'todo';
  }
  return 'unknown';
}

/** The value of the first `key: "..."` line of an approval or request file. @param {string[]} lines @param {string} key */
function quoted(lines, key) {
  const re = new RegExp(`^${key}: "(.*)"$`);
  for (const l of lines) { const m = re.exec(l); if (m) return m[1]; }
  return '';
}

/** A regular file that is not a symbolic link. @param {string} f */
function plainFile(f) { try { return lstatSync(f).isFile(); } catch { return false; } }

/**
 * `approval_ok FILE BOUND`: the user's recorded approval of exactly this content.
 * @param {Context} ctx @param {string} file the approval file's name @param {string} bound
 */
export function approvalOk(ctx, file, bound) {
  const dir = kiPlaces(ctx).approvals;
  if (!/^[0-9]{3}-known-issue\.yaml$/.test(file)) return false;
  if (!plainFile(`${dir}/${file}`)) return false;
  const lines = textLines(readBytes(`${dir}/${file}`) ?? '');
  if (quoted(lines, 'kind') !== 'known-issue' || quoted(lines, 'answered_by') !== 'user' || quoted(lines, 'consumed') !== 'true') return false;
  const src = quoted(lines, 'source');
  if (src !== 'prompt_capture' && src !== 'tty') return false;
  if (quoted(lines, 'capture_id') === '' || quoted(lines, 'bound') !== bound) return false;
  const req = quoted(lines, 'request');
  if (!/^[0-9]{3}-request-known-issue\.yaml$/.test(req)) return false;
  if (!plainFile(`${dir}/${req}`)) return false;
  return quoted(textLines(readBytes(`${dir}/${req}`) ?? ''), 'bound') === bound;
}

/** `row_bound GATE PLACE TEXT FOLLOWUP`: the digest an approval is bound to. @param {string} g @param {string} p @param {string} t @param {string} f */
export function rowBound(g, p, t, f) { return sha256(`${g}\t${p}\t${t}\t${f}\n`); }

/** The rows of a TSV file (empty lines dropped). @param {string} file @returns {string[]} */
function rowsOf(file) { return textLines(readBytes(file) ?? '').filter((l) => l !== ''); }

/**
 * `row_state ROW`: active | closed | invalid. Any doubt is invalid.
 * @param {Context} ctx @param {string} row @param {string[]} all the rows of the list (one approval backs one record)
 */
export function rowState(ctx, row, all) {
  const c = row.split('\t');
  if (c.length < 7) return 'invalid';
  const [id, g, p, t, f, a] = c;
  if (!/^KI-[0-9]+$/.test(id)) return 'invalid';
  if (gateRefused(g)) return 'invalid';
  if (!placeOk(p)) return 'invalid';
  if (t === '' || f === '') return 'invalid';   // a record without a follow-up task is not a record
  if (!approvalOk(ctx, a, rowBound(g, p, t, f))) return 'invalid';
  if (all.filter((r) => r.split('\t')[5] === a).length !== 1) return 'invalid';
  const s = followupState(ctx, f);
  return s === 'done' ? 'closed' : s === 'unknown' ? 'invalid' : 'active';
}

/**
 * `lookup GATE PLACE TEXT`: the record id and follow-up task of the exact, valid, active record; null when there is none.
 * @param {Context} ctx @param {string} g @param {string} p @param {string} t @returns {{ id: string, followup: string } | null}
 */
export function lookup(ctx, g, p, t) {
  const all = rowsOf(`${kiPlaces(ctx).dir}/LIST.tsv`);
  if (all.length === 0 || gateRefused(g)) return null;
  for (const row of all) {
    const c = row.split('\t');
    if (c[1] !== g || c[2] !== p || c[3] !== t) continue;
    if (rowState(ctx, row, all) !== 'active') continue;
    return { id: c[0], followup: c[4] };
  }
  return null;
}

/**
 * `append GATE PLACE TEXT FOLLOWUP APPROVAL-FILE`: writes the record after every check; returns its id. Closed records leave the list first (they move
 * to CLOSED.tsv, they never vanish). Throws KiError for a refusal.
 * @param {Context} ctx @param {string} g @param {string} p @param {string} t @param {string} f @param {string} a
 */
export function appendRecord(ctx, g, p, t, f, a) {
  const k = kiPlaces(ctx);
  const why = listable(ctx, g, p);
  if (why !== null) throw new KiError(why);
  if (t === '') throw new KiError('a record needs the finding text');
  if (f === '') throw new KiError('a record without a follow-up task is not valid');
  const st = followupState(ctx, f);
  if (st === 'done') throw new KiError(`the follow-up task ${f} is already done`);
  if (!['backlog', 'todo', 'in-progress'].includes(st)) throw new KiError(`the follow-up task ${f} was not found as an open markdown task file in the tasks folder (a record needs a follow-up task that exists)`);
  if (!approvalOk(ctx, a, rowBound(g, p, t, f))) throw new KiError('no recorded user approval (kind known-issue) for exactly this record');
  mkdirSync(k.dir, { recursive: true });
  const list = `${k.dir}/LIST.tsv`;
  const all = rowsOf(list);
  if (all.length > 0) {
    if (all.some((r) => r.split('\t')[5] === a)) throw new KiError('that approval already backs a record');
    if (all.some((r) => { const c = r.split('\t'); return c[1] === g && c[2] === p && c[3] === t; })) throw new KiError('this finding is already on the list');
    /** @type {string[]} */ const keep = [];
    for (const row of all) {
      if (rowState(ctx, row, all) === 'closed') appendFileSync(`${k.dir}/CLOSED.tsv`, Buffer.from(`${row}\n`, 'latin1'));
      else keep.push(row);
    }
    writeFileSync(`${list}.keep`, Buffer.from(keep.map((r) => `${r}\n`).join(''), 'latin1'));
    renameSync(`${list}.keep`, list);
  }
  let max = 0;
  for (const row of [...rowsOf(list), ...rowsOf(`${k.dir}/CLOSED.tsv`)]) {
    const n = parseInt(row.split('\t')[0].replace(/^KI-/, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  appendFileSync(list, Buffer.from(`KI-${max + 1}\t${g}\t${p}\t${t}\t${f}\t${a}\t${date}\n`, 'latin1'));
  return `KI-${max + 1}`;
}

/** `list`: the records and their state, one per line. @param {Context} ctx */
export function listRecords(ctx) {
  const all = rowsOf(`${kiPlaces(ctx).dir}/LIST.tsv`);
  if (all.length === 0) return 'known issues: none\n';
  return all.map((row) => {
    const c = row.split('\t');
    const q = (/** @type {number} */ i) => (c[i] === undefined || c[i] === '' ? '?' : c[i]);
    return `${q(0)} [${rowState(ctx, row, all)}] ${q(1)} ${q(2)}: ${q(3)} (follow-up ${q(4)})\n`;
  }).join('');
}

/** The run folders of this machine: the main tree's and those of its task worktrees. @param {Context} ctx @returns {string[]} */
function runFolders(ctx) {
  const main = ctx.sharedMain();
  const runs = [`${main}/.agents/runs`];
  for (const n of names(`${main}/.agents/local/worktrees`)) {
    if (isDirectory(`${main}/.agents/local/worktrees/${n}/.agents/runs`)) runs.push(`${main}/.agents/local/worktrees/${n}/.agents/runs`);
  }
  return runs;
}

/** The first line `KEY: "..."` of a record, its inside. @param {string[]} lines @param {string} key @param {string} [indent] */
function firstQuoted(lines, key, indent = '') {
  const re = new RegExp(`^${indent}${key}: *"(.*)"$`);
  for (const l of lines) { const m = re.exec(l); if (m) return m[1]; }
  return '';
}

/**
 * `candidates`: the blocking findings that runs on this machine recorded, that are not on the list, and whose run did not touch the place (the pre-flight
 * of a batch asks about them). One line per finding: run, finding id, gate, place, text; sorted and unique by gate, place and text.
 * @param {Context} ctx @returns {string}
 */
export function candidates(ctx) {
  /** @type {Map<string, string>} */ const found = new Map();
  for (const runs of runFolders(ctx)) {
    for (const r of names(runs)) {
      const rd = `${runs}/${r}`;
      if (!isDirectory(rd) || !isFile(`${rd}/RUN.yaml`) || !isDirectory(`${rd}/gates`)) continue;
      const scope = firstQuoted(textLines(readBytes(`${rd}/RUN.yaml`) ?? ''), 'scope_paths', '  ');
      if (scope === '') continue;   // no frozen scope: whether the run touched the place cannot be computed, so nothing is offered
      /** @type {Map<string, string>} */ const last = new Map();
      for (const n of names(`${rd}/gates`).filter((x) => /^[0-9]{3}-.*\.yaml$/.test(x))) {
        const lines = textLines(readBytes(`${rd}/gates/${n}`) ?? '');
        const fc = firstQuoted(lines, 'focus');
        last.set(`${firstQuoted(lines, 'gate')}:${fc === '' ? '-' : fc}`, n);
      }
      for (const n of [...last.values()].sort()) {
        const gf = `${rd}/gates/${n}`;
        const lines = textLines(readBytes(gf) ?? '');
        if (firstQuoted(lines, 'result') !== 'fail') continue;
        for (const l of lines) {
          const m = /^finding: ([^|]*)\|blocking\|/.exec(l);
          if (!m) continue;
          for (const fid of m[1].split(/[ \t\n]+/).filter((x) => x !== '')) {
            const c = canon(ctx, gf, fid);
            if (c === null || listable(ctx, c.gate, c.place) !== null) continue;
            const pp = placePath(c.place);
            let hit = false;
            for (const raw of scope.split(/[, \t\n]+/).filter((x) => x !== '')) {
              const se = raw.endsWith('/') ? raw.slice(0, -1) : raw;
              if (pp === se || pp.startsWith(`${se}/`)) hit = true;
              if (/[*?]/.test(se) && caseMatch(se, pp)) hit = true;
            }
            if (hit || lookup(ctx, c.gate, c.place, c.text) !== null) continue;
            const key = `${c.gate}\t${c.place}\t${c.text}`;
            if (!found.has(key)) found.set(key, `${r}\t${fid}\t${key}\n`);
          }
        }
      }
    }
  }
  return [...found.keys()].sort().map((k) => /** @type {string} */ (found.get(k))).join('');
}
