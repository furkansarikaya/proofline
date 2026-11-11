// A252: the documentation describes the finished state (Node control plane; the only shell files are the four launchers). This test scans the user-facing texts for
// references to files, commands and rules that were removed in the migration. The list is explicit (a list derived from the git history would be heavy and would
// also flag names that are legitimately reused). No generic "it is gone" skip: a line that names a removed thing passes only through an exact entry of ALLOWED below
// (a file and the sentence), so a stale reference cannot hide behind the word "removed".
// Not scanned, because they are history: docs/decisions.md, CHANGELOG.md, docs/adr/ and tests/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

/** Removed paths, commands and rules: [pattern, what it was]. */
/** @type {Array<[RegExp, string]>} */
export const REMOVED = [
  [/tests\/ci\/shellcheck/, 'the shellcheck CI helper'],
  [/\bshellcheck\b/i, 'shellcheck (no CI step runs it)'],
  [/shell-allowlist/, 'the no-shell-logic ratchet snapshot'],
  [/inline-shell-snapshot/, 'the no-shell-logic ratchet snapshot'],
  [/invariants-test\.sh/, 'the shell invariant suite'],
  [/tests\/invariants\/(?!.*\.mjs)/, 'the shell invariant folder'],
  [/test-lib\.sh/, 'the shell test library'],
  [/check-changed\.sh/, 'the shell check-changed script'],
  [/proofline-hook\.sh/, 'the shell hook'],
  [/next-user\.sh/, 'the shell next-step table'],
  [/hook-procs\.sh/, 'the shell hook benchmark'],
  [/real-session\/(smoke|codex-sandbox)\.sh/, 'the shell real-session scripts (now .mjs)'],
  [/bump-version\.sh/, 'the shell version script (now bump-version.mjs)'],
  [/cli-test\.sh/, 'the shell CLI suite'],
  [/tests\/equivalence/, 'the equivalence rig'],
  [/tests\/legacy-hook/, 'the released shell hook copies'],
  [/PROOFLINE_ENGINE/, 'the engine switch variable'],
  [/\bengine switch\b/i, 'the engine switch'],
  [/\bfast mode\b/i, 'CI fast mode'],
  [/\b(secret-scan|exec-policy)\.sh\b/, 'a script that no longer ships (the scanner is core/secretscan.mjs, the policy core/execpolicy.mjs); the fixture stub rule is documented in A252 and the ADR only'],
  [/\bsh tests\/(?!ci\/)/, 'a shell test command (tests are `node --test`)'],
  [/(?:^|[\s`(])sh\s+[\w./-]*-test\.sh/, 'a shell test command'],
];
/** The only places that may name a removed thing, each to say it is gone: [file, the sentence]. Add the stub names here only where the stub rule is documented. @type {Array<[string, RegExp]>} */
export const ALLOWED = [
  ['CONTRIBUTING.md', /there is no shellcheck any more/],
  ['CONTRIBUTING.md', /there is no fast mode any more/],
  ['CONTRIBUTING.md', /invariants-test\.sh` is gone/],
  ['CONTRIBUTING.md', /There is no CI fast mode any more/],
  ['docs/concepts/enforcement-layers.md', /there is no engine switch/],
];

/** The scanned files: tracked Markdown outside the history and the tests, plus the `proofline help` text. */
export function scanned() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  const md = out.filter((f) => f.endsWith('.md') && f !== 'docs/decisions.md' && f !== 'CHANGELOG.md' && !f.startsWith('docs/adr/') && !f.startsWith('tests/') && !f.startsWith('.out-of-scope/'));
  return [...md, 'control-plane/agents/scripts/core/cliusage.mjs'];
}

/** @param {string} text @param {string} file @returns {string[]} */
export function staleLines(text, file) {
  /** @type {string[]} */ const bad = [];
  text.split('\n').forEach((line, i) => {
    if (ALLOWED.some(([f, re]) => f === file && re.test(line))) return;
    for (const [re, what] of REMOVED) if (re.test(line)) bad.push(`${file}:${i + 1}: mentions ${what}: ${line.trim().slice(0, 120)}`);
  });
  return bad;
}

test('A252: no user-facing text mentions a removed file, command or rule as if it still existed', () => {
  const problems = scanned().flatMap((f) => staleLines(readFileSync(path.join(root, f), 'utf8'), f));
  assert.deepEqual(problems, []);
});

test('A252: the scanner flags a planted stale reference and allows a sentence that says it is gone', () => {
  for (const planted of ['run `sh tests/real-session/smoke.sh`', 'see tests/invariants/invariants-test.sh', 'CI runs shellcheck on the launchers', 'set PROOFLINE_ENGINE=sh', 'the fast mode of CI', 'source test-lib.sh', 'tests/ci/shell-allowlist.txt', 'run `sh tests/foo/x-test.sh`']) {
    assert.equal(staleLines(planted, 'x.md').length > 0, true, planted);
  }
  for (const ok of ['node tests/real-session/smoke.mjs', 'node tests/invariants-node/x.test.mjs']) assert.deepEqual(staleLines(ok, 'x.md'), [], ok);
  // no generic skip: the word "removed" or "gone" does not excuse a stale reference, in any file; only an exact ALLOWED sentence of its own file does
  for (const hidden of ['shellcheck was removed from CI but see shellcheck docs', 'the file secret-scan.sh is gone', 'run exec-policy.sh, it is no longer needed']) assert.equal(staleLines(hidden, 'README.md').length > 0, true, hidden);
  assert.deepEqual(staleLines('there is no shellcheck any more', 'CONTRIBUTING.md'), []);
  assert.equal(staleLines('there is no shellcheck any more', 'README.md').length, 1, 'the allowance belongs to its file');
  assert.ok(scanned().includes('README.md') && scanned().includes('CONTRIBUTING.md') && scanned().some((f) => f.startsWith('docs/concepts/')));
  assert.ok(!scanned().includes('docs/decisions.md') && !scanned().some((f) => f.startsWith('docs/adr/')));
});
