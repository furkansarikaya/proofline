// @ts-check
// Stop: the final report to the user carries the run's state, class and gate names verbatim (A44, TR-2): identifiers, never translated. A Stop hook
// cannot edit the assistant's message, so the hook supplies the missing lines itself, taken verbatim from `agent.sh summary`, as a systemMessage shown
// next to the report (A154: no block, no loop). A159: every /proofline command ends with one "Next step:" line; when the lead left it out the hook adds
// it from the user's last prompt (the command) and the run state (`agent.sh next-user`). A171, A193, A203: a message that asks the user to run an
// internal command or a command the lead can run itself is sent back once (and noted as friction).
import { readFileSync } from 'node:fs';
import { isFile, readText, rmf } from '../lib/fsx.mjs';
import { jesc, safe, textHasWord, hasWord } from '../lib/text.mjs';

// asks(): the line asks the user to do something (fr: also edit/modify/change)
const ASKS_FR = [
  /(please|kindly)[ \t\r\n\f\v]+(run|execute|paste|type|enter|edit|modify|change)/,
  /you[ \t\r\n\f\v]+(should|can|could|must|need to|have to|may)[ \t\r\n\f\v]+(run|execute|paste|type|enter|edit|modify|change)/,
  /(run|execute|paste|type|enter)[ \t\r\n\f\v]*:/,
  /^[ \t\r\n\f\v>*-]*(run|execute|paste|type|enter|edit|modify|change)[ \t\r\n\f\v]/,
  /(in|into) (your|a) terminal/,
  /^[ \t\r\n\f\v>*-]*!/,
];
const ASKS_SC = [
  /(please|kindly)[ \t\r\n\f\v]+(run|execute|paste|type|enter)/,
  /you[ \t\r\n\f\v]+(should|can|could|must|need to|have to|may)[ \t\r\n\f\v]+(run|execute|paste|type|enter)/,
  /(run|execute|paste|type|enter)[ \t\r\n\f\v]*:/,
  /^[ \t\r\n\f\v>*-]*(run|execute|paste|type|enter)[ \t\r\n\f\v]/,
  /(in|into) (your|a) terminal/,
  /^[ \t\r\n\f\v>*-]*!/,
];
const NAMED_FR = /agent\.sh[ \t\r\n\f\v]+[a-z]|--no-verify/;
const MUT = /(edit|modify|change|append|overwrite|delete|remove|rm|mv|cp|sed|tee|touch|vim|nano|echo|printf|cat)[ \t\r\n\f\v]|>/;
const NAMED_SC = /(^|[`:!$]|[ \t\r\n\f\v](run|execute))[ \t\r\n\f\v]*(uptime|ps|top|df|free|du|lsof|pgrep|vmstat|whoami|hostname|uname|nproc|pwd|which|printenv|git (status|log|diff|branch|remote|rev-parse)|gh (pr|run) (view|list|checks|status))([ \t\r\n\f\v`]|$)/;

/** awk's tolower in the C locale. @param {string} t */
const lower = (t) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The awk scanners of the Stop hook: a line that names the command AND asks for it, or a command named inside a code fence announced by a line that asks.
 * @param {string} msg @param {RegExp[]} asksRe @param {(t: string) => boolean} named
 */
function requested(msg, asksRe, named) {
  const asks = (/** @type {string} */ t) => { const l = lower(t); return asksRe.some((r) => r.test(l)); };
  let fence = false; let fa = false; let prev = false; let hit = false;
  for (const line of msg.split('\n')) {
    if (/^[ \t\r\n\f\v]*```/.test(line)) { fence = !fence; if (fence) fa = prev; continue; }
    if (fence) { if (named(line) && fa) hit = true; } else { if (named(line) && asks(line)) hit = true; prev = asks(line); }
  }
  return hit;
}

/** The last assistant message of a session log, as `jq -rs` printed it. @param {string} file */
function transcriptMessage(file) {
  try {
    const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    const last = rows.filter((r) => r && r.type === 'assistant').pop();
    const c = last?.message?.content;
    if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
    return typeof c === 'string' ? c : c == null ? 'null' : JSON.stringify(c);
  } catch { return ''; }
}

/** @param {string} reason */
const block = (reason) => `{"decision":"block","reason":"${jesc(reason)}"}\n`;

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  if (!ctx.parsed || ctx.sub || ctx.role !== 'lead') return undefined;
  if (!ctx.installed) return undefined;
  await ctx.flush();
  // A169: the identifier check runs only for the final report of a run, the message that ends a turn in which the lead ran a report command
  // (marked by pretool, see report-turn); an ordinary answer gets nothing appended.
  const sess = safe(ctx.get('session_id')) || 'unknown';
  const turn = `${ctx.localDir}/report-turn/${sess}`;
  const finalReport = isFile(turn);
  if (finalReport) rmf(turn);
  let msg = ctx.get('last_assistant_message');
  if (msg === '') {
    const tp = ctx.get('transcript_path');
    if (tp !== '' && isFile(tp)) msg = transcriptMessage(tp).replace(/\n+$/, '');
  }
  if (msg === '') return undefined;
  const again = ctx.get('stop_hook_active') === 'true';
  const act = ctx.act;
  const actOk = act !== '' && act !== 'INVALID';
  let out = '';
  if (finalReport && actOk) {
    const r = await ctx.agent(['report-tokens', act]);
    let need = r.stdout.replace(/\n+$/, '');
    if (r.status !== 0) { // a moved command that failed (a missing node: 127): the identifier check cannot run, so the report is not passed unchecked
      need = '';
      const mc = `proofline: agent.sh report-tokens exited ${r.status}, so the final report's identifiers could not be checked: this command runs in Node and the user must check that Node 22.13 or newer is on PATH; tell the user and do not claim the report is complete`;
      if (!again) return block(mc);
      out = mc;
    }
    const missing = need.split(/[ \t\n]+/).filter((t) => t !== '' && !textHasWord(msg, t));
    if (missing.length) {
      const s = await ctx.agent(['summary', act]);
      const summ = s.stdout.replace(/\n+$/, '');
      if (s.status !== 0 && summ === '') { // the same rule for the second moved command of this check
        const mc = `proofline: agent.sh summary exited ${s.status}, so the missing identifiers could not be appended: this command runs in Node and the user must check that Node 22.13 or newer is on PATH`;
        if (!again) return block(mc);
      }
      /** @type {string[]} */ const lines = [];
      for (const tk of missing) {
        const l = summ.split('\n').find((x) => hasWord(x, tk)) ?? tk;
        if (!lines.includes(l)) lines.push(l);
      }
      out = `proofline: the final report lacks these identifiers:${missing.map((t) => ` ${t}`).join('')}. They are appended here verbatim from 'agent.sh summary ${act}' (never translated):${lines.map((l) => `\n${l}`).join('')}`;
    }
  }
  // the command of the user's last prompt: "/proofline <command> [<TASK-ID>]" ("$proofline" for Codex); the first line of the capture file, its
  // "text" value up to the first escaped newline
  let pc = '';
  const cap = `${ctx.sharedLocal}/prompts/${sess}.json`;
  if (isFile(cap)) {
    const first = readText(cap).split('\n')[0] ?? '';
    const k = first.indexOf('"text":"');
    if (k >= 0 && first.endsWith('"}')) {
      pc = first.slice(k + 8, -2);
      const nl = pc.indexOf('\\n');
      if (nl >= 0) pc = pc.slice(0, nl);
    }
  }
  if (pc.startsWith('/proofline ') || pc.startsWith('$proofline ')) {
    const words = pc.split(/[ \t\n]+/).filter((w) => w !== '');
    const pcmd = words[1] ?? '';
    let pid = words[2] ?? '';
    if (pid.startsWith('-') || /[^A-Za-z0-9_-]/.test(pid) || !pid.includes('-')) pid = '';
    if (!msg.includes('Next step:')) {
      const n = await ctx.agent(['next-user', pcmd, ...(pid !== '' ? [pid] : [])]);
      const nu = n.status === 0 ? n.stdout.replace(/\n+$/, '') : '';
      if (nu !== '') out = `${out !== '' ? `${out}\n` : ''}${nu}`;
    }
  }
  // A193: Claude Code rejects a Skill call for a proofline skill itself (disable-model-invocation) before any hook runs, so the hook cannot answer it.
  // What it can do is catch the turn that gives up on it: a message that quotes that error, or asks the user to run /proofline:proofline-<skill>,
  // is sent back once with the file to read.
  if ((msg.includes('disable-model-invocation') || msg.includes('/proofline:proofline-')) && !again) {
    const plugin = ctx.env.CLAUDE_PLUGIN_ROOT ?? '';
    const rf = plugin !== '' ? `${plugin}/skills` : `${ctx.root}/.agents/skills`;
    return block(`proofline: do not ask the user to run a proofline skill and do not stop at the Skill tool error: every proofline skill is disable-model-invocation. Read the skill file (${rf}/<name>/SKILL.md, for example ${rf}/proofline-lead/SKILL.md) and continue with the same step.`);
  }
  // A193: the request is also refused (the message is sent back once) and it covers --no-verify, the edit of a file under .agents/ and a command
  // started with "!"; a command that is the user's own work (git push, gh auth login, a plugin update) is never matched.
  let frHit = false;
  if (msg.includes('agent.sh') || msg.includes('--no-verify') || msg.includes('.agents/')) {
    frHit = requested(msg, ASKS_FR, (t) => NAMED_FR.test(t) || (/[.]agents\//.test(t) && MUT.test(lower(t))));
  }
  // A203: the lead also never asks the user to run a command it can run itself: a read-only look at the machine or the repository.
  let scHit = false;
  if (/[Rr]un|[Ee]xecute|terminal/.test(msg)) scHit = requested(msg, ASKS_SC, (t) => NAMED_SC.test(lower(t)));
  if (scHit && !frHit) {
    if (!again && actOk) await ctx.agent(['friction-note', act, 'user-shell']);
    if (!again) return block('proofline: do not make the user run a command you can run yourself (uptime, ps, df, git status, gh pr view ...): run it with your own Bash tool and use its output. Only the user\'s own work is theirs (git push, gh auth login, a plugin update, a login). A171, A203.');
    out = `${out !== '' ? `${out}\n` : ''}proofline: this message asks the user to run a command the lead can run itself. That is friction (A203), noted in the friction report.`;
  }
  if (frHit) {
    if (!again && actOk) await ctx.agent(['friction-note', act, 'user-command']);
    if (!again) return block('proofline: Do not make the user do this: this message asks the user to run an internal command (agent.sh, approve, answer, --no-verify) or to edit a file under .agents/ by hand. Either do it yourself through the right path, or report it in one line as a proofline bug and write it to the friction report (A171, A193). The user\'s own work (git push, gh auth login, a plugin update) may stay in the message.');
    out = `${out !== '' ? `${out}\n` : ''}proofline: this message asks the user to run an internal command (agent.sh ...). That is a proofline bug (A171), noted in the friction report. The lead runs internal commands itself and tells the user only the one-line state and a /proofline next step.`;
  }
  if (out === '') return undefined;
  return `{"systemMessage":"${jesc(out)}"}\n`;
}
