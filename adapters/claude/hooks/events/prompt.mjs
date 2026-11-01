// @ts-check
// UserPromptSubmit: the user-prompt capture for approvals and answered_by (GATES.md "Approvals"), then the approval step. Never for a dispatched
// specialist, whose prompt is the lead's. THE CAPTURE CONTRACT IS BYTE FOR BYTE (Invariant 3): the intake copy of the raw event (written by
// lib/context.mjs before anything else), prompts/<session>.json `{"session","time","sha256","text"}`, the history copy prompts/history/<time>-<sha8>.txt,
// the capture id <session>:<time>:<sha256>. The order is fixed: 1. the critical records (nothing else before them); 2. housekeeping; 3. the
// approval, bounded in time; 4. the ledger flush.
import { readFileSync, statSync, rmSync } from 'node:fs';
import { append, isDir, isFile, mkdirp, names, put, putAtomic, readText, rmf } from '../lib/fsx.mjs';
import { jescExact, jesc, jgetRaw, safe, sha256 } from '../lib/text.mjs';

const REQUEST = /^[0-9]{3}-request-.*\.yaml$/;

/** Does any file under one of the folders hold the text? (`grep -rlF`) @param {string[]} dirs @param {string} needle */
function anyFileHolds(dirs, needle) {
  /** @param {string} d @returns {boolean} */
  const walk = (d) => {
    for (const n of names(d)) {
      const p = `${d}/${n}`;
      if (isDir(p)) { if (walk(p)) return true; } else if (isFile(p) && readText(p).includes(needle)) return true;
    }
    return false;
  };
  return dirs.some(walk);
}

/** The first N lines that start with PREFIX, the prefix removed, each cut to CUT characters (when given). @param {string} text @param {string} prefix @param {number} n @param {number} [cut] */
function prefixed(text, prefix, n, cut) {
  return text.split('\n').filter((l) => l.startsWith(prefix)).slice(0, n).map((l) => (cut ? [...l.slice(prefix.length)].slice(0, cut).join('') : l.slice(prefix.length)));
}

/** The approval step's messages from its output, after PREV (a recorded approval replaces it, the other lines are appended). @param {string} out @param {string} prev */
function approvalMessages(out, prev) {
  let msgs = prev;
  const ok = prefixed(out, 'approved: ', 3);
  const bad = prefixed(out, 'not recorded: ', 1)[0] ?? '';
  if (ok.length) msgs = `proofline: approval recorded: ${ok.join(';')}`;
  if (bad !== '') msgs = `${msgs !== '' ? `${msgs} ` : ''}proofline: approval NOT recorded: ${[...bad].slice(0, 240).join('')} (the lead retries at the next 'agent.sh next'; log: .agents/local/approve.log). No command is needed from you.`;
  const mu = prefixed(out, 'multi: ', 11, 200);
  if (mu.length) msgs = `${msgs !== '' ? `${msgs} ` : ''}proofline: several approvals in one message: ${mu.join(';')}`;
  return msgs;
}

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  if (!ctx.parsed || ctx.sub || ctx.role !== 'lead') return undefined;
  const pt = jgetRaw(ctx.input, 'prompt'); // the prompt exactly as sent
  // A finished background agent arrives as a "prompt" (<task-notification>): not the user's words. It must not replace the user's capture
  // (an answer recorded afterwards compared against it) and cannot approve anything.
  if (pt.startsWith('<task-notification>')) return undefined;
  if (!ctx.once()) return undefined;
  const sess = safe(ctx.get('session_id')) || 'unknown';
  const prompts = `${ctx.sharedLocal}/prompts`;
  if (!isDir(prompts) && !mkdirp(prompts)) return undefined;
  ctx.tick(); const c0 = ctx.v;
  const h = sha256(Buffer.from(pt, 'utf8'));
  const capS = ctx.s; // the capture id of THIS message keeps this second
  try { putAtomic(`${prompts}/${sess}.json`, `${prompts}/.${sess}.tmp`, `{"session":"${sess}","time":${ctx.s},"sha256":"${h}","text":"${jescExact(pt)}"}\n`); } catch { /* the intake copy still holds the message */ }
  // Every prompt is kept (raw text) so an answer recorded as the user's can be checked against what was said (A60).
  try { if (isDir(`${prompts}/history`) || mkdirp(`${prompts}/history`)) put(`${prompts}/history/${ctx.s}-${h.slice(0, 8)}.txt`, pt); } catch { /* ignore */ }
  ctx.step('capture', c0);
  // The previous run of this hook did not finish (killed at the runtime's timeout): say so plainly. An .approving- marker of another session
  // that is older than two minutes is left over from a killed hook too: removed (A171), never reported here.
  const marker = `${prompts}/.approving-${sess}`;
  let warn = '';
  if (isFile(marker)) {
    warn = "proofline: the approval hook for the user's previous message did not finish (it timed out), so an approval in that message was NOT recorded. Tell the user plainly that the approval was not recorded and ask them to repeat it.";
    rmf(marker);
  }
  const old = Date.now() - 2 * 60000;
  for (const n of names(prompts)) {
    if (!n.startsWith('.approving-')) continue;
    try { if (statSync(`${prompts}/${n}`).mtimeMs < old) rmSync(`${prompts}/${n}`, { force: true }); } catch { /* gone */ }
  }
  ctx.sweep();
  trimSpool(`${ctx.localDir}/hook-times`);
  // Approvals are recorded here, by the runtime, from the user's own reply (A41): every open request this prompt satisfies (approval phrase and
  // kind word, single-use) becomes an approval. The lead never runs `agent.sh approve`; a prompt that approves nothing changes nothing.
  // Fast path: agent.sh starts only when an approval request is open; a marker left behind means a timeout.
  let msgs = '';
  const budgetMs = ctx.approveBudget * 1000;
  let used = 0; // milliseconds of the approval budget spent so far
  const requestOpen = [`${ctx.sroot}/.agents/runs/${ctx.act}/approvals`, `${ctx.sharedLocal}/approvals`].some((d) => names(d).some((n) => REQUEST.test(n) && isFile(`${d}/${n}`)));
  /** @param {string} run @param {string} tree */
  const timeoutMsg = (run, tree) => (anyFileHolds([`${tree}/.agents/runs/${run}/approvals`, `${ctx.sharedLocal}/approvals`], `capture_id: "${sess}:${capS}:${h}"`)
    ? "proofline: your approval was recorded (the approval step ran past the hook's time budget but finished writing it)."
    : "proofline: your approval could not be recorded, send it again (the approval step ran out of time).");
  if (ctx.act !== 'INVALID' && requestOpen) {
    ctx.tick(); const a0 = ctx.v;
    try { put(marker, `${h}\n`); } catch { /* ignore */ }
    const r = await ctx.agent(['approve-pending', ctx.act], { budgetMs });
    used += Date.now() - a0;
    if (r.timedOut) {
      ctx.tick(); ctx.line(`${ctx.ev}.approve`, ctx.v - a0, 'timeout', 'stopped-by-hook-budget');
      try { append(`${ctx.localDir}/approve.log`, `${utcStamp()} approval step stopped after ${ctx.approveBudget}s (prompt hook budget)\n`); } catch { /* ignore */ }
      msgs = timeoutMsg(ctx.act, ctx.sroot);
    } else {
      ctx.step('approve', a0);
      msgs = approvalMessages(r.stdout + r.stderr, msgs);
    }
  }
  // A185 (round 2): a prompt has no path and the session's working directory is usually the main tree, so the run of a worktree (night mode,
  // worktree-add) is not `act` here. Its pending request is found in the main tree's worktree folder and approved by THAT worktree's agent.sh,
  // which agent.sh worktree-root must confirm as a registered worktree of this project (never the path string alone); the same budget.
  /** @type {Array<[string, string]>} */ let wl = [];
  const wtRoot = `${ctx.sharedLocal}/worktrees`;
  for (const d of names(wtRoot)) {
    const wlD = `${wtRoot}/${d}`;
    for (const run of names(`${wlD}/.agents/runs`)) {
      if (!names(`${wlD}/.agents/runs/${run}/approvals`).some((n) => REQUEST.test(n) && isFile(`${wlD}/.agents/runs/${run}/approvals/${n}`))) continue;
      if (wlD === ctx.sroot || run === '' || /[^A-Za-z0-9_-]/.test(run)) continue;
      if (wl.some(([a, b]) => a === wlD && b === run)) continue;
      wl.push([wlD, run]);
    }
  }
  // round 6: one reply must not approve the unrelated requests of several runs. With more than one run waiting (the main tree's counts) only a run
  // whose id the reply names is approved; one waiting run alone needs no name
  if (wl.length) {
    const n = wl.length + (requestOpen ? 1 : 0);
    if (n > 1) {
      const all = wl;
      wl = all.filter(([, run]) => pt.includes(run));
      if (!wl.length) msgs = `${msgs !== '' ? `${msgs} ` : ''}proofline: several runs wait for an approval (${all.map(([, run]) => `${run} `).join('')}); an approval records for the run named in your reply: say which run you approve (for example "approve scope <ID>").`;
    }
  }
  if (wl.length && ctx.act !== 'INVALID') {
    if (!isFile(marker)) { try { put(marker, `${h}\n`); } catch { /* ignore */ } }
    ctx.tick(); const a2 = ctx.v;
    let all = '';
    for (const [wlD, run] of wl) {
      const w = await ctx.agent(['worktree-root', wlD], { keepRole: true });
      if (w.status !== 0 || w.stdout.replace(/\n+$/, '') !== wlD) continue;
      // the worktree's agent.sh is a tracked file a task could have rewritten: it runs only when it is byte-identical to the main tree's own
      const wa = `${wlD}/.agents/scripts/agent.sh`;
      if (!isFile(wa) || !sameBytes(wa, ctx.agentPath)) continue;
      const t1 = Date.now();
      const r = await ctx.agent(['approve-pending', run], { agentPath: wa, budgetMs: Math.max(budgetMs - used, 50) });
      used += Date.now() - t1;
      if (r.timedOut) {
        ctx.tick(); ctx.line(`${ctx.ev}.approve`, ctx.v - a2, 'timeout', 'stopped-by-hook-budget');
        try { append(`${ctx.sharedLocal}/approve.log`, `${utcStamp()} approval step of worktree run ${run} stopped after ${ctx.approveBudget}s (prompt hook budget)\n`); } catch { /* ignore */ }
        msgs = `${msgs !== '' ? `${msgs} ` : ''}${timeoutMsg(run, wlD)}`;
        break;
      }
      all += r.stdout + r.stderr;
    }
    ctx.step('approve', a2);
    msgs = approvalMessages(all, msgs);
  }
  rmf(marker);
  await ctx.flush();
  if (warn !== '') msgs = `${warn}${msgs !== '' ? ` ${msgs}` : ''}`;
  if (msgs === '') return undefined;
  return `{"systemMessage":"${jesc(msgs)}","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"${jesc(msgs)}"}}\n`;
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` */
function utcStamp() { return `${new Date().toISOString().slice(0, 19)}Z`; }

/** @param {string} a @param {string} b `cmp -s` */
function sameBytes(a, b) { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } }

/** The spool is kept short: past 5000 lines only the last 2000 stay. @param {string} file */
function trimSpool(file) {
  try {
    const t = readFileSync(file, 'utf8');
    const lines = t.split('\n');
    if (lines.length - 1 <= 5000) return;
    const keep = `${lines.slice(-2001, -1).join('\n')}\n`;
    putAtomic(file, `${file}.t`, keep);
  } catch { /* none */ }
}
