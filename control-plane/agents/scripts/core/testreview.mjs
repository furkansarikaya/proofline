// @ts-check
// The inputs of the REVIEW_TESTS reviewer for the speed and determinism of the tests (issue 265 package C, A276; AC-7): `agent.sh build-record <ID> scan` prints, read-only,
//  - the scan candidates (real waits and direct clock reads) of the files the task added or changed. A changed file that an ecosystem claims is scanned for waits when its path
//    or its text says it holds tests (the data: test folders and names, test markers), whatever its name; every other claimed file is scanned for clock reads;
//  - the files nobody could scan (`NOT SCANNED`: a file that is unreadable or too large is not a clean file);
//  - the plan's `## Test exceptions` (the only justification the gate accepts for a wait, a test over budget or a test that was not measured);
//  - the measurement facts of package B: the durations and BUDGET findings of the GREEN evidence, the plan's tests that have no recorded duration, the `test-measure` ledger
//    row (`double_run=0` means nothing was run twice) and, for each GREEN command, whether it is the one the control plane double-ran (plan-listed or the pinned project test
//    command) or neither, so the reviewer can confirm which command really executes which tests.
// It decides nothing: candidates and facts are inputs, the reviewer traces them and the findings validator computes the gate. `missingFindings` is what `submit` uses to
// require a finding (or an explicit, valid clearing) for every one of them in a run that carries the measurement stamp.
import { existsSync } from 'node:fs';
import { clean } from './codetrust.mjs';
import { ecosystemRowsAll } from './ecodata.mjs';
import { patchManifest, testCodePath } from './gates.mjs';
import { sha256 } from './hash.mjs';
import { fileText, ledgerLines, textLines } from './records.mjs';
import { planVerificationCommands } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { greenRecords, measureRequired, measureRun, planKinds, recordedTestPin, testCmdPin } from './testmeasure.mjs';
import { claimedBy, isTestFile, reportJson, reportText, scanFiles, scanRules, testPathGlobs } from './waitscan.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const MAX_EXC_LINE = 4096;

/**
 * One `## Test exceptions` line: `- wait|budget|measure: <target> -- <reason>` (the separator is `--` or an em dash between blanks), a reason of at least 20 characters. Linear: a line
 * longer than 4096 characters is no exception, and the separator is found by a search, not by backtracking over the blanks.
 * @param {string} line @returns {{ kind: string, target: string, reason: string } | null}
 */
export function parseException(line) {
  if (line.length > MAX_EXC_LINE) return null;
  const head = /^[ \t]*[-*][ \t]*(wait|budget|measure):/.exec(line);
  if (!head) return null;
  const rest = line.slice(head[0].length);
  const sep = rest.search(/[ \t](?:--|—)[ \t]/);
  if (sep < 0) return null;
  const target = rest.slice(0, sep).trim();
  const reason = rest.slice(sep).replace(/^[ \t](?:--|—)[ \t]/, '').trim();
  return target === '' || reason.length < 20 ? null : { kind: head[1], target, reason };
}

/** The lines of a `## <name>` section of a PLAN.md, without a regular expression over the whole text. @param {string} plan @param {string} name */
export function sectionOf(plan, name) {
  /** @type {string[]} */ const out = []; let inside = false;
  for (const l of textLines(plan)) { if (l.startsWith('## ')) { inside = l.slice(3).trim() === name; continue; } if (inside) out.push(l); }
  return out;
}

/** @param {string} plan @returns {Array<{ kind: string, target: string, reason: string }>} */
export function planExceptions(plan) {
  return sectionOf(plan, 'Test exceptions').map(parseException).filter((x) => x !== null).map((x) => /** @type {{ kind: string, target: string, reason: string }} */ (x));
}

/** The hash of the lines of the plan's `## Test exceptions` (blank lines left out); the empty string when there are none. A refreeze that changes it needs the user. @param {string} plan */
export function exceptionsHash(plan) {
  const l = sectionOf(plan, 'Test exceptions').map((x) => x.trim()).filter((x) => x !== '');
  return l.length === 0 ? '' : sha256(`${l.join('\n')}\n`);
}

/**
 * Everything the reviewer reads, and the list of what a findings.json has to answer.
 * @param {Context} ctx @param {string} id
 */
export function collect(ctx, id) {
  const dir = runDir(ctx, id);
  const rows = ecosystemRowsAll(ctx);
  const rules = scanRules(rows);
  const testGlobs = testPathGlobs(rows);
  const files = patchManifest(ctx, dir).map((l) => l.slice(0, l.indexOf('|'))).filter((p) => p !== '' && existsSync(`${ctx.root}/${p}`)).sort();
  // fail safe: every changed file an ecosystem claims is scanned; a test (by name, folder or content) for waits and clock reads, any other for clock reads
  const claimed = files.filter((f) => claimedBy(f, rules).length > 0);
  const scan = scanFiles(ctx.root, claimed, rules, (f, text) => (isTestFile(f, text, rules, testGlobs) || testCodePath(ctx, f) ? ['wait', 'clock_read'] : ['clock_read']));
  const waitFiles = new Set(scan.candidates.filter((c) => c.kind === 'wait').map((c) => c.file));
  const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  const exceptions = planExceptions(plan);
  const m = measureRun(ctx, id);
  const pk = planKinds(plan);
  const greens = greenRecords(ctx, id);
  const recorded = greens.flatMap((g) => g.durations.map((d) => asciiLower(d.name)));
  const planTestsWithoutDuration = [...new Set(pk.names.map((n) => n.name).filter((n) => !recorded.some((r) => r === n || r.includes(n) || n.includes(r))))].sort();
  const row = [...ledgerLines(ctx, dir)].reverse().find((l) => l.includes(' event=test-measure '));
  const detail = row === undefined ? '' : (/ detail=(.*)$/.exec(row)?.[1] ?? '');
  const num = (/** @type {string} */ k) => { const v = new RegExp(`\\b${k}=(\\d+)`).exec(detail)?.[1]; return v === undefined ? null : Number(v); };
  const pinned = new Set((recordedTestPin(ctx, id) ?? '').split(',').filter((h) => h !== ''));
  const listed = new Set(planVerificationCommands(ctx, id));
  const cmds = [...new Set(greens.map((g) => g.command).filter((c) => c !== ''))].sort();
  const commands = cmds.map((c) => ({ command: c, source: listed.has(c) ? 'plan-listed' : pinned.has(testCmdPin([c])) ? 'project test command' : 'neither' }));
  const double = num('double_run');
  const measurement = {
    test_measure_row: row === undefined ? 'none' : detail,
    double_run_commands: double,
    not_measured: double === null || double === 0,
    green_commands: commands,
    plan_tests_without_duration: planTestsWithoutDuration,
    durations: m.tests.map((t) => ({ name: t.name, kind: t.kind, ms: Number(t.ms.toFixed(3)) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    budget_findings: m.budgetFindings,
    unscanned: scan.skipped,
  };

  /** @typedef {{ text: string, kind: string, match: (f: any) => boolean }} Obligation */
  /** @type {Obligation[]} */ const need = [];
  const nm = (/** @type {string} */ reason, /** @type {string} */ subject) => (/** @type {any} */ f) => f.kind === 'not_measured' && f.observed?.reason === reason && (subject === '' || String(f.observed?.detail ?? '').includes(subject));
  for (const c of scan.candidates) {
    const kind = c.kind === 'wait' ? 'real_wait' : 'clock_not_injected';
    need.push({ text: `the ${c.kind} candidate ${c.file}:${c.line} ${c.pattern}`, kind, match: (f) => f.kind === kind && f.observed?.candidate?.file === c.file && f.observed?.candidate?.line === c.line && f.observed?.candidate?.pattern === c.pattern });
  }
  for (const b of m.budgetFindings) {
    const t = /^BUDGET test "([^"]*)"/.exec(b); const su = /^BUDGET suite (\S+)/.exec(b);
    const name = t ? asciiLower(t[1]) : su ? `suite ${su[1]}` : '';
    need.push({ text: b, kind: 'over_budget', match: (f) => f.kind === 'over_budget' && (asciiLower(String(f.test?.name ?? '')) === name || (name !== '' && asciiLower(String(f.test?.name ?? '')).includes(name))) });
  }
  for (const f of scan.skipped) need.push({ text: `the file ${f} that nobody could scan`, kind: 'not_measured', match: nm('file_not_scanned', f) });
  if (row === undefined) need.push({ text: 'the missing test-measure ledger row (the run was never measured)', kind: 'not_measured', match: nm('no_test_measure_row', '') });
  else if (double === 0) need.push({ text: 'double_run=0 (no GREEN command was run twice)', kind: 'not_measured', match: nm('not_double_run', '') });
  if (row !== undefined && ((num('stability_findings') ?? 0) > 0 || (num('blockers') ?? 0) > 0)) need.push({ text: `a stability or duration finding in the test-measure row (${detail})`, kind: 'not_measured', match: nm('measurement_finding', '') });
  for (const n of planTestsWithoutDuration) need.push({ text: `the plan test "${n}" that has no recorded duration`, kind: 'not_measured', match: nm('no_recorded_duration', n) });
  for (const c of commands) if (c.source === 'neither') need.push({ text: `the GREEN command \`${c.command}\` that the control plane did not run twice`, kind: 'not_measured', match: nm('command_not_double_run', c.command) });
  return { files, scan, waitFiles, exceptions, measurement, commands, testFiles: files.filter((f) => scan.scanned.includes(f) && (testCodePath(ctx, f) || scan.candidates.some((c) => c.file === f && c.kind === 'wait'))), need };
}

/**
 * The review inputs of a run, as the text or JSON `build-record <ID> scan` prints. Exit status 1 when it lists a candidate or a file it could not scan.
 * @param {Context} ctx @param {string} id @param {boolean} json @returns {{ status: number, out: string }}
 */
export function reviewInputs(ctx, id, json) {
  const c = collect(ctx, id);
  const m = c.measurement;
  const report = { scanned: c.scan.scanned, skipped: c.scan.skipped, candidates: c.scan.candidates, allowed: [], unused: [] };
  const status = c.scan.candidates.length > 0 || c.scan.skipped.length > 0 ? 1 : 0;
  if (json) {
    const base = JSON.parse(reportJson(report));
    const cl = (/** @type {string} */ x) => clean(x);
    return { status, out: `${JSON.stringify({ ...base, task_test_files: c.testFiles.map(cl), plan_exceptions: c.exceptions.map((e) => ({ kind: e.kind, target: cl(e.target), reason: cl(e.reason) })), measurement: { ...m, green_commands: m.green_commands.map((g) => ({ command: cl(g.command), source: g.source })), plan_tests_without_duration: m.plan_tests_without_duration.map(cl), durations: m.durations.map((d) => ({ ...d, name: cl(d.name) })), budget_findings: m.budget_findings.map(cl), unscanned: m.unscanned.map(cl), test_measure_row: cl(m.test_measure_row) } }, null, 2)}\n` };
  }
  let t = reportText(report);
  t += `task-test-files: ${c.testFiles.length === 0 ? 'none' : c.testFiles.map(clean).join(' ')}\n`;
  for (const e of c.exceptions) t += `plan-exception: ${e.kind} ${clean(e.target)} -- ${clean(e.reason)}\n`;
  t += 'measurement:\n';
  t += `  test-measure-row: ${m.test_measure_row === 'none' ? 'none (the control plane has not measured this run)' : clean(m.test_measure_row)}\n`;
  if (m.not_measured) t += '  NOT MEASURED: no GREEN command was run twice (double_run=0 or no row); the durations below are the recorder\'s word, so every duration and every budget below is unconfirmed\n';
  for (const g of m.green_commands) t += `  green-command: \`${clean(g.command)}\` source=${g.source}${g.source === 'neither' ? ' (the control plane did not run it twice)' : ''}; confirm that it executes the task's test files${c.testFiles.length > 0 ? ` (${c.testFiles.map(clean).join(' ')})` : ''}\n`;
  for (const n of m.plan_tests_without_duration) t += `  NOT MEASURED: the plan names the test "${clean(n)}" and no recorded duration matches it\n`;
  for (const d of m.durations) t += `  duration: ${clean(d.name)} (${d.kind}) ${d.ms} ms\n`;
  for (const f of m.budget_findings) t += `  finding: ${clean(f)}\n`;
  return { status, out: t };
}

/**
 * What a tests findings.json leaves unanswered: in a run that carries the measurement stamp, every candidate, BUDGET finding and NOT MEASURED fact needs a finding of its own kind
 * about it (confirmed, or cleared by the rules the validator checks). A missing one is a validation error, so a reviewer cannot pass a fact over by not mentioning it.
 * @param {Context} ctx @param {string} id @param {any} doc @returns {string[]}
 */
export function missingFindings(ctx, id, doc) {
  if (!measureRequired(ctx, id)) return [];
  const findings = Array.isArray(doc?.findings) ? doc.findings : [];
  return collect(ctx, id).need.filter((o) => !findings.some(o.match)).map((o) => `findings.json has no ${o.kind} finding for ${clean(o.text)} (agent.sh build-record ${id} scan lists it; report it, or clear it with the rules of test-trust FAST.md)`);
}
