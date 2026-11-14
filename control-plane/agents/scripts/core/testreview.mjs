// @ts-check
// The inputs of the REVIEW_TESTS reviewer for the speed and determinism of the tests (issue 265 package C, A276; AC-7): `agent.sh build-record <ID> scan` prints, read-only,
//  - the scan candidates (real waits and direct clock reads) of the files the task added or changed: waits and clock reads in test files, clock reads in other code files;
//  - the plan's `## Test exceptions` (the only justification the gate accepts for a wait or a test over budget);
//  - the measurement facts of package B: the durations and BUDGET findings of the GREEN evidence, the plan's tests that have no recorded duration, the `test-measure` ledger
//    row (`double_run=0` means nothing was run twice) and, for each GREEN command, whether it is the one the control plane double-ran (plan-listed or the pinned project test
//    command) or neither, so the reviewer can confirm which command really executes which tests.
// It decides nothing: candidates and facts are inputs, the reviewer traces and the findings validator computes the gate.
import { ecosystemRows } from './ecodata.mjs';
import { patchManifest, testCodePath } from './gates.mjs';
import { ledgerLines, fileText, textLines } from './records.mjs';
import { planVerificationCommands } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { greenRecords, measureRun, planKinds, recordedTestPin, testCmdPin } from './testmeasure.mjs';
import { claimedBy, reportJson, reportText, scanFiles, scanRules } from './waitscan.mjs';
import { existsSync } from 'node:fs';

/** @typedef {import('./context.mjs').Context} Context */

const EXC = /^\s*[-*]\s*(wait|budget):\s*(.+?)\s+(?:—|--)\s+(\S.{19,})$/;

/**
 * The `## Test exceptions` of a PLAN.md: `- wait: <test file or "test name"> -- <reason>` or `- budget: ...`, a reason of at least 20 characters.
 * @param {string} plan @returns {Array<{ kind: string, target: string, reason: string }>}
 */
export function planExceptions(plan) {
  /** @type {Array<{ kind: string, target: string, reason: string }>} */ const out = [];
  let sec = '';
  for (const l of textLines(plan)) {
    if (l.startsWith('## ')) { sec = l.slice(3).trim(); continue; }
    if (sec !== 'Test exceptions') continue;
    const m = EXC.exec(l);
    if (m) out.push({ kind: m[1], target: m[2].trim(), reason: m[3].trim() });
  }
  return out;
}

/**
 * The review inputs of a run.
 * @param {Context} ctx @param {string} id @param {boolean} json @returns {{ status: number, out: string }}
 */
export function reviewInputs(ctx, id, json) {
  const dir = runDir(ctx, id);
  const rules = scanRules(ecosystemRows(ctx));
  const files = patchManifest(ctx, dir).map((l) => l.slice(0, l.indexOf('|'))).filter((p) => p !== '' && existsSync(`${ctx.root}/${p}`)).sort();
  /** @param {string} f */
  const isTest = (f) => testCodePath(ctx, f);
  const scan = scanFiles(ctx.root, files.filter((f) => claimedBy(f, rules).length > 0), rules, (f) => (isTest(f) ? ['wait', 'clock_read'] : ['clock_read']));
  const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  const exceptions = planExceptions(plan);
  const m = measureRun(ctx, id);
  const pk = planKinds(plan);
  const greens = greenRecords(ctx, id);
  const recorded = greens.flatMap((g) => g.durations.map((d) => asciiLower(d.name)));
  const notMeasured = pk.names.map((n) => n.name).filter((n) => !recorded.some((r) => r === n || r.includes(n) || n.includes(r)));
  const row = [...ledgerLines(ctx, dir)].reverse().find((l) => l.includes(' event=test-measure '));
  const detail = row === undefined ? '' : (/ detail=(.*)$/.exec(row)?.[1] ?? '');
  const double = /\bdouble_run=(\d+)/.exec(detail)?.[1];
  const pinned = new Set((recordedTestPin(ctx, id) ?? '').split(',').filter((h) => h !== ''));
  const listed = new Set(planVerificationCommands(ctx, id));
  const cmds = [...new Set(greens.map((g) => g.command).filter((c) => c !== ''))].sort();
  const testFiles = files.filter(isTest);
  const commands = cmds.map((c) => ({ command: c, source: listed.has(c) ? 'plan-listed' : pinned.has(testCmdPin([c])) ? 'project test command' : 'neither' }));
  const measurement = {
    test_measure_row: row === undefined ? 'none' : detail,
    double_run_commands: double === undefined ? null : Number(double),
    not_measured: double === undefined || Number(double) === 0,
    green_commands: commands,
    plan_tests_without_duration: [...new Set(notMeasured)].sort(),
    durations: m.tests.map((t) => ({ name: t.name, kind: t.kind, ms: Number(t.ms.toFixed(3)) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    budget_findings: m.budgetFindings,
  };
  const open = scan.candidates;
  const report = { scanned: scan.scanned, skipped: scan.skipped, candidates: open, allowed: [], unused: [] };
  if (json) {
    const base = JSON.parse(reportJson(report));
    return { status: open.length > 0 ? 1 : 0, out: `${JSON.stringify({ ...base, task_test_files: testFiles, plan_exceptions: exceptions, measurement }, null, 2)}\n` };
  }
  let t = reportText(report);
  t += `task-test-files: ${testFiles.length === 0 ? 'none' : testFiles.join(' ')}\n`;
  for (const e of exceptions) t += `plan-exception: ${e.kind} ${e.target} -- ${e.reason}\n`;
  t += 'measurement:\n';
  t += `  test-measure-row: ${measurement.test_measure_row === 'none' ? 'none (the control plane has not measured this run)' : measurement.test_measure_row}\n`;
  if (measurement.not_measured) t += '  NOT MEASURED: no GREEN command was run twice (double_run=0 or no row); the durations below are the recorder\'s word, so every duration and every budget below is unconfirmed\n';
  for (const c of commands) t += `  green-command: \`${c.command}\` source=${c.source}${c.source === 'neither' ? ' (the control plane did not run it twice)' : ''}; confirm that it executes the task's test files${testFiles.length > 0 ? ` (${testFiles.join(' ')})` : ''}\n`;
  for (const n of measurement.plan_tests_without_duration) t += `  NOT MEASURED: the plan names the test "${n}" and no recorded duration matches it\n`;
  for (const d of measurement.durations) t += `  duration: ${d.name} (${d.kind}) ${d.ms} ms\n`;
  for (const f of m.budgetFindings) t += `  finding: ${f}\n`;
  return { status: open.length > 0 ? 1 : 0, out: t };
}
