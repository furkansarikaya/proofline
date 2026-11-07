// @ts-check
// `decide`, `ledger-note` and `metrics-dispatch` (A226; the shell functions of agent.sh 0.0.57 are gone). The dispatcher calls them in process.
//
// decide <ID> <ROLE> [--dry|--agent-path|--redecide] [--focus F] [--ui-mode M] [--model M] [--effort E] [--context-bytes N] [--runtime RT] [--runtime-reason R]
//   records the execution decision of ONE dispatch (a decisions/ file, a ledger event, the escalation count); --dry only reads it. The resolver is the
//   execution policy of core/execpolicy.mjs (or the project's fixture stub, see policyCommand). A decision that is not --dry and not --agent-path is accepted
//   only for the dispatcher (A171):
//     - in process: the dispatcher builds its io with dispatcherIo(); that object lives in a module-private WeakSet, so nothing a command line, a file or
//       an environment value says can make a call a dispatcher call;
//     - from another process: the one-use nonce file .agents/local/dispatch/nonce-<hex> (PROOFLINE_DISPATCH names it) holds the pid of a LIVE ancestor of
//       this process (Linux /proc, macOS ps); removed on acceptance. On Windows no ancestor can be proven, so it is refused (fail closed).
import { readdirSync, readFileSync, renameSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { bytes } from './config.mjs';
import { now } from './clock.mjs';
import { canonRole, validRole } from './context.mjs';
import { fail, ProoflineError, unsupported } from './errors.mjs';
import { policyCommand } from './execpolicy.mjs';
import { gateFingerprint } from './fingerprint.mjs';
import { fixRoundsUsed, gateDeps, gateFocusStatus, gateLatestFile, gateSatisfied } from './gates.mjs';
import { inflightAlive } from './dispatch.mjs';
import { ledgerAppend } from './lock.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { fileText, gateField, gatesEnforced, sectionValue, textLines } from './records.mjs';
import { requireOpenRun, requireLead, nextNum } from './approve.mjs';
import { metricsJson } from './runend.mjs';
import { gateOf } from './resultutil.mjs';
import { requireRun, runProfile } from './runs.mjs';
import { pathChangedLines, pipelineClass, pipelineClassValid, pipelineValue, taskChangedPaths, tierEffective } from './signals.mjs';
import { verifySeal } from './ledger.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {import('./context.mjs').Io} Io */

const DISPATCHER_IOS = new WeakSet();

/**
 * An io that makes a `decide` call a dispatcher call. Only code that runs inside this process can hold such an object.
 * @param {Io} io @returns {Io}
 */
export function dispatcherIo(io) {
  const mine = { ...io };
  DISPATCHER_IOS.add(mine);
  return mine;
}

/** The parent of a process: Linux /proc, else `ps` (macOS and the BSDs); null when it cannot be told (Windows: never asked). @param {number} pid @param {string} [platform] @returns {number | null} */
export function parentPid(pid, platform = process.platform) {
  if (platform === 'win32') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const p = Number(after[1]);
    return Number.isInteger(p) ? p : null;
  } catch { /* no /proc: ask ps */ }
  const r = proc.run('ps', ['-o', 'ppid=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  const t = r.stdout.toString('latin1').replace(/ /g, '').trim();
  return r.status === 0 && /^[0-9]+$/.test(t) ? Number(t) : null;
}

/**
 * Is the live process NPID an ancestor of this process (at most 12 hops, never pid 1 or below)? Windows: false (an ancestor cannot be proven there).
 * @param {number} npid @param {string} [platform] @param {number} [start] @param {(pid: number) => number | null} [parentOf]
 */
export function isLiveAncestor(npid, platform = process.platform, start = process.pid, parentOf = (p) => parentPid(p, platform)) {
  if (platform === 'win32') return false;
  try { process.kill(npid, 0); } catch { return false; }
  let anc = /** @type {number | null} */ (start);
  for (let hops = 0; hops < 12 && anc !== null && anc > 1; hops++) {
    if (anc === npid) return true;
    anc = parentOf(anc);
  }
  return false;
}

/**
 * The nonce exemption of a call from another process (A171). `consume`: the file is removed on acceptance (a decision that records).
 * @param {Context} ctx @param {boolean} consume @param {string} [platform]
 */
export function nonceAccepted(ctx, consume, platform = process.platform) {
  const nonce = ctx.env.PROOFLINE_DISPATCH ?? '';
  if (nonce === '' || /[^0-9a-f]/.test(nonce) || nonce.length < 16) return false;
  const file = `${ctx.root}/.agents/local/dispatch/nonce-${nonce}`;
  if (!isFile(file)) return false;
  let pid = '';
  try { pid = readFileSync(file, 'latin1').split('\n')[0]; } catch { return false; }
  if (!/^[0-9]+$/.test(pid)) return false;
  if (!isLiveAncestor(Number(pid), platform)) return false;
  if (consume) rmSync(file, { force: true });
  return true;
}

/** `decision_files ID`: the decision files of a run in order. @param {string} dir @returns {string[]} */
function decisionFiles(dir) {
  try { return readdirSync(`${dir}/decisions`).filter((n) => /^[0-9]{3}-.*\.decision$/.test(n)).sort(); } catch { return []; }
}

/** `latest_decision ID ROLE [FOCUS]` @param {string} dir @param {string} role @param {string} focus */
function latestDecision(dir, role, focus) {
  const tag = focus === '' ? role : `${role}-${focus.replace(/\+/g, '-')}`;
  let hit = '';
  for (const f of decisionFiles(dir)) if (f.length === tag.length + 4 + 9 && f.slice(4, 4 + tag.length) === tag && /^[0-9]{3}-/.test(f) && f.endsWith('.decision')) hit = `${dir}/decisions/${f}`;
  return hit;
}

/** `role_results_count ID ROLE [FOCUS]` @param {Context} ctx @param {string} dir @param {string} role @param {string} focus */
function roleResultsCount(ctx, dir, role, focus) {
  let n = 0;
  let names = [];
  try { names = readdirSync(`${dir}/results`); } catch { return 0; }
  for (const f of names.sort()) {
    if (!new RegExp(`^[0-9]{3}-${role.replace(/[^A-Za-z0-9_]/g, '\\$&')}\\.result\\.md$`).test(f)) continue;
    if (focus !== '' && !textLines(fileText(ctx, `${dir}/results/${f}`) ?? '').includes(`FOCUS: ${focus}`)) continue;
    n++;
  }
  return n;
}

/**
 * `explorer_slot_check` (A132): the explorer slots of one planning phase are the delivered explorer reports recorded after the last freeze or refreeze plus the
 * explorer dispatches still running.
 * @param {Context} ctx @param {string} id @param {string} cls
 */
function explorerSlotCheck(ctx, id, cls) {
  const max = pipelineValue(ctx, cls, 'max_explorers');
  if (!/^[0-9]+$/.test(max) || Number(max) === 0) return;
  const dir = ctx.runDir(id);
  const ledger = fileText(ctx, `${dir}/LEDGER.log`);
  const ledgerRows = ledger === null ? [] : textLines(ledger);
  let floor = 0;
  for (const l of ledgerRows) if (/ event=(freeze|refreeze) /.test(l)) { const m = /^seq=([0-9]+)/.exec(l); floor = m ? Number(m[1]) : 0; }
  /** @type {string[]} */ const have = []; /** @type {string[]} */ const keys = [];
  let results = [];
  try { results = readdirSync(`${dir}/results`).filter((n) => /^[0-9]{3}-explorer\.result\.md$/.test(n)).sort(); } catch { results = []; }
  for (const f of results) {
    if (!textLines(fileText(ctx, `${dir}/results/${f}`) ?? '').includes('RESULT: DONE')) continue;
    let seq = '';
    for (const l of ledgerRows) if (l.includes(`detail=results/${f} `)) { const m = /^seq=([0-9]*) /.exec(l); if (m) seq = m[1]; }
    if (seq !== '' && !(Number(seq) > floor)) continue;
    const art = textLines(fileText(ctx, `${dir}/results/${f}`) ?? '').map((l) => /^ARTIFACT: [^ ]*\/[0-9a-f]{12}-([^ ]*) /.exec(l)).find((m) => m !== null);
    const key = art ? art[1] : '';
    if (key !== '' && keys.includes(key)) continue;
    keys.push(key);
    have.push(f);
  }
  let open = 0;
  let markers = [];
  try { markers = readdirSync(`${dir}/dispatch`).filter((n) => n.endsWith('.running') && /-explorer-/.test(n) && !n.startsWith('.')).sort(); } catch { markers = []; }
  for (const m of markers) {
    const mf = `${dir}/dispatch/${m}`;
    if (!isFile(mf)) continue;
    const status = fileText(ctx, `${ctx.agents}/local/submissions/d${m.slice(0, -'.running'.length)}.status`);
    if (status !== null && textLines(status).includes('status=ok')) continue;
    const lines = textLines(fileText(ctx, mf) ?? '');
    const pid = (lines.find((l) => l.startsWith('pid=')) ?? '').slice(4);
    if (inflightAlive(ctx, pid, mf, lines)) open++;
  }
  if (have.length + open < Number(max)) return;
  const names = have.map((h) => ` ${h}`).join('');
  fail(`decide refused (A132): class ${cls} allows ${max} explorer slot(s) (pipelines.${cls}.max_explorers) and run ${id} holds ${have.length} delivered result(s)${names === '' ? '' : ` (${names} )`}and ${open} running explorer dispatch(es). Consolidate EVIDENCE.md from the delivered reports; a BLOCKED or NEEDS_INPUT result or a dispatch that returned nothing holds no slot and is re-dispatched. The count restarts at each freeze/refreeze, so an extra explorer after a plan amendment is allowed once the plan is refrozen`);
}

/**
 * `ui_surface_signal ID [MODE]`: is the task's UI surface persuade or experience? The surface comes from the lead's --ui-mode or from the `visitor_mode:` line of
 * PLAN.md `## UI`. (The 0.0.57 shell also scanned design/ui.json, but its sed removed the whole match, so that branch never matched; the port does not read it.)
 * @param {Context} ctx @param {string} dir @param {string} mode
 */
function uiSurfaceSignal(ctx, dir, mode) {
  if (mode === 'persuade' || mode === 'experience') return true;
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (plan === null) return false;
  let ui = false;
  for (const l of plan.split('\n')) {
    if (l.startsWith('## ')) ui = l.startsWith('## UI');
    if (ui && /^[-* ]*`?visitor_mode`?:/.test(l)) {
      const v = l.replace(/^[^:]*:[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r][^]*$/, '');
      if (v === 'persuade' || v === 'experience') return true;
    }
  }
  return false;
}

/** The dependencies of the role's gate that are not satisfied for the current content. @param {Context} ctx @param {string} dir @param {string} id @param {string} gate */
function unmetDeps(ctx, dir, id, gate) {
  const deps = gateDeps(ctx, dir, gate);
  if (deps.length === 0) return [];
  const fp = gateFingerprint(ctx);
  return deps.filter((d) => !gateSatisfied(gateFocusStatus(ctx, dir, id, d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1), 'reuse', fp)));
}

/**
 * `decide ID ROLE [flags]`.
 * @param {Context} ctx @param {string[]} args
 */
export function decide(ctx, args) {
  ctx.fpMode = 'refresh';   // not a read-only command: big-file hashes are taken again and the cache refreshed (A202 item 28)
  requireLead(ctx);
  const id0 = args[0] ?? ''; const role0 = args[1] ?? '';
  if (id0 === '' || role0 === '') throw unsupported('usage');
  const id = id0;
  const role = canonRole(role0);
  requireRun(ctx, id);
  requireLead(ctx);
  requireOpenRun(ctx, id);
  if (!validRole(role)) fail(`invalid role: ${role}`);
  const dir = ctx.runDir(id);
  const cls = pipelineClass(ctx, dir);
  if (!pipelineClassValid(cls)) fail(`run ${id} is not classified: the execution policy is derived from its class`);
  let focus = ''; let uiMode = ''; let dry = false; let ap = false; let redo = false;
  let over = '';
  const rest = args.slice(2);
  for (let i = 0; i < rest.length;) {
    const a = rest[i];
    switch (a) {
      case '--dry': dry = true; i += 1; break;
      case '--agent-path': ap = true; i += 1; break;
      case '--redecide': redo = true; ap = true; i += 1; break;
      case '--ui-mode': case '--focus': {
        const v = rest[i + 1];
        if (v === undefined || v === '') fail(`${a} needs a value`);
        if (a === '--ui-mode') uiMode = v; else focus = v;
        i += 2; break;
      }
      case '--model': case '--effort': case '--context-bytes': case '--runtime': case '--runtime-reason':
        if (i + 1 >= rest.length) fail(`${a} needs a value`);
        over += ` ${a} ${rest[i + 1]}`; i += 2; break;
      default: fail(`unknown decide argument: ${a}`);
    }
  }
  if (dry && ap) fail('decide --dry and --agent-path exclude each other: --dry only reads, --agent-path records');
  const viaDispatcher = DISPATCHER_IOS.has(ctx.io);
  // the nonce of another process: accepted only for a call that records; the file is consumed by a call that is neither --dry nor --agent-path
  const nok = viaDispatcher || nonceAccepted(ctx, !dry && !ap);
  if ((`${over} `).includes(' --runtime-reason ') && !nok) fail("decide --runtime-reason is dispatch.sh's alone (an automatic failover): the lead does not label its own choice");
  if (!dry && !ap && !nok) {
    fail(`decide refused (A171): it records the decision of a dispatch and is not called ahead of one. Dispatch with dispatch.sh (it decides itself); to only read the decision run: agent.sh decide ${id} ${role} --dry (writes nothing); on the Agent path run it once, right before the Agent call: agent.sh decide ${id} ${role} --agent-path`);
  }
  if (role === 'explorer') explorerSlotCheck(ctx, id, cls);
  if (redo) {
    if (ctx.role !== 'lead') fail('decide --redecide is the lead\'s');
    if (gatesEnforced(ctx, dir)) ledgerAppend(dir, ctx.role, 'note', '-', '-', bytes(`decide --redecide ${role}${focus === '' ? '' : ` focus=${focus}`}: the earlier Agent-route decision stays in decisions/; another runtime or model is wanted`));
  } else if (ap && role !== 'explorer') {
    const pv = latestDecision(dir, role, focus);
    if (pv !== '') {
      const lines = textLines(fileText(ctx, pv) ?? '');
      const resultsN = (lines.find((l) => l.startsWith('results_n=')) ?? '').slice('results_n='.length);
      if (lines.includes('via=agent-path') && resultsN === String(roleResultsCount(ctx, dir, role, focus))) {
        const fo = focus === '' ? '' : ` --focus ${focus}`;
        fail(`decide --agent-path refused: the ${role}${focus === '' ? '' : ` (${focus})`} decision ${pv.slice(pv.lastIndexOf('/') + 1)} was recorded for the Agent call and no result has been recorded since. Make the Agent call with that decision (agent.sh decide ${id} ${role}${fo} --dry shows it again), or record its result first, or to choose another runtime or model: agent.sh decide ${id} ${role}${fo} --redecide [--runtime R] [--model M]`);
      }
    }
  }
  // A171: a gate whose dependency has not completed is not dispatched
  const dgate = gateOf(ctx, role, focus, id);
  if (dgate !== '') {
    const unmet = unmetDeps(ctx, dir, id, dgate);
    if (unmet.length > 0) fail(`${dgate} needs ${unmet.join(' ')} first (GATES.md, Gate dependencies): dispatch that gate and let it pass for the current content, then run this again ('agent.sh next ${id}' lists the order)`);
  }
  const tier = tierEffective(ctx, dir);
  /** @type {string[]} */ const sig = [];
  if (cls === 'CRITICAL') sig.push('critical_class');
  {
    const changed = taskChangedPaths(ctx, dir);
    const lines = pathChangedLines(ctx, dir, changed);
    let total = 0;
    for (const p of changed) total += lines.get(p) ?? 0;
    if (changed.length > 15 || total > 400) sig.push('large_diff');
  }
  if (fixRoundsUsed(ctx, dir) >= 2) sig.push('fix_round_2');
  if ((role === 'designer' || role === 'implementer') && uiSurfaceSignal(ctx, dir, uiMode)) sig.push('ui_persuade');
  if (dgate !== '') {
    const lf = gateLatestFile(ctx, dir, dgate, focus === '' ? '-' : focus);
    if (lf !== '') {
      const r = gateField(ctx, lf, 'result');
      if (r === 'fail') sig.push('recent_fail_same_focus'); else if (r === 'pass_low') sig.push('low_confidence_pass');
    }
  }
  // Runtime and profile are passed only when overridden (decide --runtime, RUN.yaml execution.profile), so the resolver records the real reason from config otherwise.
  let prof = sectionValue(ctx, dir, 'execution', 'profile');
  /** @type {string[]} */ const resolve = ['resolve', '--role', role, '--class', cls, '--tier', tier];
  if (prof === 'max' || prof === 'balanced' || prof === 'economy') resolve.push('--profile', prof); else prof = runProfile(ctx, id);
  for (const s of sig) resolve.push('--signal', s);
  let esc = 0;
  for (const f of decisionFiles(dir)) if (textLines(fileText(ctx, `${dir}/decisions/${f}`) ?? '').includes('escalated=yes')) esc++;
  resolve.push('--escalations-used', String(esc));
  for (const w of over.split(/[ \t\n]+/)) if (w !== '') resolve.push(w);
  const res = policyCommand(ctx, resolve.map(bytes));
  if (res.status !== 0) {
    const rc = res.status === 1 ? 4 : res.status;
    ctx.err(res.err);
    throw new ProoflineError(`decision refused by the execution policy (exit ${rc})`, rc);
  }
  const resOut = res.out.replace(/\n+$/, '');
  const resLines = resOut.split('\n');
  const val = (/** @type {string} */ key, /** @type {string[]} */ lines) => { const p = `${key}=`; const l = lines.find((x) => x.startsWith(p)); return l === undefined ? '' : l.slice(p.length); };
  // A200: the Agent path runs a Claude Code subagent. A role the configuration gives to another runtime is dispatched with dispatch.sh
  if (ap) {
    const rt = val('runtime', resLines);
    if (rt !== '' && rt !== 'claude') {
      fail(`decide --agent-path refused (A200): the role ${role} is configured for the runtime ${rt}, not Claude Code, so it has no Agent path. Dispatch it instead: dispatch.sh ${id} ${role}${focus === '' ? '' : ` --focus ${focus}`} --prompt-file <assignment file> (it decides itself). To run this role on Claude Code instead, the user changes runtime.roles.${role} (or the group key) in .agents/config.yaml`);
    }
  }
  let body = `${resOut}\nrole=${role}\nfocus=${bytes(focus)}\nclass=${cls}\ntier=${tier}\nprofile=${prof}\nsignals=${sig.join(',')}\ndecided_at=${now().epoch}`;
  if (ap) body += `\nvia=agent-path\nresults_n=${roleResultsCount(ctx, dir, role, focus)}`;
  const bl = body.split('\n');
  const sum = `decision: role=${val('role', bl)} runtime=${val('runtime', bl)} model=${val('model', bl)} effort=${val('effort', bl)} reason=${val('model_reason', bl)}`;
  if (dry) { ctx.out(`${sum} (dry run: nothing recorded)\n${body}\n`); return 0; }
  const decisions = `${dir}/decisions`;
  mkdirSync(decisions, { recursive: true });
  const tag = focus === '' ? role : `${role}-${focus.replace(/\+/g, '-')}`;
  const out = `${decisions}/${nextNum(decisions)}-${bytes(tag)}.decision`;
  writeFileSync(`${out}.tmp`, Buffer.from(`${body}\n`, 'latin1'));
  renameSync(`${out}.tmp`, out);
  ctx.forget('file:');
  if (gatesEnforced(ctx, dir)) {
    ledgerAppend(dir, ctx.role, 'decide', '-', '-', `${out.slice(out.lastIndexOf('/') + 1)} runtime=${val('runtime', bl)} model=${val('model', bl)} effort=${val('effort', bl)} signals=${sig.join(' ')}`);
  }
  ctx.out(`${sum}\n${body}\ndecision_file=${out.slice(ctx.root.length + 1)}\n`);
  return 0;
}

/** `ledger-note ID TEXT`: a ledgered free-text note (the lead, or the dispatcher: failover, policy violation, interruption ...). @param {Context} ctx @param {string[]} args */
export function ledgerNote(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = args[0] ?? ''; const text = args[1] ?? '';
  if (id === '' || text === '') throw unsupported('usage');
  requireRun(ctx, id);
  requireLead(ctx);
  const dir = ctx.runDir(id);
  if (!gatesEnforced(ctx, dir)) fail('ledger-note requires the lifecycle_gates policy');
  if (!/[^ \t\n\v\f\r]/.test(text)) fail('ledger-note needs text');
  verifySeal(ctx, id, dir);
  const s = sectionValue(ctx, dir, 'handoff', 'state');
  ledgerAppend(dir, ctx.role, 'note', s, s, bytes(text));
  ctx.forget('file:');
  ctx.out(`ledger note recorded: ${id}\n`);
  return 0;
}

/** `metrics-dispatch ID ROLE FOCUS RUNTIME MODEL DURATION TIN TOUT TTOTAL TURNS RETRIES RESULT` (lead only; empty = null). @param {Context} ctx @param {string[]} args */
export function metricsDispatch(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  if (args.length < 12) fail('usage: agent.sh metrics-dispatch <ID> <ROLE> <FOCUS> <RUNTIME> <MODEL> <DURATION_S> <TOKENS_IN> <TOKENS_OUT> <TOKENS_TOTAL> <TURNS> <RETRIES> <RESULT> (empty = null)');
  const [id, role, focus, runtime, model, duration, tin, tout, ttot, turns, retries, result] = args.map(bytes);
  requireRun(ctx, args[0]);
  metricsJson(ctx, ['dispatch', id, role, focus, gateOf(ctx, args[1], args[2], args[0]), runtime, model, duration, tin, tout, ttot, turns, retries, '-', '-', result]);
  return 0;
}

export const DECIDE_HANDLERS = { decide, 'ledger-note': ledgerNote, 'metrics-dispatch': metricsDispatch };
