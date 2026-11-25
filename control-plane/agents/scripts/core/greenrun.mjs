// @ts-check
// The control plane records GREEN itself (A358, issue 338 item B9). Until now the implementer ran the tests, copied each duration into a `worker-evidence GREEN` form, and the IMPLEMENTED
// handoff refused the form for a missing duration, a duration that did not fit the wall time, a budget or a command the plan did not list (retro: 6 refusals in 3 of 8 tasks, about 15 to 25
// minutes per batch). Now `handoff IMPLEMENTED` runs the plan-listed Verification commands ONCE itself, reads the per-test durations from their output, and records them as GREEN evidence keyed
// by the plan's quoted test names. The control plane's own run is the evidence (Core invariant 4); an agent's claim is not. The only refusals here are a plan-listed command that FAILS or times
// out (a listed test fails). A command that exits 0 but ran no test (its output has no per-test line) is not GREEN: nothing is recorded for it and the older checks apply unchanged.
import { fail, ProoflineError } from './errors.mjs';
import { approvedMeasureTargets, matchPlanDurations, runnerEntries, runnerEntriesAll, runPlanCommand } from './evidencerepair.mjs';
import { recordControlGreen } from './gatecmd.mjs';
import { patchManifest, taskPatchFingerprint } from './gates.mjs';
import { ledgerIf } from './lifecycle.mjs';
import { fieldOf, fileLines, fileText, gatesEnforced } from './records.mjs';
import { planVerificationCommands } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { controlGreenFor, controlGreenToken, greenRecords, measureRequired, planKinds } from './testmeasure.mjs';
import { verifyCommandTimeout } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `//` and block comments dropped (conservative: a `//` inside a string drops the rest of that line, which can only make a title go unseen). @param {string} text */
function withoutComments(text) { return text.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''); }

/**
 * How many times `name` (lower case) is DECLARED as a test in `text` (lower case): the first argument of `it(`, `test(`, `describe(`, `suite(` or `t.test(` (also `.only`, `.skip`, `.todo`), a quoted
 * title of exactly that name, comments ignored. A string a test prints, a bare quoted word and a comment are no declaration (A358).
 * @param {string} text @param {string} name
 */
function declarations(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:it|test|describe|suite|t\\.test)(?:\\.(?:only|skip|todo))?\\s*\\(\\s*(['"\`])${esc}\\1`, 'g');
  const clean = withoutComments(text);
  let n = 0;
  for (const m of clean.matchAll(re)) {
    const line = clean.slice(clean.lastIndexOf('\n', m.index) + 1, m.index);
    // a match that starts inside a quoted string of its line (an odd number of quote marks before it) is printed text, not a call
    if (['"', "'", '`'].some((q) => line.split(q).length % 2 === 0)) continue;
    n++;
  }
  return n;
}

/** The files the plan command runs: the existing files its words name, else the changed test files. @param {string[]} commands @param {string[]} changed @param {(f: string) => boolean} exists */
function runFiles(commands, changed, exists) {
  const named = commands.flatMap((c) => c.split(/\s+/)).filter((w) => w !== '' && !w.startsWith('-') && exists(w));
  if (named.length > 0) return [...new Set(named)];
  return changed.filter((f) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.|_test\./.test(f));
}

/**
 * Run the plan-listed commands once and record the durations of the plan-named tests. Returns true when the control plane's own GREEN covers this content (recorded now or before).
 * Returns false (nothing changed) when the run does not take part: no measurement stamp, no plan-named test, no plan-listed command, no earlier GREEN record to take the target from, or an
 * output without a per-test duration for any plan-named test.
 * @param {Context} ctx @param {string} id @param {string} patch the task patch fingerprint of the content being handed off
 */
export function controlPlaneGreen(ctx, id, patch) {
  const dir = runDir(ctx, id);
  if (!measureRequired(ctx, id) || !gatesEnforced(ctx, dir)) return false;
  const names = [...new Set(planKinds(fileText(ctx, `${dir}/PLAN.md`) ?? '').names.map((n) => n.name))];
  const commands = planVerificationCommands(ctx, id);
  if (names.length === 0 || commands.length === 0) return false;
  if (controlGreenFor(ctx, id, patch)) return true;
  const excused = approvedMeasureTargets(ctx, id);
  const owed = names.filter((n) => !excused.includes(n));
  const want = owed.filter((n) => !n.includes('=') && !n.includes(';'));
  if (want.length === 0) return false;
  // a plan name counts only when it is DECLARED as a test (the first argument of a test call, exactly one declaration) in the files the command runs: a line a test prints, a quoted word or a
  // comment in a file, or a title in another file is no test
  const changed = patchManifest(ctx, dir).map((l) => l.slice(0, l.indexOf('|'))).filter((p) => p !== '');
  const files = runFiles(commands, changed, (f) => fileText(ctx, `${ctx.root}/${f}`) !== null);
  const texts = files.map((f) => asciiLower(fileText(ctx, `${ctx.root}/${f}`) ?? ''));
  const titled = (/** @type {string} */ n) => texts.reduce((k, t) => k + declarations(t, n), 0) === 1;
  const greens = greenRecords(ctx, id);
  const last = greens[greens.length - 1];
  const target = last === undefined ? '' : fieldOf(fileLines(ctx, `${dir}/worker-evidence/${last.file}`), 'target');
  if (target === '') return false;
  const limit = verifyCommandTimeout(ctx.config());
  /** @type {Array<{ command: string, entries: Array<{ name: string, ms: number }> }>} */ const outputs = [];
  for (const command of commands) {
    const r = runPlanCommand(ctx, command, limit);
    if (r.timedOut) fail(`IMPLEMENTED blocked: the control plane ran the plan-listed command \`${command}\` itself and it hit the time limit (${limit} s); nothing was recorded`);
    if (r.status !== 0) fail(`IMPLEMENTED blocked: the control plane ran the plan-listed command \`${command}\` itself and it exited ${r.status}: a listed test fails. Fix it (a failing test is a normal fix), then record IMPLEMENTED again`);
    // a name that shows on two result lines is ambiguous (an echoed line next to the real one): it is left out
    const all = runnerEntriesAll(r.text);
    outputs.push({ command, entries: runnerEntries(r.text).filter((e) => all.filter((a) => a.name === e.name).length === 1) });
  }
  // the memoised patch, change lists and reads are dropped, so a path a command dirtied or created is seen
  for (const k of ['patch:', 'changed:', 'fp:', 'file:', 'hash:', 'git:']) ctx.forget(k);
  if (taskPatchFingerprint(ctx, dir) !== patch) fail('IMPLEMENTED blocked: a plan-listed command changed the application/test tree while the control plane ran it; nothing was recorded (a command of the plan must not write to the tree)');
  /** @type {Array<{ command: string, durations: string }>} */ const records = [];
  const taken = new Set();
  for (const o of outputs) {
    const part = matchPlanDurations(want.filter((n) => !taken.has(n) && titled(n)), o.entries).found;
    for (const n of part.keys()) taken.add(n);
    // keyed by the plan's own quoted name: the later steps (budgets, the double run, REVIEW_TESTS) match by that name
    if (part.size > 0) records.push({ command: o.command, durations: [...part].map(([n, e]) => `${n}=${e.ms}`).join('; ') });
  }
  const left = owed.filter((n) => !taken.has(n));
  const why = (/** @type {string} */ n) => (n.includes('=') || n.includes(';') ? 'its name has = or ;' : !titled(n) ? 'it is not declared exactly once as a test in the files the command runs' : 'no single result line shows it');
  const note = left.length === 0 ? '' : `note: the control plane's own GREEN does not stand for ${left.map((n) => `"${n}" (${why(n)})`).join(', ')}\n`;
  if (records.length === 0) {
    ctx.err(note);
    ctx.err(`note: the control plane ran the plan-listed command(s) once, but their output shows no per-test duration for a plan-named test (a command that runs no test is not GREEN); the recorded GREEN evidence is checked as before\n`);
    return false;
  }
  try {
    for (const r of records) recordControlGreen(ctx, id, r.command, target, r.durations);
  } catch (e) {
    if (!(e instanceof ProoflineError)) throw e;
    ctx.err(`note: the control plane's own GREEN record was refused (${e.message.split('\n')[0]}); the recorded GREEN evidence is checked as before\n`);
    return false;
  }
  ctx.forget('file:');
  if (note !== '') ctx.err(note);
  // all or nothing: only a run that gave a duration to EVERY plan test the user did not excuse makes the control plane's GREEN the evidence for the content; a partial run leaves the
  // tests it did not cover to the older checks (an agent's claim for them is still no evidence)
  const full = taken.size === owed.length;
  if (full) ledgerIf(ctx, id, 'green-control', '-', '-', `token=${controlGreenToken(ctx, id, patch)} commands=${records.length} tests=${taken.size}/${owed.length}`);
  ctx.err(`GREEN recorded by the control plane: ${taken.size} of ${owed.length} plan-named test(s) from its own run of ${records.length} plan-listed command(s) (durations keyed by the plan's test names)${full ? '' : '; the others are checked as before'}\n`);
  return full;
}
