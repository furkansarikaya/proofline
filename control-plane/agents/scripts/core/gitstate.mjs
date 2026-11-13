// @ts-check
// `.git/config` and HEAD of a project, as one comparable string (A226): a dispatched step must change neither (hooksPath, branch, commits). The dispatcher takes it
// before and after every step. It is read from the files of the git folder (a linked worktree: its own folder and the common one), with no git process: two reads
// of the same files are equal exactly when the config bytes, the chain of symbolic refs HEAD follows and the commit at its end are. The chain is followed the way
// `git rev-parse HEAD` follows it (a branch file may itself hold `ref: refs/heads/other`), through loose files and `packed-refs`, at most 8 hops, cycle-safe.
// Every case the plain reading cannot settle (a cycle, too many hops, a ref file that is neither a commit nor a symbolic ref) FAILS CLOSED: the state then holds
// the raw bytes that were read, so any change to them is seen. A repository the files cannot be read in the plain way (the reftable format, an unreadable
// folder) is read with git itself, in the same shape.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as proc from './proc.mjs';
import { isLocalAbsolute } from './pathin.mjs';

const MAX_HOPS = 8;

/** @param {string} p @returns {string | null} */
function text(p) { try { return readFileSync(p, 'latin1'); } catch { return null; } }

/**
 * The git folder of a working tree and the common one (the same folder in the main tree), or null.
 * @param {string} root @returns {{ gitdir: string, common: string } | null}
 */
function gitDirs(root) {
  const dotgit = path.join(root, '.git');
  let st;
  try { st = lstatSync(dotgit); } catch { return null; }
  let gitdir = dotgit;
  if (st.isFile()) {
    const m = /^gitdir: (.*)$/m.exec(text(dotgit) ?? '');
    if (!m) return null;
    gitdir = path.resolve(root, m[1]);
  } else if (!st.isDirectory()) return null;
  let common = gitdir;
  const c = text(path.join(gitdir, 'commondir'));
  if (c !== null) common = path.resolve(gitdir, c.trim());
  return { gitdir, common };
}

/** What a ref holds: the raw text of its loose file, else the packed-refs entry (a commit), else null (it does not exist). @param {string} common @param {string} ref @returns {string | null} */
function refContent(common, ref) {
  if (ref.includes('..') || ref.startsWith('/')) return `unsafe:${ref}`;
  const loose = text(path.join(common, ref));
  if (loose !== null) return loose.trim();
  for (const l of (text(path.join(common, 'packed-refs')) ?? '').split('\n')) {
    const m = /^([0-9a-f]{40,64}) (.*)$/.exec(l);
    if (m && m[2] === ref) return m[1];
  }
  return null;
}

/**
 * Follow HEAD to the commit. `chain` is the symbolic refs passed on the way, `end` the commit, 'none' (a ref that does not exist yet: an unborn branch) or
 * `unresolved:<raw>` (a cycle, too many hops or a content that is no commit: the raw bytes, so that a change of them is a change of the state).
 * @param {string} common @param {string} headText @returns {{ chain: string[], end: string }}
 */
function follow(common, headText) {
  /** @type {string[]} */ const chain = [];
  let cur = headText.trim();
  for (let hops = 0; hops <= MAX_HOPS; hops++) {
    const sym = /^ref: (.*)$/.exec(cur);
    if (!sym) return { chain, end: /^[0-9a-f]{40,64}$/.test(cur) ? cur : `unresolved:${cur}` };
    const ref = sym[1].trim();
    if (chain.includes(ref)) return { chain, end: `unresolved:cycle at ${ref}` };
    chain.push(ref);
    const next = refContent(common, ref);
    if (next === null) return { chain, end: 'none' };
    cur = next;
  }
  return { chain, end: `unresolved:more than ${MAX_HOPS} hops (${chain.join('>')})` };
}

/**
 * The state of `.git/config` and HEAD: `<config digest>|<symbolic refs of HEAD's chain, or "detached">|<commit, "none" or "unresolved:...">`.
 * @param {string} root @param {NodeJS.ProcessEnv} env @returns {string}
 */
export function gitState(root, env) {
  const dirs = gitDirs(root);
  if (dirs !== null && !existsSync(path.join(dirs.common, 'reftable'))) {
    const head = text(path.join(dirs.gitdir, 'HEAD'));
    if (head !== null && (/^ref: /.test(head) || /^[0-9a-f]{40,64}\s*$/.test(head))) {
      let sum = 'none';
      try { sum = createHash('sha1').update(readFileSync(path.join(dirs.common, 'config'))).digest('hex'); } catch { sum = 'none'; }
      const f = follow(dirs.common, head);
      return `${sum}|${f.chain.length === 0 ? 'detached' : f.chain.join('>')}|${f.end}`;
    }
  }
  // not readable in the plain way: git itself
  const git = (/** @type {string[]} */ args) => proc.run('git', ['-C', root, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const c = git(['rev-parse', '--git-path', 'config']);
  if (c.status !== 0) return 'none';
  let cfgPath = c.stdout.toString('utf8').replace(/\n$/, '');
  if (!isLocalAbsolute(cfgPath)) cfgPath = path.join(root, cfgPath);
  let sum = 'none';
  try { sum = createHash('sha1').update(readFileSync(cfgPath)).digest('hex'); } catch { sum = 'none'; }
  const sym = git(['symbolic-ref', '-q', 'HEAD']);
  const head = git(['rev-parse', '-q', '--verify', 'HEAD']);
  return `${sum}|${sym.status === 0 ? sym.stdout.toString('latin1').replace(/\n$/, '') : 'detached'}|${head.status === 0 ? head.stdout.toString('latin1').replace(/\n$/, '') : 'none'}`;
}
