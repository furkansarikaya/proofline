// @ts-check
// The PreToolUse guard for a shell command (proofline-hook.sh, the `[ -n "$cmd" ]` branch of the pretool event). Every rule that inspects a Bash
// command text lives here or in the modules it calls, in the shell hook's order, with its texts and verdicts:
//   not installed        the merge guard and the kill guard only (A136, A156)
//   always               the dispatch marker (A171), probe switches (A102); in a run: the tripwires (ADR 0001 5.3 and 7)
//   specialists          git on the live tree, strays under /tmp, git stash (A111), the agent.sh forms per role, shell writes by role (A143)
//   everyone             sed -i backup suffix (S), git hook bypass (B), the report-turn marker (A169), merge (A136), kill (A156/A161), database (A50)
//   no run, the lead     nr_bash_guard (A169), scratch (D10), /tmp (A52)
// `bashGuard(input, ctx)` returns null (allow) or { decision: 'deny', reason }; the router renders it.
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { scanCommand } from '../command-scan.mjs';
import { canon, cmdSubst, safe } from '../lib/text.mjs';
import { isFile, mkdirp, put } from '../lib/fsx.mjs';
import { Deny, deny, grepq, SP } from './kit.mjs';
import { alwaysProtected, erasable, nrPathOk, relpath, roOperand, roTail, targetOk } from './paths.mjs';
import { dbGuardCmd } from './db.mjs';
import { killGuard } from './kill.mjs';
import { mergeGuard } from './merge.mjs';
import { stashGuard } from './stash.mjs';
import { leadTmpCheck, scratchGuard, strayTmpPath, tmpIsScratchRoot } from './scratch.mjs';
import { NODE_OPTIONS_PRELOAD, PROOFLINE_ASSIGN, twCoreNode, twNodeOperand } from './tripwires.mjs';

/** @param {unknown} input @param {import('../lib/context.mjs').HookContext} ctx @returns {Promise<{ decision: 'deny', reason: string } | null>} */
export async function bashGuard(input, ctx) {
  const cmd = ctx.get('tool_input.command', 'tool_input.cmd');
  try {
    await check(ctx, cmd);
    return null;
  } catch (e) {
    if (e instanceof Deny) return { decision: 'deny', reason: e.reason };
    throw e;
  }
}

/** The text with quotes, backslashes and variable references removed, line by line (the sed of the shell hook). @param {string} cmd */
function normalForm(cmd) {
  if (!/["'\\$]/.test(cmd)) return cmd;
  return cmd.split('\n').map((l) => l.replace(/["'\\]/g, '').replace(/\$\{[^}]*\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '')).join('\n');
}

/** `command -v rtk` @param {NodeJS.ProcessEnv} env */
function rtkOnPath(env) {
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (d === '' || !d.startsWith('/')) continue;
    try { accessSync(`${d}/rtk`, constants.X_OK); if (isFile(`${d}/rtk`)) return true; } catch { /* next */ }
  }
  return false;
}

/** `grep -qs WORD FILE` @param {string} file @param {string} word */
function grepFile(file, word) {
  try { return readFileSync(file).toString('latin1').includes(word); } catch { return false; }
}

const EV_RE = new RegExp(`agent[.]sh${SP}+(build-record|verify-[a-z-]+)|(^|[;&|(]|${SP})((npm|pnpm|yarn|bun)${SP}+(run${SP}+)?(test|build|lint)|pytest|go${SP}+(test|build|vet)|cargo${SP}+(test|build|clippy)|dotnet${SP}+(test|build)|mvn|gradle|jest|vitest|make${SP}+(test|build|check)|node${SP}+--test|sh${SP}+tests/)(${SP}|$)`);
const GIT_DIFF_RE = new RegExp(`(^|[;&|(]|${SP})git${SP}+(-C${SP}+[^ \\t\\n\\v\\f\\r]+${SP}+)?(diff|show)(${SP}|$)`);
const SPEC_GIT_RE = new RegExp(`(^|[;&|(]|${SP})git${SP}+(reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout${SP}+--)(${SP}|$)`);
const SPEC_GIT_EXEMPT = new RegExp(`git${SP}+-C${SP}+|git${SP}+worktree|--work-tree`);
const DISPATCH_GLOB = new RegExp(`\\.agents/[^/ \\t\\n\\v\\f\\r]*[*?[]|\\.agents/local/[^/ \\t\\n\\v\\f\\r]*[*?[]|find${SP}[^;&|]*\\.agents(/local)?/?(${SP}|$)`);

/** @param {import('../lib/context.mjs').HookContext} ctx @param {string} cmd */
async function check(ctx, cmd) {
  const scan = scanCommand(cmd);
  if (!ctx.installed) { await mergeGuard(ctx, cmd, scan); await killGuard(ctx, cmd, scan); return; }
  const act = ctx.act;
  const role = ctx.role;
  // A171: the dispatch marker is set by dispatch.sh alone; a model never sets it to record a decision ahead of a dispatch. Checked on the text as written
  // and with quotes, backslashes and variable references removed.
  const norm = normalForm(cmd);
  const both = cmd + norm;
  if (both.includes('PROOFLINE_DISPATCH') || both.includes('DISPATCH=') || both.includes('nonce-') || both.includes('.agents/local/dispatch')) {
    deny('PROOFLINE_DISPATCH is set by dispatch.sh alone (A171). To only read a decision run: sh .agents/scripts/agent.sh decide <ID> <role> --dry');
  }
  const dnHit = norm.includes('PROOFLINE') && norm.includes('DISPATCH');
  if (dnHit || (cmd.includes('.agents') && grepq(DISPATCH_GLOB, cmd))) {
    deny("PROOFLINE_DISPATCH and the dispatch nonce are dispatch.sh's alone (A171); list .agents/local by a literal path, no glob or find over .agents or .agents/local");
  }
  // A102: the capability probes' self-test switches are never set by a model
  if (cmd.includes('PROOFLINE_PROBE_ROOT') || cmd.includes('PROOFLINE_SELFTEST')) {
    deny('PROOFLINE_PROBE_ROOT and PROOFLINE_SELFTEST are self-test switches of the capability probes (A102); a model command never sets or names them');
  }
  // ADR 0001 sections 5.3 and 7 (tripwires, not the boundary): this model Bash command text in an installed project with an open run
  if (act !== '') {
    for (const t of [cmd, norm]) {
      if (grepq(PROOFLINE_ASSIGN, t)) deny('a model command never assigns PROOFLINE_ENGINE* or PROOFLINE_TEST*: they select the engine and the test seams, which only the user (.agents/local/engine) or a test harness sets');
      if (twCoreNode(t)) deny('a model command never starts Node on the control plane (the core under .agents/scripts, proofline-core.mjs): run it only through sh .agents/scripts/agent.sh <command>, which applies the role gate, the locks and the ledger');
      if (grepq(NODE_OPTIONS_PRELOAD, t)) deny('a model command never sets NODE_OPTIONS with --require, --import, -r or --loader: it would run a file before any node script, outside what the hook can read');
      if (twNodeOperand(t)) deny('a model command runs node only on a script path written out literally (no variable, substitution, glob, tilde, brace or quote splicing, and no script fed by xargs, find -exec or stdin): the hook cannot read the file such a command starts, and the control plane is reached only through sh .agents/scripts/agent.sh <command>');
    }
  }
  const specialist = ctx.sub || role !== 'lead';
  // A specialist never mutates the live tree with git: mutation evidence runs in a separate worktree
  if (act !== '' && !ctx.ro && specialist && grepq(SPEC_GIT_RE, cmd) && !grepq(SPEC_GIT_EXEMPT, cmd)) {
    deny(`git must not change the live working tree from a specialist (stash, reset, clean, restore, checkout --, switch, ...); run mutation evidence in a separate worktree (git worktree add, then git -C <worktree> ...) and leave the tree as you found it${roTail(ctx)}`);
  }
  // A194: a command that produces evidence never runs through the user's rtk hook, which compresses output
  let rtkNeed = grepq(EV_RE, cmd);
  if (!rtkNeed && ['reviewer', 'security_reviewer', 'verifier'].includes(role) && grepq(GIT_DIFF_RE, cmd)) rtkNeed = true;
  if (rtkNeed && !(cmd.includes('RTK_DISABLED=1') || cmd.includes('rtk bypass'))) {
    const home = ctx.env.HOME || '/nonexistent';
    if (ctx.env.PROOFLINE_RTK !== 'no' && rtkOnPath(ctx.env) && [`${home}/.claude/settings.json`, `${ctx.root}/.claude/settings.json`, `${ctx.root}/.claude/settings.local.json`].some((f) => grepFile(f, 'rtk'))) {
      deny('rtk is installed and its hook compresses command output, but this command produces evidence (agent.sh, build record, verification, tests, review diff) and must run uncompressed: prefix it with RTK_DISABLED=1, for example RTK_DISABLED=1 <command> (rtk configuration docs)');
    }
  }
  if (act !== '' && specialist && !tmpIsScratchRoot(ctx)) {
    const stray = strayTmpPath(ctx, cmd, scan);
    if (stray !== '') deny(`${stray} is outside the project. Allowed: reading the runtime's own background task output (/tmp/claude-*/**/tasks/<id>.output). Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); only git worktrees go under $TMPDIR (${ctx.env.TMPDIR || 'unset'})`);
  }
  // A111: every `git stash` subcommand is refused in the project tree for a specialist (evidence worktrees are free).
  if (act !== '' && specialist) await stashGuard(ctx, cmd, scan);
  // Hook and gate bypasses: never, for anyone, while proofline is installed.
  for (const rec of scan.records) {
    const v = cmdSubst(rec.value);
    switch (rec.kind) {
      case 'S': deny(`${v}: on BSD/macOS sed the text glued to -i or the word after it is the backup suffix, so it leaves a stray file named like the target plus that token (QA_PLAN.md-E) that blocks handoff. Write the file with the Write/Edit tool, or sed -E ... file > scratch && mv scratch file, or perl -pi -e ... (sed -i '' is BSD-only, bare sed -i GNU-only)`); break;
      case 'B': deny(`git hook bypass is never allowed (${v}); the git hooks enforce identity, gates and approvals`); break;
      case 'A': {
        const sc = v.slice(v.indexOf('\t') + 1);
        if (sc === 'approve' || sc === 'approve-pending') deny(`no model runs agent.sh ${sc}: an approval is the user's. The runtime records it from the user's reply (the prompt hook) and agent.sh refuses it without that reply; wait for the user's answer, then run agent.sh next`);
        // A169: the turn runs a command that ends in a final report: the Stop hook checks the identifiers of this turn's last message
        if (['publish-completion-report', 'cleanup', 'terminate', 'deliver-plan', 'deliver-step', 'delivery-check', 'batch-status', 'batch-check'].includes(sc) && role === 'lead' && !ctx.sub) {
          let rt = safe(ctx.get('session_id'));
          if (rt === '') rt = 'unknown';
          const dir = `${ctx.localDir}/report-turn`;
          if (mkdirp(dir)) { try { put(`${dir}/${rt}`, ''); } catch { /* the marker is a convenience */ } }
        }
        break;
      }
      case 'W': if (alwaysProtected(await relpath(ctx, v))) deny(`the command writes '${v}', which wires the git hooks; it is never changed by an agent (git hook bypass)`); break;
      default: break;
    }
  }
  // The merge guard is not run-scoped either (A136).
  await mergeGuard(ctx, cmd, scan);
  await killGuard(ctx, cmd, scan);
  // The database guard is not run-scoped: a task author or an explorer runs before any run exists (A50).
  await dbGuardCmd(ctx, scan);
  if (act === '') {
    if (role === 'lead' && !ctx.sub) await nrBashGuard(ctx, scan);
    await scratchGuard(ctx, scan);
    leadTmpCheck(ctx, cmd, scan);
    return;
  }
  const hasRole = scan.records.some((r) => r.kind === 'R');
  const lineOf = scan.records.map((r) => `${r.kind}\t${Buffer.from(r.raw, 'latin1').toString('utf8')}`);
  for (const rec of scan.records) {
    const k = rec.kind;
    const v = cmdSubst(rec.value);
    switch (k) {
      case 'X': deny(`${v} is not allowed while run ${act} is active; write agent.sh, AGENT_ROLE and shell commands literally (only an argument may be a variable the same command assigns a plain literal: ID=T-1; sh .agents/scripts/agent.sh next $ID)`); break;
      case 'R': if (canon(v) !== role) deny(`AGENT_ROLE=${v} does not match the caller's role (${role}); a role never acts as another`); break;
      case 'N': deny(`specialists run through dispatch.sh (window, decision and recording), never as a nested runtime started by hand (${v})`); break;
      case 'L': {
        if (v.includes('.agents')) deny(`ln '${v}': links into or out of .agents/ are never made during a run`);
        const r = await relpath(ctx, v);
        if (r === '.agents' || r.startsWith('.agents/')) deny(`ln '${v}': links into or out of .agents/ are never made during a run`);
        break;
      }
      case 'A': agentRule(ctx, cmd, v, hasRole); break;
      case 'W': await writeRule(ctx, v, lineOf); break;
      case 'P': case 'Q': {
        if (!ctx.ro) break;
        const why = await roOperand(ctx, k, v);
        if (why !== null) deny(`the command edits '${v}' in place: ${why}${roTail(ctx)}`);
        break;
      }
      default: break;
    }
  }
  await scratchGuard(ctx, scan);
  leadTmpCheck(ctx, cmd, scan);
}

/** The agent.sh forms per role (D12, D13, D16). @param {import('../lib/context.mjs').HookContext} ctx @param {string} cmd @param {string} v the A record value @param {boolean} hasRole */
function agentRule(ctx, cmd, v, hasRole) {
  const t = v.indexOf('\t');
  const lit = v.slice(0, t < 0 ? v.length : t);
  const sc = t < 0 ? v : v.slice(t + 1);
  const role = ctx.role;
  if (lit !== '1') deny(`agent.sh subcommand '${sc}' is not literal. Allowed form: ID=T-1; sh .agents/scripts/agent.sh next $ID (a variable the same command assigns a plain literal) or write the subcommand out`);
  if (sc === 'record' || sc === 'gate') deny(`verdicts enter a run only through agent.sh submit, recorded for the SubagentStop hook or dispatch.sh (agent.sh ${sc} is never run by the lead or a subagent, D12)`);
  if (sc === 'window-open' || sc === 'window-close') deny('implementer and designer windows are opened and closed only by the runtime hooks and dispatch.sh');
  if (!(ctx.sub || role !== 'lead')) return;
  if (sc === 'approve' || sc === 'waive' || sc === 'answer') deny('a subagent never approves, waives or answers; only the user does, through the lead (D13, D16)');
  if (['status', 'pipeline', 'fingerprint', 'build-record'].includes(sc) || sc.startsWith('verify-')) return; // build-record: `run` is refused for a non-lead role by the script itself
  if (sc === 'submit') {
    if (role === 'lead') deny('the lead never submits a specialist result (D12)');
    if (!hasRole) deny(`agent.sh submit runs as your role: prefix AGENT_ROLE=${role}`);
    if (ctx.aid !== '') {
      let stok = '';
      for (const l of cmd.split('\n')) { const m = /^.*--agent[ =]+([A-Za-z0-9_.-]*).*$/.exec(l); if (m) { stok = m[1] ?? ''; break; } }
      if (stok !== ctx.aidf) deny(`agent.sh submit needs your agent token: add --agent ${ctx.aidf}`);
    }
    return;
  }
  if (role === 'implementer' && sc === 'worker-evidence') { if (!hasRole) deny('agent.sh worker-evidence runs only as the implementer: prefix AGENT_ROLE=implementer'); return; }
  if (role === 'implementer') deny(`the implementer runs only agent.sh worker-evidence status pipeline fingerprint verify-* (not ${sc})`);
  if (sc === 'next') return;
  deny(`role ${role} runs only the read-only agent.sh status pipeline fingerprint next verify-* (not ${sc}); state changes belong to the lead`);
}

/** A shell write (W record) while a run is open. @param {import('../lib/context.mjs').HookContext} ctx @param {string} v @param {string[]} lineOf */
async function writeRule(ctx, v, lineOf) {
  if (v === '' || v.startsWith('/dev/')) return;
  // A read role writes through no `..` component: $TMPDIR/<worktree>/../../<project path> would pass the worktree check
  if (ctx.ro && `/${v}/`.includes('/../')) deny(`the command writes '${v}', which goes through a .. component and cannot be placed inside an evidence worktree${roTail(ctx)}`);
  if (/[$*?[]/.test(v)) {
    if (v.startsWith('/tmp/') || v.startsWith('/private/tmp/') || v.startsWith('$TMPDIR/') || v.startsWith('${TMPDIR')) return;
    if (ctx.role === 'implementer' || ctx.role === 'designer') {
      if (v.includes('.agents') || v.includes('.claude/settings') || v.includes('.codex/') || v.includes('.git/')) deny(`the command writes '${v}', which may be protected run state`);
      return;
    }
    deny(`the command writes '${v}', which cannot be resolved; while run ${ctx.act} is active the lead and read-only roles write only their run artifacts (shell write detection is a heuristic; use the Write tool on an allowed path)${roTail(ctx)}`);
  }
  // A file the run created (untracked, or a link in scratch/) may be deleted by `rm`/`unlink` when that is the only write to it.
  const why = await targetOk(ctx, v);
  if (why === null) return;
  const w = lineOf.filter((x) => x === `W\t${v}`).length;
  const e = lineOf.filter((x) => x === `E\t${v}`).length;
  if (w === e && (await erasable(ctx, v))) return;
  deny(`the command writes '${v}': ${why}${roTail(ctx)}`);
}

/** `nr_bash_guard` (A169): the shell writes the scanner found, judged by nr_path_ok; the lead's main session while no run is active. @param {import('../lib/context.mjs').HookContext} ctx @param {import('../command-scan.mjs').ScanResult} scan */
async function nrBashGuard(ctx, scan) {
  for (const rec of scan.records) {
    if (rec.kind !== 'W') continue;
    const v = cmdSubst(rec.value);
    if (v === '' || v.startsWith('/dev/')) continue;
    if (/[$*?[]/.test(v)) {
      if (v.startsWith('/tmp/') || v.startsWith('/private/tmp/') || v.startsWith('$TMPDIR/') || v.startsWith('${TMPDIR')) continue;
      deny(`the command writes '${v}', which cannot be resolved, and no run is active (A169): the lead edits no product file itself. Propose a light run with '/proofline run <text>', or write an allowed path literally`);
    }
    const why = await nrPathOk(ctx, await relpath(ctx, v));
    if (why !== null) deny(`the command writes '${v}': ${why}`);
  }
}
