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

# Contenders are separate processes, as they are in a run: in a ( ... ) & subshell `$$` is the parent's pid in every shell (dash included), so all of them would share one
# lock holder pid and one private directory name.
cat > "$T/slow-builder.sh" <<EOF
#!/bin/sh
sleep 2
cp "$src/control-plane/a.txt" "\$1/a.txt"
git -C "\$1" init -q -b main && git -C "\$1" add a.txt && git -C "\$1" commit -q -m base
EOF
chmod +x "$T/slow-builder.sh"
contend() { # KEY OUT ERR
  sh -c '. "$1"; fx_template "$2" "$3"; echo $? > "$4"' contender "$here/../shared/fixture-lib.sh" "$1" "$T/slow-builder.sh" "$3.rc" > "$2" 2> "$3" &
}
# What a race has to leave behind, whoever built and however many did (the publish is atomic, so a second build is wasted work, not a wrong result): OUT_PREFIX N KEY EXPECTED.
# Every contender succeeded and got the same path, the final directory; it is the only thing left under the key (no private build directory, no lock); it is complete and valid
# (the builder's file with the expected content, a clean repository of one commit) and holds no nested copy of a build directory.
outcome() {
  oc_dirs=$(for oc_i in $(seq 1 "$2"); do cat "$1.$oc_i"; done | sort -u)
  oc_bad=$(for oc_i in $(seq 1 "$2"); do [ "$(cat "$1.err.$oc_i.rc" 2>/dev/null)" = 0 ] || echo "contender $oc_i status '$(cat "$1.err.$oc_i.rc" 2>/dev/null)': $(cat "$1.err.$oc_i" 2>/dev/null)"; done)
  [ -z "$oc_bad" ] || die "$3: $oc_bad"
  [ "$oc_dirs" = "$SELFTEST_TEMPLATE_DIR/$3" ] || die "$3: the contenders got '$oc_dirs'"
  oc_left=$(cd "$SELFTEST_TEMPLATE_DIR" && ls -d "$3"* 2>/dev/null | tr '\n' ' ')
  [ "$oc_left" = "$3 " ] || die "$3: left under the key: $oc_left"
  [ "$(cat "$SELFTEST_TEMPLATE_DIR/$3/a.txt" 2>/dev/null)" = "$4" ] || die "$3: the template is incomplete"
  [ "$(git -C "$SELFTEST_TEMPLATE_DIR/$3" rev-list --count HEAD 2>/dev/null)" = 1 ] && [ -z "$(git -C "$SELFTEST_TEMPLATE_DIR/$3" status --porcelain)" ] || die "$3: the template is not a clean repository of one commit"
  [ -z "$(find "$SELFTEST_TEMPLATE_DIR/$3" -mindepth 1 -maxdepth 1 -name '*.tmp.*')" ] || die "$3: a build directory is nested in the template"
  oc_n=$(($(builds) - before))
  [ "$oc_n" -ge 1 ] && [ "$oc_n" -le "$2" ] || die "$3: $oc_n builds for $2 contenders"
}
printf 'v3\n' > "$src/control-plane/a.txt"; k3=$(fx_key "$src" control-plane bin)
before=$(builds)
for i in 1 2 3 4; do contend "$k3" "$T/par.$i" "$T/par.err.$i"; done
wait
outcome "$T/par" 4 "$k3" v3; ok "four concurrent callers get one complete template at the final path, with nothing left behind"

# a template that appears between the last test and the move (a second builder, a taken-over lock): `mv` would nest this build's private directory inside it
# shellcheck disable=SC2154 # ft_final is the library's variable
mv() { mkdir -p "$ft_final"; command mv "$@"; }   # the other template appears just before the move
t5=$(fx_template nestkey build) || die "a template that appeared before the move failed the build"
unset -f mv
[ -d "$t5" ] && [ -z "$(find "$t5" -mindepth 1 -maxdepth 1 -name '*.tmp.*')" ] && ok "a directory that appeared before the move is not nested into: no private build directory is left inside the template" || die "nested template: $(ls "$t5")"

# 8 contenders on a lock left by a dead process: the outcome is right whoever builds (the number of builds is not asserted beyond 1 to 8)
dead=$(sh -c 'echo $$'); mkdir -p "$SELFTEST_TEMPLATE_DIR/k8.lock"; echo "$dead" > "$SELFTEST_TEMPLATE_DIR/k8.lock/pid"
before=$(builds)
for i in 1 2 3 4 5 6 7 8; do contend k8 "$T/c8.$i" "$T/c8.err.$i"; done
wait
outcome "$T/c8" 8 k8 v3; ok "eight contenders on a dead lock: one complete template at the final path, nothing left behind"

dead=$(sh -c 'echo $$'); mkdir -p "$SELFTEST_TEMPLATE_DIR/stale.lock"; echo "$dead" > "$SELFTEST_TEMPLATE_DIR/stale.lock/pid"
t4=$(fx_template stale build) || die "a stale lock blocked the build"
[ -d "$t4" ] && ok "a lock left by a dead process is taken over" || die "stale lock"

# a caller that finds the final directory never builds, even when a dead holder's lock is still there
mkdir -p "$SELFTEST_TEMPLATE_DIR/done9" "$SELFTEST_TEMPLATE_DIR/done9.lock"; echo "$(sh -c 'echo $$')" > "$SELFTEST_TEMPLATE_DIR/done9.lock/pid"
before=$(builds)
t9=$(fx_template done9 failing) || die "a present template was built again or refused"
[ "$t9" = "$SELFTEST_TEMPLATE_DIR/done9" ] && [ "$(builds)" = "$before" ] && ok "a template that is already there is returned without a build, whatever lock is left" || die "built over a present template: builds=$(( $(builds) - before ))"
# the pid file of a lock is complete or absent: the holder writes it under another name and renames it
grep -q 'pid.new' "$here/../shared/fixture-lib.sh" && ok "the lock's pid file is written atomically (temp name, then rename)" || die "the pid file is not written atomically"

failing() { return 1; }
if fx_template failkey failing >/dev/null 2>&1; then die "a failing builder reported success"; fi
[ ! -d "$SELFTEST_TEMPLATE_DIR/failkey.lock" ] && [ ! -d "$SELFTEST_TEMPLATE_DIR/failkey" ] && ok "a failing builder leaves neither a template nor a lock" || die "failed build left state"
dying() { exit 3; }
if fx_template dykey dying >/dev/null 2>&1; then die "a dying builder reported success"; fi
[ ! -d "$SELFTEST_TEMPLATE_DIR/dykey.lock" ] && [ ! -d "$SELFTEST_TEMPLATE_DIR/dykey" ] && ok "a builder that exits leaves neither a template nor a lock" || die "dying builder left state"
printf 'fixture-test: %s checks passed\n' "$n"
