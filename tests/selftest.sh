#!/bin/sh
# Repository self-test runner (D27 layer 1): runs every shell suite, the control-plane suites
# control-plane/agents/scripts/*-test.sh and the repository suites tests/*/*-test.sh (enforcement, generator,
# cli, ...). Each suite builds its own throwaway repositories under $TMPDIR.
# Suites run in parallel (SELFTEST_JOBS, default 4). SELFTEST_ONLY=<name> runs the suite with that name
# (e.g. gates-test); a value matching no name exactly selects every suite whose name contains it.
# Prints one PASS/FAIL line per suite, the failing suite's log tail, and a pass/total summary.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
logs=$(mktemp -d "${TMPDIR:-/tmp}/proofline-selftest.XXXXXX")
trap 'rm -rf "$logs"' EXIT
jobs=${SELFTEST_JOBS:-4}
case "$jobs" in ''|*[!0-9]*|0) jobs=4 ;; esac
only=${SELFTEST_ONLY:-}

all=''
for s in "$here"/../control-plane/agents/scripts/*-test.sh "$here"/*/*-test.sh; do
  [ -f "$s" ] && all="$all $s"
done
exact=no
for s in $all; do [ "$(basename "$s" .sh)" != "$only" ] || exact=yes; done
suites=''
for s in $all; do
  n=$(basename "$s" .sh)
  if [ "$exact" = yes ]; then [ "$n" = "$only" ] || continue; else case "$n" in *"$only"*) ;; *) continue ;; esac; fi
  suites="$suites $s"
done
[ -n "$suites" ] || { echo "selftest: no suite matches '${only}'" >&2; exit 2; }

run_one() { n=$(basename "$1" .sh); sh "$1" > "$logs/$n.log" 2>&1; echo $? > "$logs/$n.rc"; }
running=0
for s in $suites; do
  run_one "$s" &
  running=$((running + 1))
  if [ "$running" -ge "$jobs" ]; then wait; running=0; fi
done
wait

pass=0 total=0
for s in $suites; do
  n=$(basename "$s" .sh)
  total=$((total + 1))
  rc=$(cat "$logs/$n.rc" 2>/dev/null || echo 1)
  cases=$(grep -c '^\(ok\|PASS\) ' "$logs/$n.log" 2>/dev/null || true)
  if [ "$rc" = 0 ]; then pass=$((pass + 1)); printf 'PASS %s (%s cases)\n' "$n" "${cases:-0}"
  else printf 'FAIL %s (exit %s)\n' "$n" "$rc"; tail -n 15 "$logs/$n.log" | sed 's/^/    /'; fi
done
printf 'selftest: %s/%s suites passed\n' "$pass" "$total"
[ "$pass" = "$total" ]
