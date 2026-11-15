// @ts-check
// How the file system under a path compares names (A278, issue #264 AC-5 and AC-6). A guard that compares path strings is bypassed by letter case
// on a case-insensitive volume (`.AGENTS/local/x` is `.agents/local/x`, `Agent.SH` runs agent.sh) and over-refuses on a case-sensitive one if it folds
// blindly. The answer comes from the volume itself, never from the platform name: one probe, on the nearest EXISTING directory of the path being judged.
//
//   insensitiveAt(path)      true when names under the nearest existing directory of PATH compare without regard to case. Fails CLOSED: a probe that
//                            cannot decide (an empty directory with no sibling to flip, an error, an unreadable volume) answers true (more refusals, never fewer).
//   provenInsensitiveAt(p)   the same question for a rule that ALLOWS by a name: true only when the probe decided it (an undecided probe never allows more)
//   fold(text)               the comparison spelling of a name: Unicode NFC, then lower case. Used only to compare, never to touch the file system.
//   same(a, b, ci)           a and b are one path under the rule CI (NFC always; case folded when CI)
//   under(root, p, ci)       p is root or below it, under the same rule
//   createFsCase({ probe })  an instance with its own cache; the tests inject a probe (a fake volume) and install it with useFsCase()
//
// THE PROBE (create-free, no process, nothing written): list the directory, take the first entry whose name has a letter, `lstat` it and `lstat` the
// same name with every letter's case flipped. The same device and inode: the volume folds case. ENOENT: it does not. Both entries existing with different
// inodes (`a` and `A`): it does not. No entry with a letter (an empty directory, `123`): the directory's own name is flipped in its parent instead (this
// answers for the parent, an accepted approximation; a per-directory flag on an empty directory is the one thing this cannot see, and it fails closed
// only when even that cannot decide).
//
// THE CACHE KEY is the directory's identity, `st_dev:st_ino`, not the project root and not the path text: a case-sensitive volume mounted inside a case-insensitive
// tree has another st_dev, and a per-directory case-fold flag (ext4 casefold, ZFS, a macOS folder on a case-sensitive volume) has another inode, so each gets its own
// probe and a path text that names another directory later never reuses a stale answer. Only a decided answer is cached; an undecided one is asked again.
//
// UNICODE. APFS and HFS+ also treat NFC and NFD spellings as one name. A protected name is ASCII, and the only non-ASCII code points whose normal form is ASCII
// are singletons such as U+212A (Kelvin sign, NFC is `K`). So the fold applies NFC to both sides always (a path spelled with a different normalization form
// cannot slip past a protected name, whatever the volume does) and lower-cases only when the volume folds case. This is the conservative fold; no per-volume
// normalization probe is needed because on a volume that keeps NFC and NFD apart the NFC form of an exotic spelling is still not any protected name.
import { lstatSync, opendirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isWin } from './text.mjs';

/** @typedef {(dir: string) => (boolean | undefined)} Probe true: the directory folds case; false: it does not; undefined: cannot tell */

/** Swap the case of every letter. @param {string} name */
function flip(name) { return [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join(''); }

/** The real probe (see the header). @type {Probe} */
export function realProbe(dir) {
  /** @param {string} parent @param {string} name @returns {boolean | undefined} */
  const via = (parent, name) => {
    const other = flip(name);
    if (other === name) return undefined;
    let a;
    try { a = lstatSync(path.join(parent, name)); } catch { return undefined; }
    try {
      const b = lstatSync(path.join(parent, other));
      return a.dev === b.dev && a.ino === b.ino;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? false : undefined;
    }
  };
  let d;
  try { d = opendirSync(dir); } catch { return undefined; }
  try {
    for (let i = 0; i < 64; i++) {
      const e = d.readSync();
      if (!e) break;
      const r = via(dir, e.name);
      if (r !== undefined) return r;
    }
  } catch { /* fall through to the directory's own name */ } finally { try { d.closeSync(); } catch { /* closed */ } }
  const parent = path.dirname(dir);
  return parent === dir ? undefined : via(parent, path.basename(dir));
}

/** The nearest existing directory at or above P, with its identity key; null when none can be statted. @param {string} p */
function nearestDir(p) {
  let d = p;
  for (let i = 0; i < 4096; i++) {
    try {
      const st = statSync(d);
      if (st.isDirectory()) return { dir: d, key: `${st.dev}:${st.ino}` };
    } catch { /* not there: go up */ }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** @param {{ probe?: Probe }} [opt] */
export function createFsCase(opt = {}) {
  const probe = opt.probe ?? realProbe;
  /** @type {Map<string, boolean>} */ const cache = new Map();
  let probes = 0;
  return {
    /** true / false when the volume under P was probed, undefined when it cannot be told. @param {string} p an absolute path, existing or not */
    decide(p) {
      if (isWin()) return true; // NTFS and the Windows rules of A271: case-insensitive by definition there
      const n = nearestDir(p.startsWith('/') ? p : path.resolve(p));
      if (!n) return undefined;
      const hit = cache.get(n.key);
      if (hit !== undefined) return hit;
      let v;
      try { probes++; v = probe(n.dir); } catch { v = undefined; }
      if (v !== undefined) cache.set(n.key, v);
      return v;
    },
    /** how many times the probe ran (the tests assert the cache) */
    get probes() { return probes; },
  };
}

/** @type {ReturnType<typeof createFsCase>} */
let current = createFsCase();
/** Install an instance (a test's fake volume); returns the previous one. @param {ReturnType<typeof createFsCase>} inst */
export function useFsCase(inst) { const prev = current; current = inst; return prev; }

/** For a rule that REFUSES by a protected name: an undecided probe counts as case-insensitive (more refusals, never fewer). @param {string} p */
export function insensitiveAt(p) { return current.decide(p) !== false; }
/** For a rule that ALLOWS by a name (inside the project, a registered worktree, the runtime's own storage): case is folded only when the probe proved it. @param {string} p */
export function provenInsensitiveAt(p) { return current.decide(p) === true; }

/** The comparison spelling of a name: NFC, lower case when CI. @param {string} s @param {boolean} [ci] */
export function fold(s, ci = true) { const n = s.normalize('NFC'); return ci ? n.toLowerCase() : n; }

/** @param {string} a @param {string} b @param {boolean} ci */
export function same(a, b, ci) { return fold(a, ci) === fold(b, ci); }

/** P is ROOT or a path below it. @param {string} root @param {string} p @param {boolean} ci */
export function under(root, p, ci) {
  const r = fold(root, ci).replace(/\/+$/, ''); const q = fold(p, ci);
  return q === r || q.startsWith(`${r}/`);
}
