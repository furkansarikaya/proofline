#!/bin/sh
# One build and test run per commit (A148). Runs the configured commands.build then commands.test once for a
# given source state, in a separate export directory (never the working tree), and records each command, its
# real exit status and its full output under .agents/local/builds/<KEY>/. Reviewers and the verifier read that
# record (`agent.sh build-record <ID> show`) instead of building again. A key may hold several commands (a block
# list, A173): all of them run, each with its own record labelled `build[2/3]`; one failing does not hide the others.
# The verifier's own independent re-run in `submit` (A107) is unchanged and does not use this record.
# Run by the lead only: `agent.sh build-record <ID> run`, and dispatch.sh before a reviewer or verifier starts.
#   build-record.sh run [REV]    run once for REV (default: the current tree, committed or not); reuse a finished
#                                record; wait while another process runs the same key; prints the record
#   build-record.sh show [REV]   print the record; exit 3 when there is none yet
# KEY = <commit hash, or tree-<tree hash> of the working tree without .agents/runs and .agents/local>-<8 hex of
# the hash of the configured commands.install|build|test strings>, so a changed command never reuses a record.
# The record has a `steps` file (one `<file id><TAB><label>` line per command that ran, in run order). A key with one
# command keeps the file ids install, build and test, so a scalar config and older records read as before.
# Exit status of `run`/`show`: 0 every command passed, 1 a command failed (the record says which), 2 usage,
# nothing configured or not allowed, 3 no record.
# Dependencies (the export holds tracked and untracked files, not ignored ones): `commands.install`, when
# configured, runs first in the export (it is part of the record); otherwise the ignored dependency
# directories node_modules, vendor and .venv of the project root are symlinked into the export.
# shortcut: the symlinks are shared with the project (a build tool may write into them) and only the root-level
# directories are linked; the key covers sources and command strings, not node version or installed packages.
# Set `commands.install` when that matters. A stale lock is reclaimed when its process is dead or after
# BUILD_RECORD_WAIT seconds (default 1800); two waiters reclaiming at the very same moment is not guarded.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
op=${1:-}; rev=${2:-}
case "$op" in run|show) ;; *) echo "usage: build-record.sh <run|show> [REV]" >&2; exit 2 ;; esac
case "${AGENT_ROLE:-lead}" in lead) ;; *) [ "$op" = show ] || { echo "build-record: only the lead runs the build (agent.sh build-record <ID> run); use show" >&2; exit 2; } ;; esac
g() { git -C "$root" "$@"; }
cfgv() { sh "$here/agent.sh" config-get "commands.$1" 2>/dev/null || :; }   # one command per line (a list: every item, A173)

if [ -n "$rev" ]; then
  tree=$(g rev-parse --verify -q "$rev^{tree}") || { echo "build-record: unknown revision $rev" >&2; exit 2; }
  key=$(g rev-parse "$rev^{commit}")
else
  idx=$(mktemp "${TMPDIR:-/tmp}/build-record-idx.XXXXXX") || exit 2; rm -f "$idx"
  tree=$(GIT_INDEX_FILE=$idx; export GIT_INDEX_FILE; g add -A >/dev/null 2>&1 && g rm -r -q --cached --ignore-unmatch -- .agents/runs .agents/local >/dev/null 2>&1 && g write-tree); rm -f "$idx"
  [ -n "$tree" ] || { echo "build-record: cannot snapshot the working tree" >&2; exit 2; }
  if [ "$tree" = "$(g rev-parse 'HEAD^{tree}' 2>/dev/null)" ]; then key=$(g rev-parse HEAD); else key=tree-$tree; fi
fi
tab=$(printf '\t')
ic=$(cfgv install); bc=$(cfgv build); tc=$(cfgv test)
key=$key-$(printf '%s\n%s\n%s\n' "$ic" "$bc" "$tc" | g hash-object --stdin | cut -c1-8)
dir=$root/.agents/local/builds/$key

show() { # per command: its text, exit status, the last output lines; the full output stays in the .out file
  if [ -f "$dir/steps" ]; then st=$(cat "$dir/steps"); else st=$(printf 'install\tinstall\nbuild\tbuild\ntest\ttest\n'); fi
  multi=no; failed=''
  while IFS="$tab" read -r sid slabel; do
    [ -n "$sid" ] && [ -f "$dir/$sid.exit" ] || continue
    se=$(cat "$dir/$sid.exit")
    printf 'key: %s\n%s: %s\nexit: %s\noutput-file: %s\n' "$key" "$slabel" "$(cat "$dir/$sid.cmd")" "$se" ".agents/local/builds/$key/$sid.out"
    printf 'output-tail:\n'; tail -n 15 "$dir/$sid.out" | sed 's/^/  /'
    case "$slabel" in *'['*) multi=yes ;; esac
    [ "$se" = 0 ] || failed="$failed$slabel (exit $se)
"
  done <<EOF_STEPS
$st
EOF_STEPS
  if [ "$multi" = yes ]; then   # a command list: say which one broke, and that the others did not
    if [ -n "$failed" ]; then printf '%s' "$failed" | sed 's/^/failed: /'; else echo 'all commands passed'; fi
  fi
  [ "$(cat "$dir/done")" = 0 ]
}

if [ "$op" = show ]; then
  [ -f "$dir/done" ] || { echo "build-record: no finished record for $key (the lead runs: agent.sh build-record <ID> run)" >&2; exit 3; }
  show; exit $?
fi

if [ ! -f "$dir/done" ]; then
  [ -n "$bc$tc" ] || { echo "build-record: commands.build and commands.test are not configured" >&2; exit 2; }
  mkdir -p "$root/.agents/local/builds" || exit 2
  n=0; wait_max=${BUILD_RECORD_WAIT:-1800}; mine=no
  while [ ! -f "$dir/done" ]; do
    if mkdir "$dir.lock" 2>/dev/null; then echo $$ > "$dir.lock/pid"; mine=yes; break; fi
    p=$(cat "$dir.lock/pid" 2>/dev/null || :)
    if { [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; } || [ "$n" -ge "$wait_max" ]; then
      mv "$dir.lock" "$dir.lock.stale.$$" 2>/dev/null && rm -rf "$dir.lock.stale.$$"; n=0; continue
    fi
    sleep 1; n=$((n + 1))
  done
  if [ "$mine" = yes ]; then
    trap 'rm -rf "$dir.lock" "${wt:-}"' EXIT INT TERM
    if [ ! -f "$dir/done" ]; then
      rm -rf "$dir"; mkdir -p "$dir"
      wt=$(mktemp -d "${TMPDIR:-/tmp}/build-record.XXXXXX") || exit 2
      idx=$wt/index; GIT_INDEX_FILE=$idx g read-tree "$tree" && GIT_INDEX_FILE=$idx g checkout-index -a -f --prefix="$wt/src/"; rc=$?
      [ "$rc" = 0 ] || { echo "build-record: cannot export $key" >&2; exit 2; }
      if [ -z "$ic" ]; then
        for d in node_modules vendor .venv; do [ -d "$root/$d" ] && [ ! -e "$wt/src/$d" ] && ln -s "$root/$d" "$wt/src/$d"; done
      fi
      fail=0; to=''; command -v timeout >/dev/null 2>&1 && to='timeout 900'; : > "$dir/steps"
      for s in install build test; do
        case $s in install) l=$ic ;; build) l=$bc ;; *) l=$tc ;; esac
        [ -n "$l" ] || continue
        total=$(printf '%s\n' "$l" | grep -c .); i=0; kfail=0
        while IFS= read -r c; do
          [ -n "$c" ] || continue
          i=$((i + 1))
          if [ "$total" -gt 1 ]; then id=$s.$i; label="${s}[$i/$total]"; else id=$s; label=$s; fi
          printf '%s\n' "$c" > "$dir/$id.cmd"
          (cd "$wt/src" && $to sh -c "$c" < /dev/null) > "$dir/$id.out" 2>&1; e=$?
          printf '%s\n' "$e" > "$dir/$id.exit"; printf '%s\t%s\n' "$id" "$label" >> "$dir/steps"
          [ "$e" = 0 ] || kfail=1   # the rest of the same list still runs: every command reports on its own
        done <<EOF_CMDS
$l
EOF_CMDS
        [ "$kfail" = 0 ] || { fail=1; break; }   # nothing after a failed key (a failed build is not tested)
      done
      echo "$fail" > "$dir/done"
    fi
  fi
fi
show
