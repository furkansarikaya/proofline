// @ts-check
// The safe layer between the hook (and the core it runs in process) and the file system, for a Windows host (A271). Node 22.13 on Windows aborts the WHOLE process (exit 0xC0000409, a libuv assertion
// in the UTF-8 to UTF-16 path conversion, not an exception) when any call that takes a path gets one that holds U+10000 or U+10FFFF (lib/winabort.mjs). The runtime reads every exit code other than 2 of a
// PreToolUse hook as a non-blocking error, so a name the hook reads or lists could end the hook before a guard ran. The event screen cannot see a name that is made at run time (`printf '\xf0\x90\x80\x80'`
// in a command that creates a git worktree whose administrative folder the hook lists on every later command) nor a name already on disk. This layer is the control: every call that takes a path, in the
// file system module (sync, promise and stream forms), the process module (a command, its arguments, its working directory, its environment) is judged by the TEXT of the path before it reaches libuv. A path that holds an
// aborting code point does not exist: a read, stat or list of it throws ENOENT (existsSync answers false, statSync with throwIfNoEntry:false answers undefined), a write of it throws ENOENT, a process start throws; and
// a directory listing never returns such a NAME (so it is never joined into a path later). It is installed once, first, by lib/safefs-install.mjs, in the hook process and in the worker thread that runs the
// project's core, and only on a Windows host: elsewhere nothing is patched and every call is the platform's own.
//
// What it does not cover (honestly): the module loader (an import() of a file under a folder with such a name; the folders it loads are the project's own, named by the runtime, not by an agent), the
// callback forms of the file system module (the hook and the core do not use them), Dir.read() and the async iterator of a directory handle (only readSync is used), and a process that inherits an environment variable
// holding the character without naming it.

/** @typedef {(text: string) => boolean} Aborts */

/** @param {unknown} x @returns {string} the text of a path argument; '' for a file descriptor or anything that is no path */
function textOf(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Uint8Array) return Buffer.from(x).toString('utf8');
  if (x instanceof URL) { try { return decodeURIComponent(x.pathname); } catch { return x.href; } }
  return '';
}

/** @param {string} name @param {unknown} p */
function enoent(name, p) {
  const e = /** @type {NodeJS.ErrnoException} */ (new Error(`ENOENT: no such file or directory, ${name.replace(/Sync$/, '')} '${textOf(p).replace(/[\u{10000}\u{10FFFF}]/gu, '?')}'`));
  e.code = 'ENOENT'; e.errno = -4058; e.syscall = name.replace(/Sync$/, '');
  return e;
}

/** The functions of the file system module that take a path as the first argument, and those that take two. */
const ONE = ['readdir', 'readFile', 'stat', 'lstat', 'exists', 'realpath', 'opendir', 'access', 'readlink', 'mkdir', 'rm', 'rmdir', 'unlink', 'open', 'writeFile', 'appendFile', 'utimes', 'chmod', 'mkdtemp', 'truncate', 'createReadStream', 'createWriteStream', 'statfs', 'lchown', 'chown', 'lutimes'];
const TWO = ['rename', 'copyFile', 'symlink', 'link', 'cp'];
const PROMISES = ['readdir', 'readFile', 'stat', 'lstat', 'realpath', 'opendir', 'access', 'readlink', 'mkdir', 'rm', 'rmdir', 'unlink', 'open', 'writeFile', 'appendFile', 'utimes', 'chmod', 'mkdtemp', 'truncate', 'rename', 'copyFile', 'symlink', 'link', 'cp'];

/** The names of a directory listing without the ones that abort. @param {unknown} list @param {Aborts} aborts */
function clean(list, aborts) {
  if (!Array.isArray(list)) return list;
  return list.filter((e) => !aborts(typeof e === 'string' ? e : textOf(/** @type {any} */ (e)?.name) + textOf(/** @type {any} */ (e)?.parentPath ?? '')));
}

/** @param {Record<string, any>} mod the file system module (or a fake) @param {Aborts} aborts @param {boolean} promises */
function guardModule(mod, aborts, promises) {
  /** @type {Array<() => void>} */ const undo = [];
  const bases = [...ONE, ...TWO].filter((n) => !promises || PROMISES.includes(n));
  for (const base of bases) {
    for (const key of promises ? [base] : base.startsWith('create') ? [base] : [`${base}Sync`]) {
      const orig = mod[key];
      if (typeof orig !== 'function') continue;
      const two = TWO.includes(base);
      /** @type {any} */
      const wrapped = function (/** @type {any[]} */ ...args) {
        if (aborts(textOf(args[0])) || (two && aborts(textOf(args[1])))) {
          const o = /** @type {any} */ (args[1]);
          if (base === 'exists') return promises ? Promise.resolve(false) : false;
          if ((base === 'stat' || base === 'lstat') && o && typeof o === 'object' && o.throwIfNoEntry === false && !promises) return undefined;
          const err = enoent(key, args[0]);
          if (promises) return Promise.reject(err);
          throw err;
        }
        const r = orig.apply(this, args);
        if (base === 'readdir') {
          if (promises) return Promise.resolve(r).then((l) => clean(l, aborts));
          return clean(r, aborts);
        }
        if (base === 'opendir' && r && typeof r.readSync === 'function' && !promises) {
          const rs = r.readSync.bind(r);
          r.readSync = () => { for (;;) { const e = rs(); if (e === null || e === undefined || !aborts(textOf(e.name))) return e; } };
        }
        return r;
      };
      Object.assign(wrapped, orig);
      if (base === 'realpath' && !promises && orig.native) {
        const nat = orig.native;
        wrapped.native = function (/** @type {any[]} */ ...a) { if (aborts(textOf(a[0]))) throw enoent('realpath', a[0]); return nat.apply(this, a); };
      }
      mod[key] = wrapped; undo.push(() => { mod[key] = orig; });
    }
  }
  return () => { for (const u of undo.reverse()) u(); };
}

/** The process module: a command, its arguments, its working directory and its environment values are judged by text. @param {Record<string, any>} cp @param {Aborts} aborts */
function guardProcess(cp, aborts) {
  /** @type {Array<() => void>} */ const undo = [];
  for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const orig = cp[key];
    if (typeof orig !== 'function') continue;
    cp[key] = function (/** @type {any[]} */ ...args) {
      const opt = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Uint8Array)) ?? {};
      const argv = args.find((a) => Array.isArray(a)) ?? [];
      const hit = aborts(textOf(args[0])) || argv.some((/** @type {any} */ a) => aborts(textOf(a))) || aborts(textOf(opt.cwd)) || Object.values(opt.env ?? {}).some((v) => aborts(textOf(v)));
      if (hit) throw enoent(key, args[0]);
      return orig.apply(this, args);
    };
    Object.assign(cp[key], orig);
    undo.push(() => { cp[key] = orig; });
  }
  return () => { for (const u of undo.reverse()) u(); };
}

/**
 * Patch the file system module, its promise API and the process module in place. Returns the function that puts the originals back (the tests use it).
 * @param {{ fs: Record<string, any>, promises?: Record<string, any>, cp?: Record<string, any> }} mods @param {Aborts} aborts
 */
export function guardFs(mods, aborts) {
  const undo = [guardModule(mods.fs, aborts, false)];
  if (mods.promises) undo.push(guardModule(mods.promises, aborts, true));
  if (mods.cp) undo.push(guardProcess(mods.cp, aborts));
  return () => { for (const u of undo.reverse()) u(); };
}
