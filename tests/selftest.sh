#!/bin/sh
# Repository self-test runner (D27 layer 1): runs every shell suite, the control-plane suites
# control-plane/agents/scripts/*-test.sh and the repository suites tests/*/*-test.sh (enforcement, generator,
# cli, ...). Each suite builds its own throwaway repositories under $TMPDIR.
# A suite that lists its scenarios (`run_sc NAME` lines, or a `scenarios='...'` line) is split into one unit per
# scenario; every unit is an independent process with its own log. Units run in parallel on all cores
# (SELFTEST_JOBS overrides the count), so the wall time is the total work divided by the cores (A76).
#   SELFTEST_ONLY=<name>   runs the suite with that name (e.g. gates-test); a value matching no name exactly
#                          selects every suite whose name contains it.
#   SELFTEST_SHARD=I/N     runs only the units with index % N == I-1 (CI splits the work over N jobs).
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

logs=$(mktemp -d "${TMPDIR:-/tmp}/proofline-selftest.XXXXXX")
trap 'rm -rf "$logs"' EXIT
jobs=${SELFTEST_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}
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
total_units=$(wc -l < "$logs/units" | tr -d ' ')
: > "$logs/mine"
i=1
while [ "$i" -le "$total_units" ]; do
  [ $(( (i - 1) % shard_n )) -ne $((shard_i - 1)) ] || echo "$i" >> "$logs/mine"
  i=$((i + 1))
done

wall_start=$(date +%s)
[ ! -s "$logs/mine" ] || xargs -n 1 -P "$jobs" sh "$self" --unit "$logs" < "$logs/mine"
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
done | sort -rn | head -n 5 | sed 's/^/slowest: /'
printf 'selftest: %s/%s suites passed (%s units, %s jobs, shard %s, %ss)\n' "$pass" "$total" "$(wc -l < "$logs/mine" | tr -d ' ')" "$jobs" "$shard" "$wall"
[ "$pass" = "$total" ]
