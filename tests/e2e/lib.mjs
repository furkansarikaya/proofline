// @ts-check
// The decision helpers of the e2e harness (tests/e2e/run.mjs), the Node form of pending-kind.sh, question-open.sh and reply-decision.sh (176-C2).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPROVAL_FILLERS, APPROVAL_PHRASES_DEFAULT, approvalNorm, approvalPendingPairs, approvalWords, kindSlug, kindWords, latestRequest, textHasApproval, validApprovalKind } from '../../control-plane/agents/scripts/core/approvals.mjs';
import { fieldOf, readBytes, textLines } from '../../control-plane/agents/scripts/core/records.mjs';

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
  // A331: the product's own rule (`pendingRequest`): only the LATEST request of a kind can be open, and an approval file of that kind numbered at or after it closes it. An older
  // request of the same kind (the COMPLEX run of 2026-11-18 had 001-request-plan and 002-request-plan with one bound; the user's reply answered 002) is superseded, never a second open plan.
  const num = (/** @type {string} */ n) => Number(/^([0-9]+)-/.exec(n)?.[1] ?? '0');
  const slugOf = (/** @type {string} */ n) => n.slice(n.indexOf('-request-') + '-request-'.length).replace(/\.yaml$/, '');
  const latest = new Map();
  for (const n of names) if (/^[0-9]+-request-.+\.yaml$/.test(n)) latest.set(slugOf(n), n);
  const closed = (/** @type {string} */ n) => names.some((a) => !a.includes('-request-') && a.endsWith('.yaml') && a === `${a.slice(0, a.indexOf('-'))}-${slugOf(n)}.yaml` && num(a) >= num(n));
  return names.filter((n) => /^[0-9]+-request-.+\.yaml$/.test(n) && !answered.has(n) && latest.get(slugOf(n)) === n && !closed(n)).map((name) => ({
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
// kind of request. Nothing outside the file is ever sent. A message is judged by the PRODUCT's own approval grammar (textHasApproval, the function the prompt hook's
// scan uses per segment), never by a word list of the harness's own: the word list is only a second check.

/** The kinds a listing may name: user-only approvals whose message is a plain approval, and the assumption acceptance (`accept AS-N`, a question, not an approvals/ request). */
export const LISTABLE_KINDS = ['scope', 'destructive', 'mutation_budget', 'assumption'];
/**
 * Second check, by stem (not whole words): a waiver, commit, push, pull request, merge, delivery, secrets or security word, English and Turkish. The first check is the grammar.
 */
export const FORBIDDEN_STEMS = /(waiv|feragat|commit|push|pull|request|deliver|teslim|merg|secret|secur|\bpr\b)/i;
/** The most lines and the most message uses one listing may hold: it stays well under the hard reply cap. */
export const LISTING_MAX_LINES = 6;
export const LISTING_MAX_USES = 6;

/** The product's approval grammar needs only the configuration's defaults (`approval.phrases`); a listing is judged with those, as an installed project without an override. */
const GRAMMAR_CTX = /** @type {any} */ ({ config: () => ({ get: (/** @type {string} */ _k, /** @type {string} */ d) => d }) });
const bytes = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');
/** The request-id families of the product (`waive:ID`, `rule:ID`, `reopen:ID`, `rationale:ID`): the prefixes `validApprovalKind` accepts. */
const FAMILIES = (() => {
  const src = validApprovalKind.toString();
  const g = /\/\^\((waive(?:\|[a-z]+)+)\):/.exec(src);
  return g ? (g[1] ?? '').split('|') : [];
})();
/** The plain kinds of the product (read from the source of `validApprovalKind`, not written here) and the extra word sets `kindWords` knows (`delivery`, `known-issue`, ...). */
export const PRODUCT_KINDS = (() => {
  const g = /\/\^\(([a-z_|-]+)\)\$\/\.test\(k\)/.exec(validApprovalKind.toString());
  const base = g ? (g[1] ?? '').split('|') : [];
  const extra = [...kindWords.toString().matchAll(/case '([^']+)'/g)].map((m) => m[1] ?? '');
  return [...new Set([...base, ...extra])];
})();

/** The words of the approval phrases and fillers: they are never taken as the id of a request family. */
const COMMON_WORDS = new Set(`${APPROVAL_PHRASES_DEFAULT} ${APPROVAL_FILLERS}`.toLowerCase().replace(/[^a-z0-9_ -]/g, ' ').split(/\s+/).filter(Boolean));

/**
 * Every approval kind the message could satisfy: the product's plain kinds and word sets, plus the family kinds (`waive:`, `rule:`, `reopen:`, `rationale:`) whose id is a word of the
 * message itself (so `approve review-1` is seen as the waiver `waive:REVIEW-1`). `except` are words of the listed kind (`scope`): a family request whose id is that word is judged
 * at SEND time against the real open requests instead (`rationale:scope`, `rule:scope`, `reopen:scope` would otherwise make a plain `approve scope` unlistable).
 * @param {string} message @param {string[]} [except] @returns {string[]}
 */
export function candidateKinds(message, except = []) {
  const words = [...new Set(approvalNorm(`${message}\n`).split(' ').filter((w) => w !== '' && !COMMON_WORDS.has(w) && !except.includes(w) && /^[A-Za-z0-9_.+-]+$/.test(w)))];
  const out = [...PRODUCT_KINDS];
  for (const f of FAMILIES) for (const w of words) out.push(`${f}:${w}`);
  return out;
}

/**
 * The kinds the message satisfies under the product grammar (as a user prompt of one clause, alone and `for <run>`).
 * @param {string} message @param {string[]} kinds @returns {string[]}
 */
export function satisfiedKinds(message, kinds) {
  return kinds.filter((k) => textHasApproval(GRAMMAR_CTX, bytes(message), k, '') || textHasApproval(GRAMMAR_CTX, bytes(message), k, 'LC'));
}

/**
 * Is this (kind, message) pair one a listing may carry? The loader and {@link pickListed} both ask, so a hand-built entry is judged the same way.
 * @param {string} kind @param {string} message @returns {string} the reason it may not, or '' when it may
 */
export function listedProblem(kind, message) {
  if (!LISTABLE_KINDS.includes(kind)) return `kind '${kind}' may never be listed (allowed: ${LISTABLE_KINDS.join(', ')}; a waiver, commit, push, delivery, merge, secrets and security approval, and plan, never come from the harness)`;
  if (message.trim() === '' || message !== message.trim()) return 'the message is empty or has leading or trailing space';
  if (!/^[A-Za-z0-9 _-]+$/.test(message)) return `the message '${message}' holds a character other than ASCII letters, digits, space, hyphen and underscore (no comma, semicolon, ampersand, bar, apostrophe, question mark or newline: one clause only)`;
  if (/ {2,}/.test(message)) return 'the message holds a double space';
  if (FORBIDDEN_STEMS.test(message) || FORBIDDEN_STEMS.test(approvalNorm(`${message}\n`))) return `the message '${message}' holds a waiver, commit, push, pull request, merge, delivery, secrets or security word`;
  if (kind === 'assumption') {
    if (!/^accept AS-[0-9]+$/.test(message)) return `the message '${message}' is not the exact acceptance form 'accept AS-<n>'`;
    const hit = satisfiedKinds(message, candidateKinds(message));
    return hit.length === 0 ? '' : `the message '${message}' also satisfies the approval kind(s) ${hit.join(', ')}`;
  }
  const own = approvalNorm(`${kindWords(kind)}\n`).split(' ');
  const hit = satisfiedKinds(message, candidateKinds(message, own));
  if (hit.length === 1 && hit[0] === kind) return '';
  return hit.length === 0 ? `the message '${message}' is not an approval of ${kind} under the product grammar` : `the message '${message}' satisfies ${hit.join(', ')} under the product grammar, not exactly ${kind}`;
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
 * EVERY open approval request under a project, read with the PRODUCT's own functions (the ones the prompt hook's scan and `approve-pending` use), not with a regex of the harness:
 * `approvalPendingPairs` for the no-run folder and for each run, and `approvalWords` for the words each request is answered with (a `joint:` or `delivery:` field changes them: a
 * `kind: commit` request with `joint: scope` is answered by `approve scope`). `unclear` names every request file in any approvals/ folder the product cannot read unambiguously
 * (unreadable, no or several `kind:`, `joint:` or `delivery:` lines, a kind it does not accept, a file name that is not the slug of its kind): a send is withheld while one exists.
 * @param {string} project
 * @returns {{ requests: { name: string, kind: string, words: string, where: string }[], unclear: string[], runIds: string[] }}
 */
export function productRequests(project) {
  /** @param {string} root the tree whose runs are read; the shared (no-run) folder is always the project's */
  const ctxOf = (root) => /** @type {any} */ ({
    root, cwd: root, env: {}, agents: path.join(root, '.agents'), config: () => ({ get: (/** @type {string} */ _k, /** @type {string} */ d) => d }),
    sharedMain: () => project, runDir: (/** @type {string} */ id) => path.join(root, '.agents/runs', id), once: (/** @type {string} */ _k, /** @type {() => unknown} */ f) => f(),
  });
  // The trees the prompt hook walks (adapters/claude/hooks/events/prompt.mjs): the project itself and every `.agents/local/worktrees/<d>` (the run of a worktree is approved by THAT tree's
  // data, found by its run id in the reply).
  const wtRoot = path.join(project, '.agents/local/worktrees');
  const trees = [project, ...listDir(wtRoot).sort(byteSort).map((d) => path.join(wtRoot, d))];
  /** @type {{ name: string, kind: string, words: string, where: string }[]} */ const requests = [];
  /** @type {Set<string>} */ const seen = new Set();
  /** @type {Set<string>} */ const runIds = new Set();
  /** @type {string[]} */ const unclear = [];
  /** @type {[string, string][]} */ const dirs = [];
  for (const tree of trees) {
    const ctx = ctxOf(tree);
    const runs = listDir(path.join(tree, '.agents/runs')).sort(byteSort);
    for (const r of runs) runIds.add(r);
    for (const r of tree === project ? ['', ...runs] : runs) {
      let pairs = [];
      try { pairs = approvalPendingPairs(ctx, r); } catch { pairs = []; }
      for (const [target, kind] of pairs) {
        if (tree !== project && target !== r) continue;   // the no-run folder is the project's, read once
        const key = `${tree}|${target}|${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let words = kind; let name = '';
        try { words = approvalWords(ctx, target, kind); name = path.basename(latestRequest(ctx, target, kind) ?? ''); } catch { /* unclear below */ }
        requests.push({ name, kind, words, where: target });
      }
    }
    dirs.push([path.join(tree, '.agents/local/approvals'), `${path.relative(project, tree) || '.'}:-`]);
    for (const r of runs) dirs.push([path.join(tree, '.agents/runs', r, 'approvals'), `${path.relative(project, tree) || '.'}:${r}`]);
  }
  for (const [dir, where] of dirs) {
    for (const n of listDir(dir).sort(byteSort)) {
      if (!/^[0-9]{3}-request-.*\.yaml$/.test(n)) continue;
      const f = path.join(dir, n);
      const text = readBytes(f);
      const label = `${where}/${n}`;
      if (text === null) { unclear.push(`${label}: unreadable`); continue; }
      const lines = textLines(text);
      const count = (/** @type {string} */ k) => lines.filter((l) => l.startsWith(`${k}:`)).length;
      const kind = fieldOf(lines, 'kind');
      if (count('kind') !== 1 || count('joint') > 1 || count('delivery') > 1) unclear.push(`${label}: ${count('kind')} kind lines`);
      else if (!validApprovalKind(kind)) unclear.push(`${label}: kind '${kind}' is not a product kind`);
      else if (kindSlug(kind) !== n.slice('000-request-'.length).replace(/\.yaml$/, '')) unclear.push(`${label}: the name is not the slug of kind '${kind}'`);
    }
  }
  return { requests, unclear, runIds: [...runIds].sort(byteSort) };
}

/**
 * The listed message to send at this stop. `{ pick }`: a line whose kind has an open request, with uses left (per DISTINCT request: a request is answered once by a line, so a second use
 * is for another request, never the same unchanged one), and whose text satisfies, under the product grammar and with the words the product answers each request with, no open request
 * of the project except requests of exactly the listed kind (and no extra `joint:` or `delivery:` words). `{ withheld }`: it would have been sent, but it also satisfies another open
 * request (any run, the no-run folder, `rationale:`, `rule:`, `reopen:`, a `joint:` request) or a request file cannot be read unambiguously (`unclear`). Else null. Each entry is judged
 * again by {@link listedProblem}.
 * @param {{ kind: string, message: string, max: number }[]} entries
 * @param {Set<string>[]} used per entry: the requests (names) or assumption ids it was sent for
 * @param {{ name: string, kind: string }[]} open the open requests of the run's approvals folder @param {string[]} assumptions
 * @param {{ requests: { name: string, kind: string, words: string, where: string }[], unclear: string[], runIds?: string[] }} [project] {@link productRequests} (default: `open` only)
 * @returns {{ pick: { index: number, kind: string, message: string, request: string } } | { withheld: { kind: string, message: string, reason: string } } | null}
 */
export function pickListed(entries, used, open, assumptions, project = { requests: open.map((o) => ({ name: o.name, kind: o.kind, words: o.kind, where: '' })), unclear: [] }) {
  for (const [index, e] of entries.entries()) {
    const spent = used[index] ?? new Set();
    if (listedProblem(e.kind, e.message) !== '' || spent.size >= e.max) continue;
    let request = '';
    if (e.kind === 'assumption') {
      const id = /^accept (AS-[0-9]+)$/.exec(e.message)?.[1] ?? '';
      if (id === '' || !assumptions.includes(id) || spent.has(id)) continue;
      request = id;
    } else {
      const hit = open.find((o) => o.kind === e.kind && !spent.has(o.name));
      if (!hit) continue;
      request = hit.name;
    }
    const withhold = (/** @type {string} */ reason) => ({ withheld: { kind: e.kind, message: e.message, reason } });
    // the hook approves the run of a worktree when the reply names its id, so a message that holds a run id (anywhere) targets that run: withheld
    const named = (project.runIds ?? []).filter((id) => id !== '' && approvalNorm(`${e.message}\n`).includes(id.toLowerCase()));
    if (named.length > 0) return withhold(`the message holds the run id ${named.join(', ')}, so the prompt hook would also target that run`);
    if (project.unclear.length > 0) return withhold(`a request file cannot be read unambiguously: ${project.unclear.join('; ')}`);
    const other = project.requests.filter((r) => textHasApproval(GRAMMAR_CTX, bytes(e.message), r.words, r.where === '-' ? '' : r.where) && !(r.kind === e.kind && r.words === e.kind)).map((r) => (r.words === r.kind ? r.kind : `${r.kind} (answered with ${r.words})`));
    if (other.length > 0) return withhold(`the message also satisfies the open request(s) ${[...new Set(other)].join(', ')}`);
    return { pick: { index, kind: e.kind, message: e.message, request } };
  }
  return null;
}
