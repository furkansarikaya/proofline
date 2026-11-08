#!/bin/sh
# Item 30: the local test run limits itself (half the cores, nice) while CI keeps every core and normal
# priority (the doctor load line is tested in tests/core/doctor-faults.test.mjs).
set -u
here=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
fail=0
no() { echo "FAIL $*"; fail=1; }
cores=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
case "$cores" in ''|*[!0-9]*|0) cores=4 ;; esac
half=$(( (cores + 1) / 2 ))
sum() { env -u CI -u SELFTEST_JOBS "$@" SELFTEST_ONLY=classify-test LC_ONLY=zznomatch sh "$here/tests/selftest.sh" 2>&1; }
# CI path: every core, no nice note (unchanged)
out=$(sum CI=true)
case "$out" in *"$cores jobs"*) ;; *) no "CI=true should use $cores jobs: $out" ;; esac
case "$out" in *niced*) no "CI=true must not nice: $out" ;; esac
# local default: half the cores (min 1), niced when nice exists
out=$(sum)
case "$out" in *"$half jobs"*) ;; *) no "local default should be $half jobs: $out" ;; esac
if command -v nice >/dev/null 2>&1; then case "$out" in *niced*) ;; *) no "local run should be niced: $out" ;; esac; fi
# SELFTEST_JOBS overrides in both modes
out=$(sum SELFTEST_JOBS=3); case "$out" in *"3 jobs"*) ;; *) no "SELFTEST_JOBS override: $out" ;; esac

# the doctor load line (high load names the busiest executable, a fine or unreadable load prints nothing) is tested in Node: tests/core/doctor-faults.test.mjs
[ "$fail" -eq 0 ] && echo "load-limits-test: all passed"
exit "$fail"
