// @ts-check
// Is a folder tree byte-identical to another? The hook runs the shell code of a project only from a script tree it can prove is the main tree's own:
// a run worktree's .agents/scripts is tracked content that a task could have rewritten (agent.sh is a launcher of proofline-core.mjs and core/).
import { lstatSync, readFileSync, readdirSync } from 'node:fs';

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
