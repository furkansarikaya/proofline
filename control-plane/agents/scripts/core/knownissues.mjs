// @ts-check
// Known issues (A202), the decision side: whether a blocking finding is a listed known issue (`ki_untouched`, `finding_known_issue`, `ki_gate_facts`).
// The data rules (the list, the approvals, canon, lookup, append) are in kirules.mjs (A222).
import { statSync } from 'node:fs';
import { batchApproval, sharedDirOf } from './approvals.mjs';
import { hashFile } from './fingerprint.mjs';
import { git, sortUnique, trackedPaths, untrackedPaths } from './git.mjs';
import { blockingFindingIds, gateLatestFile, requiredGates } from './gates.mjs';
import { canon, listable, lookup, placePath } from './kirules.mjs';
import { sha256 } from './hash.mjs';
import { findStanding } from './standing.mjs';
import { isFile } from './paths.mjs';
import { fileText, gateField, sectionValue, textLines } from './records.mjs';
import { asciiLower } from './shellglob.mjs';
import { riskGateFocuses } from './signals.mjs';
import { normRelPath, scopeEntryCovers } from './taskfile.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `[ -s LIST.tsv ]` of the shared known-issues folder. @param {Context} ctx */
export function knownIssuesListed(ctx) {
  try { return statSync(`${ctx.sharedMain()}/.agents/local/known-issues/LIST.tsv`).size > 0; } catch { return false; }
}

/**
 * `ki_untouched ID PLACE`: true only when the run's frozen scope does not cover the place and the diff since the run's base does not hold it.
 * @param {Context} ctx @param {string} dir @param {string} place
 */
export function kiUntouched(ctx, dir, place) {
  const scope = sectionValue(ctx, dir, 'freeze', 'scope_paths');
  if (scope === '') return false;
  const lower = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const e of scope.split(',').filter((x) => x !== '')) if (scopeEntryCovers(lower(e), lower(place))) return false;
  const base = sectionValue(ctx, dir, 'repository', 'base_sha');
  if (base === '') return false;
  const d = git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', base]);
  if (d.status !== 0) return false;
  const all = sortUnique([...d.out.split('\n').filter((l) => l !== ''), ...trackedPaths(ctx), ...untrackedPaths(ctx)]).map(lower);
  const want = lower(normRelPath(place));
  if (want === '') return false;
  return !all.some((p) => p.replace(/^\.\//, '') === want);
}

/**
 * `finding_known_issue ID RECORD FINDING-ID`: "KI-n<TAB>follow-up..." when the blocking finding is an active record the task does not touch, else null.
 * @param {Context} ctx @param {string} id @param {string} rec @param {string} fid
 */
export function findingKnownIssue(ctx, id, rec, fid) {
  if (!knownIssuesListed(ctx)) return null;
  const gate = gateField(ctx, rec, 'gate');
  if (gate === 'SECRETS' || gate === 'SECURITY') return null;
  const c = canon(ctx, rec, fid);
  if (c === null) return null;
  const m = lookup(ctx, c.gate, c.place, c.text);
  if (m === null) return null;
  if (m.followup === id) return null;   // the task that is the follow-up fixes it: it is not a known issue for that task
  if (!kiUntouched(ctx, `${ctx.root}/.agents/runs/${id}`, c.place.split(':')[0])) return null;
  return `${m.id}\t${m.followup}`;
}

/**
 * `batch_answer_row ID KIND` (A200): letter, parameter and question of the newest answer to a batch pre-flight question, valid only while the batch
 * approval of the summary that asked it stands; null when there is none.
 * @param {Context} ctx @param {string} id @param {string} kind @returns {string[] | null}
 */
export function batchAnswerRow(ctx, id, kind) {
  const dir = sharedDirOf(ctx, 'batch');
  const answers = fileText(ctx, `${dir}/answers.tsv`);
  if (answers === null || answers === '') return null;
  if (batchApproval(ctx) === null) return null;
  const b = hashFile(`${dir}/SUMMARY.md`).slice(0, 12);
  /** @type {string[] | null} */ let r = null;
  for (const l of textLines(answers)) {
    const f = l.split('\t');
    if (f[0] === b && f[1] === id && f[3] === kind) r = [f[4] ?? '', f[5] ?? '', f[2] ?? ''];
  }
  return r;
}

/** `batch_accept_given`: the batch approval of the current summary stands and the newest answer to its accept question is b, from a captured user message. @param {Context} ctx */
function batchAcceptGiven(ctx) {
  if (batchApproval(ctx) === null) return false;
  const row = batchAnswerRow(ctx, 'batch', 'accept');
  if (row === null || row[0] !== 'b') return false;
  const dir = sharedDirOf(ctx, 'batch');
  const b = hashFile(`${dir}/SUMMARY.md`).slice(0, 12);
  let m = '';
  for (const l of textLines(fileText(ctx, `${dir}/answers.tsv`) ?? '')) { const f = l.split('\t'); if (f[0] === b && f[1] === 'batch' && f[3] === 'accept') m = f[6] ?? ''; }
  return m !== '' && isFile(`${sharedDirOf(ctx, 'prompts')}/history/${m}`);
}

/**
 * `finding_batch_accepted ID GATE-RECORD FINDING-ID`: the blocking finding is on the approved summary's accepted list, the task belongs to the batch
 * and does not touch the place. SECRETS and SECURITY are never accepted this way.
 * @param {Context} ctx @param {string} id @param {string} rec @param {string} fid
 */
export function findingBatchAccepted(ctx, id, rec, fid) {
  const gate = gateField(ctx, rec, 'gate');
  if (gate === 'SECRETS' || gate === 'SECURITY') return false;
  if (/secret|secur/.test(asciiLower(gateField(ctx, rec, 'focus')))) return false;
  if (batchApproval(ctx) === null) return false;
  const order = fileText(ctx, `${sharedDirOf(ctx, 'batch')}/order.tsv`);
  if (order === null || !textLines(order).some((l) => l.split('\t')[0] === id)) return false;
  if (!batchAcceptGiven(ctx)) return false;
  const c = canon(ctx, rec, fid);
  if (c === null) return false;
  const { gate: g, place: p, text: t } = c;
  if (/secret|secur/.test(asciiLower(g))) return false;
  if (listable(ctx, g, p) !== null) return false;
  const summary = fileText(ctx, `${sharedDirOf(ctx, 'batch')}/SUMMARY.md`) ?? '';
  if (!textLines(summary).includes(`- accept K ${g} ${p}: ${t}`)) return false;
  return kiUntouched(ctx, `${ctx.root}/.agents/runs/${id}`, p.split(':')[0]);
}

/** The pattern ids of the installed visual-proof registry (`PATTERN_IDS` of patterns.mjs); none when the skill is not installed. @param {Context} ctx @returns {string[]} */
function registryIds(ctx) {
  return ctx.once('standing:registry', () => {
    const t = fileText(ctx, `${ctx.root}/.agents/skills/visual-proof/scripts/patterns.mjs`) ?? '';
    const m = /export const PATTERN_IDS = \[([^\]]*)\]/.exec(t);
    return m === null ? [] : [...m[1].matchAll(/"([a-z][a-z0-9-]*)"/g)].map((x) => x[1]);
  });
}

/**
 * The standing key of a blocking finding (A361, issue 338 C3): { rule, surface, fp } when the finding was already there on the unchanged base, else null. SECRETS and
 * SECURITY never have one. `rule` is the registry rule the finding text names (`lint <id>:`, an id of the installed visual-proof registry; a free-form finding has no key); `surface` is the file; `fp` is the
 * sha256 of the gate, the rule, the finding's normalised text, the file and the file's blob at the run's base. The file must be a tracked blob that the run's frozen
 * scope does not cover and that the diff since the base does not hold (`kiUntouched`): a finding in a changed file has no key, so it is asked again.
 * @param {Context} ctx @param {string} id @param {string} rec @param {string} fid @returns {{ rule: string, surface: string, fp: string } | null}
 */
export function standingWaiverKey(ctx, id, rec, fid) {
  const gate = gateField(ctx, rec, 'gate');
  if (gate === 'SECRETS' || gate === 'SECURITY') return null;
  if (/secret|secur/.test(asciiLower(gateField(ctx, rec, 'focus')))) return null;
  const c = canon(ctx, rec, fid);
  if (c === null || /secret|secur/.test(asciiLower(c.gate)) || listable(ctx, c.gate, c.place) !== null) return null;
  const file = placePath(c.place);
  const dir = `${ctx.root}/.agents/runs/${id}`;
  if (!kiUntouched(ctx, dir, file)) return null;
  const base = sectionValue(ctx, dir, 'repository', 'base_sha');
  if (!/^[0-9a-f]{7,64}$/.test(base)) return null;
  const blob = git(ctx, ['rev-parse', '--verify', '-q', `${base}:${file}`]);
  const kind = git(ctx, ['cat-file', '-t', `${base}:${file}`]);
  if (blob.status !== 0 || kind.status !== 0 || kind.out.trim() !== 'blob') return null;
  // only a REGISTRY rule has a stable identity: the text names `lint <id>:` and the id is one of the installed visual-proof registry's. A free-form finding of a reviewer or any agent
  // (it may be caused by THIS task's change elsewhere) never gets a key; it stays a per-run waiver
  const m = /^lint ([a-z][a-z0-9-]*): /.exec(c.text);
  if (m === null || !registryIds(ctx).includes(m[1])) return null;
  const rule = m[1];
  return { rule, surface: file, fp: sha256(`${c.gate}\n${rule}\n${c.text}\n${file}\n${blob.out.trim()}\n`) };
}

/**
 * The finding is a pre-existing one (it has a standing key) that the user already waived, in this or an earlier task, for exactly this rule, this file and this content
 * (STANDING.tsv, written only from the user's message). A changed file, a changed finding or another rule has another key.
 * @param {Context} ctx @param {string} id @param {string} rec @param {string} fid
 */
export function findingStandingWaived(ctx, id, rec, fid) {
  const k = standingWaiverKey(ctx, id, rec, fid);
  return k !== null && findStanding(ctx, 'waiver', k.rule, k.surface, k.fp) !== null;
}

/** `ki_gate_facts ID GATE`: "KI-n:FINDING:follow-up" for the gate's current blocking findings that are listed known issues. @param {Context} ctx @param {string} id @param {string} gate @returns {string[]} */
export function gateFacts(ctx, id, gate) {
  const dir = `${ctx.root}/.agents/runs/${id}`;
  /** @type {string[]} */ const out = [];
  for (const fc of ['-', ...riskGateFocuses(ctx, dir, gate)]) {
    const f = gateLatestFile(ctx, dir, gate, fc);
    if (f === '' || gateField(ctx, f, 'result') !== 'fail') continue;
    for (const x of blockingFindingIds(ctx, f)) {
      const m = findingKnownIssue(ctx, id, f, x);
      if (m === null) continue;
      const cols = m.split('\t');
      out.push(`${cols[0]}:${x}:${cols[1]}`);
    }
  }
  return out;
}

/** The known issues of a run's required gates, as the status block lists them. @param {Context} ctx @param {string} id @returns {string[]} */
export function knownIssueFacts(ctx, id) {
  if (!knownIssuesListed(ctx)) return [];
  const dir = `${ctx.root}/.agents/runs/${id}`;
  return requiredGates(ctx, dir).flatMap((g) => gateFacts(ctx, id, g));
}
