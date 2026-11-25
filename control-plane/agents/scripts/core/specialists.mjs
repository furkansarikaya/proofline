// @ts-check
// B2 and B11 of issue #338: what the control plane knows about the specialists of a run that the Claude hooks started (SubagentStart writes
// `.agents/local/submissions/<token>.run` = "<ID> <ROLE>", `.started` while the specialist runs, and `.agents/local/windows/<token>` = the write window's fingerprint).
//   * A specialist whose window is open and whose `.started` marker is still there is RUNNING: `handoff IMPLEMENTED` says so and records nothing.
//   * A specialist that stopped (marker gone) but whose window is still open had its close time out on the lock: `handoff` closes it itself, under its own lock,
//     as the SubagentStop hook would have (the same `window-close`), so the tree is attested and no tree-accept question follows.
//   * A window file left behind when the run reaches CODE_DONE is cleaned.
// Accepted limit and its way out (A351): when SubagentStop never fires (the session was killed, the hook crashed) `.started` stays, the specialist counts as running
// and `handoff IMPLEMENTED` refuses while the tree differs from the last attested one. The way out is the user's: `tree-inspect`, then `tree-accept` (the user's recorded
// approval of exactly this tree). A user WINDOW record written after the marker was made (`.started`, line 2) ends the claim of that specialist; nothing is closed for it.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { ProoflineError } from './errors.mjs';
import { sha256 } from './hash.mjs';
import { taskPatchFingerprint } from './gates.mjs';
import { gateField, gatesEnforced } from './records.mjs';
import { runDir } from './runs.mjs';
import { topology, windowClose, windowFiles } from './commands/hookcmds.mjs';

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

/** The last attested tree of the run: the `after_sha256` of the last WINDOW record, else the empty tree. @param {Context} ctx @param {string} dir */
function lastAttestedTree(ctx, dir) {
  const ev = `${dir}/worker-evidence`;
  const wins = windowFiles(ev);
  return wins.length > 0 ? gateField(ctx, `${ev}/${wins[wins.length - 1]}`, 'after_sha256') : sha256('');
}

/** Did the user accept a tree (a `user` WINDOW record) after this specialist's marker was made? @param {Context} ctx @param {string} dir @param {string} token */
function acceptedSinceStart(ctx, dir, token) {
  const startedAt = Number(text(`${ctx.agents}/local/submissions/${token}.started`).split('\n')[1] ?? '');
  if (!(startedAt > 0)) return false;
  const ev = `${dir}/worker-evidence`;
  return windowFiles(ev).some((w) => gateField(ctx, `${ev}/${w}`, 'role') === 'user' && Date.parse(gateField(ctx, `${ev}/${w}`, 'timestamp')) / 1000 >= startedAt);
}

/**
 * `handoff IMPLEMENTED` (mode `close`): refuse while a specialist with an open window still runs and the tree differs from the last attested one; close the windows of the stopped ones.
 * `handoff CODE_DONE` (mode `clean`): drop what is left of the run's stopped specialists.
 * @param {Context} ctx @param {string} id @param {'close' | 'clean'} mode
 */
export function settleSpecialists(ctx, id, mode) {
  const dir = runDir(ctx, id);
  const all = specialistsOf(ctx, id);
  if (mode === 'close') {
    const running = all.filter((s) => s.running && s.window !== null);
    // a specialist the user's tree-accept came after is gone for good: its claim ends (its files are dropped), nothing is closed for it
    const live = running.filter((s) => !acceptedSinceStart(ctx, dir, s.token));
    if (live.length > 0 && taskPatchFingerprint(ctx, dir) !== lastAttestedTree(ctx, dir)) {
      const s = live[0];
      throw new ProoflineError(`handoff: specialist still running: ${s.role} (${s.token}) holds an open write window. Nothing is recorded; wait for its result (its window closes when it stops), then run the handoff again. If it is gone (session ended or killed, so its stop hook never ran and the marker .agents/local/submissions/${s.token}.started is stale), ask the USER: agent.sh tree-inspect ${id} shows the change, agent.sh tree-accept ${id} records the user's approval of exactly this tree, then run the handoff again`, 1, 'SPECIALIST_RUNNING');
    }
    for (const s of running) if (acceptedSinceStart(ctx, dir, s.token)) { rmf(`${ctx.agents}/local/windows/${s.token}`); rmf(`${ctx.agents}/local/submissions/${s.token}.run`); }
  }
  for (const s of all) {
    if (s.running) continue;
    if (s.window !== null && mode === 'close' && (s.role === 'implementer' || s.role === 'designer')) {
      const ev = `${dir}/worker-evidence`;
      const wins = windowFiles(ev);
      const last = wins.length > 0 ? `${ev}/${wins[wins.length - 1]}` : '';
      // closed by the hook while this command waited for its lock: the last record began at this window's fingerprint, ended at the current tree and is the specialist's role
      const closed = last !== '' && gateField(ctx, last, 'before_sha256') === s.window && gateField(ctx, last, 'role') === s.role && gateField(ctx, last, 'after_sha256') === taskPatchFingerprint(ctx, dir);
      if (!closed) {
        windowClose(ctx, [id, s.window, '0', s.role]);
        if (gatesEnforced(ctx, dir) && topology(ctx, dir) === 'orchestrated') ctx.out(`handoff: closed the write window of the stopped ${s.role} (${s.token}), which its SubagentStop hook could not close\n`);
      }
    }
    if (s.window !== null) rmf(`${ctx.agents}/local/windows/${s.token}`);
    rmf(`${ctx.agents}/local/submissions/${s.token}.run`);
  }
}
