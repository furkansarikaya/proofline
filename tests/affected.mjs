// @ts-check
// Selects, and by default runs, the self-test units affected by a change (A164).
// Usage: node tests/affected.mjs [--list] [--all] [FILE...]   (no FILE: git changes vs the base branch; "-": paths on stdin)
// Units are suites (control-plane/agents/scripts/*-test.sh, tests/*/*-test.sh) and node files (tests/*/*.test.mjs).
// The mapping (tests/affected-map.txt) only decides what can be safely skipped: a changed file that is not
// mapped, or is shared, selects every unit. Documentation-only changes (tests/ci/classify.mjs) select only
// the front matter and link test. --list prints the units, one per line; otherwise they run quietly.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify } from './ci/classify.mjs';

const here = import.meta.dirname;
const defaultRoot = path.resolve(here, '..');

/** Byte-order comparison. @param {string} a @param {string} b */
const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every unit as a repository-relative path, in `ls` order. @param {string} root */
export function allUnits(root) {
  /** @type {string[]} */ const out = [];
  const take = (/** @type {string} */ rel, /** @type {(n: string) => boolean} */ ok) => {
    const dir = path.join(root, rel);
    if (existsSync(dir)) for (const n of readdirSync(dir)) if (ok(n)) out.push(`${rel}/${n}`);
  };
  take('control-plane/agents/scripts', (n) => n.endsWith('-test.sh'));
  const t = path.join(root, 'tests');
  for (const d of readdirSync(t, { withFileTypes: true }).filter((e) => e.isDirectory())) take(`tests/${d.name}`, (n) => n.endsWith('-test.sh') || n.endsWith('.test.mjs'));
  return out.sort(byBytes);
}

/** A shell `case` glob (`*` crosses `/`, `?`, `[...]`) as a regular expression. @param {string} g */
export function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') { const j = g.indexOf(']', i + 2); if (j < 0) re += '\\['; else { re += g.slice(i, j + 1).replace(/^\[!/, '[^'); i = j; } }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}

/**
 * The units a set of changed files selects.
 * @param {{ files: string[], all?: boolean, units: string[], mapText: string, exists?: (f: string) => boolean }} o
 * @returns {string[]} sorted, unique
 */
export function select({ files, all = false, units, mapText, exists = () => false }) {
  const nameOf = (/** @type {string} */ u) => path.basename(u, '.sh');
  /** @type {Array<{ re: RegExp, names: string[] }>} */
  const map = [];
  for (const line of mapText.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const w = line.trim().split(/\s+/);
    if (w[0]) map.push({ re: globToRegExp(w[0]), names: w.slice(1) });
  }
  const list = files.filter((f) => f !== '');
  /** @type {Set<string>} */ const selected = new Set();
  if (all) return [...units].sort(byBytes);
  if (list.length > 0 && classify(list) === 'code=false') return ['tests/skills/frontmatter.test.mjs'];
  const unitSet = new Set(units);
  for (const f of list) {
    if (f.endsWith('-test.sh') || f.endsWith('.test.mjs')) {
      if (unitSet.has(f)) selected.add(f); else if (exists(f)) return [...units].sort(byBytes);
      continue;
    }
    let hit = false; let bad = false;
    for (const { re, names } of map) {
      if (!re.test(f)) continue;
      hit = true;
      for (const n of names) {
        const u = units.find((x) => nameOf(x) === n);
        if (u) selected.add(u); else bad = true;
      }
    }
    // unmapped, or a mapped unit that does not exist: uncertain, so everything
    if (!hit || bad) return [...units].sort(byBytes);
  }
  return [...selected].sort(byBytes);
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** The changed files against the base branch (or HEAD, or null when there is nothing to compare against). @param {string} root */
function changedFiles(root) {
  let base = '';
  for (const r of ['origin/main', 'main']) { const b = git(root, ['merge-base', 'HEAD', r])?.trim(); if (b) { base = b; break; } }
  const withHead = (/** @type {string} */ ref) => {
    const diff = git(root, ['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--no-renames', ref]) ?? '';
    const untracked = git(root, ['-c', 'core.quotepath=false', 'ls-files', '-z', '-o', '--exclude-standard']) ?? '';
    return `${diff}${untracked}`.split('\0').filter((x) => x !== '');
  };
  if (base) return withHead(base);
  if (git(root, ['rev-parse', '-q', '--verify', 'HEAD']) !== null) return withHead('HEAD');
  return null;
}

/** @param {string[]} argv @param {{ root?: string, env?: NodeJS.ProcessEnv, stdin?: () => string, write?: (s: string) => void }} [o] @returns {number} */
export function main(argv, o = {}) {
  const root = o.root ?? defaultRoot; const env = o.env ?? process.env;
  const write = o.write ?? ((s) => process.stdout.write(s));
  let mode = 'run'; let all = false; /** @type {string[]} */ let files = [];
  for (const a of argv) {
    if (a === '--list') mode = 'list';
    else if (a === '--all') all = true;
    else if (a === '-') files = [...files, ...(o.stdin ?? (() => readFileSync(0, 'utf8')))().split('\n')];
    else if (a.startsWith('-')) { console.error(`affected: unknown option ${a}`); return 2; }
    else files.push(a);
  }
  files = files.filter((f) => f !== '');
  if (files.length === 0 && !all) {
    const c = changedFiles(root);
    if (c === null) all = true; /* no history to compare against: uncertain, so everything */ else files = c;
  }
  const mapFile = env.AFFECTED_MAP || path.join(here, 'affected-map.txt');
  const selected = select({ files, all, units: allUnits(root), mapText: readFileSync(mapFile, 'utf8'), exists: (f) => existsSync(path.join(root, f)) });

  if (mode === 'list') { if (selected.length) write(`${selected.join('\n')}\n`); return 0; }
  if (selected.length === 0) { write('affected: nothing to run\n'); return 0; }
  const nice = !env.CI && process.platform !== 'win32' && spawnSync('nice', ['true'], { stdio: 'ignore' }).status === 0;   // local runs stay low priority
  let failed = 0;
  for (const u of selected) {
    const [cmd, args] = u.endsWith('.mjs') ? ['node', ['--test', u]] : ['node', [path.join(here, 'selftest.mjs')]];
    const r = nice ? spawnSync('nice', ['-n', '10', cmd, ...args], runOpts(root, u, env)) : spawnSync(cmd, args, runOpts(root, u, env));
    if (r.status !== 0) {
      failed++; write(`FAIL ${u}\n`);
      const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n'); if (lines.at(-1) === '') lines.pop();
      write(lines.slice(-30).map((l) => `${l}\n`).join(''));
    }
  }
  write(failed === 0 ? `affected: ${selected.length} units passed\n` : `affected: ${failed} of ${selected.length} units failed\n`);
  return failed === 0 ? 0 : 1;
}
/** @param {string} root @param {string} u @param {NodeJS.ProcessEnv} env */
const runOpts = (root, u, env) => ({ cwd: root, encoding: /** @type {const} */ ('utf8'), maxBuffer: 1 << 28, env: u.endsWith('.mjs') ? env : { ...env, SELFTEST_ONLY: path.basename(u, '.sh') } });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
