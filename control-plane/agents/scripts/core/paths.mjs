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
 * Input paths from a runtime on Windows: `C:\x\y` and `C:/x/y` become `C:/x/y`; the Git-for-Windows form `/c/x/y` too, on a Windows
 * host only (elsewhere `/c` is an ordinary folder). Anything else is returned in POSIX form. Pure, so it is tested with the Windows
 * rules on every platform.
 * @param {string} p @param {string} [platform]
 */
export function normalizeInputPath(p, platform = process.platform) {
  const drive = /^([A-Za-z]):[\\/]+(.*)$/.exec(p);
  if (drive) {
    const rest = path.win32.normalize(drive[2] || '.').split(path.win32.sep).join('/').replace(/^\.$/, '').replace(/\/$/, '');
    return `${drive[1].toUpperCase()}:/${rest}`;
  }
  const msys = platform === 'win32' ? /^\/([A-Za-z])(?:\/(.*))?$/.exec(p) : null;
  if (msys) return `${msys[1].toUpperCase()}:/${(msys[2] ?? '').replace(/\/$/, '')}`;
  return toPosix(p);
}
