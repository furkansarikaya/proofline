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
# the hash of the configured commands.install|build|test strings (and verification.env_files, when set)>, so a changed command never reuses a record.
# The record has a `steps` file (one `<file id><TAB><label>` line per command that ran, in run order). A key with one
# command keeps the file ids install, build and test, so a scalar config and older records read as before.
# Exit status of `run`/`show`: 0 every command passed, 1 a command failed (the record says which), 2 usage,
# nothing configured or not allowed, 3 no record.
# Dependencies (the export holds tracked and untracked files, not ignored ones): `commands.install`, when
# configured, runs first in the export (it is part of the record); otherwise the ignored dependency folders that
# worktree_deps names in ecosystems.json (A185) are COPIED into the export by worktree-prep.sh --deps, never linked.
# Env files (verification.env_files, default none): secret-free test env files (for example .env.test) that MAY enter the export; every
# other .env* stays out. Each listed file is scanned first (secret-scan.sh, the project's own scanner included); one visible secret
# rejects the run with exit 2, naming the file and line (never the value), before anything is built.
# shortcut: the copy is taken at run time and is not part of the key; the key covers sources and command strings, not node version or installed packages.
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
# The commands are part of the key. Scalar config (one command or none per kind) keeps the original form, so a record made before the
# lists existed stays valid. A list prefixes every line with its kind, so `build:[a,b] test:[c]` and `build:[a] test:[b,c]` differ.
if [ "$(printf '%s\n%s\n%s\n' "$ic" "$bc" "$tc" | wc -l | tr -d ' ')" -le 3 ]; then
  ckey=$(printf '%s\n%s\n%s\n' "$ic" "$bc" "$tc" | g hash-object --stdin | cut -c1-8)
else
  ckey=$( { printf '%s\n' "$ic" | sed 's/^/install:/'; printf '%s\n' "$bc" | sed 's/^/build:/'; printf '%s\n' "$tc" | sed 's/^/test:/'; } | g hash-object --stdin | cut -c1-8)
fi
envs=$(sh "$here/agent.sh" config-get verification.env_files 2>/dev/null | tr -s ' \t' '\n' | sed '/^$/d' || :)
[ -z "$envs" ] || ckey=$(printf '%s\nenv_files:%s\n' "$ckey" "$envs" | g hash-object --stdin | cut -c1-8)
key=$key-$ckey
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
  # a failed record: the export is clean (tracked and untracked files only), so a test that needs a git-ignored file (.env, a local database, generated files) fails there
  [ "$(cat "$dir/done")" = 0 ] || { echo 'note: the build export holds no git-ignored files (such as .env; secrets are never copied into it, a secret-free test env file may be named in verification.env_files): a test that needs one must be self-contained, or commands.install must prepare it'; return 1; }
}

if [ "$op" = show ]; then
  [ -f "$dir/done" ] || { echo "build-record: no finished record for $key (the lead runs: agent.sh build-record <ID> run)" >&2; exit 3; }
  show; exit $?
fi

if [ ! -f "$dir/done" ]; then
  [ -n "$bc$tc" ] || { echo "build-record: commands.build and commands.test are not configured" >&2; exit 2; }
  mkdir -p "$root/.agents/local/builds" || exit 2
  if [ -n "$envs" ]; then   # secret-free test env files only: a visible secret rejects the record before anything runs
    [ -f "$here/secret-scan.sh" ] || { echo "build-record: secret-scan.sh is missing, so verification.env_files cannot be checked" >&2; exit 2; }
    rr=$(CDPATH='' cd -P "$root" && pwd -P) || exit 2
    for f in $envs; do   # a listed file must really lie inside the project: its parent directory, symbolic links followed, may not leave it or be under .git
      if [ ! -e "$root/$f" ] && [ ! -L "$root/$f" ]; then echo "build-record: note: verification.env_files lists $f, which does not exist; skipped" >&2; continue; fi
      pd=$(CDPATH='' cd -P "$(dirname "$root/$f")" 2>/dev/null && pwd -P) || pd=''
      case "$pd/" in "$rr"/.git/*) pd='' ;; "$rr"/*) ;; *) pd='' ;; esac
      case "/$f/" in */.git/*) pd='' ;; esac
      if [ -z "$pd" ] || [ -L "$root/$f" ]; then
        echo "build-record: rejected: verification.env_files $f is a symbolic link, or its directory resolves outside the project or into .git; nothing was built" >&2; exit 2
      fi
    done
    sd=$root/.agents/local/env-scan.$$; rm -rf "$sd"; mkdir -p "$sd" || exit 2; i=0; map=''; paths=''
    for f in $envs; do
      [ -f "$root/$f" ] || continue
      i=$((i + 1))
      # an unquoted KEY=value line is shown to the scanner as KEY="value", so its assignment rule sees env files as it sees code
      sed -E "s/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=([^\"'[:space:]#][^[:space:]#]*)/\\2=\"\\3\"/" "$root/$f" > "$sd/e$i.txt"
      map="$map$i $f
"; paths="$paths .agents/local/env-scan.$$/e$i.txt"
    done
    src=0; sout=''
    # shellcheck disable=SC2086 # the paths are plain generated names
    [ -z "$paths" ] || sout=$(sh "$here/secret-scan.sh" --root "$root" $paths 2>"$sd/err") || src=$?
    if [ "$src" != 0 ]; then
      if [ "$src" = 1 ]; then
        printf '%s\n' "$sout" | while IFS=: read -r fp ln rl; do
          [ -n "$fp" ] || continue; fi=${fp##*/e}; fi=${fi%.txt}
          printf 'build-record: rejected: verification.env_files %s:%s holds a secret (%s); the value is not shown. Remove it, or take the file out of verification.env_files\n' "$(printf '%s' "$map" | sed -n "s/^$fi //p")" "$ln" "$rl" >&2
        done
      else echo "build-record: the secret scan of verification.env_files failed (exit $src)" >&2; fi
      rm -rf "$sd"; exit 2
    fi
    rm -rf "$sd"
  fi
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
      if [ -z "$ic" ] && [ -f "$here/worktree-prep.sh" ]; then
        # A185: the dependency folders named by worktree_deps in ecosystems.json are COPIED into the export, never linked, so a build or
        # install step cannot write through into the project
        sh "$here/worktree-prep.sh" --deps "$root" "$wt/src" >/dev/null 2>&1 || :
      fi
      for f in $envs; do   # listed and scanned above; copied only when the export lacks it (a tracked file is already there)
        [ -f "$root/$f" ] && [ ! -L "$root/$f" ] && [ ! -e "$wt/src/$f" ] || continue
        mkdir -p "$wt/src/$(dirname "$f")" && cp -p "$root/$f" "$wt/src/$f"
      done
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
