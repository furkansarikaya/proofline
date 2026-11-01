// @ts-check
// Root and worktree resolution (agent.sh lines 13-27), POSIX form for stored paths, Windows input paths.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import * as proc from './proc.mjs';

/** @param {string} p */
export function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
/** @param {string} p */
export function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
/** @param {string} p */
function real(p) { try { return realpathSync(p); } catch { return p; }}

/**
 * The project root: two directories above the folder of the script, in the logical form `cd "$self_dir/../.." && pwd` gives (symbolic
 * links in the working directory stay as the shell shows them, through PWD).
 * @param {string} scriptPath absolute path of the script folder's file (agent.sh or proofline-core.mjs)
 * @param {NodeJS.ProcessEnv} env @param {string} cwd
 */
export function projectRoot(scriptPath, env, cwd) {
  const physical = path.resolve(path.dirname(scriptPath), '..', '..');
  const pwd = env.PWD;
  if (!pwd || !path.isAbsolute(pwd) || pwd === cwd || real(pwd) !== real(cwd)) return physical;
  // PWD is another spelling of the working directory (a symbolic link in its path). A script path given in that spelling is already
  // what the shell would use. Otherwise it was relative: node resolved it against the physical directory, the shell against PWD.
  if (scriptPath === pwd || scriptPath.startsWith(pwd + path.sep)) return physical;
  const rel = path.relative(cwd, scriptPath);
  return path.resolve(pwd, path.dirname(rel), '..', '..');
}

/**
 * The main working tree whose .agents/local holds the state that belongs to no single run (A185). In the main tree it is the root; in a
 * linked worktree that proofline made under <main>/.agents/local/worktrees/ it is the main tree.
 * @param {string} root @param {NodeJS.ProcessEnv} env
 */
export function sharedRoot(root, env) {
  if (!isFile(path.join(root, '.git'))) return root;
  const r = proc.run('git', ['-C', root, 'worktree', 'list', '--porcelain'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const first = r.stdout.toString('latin1').split('\n')[0] ?? '';
  const main = first.startsWith('worktree ') ? first.slice('worktree '.length) : '';
  const physical = real(root);
  return main && physical.startsWith(`${main}/.agents/local/worktrees/`) ? main : root;
}

/** The shell's `shared_dir NAME`. @param {string} sr_main @param {string} name */
export function sharedDir(sr_main, name) { return `${sr_main}/.agents/local/${name}`; }

/** Paths kept in files stay in POSIX form. @param {string} p */
export function toPosix(p) { return p.split(path.win32.sep).join(path.posix.sep); }

/**
 * Input paths from a runtime on Windows, to the POSIX form every stored path has: `C:\x\y`, `C:/x/y` and mixed `C:\x/y\z` become
 * `C:/x/y/z` (drive letter upper case, `.` and `..` resolved, no trailing slash); the long-path prefixes `\\?\C:\x` and `\\.\C:\x` lose
 * the prefix; a UNC path `\\srv\share\x` becomes `//srv/share/x`; the Git-for-Windows form `/c/x/y` and the Cygwin form
 * `/cygdrive/c/x/y` become `C:/x/y` on a Windows host only (elsewhere `/c` is an ordinary folder). Anything else is returned with its
 * backslashes turned into slashes. Pure, so it is tested with the Windows rules on every platform.
 * @param {string} p @param {string} [platform]
 */
export function normalizeInputPath(p, platform = process.platform) {
  const lp = /^\\\\[?.]\\([A-Za-z]:[\\/].*)$/s.exec(p);
  if (lp) p = lp[1];
  const drive = /^([A-Za-z]):[\\/]+(.*)$/s.exec(p);
  if (drive) {
    const full = path.win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2]}`).split(path.win32.sep).join('/');
    return full.length > 3 ? full.replace(/\/$/, '') : `${full.slice(0, 2)}/`;
  }
  const msys = platform === 'win32' ? /^(?:\/cygdrive)?\/([A-Za-z])(?:\/(.*))?$/s.exec(p) : null;
  if (msys) {
    const rest = path.posix.normalize(msys[2] || '.').replace(/^\.$/, '').replace(/\/$/, '');
    return `${msys[1].toUpperCase()}:/${rest}`;
  }
  return toPosix(p);
}

/**
 * A stored (POSIX form) path as an argument for a program the hook starts: on a Windows host `C:/x/y` becomes `C:\x\y` (and `/c/x` too),
 * a relative `a/b` becomes `a\b`; on every other platform the path is returned unchanged. The reverse of `normalizeInputPath` for spawn
 * arguments (Node accepts both slashes, native tools and `cmd` do not always).
 * @param {string} p @param {string} [platform]
 */
export function toNativePath(p, platform = process.platform) {
  if (platform !== 'win32') return p;
  const n = normalizeInputPath(p, platform);
  return n.split('/').join(path.win32.sep);
}

/**
 * A stored path as an argument for a program that runs under Git Bash or MSYS (`sh`): `C:/x/y` becomes `/c/x/y`; any other path is
 * unchanged. Windows hosts only; elsewhere unchanged.
 * @param {string} p @param {string} [platform]
 */
export function toMsysPath(p, platform = process.platform) {
  if (platform !== 'win32') return p;
  const n = normalizeInputPath(p, platform);
  const m = /^([A-Za-z]):\/(.*)$/s.exec(n);
  return m ? `/${m[1].replace(/[A-Z]/, (c) => c.toLowerCase())}${m[2] ? `/${m[2]}` : ''}` : n;
}
