#!/bin/sh
# shellcheck disable=SC2015,SC2329 # assertion chains; builders are called by name
# Tests for the shared template fixture (tests/shared/fixture-lib.sh): a template is built once per content hash, is
# rebuilt when a file it depends on changes, is built once under concurrent callers, and every copy is independent.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-fixture-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT HUP INT TERM
GIT_CONFIG_GLOBAL=/dev/null; GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
SELFTEST_TEMPLATE_DIR=$T/cache; FX_BUILDS=$T/builds; export SELFTEST_TEMPLATE_DIR FX_BUILDS
: > "$FX_BUILDS"
# shellcheck source=../shared/fixture-lib.sh
. "$here/../shared/fixture-lib.sh"
n=0
ok() { n=$((n + 1)); printf 'ok %s - %s\n' "$n" "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
builds() { wc -l < "$FX_BUILDS" | tr -d ' '; }

src=$T/src; mkdir -p "$src/control-plane" "$src/bin"
printf 'v1\n' > "$src/control-plane/a.txt"; printf 'tool\n' > "$src/bin/tool"
build() { # DIR: a repository holding a copy of the source file, with one commit
  cp "$src/control-plane/a.txt" "$1/a.txt"
  git -C "$1" init -q -b main && git -C "$1" add a.txt && git -C "$1" commit -q -m base
}

k1=$(fx_key "$src" control-plane bin); k1b=$(fx_key "$src" control-plane bin)
[ -n "$k1" ] && [ "$k1" = "$k1b" ] && ok "the key is stable for unchanged files" || die "key not stable: '$k1' '$k1b'"
t1=$(fx_template "$k1" build) || die "first build failed"
[ -f "$t1/a.txt" ] && [ "$(builds)" = 1 ] && ok "the template is built on first use" || die "first build: builds=$(builds)"
t1b=$(fx_template "$k1" build) || die "second lookup failed"
[ "$t1b" = "$t1" ] && [ "$(builds)" = 1 ] && ok "the same key reuses the template (no second build)" || die "rebuilt for the same key: builds=$(builds)"

printf 'v2\n' > "$src/control-plane/a.txt"
k2=$(fx_key "$src" control-plane bin)
[ "$k2" != "$k1" ] && ok "a changed control-plane file changes the key" || die "key did not change"
t2=$(fx_template "$k2" build) || die "rebuild failed"
[ "$t2" != "$t1" ] && [ "$(cat "$t2/a.txt")" = v2 ] && [ "$(cat "$t1/a.txt")" = v1 ] && [ "$(builds)" = 2 ] && ok "a changed file rebuilds the template; the old one stays as it was" || die "stale template: builds=$(builds) t2=$(cat "$t2/a.txt")"
printf 'tool2\n' > "$src/bin/tool"
[ "$(fx_key "$src" control-plane bin)" != "$k2" ] && ok "a changed file in another watched directory changes the key too" || die "bin change not seen"

mkdir "$T/c1" "$T/c2"; fx_copy "$t2" "$T/c1"; fx_copy "$t2" "$T/c2"
printf 'changed in c1\n' > "$T/c1/a.txt"; git -C "$T/c1" commit -q -am c1only; printf 'extra\n' > "$T/c1/new.txt"
[ "$(cat "$T/c2/a.txt")" = v2 ] && [ ! -e "$T/c2/new.txt" ] && [ "$(git -C "$T/c2" rev-list --count HEAD)" = 1 ] && [ "$(git -C "$T/c1" rev-list --count HEAD)" = 2 ] && ok "two copies are independent (files and git history)" || die "copies share state"
[ "$(cat "$t2/a.txt")" = v2 ] && [ "$(git -C "$t2" rev-list --count HEAD)" = 1 ] && [ -z "$(git -C "$t2" status --porcelain)" ] && ok "a copy never changes the template" || die "the template was modified through a copy"
[ "$(git -C "$T/c2" rev-parse --git-dir)" = .git ] && [ -z "$(git -C "$T/c2" status --porcelain)" ] && ok "a copy is a working repository of its own (clean, own .git)" || die "copy is not a clean repository"

slow() { sleep 2; build "$1"; }
printf 'v3\n' > "$src/control-plane/a.txt"; k3=$(fx_key "$src" control-plane bin)
before=$(builds)
for i in 1 2 3 4; do ( fx_template "$k3" slow > "$T/par.$i" ) & done
wait
[ "$(builds)" = $((before + 1))  ] && [ "$(sort -u "$T"/par.? | wc -l | tr -d ' ')" = 1 ] && [ -f "$(cat "$T/par.1")/a.txt" ] && ok "four concurrent callers build the template once and get the same directory" || die "race: builds=$(( $(builds) - before )) dirs=$(cat "$T"/par.?)"

dead=$(sh -c 'echo $$'); mkdir -p "$SELFTEST_TEMPLATE_DIR/stale.lock"; echo "$dead" > "$SELFTEST_TEMPLATE_DIR/stale.lock/pid"
t4=$(fx_template stale build) || die "a stale lock blocked the build"
[ -d "$t4" ] && ok "a lock left by a dead process is taken over" || die "stale lock"

failing() { return 1; }
if fx_template failkey failing >/dev/null 2>&1; then die "a failing builder reported success"; fi
[ ! -d "$SELFTEST_TEMPLATE_DIR/failkey.lock" ] && [ ! -d "$SELFTEST_TEMPLATE_DIR/failkey" ] && ok "a failing builder leaves neither a template nor a lock" || die "failed build left state"
dying() { exit 3; }
if fx_template dykey dying >/dev/null 2>&1; then die "a dying builder reported success"; fi
[ ! -d "$SELFTEST_TEMPLATE_DIR/dykey.lock" ] && [ ! -d "$SELFTEST_TEMPLATE_DIR/dykey" ] && ok "a builder that exits leaves neither a template nor a lock" || die "dying builder left state"
printf 'fixture-test: %s checks passed\n' "$n"
