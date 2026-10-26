#!/bin/sh
# shellcheck disable=SC2015,SC2016 # assertion chains; the hung tree is literal command text
# shellcheck source-path=SCRIPTDIR
# Tests for the discover timeout (A162): run_with_timeout closes the whole process group of a hung command, for every
# process-group method this machine has.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
disc=$repo/bin/lib/discover.sh
ok() { printf 'ok %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-pgt.XXXXXX") || exit 1
tok=7$$   # the sleeps of the hung tree carry a number only this run uses, so they can be found without pgrep
# left: pids of live (not zombie) processes of the hung tree
left() { ps -A -o pid=,stat=,command= 2>/dev/null | awk -v t="$tok" '$2 !~ /^Z/ && $3 == "sleep" && $4 ~ ("^" t "[0-9]$") { print $1 }'; }
reap() { for r_p in $(left); do kill -KILL "$r_p" 2>/dev/null || :; done; }
trap 'reap; rm -rf "$T"' EXIT HUP INT TERM

# 1. a hung tree under run_with_timeout, per method
# hung tree: a nested sh, a plain sleep, a subshell that ignores TERM (its sleep too), and the sh itself waits
tree() { # N: the sleep number suffix base
  printf 'sh -c "sleep %s%s" & sleep %s%s & (trap "" TERM; sleep %s%s) & wait' "$tok" 1 "$tok" 2 "$tok" 3
}
tried=0
for m in setm setsid perl python none; do
  out=$( (
    say() { :; }
    PROOFLINE_TEST=1; PROOFLINE_PGMETHOD=$m; export PROOFLINE_TEST PROOFLINE_PGMETHOD
    # shellcheck source=../../bin/lib/discover.sh
    . "$disc"
    if [ "$m" != none ] && command -v pg_probe >/dev/null 2>&1 && ! pg_probe "$m"; then echo "skip"; exit 0; fi
    st=0; run_with_timeout 2 sh -c "$(tree)" || st=$?
    echo "rc=$st"
  ) 2>&1 )
  case "$out" in *skip*) echo "skip $m: not available on this machine"; continue ;; esac
  n=$(left | wc -l | tr -d ' ')
  case "$out" in *rc=124*) ;; *) reap; die "method $m: run_with_timeout did not return 124: $out" ;; esac
  if [ "$m" = none ]; then
    # documented fallback (the `shortcut:` in run_with_timeout): only the direct child is killed, grandchildren stay
    [ "$n" -gt 0 ] || die "fallback: expected the documented leftover grandchildren, found none (the hung tree did not start?)"
    reap; ok "fallback (no process-group method): timeout returns 124 and leaves $n grandchildren, as documented"
  else
    [ "$n" -eq 0 ] || { reap; die "method $m: $n descendants of the hung tree survived the timeout"; }
    tried=$((tried + 1)); ok "method $m: timeout returns 124 and nothing of the hung tree is left"
  fi
done
[ "$tried" -gt 0 ] || die "no process-group method is available on this machine"
echo "discover-pgroup-test: all passed"
