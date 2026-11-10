// @ts-check
// A235 (#181): `agent.sh diff-digest <ID>`, one call for the diff orientation that the verifier, the reviewers and the security reviewer spend 2-4 calls on
// (git status, git diff, ls, verify-scope): which paths the task changed, in which class, how many lines. The context gets a short summary (counts, the paths outside
// the plan scope, the largest in-scope changes, `truncated`); the complete list is a raw file in the run, written with the command line and the input hashes
// under reports/diff-digest-<n>/ (A223: reports/ is the run's registered folder; evidence/ is not), so anyone can run it again and compare.
//   - the classes are the ones `verify-scope` judges (classifyChanges is shared), so the two cannot disagree;
//   - fixed tools only: `git diff --numstat` with a fixed argv (no shell, no model-supplied argument but the run id) and the file's own bytes for untracked files;
//   - it writes nothing but those three files, in a folder it creates itself inside the run (a link planted as `reports/` or as the next folder is never followed);
//   - the raw file holds no time, pid or path of the machine: the same tree gives the same bytes. Not a gate: it reports, it never fails a scope check.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { fail } from './errors.mjs';
import { hashFile } from './fingerprint.mjs';
import { git, headSha } from './git.mjs';
import { taskPatchFingerprint } from './gates.mjs';
import { sha256 } from './hash.mjs';
import { enforceTaskBranch } from './lifecycle.mjs';
import { planScope, sectionValue } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { classifyChanges, scopeAllow } from './commands/verify.mjs';
import { bytes } from './config.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const OUTSIDE_LIST = 10;   // paths outside the plan scope named in the summary
const LARGEST = 5;         // largest in-scope changes named in the summary
const MAX_UNTRACKED = 8 * 1024 * 1024;

/** Lines of an untracked file as `git diff --numstat` would count them: null for a binary (NUL byte), unreadable or very large file. @param {Context} ctx @param {string} rel */
function untrackedLines(ctx, rel) {
  try {
    const file = Buffer.concat([Buffer.from(`${ctx.root}/`), Buffer.from(rel, 'latin1')]);
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_UNTRACKED) return null;
    const b = readFileSync(file);
    if (b.includes(0)) return null;
    let n = 0;
    for (const c of b) if (c === 10) n++;
    return b.length > 0 && b[b.length - 1] !== 10 ? n + 1 : n;
  } catch { return null; }
}

/** `git diff --numstat -z` of the tracked changes against HEAD (or a delivered run's base): path -> [added, deleted] (null for a binary file). @param {Context} ctx @returns {Map<string, [number, number] | null>} */
function trackedLines(ctx) {
  /** @type {Map<string, [number, number] | null>} */ const m = new Map();
  const r = git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '--no-renames', '-z', ctx.ctpBase === '' ? 'HEAD' : ctx.ctpBase, '--']);
  if (r.status !== 0) return m;
  for (const e of r.out.split('\0')) {
    const t = e.split('\t');
    if (t.length < 3) continue;
    const p = t.slice(2).join('\t');
    m.set(p, /^[0-9]+$/.test(t[0]) && /^[0-9]+$/.test(t[1]) ? [Number(t[0]), Number(t[1])] : null);
  }
  return m;
}

/**
 * Create the next `reports/diff-digest-<n>/` of the run. Exclusive: a name that exists (also as a link) is skipped, never followed.
 * @param {string} dir the run folder @returns {{ folder: string, n: number }}
 */
function nextFolder(dir) {
  const reports = `${dir}/reports`;
  try {
    const st = lstatSync(reports);
    if (st.isSymbolicLink() || !st.isDirectory()) fail(`diff-digest refused: ${reports} is not a plain folder`);
  } catch (e) {
    if (e instanceof Error && e.name === 'ProoflineError') throw e;
    mkdirSync(reports, { recursive: true });
  }
  const real = realpathSync(reports); const runReal = realpathSync(dir);
  if (real !== `${runReal}/reports`) fail(`diff-digest refused: ${reports} does not resolve inside the run`);
  for (let n = 1; n < 10000; n++) {
    try { mkdirSync(`${reports}/diff-digest-${n}`); return { folder: `${reports}/diff-digest-${n}`, n }; } catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e; }
  }
  return fail('diff-digest refused: 9999 digests exist in this run');
}

/** Write a new file, never through an existing name. @param {string} file @param {string} text a byte string */
function writeNew(file, text) {
  const fd = openSync(file, 'wx', 0o644);
  try { writeSync(fd, Buffer.from(text, 'latin1')); } finally { closeSync(fd); }
}

/** @param {Context} ctx @param {string[]} args */
function diffDigest(ctx, args) {
  const id = args[0];
  if (id === undefined || id === '' || args.length !== 1) fail('usage: agent.sh diff-digest <ID>');
  ctx.fpMode = 'refresh';
  requireRun(ctx, bytes(id));
  const dir = runDir(ctx, bytes(id));
  enforceTaskBranch(ctx, bytes(id));
  const sc = planScope(ctx, dir);
  if (!sc.ok || sc.rows.length === 0) fail('invalid scope mapping: fix PLAN.md ## Scope entries (see agent.sh verify-scope)');
  if (sectionValue(ctx, dir, 'baseline', 'status') !== 'captured') fail(`baseline required before a digest: ${id}`);
  const changes = classifyChanges(ctx, bytes(id), dir, sc.rows, scopeAllow(ctx, dir, false));
  const tracked = trackedLines(ctx);
  /** @type {Array<{ cls: string, add: number | null, del: number | null, path: string, fp: string, type: string }>} */
  const rows = changes.map((c) => {
    let add = null; let del = null;
    if (c.type === 'tracked') { const t = tracked.get(c.path); if (t) { add = t[0]; del = t[1]; } } else { add = untrackedLines(ctx, c.path); if (add !== null) del = 0; }
    return { cls: c.cls, add, del, path: c.path, fp: c.fp, type: c.type };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const num = (/** @type {number | null} */ v) => (v === null ? '-' : String(v));
  const raw = `# diff-digest raw v1\n# class\tadded\tdeleted\tpath ('-' = binary, unreadable or over ${MAX_UNTRACKED} bytes); byte order of the path\n${rows.map((r) => `${r.cls}\t${num(r.add)}\t${num(r.del)}\t${r.path}\n`).join('')}`;
  const inputs = [
    `plan_sha256 ${hashFile(`${dir}/PLAN.md`)}`,
    `head ${headSha(ctx)}`,
    `base ${ctx.ctpBase === '' ? 'HEAD' : ctx.ctpBase}`,
    `patch_fingerprint ${taskPatchFingerprint(ctx, dir)}`,
    `changes_sha256 ${sha256(rows.map((r) => `${r.cls} ${r.path} ${r.fp}\n`).join(''))}`,
  ].join('\n') + '\n';
  const { folder, n } = nextFolder(dir);
  writeNew(`${folder}/raw.txt`, raw);
  writeNew(`${folder}/inputs.txt`, inputs);
  writeNew(`${folder}/command.txt`, `agent.sh diff-digest ${id}\n`);
  const rel = `.agents/runs/${id}/reports/diff-digest-${n}`;

  const count = (/** @type {string} */ c) => rows.filter((r) => r.cls === c).length;
  const classes = ['scope', 'knowledge', 'control-plane', 'installed', 'unexpected'].filter((c) => count(c) > 0).map((c) => `${c}=${count(c)}`);
  const sumAdd = rows.reduce((a, r) => a + (r.add ?? 0), 0); const sumDel = rows.reduce((a, r) => a + (r.del ?? 0), 0);
  const fmt = (/** @type {{ path: string, add: number | null, del: number | null }} */ r) => `${r.path} +${num(r.add)} -${num(r.del)}`;
  const outside = rows.filter((r) => r.cls !== 'scope');
  const shownOutside = outside.slice(0, OUTSIDE_LIST);
  const inScope = rows.filter((r) => r.cls === 'scope').sort((a, b) => ((b.add ?? 0) + (b.del ?? 0)) - ((a.add ?? 0) + (a.del ?? 0)) || (a.path < b.path ? -1 : 1)).slice(0, LARGEST);
  const shown = shownOutside.length + inScope.length;
  const out = [
    `diff-digest ${id} (${n}): ${rel}/`,
    `changed paths: ${rows.length} (tracked ${rows.filter((r) => r.type === 'tracked').length}, untracked ${rows.filter((r) => r.type === 'untracked').length}); classes: ${classes.length ? classes.join(' ') : 'none'}`,
    `lines: +${sumAdd} -${sumDel} (${rows.filter((r) => r.add === null).length} path(s) without a line count)`,
  ];
  if (outside.length) out.push(`not in the plan scope (${outside.length}${outside.length > shownOutside.length ? `, first ${shownOutside.length} in byte order` : ''}): ${shownOutside.map((r) => `${r.cls}:${fmt(r)}`).join('; ')}`);
  if (inScope.length) out.push(`largest in scope: ${inScope.map(fmt).join('; ')}`);
  out.push(shown >= rows.length ? 'truncated: no' : `truncated: yes (${rows.length - shown} of ${rows.length} paths are named only in the raw file; a decision about one path reads the raw file)`);
  out.push(`raw: ${rel}/raw.txt sha256=${sha256(Buffer.from(raw, 'latin1'))}`);
  out.push(`again: agent.sh diff-digest ${id} (the same tree gives the same raw.txt; inputs.txt holds the hashes)`);
  ctx.out(`${out.join('\n')}\n`);
  return 0;
}

export const DIFFDIGEST_HANDLERS = { 'diff-digest': diffDigest };
