// @ts-check
// Baseline and path fingerprints, the content fingerprint and the fingerprint cache (agent.sh lines 622-910). One baseline map per
// invocation (no paths-times-entries loop); path fingerprints use fs and node:crypto; the content fingerprint builds the git tree of the
// working tree in a private index exactly as `content_fingerprint` does, with batched git calls. The cache has the same file, key and
// line format as the shell, so the shell and Node hit the same entries.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';
import { git, gitPaths } from './git.mjs';
import { isFile } from './paths.mjs';
import { fileLines, fileText, planScope, scopePaths } from './records.mjs';
import { blockOnlyText, hasBlockMarkers, inKnowledgeScope, installedControlPath, installedControlPaths, knowledgeScopeEntries, stripProoflineBlock, words } from './scope.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** SHA-256 hex of a file, read in chunks; '' when it cannot be read (the shell's hash_file prints nothing). @param {string} file */
export function hashFile(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return ''; }
  try {
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
    return h.digest('hex');
  } catch { return ''; } finally { closeSync(fd); }
}

// ---- the fingerprint cache ------------------------------------------------------------------------------------------------------

/** `fp_cache_file` @param {Context} ctx */
export function cacheFile(ctx) { return `${ctx.sharedMain()}/.agents/local/fp-cache`; }

/** Seconds.nanoseconds with nine digits, the form `stat -c %.9Y` and `stat -f %Fm` print. @param {bigint} ns */
function secNs(ns) { return `${ns / 1000000000n}.${String(ns % 1000000000n).padStart(9, '0')}`; }

/**
 * `fp_cache_key FILE PATH`: "path|size|mtime_ns|inode|ctime_ns" of a file of at least fingerprint.cache_min_bytes (default 262144), else null.
 * @param {Context} ctx @param {string} target @param {string} rel
 */
export function cacheKey(ctx, target, rel) {
  let min = ctx.config().get('fingerprint.cache_min_bytes', '262144');
  if (!/^[0-9]+$/.test(min)) min = '262144';
  let st;
  try { st = statSync(target, { bigint: true }); } catch { return null; }
  if (st.size < BigInt(min)) return null;
  return `${rel}|${st.size}|${secNs(st.mtimeNs)}|${st.ino}|${secNs(st.ctimeNs)}`;
}

/** `fp_cache_get KEY`: the last entry of that key, when it is a 64 hex digest. @param {Context} ctx @param {string} key */
export function cacheGet(ctx, key) {
  const lines = fileLines(ctx, cacheFile(ctx));
  let h = '';
  for (const l of lines) {
    const t = l.indexOf('\t');
    if (t < 0) { if (l === key) h = ''; continue; }
    if (l.slice(0, t) === key) h = l.slice(t + 1).split('\t')[0];
  }
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

/** `fp_cache_put KEY HASH`: append, and cut the file to its last 1000 lines when it passed 4000. @param {Context} ctx @param {string} key @param {string} hash */
export function cachePut(ctx, key, hash) {
  const file = cacheFile(ctx);
  try { mkdirSync(path.dirname(file), { recursive: true }); } catch { return; }
  try {
    if (isFile(file)) {
      const text = readFileSync(file, 'latin1');
      const lines = text.split('\n');
      const count = lines.length - 1;
      if (count > 4000) {
        const keep = lines.slice(0, -1).slice(-1000).join('\n') + '\n';
        writeFileSync(`${file}.t`, Buffer.from(keep, 'latin1'));
        renameSync(`${file}.t`, file);
      }
    }
    appendFileSync(file, Buffer.from(`${key}\t${hash}\n`, 'latin1'));
  } catch { /* a speed-up only */ }
  ctx.forget(`file:${file}`); ctx.forget(`file:lines:${file}`);
}

// ---- path fingerprints ----------------------------------------------------------------------------------------------------------

/**
 * `fingerprint_path PATH`: the SHA-256 of a regular file, `missing` for no file; a symlink or a non-regular file fails.
 * fp_fast: ctx.fpMode 'yes' reads the cache, 'refresh' hashes and stores, 'no' always hashes.
 * @param {Context} ctx @param {string} rel
 */
export function pathFingerprint(ctx, rel) {
  const target = `${ctx.root}/${rel}`;
  let l;
  try { l = lstatSync(target); } catch { return 'missing'; }
  if (l.isSymbolicLink()) {
    if (rel === 'AGENTS.md' || rel === 'CLAUDE.md') {
      fail(`cannot baseline symlink: ${rel}. A symlinked ${rel} is a product change (project rules every agent reads): replace the symlink with a regular file holding only the proofline block, or name ${rel} in the plan scope (amendment and refreeze).`);
    }
    fail(`cannot baseline symlink: ${rel}`);
  }
  if (l.isFile()) {
    if (ctx.fpMode === 'yes' || ctx.fpMode === 'refresh') {
      const k = cacheKey(ctx, target, rel);
      if (k !== null) {
        if (ctx.fpMode === 'yes') { const c = cacheGet(ctx, k); if (c !== '') return c; }
        const h = hashFile(target);
        cachePut(ctx, k, h);
        return h;
      }
    }
    return hashFile(target);
  }
  return fail(`cannot baseline non-regular file: ${rel}`);
}

// ---- the baseline ---------------------------------------------------------------------------------------------------------------

/**
 * `baseline_entries`: [type, path, hash] of the `baseline:` block of RUN.yaml, in order, up to the first malformed entry.
 * @param {Context} ctx @param {string} dir @returns {Array<[string, string, string]>}
 */
export function baselineEntries(ctx, dir) {
  const lines = fileLines(ctx, `${dir}/RUN.yaml`);
  /** @type {Array<[string, string, string]>} */ const out = [];
  let inside = false;
  let type = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inside) { if (l === 'baseline:') inside = true; continue; }
    if (/^[^ \t\n\v\f\r]/.test(l)) break;
    const t = /^ {2}(tracked|untracked):$/.exec(l);
    if (t) { type = t[1]; continue; }
    if (l.startsWith('    - path: ')) {
      const p = l.slice('    - path: '.length);
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('      sha256: ')) break;
      i++;
      out.push([type, p, next.slice('      sha256: '.length).replace(/"/g, '')]);
    }
  }
  return out;
}

/**
 * ONE map of the baseline per invocation: "type|path" -> hash (the first entry of a pair wins). `read` with IFS='|' splits at the first
 * two bars, so the key is built the same way.
 * @param {Context} ctx @param {string} dir @returns {Map<string, string>}
 */
export function baselineMap(ctx, dir) {
  return ctx.once(`baseline:${dir}`, () => {
    /** @type {Map<string, string>} */ const m = new Map();
    for (const [type, p, hash] of baselineEntries(ctx, dir)) {
      const row = `${type}|${p}|${hash}`;
      const a = row.indexOf('|');
      const b = row.indexOf('|', a + 1);
      const key = `${row.slice(0, a)}|${row.slice(a + 1, b)}`;
      if (!m.has(key)) m.set(key, row.slice(b + 1));
    }
    return m;
  });
}

/** `baseline_fingerprint TYPE PATH DIR`: the recorded hash or ''. @param {Context} ctx @param {string} type @param {string} p @param {string} dir */
export function baselineFingerprint(ctx, type, p, dir) { return baselineMap(ctx, dir).get(`${type}|${p}`) ?? ''; }

// ---- the content fingerprint ----------------------------------------------------------------------------------------------------

/**
 * The paths a run's plan scope names, over every run's PLAN.md: all of them (cf_named) and the ones kept in the tree (cf_keep).
 * @param {Context} ctx
 */
function namedPaths(ctx) {
  const td = ctx.config().get('tasks.dir', '.agents/tasks');
  /** @type {string[]} */ const named = [];
  /** @type {string[]} */ const keep = [];
  let runs = [];
  try { runs = readdirSync(`${ctx.root}/.agents/runs`).sort(); } catch { /* none */ }
  for (const r of runs) {
    const dir = `${ctx.root}/.agents/runs/${r}`;
    if (!isFile(`${dir}/PLAN.md`)) continue;
    for (const p of words(scopePaths(planScope(ctx, dir).rows).join('\n'))) {
      named.push(p);
      if (p.startsWith('.agents/runs/') || p.startsWith('.agents/local/')) continue;
      if (!p.startsWith('.agents/')) continue;
      if (p === td || p.startsWith(`${td}/`)) continue;
      if (isFile(`${ctx.root}/${p}`)) keep.push(p);
    }
  }
  return { named, keep, td };
}

/** @param {string[]} a @param {number} n */
function chunks(a, n) { /** @type {string[][]} */ const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

/**
 * `content_fingerprint [MODE]`: the git tree id of the working tree including untracked files, without .agents/ (a path a plan scope
 * names stays), without the files upgrade installs and the proofline block of AGENTS.md/CLAUDE.md. MODE `gate` leaves out the knowledge
 * step's documents; `legacy` computes the value 0.0.12 and 0.0.13 recorded. Built in a private index; the real one is never touched.
 * @param {Context} ctx @param {string} [mode]
 */
export function contentFingerprint(ctx, mode = '') {
  const tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'proofline-fp.'));
  try {
    const { index, objects } = gitPaths(ctx);
    const { named, keep, td } = namedPaths(ctx);
    const kn = mode === 'gate' ? knowledgeScopeEntries(ctx) : [];
    /** @param {string} objDir @returns {string} */
    const attempt = (objDir) => {
      const idx = `${tmp}/index`;
      if (isFile(index)) copyFileSync(index, idx);
      /** @type {Record<string, string>} */ const env = { GIT_INDEX_FILE: idx };
      if (objDir !== '') { env.GIT_OBJECT_DIRECTORY = objDir; env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objects; }
      /** @param {string[]} a @param {string | Buffer} [input] */
      const g = (a, input) => git(ctx, a, { env, input });
      if (!isFile(idx)) g(['read-tree', 'HEAD']);
      if (g(['add', '-A', '--', '.', ':(exclude).agents']).status !== 0) return '';
      g(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.agents', td]);
      if (mode === 'gate') {
        const entries = kn.map((x) => x.replace(/\/$/, ''));
        if (entries.length > 0) {
          const ls = g(['ls-files', '-z', '--', ...words(entries.join('\n'))]);
          const list = ls.out.split('\0').filter((x) => x !== '' && /\.(md|json|ya?ml|txt)$/i.test(x));
          for (const c of chunks(list, 500)) g(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...c]);
        }
        const add = named.filter((n) => inKnowledgeScope(ctx, n) && isFile(`${ctx.root}/${n}`));
        if (add.length > 0 && g(['add', '-f', '--', ...add]).status !== 0) return '';
      }
      if (keep.length > 0 && g(['add', '-f', '--', ...keep]).status !== 0) return '';
      g(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.claude/agents/proofline-*.md', '.codex/agents/proofline-*.toml', ...installedControlPaths(ctx)]);
      const back = named.filter((n) => installedControlPath(ctx, n) && isFile(`${ctx.root}/${n}`));
      if (back.length > 0 && g(['add', '-f', '--', ...back]).status !== 0) return '';
      for (const b of ['AGENTS.md', 'CLAUDE.md']) {
        if (named.includes(b)) continue;
        const f = `${ctx.root}/${b}`;
        let l; try { l = lstatSync(f); } catch { continue; }
        if (!l.isFile()) continue;
        const text = fileText(ctx, f);
        if (text === null || !hasBlockMarkers(text)) continue;
        if (mode !== 'legacy' && blockOnlyText(text)) { g(['rm', '-q', '--cached', '--ignore-unmatch', '--', b]); continue; }
        const h = g(['hash-object', '-w', '--stdin'], Buffer.from(stripProoflineBlock(text), 'latin1'));
        const blob = h.out.replace(/\n+$/, '');
        if (h.status !== 0 || blob === '') return '';
        if (g(['update-index', '--add', '--cacheinfo', `100644,${blob},${b}`]).status !== 0) return '';
      }
      return g(['write-tree']).out.replace(/\n+$/, '');
    };
    let out = attempt('');
    if (out === '') {
      mkdirSync(`${tmp}/objects`, { recursive: true });
      out = attempt(`${tmp}/objects`);
    }
    if (out === '') fail('could not compute the content fingerprint');
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `gate_fingerprint`: the fingerprint gates, results and waivers bind (the knowledge step's files left out). Computed once per invocation;
 * a command that changes the tree calls ctx.forget('fp:') first.
 * @param {Context} ctx
 */
export function gateFingerprint(ctx) { return ctx.once('fp:gate', () => contentFingerprint(ctx, 'gate')); }

/** The content fingerprint without a mode, once per invocation. @param {Context} ctx */
export function fullFingerprint(ctx) { return ctx.once('fp:full', () => contentFingerprint(ctx, '')); }

/**
 * `legacy_fingerprint_match RECORDED` (A161): a record of 0.0.12/0.0.13 holds a tree in which a block-only AGENTS.md/CLAUDE.md is still
 * part of the tree; it is the current one iff the tree computed the old way equals it. Nothing is computed unless such a file exists.
 * @param {Context} ctx @param {string} recorded
 */
export function legacyFingerprintMatch(ctx, recorded) {
  let any = false;
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const abs = `${ctx.root}/${f}`;
    let l; try { l = lstatSync(abs); } catch { continue; }
    if (!l.isFile()) continue;
    const t = fileText(ctx, abs);
    if (t !== null && blockOnlyText(t)) any = true;
  }
  if (!any) return false;
  return ctx.once(`fp:legacy`, () => contentFingerprint(ctx, 'legacy')) === recorded;
}
