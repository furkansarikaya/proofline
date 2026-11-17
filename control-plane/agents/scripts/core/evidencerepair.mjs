// @ts-check
// The evidence-only repair of a fix round (A325, closes the dead end A324.1). A REVIEW_TESTS finding "the plan names a test with no recorded duration" (`not_measured`,
// reason `no_recorded_duration`) is a fact about the GREEN evidence, not about the tree: the cure is to run the unchanged tests again and record their durations. Until now a fix
// had to change the tree (`verifyFixBound`), so the only way out was a pointless edit or a user decision. This module holds the three pieces of the narrow exception:
//  - `evidenceRepairPlan`: may a repair run now? Every open blocking finding is of that one class, nothing else is open, the task patch (application and test tree) is the one that was
//    reviewed, the plan lists a Verification command, a round is left and this fix round has not repaired yet. Any other case is refused and keeps the rule "change the tree".
//  - `evidenceRepairRun`: the control plane runs the plan-listed commands itself and reads the per-test durations from their output itself. The agent supplies nothing.
//  - `evidenceRepairCovers`: `handoff IMPLEMENTED` accepts an unchanged tree only for the finding that a repair row of the sealed ledger names, once.
// The repair creates no approval, no waiver and no gate record: the reviewer judges the new evidence on the next dispatch (Core invariants 3 and 5).
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';
import { exceptionApproval } from './exceptionsapproval.mjs';
import { blockingFindingIds, evidenceRepairRows, fixRoundsUsed, gateLatestFile, gateStatus, maxFixRounds, repairFinding, requiredGates, taskPatchFingerprint } from './gates.mjs';
import { latestFindingFile } from './next.mjs';
import * as proc from './proc.mjs';
import { fieldOf, fileLines, gateField, gatesEnforced, ledgerRows, sectionValue } from './records.mjs';
import { planVerificationCommands } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { parseException, planTestsWithoutDurationOf } from './testreview.mjs';
import { greenRecords, measureRequired } from './testmeasure.mjs';
import { verifyCommandTimeout } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The `not_measured` reasons an evidence-only repair can answer. Every other kind and reason (a wait, a clock read, a budget, a command the control plane did not run twice, a stability finding...) needs a tree change or the user. */
const REPAIRABLE_REASON = 'no_recorded_duration';

/** The reviewer's findings of the tests review. @param {string} dir */
const FINDINGS = (dir) => `${dir}/reviews/test-trust/tests/findings.json`;

// ---- reading the per-test durations from a runner's output ------------------------------------------------------------------------------

/**
 * The passing tests of a runner's output with their milliseconds, from the line shapes runners print: `<mark> name (12.5ms)` / `(12 ms)` / `(0.01s)` after a pass mark, `--- PASS: name (0.01s)`,
 * and a TAP `ok N - name` line followed by a `duration_ms:` line. Terminal colour codes are dropped first. A name with `=` or `;` cannot be recorded and is left out. The first line of a name wins.
 * @param {string} text @returns {Array<{ name: string, ms: number }>}
 */
export function parseRunnerDurations(text) {
  /** @type {Array<{ name: string, ms: number }>} */ const out = [];
  const seen = new Set();
  const add = (/** @type {string} */ rawName, /** @type {number} */ ms) => {
    const name = rawName.trim();
    if (name === '' || name.includes('=') || name.includes(';') || !Number.isFinite(ms) || ms < 0 || seen.has(name)) return;
    seen.add(name);
    out.push({ name, ms: Number(ms.toFixed(3)) });
  };
  /** @type {string | null} */ let pending = null;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  for (const line of clean.split('\n')) {
    let m = /^\s*(?:[✔✓√]|--- PASS:)\s*(.+?)\s*\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/.exec(line);
    if (m) { add(m[1], Number(m[2]) * (m[3] === 's' ? 1000 : 1)); pending = null; continue; }
    m = /^\s*ok \d+ - (.+?)(?: # .*)?\s*$/.exec(line);
    if (m && !/# (SKIP|TODO)/i.test(line)) { pending = m[1]; continue; }
    if (/^\s*not ok /.test(line)) { pending = null; continue; }
    m = /^\s*duration_ms:\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m && pending !== null) { add(pending, Number(m[1])); pending = null; }
  }
  return out;
}

/**
 * For each plan-named test, the entry of the output that carries its duration: the entry with the same name, else the ONE entry whose name contains it (the rule
 * `planTestsWithoutDurationOf` applies, minus its reverse direction). Two entries that contain the name are ambiguous and attribute nothing: the test stays missing (A325).
 * @param {string[]} planNames lower case @param {Array<{ name: string, ms: number }>} entries
 * @returns {{ found: Map<string, { name: string, ms: number }>, missing: string[] }}
 */
export function matchPlanDurations(planNames, entries) {
  /** @type {Map<string, { name: string, ms: number }>} */ const found = new Map();
  /** @type {string[]} */ const missing = [];
  for (const n of planNames) {
    const exact = entries.find((e) => asciiLower(e.name) === n);
    const part = entries.filter((e) => asciiLower(e.name).includes(n));
    const hit = exact ?? (part.length === 1 ? part[0] : undefined);
    if (hit) found.set(n, hit); else missing.push(n);
  }
  return { found, missing };
}

/**
 * The plan tests a user-approved `- measure:` line excuses (lower case): the lines of the plan's `## Test exceptions` that the user's scope approval or the approved batch summary covers
 * (A285, the same decision `submit` uses), kind measure, target without quotes or backticks. An unapproved line excuses nothing.
 * @param {Context} ctx @param {string} id @returns {string[]}
 */
export function approvedMeasureTargets(ctx, id) {
  const a = exceptionApproval(ctx, runDir(ctx, id), id);
  return a.lines.filter((l) => a.approved(l)).map(parseException).filter((e) => e !== null && e.kind === 'measure').map((e) => asciiLower(/** @type {{ target: string }} */ (e).target.replace(/[`"]/g, '').trim()));
}

// ---- which findings are open ------------------------------------------------------------------------------------------------------------

/**
 * '' when every confirmed finding of the tests review's findings.json is a `not_measured` finding of reason `no_recorded_duration`, else why the repair is refused. A finding of any other kind
 * (a real wait, a clock read, a budget, flaky, hollow...), a `not_measured` finding of another reason (including `command_not_double_run`, whose cure is a different command, not other numbers),
 * a findings.json that cannot be read, or no confirmed finding at all, refuses it. The file is also bound to the failing gate record REC: the record's blocking rows must be exactly as many as
 * the confirmed findings, so a record that carries an extra blocking row (a hollow test, say) which findings.json does not show cannot be repaired by evidence. @param {Context} ctx @param {string} dir @param {string} rec @returns {string}
 */
function findingsAreEvidenceOnly(ctx, dir, rec) {
  let doc;
  try { doc = JSON.parse(readFileSync(FINDINGS(dir), 'utf8')); } catch { return 'reviews/test-trust/tests/findings.json cannot be read, so the open findings cannot be classified (safe side: change the tree, or ask)'; }
  const all = Array.isArray(doc?.findings) ? doc.findings : [];
  const confirmed = all.filter((/** @type {any} */ f) => f?.verdict === 'confirmed');
  if (confirmed.length === 0) return 'the tests review has no confirmed finding to repair';
  const other = confirmed.filter((/** @type {any} */ f) => !(f.kind === 'not_measured' && f.observed?.reason === REPAIRABLE_REASON));
  if (other.length > 0) return `the open finding(s) ${other.map((/** @type {any} */ f) => `${String(f.id)} (${String(f.kind)}${f.observed?.reason ? `/${String(f.observed.reason)}` : ''})`).join(', ')} are not of the evidence class (a plan test with no recorded duration): they need a tree change, a plan decision or the user`;
  const rows = blockingFindingIds(ctx, rec).length;
  if (rows !== confirmed.length) return `the failing record ${rec.slice(rec.lastIndexOf('/') + 1)} carries ${rows} blocking row(s) and findings.json ${confirmed.length} confirmed finding(s): they are not the same findings, so the record is not shown to be of the evidence class`;
  return '';
}

/** The latest `handoff IMPLEMENTING` row that reopened a failed gate (from IMPLEMENTED): the start of the current fix round. @param {Context} ctx @param {string} dir */
function reopenSeq(ctx, dir) {
  const rows = ledgerRows(ctx, dir, 'handoff:IMPLEMENTING').filter((r) => r.from === 'IMPLEMENTED');
  return rows.length === 0 ? 0 : rows[rows.length - 1].seq;
}

/**
 * May an evidence-only repair run now? Returns what the run needs, or ends the command with the reason. @param {Context} ctx @param {string} id
 * @returns {{ rec: string, recName: string, patch: string, target: string, commands: string[], names: string[] }}
 */
export function evidenceRepairPlan(ctx, id) {
  const dir = runDir(ctx, id);
  const no = (/** @type {string} */ why) => fail(`evidence-only repair refused: ${why}`);
  if (!gatesEnforced(ctx, dir)) no('the run has no lifecycle_gates policy');
  if (!measureRequired(ctx, id)) no('the run was started before the test measurement (#265); its durations are optional, there is no finding to repair');
  const used = fixRoundsUsed(ctx, dir); const max = maxFixRounds(ctx);
  if (used > max) no(`fix rounds exhausted (${used} rounds, max_fix_rounds ${max}): an evidence-only repair is a fix round too`);
  const rec = gateLatestFile(ctx, dir, 'REVIEW_TESTS', '-');
  if (rec === '' || gateField(ctx, rec, 'result') !== 'fail') no('there is no failing REVIEW_TESTS record: nothing to repair (the lead reopens a failed gate with handoff IMPLEMENTING first)');
  const patch = taskPatchFingerprint(ctx, dir);
  if (gateField(ctx, rec, 'patch_sha256') !== patch) no('the application/test tree is not the one that was reviewed; a changed tree is a normal fix (and the gate runs again by itself)');
  for (const g of requiredGates(ctx, dir)) if (g !== 'REVIEW_TESTS' && gateStatus(ctx, dir, id, g) === 'fail') no(`${g} has an open finding as well: only a REVIEW_TESTS finding of the evidence class can be closed without a tree change, so this round needs a tree change`);
  if (gateStatus(ctx, dir, id, 'REVIEW_TESTS') !== 'fail') no('the REVIEW_TESTS finding is not open on the current content (waived, or the content changed)');
  if (rec !== latestFindingFile(ctx, dir)) no('the latest finding of the run is not the REVIEW_TESTS record: another gate failed after it, so this round needs a tree change');
  const bad = findingsAreEvidenceOnly(ctx, dir, rec);
  if (bad !== '') no(bad);
  if (evidenceRepairRows(ctx, dir).some((r) => r.seq > reopenSeq(ctx, dir))) no('a repair already ran in this fix round; the lead reopens the gate (handoff IMPLEMENTING) for another round, within max_fix_rounds');
  const missing = planTestsWithoutDurationOf(ctx, id);
  const excused = approvedMeasureTargets(ctx, id);
  const required = missing.filter((n) => !excused.includes(n));
  if (required.length === 0) no('every test the plan names has a recorded duration or a user-approved `- measure:` exception, so re-recording would change nothing: the finding is not about the evidence');
  /** @type {any} */ let doc = null;
  try { doc = JSON.parse(readFileSync(FINDINGS(dir), 'utf8')); } catch { /* checked above */ }
  const stale = (doc?.findings ?? []).filter((/** @type {any} */ f) => f?.verdict === 'confirmed' && !missing.includes(String(f.observed?.subject ?? '')));
  if (stale.length > 0) no(`the finding(s) ${stale.map((/** @type {any} */ f) => String(f.id)).join(', ')} name a test that has a duration now or is not a plan test: the review is out of date`);
  const commands = planVerificationCommands(ctx, id);
  if (commands.length === 0) no('the frozen plan lists no command under ## Verification commands; the repair runs plan-listed commands only (an amendment and a refreeze list the narrow command that runs the tests)');
  const greens = greenRecords(ctx, id);
  const last = greens[greens.length - 1];
  const target = last === undefined ? '' : fieldOf(fileLines(ctx, `${dir}/worker-evidence/${last.file}`), 'target');
  if (target === '') no('there is no GREEN record to take the target paths from: record GREEN the normal way first');
  return { rec, recName: rec.slice(rec.lastIndexOf('/') + 1), patch, target, commands, names: required };
}

/** The first 8 MiB of a file as text (a runner that prints more is cut; the durations of the plan tests are looked up in what is read). @param {string} file */
function readCapped(file) {
  const cap = 8 * 1024 * 1024;
  const fd = openSync(file, 'r');
  try { const buf = Buffer.alloc(cap); const n = readSync(fd, buf, 0, cap, 0); return buf.subarray(0, n).toString('utf8'); } finally { closeSync(fd); }
}

// ---- the run ----------------------------------------------------------------------------------------------------------------------------

/**
 * Run the plan-listed commands (each once, in the project root, output kept in a private folder), read the per-test durations from the output and return one GREEN record per command that
 * carries plan-named tests. Every command must exit 0, every plan-named test must have a duration, and the task patch must be the same afterwards; otherwise nothing is recorded.
 * @param {Context} ctx @param {string} id @param {ReturnType<typeof evidenceRepairPlan>} plan
 * @returns {{ records: Array<{ command: string, durations: string }>, names: string[] }}
 */
export function evidenceRepairRun(ctx, id, plan) {
  const dir = runDir(ctx, id);
  const limit = verifyCommandTimeout(ctx.config());
  /** @type {Array<{ command: string, entries: Array<{ name: string, ms: number }> }>} */ const outputs = [];
  for (const command of plan.commands) {
    const tmpd = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'proofline-repair-'));
    let r; let text = '';
    try {
      const fd = openSync(`${tmpd}/out`, 'w');
      try {
        r = proc.runUserCommand(command, { cwd: ctx.root, env: ctx.childEnv(), input: '', stdio: ['pipe', fd, fd], timeoutMs: limit * 1000, group: true, killSignal: 'SIGKILL' });
      } finally { closeSync(fd); }
      text = readCapped(`${tmpd}/out`);
    } finally { rmSync(tmpd, { recursive: true, force: true }); }
    if (r.timedOut === true) fail(`evidence-only repair refused: \`${command}\` hit the time limit (${limit} s); nothing was recorded`);
    if (r.status !== 0) fail(`evidence-only repair refused: \`${command}\` exited ${r.status}; a GREEN record needs a passing run, nothing was recorded (a failing test is a normal fix)`);
    outputs.push({ command, entries: parseRunnerDurations(text) });
  }
  // the task patch is memoised per invocation, and so are the changed-path lists (git status), the content fingerprints and the file reads it rests on: drop all of them, so a path a command dirtied or created is seen
  for (const k of ['patch:', 'changed:', 'fp:', 'file:', 'hash:', 'git:']) ctx.forget(k);
  if (taskPatchFingerprint(ctx, dir) !== plan.patch) fail('evidence-only repair refused: a plan-listed command changed the application/test tree while it ran; nothing was recorded');
  const all = outputs.flatMap((o) => o.entries);
  const m = matchPlanDurations(plan.names, all);
  if (m.missing.length > 0) fail(`evidence-only repair refused: the output of the plan-listed command(s) shows no duration for ${m.missing.map((n) => `"${n}"`).join(', ')}; nothing was recorded. Use a reporter that prints one duration per test (and list the command that runs them under ## Verification commands), or ask for a plan decision`);
  /** @type {Array<{ command: string, durations: string }>} */ const records = [];
  const taken = new Set();
  for (const o of outputs) {
    const left = plan.names.filter((n) => !taken.has(n));
    const part = matchPlanDurations(left, o.entries).found;
    for (const n of part.keys()) taken.add(n);
    const mine = [...part.values()];
    if (mine.length > 0) records.push({ command: o.command, durations: mine.map((e) => `${e.name}=${e.ms}`).join('; ') });
  }
  return { records, names: plan.names };
}

// ---- the handoff ------------------------------------------------------------------------------------------------------------------------

/**
 * True when `handoff IMPLEMENTED` may accept the unchanged tree: a repair row of the sealed ledger names this finding record and this patch, it was made in the current fix round, and the findings
 * of the record are still all of the evidence class. Each row serves one handoff (the next reopen starts a new round and needs a new repair). @param {Context} ctx @param {string} id @param {string} f the failing record @param {string} patch
 */
export function evidenceRepairCovers(ctx, id, f, patch) {
  const dir = runDir(ctx, id);
  const name = f.slice(f.lastIndexOf('/') + 1);
  const since = reopenSeq(ctx, dir);
  const row = evidenceRepairRows(ctx, dir).find((r) => r.seq > since && repairFinding(r.detail) === name && new RegExp(`(^| )patch=${patch}( |$)`).test(r.detail));
  if (row === undefined) return false;
  if (ledgerRows(ctx, dir, 'handoff:IMPLEMENTED').some((r) => r.seq > row.seq)) return false;
  return findingsAreEvidenceOnly(ctx, dir, f) === '' && sectionValue(ctx, dir, 'handoff', 'state') === 'IMPLEMENTING';
}
