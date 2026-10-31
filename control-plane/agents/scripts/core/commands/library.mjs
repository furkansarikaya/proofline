// @ts-check
// Stage 2, shared-library package: status, open-runs, effective, fingerprint, patch-fingerprint, verify-seal, verify-gates, pipeline,
// entry-tier. Each keeps its arguments, stdout, stderr, exit code and files exactly as in agent.sh 0.0.41. An argument shape whose shell
// error text the core does not copy (`${2:?usage}`) throws BridgeToShell before any output; the entry then runs the shell code.
import { readdirSync, statSync } from 'node:fs';
import { bytes } from '../config.mjs';
import { BridgeToShell, fail } from '../errors.mjs';
import { contentFingerprint, gateFingerprint } from '../fingerprint.mjs';
import { fixRoundsUsed, gateDeps, gateStatus, gateUnsupportedFocuses, gateFocusStatus, maxFixRounds, requiredGates, riskNotRerun, riskUnsupported, taskPatchFingerprint, verifyLifecycleGates } from '../gates.mjs';
import { verifySeal } from '../ledger.mjs';
import { isFile } from '../paths.mjs';
import { fileText, textLines } from '../records.mjs';
import { activeRun, effective, openRuns, requireRun, runDir } from '../runs.mjs';
import {
  ECO_WARNING, ecosystemSets, entryTier, pipelineClass, pipelineClassValid, pipelineDeclared, pipelineNeeds, pipelineReview, pipelineValue, planFlag,
  riskFocusOnGate, riskGateFocuses, riskMissingFlags, riskSignals, riskUiExempt, runAutonomy, tierEffective, validationShow,
} from '../signals.mjs';
import { tmDispatchSeconds } from '../timeouts.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** The id argument of a command that needs one (`${2:?usage}`): a missing or empty one is the shell's error text. @param {string[]} args */
function needId(args) {
  const id = args[0];
  if (id === undefined || id === '') throw new BridgeToShell('usage');
  return bytes(id);
}

/** @param {Context} ctx */
function status(ctx) {
  ctx.fpMode = 'yes';
  const id = activeRun(ctx);
  ctx.out(`active_task=${id === '' ? 'none' : id}\n`);
  ctx.out(effective(ctx, id));
  return 0;
}

/** @param {Context} ctx */
function openRunsCommand(ctx) {
  ctx.fpMode = 'refresh';
  const rows = openRuns(ctx);
  if (rows.length) ctx.out(`${rows.join('\n')}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function effectiveCommand(ctx, args) {
  ctx.fpMode = 'refresh';
  ctx.out(effective(ctx, bytes(args[0] ?? '')));
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function fingerprintCommand(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = bytes(args[0] ?? '');
  if (id !== '') requireRun(ctx, id);
  ctx.out(`${args[1] === 'full' ? contentFingerprint(ctx) : gateFingerprint(ctx)}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function patchFingerprint(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = needId(args);
  requireRun(ctx, id);
  ctx.out(`${taskPatchFingerprint(ctx, runDir(ctx, id))}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function verifySealCommand(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = needId(args);
  verifySeal(ctx, id, runDir(ctx, id));
  ctx.out(`lifecycle seal verified: ${id}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function verifyGates(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = needId(args);
  verifyLifecycleGates(ctx, id);
  ctx.out(`lifecycle gates verified: ${id}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function entryTierCommand(ctx, args) {
  ctx.fpMode = 'refresh';
  if (args[0] === undefined || args[0] === '') throw new BridgeToShell('usage');
  ctx.out(`${entryTier(ctx, bytes(args[0])) || 'none'}\n`);
  return 0;
}

/** `inflight_pid_alive PID MARKER` @param {Context} ctx @param {string} pid @param {string} marker @param {string[]} lines */
function inflightAlive(ctx, pid, marker, lines) {
  if (!/^[0-9]+$/.test(pid) || pid === '0') return false;
  try { process.kill(Number(pid), 0); } catch { return false; }
  let t = tmDispatchSeconds(ctx.config(), '');
  const m = (lines.find((l) => l.startsWith('timeout=')) ?? '').slice('timeout='.length);
  if (/^[0-9]+$/.test(m) && Number(m) <= t) t = Number(m);
  try { return Date.now() - statSync(marker).mtimeMs <= Math.floor((t + 119) / 60) * 60000; } catch { return false; }
}

/** `inflight_dispatch ID`: the role and pid of the first dispatch marker whose pid is alive, or null. @param {Context} ctx @param {string} dir */
function inflightDispatch(ctx, dir) {
  let names = [];
  try { names = readdirSync(`${dir}/dispatch`).filter((n) => n.endsWith('.running')).sort(); } catch { return null; }
  for (const n of names) {
    const f = `${dir}/dispatch/${n}`;
    if (!isFile(f)) continue;
    const lines = textLines(fileText(ctx, f) ?? '');
    const pid = (lines.find((l) => l.startsWith('pid=')) ?? '').slice(4);
    const role = (lines.find((l) => l.startsWith('role=')) ?? '').slice(5);
    if (inflightAlive(ctx, pid, f, lines)) return { role: role === '' ? 'specialist' : role, pid };
  }
  return null;
}

/** @param {string} v */
function unsupportedLabel(v) { return v === 'info' ? 'UNSUPPORTED (unproven, reported)' : 'UNSUPPORTED (blocking: a waiver or a measurement is needed)'; }

/** `risk_show ID`: the signal lines of `pipeline` (A78). @param {Context} ctx @param {string} dir @param {string[]} req */
function riskShow(ctx, dir, req) {
  const cfg = ctx.config();
  const sig = riskSignals(ctx, dir);
  const names = [...new Set(sig.map((s) => s.name))].sort();
  let out = `signals=${names.join(' ')}\n`;
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  for (const n of names) {
    const src = sig.filter((s) => s.name === n).map((s) => `${s.source}:${s.path}(${s.why})`).join(',');
    const f = cfg.get(`risk.${n}.check`, '');
    let g = '';
    for (const x of req) if (riskFocusOnGate(f, x)) g = x;
    let fl = cfg.get(`risk.${n}.flag`, '');
    if (fl !== '') fl = `${fl}:${planFlag(plan, fl)}`;
    if (riskUiExempt(ctx, dir, n)) {
      out += `signal.${n}=source=${src} check=- (class TRIVIAL: no design phase / no QA gate) flag=${fl || '-'} design_role=-\n`;
      continue;
    }
    out += `signal.${n}=source=${src} check=${g || '-'}:${f}${g !== '' ? '' : ' (no required gate carries it for this class and tier)'} flag=${fl || '-'} design_role=${cfg.get(`risk.${n}.design_role`, '-')}\n`;
  }
  for (const [n, src, p, fl] of riskMissingFlags(ctx, dir)) {
    out += `missing_flag.${n}=${src}:${p} needs PLAN.md ${fl}: yes (${src === 'diff' ? `a blocking finding of focus ${cfg.get(`risk.${n}.check`, '')}; the check still runs` : 'declare it before FREEZE'})\n`;
  }
  for (const r of ['architect', 'data_architect', 'designer']) {
    const by = names.filter((n) => cfg.get(`risk.${n}.design_role`, '') === r && !riskUiExempt(ctx, dir, n));
    if (by.length) out += `design_role.${r}=${by.join(' ')}\n`;
  }
  return out;
}

/** `pipeline_show ID` @param {Context} ctx @param {string[]} args */
function pipelineShow(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = needId(args);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!pipelineDeclared(ctx, dir)) fail(`run ${id} has no pipeline block`);
  const cls = pipelineClass(ctx, dir);
  if (!pipelineClassValid(cls)) fail(`run ${id} is not classified yet`);
  if (!ecosystemSets(ctx).loaded) ctx.out(`warning=${ECO_WARNING}\n`);
  const fly = inflightDispatch(ctx, dir);
  if (fly) ctx.out(`in_flight=dispatch.sh ${id} ${fly.role} (pid ${fly.pid}): wait for the command to return\n`);
  const tier = tierEffective(ctx, dir);
  const gates = requiredGates(ctx, dir, tier);
  let art = 'TASK.md PLAN.md';
  if (pipelineNeeds(ctx, dir, 'evidence') === 'yes') art += ' EVIDENCE.md';
  if (pipelineNeeds(ctx, dir, 'qa') === 'yes') art += ' QA_PLAN.md QA_REPORT.md';
  art += ' VERIFY.md COMPLETION_REPORT.md';
  const round = fixRoundsUsed(ctx, dir);
  ctx.out(`classification=${cls}\nreview=${pipelineReview(ctx, dir)}\nevidence=${pipelineNeeds(ctx, dir, 'evidence')}\nqa_plan=${pipelineNeeds(ctx, dir, 'qa')}\narchitect=${pipelineNeeds(ctx, dir, 'architect')}\nmax_explorers=${pipelineValue(ctx, cls, 'max_explorers')}\nautonomy=${runAutonomy(ctx, dir)}\ntier=${tier}\nartifacts=${art}\nfix_round=${round}\nmax_fix_rounds=${maxFixRounds(ctx)}\nescalation=${round >= 2 ? 'yes' : 'no'}\ngates=${gates.join(' ')}\n`);
  const fp = gateFingerprint(ctx);
  for (const g of gates) {
    ctx.out(`gate.${g}=${gateStatus(ctx, dir, id, g, 'reuse', fp)}\n`);
    const dn = gateDeps(ctx, dir, g).join(',');
    if (dn !== '') ctx.out(`gate.${g}.needs=${dn}\n`);
    const u = gateUnsupportedFocuses(ctx, dir, id, g, 'reuse', fp);
    if (u !== '') ctx.out(`gate.${g}.unsupported=${u} (unproven, reported; the gate is not a full pass)\n`);
  }
  for (const g of gates) for (const f of riskGateFocuses(ctx, dir, g)) ctx.out(`focus.${g}.${f}=${gateFocusStatus(ctx, dir, id, g, f, 'reuse', fp)}\n`);
  ctx.out(riskShow(ctx, dir, requiredGates(ctx, dir)));
  ctx.out(validationShow(ctx, dir));
  for (const n of riskNotRerun(ctx, dir)) {
    const sp = n.indexOf(' ');
    ctx.out(`not_rerun.${sp < 0 ? n : n.slice(0, sp)}=NOT_RERUN (not reproduced proof): ${sp < 0 ? n : n.slice(sp + 1)}\n`);
  }
  for (const [k, v, t, e] of riskUnsupported(ctx, dir)) ctx.out(`unsupported.${k}=${unsupportedLabel(v)}: ${t.replace(/^UNSUPPORTED /, '')}${e !== '' ? ` (evidence: ${e})` : ''}\n`);
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const LIBRARY_HANDLERS = {
  status,
  'open-runs': openRunsCommand,
  effective: effectiveCommand,
  fingerprint: fingerprintCommand,
  'patch-fingerprint': patchFingerprint,
  'verify-seal': verifySealCommand,
  'verify-gates': verifyGates,
  pipeline: pipelineShow,
  'entry-tier': entryTierCommand,
};
