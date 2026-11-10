// @ts-check
// The write-time language check (agent.sh `language_check`, A171, A172): run artifacts are English. A text with three or more non-English letters
// outside the exempt lines is refused, unless the foreign text is a QUOTATION of product text: an inline code span, a double-quoted span, a `> `
// quote line or a fenced line whose whole inner text (white space normalised, at least 4 characters, at most 1000) occurs on word boundaries in the
// run's TASK.md, in a captured user prompt (prompts/history) or in a file COMMITTED to git (HEAD, outside .agents/; never a staged, modified or
// untracked file). The lookup of a piece in the committed text is a `git grep` on HEAD for each piece the other sources do not hold, so a cache
// file that something forged can vouch for nothing. An English write costs no process.
import { readFileSync } from 'node:fs';
import { sharedDirOf, sortedNames } from './approvals.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { readBytes, textLines } from './records.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const FOREIGN = /\xc3[\x80-\x96\x98-\xb6\xb8-\xbf]|[\xc4\xc5\xce\xcf\xd0-\xd4]|[\xe3-\xe9][\x80-\xbf]/g;
const WSP = '[ \\t\\n\\v\\f\\r]';
const trim = (/** @type {string} */ t) => t.replace(new RegExp(`^${WSP}+|${WSP}+$`, 'g'), '');
const norm = (/** @type {string} */ t) => trim(t.replace(new RegExp(`${WSP}+`, 'g'), ' '));
const nchars = (/** @type {string} */ t) => t.replace(/[\x80-\xbf]/g, '').length;

/** `report_blank_summary`: the lines of the summary block blanked, line numbers kept. @param {string[]} lines */
function blankSummary(lines) {
  let skip = false; let done = false;
  return lines.map((l) => {
    if (l === '<!-- proofline:summary:begin -->' && !done) { skip = true; return ''; }
    if (skip) { if (l === '<!-- proofline:summary:end -->') { skip = false; done = true; } return ''; }
    return l;
  });
}

/** `language_question_file PATH` @param {string} p */
function questionFile(p) {
  let r = `/${p}`;
  const at = r.indexOf('/.agents/runs/');
  if (at < 0) return false;
  r = r.slice(at + '/.agents/runs/'.length);
  const s = r.indexOf('/');
  if (s < 0) return false;
  return /^questions\/[0-9]{3}\.md$/.test(r.slice(s + 1));
}

/**
 * `language_awk`: scan mode returns the line where the third foreign letter appears (0 for none); with `collect` it gathers the quoted pieces to look up
 * instead. `ok` is the set of pieces known to be product text.
 * @param {string} text @param {string} file the path the rules look at @param {string} hint @param {string[]} history the captured prompts, one entry per history file (a message)
 * @param {Set<string> | null} ok @param {Set<string> | null} collect
 */
export function scanLine(text, file, hint, history, ok = null, collect = null) {
  if (/\/runs\/[^]*\/reviews\/visual-proof\/|\/runs\/[^]*\/reports\/qa-evidence\//.test(file)) return 0; // machine output (A172)
  if (questionFile(file)) return 0;
  const own = /\/questions\/[^]*\.answer\.md$|\/questions\/[^]*\.answer\.amended-[^]*\.md$|\/approvals\/|\/runs\/[^]*\/TASK\.md$/.test(file);
  let lines = textLines(text);
  if (/\/COMPLETION_REPORT\.md$/.test(file) || hint.includes('COMPLETION_REPORT.md')) lines = blankSummary(lines);
  // one message at a time: the history files carry no line end (capture.mjs), so a line must never join the end of one message to the start of the next (A247)
  const blob = new Set(history.flatMap((m) => textLines(m)));
  const inprod = (/** @type {string} */ t0) => {
    const t = norm(t0);
    if (nchars(t) < 4 || t.length > 1000) return false;
    if (collect) { collect.add(t); return false; }
    return ok !== null && ok.has(t);
  };
  const quoted = (/** @type {string} */ t0) => { const t = trim(t0); return t === '' || blob.has(t); };
  const count = (/** @type {string} */ t) => (t.match(FOREIGN) ?? []).length;
  const stripSpans = (/** @type {string} */ t) => {
    let out = ''; let rest = t;
    for (;;) {
      let b = 0; let bo = '';
      for (const open of ['`', '"', '\xe2\x80\x9c']) { const i = rest.indexOf(open); if (i >= 0 && (b === 0 || i + 1 < b)) { b = i + 1; bo = open; } }
      if (b === 0) break;
      const closer = bo === '\xe2\x80\x9c' ? '\xe2\x80\x9d' : bo;
      const after = rest.slice(b - 1 + bo.length);
      const j = after.indexOf(closer);
      if (j < 0) break;
      const inner = after.slice(0, j);
      if (inprod(inner)) out += `${rest.slice(0, b - 1)} `;
      else out += rest.slice(0, b - 1 + bo.length + j + closer.length);
      rest = after.slice(j + closer.length);
    }
    return out + rest;
  };
  let fence = false; let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(`^${WSP}*\`\`\``).test(line)) { fence = !fence; continue; }
    let t = line; let skip = false;
    if (fence || new RegExp(`^${WSP}*>`).test(line)) {
      if (own) skip = true;
      else { t = t.replace(new RegExp(`^${WSP}*>${WSP}?`), ''); if (quoted(t) || inprod(t)) skip = true; }
    }
    if (skip || count(t) === 0) continue;
    const c = count(stripSpans(t));
    if (c > 0) { total += c; if (total >= 3 && !collect) return i + 1; }
  }
  return 0;
}

/** The ERE `language_confirm` builds for a piece (spaces match any white space run; word boundaries unless the piece starts or ends on punctuation). @param {string} piece */
function confirmPattern(piece) {
  const pat = piece.replace(/[\][\\.^$*+?(){}|]/g, '\\$&').replace(/ /g, '[[:space:]]+');
  const pre = /^[!-/:-@[-`{-~ \t\n\v\f\r\x00-\x1f\x7f]/.test(piece) ? '' : '(^|[[:punct:][:space:]])';
  const post = /[!-/:-@[-`{-~ \t\n\v\f\r\x00-\x1f\x7f]$/.test(piece) ? '' : '($|[[:punct:][:space:]])';
  return `${pre}${pat}${post}`;
}

/** Whether the piece occurs on word boundaries in a text (white space squeezed). @param {string} corpus @param {string} piece */
function inCorpus(corpus, piece) {
  const NONWORD = '[\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7f]';
  const esc = piece.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, `${WSP}+`);
  const startsNonWord = new RegExp(`^${NONWORD}`).test(piece); const endsNonWord = new RegExp(`${NONWORD}$`).test(piece);
  return new RegExp(`${startsNonWord ? '' : `(?:^|${NONWORD})`}${esc}${endsNonWord ? '' : `(?:$|${NONWORD})`}`).test(corpus);
}

const FAIL_TEXT = (/** @type {string} */ where) => `language: run artifacts are English, but ${where} holds non-English text. Do NOT transliterate it to ASCII (never turn the Turkish letters into plain c, s, g, i, u, o: product text and quotes stay as the project writes them) and do NOT ask the user: quote the text that exists in the project instead. A quote is exempt when it is inline code (\`...\`), a double-quoted span ("..."), a '> ' quote line or a JSON string value and its exact text (whitespace normalized, at least 4 characters) occurs in this run's TASK.md or in a product file COMMITTED to git (HEAD; never a staged, modified or untracked file) outside .agents/, on word boundaries; the user's own messages are quoted verbatim in a '> ' block. Text that this task writes into new or changed files cannot be quoted until it is committed, except through TASK.md: put the text in TASK.md to quote it (A171, A172). Write everything else in English`;

/**
 * The line of the third foreign letter of one text that is not quoted product text, 0 when there is none (the core of `language_scan` for one file).
 * @param {Context} ctx @param {string} file @param {string} text @param {string} hint @param {string[]} history the captured prompts, one entry per message
 */
export function languageHit(ctx, file, text, hint, history) {
  const first = scanLine(text, file, hint, history);
  if (first === 0) return 0;
  // the quoted pieces: product text of the run's TASK.md, of the user's prompts, or of the committed files
  const pieces = new Set();
  scanLine(text, file, hint, history, null, pieces);
  let run = '';
  const p = hint !== '' ? hint : file;
  if (p.includes('.agents/runs/')) run = p.slice(p.indexOf('.agents/runs/') + '.agents/runs/'.length).split('/')[0];
  if (run === '') run = (readBytes(`${ctx.root}/.agents/local/ACTIVE_RUN`) ?? '').split('\n')[0];
  if (!/^[A-Za-z0-9._-]+$/.test(run)) run = '';
  const task = run === '' ? '' : (readBytes(`${ctx.root}/.agents/runs/${run}/TASK.md`) ?? '');
  const squeeze = (/** @type {string} */ t) => t.replace(new RegExp(`${WSP}+`, 'g'), ' ');
  const corpora = [task, ...history].map(squeeze); // the task and each message on its own: a piece never spans two of them
  const ok = new Set();
  for (const piece of pieces) {
    if (corpora.some((c) => inCorpus(c, piece))) { ok.add(piece); continue; }
    const r = proc.run('git', ['-C', ctx.root, 'grep', '-q', '-I', '-E', '-e', Buffer.from(confirmPattern(piece), 'latin1').toString('utf8'), 'HEAD', '--', '.', ':(exclude).agents'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
    if (r.status === 0) ok.add(piece);
  }
  return scanLine(text, file, hint, history, ok, null);
}

/** `language_scan FILE...`: the "relative-path:line" hits of the files that hold non-English text; a missing file is skipped. @param {Context} ctx @param {string[]} files */
export function languageScanFiles(ctx, files, hint = '') {
  const prompts = `${sharedDirOf(ctx, 'prompts')}/history`;
  const history = sortedNames(prompts, /\.txt$/).map((n) => readBytes(`${prompts}/${n}`) ?? '');
  /** @type {string[]} */ const hits = [];
  for (const f of files) {
    if (!isFile(f)) continue;
    const text = readBytes(f);
    if (text === null) continue;
    const hit = languageHit(ctx, f, text, hint, history);
    if (hit !== 0) hits.push(`${f.startsWith(`${ctx.root}/`) ? f.slice(ctx.root.length + 1) : f}:${hit}`);
  }
  return hits;
}

/** `language_fail_text WHERE` @param {string} where */
export function languageFailText(where) { return FAIL_TEXT(where); }

/**
 * `language_check FILE|- [PATH]`: exit 0 when the text is English (or its non-English part is quoted product text), else exit 1 and the refusal on
 * stdout. @param {Context} ctx @param {string[]} args @param {string} stdin the text for `-`
 */
export function languageCheck(ctx, args, stdin) {
  const f = args[0] === undefined || args[0] === '' ? '-' : args[0];
  const hint = args[1] ?? '';
  const stdinMode = f === '-';
  const file = stdinMode ? '/proofline-lang.stdin' : f;
  const text = stdinMode ? stdin : (isFile(f) ? readBytes(f) : null);
  if (text === null) return 0; // language_scan: `[ -f FILE ] || continue`
  const prompts = `${sharedDirOf(ctx, 'prompts')}/history`;
  const history = sortedNames(prompts, /\.txt$/).map((n) => readBytes(`${prompts}/${n}`) ?? '');
  const hit = languageHit(ctx, file, text, hint, history);
  if (hit === 0) return 0;
  ctx.out(`${FAIL_TEXT(`line ${hit}`)}\n`);
  return 1;
}
