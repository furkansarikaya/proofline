// @ts-check
// The git queries of the control plane. Every call goes through proc.mjs (counted); output is kept as byte strings (latin1) so that
// quoted paths and byte order are what the shell saw. `git -C <root>` with LC_ALL=C, like agent.sh.
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** @typedef {{ status: number, out: string }} GitResult */

/**
 * Run git in the project root.
 * @param {Context} ctx @param {string[]} args @param {{ env?: Record<string, string>, input?: string | Buffer }} [opt]
 * @returns {GitResult}
 */
export function git(ctx, args, opt = {}) {
  const r = proc.run('git', ['-C', ctx.root, ...args], {
    cwd: ctx.cwd, env: { ...ctx.childEnv(), ...(opt.env ?? {}) }, input: opt.input, stdio: ['pipe', 'pipe', 'ignore'],
  });
  return { status: r.status, out: r.stdout.toString('latin1') };
}

/** `LC_ALL=C sort -u` over lines (byte order: the strings are byte strings). @param {string[]} lines */
export function sortUnique(lines) { return [...new Set(lines)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }

/** Non-empty lines of git output. @param {string} out */
function nonEmpty(out) { return out.split('\n').filter((l) => l !== ''); }

/** `current_tracked_paths`: the paths changed against the index and against HEAD (or against a delivered run's base). @param {Context} ctx @returns {string[]} */
export function trackedPaths(ctx) {
  const base = ctx.ctpBase;
  const a = base !== '' ? git(ctx, ['diff', '--no-renames', '--name-only', base]).out
    : git(ctx, ['diff', '--no-renames', '--name-only']).out + git(ctx, ['diff', '--cached', '--no-renames', '--name-only']).out;
  return sortUnique(nonEmpty(a));
}

/** `current_untracked_paths` @param {Context} ctx @returns {string[]} */
export function untrackedPaths(ctx) {
  return sortUnique(nonEmpty(git(ctx, ['ls-files', '--others', '--exclude-standard']).out));
}

/** `git diff --no-renames --name-only BASE --` (the task's tracked changes against its base), sorted. @param {Context} ctx @param {string} base */
export function diffNames(ctx, base) {
  return sortUnique(nonEmpty(git(ctx, ['diff', '--no-renames', '--name-only', base, '--']).out));
}

/** `git rev-parse HEAD` ('' when it fails). @param {Context} ctx */
export function headSha(ctx) { const r = git(ctx, ['rev-parse', 'HEAD']); return r.status === 0 ? r.out.replace(/\n+$/, '') : ''; }

/** `git rev-parse -q --verify REV` ('' when unknown). @param {Context} ctx @param {string} rev */
export function verifyRev(ctx, rev) { const r = git(ctx, ['rev-parse', '-q', '--verify', rev]); return r.status === 0 ? r.out.replace(/\n+$/, '') : ''; }

/** `git cat-file -e OBJECT` @param {Context} ctx @param {string} object */
export function objectExists(ctx, object) { return git(ctx, ['cat-file', '-e', object]).status === 0; }

/** `git merge-base --is-ancestor A B` @param {Context} ctx @param {string} a @param {string} b */
export function isAncestor(ctx, a, b) { return git(ctx, ['merge-base', '--is-ancestor', a, b]).status === 0; }

/** `git show REV:PATH` as bytes, null when it fails. @param {Context} ctx @param {string} spec */
export function show(ctx, spec) { const r = git(ctx, ['show', spec]); return r.status === 0 ? r.out : null; }

/** `git cat-file -p TREE:PATH`, null when it fails. @param {Context} ctx @param {string} spec */
export function catFile(ctx, spec) { const r = git(ctx, ['cat-file', '-p', spec]); return r.status === 0 ? r.out : null; }

/**
 * `git diff --numstat --no-renames BASE -- PATH...` in ONE call: path -> lines added + deleted (a binary file counts 100000).
 * @param {Context} ctx @param {string} base @param {string[]} paths @returns {Map<string, number>}
 */
export function numstat(ctx, base, paths) {
  /** @type {Map<string, number>} */ const m = new Map();
  if (paths.length === 0) return m;
  const r = git(ctx, ['diff', '--numstat', '--no-renames', '-z', base, '--', ...paths]);
  for (const rec of r.out.split('\0')) {
    if (rec === '') continue;
    const mm = /^([0-9]+|-)\t([0-9]+|-)\t([^]*)$/.exec(rec);
    if (!mm) continue;
    m.set(mm[3], (m.get(mm[3]) ?? 0) + (mm[1] === '-' ? 100000 : Number(mm[1]) + Number(mm[2])));
  }
  return m;
}

/** `git ls-files --error-unmatch -- PATH` for many paths at once: the set of tracked ones. @param {Context} ctx @param {string[]} paths */
export function trackedSet(ctx, paths) {
  if (paths.length === 0) return new Set();
  const r = git(ctx, ['ls-files', '-z', '--', ...paths]);
  return new Set(r.out.split('\0').filter((x) => x !== ''));
}

/** `git rev-parse --git-path index` and `--git-path objects`, absolute (one process). @param {Context} ctx @returns {{ index: string, objects: string }} */
export function gitPaths(ctx) {
  const r = git(ctx, ['rev-parse', '--git-path', 'index', '--git-path', 'objects']);
  const [i = '', o = ''] = r.out.split('\n');
  const abs = (/** @type {string} */ p) => (p.startsWith('/') ? p : `${ctx.root}/${p}`);
  return { index: abs(i), objects: abs(o) };
}

/**
 * Many objects in ONE `git cat-file --batch` process: spec ("REV:PATH") -> content bytes, or null when the object is missing.
 * @param {Context} ctx @param {string[]} specs @returns {Map<string, string | null>}
 */
export function catBatch(ctx, specs) {
  /** @type {Map<string, string | null>} */ const out = new Map();
  if (specs.length === 0) return out;
  const r = proc.run('git', ['-C', ctx.root, 'cat-file', '--batch'], {
    cwd: ctx.cwd, env: ctx.childEnv(), input: Buffer.from(`${specs.join('\n')}\n`, 'latin1'), stdio: ['pipe', 'pipe', 'ignore'],
  });
  const buf = r.stdout;
  let pos = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) { out.set(spec, null); continue; }
    const head = buf.subarray(pos, nl).toString('latin1');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) ([0-9]+)$/.exec(head);
    if (!m) { out.set(spec, null); continue; }
    const size = Number(m[2]);
    out.set(spec, m[1] === 'blob' ? buf.subarray(pos, pos + size).toString('latin1') : null);
    pos += size + 1;
  }
  return out;
}

/**
 * `git diff --no-renames -U0 BASE -- PATH...` in one call, split per file: path -> the lines the diff adds.
 * @param {Context} ctx @param {string} base @param {string[]} paths @returns {Map<string, string[]>}
 */
export function addedLines(ctx, base, paths) {
  if (paths.length === 0) return new Map();
  return ctx.once(`git:added:${base}:${paths.join('\0')}`, () => addedLinesNow(ctx, base, paths));
}

/** @param {Context} ctx @param {string} base @param {string[]} paths @returns {Map<string, string[]>} */
function addedLinesNow(ctx, base, paths) {
  /** @type {Map<string, string[]>} */ const out = new Map();
  const r = git(ctx, ['diff', '--no-renames', '-U0', base, '--', ...paths]);
  /** @type {string[] | null} */ let cur = null;
  let hunk = false;
  for (const l of r.out.split('\n')) {
    if (l.startsWith('diff --git a/')) {
      const rest = l.slice('diff --git a/'.length);
      const p = rest.slice(0, (rest.length - 3) / 2);
      cur = [];
      out.set(p, cur);
      hunk = false;
      continue;
    }
    if (l.startsWith('diff --git ')) { cur = null; hunk = false; continue; } // a quoted name: the caller asks for that path alone
    if (l.startsWith('@@')) { hunk = true; continue; }
    if (hunk && cur && l.startsWith('+')) cur.push(l.slice(1));
  }
  return out;
}
