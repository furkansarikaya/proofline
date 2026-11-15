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
// THE PROBE (create-free, no process, nothing written): list the directory (at most 2048 entries) and look only at entries made of ASCII letters, digits and `._-`
// (an agent can create files in some directories, so a name with `\u0131`, `\u00df` or an emoji must never steer the answer). For each, `lstat` it and the same name with
// every ASCII letter's case flipped. The same device and inode with one link: the volume folds case, and one such pair is conclusive. Sensitivity needs positive evidence:
// an ASCII entry whose flip does not exist (or a pair that are two different files), and no pair that resolved. A hard-linked entry is ignored (`a` and `A` linked on a
// keeping volume look like a folding pair). No suitable entry: the directory's own name is flipped in its parent instead (this answers for the parent, an accepted
// approximation; a per-directory flag on an empty directory is the one thing this cannot see). Anything undecided fails closed (see insensitiveAt).
//
// THE CACHE KEY is the directory's identity, `st_dev:st_ino`, not the project root and not the path text: a case-sensitive volume mounted inside a case-insensitive
// tree has another st_dev, and a per-directory case-fold flag (ext4 casefold, ZFS, a macOS folder on a case-sensitive volume) has another inode, so each gets its own
// probe and a path text that names another directory later never reuses a stale answer. Only a decided answer is cached; an undecided one is asked again.
//
// UNICODE. APFS and HFS+ also treat NFC and NFD spellings as one name, and APFS folds case by Unicode full case folding: the long s (U+017F), the Kelvin sign (U+212A),
// the sharp s and the ligatures fi, fl, ff, ffi, ffl, st name ASCII letters. `fold` is NFC always (a protected name cannot be written around a normalization form,
// whatever the volume does), and on a volume that folds case also upper then lower case (JS full case mapping). On a volume that keeps case apart the NFC form of an
// exotic spelling is still no protected name. tests/hook/fscase.test.mjs checks the fold against the real file system, code point by code point.
import { lstatSync, opendirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isWin } from './text.mjs';

/** @typedef {(dir: string) => (boolean | undefined)} Probe true: the directory folds case; false: it does not; undefined: cannot tell */

/** Swap the case of every ASCII letter (the probe judges ASCII names only: a name an agent can choose to mislead it, such as `\u0131a` or `!\u00df`, is never evidence). @param {string} name */
function flip(name) { return name.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())); }

/** @typedef {{ names: (dir: string) => Iterable<string>, lstat: (p: string) => { dev: number, ino: number, nlink: number } }} Io the file system the probe reads (injectable: tests give it a fake volume) */
/** @type {Io} */
const realIo = {
  *names(dir) {
    const d = opendirSync(dir);
    try { for (let i = 0; i < 2048; i++) { const e = d.readSync(); if (!e) break; yield e.name; } } finally { try { d.closeSync(); } catch { /* closed */ } }
  },
  lstat: (p) => lstatSync(p),
};

/** The real probe (see the header). Only entries made of ASCII letters, digits and `._-` count. A pair that resolves to one device and inode (with one link) proves a folding volume at once; sensitivity needs positive evidence: an ASCII entry whose flipped name does not exist, and no pair that resolved. A hard-linked entry is ignored. Anything else is undecided. @param {string} dir @param {Io} [io] @type {Probe} */
export function realProbe(dir, io = realIo) {
  /** @param {string} parent @param {string} name @param {boolean} isDir @returns {boolean | undefined} */
  const via = (parent, name, isDir) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !/[A-Za-z]/.test(name)) return undefined;
    const other = flip(name);
    let a;
    try { a = io.lstat(path.join(parent, name)); } catch { return undefined; }
    try {
      const b = io.lstat(path.join(parent, other));
      if (a.dev === b.dev && a.ino === b.ino) return isDir || a.nlink === 1 ? true : undefined; // a hard link pair `a`/`A` on a keeping volume looks the same: ignored
      return false; // two different files named a and A: only a volume that keeps case can hold both
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? false : undefined;
    }
  };
  let sensitive = false;
  try {
    for (const n of io.names(dir)) {
      const r = via(dir, n, false);
      if (r === true) return true;
      if (r === false) sensitive = true;
    }
  } catch { return undefined; }
  if (sensitive) return false;
  const parent = path.dirname(dir);
  return parent === dir ? undefined : via(parent, path.basename(dir), true);
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

/** The comparison spelling of a name: NFC, then (when CI) upper then lower case, which is the Unicode full case folding as far as JS has it (the long s and the Kelvin sign become `s` and `k`, the sharp s `ss`, the ligature fi `fi`). @param {string} s @param {boolean} [ci] */
export function fold(s, ci = true) { const n = s.normalize('NFC'); return ci ? n.toUpperCase().toLowerCase().replace(/\u00df/g, 'ss') : n; } // U+1E9E (capital sharp s) lower-cases to U+00DF, which APFS also resolves to `ss`: found by the ground-truth test of tests/hook/fscase.test.mjs

/** @param {string} a @param {string} b @param {boolean} ci */
export function same(a, b, ci) { return fold(a, ci) === fold(b, ci); }

/** P is ROOT or a path below it. @param {string} root @param {string} p @param {boolean} ci */
export function under(root, p, ci) {
  const r = fold(root, ci).replace(/\/+$/, ''); const q = fold(p, ci);
  return q === r || q.startsWith(`${r}/`);
}
