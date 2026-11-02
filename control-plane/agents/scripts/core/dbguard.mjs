// @ts-check
// The database guard (A40), after the fact: the project's database files (config database.paths) are listed with size and mtime when a run
// starts (`db_guard_baseline`, still written by start) and compared before freeze, IMPLEMENTED, CODE_DONE and DONE. A changed, new or removed
// file blocks the handoff. `db-check` is one process: the walk is in process (no `find`, no `sort`, no `stat`).
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { fail } from './errors.mjs';
import { DB_PATHS_DEFAULT } from './commands/data.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `fnmatch` for find's `-name` and `-path`: `*` any run (also `/`), `?` one character, `[...]` a class, `\` quotes. @param {string} pat */
function fnmatchRegex(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '[^]*';
    else if (c === '?') re += '[^]';
    else if (c === '\\' && i + 1 < pat.length) { re += pat[i + 1].replace(/[.+^${}()|[\]\\*?]/g, '\\$&'); i++; }
    else if (c === '[') {
      const end = pat.indexOf(']', i + 2);
      if (end < 0) { re += '\\['; continue; }
      let body = pat.slice(i + 1, end);
      if (body[0] === '!') body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The text of a byte string compared like `LC_ALL=C sort`. @param {string} a @param {string} b */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1'));

/**
 * `db_snapshot`: "path|size mtime" per database file inside the project, sorted. `.git`, `node_modules` and `.agents` are not entered.
 * @param {Context} ctx @returns {string[]}
 */
export function dbSnapshot(ctx) {
  const globs = ctx.config().get('database.paths', DB_PATHS_DEFAULT).split(/[ \t\n]+/).filter((g) => g !== '');
  if (globs.length === 0) return [];
  const root = ctx.root;
  const rootEsc = root.replace(/[\\*?[]/g, '\\$&');
  /** @type {Array<{ name: RegExp | null, path: RegExp | null }>} */
  const tests = globs.map((g) => (g.includes('/') ? { name: null, path: fnmatchRegex(`${rootEsc}/${g.startsWith('**/') ? g.slice(3) : g}`) } : { name: fnmatchRegex(g), path: null }));
  /** @type {string[]} */ const hits = [];
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.agents') continue;
        walk(full);
      } else if (e.isFile() && !e.isSymbolicLink() && tests.some((t) => (t.name ? t.name.test(e.name) : t.path?.test(full)))) hits.push(full);
    }
  };
  walk(root);
  hits.sort(byteOrder);
  return hits.map((f) => {
    let meta = 'unknown';
    try { const s = lstatSync(f); meta = `${s.size} ${Math.floor(s.mtimeMs / 1000)}`; } catch { /* vanished */ }
    return `${f.slice(root.length + 1)}|${meta}`;
  });
}

/** `db_baseline_file ID` @param {Context} ctx @param {string} id */
export function dbBaselineFile(ctx, id) { return `${ctx.root}/.agents/local/db/${id}.snapshot`; }

/**
 * `db_guard_check ID`: fails when a database file changed, appeared or vanished since the run started. A run started before the guard has no
 * baseline and passes.
 * @param {Context} ctx @param {string} id
 */
export function dbGuardCheck(ctx, id) {
  let then;
  try { then = readFileSync(dbBaselineFile(ctx, id), 'latin1'); } catch { return; }
  const nowText = dbSnapshot(ctx).join('\n');
  then = then.replace(/\n+$/, '');
  if (nowText === then) return;
  // `printf '%s\n%s\n' THEN NOW | sort | uniq -u | cut -d '|' -f1 | sort -u | tr '\n' ' '`
  const lines = `${then}\n${nowText}\n`.split('\n');
  lines.pop();
  lines.sort(byteOrder);
  /** @type {string[]} */ const once = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] !== lines[i - 1] && lines[i] !== lines[i + 1]) once.push(lines[i]);
  const names = [...new Set(once.map((l) => l.split('|')[0]))].sort(byteOrder);
  const diff = names.map((n) => `${n} `).join('').replace(/ $/, '');
  fail(`database guard: a database file changed during run ${id} (${diff}). No agent touches a database that is not a test suite's own throwaway database, and no destructive step runs before the user's approval in any environment. Restore the file(s), then record the incident with 'agent.sh ledger-note ${id} <TEXT>'; the run cannot continue until the baseline matches`);
}
