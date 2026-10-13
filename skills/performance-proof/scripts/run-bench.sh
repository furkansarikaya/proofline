#!/bin/sh
# Runs one benchmark command N times in a base and a change directory (two git worktrees), interleaved in
# ABBA order (pair 1 base first, pair 2 change first, ...) so slow drift of the machine hits both sides alike.
# Writes into --out: base.csv and change.csv (run,side,value,unit,exit,started_at; value = wall time in ms),
# environment.txt (key=value: OS, CPU count, load average before and after, command, warmup runs, runs,
# order, timer, revisions, timestamps, runtime versions) and bench.log (the command's output).
# Wall time comes from the first working clock: date +%s.%N, perl Time::HiRes, python3, node. The clock's own
# start-up time is inside every sample on both sides alike (a constant offset, not a difference).
# Usage: sh run-bench.sh --base DIR --change DIR --runs N [--warmup W] [--timeout S] --out DIR -- CMD [ARG...]
#   --warmup W   unrecorded runs per side before measuring (default 1)
#   --timeout S  per-run limit in seconds, at least 30 (default 300); a timed-out run is a failed run
# Exit: 0 every run exited 0; 1 a run failed (it is recorded with its exit code and is not a sample);
# 2 usage error or no usable clock. Installs nothing; POSIX sh.
set -eu
die() { printf 'run-bench: %s\n' "$*" >&2; exit 2; }
isnum() { case $1 in ''|*[!0-9]*) return 1 ;; esac; }

base='' change='' runs='' warmup=1 timeout=300 out=''
while [ $# -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    --base|--change|--runs|--warmup|--timeout|--out)
      [ $# -ge 2 ] || die "$1 needs a value"
      case $1 in
        --base) base=$2 ;; --change) change=$2 ;; --runs) runs=$2 ;;
        --warmup) warmup=$2 ;; --timeout) timeout=$2 ;; --out) out=$2 ;;
      esac
      shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ $# -gt 0 ] || die "no command after --"
[ -d "$base" ] || die "--base is not a directory: $base"
[ -d "$change" ] || die "--change is not a directory: $change"
[ -n "$out" ] || die "--out is required"
isnum "$runs" && [ "$runs" -ge 1 ] || die "--runs must be an integer >= 1"
isnum "$warmup" || die "--warmup must be an integer >= 0"
isnum "$timeout" && [ "$timeout" -ge 30 ] || die "--timeout must be an integer >= 30 (seconds)"
mkdir -p "$out"
base=$(cd "$base" && pwd) change=$(cd "$change" && pwd)

clock=''
t=$(date +%s.%N 2>/dev/null || true)
case $t in ''|*.|*[!0-9.]*) ;; *) clock='date' ;; esac   # macOS date prints a literal N
if [ -z "$clock" ] && perl -MTime::HiRes=time -e 'printf "%.6f\n", time' >/dev/null 2>&1; then clock=perl; fi
if [ -z "$clock" ] && python3 -c 'import time' >/dev/null 2>&1; then clock=python3; fi
if [ -z "$clock" ] && node -e '' >/dev/null 2>&1; then clock=node; fi
[ -n "$clock" ] || die "no sub-second clock (date +%N, perl, python3 or node): UNSUPPORTED"
now() {
  case $clock in
    date) date +%s.%N ;;
    perl) perl -MTime::HiRes=time -e 'printf "%.6f\n", time' ;;
    python3) python3 -c 'import time; print("%.6f" % time.time())' ;;
    node) node -e 'console.log(((performance.timeOrigin + performance.now()) / 1000).toFixed(6))' ;;
  esac
}
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
loadavg() {
  l=$(uptime 2>/dev/null | sed -n 's/.*load averages*: *//p')
  [ -n "$l" ] || l=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || true)
  printf '%s\n' "${l:-unknown}"
}
rev() {
  r=$(git -C "$1" rev-parse HEAD 2>/dev/null || echo unknown)
  if [ "$r" != unknown ] && [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; then r="$r+uncommitted"; fi
  printf '%s\n' "$r"
}

env_file=$out/environment.txt
{
  echo "os=$(uname -s) $(uname -r) $(uname -m)"
  echo "cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo unknown)"
  echo "load_avg_before=$(loadavg)"
  echo "command=$*"
  echo "warmup_runs=$warmup"
  echo "runs=$runs"
  echo "order=interleaved"
  echo "timer=$clock"
  echo "timeout_s=$timeout"
  echo "base_dir=$base"
  echo "base_rev=$(rev "$base")"
  echo "change_dir=$change"
  echo "change_rev=$(rev "$change")"
  for tv in node go rustc java dotnet python3 ruby php; do
    command -v "$tv" >/dev/null 2>&1 || continue
    case $tv in
      go) v=$(go version 2>&1 | head -n 1) ;;
      java) v=$(java -version 2>&1 | head -n 1) ;;
      *) v=$("$tv" --version 2>&1 | head -n 1) ;;
    esac
    echo "tool_version.$tv=$v"
  done
  echo "started_at=$(stamp)"
} > "$env_file"

log=$out/bench.log
: > "$log"
for s in base change; do echo "run,side,value,unit,exit,started_at" > "$out/$s.csv"; done
failed=0

# run_one LABEL DIR CMD...: runs CMD in DIR under the timeout; sets rc and ms.
run_one() {
  ro_label=$1 ro_dir=$2; shift 2
  echo "== $ro_label" >> "$log"
  t0=$(now)
  ( cd "$ro_dir" && exec "$@" ) >> "$log" 2>&1 < /dev/null &
  ro_pid=$!
  # Watchdog: on TERM it stops its own sleep and exits 0, so no sleeper is left behind and no job notice prints.
  (
    trap 'kill "$ro_sp" 2>/dev/null; exit 0' TERM
    sleep "$timeout" & ro_sp=$!
    wait "$ro_sp" && kill -TERM "$ro_pid" 2>/dev/null
  ) > /dev/null 2>&1 < /dev/null &
  ro_wd=$!
  rc=0; wait "$ro_pid" || rc=$?
  t1=$(now)
  kill "$ro_wd" 2>/dev/null || true
  wait "$ro_wd" 2>/dev/null || true
  ms=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.3f", (b - a) * 1000 }')
}
dir_of() { if [ "$1" = base ]; then echo "$base"; else echo "$change"; fi; }

i=0
while [ "$i" -lt "$warmup" ]; do
  i=$((i + 1))
  for s in base change; do
    run_one "warmup $i $s" "$(dir_of "$s")" "$@"
    [ "$rc" = 0 ] || die "warmup run $i on $s exited $rc (see $log)"
  done
done

i=0
while [ "$i" -lt "$runs" ]; do
  i=$((i + 1))
  if [ $((i % 2)) = 1 ]; then order="base change"; else order="change base"; fi
  for s in $order; do
    at=$(stamp)
    run_one "run $i $s" "$(dir_of "$s")" "$@"
    [ "$rc" = 0 ] || failed=1
    echo "$i,$s,$ms,ms,$rc,$at" >> "$out/$s.csv"
  done
done

{ echo "load_avg_after=$(loadavg)"; echo "finished_at=$(stamp)"; } >> "$env_file"
if [ "$failed" = 1 ]; then echo "run-bench: a run failed; failed runs are not samples (see $log)" >&2; exit 1; fi
echo "run-bench: $runs runs per side in $out"
