// @ts-check
// The lexical side of a user's answer (A347, A350): accepted forms of a user-only question, the hedge check and the segments of a message that holds approvals beside an answer.
// A leaf module (no import of approve.mjs or answer.mjs): approve.mjs reads it for the multi-approval scan and answer.mjs for the answer, without an import cycle. Nothing here writes a file.
import { existsSync } from 'node:fs';
import { approvalNormSpace, sharedDirOf, sortedNames, textHasApproval, validApprovalKind } from './approvals.mjs';
import { fileLines, gateField } from './records.mjs';
import { runDir } from './runs.mjs';

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
export const hedged = (b) => hedgedText(fold(text(b)));


/** The user-only kind a question carries: SPLIT (the split override of freeze, A171), USER_ONLY (an intent scope or batch pre-flight question). @param {string[]} lines */
export function userOnlyKind(lines) {
  for (const l of lines) { const m = /^[ \t]*(SPLIT|USER_ONLY):/.exec(l); if (m) return m[1]; }
  return '';
}


/** A latin1 byte string (how the core holds text) as real text, and back. @param {string} s */
export const text = (s) => Buffer.from(s, 'latin1').toString('utf8').normalize('NFC');
/** @param {string} s */
export const bytes = (s) => Buffer.from(s, 'utf8').toString('latin1');
/** Case folding for answer forms: Turkish İ, I, ı and i all compare as i (an English "FIX IT" and a Turkish "KIZ" both match), then lower case. @param {string} s */
export const fold = (s) => s.replace(/[İIı]/g, 'i').toLocaleLowerCase('en-US');   // on DECODED text, never on a byte string (verify-fixes: ASCII-only case mapping of bytes); en-US so the locale cannot change the mapping

/** The options line of a question as text, or null. @param {string[]} lines */
export function optionsLine(lines) {
  for (const l of lines) { const t = text(l); if (/^[ \t]*(options|seçenekler|secenekler):/iu.test(t)) return t; }
  return null;
}
/** The listed forms of a question as text, as written (quotes and a leading `a)` removed). @param {string[]} lines */
export function formsOf(lines) {
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


// ---- the option UI of a runtime (A367, issue 338 U1) ---------------------------------------------------------------------------------------------------------

/** The options of a question as {form, desc} (the form as written, quotes removed; desc the text after the quoted form, outer parentheses removed), duplicates dropped. @param {string[]} lines */
function optionItems(lines) {
  const opt = optionsLine(lines);
  if (opt === null) return [];
  /** @type {Array<{ form: string, desc: string }>} */ const out = [];
  for (const x of opt.slice(opt.indexOf(':') + 1).split(/\|/)) {
    const q = /"([^"]+)"/.exec(x);
    const form = (q?.[1] ?? x.trim().replace(/^[a-z]\)\s*/i, '').replace(/^['`]|['`]$/g, '')).trim();
    if (form === '' || out.some((o) => o.form === form)) continue;
    const rest = q ? x.slice(q.index + q[0].length).trim() : '';
    out.push({ form, desc: rest.replace(/^\(([\s\S]*)\)$/, '$1').trim() });
  }
  return out;
}

const QUESTION_MARKER = /^[ \t]+(USER_ONLY|SPLIT|ASSUMPTION|options|seçenekler|secenekler|recommended|önerilen|why|neden|source|kaynak):/iu;

/**
 * The input of Claude Code's AskUserQuestion for a question of the control plane, or null when the question is not offered as options. Only a question that carries a
 * user-only marker (`SPLIT:`, `USER_ONLY:`, never an `ASSUMPTION:` token, whose second answer is free text) with 2 to 4 listed forms, each of which is itself an
 * accepted answer, is offered. The text, the header and the options are DERIVED from the question file (nothing else is stored); the hook accepts a selection only
 * when the tool input is exactly this value. Real text (not bytes). @param {string[]} lines the question file's lines (byte strings)
 * @returns {{ questions: Array<{ question: string, header: string, multiSelect: false, options: Array<{ label: string, description: string }> }> } | null}
 */
export function askSpec(lines) {
  const kind = userOnlyKind(lines);
  if (kind === '' || lines.some((l) => /^[ \t]*ASSUMPTION: /.test(l))) return null;
  const items = optionItems(lines);
  if (items.length < 2 || items.length > 4) return null;
  for (const it of items) if (it.form.length > 60 || /["?]/.test(it.form) || !matchesAcceptedForm(bytes(it.form), lines)) return null;
  const at = lines.findIndex((l) => /^[0-9]+\. /.test(l));
  if (at < 0) return null;
  const parts = [text(lines[at]).replace(/^[0-9]+\.[ \t]+/, '')];
  for (let i = at + 1; i < lines.length && !QUESTION_MARKER.test(text(lines[i])) && !/^[0-9]+\. /.test(lines[i]); i++) parts.push(text(lines[i]));
  const q = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (q === '') return null;
  const m = /^[ \t]*USER_ONLY:[ \t]*([^ \t]+)/.exec(lines.find((l) => /^[ \t]*USER_ONLY:/.test(l)) ?? '');
  const word = kind === 'SPLIT' ? 'Split' : (m?.[1] ?? 'Question');
  const header = [...word.replace(/^[a-z]/, (c) => String.fromCharCode(c.charCodeAt(0) - 32))].slice(0, 12).join('');
  return { questions: [{ question: [...q].slice(0, 500).join(''), header, multiSelect: false, options: items.map((it) => ({ label: it.form, description: [...(it.desc === '' ? it.form : it.desc)].slice(0, 200).join('') })) }] };
}

/** @typedef {NonNullable<ReturnType<typeof askSpec>>} AskSpec */
/** @param {unknown} o @param {string[]} keys */
const keysAre = (o, keys) => typeof o === 'object' && o !== null && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));

/** Does the tool input the runtime ran equal the spec exactly (the same keys, text, header and options, in order)? @param {unknown} input @param {AskSpec} spec */
export function sameAsk(input, spec) {
  const i = /** @type {any} */ (input);
  if (!keysAre(i, ['questions']) || !Array.isArray(i.questions) || i.questions.length !== 1) return false;
  const q = i.questions[0]; const w = spec.questions[0];
  if (!keysAre(q, ['question', 'header', 'multiSelect', 'options']) || q.question !== w.question || q.header !== w.header || (q.multiSelect !== undefined && q.multiSelect !== false)) return false;
  if (!Array.isArray(q.options) || q.options.length !== w.options.length) return false;
  return w.options.every((o, k) => keysAre(q.options[k], ['label', 'description']) && q.options[k].label === o.label && q.options[k].description === o.description);
}

// A381 (issue 338 U1): the option tool of each runtime. Claude Code: AskUserQuestion with the ask= block; Codex: request_user_input with the ask-codex= block, the same question,
// header and options plus the question id Codex needs. The Codex payload was observed with Codex CLI 0.172.0 (A381): PostToolUse `tool_name: "request_user_input"`, `tool_input`
// {questions: [{id, header, question, options: [{label, description}]}]}, `tool_response` the JSON text {"answers": {<id>: {"answers": [<label or typed text>]}}}.
/** The tool name of a runtime's option UI. @type {Record<string, string>} */
export const UI_TOOLS = { claude: 'AskUserQuestion', codex: 'request_user_input' };
/** How the lead uses the blocks (printed by `questions` and `batch-plan`). */
export const ASK_USE = "Claude Code (interactive): call AskUserQuestion ONCE per ask= line with exactly its JSON (not one character changed); Codex (plan mode, or the feature default_mode_request_user_input): call request_user_input ONCE per ask-codex= line with exactly its JSON; then stop: the runtime hook records the user's selection. fallback: written options (no such tool, headless or -p mode, codex exec, or the tool is refused): relay the question and its options as written text; the user types an accepted answer";

/** The Codex input of the same question: the id first, no multiSelect key (Codex has none). @param {AskSpec} spec @param {string} id */
export function codexAsk(spec, id) {
  const w = spec.questions[0];
  return { questions: [{ id, header: w.header, question: w.question, options: w.options.map((o) => ({ label: o.label, description: o.description })) }] };
}

/** Does the tool input of RUNTIME equal the spec exactly (Codex: also the question id, and no other key such as isSecret or isOther)? @param {string} runtime @param {unknown} input @param {AskSpec} spec @param {string} id */
export function sameUiAsk(runtime, input, spec, id) {
  if (runtime === 'claude') return sameAsk(input, spec);
  if (runtime !== 'codex') return false;
  const i = /** @type {any} */ (input);
  if (!keysAre(i, ['questions']) || !Array.isArray(i.questions) || i.questions.length !== 1) return false;
  const q = i.questions[0]; const w = spec.questions[0];
  if (!keysAre(q, ['id', 'header', 'question', 'options']) || q.id !== id || q.question !== w.question || q.header !== w.header) return false;
  if (!Array.isArray(q.options) || q.options.length !== w.options.length) return false;
  return w.options.every((o, k) => keysAre(q.options[k], ['label', 'description']) && q.options[k].label === o.label && q.options[k].description === o.description);
}

/**
 * The user's answer in the tool result of RUNTIME as text, or null when the result holds none for this question (cancelled, refused, an error string, another question,
 * more than one answer). Claude Code: `answers` keyed by the question text; Codex: the JSON text (or object) `answers` keyed by the question id, exactly one string.
 * @param {string} runtime @param {unknown} response @param {AskSpec} spec @param {string} id
 */
export function uiPick(runtime, response, spec, id) {
  const qtext = spec.questions[0].question;
  if (runtime === 'claude') {
    const r = /** @type {any} */ (response);
    const answers = r !== null && typeof r === 'object' ? r.answers : null;
    if (answers === null || typeof answers !== 'object' || !Object.hasOwn(answers, qtext) || typeof answers[qtext] !== 'string') return null;
    if (Array.isArray(r.questions) && r.questions.length > 0 && r.questions[0]?.question !== qtext) return null;
    return answers[qtext];
  }
  if (runtime !== 'codex') return null;
  let r = /** @type {any} */ (response);
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
  const answers = r !== null && typeof r === 'object' && !Array.isArray(r) ? r.answers : null;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== 1 || !Object.hasOwn(answers, id)) return null;
  const a = answers[id];
  if (!keysAre(a, ['answers']) || !Array.isArray(a.answers) || a.answers.length !== 1 || typeof a.answers[0] !== 'string') return null;
  return a.answers[0];
}

// ---- an answer beside approvals in one message (A350) -------------------------------------------------------------------------------------------------------

const PLAIN_KINDS = ['plan', 'destructive', 'single_step', 'scope', 'budget', 'mutation_budget', 'tree', 'commit', 'push', 'pr', 'merge', 'cleanup', 'report', 'commands', 'rename', 'known-issue', 'scale', 'delivery'];
/** `soru 1:`, `question 1:`, `q1)` at the start of a segment: the answer is for that question number. */
const QPREFIX = /^(?:soru|question|q)[ \t]*([0-9]+)[ \t]*[:.)-][ \t]*/i;

/** The kinds a segment may approve: the plain kinds and the kinds of the requests on record (`kind:` of every request file of the run and of the shared folder). @param {Context} ctx @param {string} runId */
export function approvalKindsOf(ctx, runId) {
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
export function labelForm(lines, letter) {
  const opt = optionsLine(lines);
  if (opt === null) return null;
  for (const x of opt.slice(opt.indexOf(':') + 1).split('|')) {
    const m = /^\s*([a-z])\)\s*(.*)$/i.exec(x);
    if (m && fold(m[1]) === letter) { const f = (/"([^"]+)"/.exec(m[2])?.[1] ?? m[2].trim().replace(/^['`]|['`]$/g, '')).trim(); return f === '' ? null : f; }
  }
  return null;
}

/** The part of a segment after its `soru N:` prefix, and the form a letter stands for: null when the prefix names another question. @param {string} seg byte string @param {string[]} lines @param {number} n */
export function afterPrefix(seg, lines, n) {
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

