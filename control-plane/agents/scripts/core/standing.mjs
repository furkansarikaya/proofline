// @ts-check
// Standing approvals (A361, issue 338 C3): what the user approved ONCE and the project carries to later tasks, batches and runs, as long as the thing approved
// is still the same. Two scopes: `rationale` (a DESIGN.md pattern justification, bound to the sha256 of its exact line) and `waiver` (a finding that was already
// there on the unchanged base, bound to its rule, its file and the file's blob at the base).
//
// Invariant 3: only the control plane writes the file, and only from `approveOne` after it has recorded an approval that the user's own message earned (answered_by
// user, source prompt_capture or tty). No agent command writes it; a role cannot create a row, and a row that is not a regular single-link file on a safe path is
// not read at all (nothing is then carried). `revoke` removes rows only on the user's own captured message. A row never covers anything but its own
// (scope, rule, surface, fingerprint); SECRETS and SECURITY are never stored (the callers refuse them before they get here).
// Format of STANDING.tsv, one row per line, TAB separated: scope, rule, surface, fingerprint, message id, date, answered_by, origin.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { captureField } from './capture.mjs';
import { fail } from './errors.mjs';
import { approvalNorm, latestCapture, safeStateFile, sharedDirOf } from './approvals.mjs';
import { sha256 } from './hash.mjs';
import { latin1Buf } from './wirebytes.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ scope: string, rule: string, surface: string, fp: string, message: string, date: string, by: string, origin: string }} StandingRow */

const SCOPES = ['rationale', 'waiver'];

/** The folder of the project-level store: shared by the main tree and every run worktree. @param {Context} ctx */
export function standingDir(ctx) { return sharedDirOf(ctx, 'standing'); }

/** @param {Context} ctx */
const filePath = (ctx) => `${standingDir(ctx)}/STANDING.tsv`;

/** A field is a plain single-line string without a TAB. @param {string} s */
const clean = (s) => s !== '' && !/[\t\r\n]/.test(s);

/**
 * The rows in force: every well-formed row answered by the user. An unsafe or unreadable file is empty (the safe side: the question is asked again).
 * @param {Context} ctx @returns {StandingRow[]}
 */
export function readStanding(ctx) {
  const f = filePath(ctx);
  if (!existsSync(f) || !safeStateFile(ctx, f)) return [];
  /** @type {StandingRow[]} */ const out = [];
  let text = '';
  try { text = readFileSync(f, 'latin1'); } catch { return []; }
  for (const l of text.split('\n')) {
    const p = l.split('\t');
    if (p.length !== 8 || !SCOPES.includes(p[0]) || p[6] !== 'user' || !p.slice(0, 6).every(clean) || !/^[0-9a-f]{64}$/.test(p[3])) continue;
    out.push({ scope: p[0], rule: p[1], surface: p[2], fp: p[3], message: p[4], date: p[5], by: p[6], origin: p[7] });
  }
  return out;
}

/**
 * The row for exactly this (scope, rule, surface, fingerprint), or null.
 * @param {Context} ctx @param {string} scope @param {string} rule @param {string} surface @param {string} fp @returns {StandingRow | null}
 */
export function findStanding(ctx, scope, rule, surface, fp) {
  return readStanding(ctx).find((r) => r.scope === scope && r.rule === rule && r.surface === surface && r.fp === fp) ?? null;
}

/** @param {Context} ctx @param {StandingRow[]} rows */
function writeAll(ctx, rows) {
  const dir = standingDir(ctx);
  mkdirSync(dir, { recursive: true });
  const f = filePath(ctx);
  const body = rows.map((r) => `${[r.scope, r.rule, r.surface, r.fp, r.message, r.date, r.by, r.origin].join('\t')}\n`).join('');
  writeFileSync(`${f}.tmp`, latin1Buf(body));
  renameSync(`${f}.tmp`, f);
}

/**
 * Record one standing approval. Called only from `approveOne`, right after the approval file of the user's message was written. A row with the same key is not
 * written twice (the first message stays its origin). Returns whether a row was added.
 * @param {Context} ctx @param {{ scope: string, rule: string, surface: string, fp: string, message: string, origin: string }} row
 */
export function addStanding(ctx, row) {
  if (!SCOPES.includes(row.scope) || !clean(row.rule) || !clean(row.surface) || !/^[0-9a-f]{64}$/.test(row.fp) || !clean(row.message) || !clean(row.origin)) return false;
  if (findStanding(ctx, row.scope, row.rule, row.surface, row.fp) !== null) return false;
  const rows = readStanding(ctx);
  rows.push({ ...row, date: now().iso, by: 'user' });
  writeAll(ctx, rows);
  ctx.forget('file:');
  return true;
}

/**
 * Is the rationale line (its sha256) one the user approved and the project carries, for this DESIGN.md? (A361; the per-run approval is looked up first by the callers)
 * @param {Context} ctx @param {string} rule @param {string} surface the project-relative path of the design document @param {string} hash
 */
export function rationaleCarried(ctx, rule, surface, hash) { return findStanding(ctx, 'rationale', rule, surface, hash) !== null; }

/** The lines the batch summary and `standing list` show. @param {StandingRow} r */
export function describeStanding(r) {
  return `${r.scope} ${r.rule} on ${r.surface} (content ${r.fp.slice(0, 12)}), approved by you in message ${r.message.slice(-12)} on ${r.date}, from ${r.origin}`;
}

/** @param {Context} ctx @returns {string} */
export function standingList(ctx) {
  const rows = readStanding(ctx);
  if (rows.length === 0) return 'standing approvals: none\n';
  return `standing approvals: ${rows.length}\n${rows.map((r) => `- ${describeStanding(r)}\n`).join('')}revoke one with the message "revoke <rule>" (then: agent.sh standing revoke <rule> [<surface>])\n`;
}

/**
 * `standing revoke RULE [SURFACE]`: removes the rows of the rule (and the surface, when given), only when the user's newest captured message says `revoke` and
 * names the rule (and the surface). The removed rows go to REVOKED.tsv with the message that revoked them. A question mark or a missing capture refuses.
 * @param {Context} ctx @param {string} rule @param {string} [surface]
 */
export function revokeStanding(ctx, rule, surface = '') {
  const rows = readStanding(ctx);
  const hit = rows.filter((r) => r.rule === rule && (surface === '' || r.surface === surface));
  if (hit.length === 0) fail(`no standing approval for ${rule}${surface === '' ? '' : ` on ${surface}`} (agent.sh standing list)`);
  const cap = latestCapture(ctx);
  if (cap === null) fail('revoke refused: there is no user prompt capture; a standing approval is revoked only by the user\'s own message');
  const buf = readFileSync(cap, 'latin1');
  const text = captureField(buf, 'text');
  const time = captureField(buf, 'time') ?? '';
  const session = captureField(buf, 'session') ?? 'unknown';
  if (text === null || sha256(text) !== (captureField(buf, 'sha256') ?? '')) fail('revoke refused: the capture is not intact');
  const norm = approvalNorm(`${text}\n`);
  if (text.includes('?')) fail('revoke refused: a question is not a revocation');
  const words = ` ${norm} `;
  const ruleWords = ` ${approvalNorm(`${rule}\n`)} `;
  if (!words.includes(' revoke ') || !words.includes(ruleWords)) fail(`revoke refused: the user's newest message must say "revoke ${rule}" (it says: ${text.slice(0, 80).replace(/\n/g, ' ')})`);
  if (surface !== '' && !words.includes(` ${approvalNorm(`${surface}\n`)} `)) fail(`revoke refused: the user's newest message names ${rule} but not the surface ${surface}`);
  const cid = `${session}:${time}:${sha256(text)}`;
  const keep = rows.filter((r) => !hit.includes(r));
  writeAll(ctx, keep);
  const dir = standingDir(ctx);
  const log = `${dir}/REVOKED.tsv`;
  const date = now().iso;
  appendFileSync(log, latin1Buf(hit.map((r) => `${[r.scope, r.rule, r.surface, r.fp, r.message, r.date, r.by, r.origin, cid, date].join('\t')}\n`).join('')));
  ctx.forget('file:');
  return hit;
}
