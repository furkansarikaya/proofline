#!/bin/sh
# One build and test run per commit (A148). Runs the configured commands.build then commands.test once for a
# given source state, in a separate export directory (never the working tree), and records each command, its
# real exit status and its full output under .agents/local/builds/<KEY>/. Later callers (reviewers, the
# verifier) read that record instead of building again. The verifier's own independent re-run (A107) is
# unchanged and does not use this record.
#   build-record.sh run [REV]    run once for REV (default: the current tree, committed or not); reuse a finished
#                                record; wait while another process is running the same key; prints the record
#   build-record.sh show [REV]   print the record; exit 3 when there is none yet
# KEY is the commit hash when the tree equals that commit, else `tree-<tree hash>` of the working tree
# (without .agents/runs and .agents/local). Exit status of `run`/`show`: 0 every command passed, 1 a command
# failed (the record says which), 2 usage or nothing configured, 3 no record.
# shortcut: the key covers the source tree only, not the environment (node version, installed packages); add it when that matters.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
op=${1:-}; rev=${2:-}
case "$op" in run|show) ;; *) echo "usage: build-record.sh <run|show> [REV]" >&2; exit 2 ;; esac
g() { git -C "$root" "$@"; }

if [ -n "$rev" ]; then
  tree=$(g rev-parse --verify -q "$rev^{tree}") || { echo "build-record: unknown revision $rev" >&2; exit 2; }
  key=$(g rev-parse "$rev^{commit}")
else
  idx=$(mktemp "${TMPDIR:-/tmp}/build-record-idx.XXXXXX") || exit 2; rm -f "$idx"
  tree=$(GIT_INDEX_FILE=$idx; export GIT_INDEX_FILE; g add -A >/dev/null 2>&1 && g rm -r -q --cached --ignore-unmatch -- .agents/runs .agents/local >/dev/null 2>&1 && g write-tree); rm -f "$idx"
  [ -n "$tree" ] || { echo "build-record: cannot snapshot the working tree" >&2; exit 2; }
  if [ "$tree" = "$(g rev-parse 'HEAD^{tree}' 2>/dev/null)" ]; then key=$(g rev-parse HEAD); else key=tree-$tree; fi
fi
dir=$root/.agents/local/builds/$key

show() { # per command: its text, exit status, the last output lines; the full output stays in the .out file
  for s in build test; do
    [ -f "$dir/$s.exit" ] || continue
    printf 'key: %s\n%s: %s\nexit: %s\noutput-file: %s\n' "$key" "$s" "$(cat "$dir/$s.cmd")" "$(cat "$dir/$s.exit")" ".agents/local/builds/$key/$s.out"
    printf 'output-tail:\n'; tail -n 15 "$dir/$s.out" | sed 's/^/  /'
  done
  [ "$(cat "$dir/done")" = 0 ]
}

if [ "$op" = show ]; then
  [ -f "$dir/done" ] || { echo "build-record: no finished record for $key (run: sh .agents/scripts/build-record.sh run)" >&2; exit 3; }
  show; exit $?
fi

if [ ! -f "$dir/done" ]; then
  mkdir -p "$root/.agents/local/builds" || exit 2
  if mkdir "$dir.lock" 2>/dev/null; then
    trap 'rm -rf "$dir.lock" "${wt:-}"' EXIT INT TERM
    rm -rf "$dir"; mkdir -p "$dir"
    wt=$(mktemp -d "${TMPDIR:-/tmp}/build-record.XXXXXX") || exit 2
    idx=$wt/index; GIT_INDEX_FILE=$idx g read-tree "$tree" && GIT_INDEX_FILE=$idx g checkout-index -a -f --prefix="$wt/src/"; rc=$?
    [ "$rc" = 0 ] || { echo "build-record: cannot export $key" >&2; exit 2; }
    fail=0; ran=0; to=''; command -v timeout >/dev/null 2>&1 && to='timeout 900'
    for s in build test; do
      c=$(sh "$here/agent.sh" config-get "commands.$s" 2>/dev/null) || c=''
      [ -n "$c" ] || continue
      ran=1; printf '%s\n' "$c" > "$dir/$s.cmd"
      (cd "$wt/src" && $to sh -c "$c") > "$dir/$s.out" 2>&1; e=$?
      printf '%s\n' "$e" > "$dir/$s.exit"
      [ "$e" = 0 ] || { fail=1; break; }   # no test run after a failed build
    done
    [ "$ran" = 1 ] || { rm -rf "$dir"; echo "build-record: commands.build and commands.test are not configured" >&2; exit 2; }
    echo "$fail" > "$dir/done"
  else   # another process runs this key: wait for it (at most 30 minutes)
    n=0; while [ ! -f "$dir/done" ] && [ -d "$dir.lock" ] && [ "$n" -lt 1800 ]; do sleep 1; n=$((n + 1)); done
    [ -f "$dir/done" ] || { echo "build-record: the run for $key did not finish" >&2; exit 2; }
  fi
fi
show
