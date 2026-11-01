// @ts-check
// `proofline queue` (bin/proofline cmd_queue): task files and runs, as the shell front end printed them. The state of a run comes from
// `agent.sh next` (a child per run, as before; it is served by the core once `next` moves: NEEDS-LATER, an in-process call).
import { openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const isFileF = (/** @type {string} */ f) => { try { return statSync(f).isFile(); } catch { return false; } };
const isDirF = (/** @type {string} */ f) => { try { return statSync(f).isDirectory(); } catch { return false; } };

/** The locale the shell's glob sorted by: LC_ALL, else LC_COLLATE, else LANG. C, POSIX and C.UTF-8 sort by byte. @param {Context} ctx */
function byteOrder(ctx) {
  const l = [ctx.env.LC_ALL, ctx.env.LC_COLLATE, ctx.env.LANG].find((x) => x !== undefined && x !== '') ?? '';
  return l === '' || l === 'C' || l === 'POSIX' || /^C\.(UTF-?8|utf-?8)$/.test(l);
}

/**
 * The names a shell glob `"$dir"/PATTERN` lists, in the order the shell sorts them: by byte in the C locale, else the shell itself expands
 * the glob under the user's locale (the same collation as the front end used).
 * @param {Context} ctx @param {string} dir @param {string} pattern `*.md` or `*` @returns {string[]}
 */
function globNames(ctx, dir, pattern) {
  if (byteOrder(ctx)) {
    let names = [];
    try { names = readdirSync(dir, { encoding: 'latin1' }); } catch { return []; }
    return names.filter((n) => !n.startsWith('.') && (pattern === '*' || n.endsWith('.md'))).sort();
  }
  const r = proc.run('sh', ['-c', `for f in "$1"/${pattern}; do [ -e "$f" ] || [ -L "$f" ] || continue; printf '%s\\0' "\${f##*/}"; done`, 'x', dir], { cwd: ctx.root, env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.stdout.toString('latin1').split('\0').filter((x) => x !== '');
}

/** `"$dir"/*.md` that are files, in glob order. @param {Context} ctx @param {string} dir */
function mdFiles(ctx, dir) {
  return globNames(ctx, dir, '*.md').filter((n) => isFileF(`${dir}/${n}`));
}

/** The first 12 lines of a file (`head -n 12`), as `$(...)` returns them. @param {string} f */
function head12(f) {
  const b = Buffer.alloc(1 << 16);
  let n = 0;
  try { const fd = openSync(f, 'r'); try { n = readSync(fd, b, 0, b.length, 0); } finally { closeSync(fd); } } catch { return []; }
  const rows = b.subarray(0, n).toString('latin1').split('\n');
  return rows.slice(0, 12);
}

/** @param {Context} ctx @param {string[]} argv */
function agentOut(ctx, argv) {
  if (ctx.runner !== null && (argv[0] === 'status' || argv[0] === 'next')) { // both are commands of this core: in process, with the same root (no script is started)
    /** @type {Buffer[]} */ const out = [];
    ctx.runner(argv, { env: ctx.env, cwd: ctx.root, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: () => true }, scriptPath: ctx.scriptPath, isProcess: false });
    return Buffer.concat(out).toString('latin1');
  }
  const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, ...argv], { cwd: ctx.root, env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'], allowEqualTree: true });
  return r.stdout.toString('latin1');
}

/** @param {Context} ctx */
export function queue(ctx) {
  const tdName = ctx.config().get('tasks.dir', '.agents/tasks');
  const td = `${ctx.root}/${tdName}`;
  ctx.out(`tasks (${tdName}):\n`);
  let found = false;
  for (const d of ['todo', 'backlog']) for (const n of mdFiles(ctx, `${td}/${d}`)) { ctx.out(`  ${d}/${n}\n`); found = true; }
  for (const n of mdFiles(ctx, td)) { ctx.out(`  ${n}\n`); found = true; }
  if (!found) ctx.out('  (none)\n');
  let dn = 0;
  for (const n of mdFiles(ctx, `${td}/done`)) {
    dn++;
    if (dn > 20) continue;
    if (dn === 1) ctx.out('done (title and status only):\n');
    const dh = head12(`${td}/done/${n}`);
    const t1 = dh[0] ?? '';
    const dt = t1.startsWith('#') ? t1.replace(/^# */, '') : '';
    const st = dh.find((l) => /^\*\*Status:\*\* */.test(l));
    const ds = st === undefined ? '' : st.replace(/^\*\*Status:\*\* */, '');
    ctx.out(`  done/${n}: ${dt === '' ? '(no title)' : dt} [${ds === '' ? '-' : ds}]\n`);
  }
  if (dn > 20) ctx.out(`  ... and ${dn - 20} more finished task(s)\n`);
  const act = agentOut(ctx, ['status']).split('\n').map((l) => /^active_task=(.*)$/.exec(l)).find((m) => m)?.[1] ?? '';
  ctx.out('runs (.agents/runs):\n');
  found = false;
  /** @type {Array<{ rid: string, wt: boolean }>} */ const runs = [];
  const sub = (/** @type {string} */ d) => globNames(ctx, d, '*').filter((n) => isDirF(`${d}/${n}`));
  for (const n of sub(`${ctx.root}/.agents/runs`)) runs.push({ rid: n, wt: false });
  for (const w of sub(`${ctx.root}/.agents/local/worktrees`)) for (const n of sub(`${ctx.root}/.agents/local/worktrees/${w}/.agents/runs`)) runs.push({ rid: n, wt: true });
  for (const { rid, wt } of runs) {
    found = true;
    let st = '';
    for (const l of agentOut(ctx, ['next', rid]).split('\n')) {
      if (l.startsWith('state=')) st += `${l.slice(6)} `;
      else if (l.startsWith('handoff=')) st += ` ${l} `;
    }
    ctx.out(` ${rid === act ? '*' : ' '} ${rid}  ${st === '' ? 'state unknown' : st}${wt ? ` (worktree .agents/local/worktrees/${rid})` : ''}\n`);
  }
  if (!found) ctx.out('  (none)\n');
  ctx.out('(* = active run)\n');
  return 0;
}
