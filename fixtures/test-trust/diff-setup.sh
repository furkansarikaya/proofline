#!/bin/sh
# Builds a git repository for test-trust's diff mode (D20) from the full-mode fixtures.
#
# usage: sh diff-setup.sh <go|ts> <target-dir> <fail|pass>
#
# The base commit holds the shop library and its solid tests plus the order-dependent pair
# (price tests). The uncommitted working tree is "the task":
#   fail  refactors two units (ApplyDiscount, NormalizeEmail; behaviour unchanged) and adds
#         the checkout tests: a hollow test (no assertion), a hollow one (mocks everything),
#         a nondeterministic flaky one and a slow one.
#   pass  refactors ApplyDiscount only (behaviour unchanged); the covering test is solid.
# Expected results are in EXPECTED.md ("Diff mode"). Nothing is installed; for ts the
# caller provides node_modules (copy or symlink) before running the tests.
set -eu

usage() { echo "usage: sh diff-setup.sh <go|ts> <target-dir> <fail|pass>" >&2; exit 2; }
[ $# -eq 3 ] || usage
lang=$1; target=$2; scenario=$3
case $lang in go|ts) ;; *) usage ;; esac
case $scenario in fail|pass) ;; *) usage ;; esac

here=$(cd "$(dirname "$0")" && pwd)
if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $target" >&2
  exit 1
fi
mkdir -p "$target"
target=$(cd "$target" && pwd)
cp -R "$here/$lang/." "$target/"
rm -rf "$target/node_modules"

g() { git -C "$target" "$@"; }

# in-place edit without sed -i (BSD and GNU): edit FILE FROM TO (fixed strings, one occurrence)
edit() {
  awk -v from="$2" -v to="$3" '
    !done && (i = index($0, from)) { $0 = substr($0, 1, i - 1) to substr($0, i + length(from)); done = 1 }
    { print }
    END { if (!done) exit 3 }' "$1" > "$1.new" || { rm -f "$1.new"; echo "error: pattern not found in $1: $2" >&2; exit 1; }
  mv "$1.new" "$1"
}

if [ "$lang" = go ]; then
  tests=checkout_test.go
  prod=shop.go
else
  tests=src/checkout.test.ts
  prod=src/shop.ts
fi

# the checkout tests belong to the task, not to the base
mkdir -p "$target/.held"
mv "$target/$tests" "$target/.held/checkout-tests"

g init -q
g symbolic-ref HEAD refs/heads/main
g config user.name Fixture
g config user.email fixture@example.invalid
g config commit.gpgsign false
printf '.held/\n' >> "$target/.git/info/exclude"
g add -A
g commit -q -m "Base: shop library with solid price tests"

# the task (uncommitted): behaviour-preserving refactors of changed units
if [ "$lang" = go ]; then
  edit "$target/$prod" 'return cents * 90 / 100' 'return cents * 9 / 10'
  [ "$scenario" = fail ] && edit "$target/$prod" 'strings.ToLower(strings.TrimSpace(email))' 'strings.TrimSpace(strings.ToLower(email))'
else
  edit "$target/$prod" 'Math.round((cents * 90) / 100)' 'Math.round((cents * 9) / 10)'
  [ "$scenario" = fail ] && edit "$target/$prod" 'email.trim().toLowerCase()' 'email.toLowerCase().trim()'
fi
if [ "$scenario" = fail ]; then
  mv "$target/.held/checkout-tests" "$target/$tests"
else
  rm -f "$target/.held/checkout-tests"
fi
rmdir "$target/.held" 2>/dev/null || true
echo "fixture ready: $target ($lang, scenario $scenario; run /test-trust diff from there)"
g status --short
exit 0
