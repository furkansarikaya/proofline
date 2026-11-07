// @ts-check
// The execution-policy resolver (D5, A222; the former scripts/exec-policy.sh). A pure function of its inputs: no clock, no randomness, no model call,
// no run state. `agent.sh decide` gathers the inputs from a run and calls `cli exec-policy resolve ...`; it ledgers the result itself.
//
//   resolve --role R --class C --tier T [--profile P] [--runtime RT] [--signal S]... [--escalations-used N] [--model M] [--effort E]
//       [--context-bytes N] [--runtime-reason AUTOMATIC_FAILOVER]
//   explain < decision          reason codes -> text
//   check-capabilities          the codex ladder against the local Codex model cache
//   check-lead --runtime RT [--model M]   a lead must run on the base model or stronger (A135)
//   lead-base <runtime>         the base model of a lead (nothing: none enforced)
//   runtime <role>              the configured runtime of a role (runtime.roles.<role> > runtime.<group>)
//
// Inputs: .agents/config.yaml and .agents/roles.conf of the project. Precedence, top wins:
//   1 hard limits: role tier floor, forbidden efforts, max_context_bytes, escalation budget
//   2 explicit operator override (--runtime/--profile/--model/--effort/--context-bytes)
//   3 task policy: roles.conf row for (role, profile, runtime), class floors, escalation signals
//   4 capability validation against the runtime's ladder and capabilities
// Output: key=value lines. Exit: 0 resolved | 2 usage or invalid config | 3 invalid override | 4 unresolvable (no ladder, no role policy,
// capability floor unmet).
//
// While the project holds `.agents/scripts/exec-policy.sh` the core runs that file instead (the fixture stub of the self-tests, D14): there is no
// environment value that changes a decision, and the only way to name another config is the explicit `--config`/`--roles` of the `cli` form.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ProoflineError } from './errors.mjs';
import { isFile } from './paths.mjs';
import { asciiUpper } from './shellglob.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WS = '[ \\t\\n\\v\\f\\r]';
const reBlankOrComment = new RegExp(`^${WS}*(#|$)`);
const reValTail = new RegExp(`^[^:]*:${WS}*`);
const reCommentTail = new RegExp(`${WS}+#.*$`);

/** @param {string} m @returns {ProoflineError} */
const die = (m) => new ProoflineError(`exec-policy: ${m}`, 2, 'POLICY_USAGE');
/** @param {string} code @param {string} m */
const reject = (code, m) => new ProoflineError(`exec-policy: REJECTED ${code}: ${m}`, 3, 'POLICY_REJECTED');
/** @param {string} code @param {string} m */
const hard = (code, m) => new ProoflineError(`exec-policy: UNRESOLVABLE ${code}: ${m}`, 4, 'POLICY_UNRESOLVABLE');

/** The words of a list the way the shell splits it (blanks, tabs, newlines). @param {string} s @returns {string[]} */
const words = (s) => s.split(/[ \t\n]+/).filter((w) => w !== '');
/** `int`: digits only. @param {string} s */
const isInt = (s) => /^[0-9]+$/.test(s);
/** The shell's integer range (signed 64 bits): a longer number is an `Illegal number` error of `[ ]`, never a value. @param {string} s @returns {bigint | null} */
const SHELL_MAX = 9223372036854775807n;
const shellInt = (s) => { if (!isInt(s)) return null; const n = BigInt(s); return n > SHELL_MAX ? null : n; };
/** `idx WORD LIST`: the 1-based position, or 0. @param {string} w @param {string[]} list */
const idx = (w, list) => list.indexOf(w) + 1;

/** `canon_role`. @param {string} r */
export function canonRole(r) {
  switch (r) {
    case 'full_lifecycle': return 'lead';
    case 'implementation_worker': return 'implementer';
    case 'independent_reviewer': return 'reviewer';
    case 'independent_qa': return 'qa';
    case 'independent_verifier': return 'verifier';
    default: return r;
  }
}
/** `role_group`: the runtime.<group> key of a role (D6). @param {string} r */
function roleGroup(r) {
  if (r === 'lead') return 'lead';
  return ['reviewer', 'security_reviewer', 'qa', 'verifier'].includes(r) ? 'reviewers' : 'worker';
}

const ROLE_NAMES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];
const SIGNALS = ['low_confidence_pass', 'recent_fail_same_focus', 'large_diff', 'critical_class', 'fix_round_2', 'ui_persuade'];

/** The two files a resolution reads, parsed once. */
export class Policy {
  /** @param {string} configFile @param {string} rolesFile */
  constructor(configFile, rolesFile) {
    this.configFile = configFile;
    this.rolesFile = rolesFile;
    /** @type {string[] | null} */ this._lines = null;
  }

  /** @returns {boolean} */ hasConfig() { return isFile(this.configFile); }
  /** @returns {boolean} */ hasRoles() { return isFile(this.rolesFile); }

  /** The config as byte-string lines. @returns {string[]} */
  lines() {
    if (this._lines === null) {
      let text = '';
      try { text = readFileSync(this.configFile, 'latin1'); } catch { throw die(`config not found: ${this.configFile}`); }
      const rows = text.split('\n');
      if (rows[rows.length - 1] === '') rows.pop();
      this._lines = rows;
    }
    return this._lines;
  }

  /**
   * `cfg_walk val|keys KEY...`: the scalar at a key path (the first one, in file order), or the child keys of a path. The indentation (two spaces a
   * level) gives the path; a line without a colon, a comment and a blank line are skipped.
   * @param {'val' | 'keys'} mode @param {string[]} want @returns {string[]}
   */
  walk(mode, want) {
    const w = want.join(' ');
    /** @type {Array<string | undefined>} */ const st = [];
    /** @type {string[]} */ const out = [];
    for (const raw of this.lines()) {
      if (reBlankOrComment.test(raw)) continue;
      const m = /[^ ]/.exec(raw);
      const ind = m ? m.index : 0;
      const d = Math.floor(ind / 2);
      const line = raw.slice(ind);
      if (!line.includes(':')) continue;
      const key = line.slice(0, line.indexOf(':'));
      let val = line.replace(reValTail, '').replace(reCommentTail, '');
      if (/^".*"$/.test(val)) val = val.slice(1, val.length - 1);
      for (let i = d + 1; i < 32; i++) st[i] = undefined;
      st[d] = key;
      let p = st[0] ?? '';
      for (let i = 1; i <= d; i++) p = `${p} ${st[i] ?? ''}`;
      if (mode === 'val' && p === w) return [val];
      if (mode === 'keys') {
        const par = p.replace(/ [^ ]*$/, '');
        if (d > 0 && par === w) out.push(key);
      }
    }
    return out;
  }

  /** `cfg KEY...`: the scalar at a key path, '' when absent. @param {...string} keys */
  cfg(...keys) { return this.walk('val', keys)[0] ?? ''; }

  /** `role_runtime`: runtime.roles.<role>, else runtime.<group>, else claude. @param {string} role */
  roleRuntime(role) {
    return this.cfg('runtime', 'roles', role) || this.cfg('runtime', roleGroup(role)) || 'claude';
  }

  /** The roles.conf lines. @returns {string[]} */
  roleRows() {
    let text = '';
    try { text = readFileSync(this.rolesFile, 'latin1'); } catch { return []; }
    return text.split('\n');
  }

  /**
   * `model_tier RT MODEL`: capabilities.<rt>.<model>, else the ladder position; null when the model is not on the ladder. A tier that is not an
   * integer is an invalid config (exit 2).
   * @param {string} rt @param {string} model @returns {number | null}
   */
  modelTier(rt, model) {
    let mt = this.cfg('capabilities', rt, model);
    if (mt === '') {
      const i = idx(model, words(this.cfg('execution_policy', 'providers', rt, 'models')));
      if (i === 0) return null;
      mt = String(i);
    }
    if (!isInt(mt)) throw die(`capabilities.${rt}.${model} must be an integer`);
    return Number(mt);
  }

  /** `model_at_tier N` over a ladder: the first model whose tier is at least N, or null. @param {string} rt @param {string[]} ladder @param {number} n */
  modelAtTier(rt, ladder, n) {
    for (const m of ladder) { const t = this.modelTier(rt, m); if (t !== null && t >= n) return m; }
    return null;
  }

  /** A tier that must exist: the model comes from the ladder. @param {string} rt @param {string} model */
  mustTier(rt, model) {
    const t = this.modelTier(rt, model);
    if (t === null) throw new ProoflineError('', 1, 'POLICY_SILENT');
    return t;
  }
}

/** `kv STRING KEY`: the value of the first KEY=value word, or null. @param {string} s @param {string} key */
function kv(s, key) {
  for (const t of words(s)) if (t.startsWith(`${key}=`)) return t.slice(key.length + 1);
  return null;
}

/**
 * `resolve`: the decision for a role, as `key=value` lines.
 * @param {Policy} pol @param {string[]} argv
 * @returns {string}
 */
export function resolve(pol, argv) {
  let role = ''; let cls = ''; let tier = ''; let profile = ''; let rt = ''; let signals = ''; let usedS = '0'; let oModel = ''; let oEffort = ''; let oCtx = ''; let oRreason = '';
  for (let i = 0; i < argv.length; i += 2) {
    if (i + 1 >= argv.length) throw die(`missing value for ${argv[i]}`);
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--role': role = canonRole(v); break;
      case '--class': cls = v; break;
      case '--tier': tier = v; break;
      case '--profile': profile = v; break;
      case '--runtime': rt = v; break;
      case '--runtime-reason': oRreason = v; break;
      case '--signal': signals = `${signals} ${v}`; break;
      case '--escalations-used': usedS = v; break;
      case '--model': oModel = v; break;
      case '--effort': oEffort = v; break;
      case '--context-bytes': oCtx = v; break;
      default: throw die(`unknown option: ${argv[i]}`);
    }
  }
  if (!pol.hasConfig()) throw die(`config not found: ${pol.configFile}`);
  if (!pol.hasRoles()) throw die(`roles policy not found: ${pol.rolesFile}`);
  if (!ROLE_NAMES.includes(role)) throw die(`unknown role: '${role}'`);
  const classLine = pol.cfg('execution_policy', 'classes', cls);
  if (classLine === '') throw die(`no execution_policy.classes entry for class '${cls}'`);
  if (!['docs', 'small', 'full'].includes(tier)) throw die('--tier must be docs|small|full');
  if (!isInt(usedS)) throw die('--escalations-used must be an integer');
  const used = Number(usedS);
  for (const s of words(signals)) {
    if (!SIGNALS.includes(s)) throw die(`unknown signal: ${s} (want ${SIGNALS.join('|')})`);
  }
  if (cls === 'CRITICAL' && !` ${signals} `.includes(' critical_class ')) signals = `${signals} critical_class`;

  // profile and runtime: operator override > config
  let preason = 'OPERATOR_OVERRIDE';
  if (profile === '') { profile = pol.cfg('profile'); preason = 'CONFIG_PROFILE'; }
  if (profile === '') { profile = 'balanced'; preason = 'DEFAULT_PROFILE'; }
  if (!['max', 'balanced', 'economy'].includes(profile)) {
    if (preason === 'OPERATOR_OVERRIDE') throw reject('INVALID_PROFILE', `${profile} (want max|balanced|economy)`);
    throw die(`invalid profile in config: ${profile}`);
  }
  let rreason = 'OPERATOR_OVERRIDE';
  // A203: the dispatch label of an automatic failover (dispatch.sh passes it with the runtime it fails over to): its own reason, never an operator's
  if (oRreason === '') { /* none */ } else if (oRreason === 'AUTOMATIC_FAILOVER') { if (rt !== '') rreason = 'AUTOMATIC_FAILOVER'; } else throw reject('INVALID_RUNTIME_REASON', `${oRreason} (want AUTOMATIC_FAILOVER)`);
  if (rt === '') { rt = pol.cfg('runtime', 'roles', role); rreason = 'CONFIG_RUNTIME_ROLE'; }
  if (rt === '') { rt = pol.cfg('runtime', roleGroup(role)); rreason = 'CONFIG_RUNTIME_GROUP'; }
  if (rt === '') { rt = 'claude'; rreason = 'DEFAULT_RUNTIME'; }
  const ladderS = pol.cfg('execution_policy', 'providers', rt, 'models');
  const ladder = words(ladderS);
  if (ladder.length === 0) throw hard('NO_LADDER', `runtime ${rt} has no execution_policy.providers.${rt}.models`);
  const effortsS = pol.cfg('execution_policy', 'providers', rt, 'efforts');
  const efforts = words(effortsS);
  if (efforts.length === 0) throw die(`execution_policy.providers.${rt}.efforts missing`);
  const forbidden = words(pol.cfg('execution_policy', 'forbidden_efforts'));
  const maxCtxS = pol.cfg('execution_policy', 'max_context_bytes');
  const maxCtx = shellInt(maxCtxS);
  if (maxCtx === null) throw die('execution_policy.max_context_bytes must be an integer');
  let maxEscS = pol.cfg('budgets', 'max_escalations');
  if (maxEscS === '') maxEscS = '2';
  if (!isInt(maxEscS)) throw die('budgets.max_escalations must be an integer');
  const maxEsc = Number(maxEscS);

  // task policy: the roles.conf row for this runtime, else the row of another runtime mapped by tier
  const rowOf = (/** @type {boolean} */ withRt) => {
    for (const l of pol.roleRows()) {
      const f = words(l);
      if (f.length === 0 || f[0].startsWith('#')) continue;
      if (f[0] === role && f[1] === profile && (!withRt || f[2] === rt)) return l;
    }
    return '';
  };
  let row = rowOf(true);
  let mreason = 'ROLE_PROFILE';
  if (row === '') { row = rowOf(false); mreason = 'ROLE_TIER_MAPPED'; }
  if (row === '') throw hard('NO_ROLE_POLICY', `no roles.conf line for ${role}/${profile}`);
  const rf = words(row);
  if (rf.length !== 6) throw die(`malformed roles.conf line: ${row}`);
  const [, , rowRt, rowModel, rowEffort, floorS] = rf;
  if (!isInt(floorS)) throw die(`roles.conf tier_floor must be an integer: ${row}`);
  const floor = Number(floorS);
  let want;
  if (/^tier[0-9]$/.test(rowModel)) want = Number(rowModel.slice(4));
  else {
    const t = pol.modelTier(rowRt, rowModel);
    if (t === null) throw die(`roles.conf model ${rowModel} is not a ${rowRt} model`);
    want = t;
  }
  // hard floor first: a runtime that cannot reach it never serves the role (D7)
  const top = pol.mustTier(rt, ladder[ladder.length - 1]);
  if (top < floor) throw hard('CAPABILITY_FLOOR_UNMET', `${role} needs capability tier ${floor}; runtime ${rt} reaches ${top}`);
  let model;
  if (rowRt === rt && idx(rowModel, ladder) > 0) model = rowModel;
  else {
    model = pol.modelAtTier(rt, ladder, want);
    if (model === null) throw hard('NO_MODEL_AT_TIER', `runtime ${rt} has no model of tier >= ${want}`);
  }
  if (pol.mustTier(rt, model) < floor) {
    const raised = pol.modelAtTier(rt, ladder, floor);
    if (raised === null) throw new ProoflineError('', 1, 'POLICY_SILENT');
    model = raised; mreason = `${mreason},RAISED_TO_FLOOR`;
  }

  // effort: role effort, raised to the class floor, normalized to the runtime's scale
  let ereason = 'ROLE_PROFILE';
  let ei = idx(rowEffort, efforts);
  if (ei === 0) ei = efforts.length;
  if (efforts[ei - 1] !== rowEffort) ereason = `${ereason},CLAMPED_TO_RUNTIME_MAX`;
  const cf = kv(classLine, 'effort');
  if (cf !== null) { const cfi = idx(cf, efforts); if (cfi > 0 && cfi > ei) { ei = cfi; ereason = `${ereason},CLASS_FLOOR`; } }

  // operator overrides (hard limits still apply)
  if (oModel !== '') {
    if (idx(oModel, ladder) === 0) throw reject('UNKNOWN_MODEL', `${oModel} is not in the ${rt} ladder (${ladderS})`);
    if (pol.mustTier(rt, oModel) < floor) throw hard('CAPABILITY_FLOOR_UNMET', `${oModel} is below the tier floor ${floor} of ${role}`);
    model = oModel; mreason = 'OPERATOR_OVERRIDE';
  }
  if (oEffort !== '') {
    if (idx(oEffort, forbidden) > 0) throw reject('FORBIDDEN_EFFORT', `${oEffort} is forbidden by execution_policy.forbidden_efforts`);
    ei = idx(oEffort, efforts);
    if (ei === 0) throw reject('UNKNOWN_EFFORT', `${oEffort} (runtime ${rt} supports: ${effortsS})`);
    ereason = 'OPERATOR_OVERRIDE';
  }

  // ui_persuade (0.0.27, A170): a UI task whose surface is persuade or experience runs its designer and implementer on the strongest model of the
  // ladder. It is a placement, not an escalation: it spends no escalation budget and is not a step.
  const signalsAll = words(signals);
  const rest = signalsAll.filter((s) => s !== 'ui_persuade');
  if (signalsAll.includes('ui_persuade') && (role === 'designer' || role === 'implementer') && oModel === '') {
    const topM = ladder[ladder.length - 1];
    if (topM !== model) { model = topM; mreason = `${mreason},UI_PERSUADE_STRONGEST`; }
  }

  // escalation: any signal raises one step (model first, effort when the model is pinned or at the top)
  let escalated = 'no'; let xreason = 'NO_SIGNAL';
  if (rest.length > 0) {
    if (used >= maxEsc) xreason = 'ESCALATION_BUDGET_EXHAUSTED';
    else {
      const mi = idx(model, ladder);
      if (oModel === '' && mi < ladder.length) {
        model = ladder[mi]; mreason = `${mreason},ESCALATED`; escalated = 'yes'; xreason = 'ESCALATED_MODEL';
      } else if (oEffort === '' && ei < efforts.length) {
        ei += 1; ereason = `${ereason},ESCALATED`; escalated = 'yes'; xreason = 'ESCALATED_EFFORT';
      } else xreason = 'AT_CEILING';
    }
  }
  const effort = efforts[ei - 1];

  // context budget: class budget, halved for docs/small tiers; override; hard cap
  const ctxS = kv(classLine, 'context_bytes');
  if (ctxS === null) throw die(`class ${cls} has no context_bytes`);
  let ctxN = shellInt(ctxS);
  if (ctxN === null) throw die(`class ${cls}: context_bytes must be an integer`);
  let ctx = ctxS;   // the digits as written, like the shell's string (only arithmetic turns them into a number)
  let creason = 'CLASS_BUDGET';
  if (tier === 'docs' || tier === 'small') { ctxN /= 2n; ctx = String(ctxN); creason = `${creason},TIER_${asciiUpper(tier)}`; }
  if (oCtx !== '') {
    const o = shellInt(oCtx);   // a number beyond the shell's range is an error of `[ -gt ]` there: refused (fail closed)
    if (o === null || o <= 0n) throw reject('INVALID_OVERRIDE', 'context-bytes must be a positive integer');
    ctx = oCtx; ctxN = o; creason = 'OPERATOR_OVERRIDE';
  }
  if (ctxN > maxCtx) { ctx = maxCtxS; creason = `${creason},CAPPED_AT_HARD_LIMIT`; }

  const sig = signalsAll.join(',');
  return [
    `policy_version=${pol.cfg('execution_policy', 'revision')}`, `role=${role}`, `class=${cls}`, `tier=${tier}`, `profile=${profile}`, `profile_reason=${preason}`,
    `runtime=${rt}`, `runtime_reason=${rreason}`, `model=${model}`, `model_reason=${mreason}`, `effort=${effort}`, `effort_reason=${ereason}`,
    `context_bytes=${ctx}`, `context_reason=${creason}`, `capability_tier=${pol.mustTier(rt, model)}`, `tier_floor=${floor}`, `signals=${sig === '' ? 'none' : sig}`,
    `escalated=${escalated}`, `escalation_reason=${xreason}`,
  ].map((l) => `${l}\n`).join('');
}

const REASON_TEXT = /** @type {Record<string, string>} */ ({
  OPERATOR_OVERRIDE: 'explicit operator override',
  AUTOMATIC_FAILOVER: 'runtime chosen by an automatic failover (config failover: auto), not by an operator',
  CONFIG_PROFILE: 'profile from config',
  DEFAULT_PROFILE: 'no profile configured: balanced',
  CONFIG_RUNTIME_ROLE: 'runtime from config runtime.roles.<role>',
  CONFIG_RUNTIME_GROUP: 'runtime from config runtime.lead|worker|reviewers',
  DEFAULT_RUNTIME: 'no runtime configured: claude',
  ROLE_PROFILE: "the role's model/effort for this profile (roles.conf)",
  ROLE_TIER_MAPPED: "no roles.conf line for this runtime: another runtime's line mapped by capability tier",
  RAISED_TO_FLOOR: "raised to the role's capability tier floor",
  CLASS_FLOOR: "raised to the task class's effort floor",
  CLAMPED_TO_RUNTIME_MAX: "role effort not on this runtime's scale: its maximum used",
  ESCALATED: 'one step up after an escalation signal',
  ESCALATED_MODEL: 'escalation signal: next model in the ladder',
  ESCALATED_EFFORT: 'escalation signal: model pinned or at the top, next effort',
  ESCALATION_BUDGET_EXHAUSTED: 'escalation signal ignored: budgets.max_escalations used up',
  AT_CEILING: 'escalation signal ignored: model and effort at their ceiling or pinned',
  NO_SIGNAL: 'no escalation signal',
  CLASS_BUDGET: 'context budget of the task class',
  TIER_DOCS: 'docs/small tier: half the class context budget',
  TIER_SMALL: 'docs/small tier: half the class context budget',
  CAPPED_AT_HARD_LIMIT: 'bounded by execution_policy.max_context_bytes',
  UI_PERSUADE_STRONGEST: 'UI task on a persuade or experience surface: strongest model of the ladder',
});

/** `explain`: the reason codes of a decision, as text. @param {string} text a decision (key=value lines) */
export function explain(text) {
  let out = '';
  for (const l of text.split('\n')) {
    const eq = l.indexOf('=');
    if (eq < 0) continue;
    const k = l.slice(0, eq);
    if (!k.endsWith('_reason')) continue;
    for (const c of l.slice(eq + 1).replace(/,/g, ' ').split(/[ \t\n]+/).filter((x) => x !== '')) out += `${k}: ${c} - ${REASON_TEXT[c] ?? `(no text for ${c})`}\n`;
  }
  return out;
}

/**
 * `check-capabilities`: the codex ladder against the local Codex model cache (CODEX_MODELS_CACHE, else ~/.codex/models_cache.json).
 * @param {Policy} pol @param {NodeJS.ProcessEnv} env @returns {{ status: number, out: string }}
 */
export function checkCapabilities(pol, env) {
  if (!pol.hasConfig()) throw die(`config not found: ${pol.configFile}`);
  const cache = env.CODEX_MODELS_CACHE || `${env.HOME ?? ''}/.codex/models_cache.json`;
  if (!isFile(cache)) return { status: 0, out: `no local Codex model cache at ${cache}; nothing to verify against\n` };
  /** @type {any} */ let json;
  try { json = JSON.parse(readFileSync(cache, 'utf8')); } catch { throw die(`the Codex model cache is not readable JSON: ${cache}`); }
  const models = Array.isArray(json?.models) ? json.models : [];
  let out = '';
  let bad = 0;
  const effortsWanted = words(pol.cfg('execution_policy', 'providers', 'codex', 'efforts'));
  for (const m of words(pol.cfg('execution_policy', 'providers', 'codex', 'models'))) {
    /** @type {string[]} */ const have = [];
    for (const e of models) {
      if (e?.slug !== m) continue;
      const levels = Array.isArray(e.supported_reasoning_levels) ? e.supported_reasoning_levels : [];
      for (const lv of levels) have.push(typeof lv?.effort === 'string' ? lv.effort : '');
    }
    const haveS = have.join(',');
    if (haveS === '') { out += `MISSING model in local Codex cache: ${m}\n`; bad = 1; continue; }
    for (const e of effortsWanted) if (!`,${haveS},`.includes(`,${e},`)) { out += `UNSUPPORTED effort ${e} for ${m} (cache: ${haveS})\n`; bad = 1; }
  }
  if (bad === 0) out += `codex ladder consistent with ${cache}\n`;
  return { status: bad, out };
}

/**
 * `lead-base RT`: the base (full-strength) model a LEAD must run on (A135): execution_policy.lead_base_model.<runtime>; when an older installed config
 * lacks the key it is derived from the ladder (lowest model meeting the lead tier floor of roles.conf, 2 without it), so enforcement never turns off.
 * Enforced for codex only. '' when the runtime has none.
 * @param {Policy} pol @param {string} rt @returns {string}
 */
export function leadBase(pol, rt) {
  if (!pol.hasConfig()) throw die(`config not found: ${pol.configFile}`);
  const lb = pol.cfg('execution_policy', 'lead_base_model', rt);
  if (lb !== '') return lb;
  if (rt !== 'codex') return '';
  const ladder = words(pol.cfg('execution_policy', 'providers', rt, 'models'));
  let lf = 2;
  for (const l of pol.roleRows()) {
    const f = words(l);
    if (f[0] === 'lead' && f[2] === rt) { if (f[5] !== undefined && isInt(f[5])) lf = Number(f[5]); break; }
  }
  const m = pol.modelAtTier(rt, ladder, lf);
  if (m === null) throw new ProoflineError('', 1, 'POLICY_SILENT');
  return m;
}

/**
 * `check-lead --runtime RT [--model M]`: a lead must run on the base model of its runtime or stronger. An unset model (the runtime default)
 * cannot be verified and is refused.
 * @param {Policy} pol @param {string[]} argv
 */
export function checkLead(pol, argv) {
  let rt = ''; let model = '';
  for (let i = 0; i < argv.length; i += 2) {
    if (i + 1 >= argv.length) throw die(`missing value for ${argv[i]}`);
    if (argv[i] === '--runtime') rt = argv[i + 1];
    else if (argv[i] === '--model') model = argv[i + 1];
    else throw die(`unknown option: ${argv[i]}`);
  }
  if (rt === '') throw die('check-lead needs --runtime');
  const base = leadBase(pol, rt);
  if (base === '') return;
  if (model === '') throw reject('LEAD_MODEL_UNSET', `a ${rt} lead must name its model (base model ${base} or stronger); the runtime default cannot be verified`);
  const ladderS = pol.cfg('execution_policy', 'providers', rt, 'models');
  if (idx(model, words(ladderS)) === 0) throw reject('UNKNOWN_MODEL', `${model} is not in the ${rt} ladder (${ladderS})`);
  const have = pol.modelTier(rt, model);
  const need = pol.modelTier(rt, base);
  if (have === null || need === null || have < need) throw reject('LEAD_BELOW_BASE', `a ${rt} lead must run on the base model ${base} or stronger, not ${model} (cheap models are for workers only)`);
}

/**
 * The `exec-policy` operation of the core: `[--config F] [--roles F] resolve|explain|check-capabilities|check-lead|lead-base|runtime ...`.
 * While `.agents/scripts/exec-policy.sh` exists in the project the core runs that file (a fixture stub) and relays its output and status.
 * @param {Context} ctx @param {string[]} argv @param {string} [stdin] the decision `explain` reads
 * @returns {{ status: number, out: string, err: string }}
 */
export function policyCommand(ctx, argv, stdin = '') {
  let config = ''; let roles = '';
  let args = argv;
  while (args.length >= 2 && (args[0] === '--config' || args[0] === '--roles')) {
    if (args[0] === '--config') config = args[1]; else roles = args[1];
    args = args.slice(2);
  }
  if (config === '' && roles === '') {
    const stub = `${ctx.trustedScripts}/exec-policy.sh`;
    if (isFile(stub)) {
      const r = proc.run('sh', [stub, ...args.map((a) => Buffer.from(a, 'latin1').toString('utf8'))], { cwd: ctx.cwd, env: ctx.childEnv(), input: stdin, stdio: ['pipe', 'pipe', 'pipe'] });
      return { status: r.status, out: r.stdout.toString('latin1'), err: r.stderr.toString('latin1') };
    }
  }
  const configFile = config || ctx.configFile;
  const rolesFile = roles || (config ? path.join(path.dirname(config), 'roles.conf') : `${ctx.root}/.agents/roles.conf`);
  const pol = new Policy(configFile, rolesFile);
  const op = args[0] ?? '';
  try {
    switch (op) {
      case 'resolve': return { status: 0, out: resolve(pol, args.slice(1)), err: '' };
      case 'explain': return { status: 0, out: explain(stdin), err: '' };
      case 'check-capabilities': { const r = checkCapabilities(pol, ctx.env); return { status: r.status, out: r.out, err: '' }; }
      case 'check-lead': checkLead(pol, args.slice(1)); return { status: 0, out: '', err: '' };
      case 'lead-base': {
        if (args.length !== 2) throw die('usage: lead-base <runtime>');
        const b = leadBase(pol, args[1]);
        return { status: 0, out: b === '' ? '' : `${b}\n`, err: '' };
      }
      case 'runtime': {
        if (args.length !== 2) throw die('usage: runtime <role>');
        if (!pol.hasConfig()) throw die(`config not found: ${pol.configFile}`);
        return { status: 0, out: `${pol.roleRuntime(canonRole(args[1]))}\n`, err: '' };
      }
      default: throw die('usage: resolve|explain|check-capabilities|check-lead|lead-base|runtime <role>');
    }
  } catch (e) {
    if (e instanceof ProoflineError) return { status: e.exitCode, out: '', err: e.message === '' ? '' : `${e.message}\n` };
    throw e;
  }
}

/**
 * The configured runtime of a role, as a step record names it when no decision exists: through the stub while one is installed, else the config.
 * '' when the policy cannot say.
 * @param {Context} ctx @param {string} role
 */
export function configuredRuntime(ctx, role) {
  const r = policyCommand(ctx, ['runtime', role]);
  return r.status === 0 ? r.out.replace(/\n+$/, '') : '';
}
