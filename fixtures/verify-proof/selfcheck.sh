#!/bin/sh
# Proves the planted facts of the verify-proof fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

grep -q "^base_sha: $(git rev-parse base)$" .agents/runs/FX-VP/RUN.yaml || fail "RUN.yaml base_sha"
[ "$(git rev-parse --abbrev-ref HEAD)" = "proofline/FX-VP-username-rules" ] || fail "not on the task branch"

# Changed files: exactly the three scoped paths plus src/config.js (out of scope).
changed=$(git diff --name-only base HEAD | tr '\n' ' ')
[ "$changed" = "src/config.js src/username.js test/username-case.test.js test/username.test.js " ] \
  || fail "unexpected diff: $changed"

# The username tests pass and the implementation meets AC-2.
node --test test/username.test.js test/username-case.test.js >/dev/null 2>&1 || fail "username tests must pass"
node -e "import('./src/username.js').then(m => process.exit(m.validUsername('Alice') === false && m.validUsername('alice') === true ? 0 : 1))" \
  || fail "implementation must satisfy AC-2"

# AC-2 is untested: a mutant that accepts uppercase still passes every username test.
cp src/username.js "$tmp/username.js"
sed -e '/\[A-Z\]/d' -e 's#/^\[a-z0-9_\]+\$/#/^[a-z0-9_]+$/i#' "$tmp/username.js" > src/username.js
node -e "import('./src/username.js').then(m => process.exit(m.validUsername('Alice') === true ? 0 : 1))" \
  || { cp "$tmp/username.js" src/username.js; fail "mutant does not accept uppercase"; }
if ! node --test test/username.test.js test/username-case.test.js >/dev/null 2>&1; then
  cp "$tmp/username.js" src/username.js; fail "AC-2 mutant was caught: AC-2 is tested"
fi
cp "$tmp/username.js" src/username.js

# Pre-existing failure: test/date.test.js fails at HEAD and at base.
if node --test test/date.test.js >/dev/null 2>&1; then fail "date test must fail at HEAD"; fi
git worktree add -q --detach "$tmp/base" base
if (cd "$tmp/base" && node --test test/date.test.js >/dev/null 2>&1); then
  git worktree remove --force "$tmp/base"; fail "date test must fail at base"
fi
git worktree remove --force "$tmp/base"

# The full verification command fails only because of the pre-existing test.
if node --test >/dev/null 2>&1; then fail "node --test must fail"; fi

[ -z "$(git status --porcelain)" ] || fail "selfcheck left the tree dirty"
echo "selfcheck: verify-proof ok"
