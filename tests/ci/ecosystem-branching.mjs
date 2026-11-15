// @ts-check
// No ecosystem branching in the shared Node code (A187, ADR 0001 section 9): what an ecosystem is lives in control-plane/agents/ecosystems.json
// as data, and no module of core/, the Node entry, the hooks or the CLI branches on an ecosystem id. The ids are read from that file; the check
// FAILS when the file is missing or lists none (a rule that can not run must not pass), and on
//   - a `case` label naming an id:            case 'cargo':
//   - a comparison with an id:                 x === 'npm'   'go' !== y
//   - a table keyed by ids (A283):             { npm: [...], python: [...] }   'cargo': ...   [["go", ...], ["npm", ...]]
//     (two or more different ids as object keys or as the first element of a pair within TABLE_WINDOW lines; one id alone is not a table)
// A line directly below a `// eco-ok: <reason>` comment is exempt (for a table: that line does not count towards it) (an interpreter name is not an ecosystem). Strings that merely contain an
// id (messages, paths) do not count. The shell twin is rule 5 of tests/shared/check-static.mjs (which reads ecosystems.json).
//   usage: node tests/ci/ecosystem-branching.mjs [--root DIR]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// skills/<name>/scripts is shared code of the skills (installable alone, but not ecosystem-specific): scanned with the rest (A283)
const SCANNED_DIRS = ['control-plane/agents/scripts', 'adapters', 'bin'];
const SKILLS_DIR = 'skills';
const TABLE_WINDOW = 8;
const SKIP_DIR = /(^|\/)(node_modules|fixtures|\.git)(\/|$)/;
const SKIP_FILE = /(\.test\.mjs|-test\.mjs)$/;

/** @param {string} root @returns {string[]} the ecosystem ids, or throws with the reason the rule can not run */
export function ecosystemIds(root) {
  const file = join(root, 'control-plane/agents/ecosystems.json');
  if (!existsSync(file)) throw new Error('control-plane/agents/ecosystems.json is missing: the check needs the ecosystem definition to know the ids');
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`control-plane/agents/ecosystems.json is not valid JSON: ${/** @type {Error} */ (e).message}`); }
  const ids = Array.isArray(data?.ecosystems) ? data.ecosystems.map((/** @type {{ id?: unknown }} */ e) => e?.id).filter((/** @type {unknown} */ i) => typeof i === 'string' && i) : [];
  if (ids.length === 0) throw new Error('control-plane/agents/ecosystems.json lists no ecosystem id');
  return ids;
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (SKIP_DIR.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.mjs') && !SKIP_FILE.test(n)) out.push(p);
  }
}

/** The Node files that are shared code: core/ and the entry beside it, the hook and CLI .mjs. @param {string} root */
export function sharedFiles(root) {
  /** @type {string[]} */ const out = [];
  for (const d of SCANNED_DIRS) walk(join(root, d), out);
  return out;
}

/** The scripts of the skills: scanned for ecosystem TABLES only (A283); their case/comparison branches are not covered yet. @param {string} root */
export function skillFiles(root) {
  /** @type {string[]} */ const out = [];
  const skills = join(root, SKILLS_DIR);
  if (existsSync(skills)) for (const n of readdirSync(skills).sort()) walk(join(skills, n, 'scripts'), out);
  return out;
}

/** @param {string} text @param {string[]} ids @returns {{ line: number, text: string }[]} */
export function branchesIn(text, ids, tablesOnly = false) {
  const alt = ids.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const q = '[\'"`]';
  const caseArm = new RegExp(`\\bcase\\s+${q}(${alt})${q}\\s*:`);
  const cmp = new RegExp(`(?:[!=]==?\\s*${q}(?:${alt})${q}(?![\\w-]))|(?:${q}(?:${alt})${q}\\s*[!=]==?)`);
  // a table: an id as an object key (npm:  'npm':  "npm" :) or as the first element of a pair (["go", ...])
  const keyRe = new RegExp(`(?:^|[{,(\\s])(?:${q}(${alt})${q}|(${alt}))\\s*:(?!:)|\\[\\s*${q}(${alt})${q}\\s*,`, 'g');
  /** @type {{ line: number, text: string }[]} */ const hits = []; let ok = false;
  /** @type {{ line: number, id: string }[]} */ const keys = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (l.startsWith('//')) { ok = /^\/\/\s*eco-ok:/.test(l); return; }
    if (!ok && !tablesOnly && (caseArm.test(l) || cmp.test(l))) hits.push({ line: i + 1, text: l.slice(0, 160) });
    if (!ok) for (const m of l.matchAll(keyRe)) keys.push({ line: i + 1, id: m[1] ?? m[2] ?? m[3] });
    ok = false;
  });
  const lines = text.split('\n');
  // two different ids as keys within TABLE_WINDOW lines of each other: one hit per table, at its first line
  let last = 0;
  for (let a = 0; a < keys.length; a++) {
    if (keys[a].line <= last) continue;
    const b = keys.findIndex((k, j) => j > a && k.id !== keys[a].id && k.line - keys[a].line < TABLE_WINDOW);
    if (b < 0) continue;
    let end = keys[b].line;
    for (const k of keys.slice(b + 1)) if (k.line - end < TABLE_WINDOW) end = k.line;
    last = end;
    hits.push({ line: keys[a].line, text: `table keyed by ecosystem ids: ${lines[keys[a].line - 1].trim().slice(0, 140)}` });
  }
  return hits.sort((x, y) => x.line - y.line);
}

/** @param {string} root @returns {string[]} one message per problem (empty: the rule passes) */
export function check(root) {
  /** @type {string[]} */ const problems = [];
  let ids;
  try { ids = ecosystemIds(root); } catch (e) { return [/** @type {Error} */ (e).message]; }
  for (const f of sharedFiles(root)) for (const h of branchesIn(readFileSync(f, 'utf8'), ids)) problems.push(`${relative(root, f)}:${h.line}: ${h.text}`);
  for (const f of skillFiles(root)) for (const h of branchesIn(readFileSync(f, 'utf8'), ids, true)) problems.push(`${relative(root, f)}:${h.line}: ${h.text}`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? resolve(process.argv[i + 1]) : resolve(import.meta.dirname, '../..');
  const problems = check(root);
  if (problems.length === 0) { console.log(`PASS no ecosystem branching in shared Node code (ids: ${ecosystemIds(root).join('|')}; ${sharedFiles(root).length} files + ${skillFiles(root).length} skill scripts for tables)`); }
  else {
    console.error('FAIL ecosystem branching in shared Node code: move the knowledge into control-plane/agents/ecosystems.json as data (A187)');
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  }
}
