// Builds the verify-proof fixture repository in <target-dir>: a task branch where AC-2
// has no test (a file named for it tests trimming), a test that already fails
// at the base commit, and a change outside the frozen scope. The frozen TASK,
// PLAN and RUN files live in .agents/runs/FX-VP/ (git-ignored). Deterministic
// and offline.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] });
  let n = 0;
  /** @param {string} message @param {string} [date] */
  const commit = (message, date) => {
    n++;
    const d = date ?? `@${1767261600 + n * 86400} +0000`;
    f.git(['add', '-A']);
    f.git(['commit', '-q', '-m', message], { env: { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
  };
  f.append('.git/info/exclude', '.agents/\n');

  // --- base (main) ---
  f.mkdir('src', 'test');
  f.w('package.json', `{
  "name": "accounts-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`);
  f.w('src/config.js', `export const config = {
  pageSize: 20,
  sessionMinutes: 30,
};
`);
  f.w('src/date.js', `// Formats a Date as YYYY-MM-DD in UTC.
export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
`);
  f.w('test/date.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDay } from '../src/date.js';

test('isoDay formats a UTC day', () => {
  assert.equal(isoDay(new Date(Date.UTC(2026, 0, 31))), '2026-01-31');
});

test('isoDay pads single-digit months', () => {
  assert.equal(isoDay(new Date(Date.UTC(2026, 2, 5))), '2026-3-05');
});
`);
  commit('feat: config and date helpers');
  f.git(['tag', 'base']);

  // --- task branch ---
  f.git(['checkout', '-q', '-b', 'proofline/FX-VP-username-rules']);
  f.w('src/username.js', `// Username rules for sign-up.
export function normalizeUsername(raw) {
  return raw.trim();
}

export function validUsername(raw) {
  const name = normalizeUsername(raw);
  if (name.length < 3 || name.length > 20) return false;
  if (/[A-Z]/.test(name)) return false;
  return /^[a-z0-9_]+$/.test(name);
}
`);
  f.w('test/username.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validUsername } from '../src/username.js';

test('AC-1: length must be 3 to 20 characters', () => {
  assert.equal(validUsername('ab'), false);
  assert.equal(validUsername('abc'), true);
  assert.equal(validUsername('a'.repeat(20)), true);
  assert.equal(validUsername('a'.repeat(21)), false);
});

test('AC-3: only letters, digits and underscore', () => {
  assert.equal(validUsername('john_doe9'), true);
  assert.equal(validUsername('john-doe'), false);
  assert.equal(validUsername('john doe'), false);
});
`);
  f.w('test/username-case.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, validUsername } from '../src/username.js';

test('AC-2: username case handling', () => {
  assert.equal(normalizeUsername('  alice  '), 'alice');
  assert.equal(validUsername('  alice  '), true);
});
`);
  f.w('src/config.js', `export const config = {
  pageSize: 50,
  sessionMinutes: 30,
};
`);
  commit('feat: username validation (FX-VP)');

  // --- frozen run artifacts (git-ignored) ---
  const run = '.agents/runs/FX-VP';
  f.mkdir(run);
  f.w(`${run}/TASK.md`, `# Task: FX-VP — Username rules

## Goal
Sign-up rejects usernames that break the naming rules.

## Context
New module \`src/username.js\`; sign-up will call \`validUsername\`.

## Acceptance criteria
- AC-1: \`validUsername\` returns false for names shorter than 3 or longer than 20 characters (after
  trimming surrounding spaces), true otherwise when the other rules hold.
- AC-2: \`validUsername\` returns false for any name containing an uppercase letter.
- AC-3: \`validUsername\` returns false for names containing characters other than \`a-z\`, \`0-9\` and \`_\`.

## Out of scope
Reserved names, uniqueness checks, changes to configuration.

## Constraints
No dependencies.

## Risks
None beyond sign-up rejecting valid names.

## Suggested class
STANDARD (new validation module, one behaviour per criterion)

## Verification commands
- \`node --test\`
`);
  f.w(`${run}/PLAN.md`, `---
scope:
  - path: src/username.js
    criteria: [AC-1, AC-2, AC-3]
  - path: test/username.test.js
    criteria: [AC-1, AC-3]
  - path: test/username-case.test.js
    criteria: [AC-2]
---
# Plan: FX-VP — Username rules

## Behavior
\`validUsername(raw)\` trims, then applies the length, uppercase and character-set rules in that order.

## Tests
- \`test/username.test.js\`: AC-1 length bounds, AC-3 character set.
- \`test/username-case.test.js\`: AC-2 uppercase rejection.

## Verification commands
- \`node --test\`

## Dependencies
none

## Contracts
none

## Assumptions
none
`);
  f.w(`${run}/RUN.yaml`, ['task_id: FX-VP', 'class: STANDARD', 'state: CODE_DONE', 'branch: proofline/FX-VP-username-rules', `base_sha: ${f.git(['rev-parse', 'base']).trim()}`, 'plan_frozen: true'].map((l) => `${l}\n`).join(''));

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

