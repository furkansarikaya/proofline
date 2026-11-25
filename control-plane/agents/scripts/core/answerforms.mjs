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

