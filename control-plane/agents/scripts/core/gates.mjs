// @ts-check
// Gate records and their evaluation (agent.sh 3279-3640, 3700-3850, 3915-4020): which gates a run requires, the state of each gate
// (pass, pass_low, waived, fail, stale, missing, unsupported) and of each risk focus, selective repetition, fix rounds, the task-owned
// patch fingerprint, mutation ownership and `verify-gates`. Read-only.
// Two states stay with the shell until the stages that move their writers: a known-issues list (LIST.tsv) or an approved batch summary
// that could accept a finding, and a persistent waiver key; reaching one throws BridgeToShell before any output.
import { readdirSync, statSync } from 'node:fs';
import { BridgeToShell, fail } from './errors.mjs';
import { baselineFingerprint, gateFingerprint, legacyFingerprintMatch, pathFingerprint } from './fingerprint.mjs';
import { catFile, git, objectExists, sortUnique, trackedPaths, untrackedPaths } from './git.mjs';
import { sha256 } from './hash.mjs';
import { boundNames, listNames, verifySeal } from './ledger.mjs';
import { isFile } from './paths.mjs';
import { authorizedPath, fileLines, fileText, gateField, gatesEnforced, planScope, planSectionPresent, sectionValue, textLines } from './records.mjs';
import { knownControlArtifact, runDir } from './runs.mjs';
import { pathMatches } from './scope.mjs';
import { ecosystemSets, pipelineClassValid, pipelineClass, pipelineDeclared, pipelineNeeds, riskGateFocuses, riskNames, riskPaths, tierEffective } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const GATE_FILE = /^[0-9]{3}-(SECRETS|REVIEW_SMALL|REVIEW_PLAN|REVIEW_RULES|REVIEW_TESTS|REVIEW_DATA|SECURITY|QA|VERIFY|REOPEN)\.yaml$/;

/** `gates_dir ID` @param {string} dir */
export function gatesDir(dir) { return `${dir}/gates`; }
export { gatesDir as gatesDirOf };

/** `gate_owner GATE` @param {string} g */
export function gateOwner(g) {
  if (g.startsWith('REVIEW_')) return 'reviewer';
  return g === 'SECURITY' ? 'security_reviewer' : g === 'QA' ? 'qa' : g === 'VERIFY' ? 'verifier' : g === 'SECRETS' ? 'secret-scan' : '';
}

/** `gate_focus GATE` @param {string} g */
export function gateFocus(g) {
  switch (g) {
    case 'REVIEW_SMALL': return 'rules+tests'; case 'REVIEW_PLAN': return 'plan'; case 'REVIEW_RULES': return 'rules';
    case 'REVIEW_TESTS': return 'tests'; case 'REVIEW_DATA': return 'data'; default: return '';
  }
}

/** `gate_names ID`: the gate record files bound in the ledger chain by the command that wrote them, sorted. @param {Context} ctx @param {string} dir @returns {string[]} */
export function gateNames(ctx, dir) {
  return ctx.once(`gates:names:${dir}`, () => {
    const all = listNames(gatesDir(dir), GATE_FILE);
    return boundNames(ctx, dir, 'gates', '(gate:|REOPEN$)', all).sort();
  });
}

/** @param {Context} ctx @param {string} dir @param {string} name */
const gf = (ctx, dir, name) => `${gatesDir(dir)}/${name}`;

/** `last_reopen_seq ID [any|terminal]` @param {Context} ctx @param {string} dir @param {string} [mode] */
export function lastReopenSeq(ctx, dir, mode = 'amend') {
  let n = '0';
  for (const f of gateNames(ctx, dir)) {
    if (!f.endsWith('-REOPEN.yaml')) continue;
    const t = gateField(ctx, gf(ctx, dir, f), 'reopened_from');
    const ok = (mode === 'amend' && t === '') || mode === 'any' || (mode === 'terminal' && t !== '');
    if (!ok) continue;
    n = gateField(ctx, gf(ctx, dir, f), 'seq');
  }
  return n === '' ? 0 : Number(n);
}

/** `gate_latest_file ID GATE [FOCUS]` @param {Context} ctx @param {string} dir @param {string} gate @param {string} [focus] */
export function gateLatestFile(ctx, dir, gate, focus) {
  const reopen = lastReopenSeq(ctx, dir);
  let fc = focus ?? '';
  if (fc === '-') fc = gateFocus(gate);
  let last = '';
  for (const n of gateNames(ctx, dir)) {
    const f = gf(ctx, dir, n);
    if (gateField(ctx, f, 'gate') !== gate || !(Number(gateField(ctx, f, 'seq')) > reopen)) continue;
    if (focus !== undefined && focus !== '' && gateField(ctx, f, 'focus') !== fc) continue;
    last = f;
  }
  return last;
}

// ---- validity of a record -------------------------------------------------------------------------------------------------------

/** `gate_bound_to_contract` @param {Context} ctx @param {string} dir @param {string} rec */
export function gateBoundToContract(ctx, dir, rec) {
  return ['task', 'evidence', 'plan', 'qa_plan'].every((k) => gateField(ctx, rec, `${k}_sha256`) === sectionValue(ctx, dir, 'freeze', `${k}_sha256`));
}

/** `gate_bound_after_refreeze` (A200): a refreeze that changed only the QA plan keeps a SECRETS or SECURITY pass. @param {Context} ctx @param {string} dir @param {string} rec */
function gateBoundAfterRefreeze(ctx, dir, rec) {
  for (const k of ['task', 'evidence', 'plan']) if (gateField(ctx, rec, `${k}_sha256`) !== sectionValue(ctx, dir, 'freeze', `${k}_sha256`)) return false;
  if (gateField(ctx, rec, 'result') !== 'pass') return false;
  const g = gateField(ctx, rec, 'gate');
  return g === 'SECRETS' || g === 'SECURITY';
}

/** `hash_file` through the context's memo (a record is hashed once). @param {Context} ctx @param {string} file */
function hashOnce(ctx, file) { return ctx.once(`hash:${file}`, () => { const t = fileText(ctx, file); return t === null ? '' : sha256(t); }); }

/** `valid_gate_file ID RECORD`: task, frozen contract, policy and pipeline, manifest, author role and the bound artifact. @param {Context} ctx @param {string} dir @param {string} id @param {string} rec */
export function validGateFile(ctx, dir, id, rec) {
  if (gateField(ctx, rec, 'task_id') !== id) return false;
  if (!gateBoundToContract(ctx, dir, rec) && !gateBoundAfterRefreeze(ctx, dir, rec)) return false;
  if (gateField(ctx, rec, 'policy_sha256') !== sectionValue(ctx, dir, 'freeze', 'policy_sha256')) return false;
  if (gateField(ctx, rec, 'pipeline') !== sectionValue(ctx, dir, 'freeze', 'pipeline')) return false;
  const m = `${rec.replace(/\.yaml$/, '')}.manifest`;
  if (!isFile(m)) return false;
  if (gateField(ctx, rec, 'manifest_sha256') !== hashOnce(ctx, m)) return false;
  if (gateField(ctx, rec, 'role') !== gateOwner(gateField(ctx, rec, 'gate'))) return false;
  const art = gateField(ctx, rec, 'artifact');
  if (art !== '' && !(isFile(`${dir}/${art}`) && gateField(ctx, rec, 'artifact_sha256') === hashOnce(ctx, `${dir}/${art}`))) return false;
  const ue = gateField(ctx, rec, 'unsupported_evidence').replace(/@[^@]*$/, '');
  if (ue !== '' && !(isFile(`${dir}/${ue}`) && gateField(ctx, rec, 'unsupported_evidence_sha256') === hashOnce(ctx, `${dir}/${ue}`))) return false;
  return true;
}

// ---- findings and waivers -------------------------------------------------------------------------------------------------------

/** `blocking_finding_ids FILE`: the ids of the findings whose severity is not info. @param {Context} ctx @param {string} rec */
export function blockingFindingIds(ctx, rec) {
  /** @type {string[]} */ const out = [];
  for (const l of fileLines(ctx, rec)) {
    const m = /^finding: ([^|]*)\|([a-z]*)\|/.exec(l);
    if (m && m[2] !== 'info') out.push(m[1]);
  }
  return out;
}

/** The rows `finding: id|severity|loc|text|evidence` of a record. @param {Context} ctx @param {string} rec */
export function findingRows(ctx, rec) {
  return fileLines(ctx, rec).filter((l) => l.startsWith('finding: ')).map((l) => l.slice('finding: '.length));
}

/**
 * `finding_waived ID RECORD FINDING`: a listed known issue, an accepted batch finding, or a ledger-bound waiver for exactly this record.
 * @param {Context} ctx @param {string} dir @param {string} rec @param {string} finding
 */
export function findingWaived(ctx, dir, rec, finding) {
  const gate = gateField(ctx, rec, 'gate');
  if (gate === 'SECRETS' || gate === 'SECURITY') return false;
  const shared = ctx.sharedMain();
  if (nonEmptyFile(`${shared}/.agents/local/known-issues/LIST.tsv`)) throw new BridgeToShell('known issues list present');
  const focusLow = gateField(ctx, rec, 'focus').toLowerCase();
  if (!/secret|secur/.test(focusLow) && isFile(`${shared}/.agents/local/batch/SUMMARY.md`)) throw new BridgeToShell('batch summary present');
  const all = listNames(`${dir}/waivers`, /^[0-9]{3}-.*\.yaml$/);
  if (all.length === 0) return false;
  const rs = hashOnce(ctx, rec);
  const base = rec.slice(rec.lastIndexOf('/') + 1);
  for (const n of boundNames(ctx, dir, 'waivers', 'waive$', all)) {
    const f = `${dir}/waivers/${n}`;
    if (gateField(ctx, f, 'gate_record') === base && gateField(ctx, f, 'gate_record_sha256') === rs && gateField(ctx, f, 'finding') === finding) return true;
    if (gateField(ctx, f, 'finding_key') !== '' && gateField(ctx, f, 'gate') === gate) throw new BridgeToShell('persistent waiver key');
  }
  return false;
}

/** `[ -s FILE ]` @param {string} file */
function nonEmptyFile(file) { try { return statSync(file).size > 0; } catch { return false; } }

/** `fail_fully_waived ID RECORD` @param {Context} ctx @param {string} dir @param {string} rec */
export function failFullyWaived(ctx, dir, rec) {
  let any = false;
  for (const x of blockingFindingIds(ctx, rec)) { any = true; if (!findingWaived(ctx, dir, rec, x)) return false; }
  return any;
}

// ---- the task-owned patch -------------------------------------------------------------------------------------------------------

/**
 * `task_owned_paths ID`: the changed paths the plan scope authorizes (tracked, then untracked), sorted. Sorted unique; a path whose
 * fingerprint cannot be taken (a symlink) prints its error and ends that listing, like the shell's subshell does.
 * @param {Context} ctx @param {string} dir @returns {Array<[string, string]>} path and its fingerprint
 */
export function taskOwnedPaths(ctx, dir) {
  return ctx.once(`patch:owned:${dir}`, () => {
    if (!isFile(`${dir}/PLAN.md`)) throw new BridgeToShell('PLAN.md is not readable');
    const sc = planScope(ctx, dir);
    if (!sc.ok) return [];
    const id = dir.slice(dir.lastIndexOf('/') + 1);
    /** @type {Map<string, string>} */ const got = new Map();
    for (const type of ['tracked', 'untracked']) {
      const paths = type === 'tracked' ? trackedPaths(ctx) : untrackedPaths(ctx);
      for (const changed of paths) {
        if (changed === '') continue;
        if (knownControlArtifact(ctx, id, changed)) continue;
        const prior = baselineFingerprint(ctx, type, changed, dir);
        let current;
        try { current = pathFingerprint(ctx, changed); } catch (e) {
          if (e instanceof Error && e.name === 'ProoflineError') { ctx.err(`${e.message}\n`); break; }
          throw e;
        }
        if (prior !== '' && prior === current) continue;
        if (!authorizedPath(sc.rows, changed)) continue;
        got.set(changed, current);
      }
    }
    return sortUnique([...got.keys()]).map((p) => /** @type {[string, string]} */ ([p, got.get(p) ?? '']));
  });
}

/** `task_patch_fingerprint ID`: the digest of the task-owned paths and their fingerprints. @param {Context} ctx @param {string} dir */
export function taskPatchFingerprint(ctx, dir) {
  return ctx.once(`patch:fp:${dir}`, () => sha256(taskOwnedPaths(ctx, dir).map(([p, h]) => `${p} ${h}\n`).join('')));
}

/** `patch_manifest ID`: "path|fingerprint" lines. @param {Context} ctx @param {string} dir */
export function patchManifest(ctx, dir) { return taskOwnedPaths(ctx, dir).map(([p, h]) => `${p}|${h}`); }

// ---- selective repetition -------------------------------------------------------------------------------------------------------

/** `case` pattern of the shell as a regular expression (`*` and `?` only). @param {string} pat */
function casePat(pat) {
  return new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*').replace(/\?/g, '[^]')}$`);
}

const CONFIG_NAMES = ['*lock*', '.env*', '*.env', 'Dockerfile*', 'docker-compose*', 'compose.*', 'Makefile', '*config*', '*.conf', '*.cfg', '*.ini', '*.toml', '*require*', '*constrain*', '*depend*', 'openapi*', 'swagger*', '*.proto', '*.graphql', '*.gql', '*.sql', '*.json', '*.yaml', '*.yml', '*.xml', '*.properties', '.*rc'].map(casePat);
const CODE_NAMES = ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.py', '*.go', '*.rs', '*.java', '*.kt', '*.rb', '*.php', '*.cs', '*.swift', '*.sh', '*.scala', '*.ex', '*.exs', '*_test.*', '*.test.*', '*.spec.*', 'test_*.*', '*Test.*', '*Tests.*'].map(casePat);
export const TEST_PATH_GLOBS = '**/test/** **/tests/** **/__tests__/** *_test.* *.test.* *.spec.* test_*.* *Test.* *Tests.*';
export const SECURITY_TEST_WORDS = 'auth|login|logout|passw|credential|secret|token|session|cookie|csrf|xss|cors|permission|privilege|role|acl|rbac|admin|oauth|jwt|saml|sanitiz|escap|inject|validat|crypt|hash|signature|signing|tls|ssl|cert|owner|tenant|forbidden|unauthori|denied|allowlist|whitelist|blocklist|ssrf|traversal|redirect|upload|rate.?limit|csp|header';

/** `test_code_path PATH`: a test by a test glob, with a code extension, that is not a manifest, lockfile, env, configuration or contract file. @param {Context} ctx @param {string} p */
export function testCodePath(ctx, p) {
  const b = p.slice(p.lastIndexOf('/') + 1);
  if (!pathMatches(p, TEST_PATH_GLOBS)) return false;
  const eco = ecosystemSets(ctx);
  if (!eco.loaded) return false;
  if (pathMatches(p, `${eco.risky} ${eco.dependency} ${ctx.config().get('review.risky_paths', '')}`)) return false;
  if (CONFIG_NAMES.some((r) => r.test(b))) return false;
  return CODE_NAMES.some((r) => r.test(b));
}

/** `plan_path_claim ID PATH`: the kind column of the plan for a path ('' when none). @param {Context} ctx @param {string} dir @param {string} p */
function planPathClaim(ctx, dir, p) {
  const lines = textLines(fileText(ctx, `${dir}/PLAN.md`) ?? '');
  /** @type {string[]} */ const claims = [];
  let inside = false; let cur = '';
  for (const l of lines) {
    if (!inside) { if (l === 'scope:') inside = true; continue; }
    if (l === '---') break;
    if (l.startsWith('  - path: ')) { cur = l.slice('  - path: '.length); continue; }
    if (l.startsWith('    kind: ')) claims.push(`${cur}|${l.slice('    kind: '.length).replace(/["' ]/g, '')}`);
  }
  const hit = claims.find((c) => c.includes(`${p}|`));
  return hit === undefined ? '' : hit.split('|')[1] ?? '';
}

/** The delta of a record's manifest and the current patch manifest: paths whose line occurs once across both. @param {Context} ctx @param {string} dir @param {string} rec @returns {string[] | null} */
function manifestDelta(ctx, dir, rec) {
  const mt = fileText(ctx, `${rec.replace(/\.yaml$/, '')}.manifest`);
  if (mt === null) return null;
  const lines = [...textLines(mt), ...patchManifest(ctx, dir)].filter((l) => l !== '');
  /** @type {Map<string, number>} */ const count = new Map();
  for (const l of lines) count.set(l, (count.get(l) ?? 0) + 1);
  const once = lines.filter((l) => count.get(l) === 1).map((l) => (l.includes('|') ? l.slice(0, l.indexOf('|')) : l));
  return sortUnique(once);
}

/** `git diff-tree -r --name-only A B` -> the set of paths, or null when git fails. @param {Context} ctx @param {string} a @param {string} b */
function treeDiff(ctx, a, b) {
  const r = git(ctx, ['diff-tree', '-r', '--name-only', a, b]);
  return r.status === 0 ? r.out.split('\n').filter((x) => x !== '') : null;
}

/** `focus_untouched ID RECORD FOCUS MODE NOW` @param {Context} ctx @param {string} dir @param {string} rec @param {string} focus @param {string} mode @param {string} now */
function focusUntouched(ctx, dir, rec, focus, mode, now) {
  if (focus === '-' || focus === '') return false;
  if (gateField(ctx, rec, 'gate') === 'SECRETS') return false;
  let pats = '';
  for (const n of riskNames(ctx)) {
    if (ctx.config().get(`risk.${n}.check`, '') !== focus) continue;
    if (ctx.config().get(`risk.${n}.content`, '') !== '') return false;
    pats += ` ${riskPaths(ctx, dir, n)}`;
  }
  if (pats.slice(1) === '' && pats.trim() === '') return false;
  const delta = manifestDelta(ctx, dir, rec);
  if (delta === null || delta.length === 0) return false;
  for (const p of delta) if (pathMatches(p, pats)) return false;
  if (mode !== 'reuse') return true;
  const tree = treeDiff(ctx, gateField(ctx, rec, 'fingerprint'), now);
  if (tree === null || tree.length === 0) return false;
  return tree.every((p) => delta.includes(p));
}

/** `gate_inputs_unchanged ID RECORD GATE MODE NOW` (A200 item 5). @param {Context} ctx @param {string} dir @param {string} rec @param {string} gate @param {string} mode @param {string} now */
function gateInputsUnchanged(ctx, dir, rec, gate, mode, now) {
  if (mode === 'strict') return false;
  if (!['REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_DATA', 'SECURITY'].includes(gate)) return false;
  if (gateField(ctx, rec, 'result') !== 'pass') return false;
  const delta = manifestDelta(ctx, dir, rec);
  if (delta === null || delta.length === 0) return false;
  for (const p of delta) {
    if (!testCodePath(ctx, p)) return false;
    const k = planPathClaim(ctx, dir, p);
    if (k !== '' && k !== 'test') return false;
  }
  const recFp = gateField(ctx, rec, 'fingerprint');
  let cur = now;
  if (mode === 'reuse') {
    const tree = treeDiff(ctx, recFp, cur);
    if (tree === null || tree.length === 0) return false;
    if (!tree.every((p) => delta.includes(p))) return false;
  }
  if (gate !== 'SECURITY') return true;
  if (mode !== 'reuse') cur = gateFingerprint(ctx);
  if (!objectExists(ctx, `${recFp}^{tree}`) || !objectExists(ctx, `${cur}^{tree}`)) return false;
  const words = new RegExp(SECURITY_TEST_WORDS, 'i');
  if (delta.some((p) => words.test(p))) return false;
  const d = git(ctx, ['diff', '--no-color', '--no-ext-diff', '-U0', recFp, cur, '--', ...delta]);
  if (d.status !== 0 || d.out === '') return false;
  if (d.out.split('\n').some((l) => /^[+-][^+-]/.test(l) && words.test(l))) return false;
  return true;
}

/** `gate_amend_carry ID GATE MODE NOW` @param {Context} ctx @param {string} dir @param {string} id @param {string} gate @param {string} mode @param {string} now */
function gateAmendCarry(ctx, dir, id, gate, mode, now) {
  const re = lastReopenSeq(ctx, dir);
  if (!(re > 0)) return '';
  if (!['REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_DATA', 'SECURITY'].includes(gate)) return '';
  const fc = gateFocus(gate);
  let last = '';
  for (const n of gateNames(ctx, dir)) {
    const f = gf(ctx, dir, n);
    if (gateField(ctx, f, 'gate') === gate && Number(gateField(ctx, f, 'seq')) < re && gateField(ctx, f, 'focus') === fc) last = f;
  }
  if (last === '') return '';
  return validGateFile(ctx, dir, id, last) && gateInputsUnchanged(ctx, dir, last, gate, mode, now) ? last : '';
}

/** `status_rank` @param {string} s */
export function statusRank(s) { return s === 'pass' || s === 'unsupported' ? 0 : s === 'waived' ? 1 : s === 'pass_low' ? 2 : s === 'missing' ? 3 : s === 'stale' ? 4 : 5; }

/**
 * `gate_focus_status ID GATE FOCUS MODE NOW`: the latest record of that gate and focus ('-' = the gate's own).
 * @param {Context} ctx @param {string} dir @param {string} id @param {string} gate @param {string} focus @param {string} mode @param {string} now
 */
export function gateFocusStatus(ctx, dir, id, gate, focus, mode, now) {
  const key = mode === 'patch' ? 'patch_sha256' : 'fingerprint';
  let last = gateLatestFile(ctx, dir, gate, focus);
  if (last === '' && focus === '-' && mode !== 'strict') last = gateAmendCarry(ctx, dir, id, gate, mode, now);
  if (last === '') return 'missing';
  if (!validGateFile(ctx, dir, id, last)) return 'stale';
  if (gateField(ctx, last, key) !== now && !(key === 'fingerprint' && legacyFingerprintMatch(ctx, gateField(ctx, last, 'fingerprint')))) {
    const carried = mode !== 'strict' && gateField(ctx, last, 'result') === 'pass'
      && (focusUntouched(ctx, dir, last, focus, mode, now) || (focus === '-' && gateInputsUnchanged(ctx, dir, last, gate, mode, now)));
    if (!carried) return 'stale';
  }
  switch (gateField(ctx, last, 'result')) {
    case 'pass': return 'pass';
    case 'pass_low': return 'pass_low';
    case 'unsupported': return 'unsupported';
    case 'fail':
      if (failFullyWaived(ctx, dir, last)) return 'waived';
      if (Number(gateField(ctx, last, 'seq')) <= lastReopenSeq(ctx, dir, 'terminal')) return 'stale';
      return 'fail';
    default: return 'stale';
  }
}

/** The fingerprint a mode compares with. @param {Context} ctx @param {string} dir @param {string} mode */
export function nowFor(ctx, dir, mode) { return mode === 'patch' ? taskPatchFingerprint(ctx, dir) : gateFingerprint(ctx); }

/** `gate_status ID GATE [MODE] [NOW]`: the worst status over the gate's own focus and every risk focus it carries. @param {Context} ctx @param {string} dir @param {string} id @param {string} gate @param {string} [mode] @param {string} [now] */
export function gateStatus(ctx, dir, id, gate, mode = 'strict', now = '') {
  const n = now !== '' ? now : nowFor(ctx, dir, mode);
  let worst = 'pass';
  for (const fc of ['-', ...riskGateFocuses(ctx, dir, gate)]) {
    const s = gateFocusStatus(ctx, dir, id, gate, fc, mode, n);
    if (statusRank(s) > statusRank(worst)) worst = s;
  }
  return worst;
}

/** `gate_unsupported_focuses`: comma list. @param {Context} ctx @param {string} dir @param {string} id @param {string} gate @param {string} mode @param {string} now */
export function gateUnsupportedFocuses(ctx, dir, id, gate, mode, now) {
  return riskGateFocuses(ctx, dir, gate).filter((f) => gateFocusStatus(ctx, dir, id, gate, f, mode, now) === 'unsupported').join(',');
}

/** `unsupported_label SEVERITY` @param {string} v */
export function unsupportedLabel(v) { return v === 'info' ? 'UNSUPPORTED (unproven, reported)' : 'UNSUPPORTED (blocking: a waiver or a measurement is needed)'; }

/** `gate_satisfied` @param {string} s */
export function gateSatisfied(s) { return s === 'pass' || s === 'waived' || s === 'unsupported'; }

// ---- required gates and dependencies --------------------------------------------------------------------------------------------

/** `required_gates ID [TIER]` @param {Context} ctx @param {string} dir @param {string} [tier] @returns {string[]} */
export function requiredGates(ctx, dir, tier) {
  if (!(pipelineDeclared(ctx, dir) && pipelineClassValid(pipelineClass(ctx, dir)))) return [];
  const t = tier ?? tierEffective(ctx, dir);
  const out = ['SECRETS'];
  if (t === 'small') out.push('REVIEW_SMALL');
  else if (t === 'full') {
    out.push('REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS');
    const plan = fileText(ctx, `${dir}/PLAN.md`);
    if ((plan !== null && planSectionPresent(plan, 'Data')) || riskGateFocuses(ctx, dir, 'REVIEW_DATA').length > 0) out.push('REVIEW_DATA');
    out.push('SECURITY');
  }
  if (pipelineNeeds(ctx, dir, 'qa') === 'yes') out.push('QA');
  out.push('VERIFY');
  return out;
}

/** `gate_deps ID GATE`: "GATE:focus" that must be satisfied before GATE runs. @param {Context} ctx @param {string} dir @param {string} gate @returns {string[]} */
export function gateDeps(ctx, dir, gate) {
  if (gate !== 'VERIFY') return [];
  if (!requiredGates(ctx, dir).includes('QA')) return [];
  return riskGateFocuses(ctx, dir, 'QA').includes('visual') ? ['QA:visual'] : [];
}

// ---- fix rounds -----------------------------------------------------------------------------------------------------------------

/** `tree_line FINGERPRINT PATH:LINE`: the text of that line in that tree ('' when unknown). @param {Context} ctx @param {string} fp @param {string} loc */
function treeLine(ctx, fp, loc) {
  const colon = loc.lastIndexOf(':');
  const p = colon < 0 ? loc : loc.slice(0, colon);
  let n = colon < 0 ? loc : loc.slice(colon + 1);
  n = n.replace(/-[^]*$/, '');
  if (!/^[0-9]+$/.test(n) || Number(n) <= 0 || p === loc) return '';
  const text = catFile(ctx, `${fp}:${p}`);
  if (text === null) return '';
  const lines = text.split('\n');
  return lines[Number(n) - 1] ?? '';
}

/** `tree_line_before OLD NEW PATH:LINE`: the line number in OLD of an unchanged line of NEW; null when the diff touches it. @param {Context} ctx @param {string} oldTree @param {string} newTree @param {string} loc */
function treeLineBefore(ctx, oldTree, newTree, loc) {
  const colon = loc.lastIndexOf(':');
  const p = colon < 0 ? loc : loc.slice(0, colon);
  const n0 = (colon < 0 ? loc : loc.slice(colon + 1)).replace(/-[^]*$/, '');
  if (!/^[0-9]+$/.test(n0) || p === loc || !(Number(n0) > 0)) return null;
  if (!objectExists(ctx, `${oldTree}:${p}`)) return null;
  const n = Number(n0);
  const d = git(ctx, ['diff', '--no-color', '--no-ext-diff', '-U0', oldTree, newTree, '--', p]);
  let off = 0; let bad = false;
  for (const l of d.out.split('\n')) {
    if (!l.startsWith('@@ ')) continue;
    const h = l.replace(/^@@ -/, '').split(' ');
    const o = h[0] ?? ''; let c = h[1] ?? ''; c = c.replace(/^\+/, '');
    let ob = 1; if (o.includes(',')) ob = Number(o.split(',')[1]);
    let cs = Number(c); let cd = 1; if (c.includes(',')) { const y = c.split(','); cs = Number(y[0]); cd = Number(y[1]); }
    if (cd > 0 && n >= cs && n <= cs + cd - 1) bad = true;
    if ((cd > 0 && cs + cd - 1 < n) || (cd === 0 && cs < n)) off += ob - cd;
  }
  return bad ? null : n + off;
}

/** The locations a record cites with a non-info severity (the awk of gate_carryover_free). @param {Context} ctx @param {string} rec */
function citedLocs(ctx, rec) {
  /** @type {string[]} */ const out = [];
  for (const l of fileLines(ctx, rec)) {
    if (!l.startsWith('finding: ')) continue;
    const f = l.split('|');
    if (f[1] === 'info') continue;
    const loc = (f[2] ?? '').replace(/ /g, '');
    out.push(loc === '' ? '-' : loc);
  }
  return out;
}

/** `gate_prev_record ID RECORD`: the latest earlier record of the same gate and focus on another revision (after the last reopen). @param {Context} ctx @param {string} dir @param {string} rec */
function gatePrevRecord(ctx, dir, rec) {
  const seq = Number(gateField(ctx, rec, 'seq'));
  const g = gateField(ctx, rec, 'gate'); const fc = gateField(ctx, rec, 'focus'); const fp = gateField(ctx, rec, 'fingerprint');
  const ro = lastReopenSeq(ctx, dir, 'any');
  let best = ''; let bs = 0;
  for (const n of gateNames(ctx, dir)) {
    const f = gf(ctx, dir, n);
    if (gateField(ctx, f, 'gate') !== g || gateField(ctx, f, 'focus') !== fc) continue;
    const s = Number(gateField(ctx, f, 'seq'));
    if (!(s < seq && s > ro && s > bs)) continue;
    if (gateField(ctx, f, 'fingerprint') === fp) continue;
    best = f; bs = s;
  }
  return best;
}

/** `gate_carryover_free ID RECORD` (A171): the record only carries over examples of an earlier revision. @param {Context} ctx @param {string} dir @param {string} rec */
function gateCarryoverFree(ctx, dir, rec) {
  if (!gateField(ctx, rec, 'gate').startsWith('REVIEW_')) return false;
  const prev = gatePrevRecord(ctx, dir, rec);
  if (prev === '') return false;
  const fp = gateField(ctx, rec, 'fingerprint'); const pfp = gateField(ctx, prev, 'fingerprint');
  const seq = Number(gateField(ctx, rec, 'seq')); const g = gateField(ctx, rec, 'gate'); const fc = gateField(ctx, rec, 'focus');
  const ro = lastReopenSeq(ctx, dir, 'any');
  /** @type {Set<string>} */ const cited = new Set();
  for (const n of gateNames(ctx, dir)) {
    const f = gf(ctx, dir, n);
    if (gateField(ctx, f, 'gate') !== g || gateField(ctx, f, 'focus') !== fc) continue;
    const s = Number(gateField(ctx, f, 'seq'));
    if (!(s < seq && s > ro)) continue;
    const efp = gateField(ctx, f, 'fingerprint');
    for (const loc of citedLocs(ctx, f)) cited.add(`${loc.replace(/:[^:]*$/, '')}\t${treeLine(ctx, efp, loc)}`);
  }
  let rows = 0;
  for (const loc of citedLocs(ctx, rec)) {
    rows++;
    const txt = treeLine(ctx, fp, loc);
    if (!/[^ \t\n\v\f\r]/.test(txt)) return false;
    const old = treeLineBefore(ctx, pfp, fp, loc);
    if (old === null) return false;
    const base = loc.replace(/:[^:]*$/, '');
    if (treeLine(ctx, pfp, `${base}:${old}`) !== txt) return false;
    if (cited.has(`${base}\t${txt}`)) return false;
  }
  return rows > 0;
}

/** `max_fix_rounds` @param {Context} ctx */
export function maxFixRounds(ctx) { const v = ctx.config().get('review.max_fix_rounds', '2'); return /^[0-9]+$/.test(v) ? Number(v) : 2; }

/** `fix_rounds_used ID`: one round per distinct content that collected an unwaived blocking FAIL under the current contract since the last reopen. @param {Context} ctx @param {string} dir */
export function fixRoundsUsed(ctx, dir) {
  const reopen = lastReopenSeq(ctx, dir, 'any');
  const set = new Set();
  for (const n of gateNames(ctx, dir)) {
    const f = gf(ctx, dir, n);
    if (gateField(ctx, f, 'result') !== 'fail') continue;
    if (!(Number(gateField(ctx, f, 'seq')) > reopen)) continue;
    if (!gateBoundToContract(ctx, dir, f)) continue;
    if (failFullyWaived(ctx, dir, f)) continue;
    if (gateCarryoverFree(ctx, dir, f)) continue;
    set.add(gateField(ctx, f, 'fingerprint'));
  }
  return set.size;
}

// ---- reports the pipeline shows -------------------------------------------------------------------------------------------------

/** `risk_not_rerun ID`: the "GATE:focus reason" of each current record that re-ran nothing. @param {Context} ctx @param {string} dir @returns {string[]} */
export function riskNotRerun(ctx, dir) {
  /** @type {string[]} */ const out = [];
  for (const g of requiredGates(ctx, dir)) {
    for (const fc of ['-', ...riskGateFocuses(ctx, dir, g)]) {
      const f = gateLatestFile(ctx, dir, g, fc);
      if (f === '') continue;
      let v = gateField(ctx, f, 'not_rerun');
      if (v === '') {
        for (const l of fileLines(ctx, f)) { const m = /^finding: [^|]*\|info\|[^|]*\|NOT_RERUN: ([^|]*)\|/.exec(l); if (m) { v = m[1]; break; } }
      }
      if (v !== '') out.push(v);
    }
  }
  return out;
}

/** `risk_unsupported ID`: "GATE:focus|severity|finding|evidence" for each UNSUPPORTED finding of a current focus record. @param {Context} ctx @param {string} dir @returns {string[][]} */
export function riskUnsupported(ctx, dir) {
  /** @type {string[][]} */ const out = [];
  for (const g of requiredGates(ctx, dir)) {
    for (const fc of riskGateFocuses(ctx, dir, g)) {
      const r = gateLatestFile(ctx, dir, g, fc);
      if (r === '') continue;
      const e = gateField(ctx, r, 'unsupported_evidence');
      for (const l of fileLines(ctx, r)) {
        const m = /^finding: [^|]*\|([a-z]*)\|[^|]*\|(UNSUPPORTED [^|]*)\|/.exec(l);
        if (m) out.push([`${g}:${fc}`, m[1], m[2], e]);
      }
    }
  }
  return out;
}

/** `gate_blocking_rows FILE N`: "id loc: text" of the first N blocking rows, 300 bytes each. @param {Context} ctx @param {string} rec @param {number} n */
export function gateBlockingRows(ctx, rec, n) {
  /** @type {string[]} */ const out = [];
  for (const l of fileLines(ctx, rec)) {
    const m = /^finding: ([^|]*)\|blocking\|([^|]*)\|([^|]*)\|/.exec(l);
    if (m) out.push(`${m[1]} ${m[2]}: ${m[3]}`.slice(0, 300));
    if (out.length >= n) break;
  }
  return out;
}

/** `gate_fail_hint ID GATE STATUS` @param {Context} ctx @param {string} dir @param {string} id @param {string} g @param {string} s */
export function gateFailHint(ctx, dir, id, g, s) {
  if (s === 'fail') {
    let rows = '';
    for (const fc of ['-', ...riskGateFocuses(ctx, dir, g)]) {
      const lf = gateLatestFile(ctx, dir, g, fc);
      if (lf === '' || gateField(ctx, lf, 'result') !== 'fail') continue;
      rows += gateBlockingRows(ctx, lf, 2).map((r) => `${r};`).join('');
    }
    return `first blocking finding(s): ${rows === '' ? '(none readable in the record)' : rows} next step: agent.sh next ${id}`;
  }
  if (s === 'stale' || s === 'missing') {
    if (g === 'SECRETS') return `run: agent.sh secret-scan ${id}`;
    if (g.startsWith('REVIEW_')) return `run: dispatch.sh ${id} reviewer --focus ${gateFocus(g)}`;
    return `run: dispatch.sh ${id} ${gateOwner(g)}`;
  }
  return '';
}

/** `verify_required_gates ID strict|patch MESSAGE` @param {Context} ctx @param {string} dir @param {string} id @param {string} mode @param {string} message */
export function verifyRequiredGates(ctx, dir, id, mode, message) {
  const now = mode === 'patch' ? '' : gateFingerprint(ctx);
  for (const g of requiredGates(ctx, dir)) {
    const s = gateStatus(ctx, dir, id, g, mode, now);
    if (!gateSatisfied(s)) fail(`${message}: required gate ${g} of ${id} is ${s} for the current content. ${gateFailHint(ctx, dir, id, g, s)} (all gates: 'agent.sh pipeline ${id}')`);
  }
}

// ---- mutation ownership and verify-gates ----------------------------------------------------------------------------------------

const CANON = /** @type {Record<string, string>} */ ({ full_lifecycle: 'lead', implementation_worker: 'implementer', independent_reviewer: 'reviewer', independent_qa: 'qa', independent_verifier: 'verifier' });

/** `verify_mutation_ownership ID [force]` @param {Context} ctx @param {string} dir @param {string} id @param {boolean} [force] */
export function verifyMutationOwnership(ctx, dir, id, force = false) {
  if (!gatesEnforced(ctx, dir)) return;
  let topo = sectionValue(ctx, dir, 'execution', 'topology');
  if (topo !== 'standalone' && topo !== 'orchestrated') {
    topo = ctx.config().get('default_topology', '');
    if (topo !== 'standalone' && topo !== 'orchestrated') fail('no valid execution topology resolved: set execution.topology in RUN.yaml or default_topology in .agents/config.yaml');
  }
  if (topo !== 'orchestrated') return;
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  if (!['IMPLEMENTED', 'CODE_DONE', 'DONE'].includes(hs) && !force) return;
  let prevAfter = sha256('');
  const ev = `${dir}/worker-evidence`;
  let names = [];
  try { names = readdirSync(ev).filter((n) => /^WINDOW-[0-9]+\.yaml$/.test(n)); } catch { /* none */ }
  names.sort((a, b) => Number(a.slice(7, -5)) - Number(b.slice(7, -5)) || (a < b ? -1 : 1));
  for (const w of names) {
    const wf = `${ev}/${w}`;
    const r0 = gateField(ctx, wf, 'role');
    const role = CANON[r0] ?? r0;
    const label = w.replace(/\.yaml$/, '');
    if (role === 'implementer' || role === 'designer') { /* attested */ }
    else if (role === 'user') {
      if (boundNames(ctx, dir, 'worker-evidence', 'tree-accept$', [w]).length === 0) fail(`worker window ${label} claims the user's acceptance but no tree-accept command bound it in the ledger`);
    } else fail(`worker window ${label} was not attested for the implementer or designer`);
    if (gateField(ctx, wf, 'before_sha256') !== prevAfter) fail(`unattributed application/test mutation before ${label}: the tree changed between worker windows outside the implementer`);
    prevAfter = gateField(ctx, wf, 'after_sha256');
  }
  const tree = taskPatchFingerprint(ctx, dir);
  if (tree !== prevAfter) {
    fail(`application/test tree (${tree}) is not the last implementer-attested tree (${prevAfter}): a mutation was made outside the implementer under orchestrated topology; undo it and route the change through the implementer (dispatch.sh), or keep the run: agent.sh tree-inspect '${id}' shows the change and agent.sh tree-accept '${id}' asks the user to accept it (every gate then runs again)`);
  }
}

/** `verify_lifecycle_gates ID` @param {Context} ctx @param {string} id */
export function verifyLifecycleGates(ctx, id) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) return;
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  verifySeal(ctx, id, dir);
  verifyMutationOwnership(ctx, dir, id);
  if (hs === 'CODE_DONE' || hs === 'DONE') verifyRequiredGates(ctx, dir, id, 'patch', 'gate evidence missing or stale');
}
