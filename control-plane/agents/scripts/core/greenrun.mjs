// @ts-check
// The control plane records GREEN itself (A358, issue 338 item B9). Until now the implementer ran the tests, copied each duration into a `worker-evidence GREEN` form, and the IMPLEMENTED
// handoff refused the form for a missing duration, a duration that did not fit the wall time, a budget or a command the plan did not list (retro: 6 refusals in 3 of 8 tasks, about 15 to 25
// minutes per batch). Now `handoff IMPLEMENTED` runs the plan-listed Verification commands ONCE itself, reads the per-test durations from their output, and records them as GREEN evidence keyed
// by the plan's quoted test names. The control plane's own run is the evidence (Core invariant 4); an agent's claim is not. The only refusals here are a plan-listed command that FAILS or times
// out (a listed test fails). A command that exits 0 but ran no test (its output has no per-test line) is not GREEN: nothing is recorded for it and the older checks apply unchanged.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail, ProoflineError } from './errors.mjs';
import { approvedMeasureTargets, matchPlanDurations, runnerEntries, runnerEntriesAll, runPlanCommand } from './evidencerepair.mjs';
import { recordControlGreen } from './gatecmd.mjs';
import { taskPatchFingerprint } from './gates.mjs';
import { ledgerIf } from './lifecycle.mjs';
import { fieldOf, fileLines, fileText, gatesEnforced } from './records.mjs';
import { planVerificationCommands } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { controlGreenFor, controlGreenToken, greenRecords, measureRequired, planKinds } from './testmeasure.mjs';
import { verifyCommandTimeout } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** Thrown when the scanner is in doubt: the file then records nothing. */
class Doubt extends Error {}
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);
const IDCH = /[\p{L}\p{N}_$]/u;

/**
 * A small JavaScript scanner: strings, templates (nested `${}`), regex literals and comments are read across lines, so only real code tokens come out. Any doubt (an unterminated string, a regex
 * that cannot be told from a division, an escaped identifier) throws `Doubt`. Tokens: `{ k: 'id' | 'p' | 's', v }` (`s` is a string; `v` is null for a template with a substitution).
 * @param {string} src @returns {Array<{ k: 'id' | 'p' | 's', v: string | null }>}
 */
function scan(src) {
  /** @type {Array<{ k: 'id' | 'p' | 's', v: string | null }>} */ const out = [];
  let i = src.startsWith('#!') ? src.indexOf('\n') : 0;
  if (i < 0) return out;
  /** @param {number} start index just after an opening backtick @returns {{ end: number, plain: boolean, value: string }} */
  const template = (start) => {
    let j = start; let value = ''; let plain = true;
    for (;;) {
      if (j >= src.length) throw new Doubt('template');
      const c = src[j];
      if (c === '\\') { value += src.slice(j, j + 2); j += 2; } else if (c === '`') return { end: j + 1, plain, value };
      else if (c === '$' && src[j + 1] === '{') { plain = false; j = code(j + 2, true); } else { value += c; j++; }
    }
  };
  /** @param {number} from @param {boolean} inside true: stop at the `}` that closes a template substitution, returning the index after it (its tokens are dropped) */
  const code = (from, inside) => {
    let j = from; let depth = 0;
    /** @type {typeof out} */ const sink = inside ? [] : out;
    while (j < src.length) {
      const c = src[j];
      if (/\s/.test(c)) { j++; continue; }
      if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e < 0 ? src.length : e; continue; }
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); if (e < 0) throw new Doubt('comment'); j = e + 2; continue; }
      if (c === '"' || c === "'") {
        let k = j + 1; let value = '';
        for (;;) {
          if (k >= src.length || src[k] === '\n') throw new Doubt('string');
          if (src[k] === '\\') { value += src.slice(k, k + 2); if (src[k + 1] === '\r' || src[k + 1] === '\n') throw new Doubt('continued string'); k += 2; } else if (src[k] === c) break;
          else { value += src[k]; k++; }
        }
        sink.push({ k: 's', v: value }); j = k + 1; continue;
      }
      if (c === '`') { const t = template(j + 1); sink.push({ k: 's', v: t.plain ? t.value : null }); j = t.end; continue; }
      if (c === '\\') throw new Doubt('escape');
      if (IDCH.test(c)) { let k = j; while (k < src.length && IDCH.test(src[k])) k++; sink.push({ k: 'id', v: src.slice(j, k) }); j = k; continue; }
      if (c === '/') {
        const prev = sink[sink.length - 1];
        const division = prev !== undefined && ((prev.k === 'id' && !KEYWORDS_BEFORE_REGEX.has(prev.v ?? '')) || prev.k === 's' || (prev.k === 'p' && (prev.v === ')' || prev.v === ']')));
        if (prev !== undefined && prev.k === 'p' && (prev.v === '}' || prev.v === '+' || prev.v === '-')) throw new Doubt('slash');
        if (!division) {
          let k = j + 1; let cls = false;
          for (;;) {
            if (k >= src.length || src[k] === '\n') throw new Doubt('regex');
            if (src[k] === '\\') k += 2; else if (src[k] === '[') { cls = true; k++; } else if (src[k] === ']') { cls = false; k++; } else if (src[k] === '/' && !cls) break; else k++;
          }
          k++; while (k < src.length && IDCH.test(src[k])) k++;
          sink.push({ k: 's', v: null }); j = k; continue;
        }
      }
      if (inside) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) return j + 1; depth--; } }
      sink.push({ k: 'p', v: c }); j++;
    }
    if (inside) throw new Doubt('substitution');
    return j;
  };
  code(i, false);
  return out;
}

const RUNNER = new Set(['test', 'it']);
const SHADOWABLE = new Set(['test', 'it', 'describe', 'suite']);

/**
 * The titles DECLARED as tests in one file, name (lower case) to count; null when the file records nothing: the scanner is in doubt, the file does not import the runner (`node:test`), or it
 * declares its own `test`/`it`/`describe`/`suite`/`t` (a local helper shadowing the runner). A declaration is `test(`, `it(` (also `.only`) or `t.test(` with a quoted first argument and a comma,
 * not after a `.`, not an object method (`test('x') {`). `.skip`, `.todo`, `describe` and `suite` are no plan test (a suite title is printed as a result line but is not a test). A dead branch
 * (`if (false) { test('x') }`) cannot be told apart statically: accepted residual (A358); REVIEW_TESTS reads and mutation-tests the tests.
 * @param {string} text @returns {Map<string, number> | null}
 */
export function testTitles(text) {
  /** @type {ReturnType<typeof scan>} */ let toks;
  try { toks = scan(text); } catch (e) { if (e instanceof Doubt) return null; throw e; }
  const at = (/** @type {number} */ i) => toks[i];
  const word = (/** @type {number} */ i, /** @type {string} */ v) => at(i)?.k === 'id' && at(i).v === v;
  const punct = (/** @type {number} */ i, /** @type {string} */ v) => at(i)?.k === 'p' && at(i).v === v;
  const bound = new Set(); let shadow = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'id' || punct(i - 1, '.')) continue;
    const v = t.v ?? '';
    if (v === 'import' && !punct(i + 1, '(') && !punct(i + 1, '.')) {
      let j = i + 1; while (j < toks.length && toks[j].k !== 's' && !punct(j, ';')) j++;
      const ids = toks.slice(i + 1, j);
      if (at(j)?.k === 's' && at(j).v === 'node:test') {
        for (let k = 0; k < ids.length; k++) {
          if (ids[k].k !== 'id' || ids[k].v === 'from') continue;
          if (ids[k + 1]?.k === 'id' && ids[k + 1].v === 'as') { if (SHADOWABLE.has(ids[k + 2]?.v ?? '') && RUNNER.has(ids[k].v ?? '')) bound.add(ids[k + 2].v); k += 2; } else if (RUNNER.has(ids[k].v ?? '')) bound.add(ids[k].v);
        }
      } else if (ids.some((x) => x.k === 'id' && (SHADOWABLE.has(x.v ?? '') || x.v === 't'))) shadow = true;
      i = j;
    } else if (v === 'function' || v === 'class') {
      let j = i + 1; if (punct(j, '*')) j++;
      if (at(j)?.k === 'id' && (SHADOWABLE.has(at(j).v ?? '') || at(j).v === 't')) shadow = true;
    } else if (v === 'const' || v === 'let' || v === 'var') {
      let j = i + 1; const names = [];
      while (j < toks.length && j < i + 200 && !punct(j, ';') && !word(j, 'of') && !word(j, 'in') && !(punct(j, '=') && !punct(j + 1, '=') && !punct(j + 1, '>'))) { if (toks[j].k === 'id') names.push(toks[j].v ?? ''); j++; }
      const req = punct(j, '=') && word(j + 1, 'require') && punct(j + 2, '(') && at(j + 3)?.k === 's' && at(j + 3).v === 'node:test' && punct(j + 4, ')');
      if (req) { for (const n of names) if (RUNNER.has(n)) bound.add(n); } else if (names.some((n) => SHADOWABLE.has(n) || n === 't')) shadow = true;
    } else if (SHADOWABLE.has(v)) {
      // an assignment (`test = ...`, also a later declarator), an arrow parameter (`it => ...`) or a parameter list entry (`(test)`, `(a, it)`)
      if ((punct(i + 1, '=') && !punct(i + 2, '=') && !punct(i + 2, '>')) || (punct(i + 1, '=') && punct(i + 2, '>'))) shadow = true;
      if ((punct(i - 1, '(') || punct(i - 1, ',')) && (punct(i + 1, ')') || punct(i + 1, ','))) shadow = true;
    }
  }
  if (shadow || bound.size === 0) return null;
  /** @type {Map<string, number>} */ const titles = new Map();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'id' || punct(i - 1, '.') || word(i - 1, 'function') || word(i - 1, 'class') || word(i - 1, 'new')) continue;
    let j = -1;
    if (RUNNER.has(t.v ?? '') && bound.has(t.v ?? '')) j = punct(i + 1, '(') ? i + 1 : punct(i + 1, '.') && word(i + 2, 'only') && punct(i + 3, '(') ? i + 3 : -1;
    else if (t.v === 't' && punct(i + 1, '.') && word(i + 2, 'test') && punct(i + 3, '(')) j = i + 3;
    if (j < 0 || at(j + 1)?.k !== 's' || at(j + 1).v === null || !punct(j + 2, ',')) continue;
    let depth = 0; let k = j;
    for (; k < toks.length; k++) { if (punct(k, '(')) depth++; else if (punct(k, ')') && --depth === 0) break; }
    if (k >= toks.length || punct(k + 1, '{')) continue;
    const name = asciiLower(at(j + 1).v ?? '');
    titles.set(name, (titles.get(name) ?? 0) + 1);
  }
  return titles;
}

const TESTISH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.|_test\.|(^|\/)test-[^/]*$/;
const SOURCE = /\.(?:m?js|cjs|ts|mts|cts|jsx|tsx)$/;
const MAX_FILES = 400;

/**
 * The test files the plan commands run, as project-relative paths: the files, directories and globs their words name, resolved under the project (no `..`, no absolute path, no symlink, no
 * brace or class glob). Returns [] (nothing is recorded) when a word leaves the project, a glob is not simple, there are too many files or no word names a file: a command that runs a
 * directory or glob has no changed-file fallback (A358).
 * @param {string} root @param {string[]} commands
 */
export function runFiles(root, commands) {
  /** @type {Set<string>} */ const found = new Set();
  const inside = (/** @type {string} */ rel) => {
    const abs = path.join(root, rel);
    try { return !lstatSync(abs).isSymbolicLink() && realpathSync(abs).startsWith(`${realpathSync(root)}${path.sep}`); } catch { return false; }
  };
  /** @param {string} rel @param {number} depth @returns {string[]} */
  const walk = (rel, depth) => {
    if (depth > 8) return [];
    /** @type {string[]} */ const files = [];
    let entries; try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return []; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.isSymbolicLink()) continue;
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) files.push(...walk(r, depth + 1)); else if (e.isFile()) files.push(r);
    }
    return files;
  };
  for (const raw of commands.flatMap((c) => c.split(/\s+/))) {
    const w = raw.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
    if (w === '' || w.startsWith('-')) continue;
    if (path.isAbsolute(w) || w.split('/').includes('..') || /[`$~\\]/.test(w)) return [];
    if (/[[\]{}]/.test(w)) { if (/[*?]/.test(w)) return []; continue; }
    if (/[*?]/.test(w)) {
      const base = w.slice(0, Math.max(0, w.slice(0, w.search(/[*?]/)).lastIndexOf('/')));
      const re = new RegExp(`^${w.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`);
      for (const f of walk(base, 0)) if (re.test(f) && SOURCE.test(f)) found.add(f);
    } else if (inside(w)) {
      let st; try { st = statSync(path.join(root, w)); } catch { continue; }
      if (st.isFile()) found.add(w); else if (st.isDirectory()) for (const f of walk(w, 0)) if (SOURCE.test(f) && TESTISH.test(f)) found.add(f);
    }
    if (found.size > MAX_FILES) return [];
  }
  return [...found].filter((f) => inside(f));
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
    const files = runFiles(ctx.root, commands);
  const parsed = files.map((f) => testTitles(fileText(ctx, `${ctx.root}/${f}`) ?? ''));
  // any file the command runs that the scanner cannot read with certainty (or that shadows the runner, or does not import it) makes the whole run record nothing
  const sound = files.length > 0 && parsed.every((m) => m !== null);
  const titled = (/** @type {string} */ n) => sound && parsed.reduce((k, m) => k + (m?.get(asciiLower(n)) ?? 0), 0) === 1;
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
