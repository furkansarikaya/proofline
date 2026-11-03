// @ts-check
// The lead's own D13 question block (`ask`) and the assumption register check (`verify-assumptions`): stored like a specialist's NEEDS_INPUT so
// `questions`, `answer` and `next` treat both alike.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { bytes } from './config.mjs';
import { now } from './clock.mjs';
import { fail, unsupported } from './errors.mjs';
import { requireLead, requireOpenRun, nextNum, runLanguage } from './approve.mjs';
import { hashFile } from './fingerprint.mjs';
import { setRunValue } from './lifecycle.mjs';
import { ledgerAppend } from './ledger.mjs';
import { assumptionRegister, assumptionShapeErrors, assumptionState } from './plancheck.mjs';
import { sha256 } from './hash.mjs';
import { fileText, gatesEnforced, sectionKeyPresent, textLines } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { statusBlockUpdate } from './statusblock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `ledger_token PATH ID`: RUN-RELATIVE-PATH@sha256 of the file. @param {string} dir @param {string} rel */
export function ledgerToken(dir, rel) { return `${rel}@${hashFile(`${dir}/${rel}`)}`; }

/**
 * `ask_question ID SRC`: record the question block. TEXT is the block (the lead's file or stdin); a leading `QUESTIONS:` line is dropped and at
 * least one numbered question is required.
 * @param {Context} ctx @param {string} id @param {string} text a byte string
 * @returns {string} the number of the question
 */
export function askQuestion(ctx, id, text) {
  requireRun(ctx, id);
  requireLead(ctx);
  requireOpenRun(ctx, id);
  const dir = runDir(ctx, id);
  const body = textLines(text).filter((l) => !/^QUESTIONS:[ \t\n\v\f\r]*$/.test(l)).map((l) => `${l}\n`).join('');
  if (!/^[0-9]+\. [^ \t\n\v\f\r]/m.test(body)) fail("ask needs numbered questions ('1. <question>', then options, recommended, why)");
  mkdirSync(`${dir}/questions`, { recursive: true });
  const n = nextNum(`${dir}/questions`);
  let sess = '';
  for (const v of [ctx.env.CLAUDE_CODE_SESSION_ID, ctx.env.CODEX_SESSION_ID, ctx.env.CODEX_THREAD_ID]) if (v) { sess = v; break; }
  if (/[^A-Za-z0-9_.-]/.test(sess)) sess = '';
  writeFileSync(`${dir}/questions/${n}.md`, Buffer.from(`from: ${ctx.role}\nasked_at: ${now().epoch}\n${sess !== '' ? `asked_session: ${sess}\n` : ''}---\n${body}`, 'latin1'));
  ctx.forget('file:');
  if (sectionKeyPresent(ctx, dir, 'execution', 'awaiting_input')) setRunValue(ctx, id, 'execution', 'awaiting_input', 'true');
  if (gatesEnforced(ctx, dir)) { ledgerAppend(dir, ctx.role, 'ask', '-', '-', ledgerToken(dir, `questions/${n}.md`)); ctx.forget('file:'); }
  statusBlockUpdate(ctx, id, 'ask');
  return n;
}

/** `ask ID [--file F]` @param {Context} ctx @param {string[]} args */
export function askCommand(ctx, args) {
  requireLead(ctx);
  const id = args[0];
  if (id === undefined || id === '') throw unsupported('usage');
  let src = '';
  if (args[1] === '--file') { if (args[2] === undefined || args[2] === '') throw unsupported('usage'); src = args[2]; }
  requireRun(ctx, id);
  requireOpenRun(ctx, id);
  let text;
  if (src !== '') {
    try { text = readFileSync(src, 'latin1'); } catch { fail(`question file not found: ${src}`); }
  } else {
    const given = /** @type {{ stdinText?: string }} */ (ctx.io).stdinText;
    if (given !== undefined) text = bytes(given);
    else { try { text = readFileSync(0, 'latin1'); } catch { text = ''; } }
  }
  const n = askQuestion(ctx, id, text);
  ctx.out(`question recorded: ${id} ${n} (relay it verbatim with 'agent.sh questions ${id}')\n`);
  return 0;
}

/**
 * `assumption_states ID`: [id, risk, state, ref, text] rows.
 * @param {Context} ctx @param {string} dir @returns {string[][]}
 */
export function assumptionStates(ctx, dir) {
  return assumptionRegister(ctx, dir).map(([a, r, s, t]) => {
    if (s === 'verified') return [a, r, 'verified', '-', t];
    const st = assumptionState(ctx, dir, `${a}@${sha256(t).slice(0, 12)}`);
    if (st.startsWith('accepted')) return [a, r, 'accepted-by-user', st.slice('accepted '.length), t];
    return r === 'high' ? [a, r, 'blocked', st, t] : [a, r, 'unverified', '-', t];
  });
}

/**
 * `verify_assumptions ID [ask]`: the shape of both registers, then every unverified high-risk assumption must be answered `accept` by the user.
 * With `ask` (the freeze) each one without a question gets its NEEDS_INPUT question.
 * @param {Context} ctx @param {string} id @param {boolean} ask
 */
export function verifyAssumptions(ctx, id, ask) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (fileText(ctx, `${dir}/PLAN.md`) === null) fail('missing PLAN.md');
  const err = assumptionShapeErrors(ctx, dir).map((e) => `${e};`).join('');
  if (err !== '') fail(`invalid '## Assumptions': ${err}`);
  const all = assumptionStates(ctx, dir);
  for (const [a, r, s, ref] of all) if (s !== 'verified') ctx.out(`${a} risk=${r} status=${s}${ref !== '-' ? ` ref=${ref}` : ''}\n`);
  const blocked = all.filter((x) => x[2] === 'blocked');
  if (blocked.length === 0) { ctx.out(`assumptions verified: ${id}\n`); return; }
  let msg = '';
  for (const [a, , , ref, t] of blocked) {
    let doAsk = false;
    if (ref.startsWith('pending')) msg += ` ${a}: its question ${ref.slice(8)} is unanswered (relay it: 'agent.sh questions ${id}'; the user answers 'accept ${a}' or gives the corrected fact);`;
    else if (ref.startsWith('declined')) {
      if (ask) { doAsk = true; msg += ` ${a}: the answer ${ref.slice(9)} did not accept it (not the user's own accept, or a corrected fact: change the plan or verify the assumption);`; }
      else msg += ` ${a}: the answer ${ref.slice(9)} did not accept it (verify it or change the decisions it affects in the plan, then freeze again);`;
    } else if (ask) doAsk = true;
    else msg += ` ${a}: no question bound to it yet ('agent.sh freeze ${id}' records one);`;
    if (doAsk) {
      const row = assumptionRegister(ctx, dir).find((x) => x[0] === a) ?? [];
      const [src, method, decisions] = [row[4] ?? '', row[5] ?? '', row[6] ?? ''];
      const tok = `${a}@${sha256(t).slice(0, 12)}`;
      const q = runLanguage(ctx, id) === 'tr'
        ? bytes(`1. Yüksek riskli varsayım ${a} doğrulanmadı: ${t}\n   kaynak: ${src}; doğrulama: ${method}; etkilediği kararlar: ${decisions}\n   ASSUMPTION: ${tok}\n   seçenekler: "accept ${a}" yazın (kimlik ifadenin parçasıdır; bu varsayımla ilerlenir, cevabınızla kabul edilmiş olarak kaydedilir) | düzeltilmiş olgu (plan değiştirilir, varsayım yeniden denetlenir)\n   önerilen: doğrulanabiliyorsa düzeltilmiş olgu, aksi halde accept\n   neden: freeze doğrulanmamış yüksek riskli varsayımı reddeder; sessizce kabul edilmez\n`)
        : `1. High-risk assumption ${a} is unverified: ${t}\n   source: ${src}; verification: ${method}; affects: ${decisions}\n   ASSUMPTION: ${tok}\n   options: "accept ${a}" (the id is part of the phrase; proceed on this assumption, recorded as accepted-by-user with your answer) | the corrected fact (the plan is changed and the assumption checked again)\n   recommended: the corrected fact when it can be checked, otherwise accept\n   why: freeze refuses an unverified high-risk assumption; it is never accepted silently\n`;
      askQuestion(ctx, id, q);
      msg += ` ${a}: question recorded (relay it: 'agent.sh questions ${id}');`;
    }
  }
  fail(`unverified high-risk assumption(s) block the freeze; they are never accepted silently, the user answers each:${msg}`);
}
