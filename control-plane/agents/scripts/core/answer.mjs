// @ts-check
// `answer ID N [--captured|--amend]`. An answer is the user's only when the prompt hook hands over the message it is handling (`--captured`, `--amend`):
// the core never reads the user's words from a file. Text the lead types is the lead's answer; an `accept <id>` the user's prompt does not carry is the lead's, never the user's. The status block is built in process and its adapter is a child; the locks are released before that child runs (a slow tracker must not hold them).
import { statusBlockUpdate } from './statusblock.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { approvalNormSpace, latestCapture, quoteLines, sortedNames, textHasApproval, validApprovalKind } from './approvals.mjs';
import { captureField, safeSession } from './capture.mjs';
import { requireLead } from './approve.mjs';
import { fail } from './errors.mjs';
import { setRunValue } from './lifecycle.mjs';
import { ledgerAppend } from './ledger.mjs';
import { fileLines, gateField, gatesEnforced, readBytes, sectionKeyPresent } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { sharedDirOf } from './approvals.mjs';
import { isFile } from './paths.mjs';
import { latin1Buf } from './wirebytes.mjs';

/** @typedef {import('./context.mjs').Context} Context */

// A347: the hedge check runs on decoded, folded TEXT (fold below), not on bytes. Whole words (the English list as before, and the Turkish whole words), then Turkish STEMS matched as
// prefixes of a word (a Turkish word is inflected: değil, değildir; istemi, istemiyorum). A finite list, not language understanding; a "?" anywhere is a question, not an answer.
const NEG_WORDS = "not|never|no|nope|n't|don't|dont|do not|only if|if|unless|but|except|until|yet|wait|without|maybe|reject|rejected|decline|declined|or|actually|instead|rather|değil|degil|hayır|hayir|reddet|reddediyorum|yerine|olmasın|olmasin|sadece eğer|sadece eger|ama|eğer|eger";
const NEG_STEMS = 'değil|degil|istemi|istemem|yapma|etme|asla|fakat|ancak|bekle|bekli|iptal|vazgeç|vazgec|sanmam|emin|belki|hayir|reddet|olmasin|yerine|henüz|henuz';
const NEG_WORD_RE = new RegExp(`(^|[^\\p{L}\\p{M}])(${NEG_WORDS})([^\\p{L}\\p{M}]|$)`, 'u');
const NEG_STEM_RE = new RegExp(`(^|[^\\p{L}\\p{M}])(${NEG_STEMS})`, 'u');
/** Does folded text hold a negation, a condition, a hedge or a question mark? @param {string} t */
const hedgedText = (t) => t.includes('?') || NEG_WORD_RE.test(` ${t} `) || NEG_STEM_RE.test(` ${t} `);
/** The same for a byte string (the form the core holds text in). @param {string} b */
const hedged = (b) => hedgedText(fold(text(b)));

/** `assumption_prompt_accepts PROMPT ID` @param {string} prompt @param {string} id */
export function assumptionPromptAccepts(prompt, id) {
  const lower = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const p = lower(prompt).replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ /, '');
  const rest = p.replace(/^((accept|accepted) as-[0-9]+( *(,|;|&|and) *)?)+/, '');
  if (rest === p) return false;
  const head = p.endsWith(rest) ? p.slice(0, p.length - rest.length) : p;
  try { if (!new RegExp(`(accept|accepted) ${lower(id)}([^0-9]|$)`).test(head)) return false; } catch { return false; }
  return !hedged(` ${rest} `);
}

/** The user-only kind a question carries: SPLIT (the split override of freeze, A171), USER_ONLY (an intent scope or batch pre-flight question). @param {string[]} lines */
function userOnlyKind(lines) {
  for (const l of lines) { const m = /^[ \t]*(SPLIT|USER_ONLY):/.exec(l); if (m) return m[1]; }
  return '';
}

/** The number of open questions (no answer file) that carry a user-only kind. @param {Context} ctx @param {string} dir */
function openUserOnly(ctx, dir) {
  let c = 0;
  for (const f of sortedNames(`${dir}/questions`, /^[0-9]{3}\.md$/)) {
    if (existsSync(`${dir}/questions/${f.slice(0, -3)}.answer.md`)) continue;
    if (userOnlyKind(fileLines(ctx, `${dir}/questions/${f}`)) !== '') c++;
  }
  return c;
}

/** A latin1 byte string (how the core holds text) as real text, and back. @param {string} s */
const text = (s) => Buffer.from(s, 'latin1').toString('utf8').normalize('NFC');
/** @param {string} s */
const bytes = (s) => Buffer.from(s, 'utf8').toString('latin1');
/** Case folding for answer forms: Turkish İ, I, ı and i all compare as i (an English "FIX IT" and a Turkish "KIZ" both match), then lower case. @param {string} s */
const fold = (s) => s.replace(/[İIı]/g, 'i').toLocaleLowerCase('en-US');   // on DECODED text, never on a byte string (verify-fixes: ASCII-only case mapping of bytes); en-US so the locale cannot change the mapping

/** The options line of a question as text, or null. @param {string[]} lines */
function optionsLine(lines) {
  for (const l of lines) { const t = text(l); if (/^[ \t]*(options|seçenekler|secenekler):/iu.test(t)) return t; }
  return null;
}
/** The listed forms of a question as text, as written (quotes and a leading `a)` removed). @param {string[]} lines */
function formsOf(lines) {
  const opt = optionsLine(lines);
  if (opt === null) return [];
  return [...new Set(opt.slice(opt.indexOf(':') + 1).split(/\|/).map((x) => (/"([^"]+)"/.exec(x)?.[1] ?? x.trim().replace(/^[a-z]\)\s*/i, '').replace(/^['`]|['`]$/g, '')).trim()).filter((x) => x !== ''))];
}
/** The answer forms a question lists, as byte strings (for a message to the user). @param {string[]} lines */
export function acceptedForms(lines) { return formsOf(lines).map(bytes); }

/**
 * The answer forms a question lists: the items of its `options:` / `seçenekler:` line (separated by |, quotes and a leading `a)` removed). A
 * message is an accepted answer when, with case folded the Turkish way (A347) and the white space folded, it starts with exactly ONE listed form
 * (followed by the end or a non-letter) and the rest holds no negation or condition. Anything else (two forms, none, a hedge) records nothing.
 * Question and message are byte strings (A210 design): both are decoded to text for the comparison; the negation check runs on the bytes again.
 * @param {string} norm @param {string[]} lines
 */
export function matchesAcceptedForm(norm, lines) {
  const forms = [...new Set(formsOf(lines).map(fold))];
  if (forms.length === 0 || norm.includes('?')) return false;
  const msg = fold(text(norm)).replace(/^[ \t\n]+/, '').replace(/[.!]+$/, '');
  const hits = forms.filter((f) => msg === f || (msg.startsWith(f) && !/[\p{L}\p{N}\p{M}]/u.test(msg.charAt(f.length))));
  if (hits.length !== 1) return false;
  // no OTHER listed form may be named anywhere in the message ("report it and fix it" gives neither decision)
  if (forms.some((f) => f !== hits[0] && !hits[0].includes(f) && msg.includes(f))) return false;
  return !hedgedText(` ${msg.slice(hits[0].length)} `);
}

// ---- an answer beside approvals in one message (A350) -------------------------------------------------------------------------------------------------------

const PLAIN_KINDS = ['plan', 'destructive', 'single_step', 'scope', 'budget', 'mutation_budget', 'tree', 'commit', 'push', 'pr', 'merge', 'cleanup', 'report', 'commands', 'rename', 'known-issue', 'scale', 'delivery'];
/** `soru 1:`, `question 1:`, `q1)` at the start of a segment: the answer is for that question number. */
const QPREFIX = /^(?:soru|question|q)[ \t]*([0-9]+)[ \t]*[:.)-][ \t]*/i;

/** The kinds a segment may approve: the plain kinds and the kinds of the requests on record (`kind:` of every request file of the run and of the shared folder). @param {Context} ctx @param {string} runId */
function approvalKindsOf(ctx, runId) {
  const kinds = new Set(PLAIN_KINDS);
  const dirs = [`${sharedDirOf(ctx, 'approvals')}`];
  if (runId !== '' && runId !== '-') dirs.push(`${runDir(ctx, runId)}/approvals`);
  for (const d of dirs) for (const n of sortedNames(d, /^[0-9]{3}-request-.*\.yaml$/)) { const k = gateField(ctx, `${d}/${n}`, 'kind'); if (validApprovalKind(k)) kinds.add(k); }
  return [...kinds];
}

/** Is this segment one approval phrase of some kind (every word is a phrase, a filler or a kind word, a kind word is present)? A lexical test: it records nothing. @param {Context} ctx @param {string} runId @param {string} seg */
export function isApprovalSegment(ctx, runId, seg) {
  const kinds = approvalKindsOf(ctx, runId);
  return kinds.some((k) => textHasApproval(ctx, `${seg}\n`, k, '', kinds));
}

/** The form an option letter stands for (`a) "böl" | b) "devam"` gives "böl" for `a`), or null. @param {string[]} lines @param {string} letter folded, one letter */
function labelForm(lines, letter) {
  const opt = optionsLine(lines);
  if (opt === null) return null;
  for (const x of opt.slice(opt.indexOf(':') + 1).split('|')) {
    const m = /^\s*([a-z])\)\s*(.*)$/i.exec(x);
    if (m && fold(m[1]) === letter) { const f = (/"([^"]+)"/.exec(m[2])?.[1] ?? m[2].trim().replace(/^['`]|['`]$/g, '')).trim(); return f === '' ? null : f; }
  }
  return null;
}

/** The part of a segment after its `soru N:` prefix, and the form a letter stands for: null when the prefix names another question. @param {string} seg byte string @param {string[]} lines @param {number} n */
function afterPrefix(seg, lines, n) {
  const t = seg.trim();
  const m = QPREFIX.exec(t);
  if (!m) return { rest: t, prefixed: false };
  if (Number(m[1]) !== n) return null;
  const rest = t.slice(m[0].length).trim();
  const f = labelForm(lines, fold(text(rest)));
  return { rest: f === null ? rest : bytes(f), prefixed: true };
}

/** Does this segment answer an open user-only question of the run (an accepted form, or `soru N: <form or option letter>`)? @param {Context} ctx @param {string} runId @param {string} seg */
export function answersOpenQuestion(ctx, runId, seg) {
  if (runId === '' || runId === '-') return false;
  const dir = runDir(ctx, runId);
  for (const f of sortedNames(`${dir}/questions`, /^[0-9]{3}\.md$/)) {
    if (existsSync(`${dir}/questions/${f.slice(0, -3)}.answer.md`)) continue;
    const lines = fileLines(ctx, `${dir}/questions/${f}`);
    if (userOnlyKind(lines) === '') continue;
    const a = afterPrefix(seg, lines, Number(f.slice(0, 3)));
    if (a !== null && matchesAcceptedForm(approvalNormSpace(a.rest), lines)) return true;
  }
  return false;
}

/**
 * A message that holds approvals beside the answer: the approval segments (split on `;`, `,` and lines) are dropped and a `soru N:` prefix is removed; what is left is checked
 * like any answer (one accepted form, no hedge). Null when nothing changed or nothing is left. The message is the user's own text; nothing is recorded from here.
 * @param {Context} ctx @param {string} runId @param {string} message byte string @param {string[]} lines @param {number} n
 */
export function reduceToAnswer(ctx, runId, message, lines, n) {
  const parts = message.split(/([;,\n])/);
  /** @type {Array<{ sep: string, piece: string }>} */ const kept = [];
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].trim() === '' || isApprovalSegment(ctx, runId, parts[i])) { changed = true; continue; }
    kept.push({ sep: i > 0 ? parts[i - 1] : '', piece: parts[i] });
  }
  if (kept.length === 0) return null;
  const joined = kept.map((k, i) => (i === 0 ? '' : k.sep) + k.piece).join('');
  const a = afterPrefix(joined, lines, n);
  if (a === null) return null;
  return changed || a.prefixed ? a.rest : null;
}

const TOKEN_LINE =/^[ \t\n\v\f\r]*ASSUMPTION: ([^ \t\n\v\f\r]*)[ \t\n\v\f\r]*$/;

/** `epoch_iso` @param {string} e */
function epochIso(e) { return /^[0-9]+$/.test(e) ? new Date(Number(e) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : e; }

/** @param {Context} ctx @param {string[]} args id, n, mode */
export function answer(ctx, args) {
  const [id, n, mode = ''] = args;
  requireRun(ctx, id);
  requireLead(ctx);
  const dir = runDir(ctx, id);
  if (!/^[0-9]+$/.test(n)) fail('question number must be numeric');
  const q = `${dir}/questions/${String(Number(n.replace(/^0+/, '') || '0')).padStart(3, '0')}.md`;
  if (!isFile(q)) fail(`no question ${n} for ${id}`);
  const amend = mode === '--amend';
  const prev = `${q.slice(0, -3)}.answer.md`;
  if (amend) { if (!existsSync(prev)) fail(`question ${n} has no answer to amend`); } else if (existsSync(prev)) fail(`question ${n} is already answered (a wrong answer is corrected with: agent.sh answer ${id} ${n} --amend, after the user's new message)`);
  const prompts = sharedDirOf(ctx, 'prompts');
  const consumed = () => (readBytes(`${prompts}/consumed`) ?? '').split('\n');
  let text = ''; let cm = false; let used = ''; let src = ''; let pick = '';
  const handed = /** @type {{ promptCapture?: { session: string, time: number, sha256: string, text: string } }} */ (ctx.io).promptCapture;
  if (mode === '--captured' || amend) {
    // A210, #187 (option 2): an answer is the user's ONLY when the prompt hook records it, in process, from the message it is handling; the core never
    // takes the user's words from a file (a planted prompts/history file or capture cannot become the user's answer). The lead's `--captured` and
    // `--amend` without that hand-over are refused: the user is asked again, and a typed answer (no flag) is the lead's.
    if (!handed) fail(`answer ${n} cannot be recorded as the user's from a file: the prompt hook records the user's answer from the message it handles (ask the user in this session and wait for the reply); an answer the lead types without --captured is recorded as the lead's`);
    cm = true;
    let a0 = gateField(ctx, q, 'asked_at'); if (!/^[0-9]+$/.test(a0)) a0 = '0';
    let prevSrc = '';
    if (amend) { let pe = gateField(ctx, prev, 'answered_epoch'); if (!/^[0-9]+$/.test(pe)) pe = a0; a0 = pe; prevSrc = gateField(ctx, prev, 'source_message'); }
    if (latestCapture(ctx, true) === null) fail('the capture of this message is not on disk as the hook wrote it');
    // bound to the ASKING session: the question names the session that asked it (the lead's run); a prompt of another session is not its answer, and a
    // question without a known asking session records nothing
    const askedSession = gateField(ctx, q, 'asked_session');
    if (askedSession === '') fail(`question ${n} has no asking session on record: the user's answer is not recorded from a message (ask again with ask)`);
    if (safeSession(askedSession) !== handed.session) fail(`this message is from another session than the one that asked question ${n}`);
    // a question mark anywhere: the user is asking, not answering (as for approvals)
    if (handed.text.includes('?')) fail(`this message holds a question mark, so it is not an answer to question ${n}`);
    // strictly newer than the question (a message of the same second as the question is not its answer)
    if (BigInt(handed.time) <= BigInt(a0)) fail(`this message is not newer than question ${n}`);
    pick = `${handed.time}-${handed.sha256.slice(0, 8)}.txt`;
    if (pick === prevSrc) fail(`this message (${pick}) is the one the recorded answer already came from`);
    if (consumed().includes(pick)) fail(`this message (${pick}) already answered another question`);
    text = Buffer.from(handed.text, 'utf8').toString('latin1');
    used = pick; src = pick;
  } else {
    text = readStdin(ctx);
  }
  if (!/[^ \t\n\v\f\r]/.test(text)) fail('empty answer');
  const tokLine = fileLines(ctx, q).map((l) => TOKEN_LINE.exec(l)).find((m) => m !== null);
  const tok = tokLine ? tokLine[1] : '';
  const tokId = tok.includes('@') ? tok.slice(0, tok.lastIndexOf('@')) : tok;
  let acc = false; let by = 'lead'; let resolved = '';   // resolved: the answer that was found inside a message that also held approvals (A350)
  let asked = gateField(ctx, q, 'asked_at'); if (!/^[0-9]+$/.test(asked)) asked = '';
  const norm = approvalNormSpace(text);
  const qtext = fileLines(ctx, q);
  if (cm) {
    by = 'user';
    if (tok !== '' && assumptionPromptAccepts(norm, tokId)) acc = true;
    else if (tok === '' && userOnlyKind(qtext) !== '') {
      // a split override or another user-only question: the single open one, answered by one of the forms the question lists
      if (openUserOnly(ctx, dir) !== 1) fail(`question ${n} is not the only open user-only question: ask the user again`);
      // A350: the message may hold approvals beside the answer ("approve scope; böl", "approve plan, soru 1: b"): the approval segments are not part of the answer
      const reduced = matchesAcceptedForm(norm, qtext) ? norm : reduceToAnswer(ctx, id, text, qtext, Number(n.replace(/^0+/, '') || '0'));
      if (reduced !== norm && reduced !== null) resolved = reduced;
      if (reduced === null || !matchesAcceptedForm(approvalNormSpace(reduced), qtext)) fail(`this message is not one of the accepted answers of question ${n} (accepted: ${acceptedForms(qtext).map((f) => `"${f}"`).join(' | ')}; nothing is recorded; ask the user again)`);
      acc = true;
    } else if (tok === '') fail(`question ${n} is not a question the user answers through the prompt hook (the lead types the answer; it is recorded as the lead's)`);
    // the prompt hook tries every open user-only question with each message it handles: it records an acceptance or an accepted form and nothing else
    if (!acc) fail(`this message is not an acceptance of the assumption of question ${n} (only an acceptance is recorded as the user's answer from the hook)`);
  }
  let body = text;
  if (tok !== '' && /^accept/i.test(norm)) {
    if (acc) body = `accept ${tokId}\n`; else by = 'lead';
  } else if (by === 'user') body = `${quoteLines(text)}${resolved !== '' ? `${text.endsWith('\n') ? '' : '\n'}answer: ${resolved.replace(/[\n\r]+/g, ' ')}\n` : ''}`;
  let amends = '';
  if (amend) {
    let k = 1;
    while (existsSync(`${q.slice(0, -3)}.answer.amended-${k}.md`)) k++;
    amends = `${q.slice(q.lastIndexOf('/') + 1, -3)}.answer.amended-${k}.md`;
    const old = readBytes(prev) ?? '';
    const lines = old === '' ? [] : old.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    writeFileSync(`${dir}/questions/${amends}`, latin1Buf(lines.length === 0 ? '' : `amended: true\namended_at: ${now().epoch}\n${lines.map((l) => `${l}\n`).join('')}`));
    rmSync(prev, { force: true });
  }
  const t = now();
  let head = `answered_by: ${by}\ntime: ${t.iso}\nanswered_epoch: ${t.epoch}\n`;
  if (src !== '') head += `source_message: ${src}\n`;
  if (amends !== '') head += `amends: ${amends}\n`;
  if (ctx.cancelled()) fail('answer refused: the prompt hook stopped waiting for this step (its time budget ended)');
  writeFileSync(prev, latin1Buf(`${head}---\n${body}`));
  if (used !== '') { mkdirSync(prompts, { recursive: true }); appendFileSync(`${prompts}/consumed`, `${used}\n`); }
  let left = false;
  for (const f of sortedNames(`${dir}/questions`, /^[0-9]{3}\.md$/)) if (!existsSync(`${dir}/questions/${f.slice(0, -3)}.answer.md`)) left = true;
  ctx.forget('file:');
  if (!left && sectionKeyPresent(ctx, dir, 'execution', 'awaiting_input')) setRunValue(ctx, id, 'execution', 'awaiting_input', 'false');
  const as = tokLine ? ` assumption=${tokLine[1]}` : '';
  const qbase = q.slice(q.lastIndexOf('/') + 1, -3);
  if (gatesEnforced(ctx, dir)) {
    ledgerAppend(dir, ctx.role, amend ? 'answer-amend' : 'answer', '-', '-', `${qbase}.md answered_by=${by}${src !== '' ? ` source=${src}` : ''}${amends !== '' ? ` amends=${amends}` : ''}${as}`);
    ctx.forget('file:');
  }
  statusBlock(ctx, id);
  ctx.out(`answer recorded: ${id} ${qbase} answered_by=${by}${amends !== '' ? ` (amends ${amends}, the old record is kept)` : ''}\n`);
  if (src !== '') ctx.out(`answer source: the user's message ${src} (${epochIso(src.slice(0, src.indexOf('-')))}): ${text.replace(/[ \t\n\v\f\r]+/g, ' ').slice(0, 80)}\n`);
  if (as !== '' && by !== 'user') ctx.out(`note:${as}: not an acceptance the user's own prompt carries (answered_by=${by}; the prompt must start with 'accept <id>' and hold no negation or condition), so the assumption stays unaccepted\n`);
  return 0;
}

/** The answer typed by the lead arrives on stdin. @param {Context} ctx */
function readStdin(ctx) {
  const given = /** @type {{ stdinText?: string }} */ (ctx.io).stdinText; // handed over by the Node hook, which runs this in its own process
  if (given !== undefined) return Buffer.from(given, 'utf8').toString('latin1');
  try { return readFileSync(0, 'latin1'); } catch { return ''; }
}

/** `status_block_update ID answer`: best effort. The block is built in process; the locks are released before the adapter child runs, so a slow tracker never holds them. @param {Context} ctx @param {string} id */
function statusBlock(ctx, id) { ctx.locks?.releaseAll(); statusBlockUpdate(ctx, id, 'answer'); }


