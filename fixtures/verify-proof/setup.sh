#!/bin/sh
# Builds the verify-proof fixture repository in $1: a task branch where AC-2
# has no test (a file named for it tests trimming), a test that already fails
# at the base commit, and a change outside the frozen scope. The frozen TASK,
# PLAN and RUN files live in .agents/runs/FX-VP/ (git-ignored). Deterministic
# and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
mkdir -p "$1"
cd "$1"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
git init -q
git symbolic-ref HEAD refs/heads/main
git config commit.gpgsign false
git config core.autocrlf false
printf '.agents/\n' >> .git/info/exclude

N=0
commit() {
  N=$((N + 1))
  d="@$((1767261600 + N * 86400)) +0000"
  git add -A
  GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -q -m "$1"
}

# --- base (main) ---
mkdir -p src test
cat > package.json <<'X'
{
  "name": "accounts-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
X
cat > src/config.js <<'X'
export const config = {
  pageSize: 20,
  sessionMinutes: 30,
};
X
cat > src/date.js <<'X'
// Formats a Date as YYYY-MM-DD in UTC.
export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
X
cat > test/date.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDay } from '../src/date.js';

test('isoDay formats a UTC day', () => {
  assert.equal(isoDay(new Date(Date.UTC(2026, 0, 31))), '2026-01-31');
});

test('isoDay pads single-digit months', () => {
  assert.equal(isoDay(new Date(Date.UTC(2026, 2, 5))), '2026-3-05');
});
X
commit "feat: config and date helpers"
git tag base

# --- task branch ---
git checkout -q -b proofline/FX-VP-username-rules
cat > src/username.js <<'X'
// Username rules for sign-up.
export function normalizeUsername(raw) {
  return raw.trim();
}

export function validUsername(raw) {
  const name = normalizeUsername(raw);
  if (name.length < 3 || name.length > 20) return false;
  if (/[A-Z]/.test(name)) return false;
  return /^[a-z0-9_]+$/.test(name);
}
X
cat > test/username.test.js <<'X'
import { test } from 'node:test';
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
X
cat > test/username-case.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, validUsername } from '../src/username.js';

test('AC-2: username case handling', () => {
  assert.equal(normalizeUsername('  alice  '), 'alice');
  assert.equal(validUsername('  alice  '), true);
});
X
cat > src/config.js <<'X'
export const config = {
  pageSize: 50,
  sessionMinutes: 30,
};
X
commit "feat: username validation (FX-VP)"

# --- frozen run artifacts (git-ignored) ---
run=.agents/runs/FX-VP
mkdir -p "$run"
cat > "$run/TASK.md" <<'X'
# Task: FX-VP — Username rules

## Goal
Sign-up rejects usernames that break the naming rules.

## Context
New module `src/username.js`; sign-up will call `validUsername`.

## Acceptance criteria
- AC-1: `validUsername` returns false for names shorter than 3 or longer than 20 characters (after
  trimming surrounding spaces), true otherwise when the other rules hold.
- AC-2: `validUsername` returns false for any name containing an uppercase letter.
- AC-3: `validUsername` returns false for names containing characters other than `a-z`, `0-9` and `_`.

## Out of scope
Reserved names, uniqueness checks, changes to configuration.

## Constraints
No dependencies.

## Risks
None beyond sign-up rejecting valid names.

## Suggested class
STANDARD (new validation module, one behaviour per criterion)

## Verification commands
- `node --test`
X
cat > "$run/PLAN.md" <<'X'
---
task: FX-VP
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
`validUsername(raw)` trims, then applies the length, uppercase and character-set rules in that order.

## Tests
- `test/username.test.js`: AC-1 length bounds, AC-3 character set.
- `test/username-case.test.js`: AC-2 uppercase rejection.

## Verification commands
- `node --test`

## Dependencies
None.
X
{
  echo "task_id: FX-VP"
  echo "class: STANDARD"
  echo "state: CODE_DONE"
  echo "branch: proofline/FX-VP-username-rules"
  echo "base_sha: $(git rev-parse base)"
  echo "plan_frozen: true"
} > "$run/RUN.yaml"
