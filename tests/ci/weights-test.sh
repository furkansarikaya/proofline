#!/bin/sh
# shellcheck disable=SC2015,SC2016 # assertion chains; literal text
# Tests for the unit weights of tests/selftest.sh: the median rule for unlisted units, SELFTEST_TIMES_FILE, and
# tests/selftest-weights.sh (valid input merges and sorts, invalid input is refused and writes nothing).
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tests=$(CDPATH='' cd "$here/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-weights-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT HUP INT TERM
# the nested runs below choose their own selection
unset SELFTEST_ONLY SELFTEST_SHARD SELFTEST_LIST SELFTEST_WEIGHTS SELFTEST_TIMES_FILE SELFTEST_JOBS SELFTEST_SLOWEST LC_ONLY LC_EXACT
n=0
ok() { n=$((n + 1)); printf 'ok %s - %s\n' "$n" "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ---- the median rule: units come from a real split suite, some are listed, the others must weigh the median
units=$(SELFTEST_LIST=1 SELFTEST_WEIGHTS=/dev/null SELFTEST_ONLY=next-user-test sh "$tests/selftest.sh") || die "cannot list units"
[ "$(printf '%s\n' "$units" | wc -l | tr -d ' ')" -ge 6 ] || die "next-user-test lists too few units: $units"
keys=$(printf '%s\n' "$units" | sed 's|^.*/||; s|\.sh||; s/|/ /; s/ *$//')
total=$(printf '%s\n' "$keys" | wc -l | tr -d ' ')
{ i=0; for w in 10 30 100; do i=$((i + 1)); printf '%s %s\n' "$w" "$(printf '%s\n' "$keys" | sed -n "${i}p")"; done; } > "$T/w3.txt"
got=$(SELFTEST_LIST=weights SELFTEST_WEIGHTS="$T/w3.txt" SELFTEST_ONLY=next-user-test sh "$tests/selftest.sh")
[ "$(printf '%s\n' "$got" | awk '$1 == 30' | wc -l | tr -d ' ')" = $((total - 2)) ] && [ "$(printf '%s\n' "$got" | awk '$1 == 15' | wc -l | tr -d ' ')" = 0 ] \
  && ok "an unlisted unit weighs the median of the listed ones (10 30 100 gives 30), not 15" || die "median rule: $got"
{ i=0; for w in 10 20 30 100; do i=$((i + 1)); printf '%s %s\n' "$w" "$(printf '%s\n' "$keys" | sed -n "${i}p")"; done; } > "$T/w4.txt"
got=$(SELFTEST_LIST=weights SELFTEST_WEIGHTS="$T/w4.txt" SELFTEST_ONLY=next-user-test sh "$tests/selftest.sh")
[ "$(printf '%s\n' "$got" | awk '$1 == 25' | wc -l | tr -d ' ')" = $((total - 4)) ] && ok "an even count takes the middle pair (10 20 30 100 gives 25)" || die "median rule (even): $got"
got=$(SELFTEST_LIST=weights SELFTEST_WEIGHTS=/dev/null SELFTEST_ONLY=next-user-test sh "$tests/selftest.sh")
[ "$(printf '%s\n' "$got" | awk '$1 != 15' | wc -l | tr -d ' ')" = 0 ] && ok "with no weights at all every unit weighs 15" || die "no weights: $got"

# ---- SELFTEST_TIMES_FILE: one "<seconds> <suite> [scenario]" line per unit that ran (a fake tree keeps this fast)
mkdir -p "$T/fake/tests/a"; cp "$tests/selftest.sh" "$T/fake/tests/selftest.sh"
printf '%s\n' 'run_sc() { [ "${LC_EXACT:-}" = "$*" ] || return 0; echo "ok 1 $*"; }' 'run_sc one' 'run_sc two x' > "$T/fake/tests/a/fake-test.sh"
printf '%s\n' 'echo "ok 1 whole"' > "$T/fake/tests/a/whole-test.sh"
SELFTEST_TIMES_FILE="$T/times.txt" SELFTEST_TEMPLATE_DIR="$T/tpl" sh "$T/fake/tests/selftest.sh" > "$T/fake.out" 2>&1 || die "fake run failed: $(cat "$T/fake.out")"
bad=$(grep -vcE '^[0-9]+ (fake-test (one|two x)|whole-test)$' "$T/times.txt")
[ "$(wc -l < "$T/times.txt" | tr -d ' ')" = 3 ] && [ "$bad" = 0 ] && ok "SELFTEST_TIMES_FILE gets one line per unit in the weights file format" || die "times file: $(cat "$T/times.txt")"

# ---- tests/selftest-weights.sh
W=$tests/selftest-weights.sh
mkdir -p "$T/art"
printf '%s\n' '# shard 1' '40 alpha-test sc_a' '10 beta-test' '' '6 alpha-test sc_b x' > "$T/art/times-1.txt"
printf '%s\n' '60 alpha-test sc_a' '2 gamma-test' > "$T/art/times-2.txt"
sh "$W" -o "$T/out1.txt" --note "split units were estimated" "$T/art" || die "valid input refused"
body=$(grep -v '^#' "$T/out1.txt")
want=$(printf '%s\n' '50 alpha-test sc_a' '10 beta-test' '6 alpha-test sc_b x' '2 gamma-test')
[ "$body" = "$want" ] && ok "a directory of times files is merged (same unit averaged), longest first" || die "merged weights: $body"
grep -q '^# split units were estimated' "$T/out1.txt" && grep -q 'MEDIAN' "$T/out1.txt" && grep -q 'from 2 times file' "$T/out1.txt" && ok "the header states its source and carries the note" || die "header: $(grep '^#' "$T/out1.txt")"
sh "$W" -o "$T/out2.txt" "$T/art/times-1.txt" || die "single file refused"
[ "$(grep -vc '^#' "$T/out2.txt")" = 3 ] && ok "one times file works as well" || die "single file"
printf '%s\n' '40 alpha-test sc_a' 'seven beta-test' > "$T/bad.txt"
if sh "$W" -o "$T/out3.txt" "$T/art/times-1.txt" "$T/bad.txt" > "$T/bad.out" 2>&1; then die "a malformed line was accepted"; fi
grep -q 'bad.txt:2:' "$T/bad.out" && [ ! -e "$T/out3.txt" ] && ok "a malformed line is refused with file and line, and nothing is written" || die "invalid input: $(cat "$T/bad.out")"
if sh "$W" -o "$T/out4.txt" "$T/nonexistent" > "$T/bad2.out" 2>&1; then die "a missing input was accepted"; fi
[ ! -e "$T/out4.txt" ] && ok "a missing input path is refused" || die "missing input wrote a file"
printf 'weights-test: %s checks passed\n' "$n"
