#!/bin/sh
# Builds the tdd-proof fixture repository in $1: a duration module without
# parseDuration (so a first test that imports it fails to load, not to assert)
# and a colleague's test for the formatDuration change that passes before the
# change (hollow). Deterministic and offline.
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

mkdir -p src test
cat > package.json <<'X'
{
  "name": "timer-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
X
cat > README.md <<'X'
# timer

Duration helpers (seconds). Plain Node ESM, no dependencies.

    node --test
X
cat > src/duration.js <<'X'
// Durations are whole seconds.
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  let out = '';
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (s) out += `${s}s`;
  return out;
}
X
cat > test/format.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/duration.js';

test('formats hours, minutes and seconds', () => {
  assert.equal(formatDuration(5400), '1h30m');
  assert.equal(formatDuration(3725), '1h2m5s');
  assert.equal(formatDuration(42), '42s');
});
X
commit "feat: format durations"

cat > TASK.md <<'X'
# Task: FX-TDD — Parse durations and format zero

## Goal
Users can type durations such as `1h30m`, and a zero duration is displayed instead of an empty string.

## Acceptance criteria
- AC-1: `parseDuration(text)` exported from `src/duration.js` returns the number of seconds for
  strings made of `<n>h`, `<n>m`, `<n>s` parts in that order, each optional but at least one present
  (`'1h30m'` -> 5400, `'45s'` -> 45, `'2h5s'` -> 7205).
- AC-2: `parseDuration` throws an `Error` for any other input (`''`, `'abc'`, `'30m1h'`).
- AC-3: `formatDuration(0)` returns `'0s'`; all other outputs of `formatDuration` are unchanged.

## Out of scope
Days, fractional values, negative durations.

## Constraints
No dependencies. Tests use `node:test`.

## Suggested class
STANDARD (two small behaviour changes in one module, new public function)

## Verification commands
- `node --test`
X
cat > test/format-zero.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/duration.js';

// AC-3: written ahead of the change by a colleague.
test('formatDuration(0) is displayable', () => {
  const out = formatDuration(0);
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('undefined'));
});
X
commit "chore: add task FX-TDD and a test for AC-3"
