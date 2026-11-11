// @ts-check
// Static guard for A248 (round 7, Part of #165): no source of the control plane starts a RAW git that reads the index or the work tree. Those commands (`ls-files`,
// `check-ignore`, `status`, `diff`, `add`, `checkout`, `reset`, `worktree add`, ...) can start a program the repository's configuration names (`core.fsmonitor`) or a
// filter, so they go through `hgit()` or `git()` (hgit.mjs, git.mjs), which blank both. A raw spawn is allowed for a command that reads refs, objects or configuration
// only (ALLOWED below). The scan reads text; it starts no process. A new exception needs an entry with its reason, here, and a line in decision A248.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { listable } from '../../control-plane/agents/scripts/core/kirules.mjs';
import { git, makeFixture } from './fixture.mjs';
import { repo } from './helpers.mjs';

const CORE = path.join(repo, 'control-plane/agents/scripts/core');
/** The files that ARE the hermetic helpers: they start git on purpose and add the blanking. */
const HELPERS = new Set(['hgit.mjs', 'git.mjs']);

/** Subcommands that read refs, objects or configuration only: they open no index and no work tree file, so no fsmonitor program and no filter can start. */
export const ALLOWED = new Set([
  'rev-parse', 'cat-file', 'rev-list', 'show-ref', 'symbolic-ref', 'for-each-ref', 'merge-base', 'ls-remote', 'config', 'ls-tree', 'log', 'diff-tree', 'branch', 'remote', 'var',
  'pack-objects', 'worktree', // `worktree` only with `list` as its first argument (checked below)
]);
/** What makes `log` and `diff-tree` read file content (a patch, a stat: textconv, external diff, the work tree): refused in a raw call. */
const CONTENT_FLAGS = /^(-p|-u|--patch|--stat|--numstat|--shortstat|--dirstat|--raw|-U\d*|--textconv|--ext-diff|--cc|-c|-m|--follow)$/;
/** Subcommands that read or write the index or the work tree, found anywhere in a `proc.run(` call (a spawn whose binary is not named literally). */
const DENY = ['ls-files', 'check-ignore', 'status', 'diff', 'diff-index', 'diff-files', 'add', 'update-index', 'read-tree', 'checkout', 'checkout-index', 'reset', 'stash', 'rm', 'mv', 'clean', 'grep', 'merge', 'switch', 'restore', 'commit', 'apply', 'write-tree', 'submodule'];

/** Whole files outside the guard, each with the reason (A248 (d)). */
export const EXCEPT_FILES = /** @type {Record<string, string>} */ ({
  'githooks.mjs': 'runs inside the user\'s own `git commit` or `git push`, where the repository\'s configuration is already running (A211/A217/A218)',
  'buildrecord.mjs': 'the build record key and its export need the repository\'s own clean and smudge filters (A248 round 6); it passes core.fsmonitor=false itself (round 7)',
});
/** Single subcommands allowed in one file, each with the reason. */
export const EXCEPT_SUBS = /** @type {Record<string, Record<string, string>>} */ ({
  'deliver.mjs': {
    init: 'a bare scratch repository the proof fetch makes in its own temporary folder, `--template=`',
    push: 'the delivery\'s own push of the proven tip with `core.hooksPath=/dev/null`: a remote operation, no index and no work tree',
    'update-ref': 'in the private bare proof repository (`--git-dir` a temporary folder, global and system configuration nulled): no index, no work tree',
    fetch: 'the hermetic fetch into that private bare proof repository (the project itself stays transport-free, A248 S3)',
  },
  'doctor.mjs': {
    init: 'the probe repositories in doctor\'s own temporary folder, with a cleaned environment',
    commit: 'the probe commit in that scratch repository: it exists to run the project\'s hook',
    push: 'the probe push from that scratch repository to its own bare remote',
  },
  'proflinecli.mjs': { status: 'the local `git` wrapper sends `status` to hgit (the `a[0] === \'status\'` branch); the other subcommands are refs only' },
});
/** The local functions (per file) that forward their argument list to a raw git spawn: their calls are checked too. Regular expression sources. */
export const WRAPPERS = /** @type {Record<string, string[]>} */ ({
  'merge.mjs': ['gitOut'],
  'gitstate.mjs': ['git'],
  'install.mjs': ['g', 'this\\.git'],
  'doctor.mjs': ['git', 'this\\.gitOut', 'pg', 'init'],
  'platform.mjs': ['g'],
  'dispatcher.mjs': ['git'],
  'proflinecli.mjs': ['git'],
  'worktree.mjs': ['git'],
  'deliver.mjs': ['gp'],
});

/** Index of the end of the string, template or comment-free literal that starts at I (a quote), or -1. @param {string} s @param {number} i */
function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') { j = skipBalanced(s, j + 1) - 1; continue; }
    if (s[j] === q) return j + 1;
  }
  return -1;
}
/** Index just after the bracket group that opens at I. @param {string} s @param {number} i */
function skipBalanced(s, i) {
  const pairs = /** @type {Record<string, string>} */ ({ '(': ')', '[': ']', '{': '}' });
  const stack = [pairs[s[i]]];
  let j = i + 1;
  while (j < s.length && stack.length > 0) {
    const c = s[j];
    if (c === '\'' || c === '"' || c === '`') { const e = skipString(s, j); if (e < 0) return s.length; j = e; continue; }
    if (c in pairs) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    j++;
  }
  return j;
}
/** The top level elements of the array or argument list whose opening bracket is at I (text of each, trimmed). @param {string} s @param {number} i */
function elements(s, i) {
  const end = skipBalanced(s, i) - 1;
  /** @type {string[]} */ const out = [];
  let start = i + 1; let j = i + 1;
  while (j < end) {
    const c = s[j];
    if (c === '\'' || c === '"' || c === '`') { j = skipString(s, j); continue; }
    if (c === '(' || c === '[' || c === '{') { j = skipBalanced(s, j); continue; }
    if (c === ',') { out.push(s.slice(start, j).trim()); start = j + 1; }
    j++;
  }
  const last = s.slice(start, end).trim();
  if (last !== '') out.push(last);
  return out;
}
const lit = (/** @type {string} */ e) => { const m = /^'([^'\\]*)'$|^"([^"\\]*)"$/.exec(e); return m === null ? null : (m[1] ?? m[2] ?? ''); };

/**
 * The git subcommand of an argument list: leading options (and the value of `-C`, `-c`, `--git-dir`, `--work-tree`) are skipped. null when it is not a literal (a spread or a variable).
 * @param {string[]} els @returns {{ sub: string, rest: string[] } | null}
 */
export function subcommand(els) {
  let k = 0;
  while (k < els.length) {
    const l = lit(els[k]);
    if (l === null) return null;
    if (l === '-C' || l === '-c' || l === '--git-dir' || l === '--work-tree') { k += 2; continue; }
    if (l.startsWith('-')) { k++; continue; }
    return { sub: l, rest: els.slice(k + 1) };
  }
  return null;
}

/**
 * Every raw git call of one source: its subcommand (or '?' when the list is not literal, `dyn` true), its line, and the wrapper calls. Comments are not removed: a line comment that
 * looks like a call is a false alarm that shows up as a failure with its line, which is the safe direction.
 * @param {string} src @param {string[]} wrappers @returns {Array<{ sub: string, rest: string[], line: number, dyn: boolean, via: string }>}
 */
export function rawGitCalls(src, wrappers) {
  /** @type {Array<{ sub: string, rest: string[], line: number, dyn: boolean, via: string }>} */ const out = [];
  const lineOf = (/** @type {number} */ i) => src.slice(0, i).split('\n').length;
  const add = (/** @type {number} */ at, /** @type {string[]} */ els, /** @type {string} */ via, /** @type {boolean} */ spawn) => {
    const sc = subcommand(els);
    if (sc === null) out.push({ sub: '?', rest: [], line: lineOf(at), dyn: spawn, via });
    else out.push({ sub: sc.sub, rest: sc.rest, line: lineOf(at), dyn: false, via });
  };
  // 1. a spawn that names git (a literal or a binary variable of the delivery) and has a literal list
  for (const m of src.matchAll(/proc\.run\(\s*(?:'git'|"git"|gitBin|gitPath|gtp\.path|gt\.path)\s*,\s*(\[)?/g)) {
    const at = m.index ?? 0;
    if (m[1] === undefined) out.push({ sub: '?', rest: [], line: lineOf(at), dyn: true, via: 'proc.run' }); // the list is a variable
    else add(at, elements(src, at + m[0].length - 1), 'proc.run', true);
  }
  // 2. a spawn whose binary is another variable: any denied subcommand literal inside the call is a raw index or work tree reader
  for (const m of src.matchAll(/proc\.run\(/g)) {
    const at = m.index ?? 0;
    const body = src.slice(at, skipBalanced(src, at + m[0].length - 1));
    if (/^proc\.run\(\s*(?:'git'|"git"|gitBin|gitPath|gtp\.path|gt\.path)\s*,\s*\[/.test(body)) continue;
    if (/^proc\.run\(\s*['"]/.test(body)) continue; // another program named in the source (grep, sh, gh, node): not git
    for (const d of DENY) if (new RegExp(`['"]${d}['"]`).test(body)) out.push({ sub: d, rest: [], line: lineOf(at), dyn: false, via: 'proc.run(<binary variable>)' });
  }
  // 3. the calls of the local functions that forward their list to a raw spawn
  for (const w of wrappers) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.])${w}\\(\\s*(?:ctx\\s*,\\s*)?\\[`, 'g'))) {
      const at = m.index ?? 0;
      add(at, elements(src, at + m[0].length - 1), w.replace(/\\/g, ''), false);
    }
  }
  return out;
}

/** The problems of one call, or ''. @param {string} file @param {{ sub: string, rest: string[], via: string }} c */
export function problem(file, c) {
  if (c.sub === '?') return '';
  if (EXCEPT_SUBS[file]?.[c.sub] !== undefined) return '';
  if (!ALLOWED.has(c.sub)) return `raw git ${c.sub} (${c.via})`;
  if (c.sub === 'worktree' && lit(c.rest[0] ?? '') !== 'list') return `raw git worktree ${lit(c.rest[0] ?? '') ?? '<not literal>'} (${c.via}): only \`worktree list\` may be raw`;
  if ((c.sub === 'log' || c.sub === 'diff-tree') && c.rest.some((e) => { const l = lit(e); return l !== null && CONTENT_FLAGS.test(l); })) return `raw git ${c.sub} with a content flag (${c.via})`;
  return '';
}

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p)); else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out.sort();
}

test('A248 guard: no raw git in the control plane reads the index or the work tree (only refs, objects and configuration readers are raw; the rest goes through hgit/git)', () => {
  /** @type {string[]} */ const bad = [];
  /** @type {Set<string>} */ const usedExceptions = new Set();
  /** @type {Set<string>} */ const usedWrappers = new Set();
  const files = sources(CORE);
  assert.ok(files.length > 50, 'the scan found the control plane sources');
  for (const f of files) {
    const base = path.basename(f);
    if (HELPERS.has(base)) continue;
    const src = readFileSync(f, 'utf8');
    if (/child_process/.test(src) && base !== 'proc.mjs') bad.push(`${base}: starts processes without proc.mjs (the guard cannot see what it runs)`);
    const wr = WRAPPERS[base] ?? [];
    const calls = rawGitCalls(src, wr);
    if (EXCEPT_FILES[base] !== undefined) { if (calls.length > 0) usedExceptions.add(base); continue; }
    const dynamicSpawn = calls.some((c) => c.dyn);
    if (dynamicSpawn && wr.length === 0) bad.push(`${base}: a raw git spawn with a list that is not literal, and no wrapper is registered for the file`);
    for (const c of calls) {
      if (c.via !== 'proc.run' && c.via !== 'proc.run(<binary variable>)') usedWrappers.add(`${base}:${c.via}`);
      if (c.sub === '?') { if (!c.dyn) bad.push(`${base}:${c.line}: a call of ${c.via} whose subcommand is not a literal`); continue; }
      const p = problem(base, c);
      if (p !== '') bad.push(`${base}:${c.line}: ${p}`);
      else if (EXCEPT_SUBS[base]?.[c.sub] !== undefined) usedExceptions.add(`${base}:${c.sub}`);
    }
  }
  for (const [f, subs] of Object.entries(EXCEPT_SUBS)) for (const s of Object.keys(subs)) if (!usedExceptions.has(`${f}:${s}`)) bad.push(`stale exception ${f}:${s} (nothing uses it)`);
  for (const f of Object.keys(EXCEPT_FILES)) if (!usedExceptions.has(f)) bad.push(`stale file exception ${f} (it spawns no git)`);
  for (const [f, ws] of Object.entries(WRAPPERS)) for (const w of ws) if (![...usedWrappers].some((u) => u.startsWith(`${f}:`) && u.slice(f.length + 1) === w.replace(/\\/g, ''))) bad.push(`stale wrapper ${f}:${w} (no call of it found)`);
  assert.deepEqual(bad, [], `index or work tree readers must go through hgit()/git() (hgit.mjs, git.mjs), or be listed with a reason:\n${bad.join('\n')}`);
});

test('A248 guard (scanner): a raw ls-files, check-ignore, status, a spread list, a wrapper call and a binary variable are all found; refs readers and the helpers pass', () => {
  const probs = (/** @type {string} */ src, /** @type {string[]} */ w = []) => rawGitCalls(src, w).map((c) => problem('x.mjs', c)).filter((p) => p !== '');
  assert.deepEqual(rawGitCalls("const h = (a) => proc.run('git', ['-C', r, ...a], {});", []).map((c) => [c.sub, c.dyn]), [['?', true]], 'a spawn with a spread list is reported as dynamic (the file then needs a registered wrapper)');
  assert.deepEqual(probs("proc.run('git', ['-C', root, 'ls-files', '--', p], {})"), ['raw git ls-files (proc.run)']);
  assert.deepEqual(probs("proc.run('git', ['-c', 'a=b', '-C', `${a}/x`, '--no-optional-locks', 'check-ignore', '-q'], {})"), ['raw git check-ignore (proc.run)']);
  assert.deepEqual(probs("proc.run(gitBin, ['--no-replace-objects', '--git-dir', tmp, 'status'], {})"), ['raw git status (proc.run)']);
  assert.deepEqual(probs("proc.run(tool, ['ls-files', 'x'], {})"), ['raw git ls-files (proc.run(<binary variable>))']);
  assert.deepEqual(probs("const git = (a) => proc.run('git', ['-C', r, ...a], {}); git(['add', '-A']); git(['rev-parse', 'HEAD']);", ['git']), ['raw git add (git)']);
  assert.deepEqual(probs("g(ctx, ['status'], main)", ['g']), ['raw git status (g)']);
  assert.deepEqual(probs("this.git(['diff', '--cached'])", ['this\\.git']), ['raw git diff (this.git)']);
  assert.deepEqual(probs("proc.run('git', ['worktree', 'add', d], {})"), ['raw git worktree add (proc.run): only `worktree list` may be raw']);
  assert.deepEqual(probs("proc.run('git', ['log', '-p', 'HEAD'], {})"), ['raw git log with a content flag (proc.run)']);
  assert.deepEqual(probs("proc.run('git', ['diff-tree', '-r', '--name-only', a, b], {})"), []);
  assert.deepEqual(probs("proc.run('git', ['-C', r, 'worktree', 'list', '--porcelain'], {}); proc.run('git', ['cat-file', '-e', `${s}^{commit}`], {}); proc.run('git', ['config', k], {})"), []);
  // a string that holds brackets, commas and quotes does not confuse the list reader
  assert.deepEqual(rawGitCalls("proc.run('git', ['-C', kiPlaces(ctx, [1, 2]).main, 'ls-files'], {})", []).map((c) => c.sub), ['ls-files']);
});

test('A248 round 7: a known-issue place check (kirules listable, ls-files --error-unmatch) never runs the repository\'s core.fsmonitor program', () => {
  const fx = makeFixture();
  const mark = `${fx.root}-FSM`; const prog = `${fx.root}-fsm.sh`;
  writeFileSync(prog, `#!/bin/sh\ntouch ${mark}\nprintf '\\0'\n`);
  chmodSync(prog, 0o755);
  git(fx.root, ['config', 'core.fsmonitor', prog]);
  git(fx.root, ['ls-files', '--error-unmatch', '--', 'README.md']);
  assert.ok(existsSync(mark), 'test premise: plain ls-files runs the core.fsmonitor program');
  rmSync(mark, { force: true });
  const ctx = fx.ctx();
  assert.equal(listable(ctx, 'QUALITY', 'README.md'), null, 'a tracked file is listable');
  assert.ok(listable(ctx, 'QUALITY', 'nope.txt')?.includes('not a tracked file'), 'an untracked one is not');
  assert.ok(!existsSync(mark), 'listable ran the core.fsmonitor program of the repository configuration');
  rmSync(prog, { force: true }); rmSync(mark, { force: true });
});
