// @ts-check
// Stage 3: the write-time language check (agent.sh `language_check`, A171). The first pass of the scan is here: it counts the non-English
// letters outside the exempt lines and says whether the text can be a problem at all; an English write (the usual one) costs no process.
// A text with a hit may still be cleared by a quotation of product text (committed content, TASK.md, the user's prompts): that lookup
// is the shell's `language_ok_pieces`, run by the shell code for exactly that case (NEEDS-LATER: its port).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readBytes, textLines } from './records.mjs';
import { sortedNames, sharedDirOf } from './approvals.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const FOREIGN = /\xc3[\x80-\x96\x98-\xb6\xb8-\xbf]|[\xc4\xc5\xce\xcf\xd0-\xd4]|[\xe3-\xe9][\x80-\xbf]/g;
const WSP = '[ \\t\\n\\v\\f\\r]';
const trim = (/** @type {string} */ t) => t.replace(new RegExp(`^${WSP}+|${WSP}+$`, 'g'), '');

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
 * The first pass of `language_scan` over one text: the line where the third foreign letter appears, or 0.
 * @param {string} text @param {string} file the path the rules look at @param {string} hint @param {string} history the captured prompts
 */
export function scanLine(text, file, hint, history) {
  if (/\/runs\/[^]*\/reviews\/visual-proof\/|\/runs\/[^]*\/reports\/qa-evidence\//.test(file)) return 0; // machine output (A172)
  if (questionFile(file)) return 0;
  const own = /\/questions\/[^]*\.answer\.md$|\/questions\/[^]*\.answer\.amended-[^]*\.md$|\/approvals\/|\/runs\/[^]*\/TASK\.md$/.test(file);
  let lines = textLines(text);
  if (/\/COMPLETION_REPORT\.md$/.test(file) || hint.includes('COMPLETION_REPORT.md')) lines = blankSummary(lines);
  const blob = new Set();
  for (const l of textLines(history)) blob.add(l);
  let fence = false; let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(`^${WSP}*\`\`\``).test(line)) { fence = !fence; continue; }
    let t = line;
    let skip = false;
    if (fence || new RegExp(`^${WSP}*>`).test(line)) {
      if (own) skip = true;
      else { t = t.replace(new RegExp(`^${WSP}*>${WSP}?`), ''); const q = trim(t); if (q === '' || blob.has(q)) skip = true; }
    }
    if (skip) continue;
    const c = (t.match(FOREIGN) ?? []).length;
    if (c === 0) continue;
    total += c;
    if (total >= 3) return i + 1;
  }
  return 0;
}

/**
 * `language_check FILE|- [PATH]`: exit 0 when the text is English (or its non-English part is quoted product text), else exit 1 and the
 * refusal on stdout. @param {Context} ctx @param {string[]} args @param {string} stdin the text for `-`
 */
export function languageCheck(ctx, args, stdin) {
  const f = args[0] === undefined || args[0] === '' ? '-' : args[0];
  const hint = args[1] ?? '';
  const stdinMode = f === '-';
  const file = stdinMode ? `${tmpdir()}/proofline-lang.stdin` : f;
  const text = stdinMode ? stdin : (isFile(f) ? readBytes(f) : null);
  if (text === null) return 0; // language_scan: `[ -f FILE ] || continue`
  let history = '';
  for (const n of sortedNames(`${sharedDirOf(ctx, 'prompts')}/history`, /\.txt$/)) history += readBytes(`${sharedDirOf(ctx, 'prompts')}/history/${n}`) ?? '';
  if (scanLine(text, file, hint, history) === 0) return 0;
  // a hit: the quotation lookup (committed product text, TASK.md, the user's prompts) is the shell's
  const dir = mkdtempSync(`${tmpdir()}/proofline-lang-`);
  try {
    let target = f;
    if (stdinMode) { target = `${dir}/text`; writeFileSync(target, Buffer.from(text, 'latin1'), { mode: 0o600 }); }
    const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, 'language-check', target, ...(hint !== '' ? [hint] : [])], { cwd: ctx.cwd, env: { ...ctx.env, PROOFLINE_ENGINE: 'sh' }, stdio: ['ignore', 'pipe', 'pipe'], allowEqualTree: true });
    ctx.out(r.stdout.toString('latin1'));
    if (r.stderr.length) ctx.err(r.stderr.toString('latin1'));
    return r.status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
