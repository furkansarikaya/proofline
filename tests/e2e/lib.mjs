// @ts-check
// The decision helpers of the e2e harness (tests/e2e/run.mjs), the Node form of pending-kind.sh, question-open.sh and reply-decision.sh (176-C2).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const KINDS = 'plan|destructive|single_step|scope|budget|commit|push|waive:[^ ]+';

/**
 * The approval kind the run waits for, from the output of `agent.sh next <ID>`: a `request-approval <ID> <kind>` step, or a `reason=<kind> approval ...`
 * line; else (A128) the newest file of the approvals folder when it is an unanswered `NNN-request-<kind>.yaml` (agent.sh turns ':' into '-': waive-F-1
 * is waive:F-1). Empty when none.
 * @param {string} state @param {string} [approvalsDir]
 */
export function pendingKind(state, approvalsDir) {
  for (const line of state.split('\n')) {
    const f = line.split(/[ \t]+/).filter((x) => x !== '');
    if (new RegExp(`request-approval [^ ]+ (${KINDS})`).test(line)) {
      const i = f.indexOf('request-approval');
      if (i >= 0) return f[i + 2] ?? '';
    }
    if (line.startsWith('reason=')) {
      const a = line.slice('reason='.length).split(/[ \t]+/).filter((x) => x !== '');
      if (a.length >= 2 && a[1] === 'approval') return a[0] ?? '';
    }
  }
  if (approvalsDir && existsSync(approvalsDir)) {
    const newest = listDir(approvalsDir).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).at(-1) ?? '';
    if (/^[0-9].*-request-.*\.yaml$/.test(newest)) {
      let kind = newest.slice(newest.indexOf('-request-') + '-request-'.length).replace(/\.yaml$/, '');
      if (kind.startsWith('waive-')) kind = `waive:${kind.slice('waive-'.length)}`;
      return kind;
    }
  }
  return '';
}

/**
 * Is a question open: the run names a pending question, or the lead's last message asks one (it holds a question mark) while the run has no step of its
 * own to take: no task yet, or `next` names no `agent.sh` step (A131/A120).
 * @param {string} state @param {string} lastFile @param {string} [id]
 */
export function questionOpen(state, lastFile, id = 'none') {
  if (state.includes('a question is pending')) return true;
  if (id !== '' && id !== 'none' && /^next=agent\.sh /m.test(state)) return false;
  try { return /[?？]/.test(readFileSync(lastFile, 'utf8')); } catch { return false; }
}

/**
 * What the harness does at a stop (A128): `plan` (answer the approval), `question` (the scripted question reply may be sent) or `stop` (never answer).
 * With no kind, a commit or push request in the text decides (the accepted-answers line of an approval question is skipped).
 * @param {string} kind @param {string} [text]
 * @returns {'plan' | 'question' | 'stop'}
 */
export function replyDecision(kind, text = '') {
  if (kind === 'plan') return 'plan';
  if (kind !== '') return 'stop';
  const hit = text.split('\n').filter((l) => !/accepted answers:|kabul edilen onay/i.test(l)).some((l) => /approve (the )?(commit|push)|commit approval|push approval|commit it|push it/i.test(l));
  return hit ? 'stop' : 'question';
}

/** The kind of a request file slug (`agent.sh` only turns ':' into '-': waive-F-1 is waive:F-1). @param {string} slug */
const slugKind = (slug) => (slug.startsWith('waive-') ? `waive:${slug.slice('waive-'.length)}` : slug);
/** The names in a folder; none when it is not a readable folder (a file, ENOTDIR, EACCES): the loop then ends with a stop reason instead of a crash. @param {string} dir @returns {string[]} */
function listDir(dir) { try { return readdirSync(dir); } catch { return []; } }
const byteSort = (/** @type {string} */ x, /** @type {string} */ y) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Every approval request of the run nobody answered: `NNN-request-<kind>.yaml` files that no answer file names in its `request:` line. This is the
 * whole stop, not only the newest request: a refreeze raises a plan AND a scope request at once (the COMPLEX run of 2026-11-16 had 003-request-plan and
 * 004-request-scope open, and the newest-file rule saw only `scope`).
 * @param {string} [approvalsDir] @returns {{ name: string, kind: string, bound: string }[]}
 */
export function openApprovals(approvalsDir) {
  if (!approvalsDir || !existsSync(approvalsDir)) return [];
  const names = listDir(approvalsDir).sort(byteSort);
  const read = (/** @type {string} */ n) => { try { return readFileSync(path.join(approvalsDir, n), 'utf8'); } catch { return ''; } };
  const answered = new Set();
  for (const n of names) {
    if (!/^[0-9]+-/.test(n) || n.includes('-request-') || !n.endsWith('.yaml')) continue;
    const m = /^request: "?([^"\n]+?)"?\s*$/m.exec(read(n));
    if (m) answered.add(m[1]);
  }
  return names.filter((n) => /^[0-9]+-request-.+\.yaml$/.test(n) && !answered.has(n)).map((name) => ({
    name,
    kind: slugKind(name.slice(name.indexOf('-request-') + '-request-'.length).replace(/\.yaml$/, '')),
    bound: /^bound: "?([^"\n]*?)"?\s*$/m.exec(read(name))?.[1] ?? '',
  }));
}

/**
 * How many times the plan was frozen again after an amendment: the distinct plan hashes the run asked approval for, minus the first. C-14 allows one
 * more answer for each. A lead that re-asks the same plan gives the same hash and does not raise the allowance.
 * @param {string} [approvalsDir]
 */
export function refreezeCount(approvalsDir) {
  if (!approvalsDir || !existsSync(approvalsDir)) return 0;
  const bounds = new Set();
  for (const n of listDir(approvalsDir)) {
    if (!/^[0-9]+-request-plan\.yaml$/.test(n)) continue;
    try { bounds.add(/^bound: "?([^"\n]*?)"?\s*$/m.exec(readFileSync(path.join(approvalsDir, n), 'utf8'))?.[1] ?? ''); } catch { bounds.add(''); }
  }
  return Math.max(0, bounds.size - 1);
}

/** The absolute ceiling of harness replies, whatever the allowance: a bug that keeps raising approval requests cannot loop forever. */
export const HARD_REPLY_CAP = 12;

/**
 * The reply allowance (C-14): `base` answers (default 3) plus one for every refreeze plus one for every listed approval sent (A328: a listed message is a user message
 * the scenario file names in advance and bounds by max-uses, so it does not use up the answers of the other replies), never above the hard cap.
 * @param {number} base @param {number} refreezes @param {number} [listed]
 */
export const replyBudget = (base, refreezes, listed = 0) => Math.min(HARD_REPLY_CAP, base + refreezes + listed);

/**
 * The decision at a stop with the whole set of open requests: a refreeze raises a `plan` and a `scope` request together (the amended plan and its
 * scope change) and exactly that pair gets one `refreeze` reply, which approves the PLAN only (the scope request stays open, X-13); a `scope` request alone (an unrequested fix, X-13) and every other kind stay
 * unanswered. Else the single-kind rule of {@link replyDecision}.
 * @param {string} kind @param {{ kind: string }[]} open @param {string} [text]
 * @returns {'plan' | 'refreeze' | 'question' | 'stop'}
 */
export function stopDecision(kind, open, text = '') {
  const kinds = [...new Set(open.map((o) => o.kind))].sort(byteSort);
  if (kinds.length === 2 && kinds[0] === 'plan' && kinds[1] === 'scope') return 'refreeze';
  if (kinds.length > 1) return 'stop';
  return replyDecision(kinds.length === 1 ? (kinds[0] ?? kind) : kind, text);
}

/**
 * The scripted question replies of a scenario: the non-empty lines of `question.<SCENARIO>.txt`, one per question stop in order, the last one
 * repeating; the generic file gives line 1 only.
 * @param {string} file @param {boolean} generic the file is the generic `<SCENARIO>.txt` (line 1 is the question reply, the rest are approvals)
 * @returns {string[]}
 */
export function questionScript(file, generic) {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  return generic ? [lines[0] ?? ''].filter((l) => l !== '') : lines.filter((l) => l.trim() !== '');
}

// ---- Listed approvals (A328) ----------------------------------------------------------------------------------------------------------------------
// The harness has NO privileged path for an approval only the user gives. A scenario may, like a real user, SEND such a message through the same prompt path as every
// other reply (the lead is resumed with the text as the user's prompt) when the scenario file `replies/approvals.<SCENARIO>.txt` LISTS that exact message for that
// kind of request. Nothing outside the file is ever sent; the kinds below are the only ones a file may name.

/** The kinds a listing may name: user-only approvals whose message is a plain approval, and the assumption acceptance (`accept AS-N`, a question, not an approvals/ request). */
export const LISTABLE_KINDS = ['scope', 'destructive', 'mutation_budget', 'assumption'];
/**
 * Never listed, never sent, whatever the file says: a waiver (a waiver must never come from the harness), commit, push, pull request, merge, delivery, anything of the
 * SECRETS or SECURITY gates. `plan` is the scripted line 2 and 3 of the scenario's reply file, not a listing.
 */
export const FORBIDDEN_WORDS = /\b(waive|waived|waiver|waivers|commit|commits|committed|push|pushed|merge|merged|delivery|deliver|pr|pull request|pull-request|secret|secrets|security|feragat|teslimat|teslimatı|teslimati)\b/i;
/** The words a message of each listable kind holds; a message names exactly one kind (assumption: only the form `accept AS-<n>`). */
const KIND_PATTERN = { scope: /\bscope\b/i, destructive: /\bdestructive\b/i, mutation_budget: /\bmutation budget\b/i, assumption: /^accept AS-[0-9]+$/ };
/** The most lines and the most message uses one listing may hold: it stays well under the hard reply cap. */
export const LISTING_MAX_LINES = 6;
export const LISTING_MAX_USES = 6;

/**
 * Is this (kind, message) pair one a listing may carry? The loader and {@link pickListed} both ask, so a hand-built entry is judged the same way.
 * @param {string} kind @param {string} message @returns {string} the reason it may not, or '' when it may
 */
export function listedProblem(kind, message) {
  if (!LISTABLE_KINDS.includes(kind)) return `kind '${kind}' may never be listed (allowed: ${LISTABLE_KINDS.join(', ')}; a waiver, commit, push, delivery, merge, secrets and security approval, and plan, never come from the harness)`;
  if (message.trim() === '' || message !== message.trim()) return 'the message is empty or has leading or trailing space';
  if (/[\n\r]/.test(message) || message.includes('?')) return 'the message must be one line without a question mark';
  if (FORBIDDEN_WORDS.test(message)) return `the message '${message}' holds a waiver, commit, push, merge, delivery, secrets or security word`;
  if (!KIND_PATTERN[/** @type {keyof typeof KIND_PATTERN} */ (kind)].test(message)) return `the message '${message}' is not a ${kind} approval (it must name the kind)`;
  for (const k of LISTABLE_KINDS) if (k !== kind && KIND_PATTERN[/** @type {keyof typeof KIND_PATTERN} */ (k)].test(message)) return `the message '${message}' also names the ${k} kind`;
  return '';
}

/**
 * Load a listing file: `kind | exact message [| max-uses]` per line, `#` comments and blank lines ignored, max-uses defaults to 1. An absent file is an empty
 * listing (a scenario without one behaves as before). Anything else wrong throws, so the harness fails at startup.
 * @param {string} file @returns {{ kind: string, message: string, max: number }[]}
 */
export function loadListedApprovals(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  let n = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    n++;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const fail = (/** @type {string} */ why) => { throw new Error(`${file}:${n}: ${why}`); };
    const parts = raw.replace(/\r$/, '').split(' | ');
    if (parts.length < 2 || parts.length > 3) fail("expected 'kind | message' or 'kind | message | max-uses'");
    const kind = (parts[0] ?? '').trim();
    const message = parts[1] ?? '';
    let max = 1;
    if (parts.length === 3) {
      const m = (parts[2] ?? '').trim();
      if (!/^[1-9][0-9]*$/.test(m)) fail(`max-uses '${m}' is not a positive whole number`);
      max = Number(m);
    }
    const why = listedProblem(kind, message);
    if (why) fail(why);
    entries.push({ kind, message, max });
  }
  if (entries.length > LISTING_MAX_LINES) throw new Error(`${file}: more than ${LISTING_MAX_LINES} lines`);
  if (entries.reduce((s, e) => s + e.max, 0) > LISTING_MAX_USES) throw new Error(`${file}: the max-uses add up to more than ${LISTING_MAX_USES}`);
  return entries;
}

/**
 * The ids of the high-risk assumptions the lead's open questions ask the user to accept: the `ASSUMPTION: AS-<n>@<hash>` lines of `agent.sh questions <ID>`.
 * @param {string} questionsText @returns {string[]}
 */
export function openAssumptions(questionsText) {
  return [...new Set([...questionsText.matchAll(/^\s*ASSUMPTION: (AS-[0-9]+)@/gm)].map((m) => m[1] ?? ''))].filter(Boolean);
}

/**
 * The listed message to send at this stop, or null. A line matches only while a request of its kind is open: an unanswered `scope`, `destructive` or `mutation_budget`
 * request in approvals/, or (assumption) the question naming that exact id; and while its uses are not spent. Each entry is judged again by {@link listedProblem}.
 * @param {{ kind: string, message: string, max: number }[]} entries @param {number[]} used uses spent per entry (same order)
 * @param {{ name: string, kind: string }[]} open @param {string[]} assumptions
 * @returns {{ index: number, kind: string, message: string, request: string } | null}
 */
export function pickListed(entries, used, open, assumptions) {
  for (const [index, e] of entries.entries()) {
    if (listedProblem(e.kind, e.message) !== '' || (used[index] ?? 0) >= e.max) continue;
    if (e.kind === 'assumption') {
      const id = /^accept (AS-[0-9]+)$/.exec(e.message)?.[1] ?? '';
      if (id !== '' && assumptions.includes(id)) return { index, kind: e.kind, message: e.message, request: id };
      continue;
    }
    const hit = open.find((o) => o.kind === e.kind);
    if (hit) return { index, kind: e.kind, message: e.message, request: hit.name };
  }
  return null;
}
