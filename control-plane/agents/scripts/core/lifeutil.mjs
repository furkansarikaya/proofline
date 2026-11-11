// @ts-check
// Stage 4, package 4B: the small helpers the lifecycle commands share (start, freeze, refreeze, handoff, terminate, amend, reopen, cleanup).
// Each one is the shell function of agent.sh 0.0.47 of the same name, without its process starts.
import { readFileSync } from 'node:fs';
import { asciiLower } from './shellglob.mjs';
import { bytes } from './config.mjs';
import { ProoflineError, unsupported } from './errors.mjs';
import { ledgerAppend } from './ledger.mjs';
import * as proc from './proc.mjs';
import { WS } from './records.mjs';
import { runDir } from './runs.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** A mandatory argument (`${2:?usage}`). @param {string[]} args @param {number} i */
export function need(args, i) {
  const v = args[i];
  if (v === undefined || v === '') throw unsupported('usage');
  return bytes(v);
}

/** `ledger_append ID EVENT FROM TO DETAIL` @param {Context} ctx @param {string} id @param {string} event @param {string} from @param {string} to @param {string} detail */
export function led(ctx, id, event, from, to, detail) {
  ledgerAppend(runDir(ctx, id), ctx.role, event, from, to, detail);
  ctx.forget('file:');
}

/** `one_line TEXT`: newlines and tabs become blanks. @param {string} s */
export const oneLine = (s) => s.replace(/[\n\t]/g, ' ');

/** `reject_generic_justification TEXT`, true when the reason is accepted. @param {string} text */
export function justificationOk(text) {
  const norm = asciiLower(text).replace(new RegExp(`^${WS}+`), '').replace(new RegExp(`${WS}+$`), '').replace(new RegExp(`${WS}+`, 'g'), ' ');
  if (['', 'tdd not needed', 'test not needed', 'no test needed', 'not needed', 'configuration change', 'n/a', 'na'].includes(norm)) return false;
  return norm.length >= 20;
}

/** `field_from FILE KEY` over the text: the first `KEY:` line without the key and the blanks after it. @param {string} text @param {string} key */
export function fieldFromText(text, key) {
  const pre = `${key}:`;
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  for (const l of rows) if (l.startsWith(pre)) return l.slice(pre.length).replace(/^ +/, '');
  return '';
}

/** What a command reads from its stdin (`cat > scratch`). */
export function readStdin() {
  try { return readFileSync(0, 'latin1'); } catch { return ''; }
}

/** Run a function and drop what it wrote to stdout (`>/dev/null`; stderr stays). @template T @param {Context} ctx @param {() => T} fn @returns {T} */
export function quietly(ctx, fn) {
  const mark = ctx.chunks.length;
  try { return fn(); } finally {
    const kept = ctx.chunks.slice(0, mark);
    for (const c of ctx.chunks.slice(mark)) if (c[0] === 'err') kept.push(c);
    ctx.chunks.length = 0;
    ctx.chunks.push(...kept);
  }
}

/**
 * Run a command of agent.sh that is still shell code (stage 5) as a clean child of this process: the parent holds the locks and the child, whose
 * parent it is, takes them over (a lock whose pid file names the child's parent is the parent's own transaction).
 * @param {Context} ctx @param {string[]} argv @param {{ input?: string }} [o] @returns {{ status: number, out: string, err: string }}
 */
export function shellChild(ctx, argv, o = {}) {
  ctx.flush();
  const r = proc.runScript([`${ctx.scripts}/agent.sh`, ...argv], {
    cwd: ctx.cwd, env: ctx.childEnv(), input: o.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], allowEqualTree: true,
  });
  return { status: r.status, out: r.stdout.toString('latin1'), err: r.stderr.toString('latin1') };
}

/** A verify function that returned a non-zero status after printing its own reason stops the command with that status (the shell's `set -e`). @param {number} rc */
export function must(rc) {
  if (rc !== 0) throw new ProoflineError('', rc);
}
