// @ts-check
// `proofline queue` (bin/proofline cmd_queue): task files and runs, as the shell front end printed them. The state of a run comes from
// `agent.sh next` (a child per run, as before; it is served by the core once `next` moves: NEEDS-LATER, an in-process call).
import { openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const isFileF = (/** @type {string} */ f) => { try { return statSync(f).isFile(); } catch { return false; } };
const isDirF = (/** @type {string} */ f) => { try { return statSync(f).isDirectory(); } catch { return false; } };

/** `"$dir"/*.md` that are files, in glob order. @param {string} dir */
function mdFiles(dir) {
  let names = [];
  try { names = readdirSync(dir, { encoding: 'latin1' }); } catch { return []; }
  return names.filter((n) => n.endsWith('.md') && !n.startsWith('.') && isFileF(`${dir}/${n}`)).sort();
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
  const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, ...argv], { cwd: ctx.root, env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.stdout.toString('latin1');
}

/** @param {Context} ctx */
export function queue(ctx) {
  const tdName = ctx.config().get('tasks.dir', '.agents/tasks');
  const td = `${ctx.root}/${tdName}`;
  ctx.out(`tasks (${tdName}):\n`);
  let found = false;
  for (const d of ['todo', 'backlog']) for (const n of mdFiles(`${td}/${d}`)) { ctx.out(`  ${d}/${n}\n`); found = true; }
  for (const n of mdFiles(td)) { ctx.out(`  ${n}\n`); found = true; }
  if (!found) ctx.out('  (none)\n');
  let dn = 0;
  for (const n of mdFiles(`${td}/done`)) {
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
  const sub = (/** @type {string} */ d) => { try { return readdirSync(d, { encoding: 'latin1' }).filter((n) => !n.startsWith('.') && isDirF(`${d}/${n}`)).sort(); } catch { return []; } };
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
