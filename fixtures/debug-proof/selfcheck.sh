#!/bin/sh
# Proves the planted facts of the debug-proof fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

[ "$(git rev-list --count HEAD)" -eq 8 ] || fail "expected 8 commits"
c3=$(git rev-list --reverse HEAD | sed -n 3p)
c4=$(git rev-list --reverse HEAD | sed -n 4p)
c5=$(git rev-list --reverse HEAD | sed -n 5p)
[ "$(git rev-parse v1.0)" = "$(git rev-list --reverse HEAD | sed -n 2p)" ] || fail "v1.0 is not commit 2"
[ "$(git log -1 --format=%s "$c5")" = "style: tidy formatCents" ] || fail "commit 5 subject"

fmt_at() { # <rev> <cents>
  git show "$1:src/money.js" > "$tmp/money.mjs"
  node -e "import('$tmp/money.mjs').then(m => process.stdout.write(m.formatCents($2)))"
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

[ "$(fmt_at v1.0 1205)" = "12.05" ] || fail "v1.0 must format 1205 as 12.05"
[ "$(fmt_at "$c4" 1205)" = "12.05" ] || fail "commit 4 must still be good"
[ "$(fmt_at "$c5" 1205)" = "12.50" ] || fail "commit 5 must be the first bad commit"
[ "$(fmt_at HEAD 1205)" = "12.50" ] || fail "HEAD must show the bug"

# Decoy: commit 3 formats every integer exactly like v1.0.
git show "v1.0:src/money.js" > "$tmp/good.mjs"
git show "$c3:src/money.js" > "$tmp/decoy.mjs"
node -e "
Promise.all([import('$tmp/good.mjs'), import('$tmp/decoy.mjs')]).then(([a, b]) => {
  for (let c = -100000; c <= 100000; c++) if (a.formatCents(c) !== b.formatCents(c)) { console.error('differs at', c); process.exit(1); }
});" || fail "commit 3 is not harmless"

# The suite at HEAD passes: the bug is not covered by any test.
node --test test/*.test.js >/dev/null 2>&1 || fail "HEAD test suite must pass"

# Bisect between v1.0 and HEAD names commit 5.
git worktree add -q --detach "$tmp/wt" HEAD
(
  cd "$tmp/wt"
  git bisect start HEAD v1.0 >/dev/null
  git bisect run node -e "import('./src/money.js').then(m => process.exit(m.formatCents(1205) === '12.05' ? 0 : 1))" > "$tmp/bisect.log" 2>&1 || { cat "$tmp/bisect.log" >&2; exit 1; }
  git rev-parse refs/bisect/bad > "$tmp/first-bad"
  git bisect reset >/dev/null 2>&1 || true
)
[ "$(cat "$tmp/first-bad")" = "$c5" ] || fail "bisect did not name commit 5"
git worktree remove --force "$tmp/wt"
echo "selfcheck: debug-proof ok"
