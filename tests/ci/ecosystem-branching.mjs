// @ts-check
// No ecosystem branching in the shared Node code (A187, ADR 0001 section 9): what an ecosystem is lives in control-plane/agents/ecosystems.json
// as data, and no module of core/, the Node entry, the hooks or the CLI branches on an ecosystem id. The ids are read from that file; the check
// FAILS when the file is missing or lists none (a rule that can not run must not pass), and on
//   - a `case` label naming an id:            case 'cargo':
//   - a comparison with an id:                 x === 'npm'   'go' !== y
// A line directly below a `// eco-ok: <reason>` comment is exempt (an interpreter name is not an ecosystem). Strings that merely contain an
// id (messages, paths) do not count. The shell twin is rule 5 of tests/shared/check-static.sh (which reads ecosystems.tsv).
//   usage: node tests/ci/ecosystem-branching.mjs [--root DIR]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SCANNED_DIRS = ['control-plane/agents/scripts', 'adapters', 'bin'];
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

/** @param {string} text @param {string[]} ids @returns {{ line: number, text: string }[]} */
export function branchesIn(text, ids) {
  const alt = ids.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const q = '[\'"`]';
  const caseArm = new RegExp(`\\bcase\\s+${q}(${alt})${q}\\s*:`);
  const cmp = new RegExp(`(?:[!=]==?\\s*${q}(?:${alt})${q}(?![\\w-]))|(?:${q}(?:${alt})${q}\\s*[!=]==?)`);
  /** @type {{ line: number, text: string }[]} */ const hits = []; let ok = false;
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (l.startsWith('//')) { ok = /^\/\/\s*eco-ok:/.test(l); return; }
    if (!ok && (caseArm.test(l) || cmp.test(l))) hits.push({ line: i + 1, text: l.slice(0, 160) });
    ok = false;
  });
  return hits;
}

/** @param {string} root @returns {string[]} one message per problem (empty: the rule passes) */
export function check(root) {
  /** @type {string[]} */ const problems = [];
  let ids;
  try { ids = ecosystemIds(root); } catch (e) { return [/** @type {Error} */ (e).message]; }
  for (const f of sharedFiles(root)) for (const h of branchesIn(readFileSync(f, 'utf8'), ids)) problems.push(`${relative(root, f)}:${h.line}: ${h.text}`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? resolve(process.argv[i + 1]) : resolve(import.meta.dirname, '../..');
  const problems = check(root);
  if (problems.length === 0) { console.log(`PASS no ecosystem branching in shared Node code (ids: ${ecosystemIds(root).join('|')}; ${sharedFiles(root).length} files)`); }
  else {
    console.error('FAIL ecosystem branching in shared Node code: move the knowledge into control-plane/agents/ecosystems.json as data (A187)');
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  }
}
