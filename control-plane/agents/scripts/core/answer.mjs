// @ts-check
// `answer ID N [--captured|--amend]`. An answer is the user's only when the prompt hook hands over the message it is handling (`--captured`, `--amend`):
// the core never reads the user's words from a file. Text the lead types is the lead's answer; an `accept <id>` the user's prompt does not carry is the lead's, never the user's. The status block update is a command that takes the locks itself, so the locks
// are released before it runs (the shell ran it in the same process under the same locks; it is best effort either way).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { approvalNormSpace, latestCapture, quoteLines, sortedNames } from './approvals.mjs';
import { captureField } from './capture.mjs';
import { requireLead } from './approve.mjs';
import { fail } from './errors.mjs';
import { asciiLower } from './shellglob.mjs';
import { setRunValue } from './lifecycle.mjs';
import * as proc from './proc.mjs';
import { ledgerAppend } from './ledger.mjs';
import { fileLines, gateField, gatesEnforced, readBytes, sectionKeyPresent } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { sharedDirOf } from './approvals.mjs';
import { isFile } from './paths.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const NEGATION = /(^|[^A-Za-z])(not|never|no|nope|n't|don't|dont|do not|only if|if|unless|but|except|until|yet|wait|without|maybe|reject|rejected|decline|declined|or|actually|instead|rather|değil|degil|hayır|hayir|reddet|reddediyorum|yerine|olmasın|olmasin|sadece eğer|sadece eger|ama|eğer|eger)([^A-Za-z]|$)/;
const NEGATION_BYTES = new RegExp(Buffer.from(NEGATION.source, 'utf8').toString('latin1'));

/** `assumption_prompt_accepts PROMPT ID` @param {string} prompt @param {string} id */
export function assumptionPromptAccepts(prompt, id) {
  const lower = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const p = lower(prompt).replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ /, '');
  const rest = p.replace(/^((accept|accepted) as-[0-9]+( *(,|;|&|and) *)?)+/, '');
  if (rest === p) return false;
  const head = p.endsWith(rest) ? p.slice(0, p.length - rest.length) : p;
  try { if (!new RegExp(`(accept|accepted) ${lower(id)}([^0-9]|$)`).test(head)) return false; } catch { return false; }
  return !NEGATION_BYTES.test(` ${rest} `);
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

/**
 * The answer forms a question lists: the items of its `options:` / `seçenekler:` line (separated by | or ,, quotes and a leading `a)` removed). A
 * message is an accepted answer when, in lower case with the white space folded, it starts with exactly ONE listed form (followed by the end or a
 * non-letter) and the rest holds no negation or condition. Anything else (two forms, none, a hedge) records nothing.
 * @param {string} norm @param {string[]} lines
 */
function matchesAcceptedForm(norm, lines) {
  const opt = lines.find((l) => /^[ \t]*(options|seçenekler|secenekler):/i.test(l));
  if (!opt) return false;
  const forms = [...new Set(opt.slice(opt.indexOf(':') + 1).split(/\|/).map((x) => (/"([^"]+)"/.exec(x)?.[1] ?? x.trim().replace(/^[a-z]\)\s*/i, '').replace(/^['`]|['`]$/g, '')).trim()).map(asciiLower).filter((x) => x !== ''))];
  const msg = asciiLower(norm).replace(/^[ \t\n]+/, '').replace(/[.!]+$/, '');
  const hits = forms.filter((f) => msg === f || (msg.startsWith(f) && !/[a-zçğıöşü0-9]/i.test(msg.charAt(f.length))));
  if (hits.length !== 1) return false;
  return !NEGATION_BYTES.test(` ${msg.slice(hits[0].length)} `);
}

const TOKEN_LINE = /^[ \t\n\v\f\r]*ASSUMPTION: ([^ \t\n\v\f\r]*)[ \t\n\v\f\r]*$/;

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
  let acc = false; let by = 'lead';
  let asked = gateField(ctx, q, 'asked_at'); if (!/^[0-9]+$/.test(asked)) asked = '';
  const norm = approvalNormSpace(text);
  const qtext = fileLines(ctx, q);
  if (cm) {
    by = 'user';
    if (tok !== '' && assumptionPromptAccepts(norm, tokId)) acc = true;
    else if (tok === '' && userOnlyKind(qtext) !== '') {
      // a split override or another user-only question: the single open one, answered by one of the forms the question lists
      if (openUserOnly(ctx, dir) !== 1) fail(`question ${n} is not the only open user-only question: ask the user again`);
      if (!matchesAcceptedForm(norm, qtext)) fail(`this message is not one of the accepted answers of question ${n} (nothing is recorded; ask the user again)`);
      acc = true;
    } else if (tok === '') fail(`question ${n} is not a question the user answers through the prompt hook (the lead types the answer; it is recorded as the lead's)`);
    // the prompt hook tries every open user-only question with each message it handles: it records an acceptance or an accepted form and nothing else
    if (!acc) fail(`this message is not an acceptance of the assumption of question ${n} (only an acceptance is recorded as the user's answer from the hook)`);
  }
  let body = text;
  if (tok !== '' && /^accept/i.test(norm)) {
    if (acc) body = `accept ${tokId}\n`; else by = 'lead';
  } else if (by === 'user') body = quoteLines(text);
  let amends = '';
  if (amend) {
    let k = 1;
    while (existsSync(`${q.slice(0, -3)}.answer.amended-${k}.md`)) k++;
    amends = `${q.slice(q.lastIndexOf('/') + 1, -3)}.answer.amended-${k}.md`;
    const old = readBytes(prev) ?? '';
    const lines = old === '' ? [] : old.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    writeFileSync(`${dir}/questions/${amends}`, Buffer.from(lines.length === 0 ? '' : `amended: true\namended_at: ${now().epoch}\n${lines.map((l) => `${l}\n`).join('')}`, 'latin1'));
    rmSync(prev, { force: true });
  }
  const t = now();
  let head = `answered_by: ${by}\ntime: ${t.iso}\nanswered_epoch: ${t.epoch}\n`;
  if (src !== '') head += `source_message: ${src}\n`;
  if (amends !== '') head += `amends: ${amends}\n`;
  if (ctx.cancelled()) fail('answer refused: the prompt hook stopped waiting for this step (its time budget ended)');
  writeFileSync(prev, Buffer.from(`${head}---\n${body}`, 'latin1'));
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

/** `status_block_update ID answer`: best effort; the command takes the locks itself, so ours go first. @param {Context} ctx @param {string} id */
function statusBlock(ctx, id) {
  if (ctx.config().get('tasks.status_block', 'on') === 'off') return;
  ctx.locks?.releaseAll();
  const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, 'status-block', id, 'answer'], { cwd: ctx.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'], allowEqualTree: true });
  if (r.stderr.length) ctx.err(r.stderr.toString('latin1'));
}


