#!/bin/sh
# Proves the planted facts of the tdd-proof fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Existing suite passes, including the colleague's AC-3 test, before any change.
node --test test/format.test.js test/format-zero.test.js >/dev/null 2>&1 || fail "baseline suite must pass"

# Trap: the obvious first test for AC-1 fails to load (missing export), not on an assertion.
cat > test/zz-naive.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.js';
test('parses', () => { assert.equal(parseDuration('1h30m'), 5400); });
X
if node --test test/zz-naive.test.js > "$tmp/naive.log" 2>&1; then fail "naive test must fail"; fi
grep -q "does not provide an export named 'parseDuration'" "$tmp/naive.log" || fail "naive failure is not a missing-export SyntaxError"
grep -q "AssertionError" "$tmp/naive.log" && fail "naive failure must not be an assertion failure"

# With a stub, the same test fails on an assertion (a valid RED).
cp src/duration.js "$tmp/duration.js.orig"
printf '\nexport function parseDuration(text) {\n  return 0;\n}\n' >> src/duration.js
if node --test test/zz-naive.test.js > "$tmp/stub.log" 2>&1; then fail "stubbed test must fail"; fi
grep -q "AssertionError" "$tmp/stub.log" || fail "stubbed failure must be an assertion failure"
cp "$tmp/duration.js.orig" src/duration.js
rm test/zz-naive.test.js

# Hollow: the colleague's AC-3 test passes without the change (above) and with a correct change.
sed 's/^  return out;$/  return out || '"'"'0s'"'"';/' src/duration.js > "$tmp/fixed.js"
grep -q "out || '0s'" "$tmp/fixed.js" || fail "could not build the fixed variant"
cp "$tmp/fixed.js" src/duration.js
node -e "import('./src/duration.js').then(m => process.exit(m.formatDuration(0) === '0s' ? 0 : 1))" || fail "fixed variant wrong"
node --test test/format-zero.test.js >/dev/null 2>&1 || fail "colleague test must pass after the change too"
cp "$tmp/duration.js.orig" src/duration.js
node -e "import('./src/duration.js').then(m => process.exit(m.formatDuration(0) === '' ? 0 : 1))" || fail "baseline formatDuration(0) must be empty"

[ -z "$(git status --porcelain)" ] || fail "selfcheck left the tree dirty"
echo "selfcheck: tdd-proof ok"
