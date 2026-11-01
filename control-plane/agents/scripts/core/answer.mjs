// @ts-check
// Stage 3: `answer ID N [--captured|--amend]` (agent.sh 0.0.42). An answer is the user's when it is the user's captured message (or, typed
// by the lead, contained in the newest capture that is not older than the question and whose hash matches its text); an `accept <id>` the
// user's prompt does not carry is the lead's, never the user's. The status block update is a command that takes the locks itself, so the locks
// are released before it runs (the shell ran it in the same process under the same locks; it is best effort either way).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { approvalNormSpace, latestCapture, quoteLines, sortedNames } from './approvals.mjs';
import { captureField } from './capture.mjs';
import { requireLead } from './approve.mjs';
import { fail } from './errors.mjs';
import { sha256 } from './hash.mjs';
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
  // Stage 3 hardening (deliberately unlike the shell, which read the newest capture or history FILE and called it the user's): the user's words
  // are known to the prompt hook alone, which hands the message it is handling to this command in its own process (`ctx.io.promptCapture`, the same
  // handoff as for an approval). From the hook only an acceptance of an assumption is recorded this way. Anything typed by the lead is the lead's.
  const handed = /** @type {{ promptCapture?: { session: string, time: number, sha256: string, text: string } }} */ (ctx.io).promptCapture;
  if (mode === '--captured' && !handed) fail('answer --captured is recorded by the prompt hook from the user\'s own message and by nothing else: pass the answer on stdin (it is then recorded as the lead\'s answer, answered_by=lead) and keep asking the user for the acceptance of an assumption');
  if ((mode === '--captured' || amend) && handed) {
    cm = true;
    if (latestCapture(ctx, true) === null) fail('the capture of this message is not on disk as the hook wrote it');
    let a0 = gateField(ctx, q, 'asked_at'); if (!/^[0-9]+$/.test(a0)) a0 = '0';
    if (BigInt(handed.time) < BigInt(a0)) fail(`this message is older than question ${n}`);
    pick = `${handed.time}-${handed.sha256.slice(0, 8)}.txt`;
    if (consumed().includes(pick)) fail(`this message (${pick}) already answered another question`);
    text = Buffer.from(handed.text, 'utf8').toString('latin1'); used = pick; src = pick;
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
  if (cm) {
    by = 'user';
    if (tok !== '' && assumptionPromptAccepts(norm, tokId)) acc = true;
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
  if (src !== '') ctx.out(`answer source: the user's message ${src} (${epochIso(src.slice(0, src.indexOf('-')))}): ${(readBytes(`${prompts}/history/${src}`) ?? '').replace(/[ \t\n\v\f\r]+/g, ' ').slice(0, 80)}\n`);
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
  const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, 'status-block', id, 'answer'], { cwd: ctx.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.stderr.length) ctx.err(r.stderr.toString('latin1'));
}


