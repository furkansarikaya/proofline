// @ts-check
// The step of the `windows-core-probe` job of .github/workflows/ci.yml (A260, Windows port W1): `node tests/ci/windows-probe.mjs`. It reads the leg from $PROBE_SUITE (the matrix value,
// `core 1/4` ... `invariants`) and the optional selection from $PROBE_TESTS (the `tests` input of the manual run): space-separated test files, globs or folders relative to the repository root.
// An empty selection runs the leg's default (today's behaviour: its shard of tests/core or tests/invariants-node). A selection runs ONLY those files: the files under tests/invariants-node go to
// the `invariants` leg, every other file is shared by the four `core k/4` legs with their `--test-shard=k/4` (a leg that gets no file prints 0 tests), and an `invariants` leg without invariant files prints a SKIPPED line. The input is data, never shell: it reaches this script through the environment, is checked
// with a strict pattern (selectTests) and goes to `node --test` as separate arguments (no shell is started). The leg prints one `PROBE-RESULT` line (pass, fail, duration from the test runner's own summary) and
// adds a row to the job summary ($GITHUB_STEP_SUMMARY), so a round can be read with `gh run view --log`. No clock is read here: the duration is the runner's `duration_ms`.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');

/** The default arguments of each leg (the matrix of the job), as `node --test` takes them. */
export const DEFAULTS = /** @type {Record<string, string[]>} */ ({
  'core 1/4': ['--test-shard=1/4', 'tests/core/*.test.mjs'],
  'core 2/4': ['--test-shard=2/4', 'tests/core/*.test.mjs'],
  'core 3/4': ['--test-shard=3/4', 'tests/core/*.test.mjs'],
  'core 4/4': ['--test-shard=4/4', 'tests/core/*.test.mjs'],
  invariants: ['tests/invariants-node/*.test.mjs'],
});
/** The legs that must find a test when a selection is given (shard 1/4 always gets the first selected file; `invariants` gets the invariant files). */
export const MUST_FIND = ['core 1/4', 'invariants'];
export const MAX_TOKENS = 64;
export const MAX_TOKEN_LENGTH = 200;

/**
 * Check the `tests` input. Tokens are separated by spaces only; each is a path under `tests/` made of letters, digits, `_ . - /` and `*` (a glob), with no `..` segment, no empty segment, no leading `-`
 * (an option) and no leading `/`; a token whose last segment has no dot is a folder and means its `*.test.mjs` files; any other token must end in `.mjs`. Everything else is refused as a whole
 * (never partly accepted): `; | & $ ( ) { } < > ' " \ ` backtick, a newline, a tab, a drive letter, a URL. Pure.
 * @param {string | undefined} input
 * @returns {{ ok: true, files: string[] } | { ok: false, error: string }}
 */
export function selectTests(input) {
  const text = input ?? '';
  if (text.trim() === '') return { ok: true, files: [] };
  if (!/^[A-Za-z0-9_.\-/* ]+$/.test(text)) return { ok: false, error: 'the tests input may only hold letters, digits, _ . - / * and spaces' };
  const tokens = text.split(' ').filter((t) => t !== '');
  if (tokens.length > MAX_TOKENS) return { ok: false, error: `the tests input holds more than ${MAX_TOKENS} entries` };
  /** @type {string[]} */ const files = [];
  for (const t of tokens) {
    if (t.length > MAX_TOKEN_LENGTH) return { ok: false, error: `an entry is longer than ${MAX_TOKEN_LENGTH} characters` };
    if (!t.startsWith('tests/')) return { ok: false, error: `${t}: an entry must start with tests/` };
    const segments = t.split('/');
    const inner = segments[segments.length - 1] === '' ? segments.slice(0, -1) : segments;
    if (inner.some((s) => s === '')) return { ok: false, error: `${t}: an empty path segment` };
    if (segments.some((s) => s === '.' || s === '..' || s.startsWith('-') || /^\.+$/.test(s))) return { ok: false, error: `${t}: . and .. segments and a leading - are refused` };
    const last = segments[segments.length - 1];
    if (last === '') { files.push(`${t}*.test.mjs`); continue; }
    if (!last.includes('.')) { files.push(`${t}/*.test.mjs`); continue; }
    if (!last.endsWith('.mjs')) return { ok: false, error: `${t}: a file entry must end in .mjs` };
    files.push(t);
  }
  return { ok: true, files: [...new Set(files)] };
}

/**
 * The `node --test` arguments of one leg: its default for an empty selection; else the selected files that belong to it (null: nothing to run in this leg).
 * @param {string} suite @param {string[]} files @returns {string[] | null}
 */
export function legArgs(suite, files) {
  if (!(suite in DEFAULTS)) throw new Error(`unknown leg: ${suite}`);
  if (files.length === 0) return DEFAULTS[suite];
  const invariant = (/** @type {string} */ f) => f.startsWith('tests/invariants-node/');
  if (suite === 'invariants') { const inv = files.filter(invariant); return inv.length > 0 ? inv : null; }
  const rest = files.filter((f) => !invariant(f));
  return rest.length > 0 ? [DEFAULTS[suite][0], ...rest] : null;   // the four core legs share the selected files with the same --test-shard=k/4 as their default
}

/**
 * The counts of the test runner's closing summary (`ℹ pass 12`, `ℹ duration_ms 1234.5`); the last of each wins. @param {string} text
 * @returns {{ tests?: number, pass?: number, fail?: number, cancelled?: number, skipped?: number, todo?: number, duration_ms?: number }}
 */
export function parseSummary(text) {
  /** @type {Record<string, number>} */ const out = {};
  for (const m of text.matchAll(/^[^\s\w]{0,3}\s*(tests|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)\s*$/gm)) out[m[1]] = Number(m[2]);
  return out;
}

/** One line for the log and the job summary. @param {string} suite @param {ReturnType<typeof parseSummary>} s @param {string} note */
export function resultLine(suite, s, note = '') {
  const secs = s.duration_ms === undefined ? 'n/a' : (s.duration_ms / 1000).toFixed(1);
  return `PROBE-RESULT leg=${suite} pass=${s.pass ?? 'n/a'} fail=${s.fail ?? 'n/a'} cancelled=${s.cancelled ?? 'n/a'} skipped=${s.skipped ?? 'n/a'} duration_s=${secs}${note === '' ? '' : ` ${note}`}`;
}

/** @param {string} suite @param {ReturnType<typeof parseSummary>} s @param {string} note */
export function summaryRow(suite, s, note = '') {
  const secs = s.duration_ms === undefined ? 'n/a' : (s.duration_ms / 1000).toFixed(1);
  return `| ${suite} | ${s.pass ?? 'n/a'} | ${s.fail ?? 'n/a'} | ${s.cancelled ?? 'n/a'} | ${s.skipped ?? 'n/a'} | ${secs} | ${note} |\n`;
}
const SUMMARY_HEAD = '| leg | pass | fail | cancelled | skipped | duration (s) | note |\n|---|---|---|---|---|---|---|\n';

/**
 * Run the leg. `exec(args, onLine)` starts `node` with ARGS and calls ONLINE for each output line; it resolves to the exit status.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ exec?: (args: string[], onLine: (line: string) => void) => Promise<number>, write?: (s: string) => void, summary?: (s: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function main(env, io = {}) {
  const write = io.write ?? ((s) => process.stdout.write(s));
  const sum = io.summary ?? ((s) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, s); });
  const suite = env.PROBE_SUITE ?? '';
  if (!(suite in DEFAULTS)) { write(`windows-probe: unknown leg '${suite}'\n`); return 2; }
  const sel = selectTests(env.PROBE_TESTS);
  if ('error' in sel) { write(`windows-probe: ${sel.error}\n`); return 2; }
  const args = legArgs(suite, sel.files);
  if (args === null) {
    write(`SKIPPED: no selected test file belongs to the ${suite} leg\n`);
    sum(`${SUMMARY_HEAD}${summaryRow(suite, {}, 'skipped: nothing selected for this leg')}`);
    return 0;
  }
  write(`windows-probe: ${suite}: node --test ${args.join(' ')}${sel.files.length > 0 ? ' (selection)' : ''}\n`);
  const exec = io.exec ?? execNode;
  /** @type {string[]} */ const kept = [];
  const status = await exec(['--test', '--test-reporter=spec', ...args], (line) => {
    write(`${line}\n`);
    if (/^[^\s\w]{0,3}\s*(tests|pass|fail|cancelled|skipped|todo|duration_ms) \d/.test(line)) kept.push(line);
  });
  const s = parseSummary(kept.join('\n'));
  const empty = sel.files.length > 0 && MUST_FIND.includes(suite) && (s.tests ?? 0) === 0;
  const note = empty ? 'the selection matched nothing (no test ran: file not found or no test in it)' : status === 0 ? '' : `exit ${status}`;
  write(`${resultLine(suite, s, note)}\n`);
  sum(`${SUMMARY_HEAD}${summaryRow(suite, s, note)}`);
  return empty && status === 0 ? 1 : status;
}

/** The options of the one process this script starts: no shell, so the selection is never parsed by one. */
/** @returns {import('node:child_process').SpawnOptions} */
export function spawnOptions() { return { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: false }; }

/** @param {string[]} args @param {(line: string) => void} onLine @returns {Promise<number>} */
function execNode(args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, spawnOptions());
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => {
      rest += chunk;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) { onLine(rest.slice(0, i).replace(/\r$/, '')); rest = rest.slice(i + 1); }
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => { if (rest !== '') onLine(rest); resolve(code ?? 1); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.env);
