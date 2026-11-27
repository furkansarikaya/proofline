// @ts-check
// Standing approvals (A361, issue 338 C3): what the user approved ONCE and the project carries to later tasks, batches and runs, as long as the thing approved
// is still the same. Two scopes: `rationale` (a DESIGN.md pattern justification, bound to the sha256 of its exact line) and `waiver` (a finding that was already
// there on the unchanged base, bound to its rule, its file and the file's blob at the base).
//
// Invariant 3: only the control plane writes the file, and only from `approveOne` after it has recorded an approval that the user's own message earned (answered_by
// user, source prompt_capture or tty). No agent command writes it; a role cannot create a row, and a row that is not a regular single-link file on a safe path is
// not read at all (nothing is then carried). `revoke` removes rows only on the user's own captured message. A row never covers anything but its own
// (scope, rule, surface, fingerprint); SECRETS and SECURITY are never stored (the callers refuse them before they get here).
// Format of STANDING.tsv, one row per line, TAB separated: scope, rule, surface, fingerprint, message id, date, answered_by, origin, named; a `measure` row
// (A380, a measured visual item: rule = the check, surface = `page:<path>` or `kind:<kind>:<glob>`, standingmeasure.mjs) adds a tenth field, the approved value.
// A row is created only when the user's reply said the word `standing` (or the Turkish kalici) in the segment that names the rationale or the finding (never by the approval alone),
// and it counts only while it VERIFIES at use time (`verifyRow`): the message id must be a message of the prompt history whose bytes still hash to it, and that message must still
// say an approval phrase, the named rationale or finding and `standing` in one segment. A row planted by hand without such a message carries nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { captureField } from './capture.mjs';
import { fail } from './errors.mjs';
import { HEDGE_WORDS, approvalNorm, approvalPhrases, latestCapture, promptsDir, safeStateFile, sharedDirOf } from './approvals.mjs';
import { sha256 } from './hash.mjs';
import { latin1Buf } from './wirebytes.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ scope: string, rule: string, surface: string, fp: string, message: string, date: string, by: string, origin: string, named: string, value?: string }} StandingRow */

const SCOPES = ['rationale', 'waiver', 'measure'];
const VALUE = /^-?[0-9]+(?:\.[0-9]+)?$/;
/** The fields of a row as written (a measure row carries its approved value). @param {StandingRow} r */
const fields = (r) => [r.scope, r.rule, r.surface, r.fp, r.message, r.date, r.by, r.origin, r.named, ...(r.scope === 'measure' ? [r.value ?? ''] : [])];

/** The folder of the project-level store: shared by the main tree and every run worktree. @param {Context} ctx */
export function standingDir(ctx) { return sharedDirOf(ctx, 'standing'); }

/** @param {Context} ctx */
const filePath = (ctx) => `${standingDir(ctx)}/STANDING.tsv`;

/** A field is a plain single-line string without a TAB. @param {string} s */
const clean = (s) => s !== '' && !/[\t\r\n]/.test(s);

const bs = (/** @type {string} */ x) => Buffer.from(x, 'utf8').toString('latin1');
/** Turkish refusals the shared hedge list does not carry (ASCII and UTF-8 spellings, normalised like the reply). */
const HEDGE_EXTRA = ` olmasin olmasın ${approvalNorm(bs('olmasın\n'))} degildir hayir `;
const STAND_WORDS = [' standing ', ' kalici ', ` ${approvalNorm(bs('kalıcı\n'))} `];

/**
 * Does one text say, in ONE segment (a line, or the part between , and ;), an approval phrase, the NAMED word and `standing`? Quoted lines and questions never count.
 * @param {Context} ctx @param {string} text a byte string @param {string} named the normalised name (`mono-labels`, `qa-1`)
 */
export function standingSaid(ctx, text, named) {
  if (named === '') return false;
  const pl = approvalPhrases(ctx).split(',').map(approvalNorm).filter((w) => w !== '');
  for (const line of text.split('\n')) {
    if (/^\s*(>|~~~|\x60\x60\x60)/.test(line)) continue;
    // a negation or a hedge anywhere in the LINE ("not standing", "standing, kalici degil", "olmasin", "but ...") is no decision to keep: checked here, not left to the grammar of the approval
    if (approvalNorm(`${line}\n`).split(' ').some((w) => w !== '' && (HEDGE_WORDS.includes(` ${w} `) || HEDGE_EXTRA.includes(` ${w} `)))) continue;
    for (const seg of line.split(/[,;]/)) {
      if (seg.includes('?')) continue;
      const n = ` ${approvalNorm(`${seg}\n`)} `;
      if (n.includes(` ${named} `) && STAND_WORDS.some((w) => n.includes(w)) && pl.some((w) => n.includes(` ${w} `))) return true;
    }
  }
  return false;
}

/** The message the row names, if it is intact in the prompt history; else null. @param {Context} ctx @param {string} id @returns {string | null} */
function messageText(ctx, id) {
  const m = /^([A-Za-z0-9._-]+):([0-9]+):([0-9a-f]{64})$/.exec(id);
  if (m === null) return null;
  const f = `${promptsDir(ctx)}/history/${m[2]}-${m[3].slice(0, 8)}.txt`;
  if (!existsSync(f) || !safeStateFile(ctx, f)) return null;
  let t;
  try { t = readFileSync(f, 'latin1'); } catch { return null; }
  return sha256(t) === m[3] ? t : null;
}

/** A row counts only when the user's message it cites still says the approval and `standing` for the thing named. @param {Context} ctx @param {StandingRow} r */
function verifyRow(ctx, r) {
  // the name the message must carry is the row's own: a rationale row names its rule; a waiver row names a finding id (`qa-1`, `review_rules-3`) or its rule. A row cannot cite another rule's real message.
  if (r.scope === 'rationale' ? r.named !== approvalNorm(`${r.rule}\n`) : !(r.named === approvalNorm(`${r.rule}\n`) || /^[a-z][a-z0-9_]*-[0-9]+$/.test(r.named))) return false;
  const t = messageText(ctx, r.message);
  return t !== null && standingSaid(ctx, t, r.named);
}

/** Every well-formed row of the file, verified or not (what `standing list` and `revoke` work on). @param {Context} ctx @returns {StandingRow[]} */
export function readStandingRaw(ctx) {
  const f = filePath(ctx);
  if (!existsSync(f) || !safeStateFile(ctx, f)) return [];
  /** @type {StandingRow[]} */ const out = [];
  let text = '';
  try { text = readFileSync(f, 'latin1'); } catch { return []; }
  for (const l of text.split('\n')) {
    const p = l.split('\t');
    if (p.length !== (p[0] === 'measure' ? 10 : 9) || !SCOPES.includes(p[0]) || p[6] !== 'user' || !p.every(clean) || !/^[0-9a-f]{64}$/.test(p[3])) continue;
    if (p[0] === 'measure' && !VALUE.test(p[9])) continue;
    out.push({ scope: p[0], rule: p[1], surface: p[2], fp: p[3], message: p[4], date: p[5], by: p[6], origin: p[7], named: p[8], ...(p[0] === 'measure' ? { value: p[9] } : {}) });
  }
  return out;
}

/**
 * The rows in force: the well-formed rows answered by the user whose message verifies. An unsafe or unreadable file is empty (the safe side: the question is asked again).
 * @param {Context} ctx @returns {StandingRow[]}
 */
export function readStanding(ctx) { return ctx.once('standing:rows', () => readStandingRaw(ctx).filter((r) => verifyRow(ctx, r))); }

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
  const body = rows.map((r) => `${fields(r).join('\t')}\n`).join('');
  writeFileSync(`${f}.tmp`, latin1Buf(body));
  renameSync(`${f}.tmp`, f);
}

/**
 * Record one standing approval. Called only from `approveOne`, right after the approval file of the user's message was written. A row with the same key is not
 * written twice (the first message stays its origin). Returns whether a row was added.
 * @param {Context} ctx @param {{ scope: string, rule: string, surface: string, fp: string, message: string, origin: string, named: string, value?: string }} row
 */
export function addStanding(ctx, row) {
  if (!clean(row.named) || !SCOPES.includes(row.scope) || !clean(row.rule) || !clean(row.surface) || !/^[0-9a-f]{64}$/.test(row.fp) || !clean(row.message) || !clean(row.origin)) return false;
  if ((row.scope === 'measure') !== (row.value !== undefined) || (row.value !== undefined && !VALUE.test(row.value))) return false;
  if (findStanding(ctx, row.scope, row.rule, row.surface, row.fp) !== null) return false;
  const rows = readStandingRaw(ctx);
  rows.push({ ...row, date: now().iso, by: 'user' });
  writeAll(ctx, rows);
  ctx.forget('file:'); ctx.forget('standing:');
  return true;
}

/**
 * Is the rationale line (its sha256) one the user approved and the project carries, for this DESIGN.md? (A361; the per-run approval is looked up first by the callers)
 * @param {Context} ctx @param {string} rule @param {string} surface the project-relative path of the design document @param {string} hash
 */
export function rationaleCarried(ctx, rule, surface, hash) { return findStanding(ctx, 'rationale', rule, surface, hash) !== null; }

/** The lines the batch summary and `standing list` show. @param {StandingRow} r */
export function describeStanding(r) {
  if (r.scope === 'measure') {
    const k = /^kind:([^:]+):(.*)$/.exec(r.surface);
    const where = r.surface.startsWith('page:') ? `the page ${r.surface.slice(5)}` : k === null ? r.surface : `pages of kind ${k[1]} (paths ${k[2]})`;
    return `measure ${r.rule} on ${where} at a value no worse than ${r.value}, approved by you in message ${r.message.slice(-12)} on ${r.date}, from ${r.origin}`;
  }
  return `${r.scope} ${r.rule} on ${r.surface} (content ${r.fp.slice(0, 12)}), approved by you in message ${r.message.slice(-12)} on ${r.date}, from ${r.origin}`;
}

/** @param {Context} ctx @returns {string} */
export function standingList(ctx) {
  const rows = readStanding(ctx);
  const ignored = readStandingRaw(ctx).length - rows.length;
  const note = ignored > 0 ? `${ignored} row(s) of the file do not verify against a message of yours and are ignored (revoke them by name to remove them)\n` : '';
  if (rows.length === 0) return `standing approvals: none\n${note}`;
  return `standing approvals: ${rows.length}\n${rows.map((r) => `- ${describeStanding(r)}\n`).join('')}${note}revoke one with the message "revoke <rule>" (then: agent.sh standing revoke <rule> [<surface>])\n`;
}

/**
 * `standing revoke RULE [SURFACE]`: removes the rows of the rule (and the surface, when given), only when the user's newest captured message says `revoke` and
 * names the rule (and the surface). The removed rows go to REVOKED.tsv with the message that revoked them. A question mark or a missing capture refuses.
 * @param {Context} ctx @param {string} rule @param {string} [surface]
 */
export function revokeStanding(ctx, rule, surface = '') {
  const rows = readStandingRaw(ctx);
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
  appendFileSync(log, latin1Buf(hit.map((r) => `${[...fields(r), cid, date].join('\t')}\n`).join('')));
  ctx.forget('file:'); ctx.forget('standing:');
  return hit;
}
