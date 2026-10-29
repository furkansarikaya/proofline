#!/bin/sh
# Repository self-test runner (D27 layer 1): runs every shell suite, the control-plane suites
# control-plane/agents/scripts/*-test.sh and the repository suites tests/*/*-test.sh (enforcement, generator,
# cli, ...). Each suite builds its own throwaway repositories under $TMPDIR.
# A suite that lists its scenarios (`run_sc NAME` lines, or a `scenarios='...'` line) is split into one unit per
# scenario; every unit is an independent process with its own log. Units run in parallel on all cores
# (SELFTEST_JOBS overrides the count), so the wall time is the total work divided by the cores (A76).
# Run locally (CI unset) it uses half the cores (min 1) and runs every unit under `nice -n 10` (when nice exists),
# so the machine stays usable; with CI set (GitHub Actions) the count is all cores and nothing is niced, as before.
#   SELFTEST_ONLY=<name>   runs the suite with that name (e.g. gates-test); a value matching no name exactly
#                          selects every suite whose name contains it.
#   SELFTEST_SHARD=I/N     runs only shard I of N (CI splits the work over N jobs); units are spread by the
#                          weights in tests/selftest-weights.txt (A109).
#   SELFTEST_LIST=1        prints the shard's units and exits (shows the split; no test runs); =weights prefixes the
#                          weight each unit was given. A unit missing from the weights file weighs the median of the listed.
#   SELFTEST_WEIGHTS=FILE  weights file to use instead of tests/selftest-weights.txt.
#   SELFTEST_TIMES_FILE=F  appends one line "<seconds> <suite> [scenario]" per unit this run executed; tests/selftest-weights.sh
#                          merges such files into tests/selftest-weights.txt.
#   SELFTEST_TEMPLATE_DIR  cache of installed template repositories shared by the units of one run (default: inside the
#                          run's own log directory, removed at the end); each scenario copies a template, never shares one.
#   SELFTEST_SLOWEST=K    prints the K slowest units (default 5); K=999 lists every unit to refresh the weights.
#   LC_ONLY=<substring>    runs only the scenarios whose line contains it.
# Prints one PASS/FAIL line per suite, the failing unit's log tail, the slowest units and a pass/total summary.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
self=$here/selftest.sh

if [ "${1:-}" = --unit ]; then   # worker: --unit LOGDIR INDEX
  logs=$2 i=$3
  line=$(sed -n "${i}p" "$logs/units")
  suite=${line%%|*} scen=${line#*|}
  st=$(date +%s)
  if [ -n "$scen" ]; then LC_EXACT=$scen sh "$suite" > "$logs/$i.log" 2>&1; else sh "$suite" > "$logs/$i.log" 2>&1; fi
  echo $? > "$logs/$i.rc"
  echo $(( $(date +%s) - st )) > "$logs/$i.t"
  exit 0
fi

logs=$(mktemp -d "${TMPDIR:-/tmp}/proofline-selftest.XXXXXX") || { echo "selftest: TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }
[ -n "$logs" ] && [ -d "$logs" ] || { echo "selftest: no log directory" >&2; exit 2; }
trap 'rm -rf "$logs"' EXIT
# One installed-template cache for every unit of this run (tests/shared/fixture-lib.sh); gone with the logs.
if [ -z "${SELFTEST_TEMPLATE_DIR:-}" ]; then SELFTEST_TEMPLATE_DIR=$logs/templates; export SELFTEST_TEMPLATE_DIR; fi
cores=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
case "$cores" in ''|*[!0-9]*|0) cores=4 ;; esac
nice_cmd=''
if [ -z "${CI:-}" ]; then   # local run: half the cores, low priority; CI keeps every core and normal priority
  cores=$(( (cores + 1) / 2 )); [ "$cores" -ge 1 ] || cores=1
  ! command -v nice >/dev/null 2>&1 || nice_cmd='nice -n 10'
fi
jobs=${SELFTEST_JOBS:-$cores}
case "$jobs" in ''|*[!0-9]*|0) jobs=4 ;; esac
only=${SELFTEST_ONLY:-}
lc_only=${LC_ONLY:-}
shard=${SELFTEST_SHARD:-1/1}
shard_i=${shard%/*} shard_n=${shard#*/}
case "$shard_i$shard_n" in ''|*[!0-9]*) echo "selftest: SELFTEST_SHARD must be I/N" >&2; exit 2 ;; esac
{ [ "$shard_i" -ge 1 ] && [ "$shard_i" -le "$shard_n" ]; } || { echo "selftest: SELFTEST_SHARD must be I/N with 1 <= I <= N" >&2; exit 2; }

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

# scenarios_of SUITE: one scenario per line, exactly as run_sc receives it ("name" or "name arg").
scenarios_of() {
  sed -n 's/^run_sc \([A-Za-z_].*\)$/\1/p' "$1"
  sed -n "s/^scenarios='\\(.*\\)'\$/\\1/p" "$1" | tr ' ' '\n' | sed '/^$/d'
}
# Unsplit suites first (their length is unknown), then the scenario units in suite order.
: > "$logs/units"
for s in $suites; do
  [ -n "$(scenarios_of "$s")" ] || printf '%s|\n' "$s" >> "$logs/units"
done
for s in $suites; do
  scenarios_of "$s" | while IFS= read -r sc; do
    [ -z "$lc_only" ] || case "$sc" in *"$lc_only"*) ;; *) continue ;; esac
    printf '%s|%s\n' "$s" "$sc" >> "$logs/units"
  done
done
# A109: units go to shards by weight (tests/selftest-weights.txt, default 15), longest first onto the lightest
# shard, so no shard collects the heavy units; every unit lands in exactly one shard. `mine` lists this
# shard's unit numbers, heaviest first (the best start order for the parallel workers).
weights=${SELFTEST_WEIGHTS:-$here/selftest-weights.txt}
[ -f "$weights" ] || weights=/dev/null
# A unit that is not listed weighs the MEDIAN of the listed units (a stale file then still balances the shards).
awk -v wf="$weights" '
  FILENAME == wf { if ($1 ~ /^[0-9]+$/) { w = $1; sub(/^[0-9]+ +/, ""); sub(/ +$/, ""); wt[$0] = w; vals[++nv] = w + 0 } ; next }
  !med_set {   # median of the listed weights, once
    med_set = 1; med = 15
    if (nv > 0) {
      for (a = 2; a <= nv; a++) { v = vals[a]; b = a - 1; while (b >= 1 && vals[b] > v) { vals[b + 1] = vals[b]; b-- } vals[b + 1] = v }
      med = (nv % 2) ? vals[(nv + 1) / 2] : int((vals[nv / 2] + vals[nv / 2 + 1]) / 2)
    }
  }
  { s = $0; sub(/\|.*/, "", s); sc = $0; sub(/^[^|]*\|/, "", sc); sub(/.*\//, "", s); sub(/\.sh$/, "", s)
    k = (sc == "") ? s : s " " sc
    print ((k in wt) ? wt[k] : med), FNR }
' "$weights" "$logs/units" | sort -k1,1nr -k2,2n > "$logs/weighed"
awk -v n="$shard_n" -v me="$shard_i" '
  { b = 1; for (j = 2; j <= n; j++) if (load[j] < load[b]) b = j
    load[b] += $1; if (b == me) print $2 }
' "$logs/weighed" > "$logs/mine"
if [ -n "${SELFTEST_LIST:-}" ]; then   # print this shard's units (suite|scenario) and stop; =weights prefixes the weight
  for i in $(cat "$logs/mine"); do
    if [ "$SELFTEST_LIST" = weights ]; then printf '%s ' "$(awk -v i="$i" '$2 == i { print $1 }' "$logs/weighed")"; fi
    sed -n "${i}p" "$logs/units"
  done
  exit 0
fi

wall_start=$(date +%s)
# shellcheck disable=SC2086 # nice_cmd is "nice -n 10" or empty on purpose
[ ! -s "$logs/mine" ] || xargs -n 1 -P "$jobs" $nice_cmd sh "$self" --unit "$logs" < "$logs/mine"
wall=$(( $(date +%s) - wall_start ))

pass=0 total=0
for s in $suites; do
  n=$(basename "$s" .sh)
  ok=yes seen=no cases=0
  for i in $(cat "$logs/mine"); do
    line=$(sed -n "${i}p" "$logs/units")
    [ "${line%%|*}" = "$s" ] || continue
    seen=yes
    scen=${line#*|}
    rc=$(cat "$logs/$i.rc" 2>/dev/null || echo 1)
    c=$(grep -c '^\(ok\|PASS\|skip\) ' "$logs/$i.log" 2>/dev/null || true)
    cases=$((cases + ${c:-0}))
    # a scenario unit that ran no case selected nothing: that is a failure, not a pass
    if [ "$rc" != 0 ] || { [ -n "$scen" ] && [ "${c:-0}" = 0 ]; }; then
      ok=no; printf 'FAIL %s%s (exit %s)\n' "$n" "${scen:+ [$scen]}" "$rc"; tail -n 15 "$logs/$i.log" | sed 's/^/    /'
    fi
  done
  [ "$seen" = yes ] || continue
  total=$((total + 1))
  if [ "$ok" = yes ]; then pass=$((pass + 1)); printf 'PASS %s (%s cases)\n' "$n" "$cases"; fi
done
for i in $(cat "$logs/mine"); do
  line=$(sed -n "${i}p" "$logs/units")
  printf '%s %s %s\n' "$(cat "$logs/$i.t" 2>/dev/null || echo 0)" "$(basename "${line%%|*}" .sh)" "${line#*|}"
done | sort -rn | head -n "${SELFTEST_SLOWEST:-5}" | sed 's/^/slowest: /'
if [ -n "${SELFTEST_TIMES_FILE:-}" ]; then   # the measured seconds of this shard's units, in the weights file's format
  for i in $(cat "$logs/mine"); do
    line=$(sed -n "${i}p" "$logs/units"); scen=${line#*|}
    printf '%s %s%s\n' "$(cat "$logs/$i.t" 2>/dev/null || echo 0)" "$(basename "${line%%|*}" .sh)" "${scen:+ $scen}"
  done >> "$SELFTEST_TIMES_FILE"
fi
printf 'selftest: %s/%s suites passed (%s units, %s jobs, shard %s, %ss)\n' "$pass" "$total" "$(wc -l < "$logs/mine" | tr -d ' ')" "$jobs" "$shard" "$wall"
[ -z "$nice_cmd" ] || echo "selftest: local run, units niced (SELFTEST_JOBS overrides the job count; CI=1 disables the limits)"
[ "$pass" = "$total" ]
