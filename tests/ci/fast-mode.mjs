// TEMPORARY FAST MODE of the CI workflow (user decision, expires with tests/ci/fast-mode.txt). Read by the `changes` job.
//
//   node tests/ci/fast-mode.mjs --event <github event name> [--file tests/ci/fast-mode.txt] [--today YYYY-MM-DD] [--github-output FILE]
//                               [--changed-file FILE]
//
// Authority (security review F3): on a pull request the workflow runs THIS script and reads fast-mode.txt from the BASE sha (a worktree of it),
// never from the pull request's tree, and passes the list of paths the pull request changes in --changed-file. A pull request that changes
// tests/ci/fast-mode.txt or any tests/ci/fast-mode.* file runs the full suite (fast=false), so it cannot enable or extend the mode for itself.
// A base without the script (the pull request that introduces it) runs the full suite too. .github/CODEOWNERS puts .github/ and tests/ci/
// under the repository owner's review.
//
// While tests/ci/fast-mode.txt exists, is valid and is not expired, and the event is `pull_request`, the heavy legacy jobs (the self-test
// shards, the fixtures job and the skill tests step) are skipped: the job outputs `fast=true` and a one-line `notice`. It never skips the
// invariants (context budget included), the equivalence job, the Node tests or the static job: those workflow jobs do not read this output.
// push to main, schedule and workflow_dispatch always run everything (fast=false). After the expiry date the job FAILS while the file
// exists, whatever the event; so does a file that is malformed (a missing field or a date that is not a date).
//
// File format: `key: value` lines; `#` lines and blank lines are ignored. Required keys: name, reason, owner, expires (YYYY-MM-DD, the last
// day the mode may run), removal (the condition under which the file is deleted).
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED = ['name', 'reason', 'owner', 'expires', 'removal'];

/** @param {string} text @returns {Record<string, string>} */
export function parseFile(text) {
  /** @type {Record<string, string>} */
  const kv = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`fast-mode file: not a "key: value" line: ${line}`);
    kv[m[1]] = m[2].trim();
  }
  return kv;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A changed path that decides the mode: the file itself or any tests/ci/fast-mode.* file (the reader, its test). @param {string} f */
export const touchesFastMode = (f) => f === 'tests/ci/fast-mode.txt' || f.startsWith('tests/ci/fast-mode.');

/**
 * @param {{ event: string, text: string | null, today: string, changed?: string[] }} a
 * @returns {{ ok: boolean, fast: boolean, notice: string, errors: string[] }}
 */
export function decide({ event, text, today, changed = [] }) {
  if (changed.some(touchesFastMode)) return { ok: true, fast: false, notice: '', errors: [] };
  if (text === null) return { ok: true, fast: false, notice: '', errors: [] };
  /** @type {Record<string, string>} */
  let kv;
  try { kv = parseFile(text); } catch (e) { return { ok: false, fast: false, notice: '', errors: [String(e.message)] }; }
  const errors = [];
  for (const k of REQUIRED) if (!kv[k]) errors.push(`fast-mode file: "${k}" is missing or empty`);
  if (kv.expires && !validDate(kv.expires)) errors.push(`fast-mode file: expires "${kv.expires}" is not a YYYY-MM-DD date`);
  if (!validDate(today)) errors.push(`today "${today}" is not a YYYY-MM-DD date`);
  if (errors.length) return { ok: false, fast: false, notice: '', errors };
  if (today > kv.expires) {
    return { ok: false, fast: false, notice: '', errors: [`FAST MODE EXPIRED on ${kv.expires} (today ${today}): ${kv.name}. Delete tests/ci/fast-mode.txt (removal condition: ${kv.removal}) or ask ${kv.owner} to extend it with a new reason.`] };
  }
  if (event !== 'pull_request') return { ok: true, fast: false, notice: '', errors: [] };
  const notice = `FAST MODE (temporary, expires ${kv.expires}, owner ${kv.owner}): the legacy self-test shards, the fixtures job and the skill tests step are SKIPPED on this pull request. Invariants, equivalence, the Node tests and the static checks still ran. Reason: ${kv.reason}. Removal: ${kv.removal}.`;
  return { ok: true, fast: true, notice, errors: [] };
}

function main(argv) {
  let event = '';
  let file = resolve(import.meta.dirname, 'fast-mode.txt');
  let today = new Date().toISOString().slice(0, 10);
  let out = '';
  let changedFile = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') event = argv[++i] ?? '';
    else if (a === '--file') file = resolve(argv[++i] ?? '');
    else if (a === '--today') today = argv[++i] ?? '';
    else if (a === '--github-output') out = argv[++i] ?? '';
    else if (a === '--changed-file') changedFile = argv[++i] ?? '';
    else { process.stderr.write(`fast-mode: unknown argument ${a}\n`); return 2; }
  }
  if (!event) { process.stderr.write('fast-mode: --event is required\n'); return 2; }
  const changed = changedFile ? readFileSync(changedFile, 'utf8').split('\n').filter(Boolean) : [];
  const d = decide({ event, text: existsSync(file) ? readFileSync(file, 'utf8') : null, today, changed });
  const lines = [`fast=${d.fast}`, `notice=${d.notice}`];
  if (out) appendFileSync(out, lines.join('\n') + '\n');
  if (!d.ok) {
    for (const e of d.errors) process.stderr.write(`::error title=FAST MODE::${e}\n`);
    return 1;
  }
  if (d.fast) {
    const bar = '='.repeat(100);
    process.stdout.write(`${bar}\nFAST MODE IS ACTIVE\n${d.notice}\n${bar}\n`);
    process.stdout.write(`::warning title=FAST MODE::${d.notice}\n`);
  } else process.stdout.write(`fast-mode: off (${changed.some(touchesFastMode) ? 'this pull request changes the fast-mode files: full suite' : existsSync(file) ? `file present, event ${event}` : 'no file'})\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exitCode = main(process.argv.slice(2));
