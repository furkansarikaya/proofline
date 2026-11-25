// @ts-check
// Tidying of what runs leave behind (A357, issue 338 B7). Only things that hold nothing: a folder under `.agents/runs` with no file, no link and nothing else in it (the empty
// `scratch/` a role made in the main checkout) is removed with `rmdir`, deepest first. `rmdir` cannot remove a folder that holds anything, so a file that appeared meanwhile
// keeps its folder; a link is never followed and a folder that holds one is kept. A folder with a RUN.yaml is a run and holds a file by definition.
import { lstatSync, readdirSync, rmdirSync } from 'node:fs';

/**
 * Remove the empty folders directly under RUNS (and the empty folders in them). Returns the names of the top folders that went.
 * @param {string} runs the `.agents/runs` folder of a tree
 * @returns {string[]}
 */
export function pruneEmptyRunFolders(runs) {
  /** @type {string[]} */ const gone = [];
  let top = [];
  try {
    const st = lstatSync(runs);
    if (!st.isDirectory() || st.isSymbolicLink()) return gone;
    top = readdirSync(runs).sort();
  } catch { return gone; }
  /** @param {string} dir @returns {boolean} the folder is gone */
  const prune = (dir) => {
    let st;
    try { st = lstatSync(dir); } catch { return false; }
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    let names = [];
    try { names = readdirSync(dir); } catch { return false; }
    let left = names.length;
    for (const n of names) if (prune(`${dir}/${n}`)) left--;
    if (left > 0) return false;
    try { rmdirSync(dir); return true; } catch { return false; }
  };
  for (const n of top) if (!n.startsWith('.') && prune(`${runs}/${n}`)) gone.push(n);
  return gone;
}
