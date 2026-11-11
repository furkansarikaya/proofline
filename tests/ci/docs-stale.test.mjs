// A252: the documentation describes the finished state (Node control plane; the only shell files are the four launchers). This test scans the user-facing texts for
// references to files, commands and rules that were removed in the migration. The list is explicit (a list derived from the git history would be heavy and would
// also flag names that are legitimately reused). A line may name a removed thing only to say that it is gone ("is gone", "any more", "no longer", "removed").
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
  [/\bsh tests\/(?!ci\/)/, 'a shell test command (tests are `node --test`)'],
  [/(?:^|[\s`(])sh\s+[\w./-]*-test\.sh/, 'a shell test command'],
];
const GONE = /\b(is gone|are gone|any more|no longer|removed|deleted|retired)\b|there is no /i;

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
    if (GONE.test(line)) return;
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
  for (const ok of ['there is no shellcheck any more', 'the shell suite `tests/invariants/invariants-test.sh` is gone', 'node tests/real-session/smoke.mjs', 'node tests/invariants-node/x.test.mjs']) {
    assert.deepEqual(staleLines(ok, 'x.md'), [], ok);
  }
  assert.ok(scanned().includes('README.md') && scanned().includes('CONTRIBUTING.md') && scanned().some((f) => f.startsWith('docs/concepts/')));
  assert.ok(!scanned().includes('docs/decisions.md') && !scanned().some((f) => f.startsWith('docs/adr/')));
});
