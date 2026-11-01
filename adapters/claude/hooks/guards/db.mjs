// @ts-check
// The database guard (A40, A50): whenever proofline is installed no agent (lead included) reads, copies, queries or writes a database file, runs a
// SQL client against one, or runs a migration/seed command; destructive steps run in no environment before the user's approval. The only database
// an agent may meet is a test suite's own throwaway database: in memory or a scratch file under $TMPDIR outside the project. Paths, clients and
// migrate commands come from the config (hook-config / db-config). A heuristic: token and command-word matching on the command text.
//   dbLoad(ctx)                       the settings (once per event)
//   dbCheckToken(ctx, token, what)    deny unless TOKEN is no database file or a scratch one (the file tools use it for their paths too)
//   dbGuardCmd(ctx, scan)             the Bash command: tokens of every command and write target, SQL clients, destructive SQL, migrations
//   scratchPath(ctx, p)               a throwaway location outside the project root
import { readFileSync, statSync } from 'node:fs';
import { isDir as isDirectory } from '../lib/fsx.mjs';
import { cmdSubst } from '../lib/text.mjs';
import { cParts, deny, dn, physDir, ereToJs, globMatch, grepq, hcfgLoad, lines, mcFail, stateOf } from './kit.mjs';

const DSQL = new RegExp('(^|[^a-z_])(drop[ \\t\\n\\v\\f\\r]+(table|column|index|view|schema|database|trigger)|alter[ \\t\\n\\v\\f\\r]+table[^;]*[ \\t\\n\\v\\f\\r]drop[ \\t\\n\\v\\f\\r]|truncate[ \\t\\n\\v\\f\\r]+(table[ \\t\\n\\v\\f\\r]+)?[a-z_"`]|delete[ \\t\\n\\v\\f\\r]+from[ \\t\\n\\v\\f\\r])', 'i');

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function dbLoad(ctx) {
  const st = stateOf(ctx);
  if (st.dbLoaded) return;
  st.dbLoaded = true;
  let paths = ''; let clients = ''; let migrate = '';
  if (await hcfgLoad(ctx)) { paths = st.hc.paths; clients = st.hc.clients; migrate = st.hc.migrate; } else {
    const r = await ctx.agent(['db-config', 'all']);
    let out = r.stdout;
    if (r.status !== 0) { out = ''; mcFail(ctx, 'db-config', 'run', r.status, 'database guard'); }
    let p = false; let c = false; let m = false;
    for (const l of out.split('\n')) {
      if (l.startsWith('paths=') && !p) { paths = l.slice(6); p = true; } else if (l.startsWith('clients=') && !c) { clients = l.slice(8); c = true; } else if (l.startsWith('migrate_commands=') && !m) { migrate = l.slice(17); m = true; }
    }
  }
  // the migration patterns, split at commas and trimmed once
  st.dbMigrate = migrate.split(',').map((x) => x.replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '')).filter((x) => x !== '');
  st.dbPaths = paths === '' ? '*.db *.sqlite *.sqlite3 *.db3' : paths;
  st.dbClients = clients;
}

/**
 * `scratch_path P`: a throwaway location outside the project root. Stricter than the shell: a `..` component, or a link that leads out of the
 * scratch folders, makes it no scratch (`/tmp/../project/x.db` is the project's database).
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} p0
 */
export function scratchPath(ctx, p0) {
  const textual = (/** @type {string} */ q0) => {
    const p = q0.replace(/^\/private/, '');
    const r = ctx.root.replace(/^\/private/, '');
    if (p === r || p.startsWith(`${r}/`)) return false;
    if (p.startsWith('/tmp/') || p.startsWith('/var/folders/') || p.startsWith('$TMPDIR/') || p.startsWith('${TMPDIR}/')) return true;
    const tmp = ctx.env.TMPDIR ?? '';
    if (tmp !== '') {
      let t = tmp.endsWith('/') ? tmp.slice(0, -1) : tmp;
      t = t.replace(/^\/private/, '');
      if (p.startsWith(`${t}/`)) return true;
    }
    return false;
  };
  if (!textual(p0)) return false;
  if (`/${p0}/`.includes('/../')) return false;
  if (p0.startsWith('/')) {
    let d = p0;
    for (let i = 0; i < 64 && d !== '/' && !isDirectory(d); i++) d = dn(d);
    const real = physDir(d);
    if (real !== '' && !textual(real + p0.slice(d.length))) return false;
  }
  return true;
}

/** `db_is_path TOKEN`. @param {import('../lib/context.mjs').HookContext} ctx @param {string} tok */
function dbIsPath(ctx, tok) {
  for (const g of stateOf(ctx).dbPaths.split(/[ \t\n]+/).filter((x) => x !== '')) {
    if (g.includes('/')) { if (globMatch(g, tok) || globMatch(`*/${g}`, tok)) return true; } else if (globMatch(g, tok.slice(tok.lastIndexOf('/') + 1))) return true;
  }
  return false;
}

/** `db_check_token TOKEN WHAT`: the caller has run dbLoad. @param {import('../lib/context.mjs').HookContext} ctx @param {string} tok @param {string} what */
export function dbCheckToken(ctx, tok, what) {
  if (!dbIsPath(ctx, tok)) return;
  if (scratchPath(ctx, tok)) return;
  deny(`${what} names the database file '${tok}'. No agent reads, copies, queries or writes a database file while a run is open (a test suite's own throwaway database under $TMPDIR is the only exception). Existing rows are evidence only through the project's seed files and the test suite; record what you could not check as an open point in EVIDENCE.md`);
}

/** `db_guard_cmd`. @param {import('../lib/context.mjs').HookContext} ctx @param {import('../command-scan.mjs').ScanResult} scan */
export async function dbGuardCmd(ctx, scan) {
  await dbLoad(ctx);
  const st = stateOf(ctx);
  // Every word the command passes (command words, arguments, redirection targets), split at separators so --db=x.db, URLs and code strings are caught.
  for (const rec of scan.records) {
    if (rec.kind !== 'C' && rec.kind !== 'W') continue;
    for (const t of rec.value.split(/[ \t\n\v\f\r\x03;|&()<>"`'=,:]+/)) if (t !== '') dbCheckToken(ctx, t, 'the command');
  }
  const clients = ` ${st.dbClients} `;
  for (const rec of scan.records) {
    if (rec.kind !== 'C') continue;
    const { cw, args } = cParts(rec);
    let isql = clients.includes(` ${cw} `);
    // eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
    if (['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'ruby', 'php', 'perl'].includes(cw)) {
      const flat = ` ${args.replace(/\n/g, ' ')} `;
      if (flat.includes(' -e ') || flat.includes(' -c ') || flat.includes(' -p ') || flat.includes(' --eval ') || flat.includes(' -r ')) isql = true;
    }
    if (isql && grepq(DSQL, args)) deny(`${cw} would run a destructive SQL statement (drop, alter ... drop, truncate, delete from). Destructive steps run in no environment, in-memory or scratch databases included; the project's tests exercise migrations, and the user's destructive approval gates the plan, not an agent's command`);
    if (cw === '<') {
      const src = (args.split('\n')[0] ?? '');
      let text = null;
      try { if (statSync(src).isFile()) text = readFileSync(src, 'utf8'); } catch { /* none */ }
      if (text !== null && grepq(DSQL, text)) deny(`the command feeds '${src}', which holds a destructive SQL statement, to a program. Destructive steps run in no environment, in-memory or scratch databases included`);
    }
    if (clients.includes(` ${cw} `)) {
      if (['sqlite3', 'sqlite', 'duckdb', 'litecli'].includes(cw)) {
        let first = ''; let skip = false;
        for (const a of args.split('\n')) {
          if (skip) { skip = false; continue; }
          if (['-init', '-cmd', '-separator', '-newline', '-nullvalue', '-vfs', '-mmap', '-A'].includes(a)) { skip = true; continue; }
          if (a.startsWith('-')) continue;
          first = a; break;
        }
        if (!(first === '' || first === ':memory:' || first.startsWith('file::memory:')) && !scratchPath(ctx, first)) {
          deny(`${cw} would open '${first}'. A SQL client runs only against :memory: or a scratch file under $TMPDIR outside the project (a test suite's own throwaway database); never against a project or environment database`);
        }
      } else deny(`${cw} is a database client; no agent connects to a database while a run is open (a test suite builds its own throwaway database)`);
    }
    const joined = `${cw} ${args.replace(/\n/g, ' ')}`;
    for (const pat of st.dbMigrate) {
      const re = ereToJs(pat);
      if (re && grepq(re, joined)) {
        deny(`'${cw}' runs a migration, seed or schema command (matches database.migrate_commands). No agent runs one in any environment: the project's test command exercises migrations on the suite's own throwaway database, and applying a destructive step is the user's decision after the destructive approval`);
      }
    }
  }
}

export { cmdSubst, lines };
