// @ts-check
// `debt` (A153, scripts/debt.sh): the `shortcut: <limit>, <when to improve>` comments of the code with file and line, found by git grep.
// debt.sh stays as the legacy launcher until stage 10; the command runs here. Text is a byte string.
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProoflineError } from './errors.mjs';
import * as proc from './proc.mjs';
import { trimSpace } from './shellglob.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const GREP_RE = '(#|//|--|/\\*|<!--|;|\\*)[[:space:]]*shortcut:';
const MATCH_RE = /(#|\/\/|--|\/\*|<!--|;|\*)[ \t]*shortcut:/;

/** @param {string} m @returns {never} */
function die(m) { throw new ProoflineError(`debt: ${m}`, 1); }

/** @param {string} a @param {string} b */
const byteCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows of `rows()`: [file, line, limit, improve-when], sorted like `LC_ALL=C sort -k1,1 -k2,2n`.
 * @param {Context} ctx @param {string} top
 * @returns {Array<[string, number, string, string]>}
 */
function rows(ctx, top) {
  const r = proc.run('git', ['-C', top, 'grep', '-n', '-I', '-E', '--untracked', '--exclude-standard', '-e', GREP_RE, '--', '.',
    ':(exclude)*.md', ':(exclude).agents', ':(exclude).claude', ':(exclude)docs/wiki'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  const text = r.stdout.toString('latin1');
  /** @type {Array<{ f: string, ln: string, lim: string, imp: string, key: string }>} */ const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const p1 = line.indexOf(':') + 1; // awk index: 0 when absent
    const f0 = line.slice(0, Math.max(p1 - 1, 0));
    const rest = line.slice(p1);
    const p2 = rest.indexOf(':') + 1;
    const ln = rest.slice(0, Math.max(p2 - 1, 0));
    const txt = rest.slice(p2);
    const m = MATCH_RE.exec(txt);
    if (!m) continue;
    let t = txt.slice(m.index + m[0].length);
    t = t.replace(/[ \t]*(\*\/|-->)[ \t]*$/, '');
    t = trimSpace(t);
    let lim = t; let imp = '(not stated)';
    const c = /[,;] /.exec(t);
    if (c) { lim = trimSpace(t.slice(0, c.index)); imp = trimSpace(t.slice(c.index + 2)); }
    if (lim === '') lim = '(not stated)';
    lim = lim.replace(/\t/g, ' '); imp = imp.replace(/\t/g, ' ');
    const f = f0.replace(/\t/g, ' ');
    const n = Number.parseInt(ln, 10);
    const num = Number.isNaN(n) ? 0 : n;
    out.push({ f, ln: String(num).padStart(8, '0'), lim, imp, key: `${f}\t${String(num).padStart(8, '0')}\t${lim}\t${imp}` });
  }
  out.sort((a, b) => byteCmp(a.f, b.f) || Number(a.ln) - Number(b.ln) || byteCmp(a.key, b.key));
  return out.map((o) => [o.f, Number(o.ln), o.lim, o.imp]);
}

/** @param {string} op @param {Context} ctx */
export function debt(ctx, op) {
  const root = ctx.root;
  const t = proc.run('git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  if (t.status !== 0) die(`not a git repository: ${root}`);
  const top = t.stdout.toString('latin1').replace(/\n+$/, '');
  const page = `${top}/docs/wiki/concepts/shortcut-debt.md`;
  switch (op) {
    case 'list': {
      const r = rows(ctx, top);
      if (r.length === 0) { ctx.out('shortcut debt: none\n'); return 0; }
      ctx.out(`shortcut debt: ${r.length}\n`);
      for (const [f, ln, lim, imp] of r) ctx.out(`${f}:${ln} | ${lim} | ${imp}\n`);
      return 0;
    }
    case 'page': {
      if ((ctx.rawRole === '' ? 'lead' : ctx.rawRole) !== 'lead') die("only the lead runs 'page'");
      return writePage(ctx, top, page, rows(ctx, top));
    }
    default:
      ctx.err('usage: debt.sh [list|page]\n');
      return 2;
  }
}

/** @param {Context} ctx @param {string} top @param {string} page @param {Array<[string, number, string, string]>} r */
function writePage(ctx, top, page, r) {
  const dir = (() => { try { return statSync(`${top}/docs/wiki`).isDirectory(); } catch { return false; } })();
  if (!dir) { ctx.out("no wiki (docs/wiki/): page not written; 'agent.sh debt' lists the shortcuts\n"); return 0; }
  const exists = (() => { try { return statSync(page).isFile(); } catch { return false; } })();
  if (r.length === 0 && !exists) { ctx.out('no shortcut comments and no page: nothing to write\n'); return 0; }
  const pdir = path.dirname(page);
  try { mkdirSync(pdir, { recursive: true }); } catch { die(`cannot create ${pdir}`); }
  const tmp = `${page}.${process.pid}`;
  let body = '---\ntitle: shortcut-debt\nstatus: current\nsource: .agents/KNOWLEDGE.md\n---\n\n# Shortcut debt\n\n';
  body += 'Written by `agent.sh debt page` from the `shortcut: <limit>, <when to improve>` comments in the code; never edit it by hand. A removed shortcut drops off the page.\n\n';
  if (r.length === 0) body += 'No shortcut comments in the code.\n';
  else {
    body += '| Where | Limit | Improve when |\n|---|---|---|\n';
    for (const [f, ln, lim, imp] of r) body += `| \`${f}:${ln}\` | ${lim.replace(/\|/g, '\\|')} | ${imp.replace(/\|/g, '\\|')} |\n`;
  }
  try { writeFileSync(tmp, Buffer.from(body, 'latin1')); } catch { rmSync(tmp, { force: true }); die(`cannot write ${page}`); }
  try { renameSync(tmp, page); } catch { rmSync(tmp, { force: true }); die(`cannot write ${page}`); }
  const rel = page.startsWith(`${top}/`) ? page.slice(top.length + 1) : page;
  ctx.out(`wrote ${rel} (${r.length} shortcut(s)); link it from docs/wiki/index.md if it is not linked yet\n`);
  return 0;
}
