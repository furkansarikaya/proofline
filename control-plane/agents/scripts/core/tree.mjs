// @ts-check
// Is a folder tree byte-identical to another? Used by proc.mjs: a shell script of a RUN WORKTREE is started only when the worktree's whole
// .agents/scripts equals the main tree's (the worktree's copy is tracked content that a task could have rewritten: agent.sh is a launcher of
// proofline-core.mjs and core/, and the shell fallback and the helper scripts run from the same folder).
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** @param {string} a @param {string} b @returns {boolean} true when both are folders with the same names and, for files, the same bytes; a link is never the same */
export function sameTree(a, b) {
  try {
    const sa = lstatSync(a); const sb = lstatSync(b);
    if (sa.isSymbolicLink() || sb.isSymbolicLink()) return false;
    if (sa.isDirectory() && sb.isDirectory()) {
      const na = readdirSync(a).sort(); const nb = readdirSync(b).sort();
      if (na.length !== nb.length || na.some((n, i) => n !== nb[i])) return false;
      return na.every((n) => sameTree(`${a}/${n}`, `${b}/${n}`));
    }
    return sa.isFile() && sb.isFile() && sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
  } catch { return false; }
}

/**
 * The shell script a child would run, when it lives in a run worktree's script folder: `{ tree, main }` (the worktree's .agents/scripts and the
 * project's own), else null. @param {string} program @param {string[]} args @param {string | undefined} cwd
 * @returns {{ tree: string, main: string } | null}
 */
function worktreeScript(program, args, cwd) {
  if (!/(^|\/)(sh|bash|dash)$/.test(program)) return null;
  const first = args.find((a) => !a.startsWith('-'));
  if (first === undefined) return null;
  let file = path.resolve(cwd ?? process.cwd(), first);
  try { file = realpathSync(file); } catch { /* the shell reports a missing file */ }
  const m = /^(.*)\/\.agents\/local\/worktrees\/[^/]+\/\.agents\/scripts\//.exec(file);
  return m ? { tree: file.slice(0, file.indexOf('/.agents/scripts/') + '/.agents/scripts'.length), main: `${m[1]}/.agents/scripts` } : null;
}

/**
 * The refusal text when a child would run a script of a run worktree, else null. proc.mjs calls it before every spawn. A worktree's copy is tracked
 * content a task could have rewritten, and comparing it with the project's and then running it leaves a window for a rewrite in between, so the core
 * never runs it: a run of a worktree is served in process by the project's own code with the worktree as its root (proofline-core.mjs), and its helper
 * scripts are the project's (Context.trustedScripts). Only a caller that says so (`allowEqualTree`: the hook, when the USER forced the shell engine for
 * a rollback) may run a worktree's script, and only while the whole tree equals the project's (the residual window is that of the rollback mode).
 * @param {string} program @param {string[]} args @param {string | undefined} cwd @param {boolean} [allowEqualTree] @returns {string | null}
 */
export function refuseUntrustedScript(program, args, cwd, allowEqualTree = false) {
  const w = worktreeScript(program, args, cwd);
  if (!w) return null;
  return allowEqualTree && sameTree(w.tree, w.main) ? null : `proofline: ${w.tree} is a run worktree's copy of ${w.main}, so none of its scripts is run (a run worktree's scripts are tracked content a task could have rewritten; the project's own code serves the worktree's runs)\n`;
}
