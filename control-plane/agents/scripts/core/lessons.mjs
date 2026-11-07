// @ts-check
// Lesson candidates from run evidence (A229: the former scripts/lessons.sh). A lesson comes only from evidence and becomes a rule only with the user's approval;
// this module is the whole mechanism (no store of its own: the candidates are rows of one wiki page, the promoted rule is a line in AGENTS.md). Run through
// `agent.sh lessons <op> ...`.
//   derive ID                  candidates from the run's gate records: one line per non-info finding, "<source> | kind=<GATE>:<focus> | <finding text>"
//   write ID SOURCE TEXT       lead only: append a candidate row to docs/wiki/lessons/observations.md; refused when SOURCE does not resolve to a gate record
//                              (or a finding in it) of the run
//   validate                   every row of the page has a well-formed source (resolved while the run exists)
//   count [KIND]               "<kind> | runs=N | repeats=N-1 | propose=yes|no": distinct runs per finding kind, from the page rows and the gate records of the
//                              runs now on disk
//   bound ID CAND              hash of the candidate row (what an approval of kind rule:CAND binds to)
//   text CAND                  the candidate's text
//   promote ID CAND            lead only: append the candidate to the "## Project rules" section of AGENTS.md and mark the row promoted; refused without an
//                              unconsumed `rule:CAND` approval
// SOURCE = gate:<RUN>/<NNN-GATE>[#<FINDING-ID>]@<sha256 of the record file>; a cleaned run's row is trusted only when `write` saw it
// (.agents/local/lessons-sources) or the committed page holds it, so an invented run id fails validate. Kind of a finding = the gate and risk focus of its record.
// shortcut: the gate record is read as written (agent.sh verify-gates owns its integrity); a row of a run that is already cleaned up keeps its source text
// unchecked. Promotion targets AGENTS.md only; a config change is made by the normal route.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { approvalConsume } from './approve.mjs';
import { ProoflineError } from './errors.mjs';
import { gitBlobSha, sha256 } from './hash.mjs';
import { LockSet, takeCommandLocks } from './lock.mjs';
import { isDir, isFile } from './paths.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** A refusal of `lessons`: the text with its `lessons: ` prefix and exit status 1 (`die`). */
class Die extends ProoflineError {
  /** @param {string} msg */
  constructor(msg) { super(`lessons: ${msg}`, 1); }
}

const PAGE_HEAD = '---\ntitle: lesson-observations\nstatus: current\nsource: .agents/KNOWLEDGE.md\n---\n\n# Lesson observations\n\nCandidates derived from run evidence. A candidate is a rule only after the user approved it (`agent.sh lessons promote`).\n\n';

/** @param {string} p */
function readText(p) { try { return readFileSync(p, 'latin1'); } catch { return ''; } }
/** @param {string} s */
const trim = (s) => s.replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '');
/** @param {Context} ctx */
const pageOf = (ctx) => `${ctx.root}/docs/wiki/lessons/observations.md`;
/** @param {Context} ctx @param {string} run */
const rdir = (ctx, run) => `${ctx.root}/.agents/runs/${run}`;

/** One finding of a gate record. @typedef {{ gf: string, fid: string, kind: string, text: string }} Finding */

/**
 * `findings RUN`: one entry per non-info finding of every gate record (`gates/NNN-*.yaml`).
 * @param {Context} ctx @param {string} run @returns {Finding[]}
 */
export function findings(ctx, run) {
  const dir = `${rdir(ctx, run)}/gates`;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(dir).filter((n) => /^[0-9]{3}-.*\.yaml$/.test(n)).sort(); } catch { return []; }
  /** @type {Finding[]} */ const out = [];
  for (const n of names) {
    if (!isFile(`${dir}/${n}`)) continue;
    let g = ''; let fc = '';
    /** @type {Array<[string, string]>} */ const rows = [];
    for (const l of readText(`${dir}/${n}`).replace(/\n$/, '').split('\n')) {
      if (l.startsWith('gate: ')) g = (l.split(/[ \t]+/)[1] ?? '').replace(/"/g, '');
      if (l.startsWith('focus: ')) fc = l.replace(/^focus: */, '').replace(/"/g, '');
      if (l.startsWith('finding: ')) {
        const p = l.slice(9).split('|');
        if (trim(p[1] ?? '') !== 'info') rows.push([trim(p[0] ?? ''), trim((p[3] ?? '').replace(/\t/g, ' '))]);
      }
    }
    if (fc === '') fc = '-';
    for (const [fid, text] of rows) out.push({ gf: n.replace(/\.yaml$/, ''), fid, kind: `${g}:${fc}`, text });
  }
  return out;
}

/** `kind_of_gate RUN GATEFILE`: "<gate>:<focus or ->", or null when the record is missing. @param {Context} ctx @param {string} run @param {string} gate */
function kindOfGate(ctx, run, gate) {
  const f = `${rdir(ctx, run)}/gates/${gate}.yaml`;
  if (!isFile(f)) return null;
  const lines = readText(f).split('\n');
  const pick = (/** @type {string} */ k) => { for (const l of lines) { const m = new RegExp(`^${k}: *"(.*)"`).exec(l); if (m) return m[1]; } return ''; };
  const fc = pick('focus');
  return `${pick('gate')}:${fc === '' ? '-' : fc}`;
}

/**
 * `check_source SOURCE`: the run and the kind of a source ("?" for a cleaned run), or the message of the refusal.
 * SOURCE = gate:<RUN>/<NNN-GATE>[#<FINDING-ID>]@<sha256 of the gate record file>; while the run exists the hash must match.
 * @param {Context} ctx @param {string} src @returns {{ run: string, kind: string } | { error: string }}
 */
export function checkSource(ctx, src) {
  if (!/^gate:.+\/[0-9]{3}-.*@.{64}$/s.test(src)) return { error: `source '${src}' is not gate:<RUN>/<NNN-GATE>[#<FINDING-ID>]@<sha256 of the record>` };
  const sha = src.slice(src.lastIndexOf('@') + 1);
  let r = src.slice(5); r = r.slice(0, r.lastIndexOf('@'));
  const run = r.slice(0, r.indexOf('/'));
  r = r.slice(r.indexOf('/') + 1);
  const gate = r.includes('#') ? r.slice(0, r.indexOf('#')) : r;
  const fid = r.includes('#') ? r.slice(r.indexOf('#') + 1) : '';
  if (/[^A-Za-z0-9._#+-]/.test(run + gate + fid + sha)) return { error: `source '${src}' holds an invalid character` };
  // a cleaned run: validate decides from the hash (seen-file) or the committed page; an invented run id has neither
  if (!isDir(rdir(ctx, run))) return { run, kind: '?' };
  const kind = kindOfGate(ctx, run, gate);
  if (kind === null) return { error: `source '${src}': run ${run} has no gate record ${gate}` };
  if (sha256(readFileSync(`${rdir(ctx, run)}/gates/${gate}.yaml`)) !== sha) return { error: `source '${src}': the gate record's hash differs` };
  if (fid !== '' && !findings(ctx, run).some((f) => f.gf === gate && f.fid === fid)) return { error: `source '${src}': gate record ${gate} has no non-info finding ${fid}` };
  return { run, kind };
}

/** `cand_id`: lc-<8 hex of the hash of the text>. @param {string} text */
const candId = (text) => `lc-${gitBlobSha(text).slice(0, 8)}`;

/** The candidate rows of the page. @param {Context} ctx */
function rows(ctx) { return readText(pageOf(ctx)).split('\n').filter((l) => l.startsWith('- lc-')); }

/** `row_of CAND`: the row line, or null. @param {Context} ctx @param {string} cand */
function rowOf(ctx, cand) { return rows(ctx).find((l) => l.startsWith(`- ${cand} | `)) ?? null; }

/** @param {string} row */
const normRow = (row) => row.replace(/ \| status=[a-z]* \| /, ' | ');

/** `row_trusted`: a cleaned run's row counts when `write` saw its record, or the same row is in the committed page. @param {Context} ctx @param {string} row */
function rowTrusted(ctx, row) {
  const seen = `${ctx.root}/.agents/local/lessons-sources`;
  const h = sha256(normRow(row));
  if (readText(seen).split('\n').includes(h)) return true;
  const r = proc.run('git', ['-C', ctx.root, 'show', 'HEAD:docs/wiki/lessons/observations.md'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return false;
  return r.stdout.toString('latin1').split('\n').some((l) => normRow(l) === normRow(row));
}

/** `row_fields ROW`. @param {string} row */
function rowFields(row) {
  const f = row.split('|');
  const v = (/** @type {number} */ i, /** @type {string} */ prefix) => { const x = trim(f[i] ?? ''); return x.startsWith(prefix) ? x.slice(prefix.length) : x; };
  return { id: trim((f[0] ?? '').replace(/^- /, '')), kind: v(1, 'kind='), run: v(2, 'run='), src: v(3, 'source='), st: v(4, 'status=') };
}

/** `row_text ROW`: the fields from the sixth on. @param {string} row */
function rowText(row) { return row.split('|').slice(5).join('|').replace(/^[ \t\n\v\f\r]+/, ''); }

/** @param {Context} ctx @param {string} id */
function needRun(ctx, id) { if (!isDir(rdir(ctx, id))) throw new Die(`no run ${id}`); }

/** `lessons bound ID CAND` / the approval binding of a rule: the hash of the candidate row. @param {Context} ctx @param {string} cand @returns {string | null} */
export function lessonBound(ctx, cand) {
  const row = rowOf(ctx, cand);
  return row === null ? null : sha256(row);
}

/** `lessons text CAND`: the candidate's text, or null when there is no such candidate. @param {Context} ctx @param {string} cand @returns {string | null} */
export function lessonText(ctx, cand) {
  const row = rowOf(ctx, cand);
  return row === null ? null : rowText(row);
}

/** `lessons validate`: the messages and whether every row is well formed. @param {Context} ctx @returns {{ ok: boolean, err: string }} */
export function lessonsValidate(ctx) {
  let bad = false; let err = '';
  const note = (/** @type {string} */ m) => { err += `${m}\n`; bad = true; };
  for (const row of rows(ctx)) {
    const f = rowFields(row);
    const text = rowText(row);
    if (!/^lc-.{8}$/s.test(f.id)) { note(`bad row id: ${row}`); continue; }
    if (f.src === '') { note(`${f.id}: no source`); continue; }
    const res = checkSource(ctx, f.src);
    if ('error' in res) { err += `${res.error}\n`; note(`${f.id}: invalid source`); continue; }
    if (res.run !== f.run) { note(`${f.id}: run=${f.run} does not match its source`); continue; }
    if (res.kind === '?' && !rowTrusted(ctx, row)) { note(`${f.id}: run ${f.run} is gone and its record hash is neither seen by write nor in the committed page`); continue; }
    if (res.kind !== '?' && res.kind !== f.kind) { note(`${f.id}: kind=${f.kind} does not match its gate record (${res.kind})`); continue; }
    if (f.st !== 'candidate' && f.st !== 'promoted') note(`${f.id}: status must be candidate|promoted`);
    if (text === '') note(`${f.id}: no text`);
  }
  // a list item that is not a well-formed row cannot hide a sourceless candidate
  if (readText(pageOf(ctx)).split('\n').some((l) => l.startsWith('- ') && !l.startsWith('- lc-'))) note('page holds a list item that is not a candidate row');
  return { ok: !bad, err };
}

/** `lessons count [KIND]`: one line per finding kind. @param {Context} ctx @param {string} want */
function count(ctx, want) {
  /** @type {Set<string>} */ const pairs = new Set();
  for (const row of rows(ctx)) { const f = rowFields(row); pairs.add(`${f.kind}\t${f.run}`); }
  /** @type {string[]} */ let runs = [];
  try { runs = readdirSync(`${ctx.root}/.agents/runs`).sort(); } catch { runs = []; }
  for (const rid of runs) {
    if (!isDir(`${ctx.root}/.agents/runs/${rid}`)) continue;
    for (const f of findings(ctx, rid)) pairs.add(`${f.kind}\t${rid}`);
  }
  /** @type {Map<string, number>} */ const n = new Map();
  for (const p of pairs) { const kind = p.slice(0, p.indexOf('\t')); if (kind !== '' && (want === '' || kind === want)) n.set(kind, (n.get(kind) ?? 0) + 1); }
  let out = '';
  for (const kind of [...n.keys()].sort()) {
    const runsN = /** @type {number} */ (n.get(kind));
    const prom = rows(ctx).some((l) => l.includes(`| kind=${kind} |`) && l.includes('| status=promoted |'));
    out += `${kind} | runs=${runsN} | repeats=${runsN - 1} | propose=${runsN - 1 >= 1 && !prom ? 'yes' : 'no'}\n`;
  }
  return out;
}

/** The AGENTS.md with the bullet in its "## Project rules" section (newest first), or in a new one at the end. @param {string} text @param {string} bullet */
function withRule(text, bullet) {
  if (!/^## Project rules[ \t]*$/m.test(text)) return `${text}\n## Project rules\n\n${bullet}\n`;
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  /** @type {string[]} */ const out = [];
  let pend = false; let done = false;
  for (const l of lines) {
    if (pend) {
      pend = false;
      if (l === '') { out.push(l, bullet); continue; }
      out.push(bullet);
    }
    out.push(l);
    if (/^## Project rules[ \t]*$/.test(l) && !done) { pend = true; done = true; }
  }
  if (pend) out.push(bullet);
  return `${out.join('\n')}\n`;
}

/** Run FN holding the locks of COMMAND (the child `agent.sh approval-consume` took them itself). @template T @param {Context} ctx @param {string} command @param {string[]} args @param {() => T} fn @returns {T} */
export function withCommandLocks(ctx, command, args, fn) {
  const locks = new LockSet(ctx);
  try { takeCommandLocks(locks, ctx, command, args); return fn(); } finally { locks.releaseAll(); }
}

const USAGE = 'usage: agent.sh lessons <derive ID|write ID SOURCE TEXT|validate|count [KIND]|bound ID CAND|text CAND|promote ID CAND>';

/** @param {Context} ctx @param {string[]} args the arguments after `lessons` */
export function lessonsCommand(ctx, args) {
  const op = args[0] ?? '';
  const a = args.slice(1);
  const lead = () => { if (ctx.role !== 'lead') throw new ProoflineError(`command denied for ${ctx.role} (lead only)`, 1); };
  const page = pageOf(ctx);
  switch (op) {
    case 'derive': {
      const id = a[0] ?? '';
      if (id === '') { ctx.err('usage: agent.sh lessons derive <ID>\n'); return 2; }
      needRun(ctx, id);
      for (const f of findings(ctx, id)) ctx.out(`gate:${id}/${f.gf}#${f.fid}@${sha256(readFileSync(`${rdir(ctx, id)}/gates/${f.gf}.yaml`))} | kind=${f.kind} | ${f.text}\n`);
      return 0;
    }
    case 'write': {
      lead();
      const [id = '', src = '', text = ''] = a;
      if (id === '') { ctx.err('usage: agent.sh lessons write <ID> <SOURCE> <TEXT>\n'); return 2; }
      if (trim(text) === '') throw new Die('a candidate needs text');
      if (text.includes('\n')) throw new Die('a candidate is one line');
      needRun(ctx, id);
      const res = checkSource(ctx, src);
      if ('error' in res) { ctx.err(`${res.error}\n`); throw new Die('candidate refused: no valid source'); }
      if (res.run !== id || res.kind === '?') throw new Die(`candidate refused: source is run ${res.run} (not ${id}) or has no gate record now`);
      const cid = candId(`${res.kind}|${src}`);
      if (rowOf(ctx, cid) !== null) throw new Die(`candidate ${cid} is already written`);
      try { mkdirSync(path.dirname(page), { recursive: true }); } catch { throw new Die('cannot create the wiki folder'); }
      if (!existsSync(page)) writeFileSync(page, Buffer.from(PAGE_HEAD, 'latin1'));
      const nrow = `- ${cid} | kind=${res.kind} | run=${id} | source=${src} | status=candidate | ${text}`;
      appendFileSync(page, Buffer.from(`${nrow}\n`, 'latin1'));
      // local, untracked: this clone saw the record; the row hash binds id, kind, run, source and text
      const seen = `${ctx.root}/.agents/local/lessons-sources`;
      mkdirSync(path.dirname(seen), { recursive: true });
      appendFileSync(seen, `${sha256(normRow(nrow))}\n`);
      ctx.out(`candidate written: ${cid} (${res.kind})\n`);
      return 0;
    }
    case 'validate': {
      const v = lessonsValidate(ctx);
      ctx.err(v.err);
      if (!v.ok) return 1;
      ctx.out('lessons valid\n');
      return 0;
    }
    case 'count': ctx.out(count(ctx, a[0] ?? '')); return 0;
    case 'bound': {
      if ((a[1] ?? '') === '') { ctx.err('usage: agent.sh lessons bound <ID> <CAND>\n'); return 2; }
      const h = lessonBound(ctx, a[1]);
      if (h === null) throw new Die(`no candidate ${a[1]}`);
      ctx.out(`${h}\n`);
      return 0;
    }
    case 'text': {
      if ((a[0] ?? '') === '') { ctx.err('usage: agent.sh lessons text <CAND>\n'); return 2; }
      const t = lessonText(ctx, a[0]);
      if (t === null) throw new Die(`no candidate ${a[0]}`);
      ctx.out(`${t}\n`);
      return 0;
    }
    case 'promote': {
      lead();
      const [id = '', cand = ''] = a;
      if (id === '') { ctx.err('usage: agent.sh lessons promote <ID> <CAND>\n'); return 2; }
      const row = rowOf(ctx, cand);
      if (row === null) throw new Die(`no candidate ${cand}`);
      const f = rowFields(row);
      if (f.st !== 'candidate') throw new Die(`candidate ${cand} is already ${f.st}`);
      const v = lessonsValidate(ctx);
      ctx.err(v.err);
      if (!v.ok) throw new Die('the observation page is not valid');
      const agents = `${ctx.root}/AGENTS.md`;
      if (!isFile(agents)) throw new Die('no AGENTS.md at the project root');
      // the new AGENTS.md is built first; the approval is consumed only when it exists, then it replaces the file (the approval is the user's:
      // 'request-approval <ID> rule:<CAND>', relayed, answered in the user's own words)
      const tmp = `${agents}.lessons.${process.pid}`;
      writeFileSync(tmp, Buffer.from(withRule(readText(agents), `- ${rowText(row)} (lesson ${cand})`), 'latin1'));
      const mark = ctx.chunks.length;
      try {
        withCommandLocks(ctx, 'approval-consume', [id, `rule:${cand}`], () => approvalConsume(ctx, [id, `rule:${cand}`]));
      } catch (e) {
        rmSync(tmp, { force: true });
        if (e instanceof ProoflineError) ctx.err(`${e.message}\n`);
        throw new Die(`promotion refused: no unconsumed user approval 'rule:${cand}' bound to this candidate (run: agent.sh request-approval ${id} rule:${cand}, relay it to the user)`);
      }
      ctx.chunks.length = mark;
      try { renameSync(tmp, agents); } catch { throw new Die('cannot write AGENTS.md (the approval is consumed: request it again)'); }
      const re = new RegExp(`^(- ${cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| .* \\| source=[^|]* \\| )status=candidate`);
      writeFileSync(page, Buffer.from(readText(page).split('\n').map((l) => l.replace(re, '$1status=promoted')).join('\n'), 'latin1'));
      ctx.out(`promoted: ${cand} -> AGENTS.md\n`);
      return 0;
    }
    default:
      ctx.err(`${USAGE}\n`);
      return 2;
  }
}
