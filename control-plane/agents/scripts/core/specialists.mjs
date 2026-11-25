// @ts-check
// B2 and B11 of issue #338: what the control plane knows about the specialists of a run that the Claude hooks started (SubagentStart writes
// `.agents/local/submissions/<token>.run` = "<ID> <ROLE>", `.started` while the specialist runs, and `.agents/local/windows/<token>` = the write window's fingerprint).
//   * A specialist whose window is open and whose `.started` marker is still there is RUNNING: `handoff IMPLEMENTED` says so and records nothing.
//   * A specialist that stopped (marker gone) but whose window is still open had its close time out on the lock: `handoff` closes it itself, under its own lock,
//     as the SubagentStop hook would have (the same `window-close`), so the tree is attested and no tree-accept question follows.
//   * A window file left behind when the run reaches CODE_DONE is cleaned.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { ProoflineError } from './errors.mjs';
import { gateField } from './records.mjs';
import { runDir } from './runs.mjs';
import { windowClose, windowFiles } from './commands/hookcmds.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** @param {string} p */
const text = (p) => { try { return readFileSync(p, 'latin1'); } catch { return ''; } };
/** @param {string} p */
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
/** @param {string} p */
const rmf = (p) => { try { rmSync(p, { force: true }); } catch { /* gone */ } };

/**
 * The specialists of run ID that the hooks registered in this tree.
 * @param {Context} ctx @param {string} id
 * @returns {{ token: string, role: string, running: boolean, window: string | null }[]}
 */
export function specialistsOf(ctx, id) {
  const sub = `${ctx.agents}/local/submissions`;
  let names = [];
  try { names = readdirSync(sub).filter((n) => n.endsWith('.run')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const token = n.slice(0, -4);
    if (!/^[A-Za-z0-9_.-]+$/.test(token)) continue;
    const m = /^([A-Za-z0-9_-]+) ([a-z_]+)\n?$/.exec(text(`${sub}/${n}`));
    if (!m || m[1] !== id) continue;
    const w = `${ctx.agents}/local/windows/${token}`;
    out.push({ token, role: m[2], running: isFile(`${sub}/${token}.started`), window: isFile(w) ? text(w).replace(/\n+$/, '') : null });
  }
  return out;
}

/**
 * `handoff IMPLEMENTED` (mode `close`): refuse while a specialist with an open window still runs; close the windows of the stopped ones.
 * `handoff CODE_DONE` (mode `clean`): drop what is left of the run's stopped specialists.
 * @param {Context} ctx @param {string} id @param {'close' | 'clean'} mode
 */
export function settleSpecialists(ctx, id, mode) {
  const dir = runDir(ctx, id);
  const all = specialistsOf(ctx, id);
  const running = all.filter((s) => s.running && s.window !== null);
  if (mode === 'close' && running.length > 0) {
    const s = running[0];
    throw new ProoflineError(`handoff: specialist still running: ${s.role} (${s.token}) holds an open write window. Nothing is recorded; wait for its result (its window closes when it stops), then run the handoff again`, 1, 'SPECIALIST_RUNNING');
  }
  for (const s of all) {
    if (s.running) continue;
    if (s.window !== null && mode === 'close' && (s.role === 'implementer' || s.role === 'designer')) {
      const ev = `${dir}/worker-evidence`;
      const wins = windowFiles(ev);
      const last = wins.length > 0 ? `${ev}/${wins[wins.length - 1]}` : '';
      // closed by the hook while this command waited for its lock: the last record began at this window's fingerprint
      const closed = last !== '' && gateField(ctx, last, 'before_sha256') === s.window && gateField(ctx, last, 'role') === s.role;
      if (!closed) windowClose(ctx, [id, s.window, '0', s.role]);
      ctx.out(`handoff: closed the write window of the stopped ${s.role} (${s.token}), which its SubagentStop hook could not close\n`);
    }
    if (s.window !== null) rmf(`${ctx.agents}/local/windows/${s.token}`);
    rmf(`${ctx.agents}/local/submissions/${s.token}.run`);
  }
}
