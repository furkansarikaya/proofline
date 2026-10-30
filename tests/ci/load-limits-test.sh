#!/bin/sh
# Item 30: the local test run limits itself (half the cores, nice) while CI keeps every core and normal
# priority; doctor reports a high machine load in one line and stays silent otherwise.
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

# doctor: high load -> one line naming the busiest executable (name only); fine load -> nothing
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-load.XXXXXX") || exit 2
trap 'rm -rf "$T"' EXIT HUP INT TERM
mkdir -p "$T/bin"
printf '#!/bin/sh\nprintf "%%s\\n" /usr/bin/busyproc /usr/bin/busyproc /bin/other\n' > "$T/bin/ps"; chmod +x "$T/bin/ps"
# shellcheck disable=SC1091
. "$here/bin/lib/doctor.sh"
# shellcheck disable=SC2034 # read by doctor_load from the sourced doctor.sh
D_WARNS=0 D_FAILS=0
out=$(PATH="$T/bin:$PATH" PROOFLINE_DOCTOR_LOAD=120.5 PROOFLINE_DOCTOR_CORES=8 doctor_load)
case "$out" in WARN\ load:*120.5*8\ cores*busyproc*) ;; *) no "high load line: $out" ;; esac
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] || no "more than one line: $out"
out=$(PATH="$T/bin:$PATH" PROOFLINE_DOCTOR_LOAD=2.0 PROOFLINE_DOCTOR_CORES=8 doctor_load)
[ -z "$out" ] || no "fine load must print nothing: $out"
out=$(PATH="$T/bin:$PATH" PROOFLINE_DOCTOR_LOAD=junk PROOFLINE_DOCTOR_CORES=8 doctor_load); rc=$?
{ [ -z "$out" ] && [ "$rc" = 0 ]; } || no "unreadable load must be silent and succeed: $out"
[ "$fail" -eq 0 ] && echo "load-limits-test: all passed"
exit "$fail"
