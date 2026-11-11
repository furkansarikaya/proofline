// @ts-check
// Pruning of the Node test harness' disk use (A253, a finding on issue #165): the template cache of tests/lib/harness.mjs `cached()` and the temporary folders the test helpers leave
// behind when a run is killed. One implementation for both users: `cached()` (throttled, on use) and `node tests/lib/clean-temp.mjs` (by hand). Nothing here reads a clock or the
// real file system on its own: the caller gives `now` (milliseconds) and, in tests, a file system; a decision is a function of what `lstat` says and of `now`.
//
// What is deleted, and why it is safe to run next to live test processes (several run at once):
//  - an entry of the cache is "used" when its `.built` marker is touched (every `cached()` hit and every `copyOf` touches it), so its last use is that marker's mtime;
//  - an entry used within `protectMs` is never touched, nor is an entry the caller names in `keep` (the key it is about to return);
//  - an entry idle for more than `maxAgeMs` goes; when the rest is still larger than `maxBytes` the least recently used unprotected ones go, oldest first;
//  - a private `build-*` folder, an `evict-<time>-*` tombstone (as old as its name says) or an entry without a marker (a builder that was killed) goes once its own mtime is older than `leftoverMs`;
//  - an entry is never deleted in place: it is first RENAMED to an `evict-<time>-*` tombstone (atomic; a path that is a link would move as the link, never be followed), the marker is
//    read again, and when it was touched since the listing the entry is renamed back. A reader that was copying in that instant gets an error (the copy of tests/lib/harness.mjs is
//    written in JS for this: node's own `cpSync` aborts the whole process from C++ when a folder disappears under it) and `copyOf` copies again (copy-then-verify), after
//    building the template anew if it is gone for good.
import * as nodeFs from 'node:fs';
import path from 'node:path';

/** The knobs. Milliseconds and bytes. */
export const POLICY = Object.freeze({ protectMs: 30 * 60e3, maxAgeMs: 6 * 3600e3, leftoverMs: 3600e3, maxBytes: 2 * 1024 ** 3, stampMs: 5 * 60e3, tempMs: 2 * 3600e3 });

/** @typedef {Pick<typeof nodeFs, 'lstatSync' | 'readdirSync' | 'renameSync' | 'rmdirSync' | 'unlinkSync' | 'chmodSync' | 'utimesSync' | 'writeFileSync'>} Fsx */
/** @typedef {{ name: string, path: string, bytes: number, reason: string }} Removal */

/** @param {unknown} e @param {string} code */
const is = (e, code) => /** @type {any} */ (e)?.code === code;

/** unlink/rmdir by hand, links never followed; a path that is already gone is done. @param {string} p @param {Fsx} [fsx] */
export function removeTree(p, fsx = nodeFs) {
  let st;
  try { st = fsx.lstatSync(p); } catch (e) { if (is(e, 'ENOENT')) return; throw e; }
  try {
    if (st.isDirectory()) { fsx.chmodSync(p, 0o700); for (const n of fsx.readdirSync(p)) removeTree(path.join(p, n), fsx); fsx.rmdirSync(p); } else fsx.unlinkSync(p);   // lstat above: p is no link, so chmod never follows one; a read-only directory could not be emptied
  } catch (e) { if (!is(e, 'ENOENT')) throw e; }
}

/** Disk bytes under p (blocks when the file system says, else sizes), links counted as themselves. @param {string} p @param {Fsx} [fsx] @returns {number} */
export function sizeOf(p, fsx = nodeFs) {
  let st;
  try { st = fsx.lstatSync(p); } catch { return 0; }
  let n = typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
  if (st.isDirectory()) { let names = []; try { names = fsx.readdirSync(p); } catch { /* gone or unreadable: counts what it counts */ } for (const c of names) n += sizeOf(path.join(p, String(c)), fsx); }
  return n;
}

/** mtime of the `.built` marker of a template folder, or undefined. @param {string} dir @param {Fsx} fsx */
function markerMtime(dir, fsx) {
  try { const st = fsx.lstatSync(path.join(dir, '.built')); return st.isFile() ? st.mtimeMs : undefined; } catch { return undefined; }
}

/** Record a use of a template: touch its marker (best effort: a template that is gone is the caller's business). @param {string} template @param {number} now @param {Fsx} [fsx] */
export function touchUse(template, now, fsx = nodeFs) {
  try { fsx.utimesSync(path.join(template, '.built'), now / 1000, now / 1000); } catch { /* evicted or read-only */ }
}

let evictions = 0;

/**
 * Prune a cache folder. Only direct children that are real directories of this user are ever looked at.
 * @param {string} root the cache folder (the caller made sure it is a private folder of this user)
 * @param {{ now: number, keep?: string[], dryRun?: boolean, policy?: Partial<typeof POLICY>, fsx?: Fsx, uid?: number, afterRename?: (name: string) => void }} o
 * `afterRename`: a test seam that runs between the rename to the tombstone and the second look at the marker.
 * @returns {{ removed: Removal[], kept: number, bytes: number }} what was (or, with dryRun, would be) removed; `bytes` their total
 */
export function pruneCache(root, o) {
  const fsx = o.fsx ?? nodeFs; const P = { ...POLICY, ...(o.policy ?? {}) }; const keep = new Set(o.keep ?? []);
  const uid = o.uid ?? process.getuid?.();
  /** @type {Array<{ name: string, p: string, mtime: number, marker: number | undefined }>} */ const items = [];
  let names; try { names = fsx.readdirSync(root).map(String); } catch { return { removed: [], kept: 0, bytes: 0 }; }
  for (const name of names) {
    const p = path.join(root, name);
    let st; try { st = fsx.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;   // files (the stamp), links and other users' folders are not ours to judge
    items.push({ name, p, mtime: st.mtimeMs, marker: markerMtime(p, fsx) });
  }
  /** @type {Removal[]} */ const removed = [];
  /** @type {typeof items} */ const live = [];
  for (const it of items) {
    const leftover = /^(?:build|evict)-/.test(it.name) || it.marker === undefined;
    // a tombstone is as old as the moment it was made (it is in its name): the mtime of the evicted entry itself is its idle time, which says nothing about a deletion in progress
    const born = /^evict-(\d+)-/.exec(it.name);
    if (leftover) { if (o.now - (born ? Number(born[1]) : it.mtime) > P.leftoverMs && !keep.has(it.name)) { removed.push({ name: it.name, path: it.p, bytes: sizeOf(it.p, fsx), reason: 'leftover' }); } continue; }
    live.push(it);
  }
  const used = (/** @type {typeof items[0]} */ it) => /** @type {number} */ (it.marker);
  const protectedNow = (/** @type {typeof items[0]} */ it) => keep.has(it.name) || o.now - used(it) < P.protectMs;
  /** @type {Array<typeof items[0] & { bytes: number }>} */ const rest = [];
  for (const it of live) {
    if (!protectedNow(it) && o.now - used(it) > P.maxAgeMs) removed.push({ name: it.name, path: it.p, bytes: sizeOf(it.p, fsx), reason: 'idle' });
    else rest.push({ ...it, bytes: sizeOf(it.p, fsx) });
  }
  let total = rest.reduce((s, it) => s + it.bytes, 0);
  for (const it of [...rest].sort((a, b) => used(a) - used(b))) {
    if (total <= P.maxBytes) break;
    if (protectedNow(it)) continue;
    removed.push({ name: it.name, path: it.p, bytes: it.bytes, reason: 'size' });
    total -= it.bytes;
  }
  const marks = new Map(items.map((it) => [it.name, it.marker]));
  /** @type {Removal[]} */ const done = [];
  for (const r of removed) {
    if (o.dryRun) { done.push(r); continue; }
    if (r.reason === 'leftover') { try { removeTree(r.path, fsx); done.push(r); } catch { /* retried by the next prune */ } continue; }
    const tomb = path.join(root, `evict-${o.now}-${process.pid}-${++evictions}-${r.name}`.slice(0, 200));
    try { fsx.renameSync(r.path, tomb); } catch { continue; }   // gone, or taken by another pruner: nothing to do
    o.afterRename?.(r.name);
    if (markerMtime(tomb, fsx) !== marks.get(r.name)) {   // used since the listing: it is not idle after all
      try { fsx.renameSync(tomb, r.path); continue; } catch { /* the key was rebuilt meanwhile: the tombstone is the stale copy */ }
    }
    try { removeTree(tomb, fsx); done.push(r); } catch { /* a leftover evict-* is removed by a later prune */ }
  }
  return { removed: done, kept: items.length - done.length, bytes: done.reduce((s, r) => s + r.bytes, 0) };
}

/**
 * Prune at most once per `stampMs` for a cache folder (a stamp file in it carries the time), whoever asks: a `cached()` call of any test process.
 * @param {string} root @param {Parameters<typeof pruneCache>[1]} o
 * @returns {ReturnType<typeof pruneCache> | undefined} undefined when the stamp is fresh
 */
export function pruneThrottled(root, o) {
  const fsx = o.fsx ?? nodeFs; const stamp = path.join(root, '.pruned'); const every = { ...POLICY, ...(o.policy ?? {}) }.stampMs;
  try { if (o.now - fsx.lstatSync(stamp).mtimeMs < every) return undefined; } catch { /* no stamp yet */ }
  try { fsx.writeFileSync(stamp, ''); fsx.utimesSync(stamp, o.now / 1000, o.now / 1000); } catch { return undefined; }
  return pruneCache(root, o);
}

/**
 * Copy a folder tree with plain file system calls, so that a source that disappears under the copy (an entry evicted by another process) is an error the caller can catch.
 * Node's own `cpSync` runs in C++ and aborts the whole process then. Links are copied as links (the text of the target is kept), modes are kept, `skip` names are left out.
 * @param {string} src @param {string} dst (may exist: the folder `tmp()` made) @param {string[]} [skip] base names not to copy, at any depth
 */
export function copyTree(src, dst, skip = []) {
  const st = nodeFs.lstatSync(src);
  if (st.isDirectory()) {
    nodeFs.mkdirSync(dst, { recursive: true });
    for (const n of nodeFs.readdirSync(src)) if (!skip.includes(n)) copyTree(path.join(src, n), path.join(dst, n), skip);
  } else if (st.isSymbolicLink()) nodeFs.symlinkSync(nodeFs.readlinkSync(src), dst);
  else nodeFs.copyFileSync(src, dst, nodeFs.constants.COPYFILE_FICLONE);
}
