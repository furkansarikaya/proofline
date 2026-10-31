// @ts-check
// Dispatch markers of a run (agent.sh 6832-6870): `dispatch/*.running` files left by dispatch.sh while a specialist step is in flight.
// Shared by `pipeline` (the in_flight line) and `next` (the wait line, the stale-marker sweep and the time note).
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { BridgeToShell } from './errors.mjs';
import { isFile } from './paths.mjs';
import { fileText, textLines } from './records.mjs';
import { tmDispatchSeconds, tmWarnPercent } from './timeouts.mjs';
import { now } from './clock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The `*.running` markers of a run in glob order (no dot files, regular files only). @param {string} dir @returns {string[]} */
function markers(dir) {
  let names = [];
  try { names = readdirSync(`${dir}/dispatch`).filter((n) => n.endsWith('.running') && !n.startsWith('.')).sort(); } catch { return []; }
  return names.filter((n) => isFile(`${dir}/dispatch/${n}`));
}

/** The first line that starts with PREFIX, without it. @param {string[]} lines @param {string} prefix */
function lineValue(lines, prefix) { return (lines.find((l) => l.startsWith(prefix)) ?? '').slice(prefix.length); }

/** `inflight_pid_alive PID MARKER` @param {Context} ctx @param {string} pid @param {string} marker @param {string[]} lines */
export function inflightAlive(ctx, pid, marker, lines) {
  if (!/^[0-9]+$/.test(pid) || pid === '0') return false;
  try { process.kill(Number(pid), 0); } catch { return false; }
  let t = tmDispatchSeconds(ctx.config(), '');
  const m = lineValue(lines, 'timeout=');
  if (/^[0-9]+$/.test(m) && Number(m) <= t) t = Number(m);
  try { return Date.now() - statSync(marker).mtimeMs <= Math.floor((t + 119) / 60) * 60000; } catch { return false; }
}

/** The lines of a marker file. @param {Context} ctx @param {string} f */
function markerLines(ctx, f) { return textLines(fileText(ctx, f) ?? ''); }

/** `inflight_dispatch ID`: the role and pid of the first dispatch marker whose pid is alive, or null. @param {Context} ctx @param {string} dir */
export function inflightDispatch(ctx, dir) {
  for (const n of markers(dir)) {
    const f = `${dir}/dispatch/${n}`;
    const lines = markerLines(ctx, f);
    const role = lineValue(lines, 'role=');
    if (inflightAlive(ctx, lineValue(lines, 'pid='), f, lines)) return { role: role === '' ? 'specialist' : role, pid: lineValue(lines, 'pid=') };
  }
  return null;
}

/**
 * `inflight_sweep ID` without the removal: the names of the markers whose pid is dead (stale). The caller removes them with
 * `removeMarkers` once the command is sure to finish in Node (a hand-over to the shell must find them still there).
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
export function staleMarkers(ctx, dir) {
  return markers(dir).filter((n) => {
    const f = `${dir}/dispatch/${n}`;
    const lines = markerLines(ctx, f);
    return !inflightAlive(ctx, lineValue(lines, 'pid='), f, lines);
  });
}

/** `rm -f` of the stale markers. @param {string} dir @param {string[]} names */
export function removeMarkers(dir, names) {
  for (const n of names) { try { unlinkSync(`${dir}/dispatch/${n}`); } catch { /* gone already */ } }
}

/**
 * `budget_note ID`: one line per live dispatch that has used timeouts.warn_percent of its time (A202 item 29).
 * @param {Context} ctx @param {string} dir @returns {string}
 */
export function budgetNote(ctx, dir) {
  const pct = tmWarnPercent(ctx.config());
  const nowS = now().epoch;
  let out = '';
  for (const n of markers(dir)) {
    const f = `${dir}/dispatch/${n}`;
    const lines = markerLines(ctx, f);
    if (!inflightAlive(ctx, lineValue(lines, 'pid='), f, lines)) continue;
    const t = lineValue(lines, 'timeout='); const s = lineValue(lines, 'started_epoch=');
    if (!/^[0-9]+$/.test(t + s) || t === '' || s === '' || !(Number(t) > 0)) continue;
    const e = nowS - Number(s);
    if (!(e * 100 >= Number(t) * pct)) continue;
    const role = lineValue(lines, 'role=');
    // the shell reads "ROLE ELAPSED TIMEOUT" back with `read`: an empty or blank-bearing role shifts the fields (its own error text)
    if (role === '' || /[ \t]/.test(role)) throw new BridgeToShell('dispatch marker role');
    out += `note=TIME: dispatch ${role} has used ${Math.floor(e / 60)}m of its ${Math.floor(Number(t) / 60)}m limit (${Math.floor((e * 100) / Number(t))}%); at the limit it fails (never a pass) and the next dispatch of the step resumes from dispatch/RESUME-*.md. Do not stop it; tell the user in one line that this step is slow (proofline doctor --scale proposes a longer limit)\n`;
  }
  return out;
}
