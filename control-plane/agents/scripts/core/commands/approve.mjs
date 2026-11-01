// @ts-check
// Stage 3: request-approval, approve, approve-pending, approval-consume (agent.sh 0.0.42). `approve-pending` is what the prompt hook runs
// right after it stored the user's capture: every open request this prompt satisfies becomes an approval, one `approve` per target in the
// order of the delivery steps, each with its own locks and its own context (nothing is shared between the targets, as when each was a process).
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { now } from '../clock.mjs';
import { approvalConsume, approvalScanLatest, approvalScanReport, approveInChild, approveKinds, forgetFiles, requestApproval, requireLead } from '../approve.mjs';
import { approvalPendingPairs } from '../approvals.mjs';
import { fail } from '../errors.mjs';

/** @typedef {import('../context.mjs').Context} Ctx */

/** @param {Ctx} ctx @param {string[]} args */
function requestApprovalCommand(ctx, args) { ctx.fpMode = 'refresh'; return requestApproval(ctx, args[0] ?? '', args[1] ?? ''); }

/** @param {Ctx} ctx @param {string[]} args */
function approveCommand(ctx, args) {
  if (args.length < 2) fail('usage: agent.sh approve <ID> <KIND>...');
  ctx.fpMode = 'refresh';
  return approveKinds(ctx, args[0], args.slice(1));
}

/** @param {Ctx} ctx @param {string[]} args */
function approvalConsumeCommand(ctx, args) {
  if (args.length < 2) fail('usage: agent.sh approval-consume <ID> <KIND> [FINGERPRINT [REF...]]');
  ctx.fpMode = 'refresh';
  return approvalConsume(ctx, args);
}

const RANK = /** @type {Record<string, number>} */ ({ commit: 1, push: 2, pr: 3, merge: 4, cleanup: 5 });

/** `now_iso` @param {string} text */
const tail = (text) => text.replace(/\n+$/, '').replace(/\n/g, ' ').replace(/ +/g, ' ').slice(0, 300);

/** `approve_pending [ID]` @param {Ctx} ctx @param {string[]} args */
function approvePendingCommand(ctx, args) {
  requireLead(ctx);
  const run = args[0] ?? '';
  const main = ctx.sharedMain();
  const log = `${main}/.agents/local/approve.log`;
  try { mkdirSync(`${main}/.agents/local`, { recursive: true }); } catch { /* the log is best effort */ }
  const scan = approvalScanLatest(ctx, run);
  const pairs = [...new Set(approvalPendingPairs(ctx, run).map(([t, k]) => `${t} ${k}`))].sort().map((p) => /** @type {[string, string]} */ ([p.slice(0, p.indexOf(' ')), p.slice(p.indexOf(' ') + 1)]));
  /** @type {Array<[string, number, string]>} */ const ranked = pairs.map(([t, k]) => [t, RANK[k] ?? 0, k]);
  ranked.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)));
  /** @type {Map<string, string[]>} */ const groups = new Map();
  for (const [t, , k] of ranked) { const g = groups.get(t); if (g) g.push(k); else groups.set(t, [k]); }
  let lines = '';
  let nrec = 0;
  for (const [t, ks] of groups) {
    const { rc, output } = approveInChild(ctx, t, ks);
    const l = tail(output);
    try { appendFileSync(log, `${now().iso} target=${t} kinds=${ks.join(' ')} rc=${rc} output: ${l}\n`); } catch { /* best effort */ }
    nrec += output.split('\n').filter((x) => x.startsWith('approval recorded')).length;
    const shown = t === '-' ? '' : t;
    if (rc === 0) lines += `approved: ${shown} ${ks.join(' ')}: ${l}\n`;
    else if (!output.includes('contain no approval phrase') && !output.includes('none of the open requests')) lines += `not recorded: ${shown} ${ks.join(' ')}: ${l}\n`;
  }
  ctx.out(lines);
  const rep = approvalScanReport(scan, nrec);
  if (rep !== '') {
    ctx.out(rep);
    try { appendFileSync(log, rep.replace(/\n$/, '').split('\n').map((x) => `${now().iso} ${x}\n`).join('')); } catch { /* best effort */ }
  }
  // A202 item 28: the hook's raw copies of the user's prompts (prompts/intake) are a safety net; those older than two days go
  removeOld(`${main}/.agents/local/prompts/intake`);
  // the log is shared by every tree: rotate it under a lock (a rotation racing an append would lose lines); a busy lock just skips the rotation
  try {
    const text = readFileSync(log, 'latin1');
    if (text.split('\n').length - 1 > 400) {
      try {
        mkdirSync(`${log}.lock`);
        const keep = text.split('\n').slice(0, -1).slice(-200).map((x) => `${x}\n`).join('');
        writeFileSync(`${log}.tmp`, Buffer.from(keep, 'latin1'));
        renameSync(`${log}.tmp`, log);
        rmdirSync(`${log}.lock`);
      } catch { /* a busy lock skips the rotation */ }
    }
  } catch { /* no log */ }
  forgetFiles(ctx);
  return 0;
}

/** `find DIR -type f -mtime +2 -exec rm -f` @param {string} dir */
function removeOld(dir) {
  /** @param {string} d */
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const f = `${d}/${n}`;
      let st;
      try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else if (st.isFile() && Date.now() - st.mtimeMs >= 3 * 86400000) rmSync(f, { force: true });
    }
  };
  walk(dir);
}

export const APPROVE_HANDLERS = {
  'request-approval': requestApprovalCommand,
  approve: approveCommand,
  'approve-pending': approvePendingCommand,
  'approval-consume': approvalConsumeCommand,
};
