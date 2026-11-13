// @ts-check
// Stage 4, package 4C: the pieces the result protocol (`record`, `submit`) shares, each the shell function of agent.sh 0.0.47 of the same name:
// where each role reports (`artifact_paths`, `artifact_allowed`), the result kinds and finding prefixes, the header and findings parsers, the cited
// evidence checks, the skill validators, the reproduced-evidence re-run, the evidence of an UNSUPPORTED result, the classification flip and the
// per-step metrics.
import { asciiLower, asciiUpper } from './shellglob.mjs';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashFile } from './fingerprint.mjs';
import { NORMALIZE } from './commands/tools.mjs';
import { findingKey, gateNames, lastReopenSeq, requiredGates } from './gates.mjs';
import { BLOCKING_RULE_VERSION } from './gatewrite.mjs';
import { baseMovedLines } from './lifecycle.mjs';
import * as proc from './proc.mjs';
import { probePerformance, probeVisual } from './probes.mjs';
import { fileText, gateField, sectionValue, textLines } from './records.mjs';
import { configuredRuntime } from './execpolicy.mjs';
import { inside, isLocalAbsolute, notRunRelative, realpathPosix } from './pathin.mjs';
import { runDir } from './runs.mjs';
import { riskSignals } from './signals.mjs';
import { verifyCommandTimeout } from './timeouts.mjs';
import { listNames } from './ledger.mjs';
import { metricsJson, metricsLine } from './runend.mjs';
import { findCodexRollout, toolsRecord } from './toolstats.mjs';
import { now } from './clock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WSC = '[ \\t\\n\\v\\f\\r]';

// ---- roles, kinds and prefixes ---------------------------------------------------------------------------------------------------

/** `is_gate_role` @param {string} r */
export const isGateRole = (r) => r === 'reviewer' || r === 'security_reviewer' || r === 'qa' || r === 'verifier';

/** `result_kind ROLE RESULT` -> 'gate' | 'task' | '' (the result is not valid for the role). @param {string} role @param {string} res */
export function resultKind(role, res) {
  switch (res) {
    case 'UNSUPPORTED': case 'PASS': case 'FAIL': return isGateRole(role) ? 'gate' : '';
    case 'BLOCKED': return isGateRole(role) && role !== 'qa' ? 'gate' : 'task';
    case 'DONE': case 'NEEDS_INPUT': return role === 'reviewer' || role === 'security_reviewer' || role === 'verifier' ? '' : 'task';
    default: return '';
  }
}

/** `finding_prefix ROLE KIND GATE` @param {string} role @param {string} kind @param {string} gate */
export const findingPrefix = (role, kind, gate) => (kind === 'gate' && gate !== '' ? gate : role);

/** `id_keys`: upper case, leading zeros of the number dropped. @param {string} id */
export const idKey = (id) => asciiUpper(id).replace(/-0+([0-9])/g, '-$1');

/** `risk_focus_report FOCUS` @param {string} f */
export function riskFocusReport(f) {
  switch (f) {
    case 'contract': return 'reviews/contract-proof/';
    case 'concurrency': return 'reviews/concurrency-proof/';
    case 'performance': return 'reviews/performance-proof/';
    case 'config': return 'reviews/proof-review/config/';
    case 'migration': return 'reviews/data-migration/';
    case 'visual': return 'reviews/visual-proof/';
    case 'dependencies': return 'security/dependencies/';
    case 'logging': return 'security/logging/';
    default: return '';
  }
}

/** `gate_of ROLE [FOCUS] [ID]`: the gate a role's result lands on, '' when none. @param {Context} ctx @param {string} role @param {string} focus @param {string} id */
export function gateOf(ctx, role, focus, id) {
  switch (`${role}:${focus}`) {
    case 'reviewer:plan': return 'REVIEW_PLAN';
    case 'reviewer:rules': return 'REVIEW_RULES';
    case 'reviewer:tests': return 'REVIEW_TESTS';
    case 'reviewer:data': case 'reviewer:migration': return 'REVIEW_DATA';
    case 'reviewer:rules+tests': return 'REVIEW_SMALL';
    case 'reviewer:contract': case 'reviewer:concurrency': case 'reviewer:performance': case 'reviewer:config':
      return id !== '' && requiredGates(ctx, runDir(ctx, id)).includes('REVIEW_SMALL') ? 'REVIEW_SMALL' : 'REVIEW_RULES';
    default:
      if (role === 'security_reviewer') return 'SECURITY';
      if (role === 'qa') return 'QA';
      if (role === 'verifier') return 'VERIFY';
      return '';
  }
}

/** `artifact_paths ROLE KIND FOCUS` @param {string} role @param {string} kind @param {string} focus */
export function artifactPaths(role, kind, focus) {
  if (role === 'reviewer') {
    switch (focus) {
      case 'plan': return 'reviews/proof-review/plan/';
      case 'rules': return 'reviews/proof-review/rules/';
      case 'rules+tests': return 'reviews/proof-review/small/';
      case 'tests': return 'reviews/test-trust/tests/';
      case 'data': return 'reviews/data-design/';
      case 'contract': case 'concurrency': case 'performance': case 'config': case 'migration': return riskFocusReport(focus);
      default: return 'reviews/proof-review/';
    }
  }
  switch (role) {
    case 'security_reviewer': return 'security/';
    case 'qa': return kind === 'gate' ? (focus === 'visual' ? 'reviews/visual-proof/' : 'QA_REPORT.md') : 'QA_PLAN.md reports/ reviews/test-trust/qa/';
    case 'verifier': return 'VERIFY.md design/SYNC.md';
    case 'implementer': return 'reports/ worker-evidence/';
    case 'task_author': return 'TASK.md design/INTENT.md reports/';
    case 'explorer': return 'reports/';
    case 'architect': case 'data_architect': case 'designer': return 'design/ reports/';
    default: return 'reports/ TASK.md PLAN.md EVIDENCE.md';
  }
}

/** `artifact_allowed ROLE KIND FOCUS PATH` @param {string} role @param {string} kind @param {string} focus @param {string} p */
export function artifactAllowed(role, kind, focus, p) {
  if (p.startsWith('reports/snapshots/')) return true;
  for (const t of artifactPaths(role, kind, focus).split(/[ \t\n]+/).filter((x) => x !== '')) {
    if (t.endsWith('/')) { if (p.startsWith(t)) return true; } else if (p === t) return true;
  }
  return false;
}

/** `canon_rel PATH`: "/./" and "//" collapsed, a leading "./" dropped. @param {string} p0 */
export function canonRel(p0) {
  let p = p0;
  for (;;) {
    const q = p.replace(/\/+/g, '/').replace(/\/\.\//g, '/').replace(/^\.\//, '').replace(/\/\.$/, '');
    if (q === p) return p;
    p = q;
  }
}

/**
 * `normalize_artifact ID PATH`: the run-relative path of an existing regular file inside the run (any spelling), code 1 for a path outside the run,
 * code 2 for a file that is not there (or is a link).
 * @param {Context} ctx @param {string} id @param {string} p0 @returns {{ path: string } | { code: 1 | 2 }}
 */
export function normalizeArtifact(ctx, id, p0) {
  const d = runDir(ctx, id);
  let p = p0;
  if (p.startsWith(`${d}/`)) p = p.slice(d.length + 1);
  else if (p.startsWith(`.agents/runs/${id}/`)) p = p.slice(`.agents/runs/${id}/`.length);
  else if (p.startsWith(`./.agents/runs/${id}/`)) p = p.slice(`./.agents/runs/${id}/`.length);
  else if (p.startsWith('./')) p = p.slice(2);
  if (p === '' || notRunRelative(p)) return { code: 1 };
  p = canonRel(p);
  if (p === '' || notRunRelative(p)) return { code: 1 };
  try {
    const st = lstatSync(`${d}/${p}`);
    if (!st.isFile()) return { code: 2 };
  } catch { return { code: 2 }; }
  return { path: p };
}

/** `[ -f F ] && [ ! -L F ]` @param {string} f */
export function plainFile(f) { try { return lstatSync(f).isFile(); } catch { return false; } }

/** `realpath`, null when the path does not exist. @param {string} p */
export function realOf(p) { try { return realpathPosix(p); } catch { return null; } }

// ---- header and findings ---------------------------------------------------------------------------------------------------------

const HEADER_KEYS = new Set(['ROLE', 'TASK', 'FOCUS', 'RESULT', 'CONFIDENCE', 'FINGERPRINT', 'ARTIFACT']);

/**
 * `parse_header`: the leading KEY: value block (blank lines before it skipped, ended by the first other line); null for an unknown or repeated key.
 * @param {string} raw @returns {Map<string, string> | null}
 */
export function parseHeader(raw) {
  /** @type {Map<string, string>} */ const out = new Map();
  let started = false;
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const l of lines) {
    if (!started && new RegExp(`^${WSC}*$`).test(l)) continue;
    started = true;
    const m = /^([A-Z_]+):/.exec(l);
    if (!m) break;
    const k = m[1];
    if (!HEADER_KEYS.has(k) || out.has(k)) return null;
    out.set(k, l.replace(new RegExp(`^[A-Z_]+:${WSC}*`), '').replace(new RegExp(`${WSC}+$`), ''));
  }
  return out;
}

/** `awk` field trim @param {string} s */
const trim = (s) => s.replace(new RegExp(`^${WSC}+`), '').replace(new RegExp(`${WSC}+$`), '');

/** `parse_findings`: "id|severity|path:line|finding|evidence" rows, or the markers MALFORMED and NO_FINDINGS_PLACEHOLDER. @param {string} raw @returns {string[]} */
export function parseFindings(raw) {
  /** @type {string[]} */ const out = [];
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const l of lines) {
    if (!l.startsWith('|')) continue;
    if (new RegExp(`^\\|[-:| ]+\\|?${WSC}*$`).test(l)) continue;
    const f = l.split('|');
    const id = trim(f[1] ?? '');
    if (id === 'id' || id === '') continue;
    const low = asciiLower(id);
    if (low === '(none)' || low === 'none' || low === '-' || low === 'n/a') { out.push('NO_FINDINGS_PLACEHOLDER'); continue; }
    if (f.length < 7) { out.push('MALFORMED'); continue; }
    out.push(`${id}|${trim(f[2])}|${trim(f[3])}|${trim(f[4])}|${trim(f[5])}`);
  }
  return out;
}

/** The text after the first `KEY:` line head (the key and the blanks after it stripped). @param {string} raw @param {string} key */
export function lineValue(raw, key) {
  const re = new RegExp(`^${key}:${WSC}*`);
  for (const l of raw.split('\n')) if (re.test(l)) return l.replace(re, '');
  return '';
}

// ---- UNSUPPORTED reasons ---------------------------------------------------------------------------------------------------------

/** `unsupported_blocks REASON`: `risk.unsupported: block`, or an INCONCLUSIVE measurement, blocks. @param {Context} ctx @param {string} reason */
export function unsupportedBlocks(ctx, reason) {
  if (ctx.config().get('risk.unsupported', 'report') === 'block') return true;
  return reason.split('\n').some((l) => /^[A-Za-z0-9_ -]*INCONCLUSIVE:/.test(l));
}

const REASON_RE = /INCONCLUSIVE:|[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_.-]{2,}|[A-Za-z0-9_-]\.(json|ya?ml|proto|graphqls?|gql|avsc|sql|js|mjs|ts|py|go|rb|java|sh|toml|lock|html?)([^A-Za-z]|$)|tool|parser|parse|benchmark|browser|chromium|chrome|database|schema|snapshot|contract|command|install|binary|runtime|driver|harness|format|capabilit|openapi|asyncapi|graphql|protobuf|machine-readable|migration|seed row|fixture|server|interception|threshold|library|package|test suite|temp-db|temporary|throwaway|node/i;

/** `unsupported_reason_ok REASON` (A98) @param {string} reason */
export function unsupportedReasonOk(reason) {
  return Buffer.byteLength(reason, 'latin1') >= 12 && reason.split('\n').some((l) => REASON_RE.test(l));
}

// ---- cited evidence --------------------------------------------------------------------------------------------------------------

/**
 * `evidence_cite_check ID ROLE FOCUS PATH [SHA]` (A107): `{ ok: "<path> <sha256>" }`, or `{ err: text }`.
 * @param {Context} ctx @param {string} id @param {string} role @param {string} focus @param {string} p0 @param {string} sha
 */
export function evidenceCiteCheck(ctx, id, role, focus, p0, sha) {
  const d = runDir(ctx, id);
  let p = p0;
  if (p.startsWith(`.agents/runs/${id}/`)) p = p.slice(`.agents/runs/${id}/`.length);
  if (p === '' || notRunRelative(p)) return { err: `cited evidence path must be run-relative: ${p0} (A107)` };
  if (!plainFile(`${d}/${p}`)) return { err: `cited evidence file not found in the run: ${p} (A107)` };
  const real = realOf(`${d}/${p}`); const runReal = realOf(d);
  if (real === null || runReal === null || inside(runReal, real) === null) return { err: `cited evidence file must be inside the run: ${p} (A107)` };
  if (!(p.startsWith('reports/') || p.startsWith('worker-evidence/'))) {
    if (!(artifactAllowed(role, 'gate', focus, p) || artifactAllowed(role, 'task', focus, p))) {
      return { err: `cited evidence file ${p} is outside the folders ${role}${focus !== '' ? ` (FOCUS ${focus})` : ''} reports in: ${artifactPaths(role, 'gate', focus)} reports/ worker-evidence/ (A107)` };
    }
  }
  const h = hashFile(`${d}/${p}`);
  if (sha !== '' && h !== sha) return { err: `cited evidence file ${p} was modified after it was hashed: cited sha256 ${sha.slice(0, 12)}, the file is ${h.slice(0, 12)} (A107)` };
  return { ok: `${p} ${h}` };
}

// ---- skill validators ------------------------------------------------------------------------------------------------------------

/** `node SCRIPT ARGS` with stdout and stderr merged. @param {Context} ctx @param {string[]} args @returns {{ status: number, text: string }} */
function nodeRun(ctx, args) {
  const r = proc.run(process.execPath, args, { cwd: ctx.root, env: ctx.childEnv(), input: '', stdio: ['pipe', 'pipe', 'pipe'] });
  return { status: r.status, text: r.stdout.toString('latin1') + r.stderr.toString('latin1') };
}

/** @param {string} s */
const oneLineText = (s) => s.replace(/\n/g, ' ');

/**
 * `skill_validator ID ROLE FOCUS ARTIFACT` (A107): the validator of the skill behind a role and focus, run by the control plane. `{ text, rc }`:
 * "PASS|FAIL script", "NOSKILL skill", "UNRUN why", '' when no validator is mapped; rc 1 when the validator rejects the report.
 * @param {Context} ctx @param {string} id @param {string} role @param {string} focus @param {string} artifact
 */
export function skillValidator(ctx, id, role, focus, artifact) {
  const d = runDir(ctx, id);
  const root = ctx.root;
  let k;
  if (role === 'verifier') k = 'verify-proof';
  else if (role === 'reviewer' && focus === 'tests') k = 'test-trust';
  else if (role === 'reviewer' && (focus === 'plan' || focus === 'rules' || focus === 'rules+tests')) k = 'proof-review';
  else return { text: '', rc: 0 };
  if (!isDirectory(`${root}/.agents/skills/${k}`)) return { text: `NOSKILL ${k}`, rc: 0 };
  if (role === 'verifier') {
    const s = `${root}/.agents/skills/verify-proof/scripts/validate-verify.mjs`;
    if (!plainOrLinkFile(s)) return { text: `UNRUN ${s} is missing`, rc: 0 };
    const a = [];
    if (plainOrLinkFile(`${d}/TASK.md`)) a.push('--task', `${d}/TASK.md`);
    if (plainOrLinkFile(`${d}/PLAN.md`)) a.push('--plan', `${d}/PLAN.md`);
    const r = nodeRun(ctx, [s, `${d}/${artifact}`, ...a]);
    if (r.status !== 0) return { text: `validate-verify.mjs rejects ${artifact}: ${oneLineText(r.text.replace(/\n+$/, ''))}`, rc: 1 };
    const verdicts = (fileText(ctx, `${d}/${artifact}`) ?? '').split('\n').map((l) => new RegExp(`^Verdict:${WSC}*([A-Z]*)${WSC}*$`).exec(l)).filter((m) => m !== null);
    const v = verdicts.length > 0 ? /** @type {RegExpExecArray} */ (verdicts[verdicts.length - 1])[1] : '';
    return { text: `${v === 'PASS' ? 'PASS' : 'FAIL'} verify-proof/scripts/validate-verify.mjs`, rc: 0 };
  }
  if (role === 'reviewer' && focus === 'tests') {
    const s = `${root}/.agents/skills/test-trust/scripts/gate.mjs`; const f = `${d}/reviews/test-trust/tests/findings.json`;
    if (!(plainOrLinkFile(s) && plainOrLinkFile(f))) return { text: 'UNRUN reviews/test-trust/tests/findings.json or the test-trust gate script is missing', rc: 0 };
    return { text: `${nodeRun(ctx, [s, 'gate', f]).status === 0 ? 'PASS' : 'FAIL'} test-trust/scripts/gate.mjs`, rc: 0 };
  }
  const sub = focus === 'plan' ? 'plan' : focus === 'rules' ? 'rules' : 'small';
  const f = `${d}/reviews/proof-review/${sub}/findings.json`;
  const v = `${root}/.agents/skills/proof-review/scripts/validate-findings.mjs`; const s = `${root}/.agents/skills/proof-review/scripts/gate.mjs`;
  if (!(plainOrLinkFile(f) && plainOrLinkFile(v) && plainOrLinkFile(s))) return { text: `UNRUN reviews/proof-review/${sub}/findings.json or the proof-review scripts are missing`, rc: 0 };
  const o = nodeRun(ctx, [v, f]);
  if (o.status !== 0) return { text: `validate-findings.mjs rejects reviews/proof-review/${sub}/findings.json: ${oneLineText(o.text.replace(/\n+$/, ''))}`, rc: 1 };
  return { text: `${nodeRun(ctx, [s, f]).status === 0 ? 'PASS' : 'FAIL'} proof-review/scripts/gate.mjs`, rc: 0 };
}

/** @param {string} f */
function isDirectory(f) { try { return statSync(f).isDirectory(); } catch { return false; } }
/** `[ -f F ]` (follows links) @param {string} f */
function plainOrLinkFile(f) { try { return statSync(f).isFile(); } catch { return false; } }

// ---- reproduced evidence ---------------------------------------------------------------------------------------------------------

/** `repro_normalize` over one line. @param {string} line */
export function reproNormalizeLine(line) { let s = line; for (const [re, to] of NORMALIZE) s = s.replace(re, /** @type {string} */ (to)); return s; }

/** `reproduce_allowed ID`: the commands the control plane may run again (A107). @param {Context} ctx @param {string} id */
export function reproduceAllowed(ctx, id) {
  /** @type {string[]} */ const out = [];
  for (const k of ['build', 'test', 'lint']) for (const c of ctx.config().cmds(`commands.${k}`)) if (c !== '') out.push(c);
  const dir = runDir(ctx, id);
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (plan === null) return out;
  const frozen = sectionValue(ctx, dir, 'freeze', 'plan_sha256');
  if (!/^[0-9a-f]{64}$/.test(frozen)) return out;
  if (hashFile(`${dir}/PLAN.md`) !== frozen) return out;
  let inside = false;
  for (const l of textLines(plan)) {
    if (new RegExp(`^## Verification commands${WSC}*$`).test(l)) { inside = true; continue; }
    if (l.startsWith('## ')) inside = false;
    if (!inside) continue;
    const m = /^[^`]*`([^`]+)`/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

const VOLATILE = /[0-9]([ \t\n\v\f\r]*(ms|us|s|sec|secs|seconds|m|min|mins|minutes))([^A-Za-z]|$)|[0-9]{1,2}:[0-9]{2}|[0-9]{4}-[0-9]{2}-[0-9]{2}|pid[ =:]*[0-9]+|0x[0-9a-f]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
const US = '\x1f';

/**
 * `reproduce_recheck ID ROLE REPORT EVLINES REQUIRED` (A107, A200): re-runs the recorded reproduced items of the verifier's VERIFY.md `## Commands` and
 * of cited evidence files; one problem line per item that does not match. `n` is the number of re-runs.
 * @param {Context} ctx @param {string} id @param {string} role @param {string} reportFile @param {string[]} evlines @param {boolean} required
 * @returns {{ problems: string[], n: number }}
 */
export function reproduceRecheck(ctx, id, role, reportFile, evlines, required) {
  /** @type {string[]} */ const items = [];
  if (role === 'verifier' && plainOrLinkFile(reportFile)) {
    const lines = textLines(fileText(ctx, reportFile) ?? '');
    /** @type {string[]} */ const cmd = []; /** @type {string[]} */ const ex = []; /** @type {string[]} */ const out = [];
    /** @type {Set<string>} */ const ac = new Set();
    let sec = ''; let cur = 0;
    for (const l of lines) {
      if (l.startsWith('## ')) { sec = l; continue; }
      if (new RegExp(`^## Commands${WSC}*$`).test(sec)) {
        const m = /^- `([^`]+)` \| exit=([0-9]+)/.exec(l);
        if (m) { cmd.push(m[1]); ex.push(m[2]); out.push(''); cur = cmd.length; continue; }
        if (l.startsWith('  output: ') && cur > 0 && out[cur - 1] === '') out[cur - 1] = l.slice('  output: '.length);
      }
      if (new RegExp(`^## AC coverage${WSC}*$`).test(sec) && l.startsWith('|')) {
        const f = l.split('|');
        if (/AC-[0-9]+/.test(f[1] ?? '') && (f[2] ?? '').includes('command: `')) {
          const t = (f[2] ?? '').replace(/^[^`]*`/, '').replace(/`[^]*$/, '');
          if (t !== '') ac.add(t);
        }
      }
    }
    const seen = new Set();
    for (let i = 0; i < cmd.length; i++) { items.push(`${cmd[i]}${US}${ex[i]}${US}${out[i]}${US}${ac.has(cmd[i]) ? 1 : 0}`); seen.add(cmd[i]); }
    for (const c of ac) if (!seen.has(c)) items.push(`${c}${US}-${US}${US}1`);
  }
  for (const ev of evlines) {
    const ep = ev.split(' ')[0];
    if (ep === '' || !plainOrLinkFile(`${runDir(ctx, id)}/${ep}`)) continue;
    let c = ''; let e = ''; let o = ''; let n = 0;
    const flush = () => { if (c !== '' && n < 3) { items.push(`${c}${US}${e === '' ? '0' : e}${US}${o}${US}0`); n++; } c = ''; e = ''; o = ''; };
    for (const l of textLines(fileText(ctx, `${runDir(ctx, id)}/${ep}`) ?? '')) {
      if (l.startsWith('command:')) { flush(); c = l.replace(new RegExp(`^command:${WSC}*`), ''); }
      if (l.startsWith('exit:')) e = l.replace(new RegExp(`^exit:${WSC}*`), '');
      if (l.startsWith('output:')) o = l.replace(new RegExp(`^output:${WSC}*`), '');
    }
    flush();
  }
  if (items.length === 0) {
    return { problems: required ? ['no re-runnable reproduced evidence: the result records no command with an exit status to run again'] : [], n: 0 };
  }
  const allowed = new Set(reproduceAllowed(ctx, id));
  let n = 0; let x = 0; let pb = 0;
  /** @type {string[]} */ const problems = [];
  const secs = verifyCommandTimeout(ctx.config());
  for (const it of [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [c, e, o0, a] = it.split(US);
    const cd = c.replace(/\|/g, '/');
    if (!allowed.has(c)) {
      if (a === '1') { pb++; problems.push(`AC proof cites \`${cd}\`, which is neither a configured build, test or lint command nor an entry of the frozen PLAN.md Verification commands, so it cannot be re-run`); }
      continue;
    }
    if (a !== '1') { if (x >= 3) continue; x++; }
    if (e === '-') { pb++; problems.push(`AC proof cites \`${cd}\` but VERIFY.md records no Commands entry with an exit status for it: nothing to compare`); continue; }
    let o = o0 === '(no output)' ? '' : o0;
    o = reproNormalizeLine(o);
    if (o !== '' && VOLATILE.test(o)) {
      pb++; problems.push(`the recorded output line of \`${cd}\` ("${o.replace(/\|/g, '/')}") holds a time, duration, date, pid or random value: record one stable summary line that is identical on every run (for example the pass and fail counts), or \`(no output)\` for a silent command`);
      continue;
    }
    n++;
    // the recorded command is the user's own string (runUserCommand), standard error merged into the output, stopped by Node's timer at the limit (124, as `timeout` said; its group is killed whole)
    const dir = mkdtempSync(path.join(tmpdir(), 'proofline-rerun-'));
    const fd = openSync(`${dir}/out`, 'w');
    /** @type {{ status: number, timedOut?: boolean }} */ let r;
    try { r = proc.runUserCommand(c, { cwd: ctx.root, env: ctx.childEnv(), input: '', stdio: ['pipe', fd, fd], timeoutMs: secs * 1000, group: true }); } finally { closeSync(fd); }
    const outText = readFileSync(`${dir}/out`, 'latin1');
    rmSync(dir, { recursive: true, force: true });
    const rc = r.timedOut === true ? 124 : r.status;
    if (String(rc) !== e) {
      pb++;
      problems.push(`re-running \`${cd}\` gave exit=${rc}, the report records exit=${e} (reproduced evidence does not reproduce)${rc === 124 ? `; it hit the time limit of ${secs} s (verification.command_timeout_seconds times timeouts.scale), which is a failure, never a pass: raise the limit or run proofline doctor --scale` : ''}`);
    } else if (o === '') {
      if (/[^ \t\n\v\f\r]/.test(outText)) { pb++; problems.push(`re-running \`${cd}\` printed output but the report records none (\`(no output)\` is for a silent command; record one stable summary line)`); }
    } else {
      const want = o.replace(/^[ \t]+/, '').replace(/[ \t\r]+$/, '');
      const lines = outText.split('\n').map((l) => reproNormalizeLine(l));
      const found = lines.some((l) => l.replace(/^[ \t]+/, '').replace(/[ \t\r]+$/, '') === want);
      if (!found) { pb++; problems.push(`re-running \`${cd}\` gave exit=${rc} but no output line equal to the recorded "${o.replace(/\|/g, '/')}" (reproduced evidence does not reproduce)`); }
    }
  }
  if (n === 0 && pb === 0 && required) problems.push('no recorded reproduced command could be re-run: none is a configured build, test or lint command or an entry of the frozen PLAN.md Verification commands');
  return { problems, n };
}

// ---- the evidence of an UNSUPPORTED result ---------------------------------------------------------------------------------------

/** `base_moved_predecessors ID BASE` (A161) @param {Context} ctx @param {string} id @param {string} base */
function baseMovedPredecessors(ctx, id, base) {
  /** @type {string[]} */ const out = [];
  const bm = baseMovedLines(ctx, runDir(ctx, id));
  let cur = base;
  for (let n = 0; n < 100 && cur !== ''; n++) {
    const re = new RegExp(`event=base-moved role=[^ ]* from=[^ ]* to=[^ ]* digest=[^ ]* ts=[^ ]* epoch=[^ ]* detail=base_sha moved \\(([0-9a-f]{7,40}) -> ${cur}[0-9a-f]*\\)`);
    let old = '';
    for (const l of bm) { const m = re.exec(l); if (m) old = m[1]; }
    if (old === '') break;
    out.push(old); cur = old;
  }
  return out;
}

/**
 * `unsupported_evidence_check ID ROLE FOCUS RAW` (A102): `{ ok: "<path> <sha256>" }` or `{ err: text }`.
 * @param {Context} ctx @param {string} id @param {string} role @param {string} focus @param {string} raw
 */
export function unsupportedEvidenceCheck(ctx, id, role, focus, raw) {
  const d = runDir(ctx, id);
  const line = lineValue(raw, 'UNSUPPORTED_EVIDENCE');
  const sp = line.lastIndexOf(' ');
  let p = sp < 0 ? line : line.slice(0, sp);
  const sha = line.slice(sp + 1);
  if (sp < 0) return { err: "UNSUPPORTED_EVIDENCE needs '<run-relative path> <sha256>'" };
  if (p.startsWith(`.agents/runs/${id}/`)) p = p.slice(`.agents/runs/${id}/`.length);
  if (p === '' || notRunRelative(p)) return { err: `UNSUPPORTED_EVIDENCE path must be run-relative: ${p}` };
  if (!plainFile(`${d}/${p}`)) return { err: `UNSUPPORTED_EVIDENCE not found in the run: ${p}` };
  const real = realOf(`${d}/${p}`); const runReal = realOf(d);
  if (real === null || runReal === null || inside(runReal, real) === null) return { err: `UNSUPPORTED_EVIDENCE must be inside the run: ${p}` };
  const dir = riskFocusReport(focus);
  const esc = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!(p.startsWith(dir) || new RegExp(`^reports/snapshots/.{12}-${esc}-`).test(p) || new RegExp(`^reports/[0-9]{3}-${esc}`).test(p))) {
    return { err: `UNSUPPORTED_EVIDENCE must be the ${role} role's own file (${dir}, its reports/snapshots/<sha12>-${role}-... snapshot or reports/<NNN>-${role}...): ${p}` };
  }
  if (hashFile(`${d}/${p}`) !== sha) return { err: `UNSUPPORTED_EVIDENCE sha256 mismatch for ${p} (edited after it was cited)` };
  const text = fileText(ctx, `${d}/${p}`) ?? '';
  const rows = text.split('\n');
  const rx = focus === 'visual' ? 'UNSUPPORTED|INCONCLUSIVE' : 'UNSUPPORTED';
  if (!rows.some((l) => new RegExp(`^RESULT:${WSC}*(${rx})${WSC}*$`, 'i').test(l))) {
    return { err: `UNSUPPORTED_EVIDENCE ${p} does not hold the validator's 'RESULT: UNSUPPORTED' line: save the ${focus} validator's own output there (A102)` };
  }
  const reason = lineValue(raw, 'UNSUPPORTED_REASON');
  const inc = rows.some((l) => new RegExp(`^RESULT:${WSC}*INCONCLUSIVE${WSC}*$`, 'i').test(l)) || rows.some((l) => new RegExp(`^reason:${WSC}*${focus} INCONCLUSIVE:`, 'i').test(l));
  if (inc) {
    if (!reason.startsWith(`${focus} INCONCLUSIVE:`)) return { err: `UNSUPPORTED_REASON must start '${focus} INCONCLUSIVE:': ${p} records an INCONCLUSIVE measurement, which stays blocking (A98, A102)` };
  } else if (/^[A-Za-z0-9_ -]*INCONCLUSIVE:/.test(reason)) {
    return { err: `UNSUPPORTED_REASON claims an INCONCLUSIVE measurement, but ${p} records UNSUPPORTED (A102)` };
  }
  let cap = '';
  if (!inc) { if (focus === 'visual') cap = probeVisual(ctx); else if (focus === 'performance') cap = probePerformance(ctx); }
  if (cap !== '') return { err: `UNSUPPORTED refused: capability present: ${cap}; run ${focus}-proof and submit PASS/FAIL (or a measured INCONCLUSIVE); if it cannot exercise this change, submit BLOCKED with the reason for the user (A102)` };
  const bm = rows.map((l) => new RegExp(`^BASE:${WSC}*([0-9a-f]{7,40})${WSC}*$`).exec(l)).find((m) => m !== null);
  const ub = bm ? bm[1] : '';
  if (ub !== '') {
    const rb = sectionValue(ctx, d, 'repository', 'base_sha');
    let ok = false;
    for (const x of [rb, ...baseMovedPredecessors(ctx, id, rb)]) { if (x !== '' || ub === '') { if (x.startsWith(ub)) { ok = true; break; } } }
    if (!ok) return { err: `UNSUPPORTED_EVIDENCE ${p} was produced against base ${ub}, not the run's base ${rb === '' ? 'unknown' : rb} (nor a base before an accepted control-plane-only move)` };
  }
  if (focus === 'contract') {
    const files = [...new Set(riskSignals(ctx, d).filter((s) => s.name === 'contract_file' && s.source === 'diff').map((s) => s.path))].sort();
    for (const c of files) {
      if (!rows.some((l) => l === `FILE: compared ${c}` || l === `FILE: unsupported ${c}`)) return { err: `UNSUPPORTED refused: ${c} is a contract file this run changed (risk signal contract_file) and ${p} does not list it as compared or unsupported; run the differ over it (--path ${c}) and submit its result (A102)` };
    }
    if (rows.some((l) => l.startsWith('FILE: ')) && !rows.some((l) => l.startsWith('FILE: unsupported '))) return { err: `UNSUPPORTED refused: ${p} lists every contract file as compared; the result is PASS or FAIL (A102)` };
  } else if (focus === 'migration') {
    if (rows.some((l) => l.startsWith('WARN no --repo'))) return { err: `UNSUPPORTED_EVIDENCE ${p} is validate-migration output without --repo; re-run it with --repo <repo> (A102)` };
    const files = [...new Set(riskSignals(ctx, d).filter((s) => s.name === 'migration' && s.source === 'diff' && s.path.endsWith('.sql')).map((s) => s.path))].sort();
    for (const c of files) {
      if (!rows.includes(`FILE: unsupported ${c}`)) return { err: `UNSUPPORTED refused: the changed migration ${c} is not listed 'FILE: unsupported ${c}' in ${p}; cite it in the report's ## Migrations and re-run validate-migration.mjs --repo (A102)` };
    }
  }
  return { ok: `${p} ${sha}` };
}

// ---- classification flip (A171) --------------------------------------------------------------------------------------------------

/**
 * `classification_flip ID GATE FOCUS FINGERPRINT ROWS`: the first row whose key an earlier record of the same gate and focus under the same rule version
 * classified the other way; the text, or '' when none.
 * @param {Context} ctx @param {string} id @param {string} gate @param {string} focus @param {string} fp @param {string[]} rows
 */
export function classificationFlip(ctx, id, gate, focus, fp, rows) {
  const dir = runDir(ctx, id);
  const ro = lastReopenSeq(ctx, dir, 'any');
  for (const n of gateNames(ctx, dir)) {
    const f = `${dir}/gates/${n}`;
    if (gateField(ctx, f, 'gate') !== gate || gateField(ctx, f, 'focus') !== focus) continue;
    if (!(Number(gateField(ctx, f, 'seq')) > ro)) continue;
    if (gateField(ctx, f, 'blocking_rule') !== BLOCKING_RULE_VERSION) continue;
    const pfp = gateField(ctx, f, 'fingerprint');
    /** @type {Map<string, string>} */ const old = new Map();
    for (const l of textLines(fileText(ctx, f) ?? '')) {
      if (!l.startsWith('finding: ')) continue;
      const c = l.slice('finding: '.length).split('|');
      const s = c[1] ?? ''; const loc = c[2] ?? ''; const x = c[3] ?? '';
      if (s !== 'info' && s !== 'blocking') continue;
      if ((x + loc).startsWith('UNSUPPORTED') || (x + loc).includes('risk signal ')) continue;
      const k = findingKey(ctx, pfp, loc, x);
      if (!old.has(k)) old.set(k, s);
    }
    if (old.size === 0) continue;
    for (const row of rows) {
      const c = row.split('|');
      const s = c[1] ?? ''; const loc = c[2] ?? ''; const x = c[3] ?? '';
      if (s !== 'info' && s !== 'blocking') continue;
      const was = old.get(findingKey(ctx, fp, loc, x));
      if (was !== undefined && was !== s) return `${c[0]} (${loc}) is ${s}, and was ${was} in ${n}`;
    }
  }
  return '';
}

// ---- metrics ---------------------------------------------------------------------------------------------------------------------

/** `latest_decision ID ROLE [FOCUS]` @param {Context} ctx @param {string} id @param {string} role @param {string} focus */
function latestDecision(ctx, id, role, focus) {
  const tag = focus === '' ? role : `${role}-${focus.replace(/\+/g, '-')}`;
  let hit = '';
  for (const f of listNames(`${runDir(ctx, id)}/decisions`, /^[0-9]{3}-.*\.decision$/)) if (f.slice(3) === `-${tag}.decision`) hit = `${runDir(ctx, id)}/decisions/${f}`;
  return hit;
}

/**
 * `metrics_step ID ROLE FOCUS OUTCOME`: the per-step records (history line and JSON record). `stepAgent` is the dispatch token of this submission
 * (PROOFLINE_STEP_AGENT); the dispatch start and runtime come from the environment dispatch.sh sets.
 * @param {Context} ctx @param {string} id @param {string} role @param {string} focus @param {string} outcome @param {string} stepAgent @param {string} [platform] for the tests (which paths count as absolute)
 */
export function metricsStep(ctx, id, role, focus, outcome, stepAgent, platform = process.platform) {
  const decision = latestDecision(ctx, id, role, focus);
  let rt = '-'; let model = '-'; let dur = '-';
  if (decision !== '') {
    const text = readFileSync(decision, 'latin1');
    const get = (/** @type {string} */ k) => { for (const l of text.split('\n')) if (l.startsWith(`${k}=`)) return l.slice(k.length + 1); return ''; };
    rt = get('runtime'); model = get('model');
    const at = get('decided_at');
    if (at !== '') dur = String(now().epoch - Number(at));
  } else {
    const t = configuredRuntime(ctx, role);
    rt = t === '' ? '-' : t;
  }
  let st = '';
  const ds = ctx.env.PROOFLINE_DISPATCH_START ?? '';
  if (/^[0-9]+$/.test(ds)) st = ds;
  const dr = ctx.env.PROOFLINE_DISPATCH_RUNTIME ?? '';
  if (dr !== '' && /^[A-Za-z0-9._+:-]*$/.test(dr)) rt = dr;
  const started = stepAgent !== '' && /^[A-Za-z0-9_.-]+$/.test(stepAgent) ? fileLinesOrEmpty(`${ctx.agents}/local/submissions/${stepAgent}.started`) : [];
  if (st === '' && started.length >= 2 && /^[0-9]+$/.test(started[1])) st = started[1];
  if (st !== '') { const d = now().epoch - Number(st); if (d >= 0) dur = String(d); }
  metricsLine(ctx, [id, role, rt === '' ? '-' : rt, model === '' ? '-' : model, dur, outcome]);
  let tin = '-'; let tout = '-'; let ttot = '-';
  const tp = started.length >= 1 ? started[0] : '';
  if (isLocalAbsolute(tp, platform) && /^.*\.jsonl$/.test(tp) && plainOrLinkFile(tp) && rt === 'claude') {
    /** @type {Map<string, [number, number]>} */ const per = new Map();
    for (const l of readFileSync(tp, 'latin1').split('\n')) {
      if (!l.includes('"role":"assistant"')) continue;
      const m = /"id":"msg_[A-Za-z0-9_]+"/.exec(l);
      if (!m) continue;
      let u = l.replace(/^[^]*"usage":\{/, '');
      u = u.slice(0, 400);
      const num = (/** @type {string} */ k) => { const mm = new RegExp(`"${k}":([0-9]+)`).exec(u); return mm ? Number(mm[1]) : 0; };
      per.set(m[0], [num('input_tokens') + num('cache_creation_input_tokens'), num('output_tokens')]);
    }
    if (per.size > 0) { let a = 0; let b = 0; for (const [i, o] of per.values()) { a += i; b += o; } tin = String(a); tout = String(b); ttot = String(a + b); }
  }
  metricsJson(ctx, ['step', id, role, focus, gateOf(ctx, role, focus, id), rt === '' ? '-' : rt, model === '' ? '-' : model, dur, tin, tout, ttot, '-', '-', '-', '-', outcome]);
  // A235: the tool calls and result bytes of the same session log, in a file of their own (records.jsonl keeps its format)
  // A255: a Codex worker has no `.started` file; its rollout log is found by the session id in its environment
  const cx = rt === 'codex' ? findCodexRollout(ctx.env, now().epoch) : { file: '', reason: null };
  toolsRecord(ctx, { task: id, role, focus, gate: gateOf(ctx, role, focus, id), runtime: rt, log: rt === 'codex' ? cx.file : isLocalAbsolute(tp, platform) && /^.*\.jsonl$/.test(tp) && plainOrLinkFile(tp) && rt === 'claude' ? tp : '', reason: cx.reason });
}

/** @param {string} f */
function fileLinesOrEmpty(f) { try { return readFileSync(f, 'latin1').split('\n'); } catch { return []; } }
