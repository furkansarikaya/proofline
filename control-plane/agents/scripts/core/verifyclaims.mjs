// @ts-check
// A341: the verification claims of a completion report come from the gate records, not from the model's words (Core invariants 3 and 4: an agent's claim
// is not evidence). `claimsBlock` makes the '## Verification claims' block and the one line the lead pastes into its final message: for each required
// gate and each risk focus it says whether it ran on the FINAL tree (the record's fingerprint is the current gate fingerprint, the task file the task
// adapter writes left out of the comparison), ran on an EARLIER tree, did not run, or is unsupported. `auditClaims` refuses, before publish, text outside
// the generated blocks that contains any word of the visual/browser vocabulary (claimwords.mjs) unless the block says the visual check ran on the final tree. `checkClaimsBlock` finds a
// block edited by hand (its own hash); `verifyClaimsBlock` recomputes the block from the records and compares.
import path from 'node:path';
import { gateFingerprint } from './fingerprint.mjs';
import { gateFocusStatus, gateLatestFile, gateNames, requiredGates, treeDiff } from './gates.mjs';
import { sha256 } from './hash.mjs';
import { localTaskSourceRun } from './lifecycle.mjs';
import { fileLines, gateField, sectionValue } from './records.mjs';
import { asciiLower } from './shellglob.mjs';
import { fixRoundsDone } from './reports.mjs';
import { riskGateFocuses } from './signals.mjs';
import { CLAIM_CONFUSABLES, CLAIM_ENTITIES, CLAIM_VOCABULARY } from './claimwords.mjs';
import { lifecycleFolderStatus } from './runs.mjs';

/** @typedef {import('./context.mjs').Context} Context */

export const CLAIMS_BEGIN = '<!-- proofline:claims:begin -->';
export const CLAIMS_END = '<!-- proofline:claims:end -->';
const FACTS_BEGIN = '<!-- proofline:facts:begin -->';
const FACTS_END = '<!-- proofline:facts:end -->';
const HASH = 'Claims-hash: ';
const VISUAL = 'visual/browser check';

/** @param {string} s */
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** @param {string[]} words */
const anyWord = (words) => new RegExp(`(^|[^a-z0-9_-])(${words.map(reEsc).join('|')})([^a-z0-9_-]|$)`, 'i');

/** The paths the task adapter writes itself: the local task file, and the same file name in another lifecycle folder of the same parent (the move at DONE); nothing else. @param {Context} ctx @param {string} dir @param {string} id @returns {(p: string) => boolean} */
function adapterOwned(ctx, dir, id) {
  if (!localTaskSourceRun(ctx, id)) return () => false;
  const src = sectionValue(ctx, dir, 'task_source', 'path');
  if (src === '') return () => false;
  const up = path.posix.dirname(path.posix.dirname(src));
  const base = path.posix.basename(src);
  return (p) => p === src || (lifecycleFolderStatus(src) !== '' && lifecycleFolderStatus(p) !== '' && path.posix.basename(p) === base && path.posix.dirname(path.posix.dirname(p)) === up);
}

/**
 * The claim row of one gate or focus: `state` is final | final-fail | final-low | waived | unsupported | earlier | invalidated | before-reopen | not-run.
 * @param {Context} ctx @param {string} dir @param {string} id @param {string} gate @param {string} focus @param {string} fp @param {(p: string) => boolean} owned
 * @returns {{ state: string, record: string }}
 */
function rowState(ctx, dir, id, gate, focus, fp, owned) {
  const rec = gateLatestFile(ctx, dir, gate, focus);
  if (rec === '') {
    const want = focus === '-' ? '' : focus;
    const any = gateNames(ctx, dir).some((n) => !n.endsWith('-REOPEN.yaml') && gateField(ctx, `${dir}/gates/${n}`, 'gate') === gate && (focus === '-' || gateField(ctx, `${dir}/gates/${n}`, 'focus') === want));
    return { state: any ? 'before-reopen' : 'not-run', record: '' };
  }
  const seq = gateField(ctx, rec, 'seq');
  const recFp = gateField(ctx, rec, 'fingerprint');
  let eff = fp;
  // the same tree: the only paths that differ are the ones the task adapter writes (the completion report block, the status block)
  if (recFp !== '' && recFp !== fp) {
    const diff = treeDiff(ctx, recFp, fp);
    if (diff !== null && diff.length > 0 && diff.every(owned)) eff = recFp;
  }
  const s = gateFocusStatus(ctx, dir, id, gate, focus, 'strict', eff);
  switch (s) {
    case 'pass': return { state: 'final', record: seq };
    case 'pass_low': return { state: 'final-low', record: seq };
    case 'unsupported': return { state: 'unsupported', record: seq };
    case 'waived': return { state: 'waived', record: seq };
    case 'fail': return { state: 'final-fail', record: seq };
    default: return { state: recFp === eff ? 'invalidated' : 'earlier', record: seq };
  }
}

/** @param {{ state: string, record: string }} r @param {string} what @param {number} rounds the fix rounds of the Facts block @returns {string} */
function stateText(r, what, rounds) {
  const rec = r.record !== '' ? `record ${r.record}` : '';
  switch (r.state) {
    case 'final': return `ran on the final tree: pass (${what}, ${rec})`;
    case 'final-low': return `ran on the final tree with low confidence (${what}, ${rec}); not counted as a pass`;
    case 'final-fail': return `ran on the final tree: FAIL (${what}, ${rec})`;
    case 'waived': return `failed on the final tree and was waived by the user (${what}, ${rec})`;
    case 'unsupported': return `unsupported: it could not run here (${what}, ${rec}); nothing is claimed`;
    case 'earlier': {
      const fix = rounds > 0 ? `fix rounds used in the run: ${rounds}, as in the Facts block` : 'the tree changed after it';
      return `ran on an EARLIER tree (${what}, ${rec}; ${fix}); it is not a check of the final tree`;
    }
    case 'invalidated': return `its record was invalidated by a later change such as a refreeze or an evidence repair (${what}, ${rec}); it is not a check of the final tree`;
    case 'before-reopen': return `its only record is from before a reopen (${what}); it is not a check of the final tree`;
    default: return `not run (${what})`;
  }
}

/** @param {string} state */
const holdsFinal = (state) => state === 'final' || state === 'final-low' || state === 'final-fail' || state === 'waived' || state === 'unsupported';
/** @param {string} state */
const shortState = (state) => (state === 'earlier' ? 'earlier tree' : state === 'invalidated' ? 'invalidated by a later change' : state === 'before-reopen' ? 'before reopen' : state === 'not-run' ? 'not run' : 'no record');

/**
 * The generated block, the one line for the final message and whether a visual claim is allowed. The same records give the same bytes.
 * @param {Context} ctx @param {string} dir @param {string} id
 * @returns {{ block: string, line: string, visualOk: boolean, visual: string, hash: string }}
 */
export function claimsBlock(ctx, dir, id) {
  const fp = gateFingerprint(ctx);
  const owned = adapterOwned(ctx, dir, id);
  const rounds = fixRoundsDone(ctx, dir);
  const gl = requiredGates(ctx, dir);
  /** @type {string[]} */ const rows = [];
  /** @type {string[]} */ const notFinal = [];
  /** @type {string[]} */ const failed = [];
  let onFinal = 0;
  let visualRow = null;
  for (const g of gl) {
    const r = rowState(ctx, dir, id, g, '-', fp, owned);
    if (holdsFinal(r.state)) onFinal++; else notFinal.push(`${g} (${shortState(r.state)})`);
    if (r.state === 'final-fail') failed.push(g);
    rows.push(`- Gate ${g}: ${stateText(r, `gate ${g}`, rounds)}`);
    for (const fc of riskGateFocuses(ctx, dir, g)) {
      const fr = rowState(ctx, dir, id, g, fc, fp, owned);
      const isVisual = g === 'QA' && fc === 'visual';
      if (isVisual) visualRow = fr;
      rows.push(`- ${isVisual ? 'Visual/browser check' : `Check ${g}:${fc}`}: ${stateText(fr, isVisual ? `${VISUAL}, gate QA:visual` : `focus ${g}:${fc}`, rounds)}`);
      if (!holdsFinal(fr.state)) notFinal.push(`${g}:${fc} (${shortState(fr.state)})`);
      if (fr.state === 'final-fail') failed.push(`${g}:${fc}`);
    }
  }
  let visual;
  if (visualRow === null) {
    visual = 'not part of this run (no QA:visual gate); no visual, browser or screenshot check is claimed';
    rows.push(`- Visual/browser check: ${visual}`);
  } else visual = stateText(visualRow, 'gate QA:visual', rounds);
  const visualOk = visualRow !== null && visualRow.state === 'final';
  const line = `Verification claims (from the ledger): ${onFinal} of ${gl.length} gates hold a record for the final tree${failed.length > 0 ? `; failed on the final tree: ${failed.join(', ')}` : ''}${notFinal.length > 0 ? `; not on the final tree: ${notFinal.join(', ')}` : ''}; ${VISUAL}: ${visual}.`;
  const body = [
    '## Verification claims', '',
    'Generated from the gate records by the publish step and checked again by verify-completion-report; never edited by hand. A gate or check is "ran on the final tree" only when its record carries the fingerprint of the tree being published. No sentence outside this block may claim a visual, browser, screenshot or UI check.', '',
    ...rows, '', `Final message line (paste it unchanged): ${line}`,
  ];
  const hash = sha256(`${body.join('\n')}\n`);
  return { block: `${[CLAIMS_BEGIN, ...body, `${HASH}${hash}`, CLAIMS_END].join('\n')}\n`, line, visualOk, visual, hash };
}

/**
 * A block in the report that was edited by hand, or has no hash: the message to refuse with, else ''.
 * @param {string[]} lines the report lines
 */
export function checkClaimsBlock(lines) {
  const b = lines.indexOf(CLAIMS_BEGIN);
  if (b < 0) return '';
  const e = lines.indexOf(CLAIMS_END, b);
  if (e < 0) return `completion report: the '## Verification claims' block has no closing marker ${CLAIMS_END}; delete the block, the publish step writes it from the records (A341)`;
  const inner = lines.slice(b + 1, e);
  const h = inner.length > 0 ? inner[inner.length - 1] : '';
  const body = inner.slice(0, -1);
  if (!h.startsWith(HASH) || sha256(`${body.join('\n')}\n`) !== h.slice(HASH.length)) {
    return "completion report: the '## Verification claims' block was changed by hand (its hash does not match its text). The block is generated from the gate records and a claim in it is not yours to write: delete the whole block, the publish step writes it again (A341)";
  }
  return '';
}

/**
 * verify-completion-report: the block of the report in the run folder equals the one the records give now, and the hash recorded at publish.
 * @param {Context} ctx @param {string} dir @param {string} id @param {string} recordedHash the hash the ledger holds ('' for a report published before A341)
 * @returns {string} the message to fail with, else ''
 */
export function verifyClaimsBlock(ctx, dir, id, recordedHash) {
  if (recordedHash === '') return '';
  const lines = fileLines(ctx, `${dir}/COMPLETION_REPORT.md`);
  if (!lines.includes(CLAIMS_BEGIN)) return `completion report: the Verification claims block is missing (the ledger holds its hash ${recordedHash.slice(0, 12)}); publish the report again (A341)`;
  const bad = checkClaimsBlock(lines);
  if (bad !== '') return bad;
  const b = lines.indexOf(CLAIMS_BEGIN); const e = lines.indexOf(CLAIMS_END, b);
  const have = `${lines.slice(b, e + 1).join('\n')}\n`;
  const now = claimsBlock(ctx, dir, id);
  if (have !== now.block || now.hash !== recordedHash) return `completion report: the Verification claims block differs from what the gate records give now or from the hash recorded at publish; it was changed after publish or the records changed. Now: ${now.line} Publish the report again (A341)`;
  return '';
}

/** @typedef {{ lookAt: string[], execution: string[] | null, generatedLines: string[] }} Generated */

/**
 * The lead's own text as characters with their line numbers. Left out: the generated blocks (Verification claims, Facts), the Execution section that equals the one the script
 * generates (any other section of that name is read), the `Look at:` lines that are exactly the items copied from the QA record, and the exact lines the script generated
 * (`generatedLines`). Fenced code, code spans and the token of a gate name are NOT exempt.
 * @param {string[]} lines @param {Generated} g @returns {Array<[string, number]>}
 */
function ownChars(lines, g) {
  /** @type {Array<[string, number]>} */ const out = [];
  const genExec = g.execution === null ? null : trimEnd(g.execution);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === CLAIMS_BEGIN || l === FACTS_BEGIN) {
      const end = l === CLAIMS_BEGIN ? CLAIMS_END : FACTS_END;
      while (i < lines.length && lines[i] !== end) i++;
      continue;
    }
    if (/^## Execution[ \t]*$/.test(l) && genExec !== null) {
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('## ')) j++;
      const sec = trimEnd(lines.slice(i, j));
      if (sec.length === genExec.length && sec.every((x, k) => x === genExec[k])) { i = j - 1; continue; }
    }
    if (l.startsWith('Look at: ') && g.lookAt.includes(l.slice('Look at: '.length))) continue;
    if (g.generatedLines.includes(l)) continue;
    for (const c of l) out.push([c, i + 1]);
    out.push(['\n', i + 1]);
  }
  return out;
}

/** @param {string[]} a */
function trimEnd(a) { const b = [...a]; while (b.length > 0 && b[b.length - 1].trim() === '') b.pop(); return b; }

/** Replace every match of a pattern in a character list by the text `f` gives (the line of the first character is kept). @param {Array<[string, number]>} cs @param {RegExp} re @param {(m: RegExpExecArray) => string} f */
function rewrite(cs, re, f) {
  const text = cs.map((c) => c[0]).join('');
  /** @type {number[]} */ const at = []; for (let i = 0; i < cs.length; i++) for (let k = 0; k < cs[i][0].length; k++) at.push(i);
  /** @type {Array<[string, number]>} */ const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    for (let k = last; k < idx; k++) out.push([text[k], cs[at[k]][1]]);
    for (const c of f(/** @type {RegExpExecArray} */ (m))) out.push([c, cs[at[idx]][1]]);
    last = idx + m[0].length;
  }
  for (let k = last; k < text.length; k++) out.push([text[k], cs[at[k]][1]]);
  return out;
}

/** Named and numeric HTML entities decoded (up to three times, for &amp;#98;). @param {Array<[string, number]>} cs */
function decodeEntities(cs) {
  let cur = cs;
  for (let n = 0; n < 3; n++) {
    const next = rewrite(cur, /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi, (m) => {
      const e = asciiLower(m[1]);
      if (e.startsWith('#x')) { try { return String.fromCodePoint(parseInt(e.slice(2), 16)); } catch { return m[0]; } }
      if (e.startsWith('#')) { try { return String.fromCodePoint(parseInt(e.slice(1), 10)); } catch { return m[0]; } }
      return CLAIM_ENTITIES[e] ?? m[0];
    });
    if (next.length === cur.length && next.every((c, i) => c[0] === cur[i][0])) return next;
    cur = next;
  }
  return cur;
}

/**
 * The text a reader sees, as lower-case Latin characters: NFKC, no zero-width or format character (soft hyphen, ZWJ ...), HTML entities decoded, HTML comments and tags removed,
 * link syntax removed so a word split by it joins, look-alike Cyrillic and Greek letters mapped to Latin. Two variants: the markup characters (`*`, `_`, backslash, backtick, `~`)
 * deleted (a word split by emphasis joins), or replaced by a blank (a word between them stays a word).
 * @param {Array<[string, number]>} cs @returns {Array<Array<[string, number]>>}
 */
function readable(cs) {
  let c = rewrite(cs, /[^]/gu, (m) => m[0].normalize('NFKC'));
  const fmt = /[\p{Cf}\u034f\u180e]/gu;
  c = rewrite(c, fmt, () => '');
  c = decodeEntities(c);
  c = rewrite(c, fmt, () => '');
  c = rewrite(c, /<!--[^]*?-->/g, () => '');
  c = rewrite(c, /<\/?[A-Za-z][^>\n]*>/g, () => '');
  c = rewrite(c, /\]\([^)\n]*\)|\]\[[^\]\n]*\]|[[\]]/g, () => '');
  c = rewrite(c, /[^]/gu, (m) => CLAIM_CONFUSABLES[m[0]] ?? asciiLower(m[0]));
  return [rewrite(c, /[*_\\`~]/g, () => ''), rewrite(c, /[*_\\`~]/g, () => ' ')];
}

/** One regular expression for the vocabulary: whole words (a trailing * is any letters after the stem), a space is any white space (a line break too), a hyphen is a hyphen or white space. */
const VOCAB = new RegExp(`(?<![a-z0-9])(?:${CLAIM_VOCABULARY.map((w) => reEsc(w.replace(/\*$/, '')).replace(/ /g, '\\s+').replace(/-/g, '[\\s-]+') + (w.endsWith('*') ? '[a-z]*' : '')).join('|')})(?![a-z0-9])`, 'g');

/** The vocabulary words found in a text: [word, line]. @param {string[]} lines @param {Generated} g @returns {Array<[string, number]>} */
export function vocabularyHits(lines, g) {
  /** @type {Array<[string, number]>} */ const out = [];
  const seen = new Set();
  for (const variant of readable(ownChars(lines, g))) {
    const text = variant.map((c) => c[0]).join('');
    for (const m of text.matchAll(VOCAB)) {
      const w = m[0].replace(/\s+/g, ' '); const n = variant[m.index ?? 0]?.[1] ?? 0;
      if (!seen.has(`${w}|${n}`)) { seen.add(`${w}|${n}`); out.push([w, n]); }
    }
  }
  return out.sort((a, b) => a[1] - b[1]);
}

/**
 * The refusal message for the report text outside the generated parts, or '' when the visual check ran on the final tree or the text holds none of the vocabulary.
 * @param {string[]} lines the report lines @param {{ visualOk: boolean, visual: string }} claims @param {Generated} [g]
 */
export function auditClaims(lines, claims, g = { lookAt: [], execution: null, generatedLines: [] }) {
  if (claims.visualOk) return '';
  const hits = vocabularyHits(lines, g);
  if (hits.length === 0) return '';
  return `completion report: words of a visual, browser or screenshot check outside the generated blocks (A341):\n${hits.map(([w, n]) => `line ${n}: "${w}"`).join('\n')}\nRemove or rephrase the sentence without these words (no exemption: not in a negation, a code span or a code block; markup, entities and look-alike letters are read through). Whether a visual, browser or screenshot check ran is stated only by the generated '## Verification claims' block; it says now: ${claims.visual}. Copy its 'Final message line' unchanged into your final message and write no visual, browser or screenshot claim of your own.`;
}
