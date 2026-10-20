#!/bin/sh
# shellcheck disable=SC2010,SC2013,SC2015,SC2016 # task IDs and our own file names are word-safe; the prompt holds literal backticks; A && B || stop on purpose
# Night mode (A157): the batch plan, the driver and the morning report. Run through `agent.sh batch-plan|batch-status`
# and `proofline batch run|status`.
#   batch.sh plan <ID...|all>  order the tasks (depends_on), leave out what a batch must not run, write
#                              .agents/local/batch/SUMMARY.md and order.tsv (agent.sh then requests the `batch` approval)
#   batch.sh run               the driver: one clean headless lead session per task, one task at a time, only with a valid
#                              batch approval (bound to the SUMMARY.md hash); the outcome of a task is read from records
#   batch.sh status            the morning table, from state.tsv, merged.tsv and the runs' own records, never from a log
# Files under .agents/local/batch/: SUMMARY.md, order.tsv (ID class depends_on), state.tsv (ID status reason question,
# status pending|running|merged|parked|skipped, a trailing `# stopped: <reason>` line), merged.tsv (ID PR epoch, written by
# deliver-step cleanup), logs/<ID>.log, LOCK (the driver's PID), history/<batch id>/.
# Test seam: `claude` and `codex` are taken from PATH (the tests put fakes there); nothing selects a binary by environment.
# Under PROOFLINE_TEST=1 only, PROOFLINE_BATCH_MINUTE is the length of one "minute" in seconds (default 60): it scales batch.task_timeout
# and the CI polling, so a test needs seconds, not hours.
set -eu
LC_ALL=C; export LC_ALL
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
agent=$here/agent.sh
bd=$root/.agents/local/batch

die() { echo "batch: $*" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 < "$1" | awk '{print $1}'; }; else sha() { sha256sum < "$1" | awk '{print $1}'; }; fi
cfgv() { v=$(sh "$agent" config-get "$1" 2>/dev/null) || v=''; [ -n "$v" ] || v=${2:-}; printf '%s\n' "$v"; }
tsv() { printf '%s' "$*" | tr '\t\n' '  '; }
bid() { sha "$bd/SUMMARY.md" | cut -c1-12; }
tick=60; [ "${PROOFLINE_TEST:-}" != 1 ] || tick=${PROOFLINE_BATCH_MINUTE:-60}; case "$tick" in ''|*[!0-9]*|0) tick=60 ;; esac
CODEX_NET='sandbox_workspace_write.network_access=true'   # the one place of the Codex override that lets workspace-write reach the network (package installs)

# --- plan ------------------------------------------------------------------------------------------------------------
cls_of() { awk '/^## Suggested class[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && match($0, /(TRIVIAL|STANDARD|COMPLEX|CRITICAL)/) { print substr($0, RSTART, RLENGTH); exit }' "$1"; }
deps_of() { awk 'NR > 1 && /^## / { exit } /^---[[:space:]]*$/ { fm = !fm; next } fm && /^depends_on:/ { sub(/^depends_on:[[:space:]]*/, ""); gsub(/["\[\]]/, ""); gsub(/[,[:space:]]+/, ","); sub(/^,/, ""); sub(/,$/, ""); print; exit }' "$1"; }
plan() {
  [ "$(cfgv tasks.adapter markdown)" = markdown ] || die "night mode reads task files through the markdown adapter only (tasks.adapter is $(cfgv tasks.adapter markdown)); known limit"
  danger=no; for a in "$@"; do shift; if [ "$a" = --codex-danger-full-access ]; then danger=yes; else set -- "$@" "$a"; fi; done
  [ $# -gt 0 ] || die "usage: agent.sh batch-plan <ID...|all> [--codex-danger-full-access]"
  td=$root/$(cfgv tasks.dir .agents/tasks)
  [ ! -f "$bd/LOCK" ] || ! kill -0 "$(cat "$bd/LOCK" 2>/dev/null)" 2>/dev/null || die "a batch is running (pid $(cat "$bd/LOCK")); a new plan waits until it ends"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-batch.XXXXXX"); trap 'rm -rf "$tmp"' 0
  : > "$tmp/sel"
  if [ "$1" = all ]; then
    [ $# -eq 1 ] || die "'all' stands alone"
    for f in "$td"/todo/*.md "$td"/*.md; do [ -f "$f" ] && basename "$f" .md; done | sort -u > "$tmp/sel" || :
  else
    for id in "$@"; do
      case "$id" in run|status|all|'') die "'$id' is a reserved word, not a task ID" ;; *[!A-Za-z0-9_-]*) die "invalid task ID: $id" ;; esac
      [ -f "$td/$id.md" ] || [ -f "$td/todo/$id.md" ] || [ -f "$td/backlog/$id.md" ] || die "task $id not found in $td (top level, todo/ or backlog/)"
      grep -Fxq "$id" "$tmp/sel" || printf '%s\n' "$id" >> "$tmp/sel"
    done
  fi
  [ -s "$tmp/sel" ] || die "no task to batch in $td"
  for f in "$td"/done/*.md; do [ -f "$f" ] && basename "$f" .md; done > "$tmp/done" || :
  : > "$tmp/info"
  while IFS= read -r id; do
    f=$td/$id.md; [ -f "$f" ] || f=$td/todo/$id.md; [ -f "$f" ] || f=$td/backlog/$id.md
    c=$(cls_of "$f"); d=$(deps_of "$f")
    printf '%s\t%s\t%s\t%s\n' "$id" "${c:--}" "${d:--}" "$(sed -n '1s/^# Task: *[^ ]* *[-—]* *//p' "$f" | tr '\t' ' ')" >> "$tmp/info"
  done < "$tmp/sel"
  # a dependency cycle among the selected tasks refuses the whole batch
  awk -F'\t' '
    { id[NR] = $1; sel[$1] = 1; dep[$1] = $3 }
    function visit(u,   m, a, i, v, j, s, st) {
      col[u] = 1; stack[++sp] = u; m = split(dep[u], a, ",")
      for (i = 1; i <= m; i++) { v = a[i]; if (!(v in sel)) continue
        if (col[v] == 1) { for (j = 1; j <= sp; j++) if (stack[j] == v) st = j
          s = ""; for (j = st; j <= sp; j++) s = s stack[j] " -> "; print "dependency cycle: " s v; exit 1 }
        if (!col[v]) visit(v) }
      col[u] = 2; sp--
    }
    END { for (k = 1; k <= NR; k++) if (!col[id[k]]) visit(id[k]) }' "$tmp/info" >&2 || die "the batch is refused; nothing was written"
  # what a batch never runs: CRITICAL, class unknown, and whatever depends on an excluded task or on a task nobody finishes
  awk -F'\t' -v OFS='\t' '
    FILENAME == ARGV[1] { done[$1] = 1; next }
    { n++; id[n] = $1; cls[$1] = $2; dep[$1] = $3; title[$1] = $4; sel[$1] = 1 }
    END {
      for (i = 1; i <= n; i++) { u = id[i]
        if (cls[u] == "CRITICAL") ex[u] = "class CRITICAL (keeps its per-task approvals)"
        else if (cls[u] == "-") ex[u] = "class unknown (fail closed)" }
      do { ch = 0
        for (i = 1; i <= n; i++) { u = id[i]; if (u in ex) continue
          m = split(dep[u], a, ",")
          for (j = 1; j <= m; j++) { v = a[j]; if (v == "-" || v == "") continue
            if (v in ex) { ex[u] = "depends on " v ", which is not in this batch"; ch = 1; break }
            if (!(v in sel) && !(v in done)) { ex[u] = "dependency " v " is neither in this batch nor done"; ch = 1; break } } }
      } while (ch)
      for (i = 1; i <= n; i++) { u = id[i]; if (u in ex) print "X", u, ex[u]; else print "K", u, cls[u], dep[u], title[u] }
    }' "$tmp/done" "$tmp/info" > "$tmp/split"
  awk -F'\t' '$1 == "K"' "$tmp/split" > "$tmp/kept"
  [ -s "$tmp/kept" ] || { awk -F'\t' '$1 == "X" { print "  " $2 ": " $3 }' "$tmp/split" >&2; die "no task can be batched; nothing was written"; }
  # topological order; ties keep the listed order
  awk -F'\t' -v OFS='\t' '
    { n++; id[n] = $2; cls[$2] = $3; dep[$2] = $4; kept[$2] = 1 }
    END { left = n
      while (left > 0) {
        for (i = 1; i <= n; i++) { u = id[i]; if (u in em) continue
          m = split(dep[u], a, ","); ok = 1
          for (j = 1; j <= m; j++) if ((a[j] in kept) && !(a[j] in em)) ok = 0
          if (ok) { em[u] = 1; print u, cls[u], dep[u]; left--; break } } } }' "$tmp/kept" > "$tmp/order"
  # a finished batch goes to history; an unfinished plan is simply replaced
  mkdir -p "$bd"
  if [ -f "$bd/state.tsv" ]; then
    hd=$bd/history/$( [ -f "$bd/SUMMARY.md" ] && bid || echo previous ); mkdir -p "$hd"
    for f in SUMMARY.md order.tsv state.tsv merged.tsv logs; do [ ! -e "$bd/$f" ] || mv "$bd/$f" "$hd/"; done
    rm -f "$bd/LOCK"
  fi
  cap=$(cfgv batch.mutation_budget_cap 40)
  {
    printf '# Night batch\n\nnonce: %s-%s\n\n' "$(date +%s)" "$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo $$)"
    printf 'One approval of this summary stands in for the approvals listed below, for the tasks in the table and for nothing else.\nThe batch id is the first 12 hex digits of the sha256 of this file; the approval is bound to that hash.\n\n'
    printf '## Order (one task at a time, each in a clean headless lead session)\n\n| # | task | title | class | depends_on |\n|---|------|-------|-------|------------|\n'
    p=0
    while IFS="$(printf '\t')" read -r oid ocls odep; do
      p=$((p + 1)); ot=$(awk -F'\t' -v t="$oid" '$2 == t { print $5 }' "$tmp/kept")
      printf '| %s | %s | %s | %s | %s |\n' "$p" "$oid" "$ot" "$ocls" "$odep"
    done < "$tmp/order"
    printf '\n## What the approval covers, per task\n\n'
    printf -- '- plan: the freeze of the plan (kind plan), after classification and the usual checks\n'
    printf -- '- delivery: commit, push, pull request, merge only when CI is green and every gate passed (proofline merge), cleanup\n'
    printf -- '- mutation budget: a raise of test_trust.mutation_budget (now %s) up to the cap batch.mutation_budget_cap = %s\n' "$(cfgv test_trust.mutation_budget 20)" "$cap"
    printf '\n## Stop rules\n\n'
    printf -- '- a task that needs anything else is parked with its question and the batch goes on; a task that depends on it is skipped\n'
    printf -- '- a headless session that runs longer than batch.task_timeout (%s minutes) is closed with its whole process group, the task is parked with the reason timeout and the tasks that depend on it are skipped\n' "$(cfgv batch.task_timeout 120)"
    printf -- '- after every merge the driver waits for the CI run of the merge commit itself (not the latest run): the batch stops when that run is red, still running after batch.ci_wait_minutes (%s), or when no run for it appears within batch.ci_appear_minutes (%s)\n' "$(cfgv batch.ci_wait_minutes 30)" "$(cfgv batch.ci_appear_minutes 10)"
    printf -- '- the batch also stops when every runtime hit its usage limit, or when a runtime is not logged in\n'
    printf '\n## NOT covered (each stays a question the batch parks on)\n\n'
    printf -- '- a waiver of a finding, a scope expansion, a new dependency, a reopen of a FAILED or BLOCKED run\n'
    printf -- '- a destructive or single_step data change, a rule promotion, sending the friction report, a new fix-round budget\n'
    printf -- '- a mutation budget above the cap, and any CRITICAL task\n'
    printf '\n## Not in this batch\n\n'
    if awk -F'\t' '$1 == "X" { f = 1 } END { exit !f }' "$tmp/split"; then awk -F'\t' '$1 == "X" { print "- " $2 ": " $3 }' "$tmp/split"; else printf -- '- none\n'; fi
    printf '\n## Runtime\n\nheadless lead runtime: %s, claude permission mode: %s (the PreToolUse hook confines it)\n' "$(cfgv batch.runtimes "$(cfgv runtime.lead claude)")" "$(cfgv dispatch.claude_permission_mode bypassPermissions)"
    printf 'per-task timeout: %s minutes\n' "$(cfgv batch.task_timeout 120)"
    if [ "$danger" = yes ]; then
      printf 'codex sandbox: danger-full-access\n'
      printf 'WARNING: you chose --codex-danger-full-access. A Codex night session then runs with NO sandbox: it can read and write anywhere your user can and use the network. Approving this summary approves that.\n'
    else printf 'codex sandbox: workspace-write (project folder, network access on for package installs)\n'; fi
  } > "$tmp/SUMMARY.md"
  mv "$tmp/SUMMARY.md" "$bd/SUMMARY.md"; mv "$tmp/order" "$bd/order.tsv"
  cat "$bd/SUMMARY.md"
  printf '\nbatch id: %s\n\n' "$(bid)"
}

# --- state -----------------------------------------------------------------------------------------------------------
st_get() { awk -F'\t' -v t="$1" -v c="$2" '$1 == t { print $c; exit }' "$bd/state.tsv"; }
st_set() { # ID STATUS [REASON [QUESTION]]
  S_R=$(tsv "${3:-}") S_Q=$(tsv "${4:-}") awk -F'\t' -v OFS='\t' -v t="$1" -v s="$2" '$1 == t { $2 = s; $3 = ENVIRON["S_R"]; $4 = ENVIRON["S_Q"] } { print }' "$bd/state.tsv" > "$bd/state.tsv.tmp" && mv "$bd/state.tsv.tmp" "$bd/state.tsv"
}
st_stop() { # REASON: the trailer, one only
  { grep -v '^# stopped:' "$bd/state.tsv" || :; printf '# stopped: %s\n' "$(tsv "$1")"; } > "$bd/state.tsv.tmp" && mv "$bd/state.tsv.tmp" "$bd/state.tsv"
}
merged_pr() { awk -F'\t' -v t="$1" '$1 == t { p = $2; f = 1 } END { if (f) print p; exit !f }' "$bd/merged.tsv" 2>/dev/null; }
run_state() { awk '/^execution:/ { i = 1; next } i && /^[^ ]/ { exit } i && /^  state:/ { sub(/^  state:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' "$root/.agents/runs/$1/RUN.yaml" 2>/dev/null || :; }
open_question() { # ID: the first line of the first unanswered question, from the run's records
  sh "$agent" questions "$1" 2>/dev/null | sed -n '/^=== QUESTION/{n;p;q;}' || :
}
pending_approval() { # ID: the kind of an approval request nobody answered (the batch cover would have answered it)
  pa_d=$root/.agents/runs/$1/approvals
  for pa_r in "$pa_d"/[0-9][0-9][0-9]-request-*.yaml; do
    [ -f "$pa_r" ] || continue
    pa_b=$(basename "$pa_r"); pa_n=$(printf '%s' "$pa_b" | cut -c1-3 | sed 's/^0*//'); pa_k=${pa_b#???-request-}; pa_k=${pa_k%.yaml}; pa_a=0
    for pa_f in "$pa_d"/[0-9][0-9][0-9]-"$pa_k".yaml; do
      [ -f "$pa_f" ] || continue
      [ "$(basename "$pa_f" | cut -c1-3 | sed 's/^0*//')" -lt "$pa_n" ] || pa_a=1
    done
    [ "$pa_a" = 1 ] || { printf '%s\n' "$pa_k"; return 0; }
  done
  return 1
}

# --- run -------------------------------------------------------------------------------------------------------------
wt_list() { git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | sort; }
dirty() { git -C "$root" status --porcelain --untracked-files=all | grep -v '^.. \.agents/\(runs\|local\)/' || :; }
# main_ci SHA REQUIRED: the CI runs of exactly that commit. 0 green (or no run and not required), 1 red, 2 still running after the
# wait, 3 unreadable, 4 no run appeared (required only). A red run wins over a running one; an older green run never counts.
main_ci() {
  mc_br=$(cfgv canonical_branch main); mc_max=$(cfgv batch.ci_wait_minutes 30); mc_app=$(cfgv batch.ci_appear_minutes 10)
  case "$mc_max" in ''|*[!0-9]*) mc_max=30 ;; esac; case "$mc_app" in ''|*[!0-9]*) mc_app=10 ;; esac; mc_a=0; mc_r=0
  while :; do
    mc_j=$(cd "$root" && gh run list --branch "$mc_br" --commit "$1" --limit 30 --json status,conclusion 2>/dev/null) || return 3
    mc_v=$(printf '%s' "$mc_j" | tr '}' '\n' | awk '/"status"/ { n++; if ($0 !~ /"status":"completed"/) r = 1; else if ($0 !~ /"conclusion":"(success|skipped|neutral)"/) x = 1 }
      END { if (x) print "red"; else if (!n) print "none"; else if (r) print "running"; else print "green" }')
    case "$mc_v" in
      green) return 0 ;;
      red) return 1 ;;
      none) [ "$2" = yes ] || return 0; [ "$mc_a" -lt "$mc_app" ] || return 4; mc_a=$((mc_a + 1)) ;;
      *) [ "$mc_r" -lt "$mc_max" ] || return 2; mc_r=$((mc_r + 1)) ;;
    esac
    sleep "$tick"
  done
}
ok_sha=''
ci_gate() { # SHA REQUIRED: stop the batch unless the CI of that commit allows going on
  cg_c=0; main_ci "$1" "$2" || cg_c=$?; cg_s=$(printf '%s' "$1" | cut -c1-7)
  case "$cg_c" in
    0) ;;
    1) stop "main CI is red (run of $cg_s)" ;;
    2) stop "main CI is still running after $(cfgv batch.ci_wait_minutes 30) minutes (run of $cg_s)" ;;
    4) stop "no CI run appeared for $cg_s" ;;
    *) stop "main CI cannot be read (gh run list failed)" ;;
  esac
  ok_sha=$1
}
prompt_for() { # ID
  printf 'Batch mode (batch %s). Task %s only. Follow the proofline-lead skill and its Batch mode section: `/proofline run %s` (or resume it if a run exists). At every approval request of kind plan, delivery or mutation_budget call `agent.sh batch-cover %s <KIND>` instead of waiting. At any other approval request, or any question that needs the user: record it with `agent.sh ask %s` and END the session; never wait, never guess. Stop when the task is merged and cleaned up, or parked.' "$(bid)" "$1" "$1" "$1" "$1"
}
# The headless session is the leader of its own process group: `set -m` gives the background job its own pgid (needs a shell that
# can do job control; macOS has no setsid); where that is not available (dash without a terminal) `setsid` is used if it exists.
# The driver signals only that group, only after the leader itself reported pid == pgid, never 0, 1, its own group. When neither
# way gives a group of its own, only the session's own pid is signalled (known limit: its grandchildren may stay).
G_PID=''; S_TO=0
nap() { sleep 0.2 2>/dev/null || sleep 1; }
grp_alive() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }
reap() { # close the session's own process group: TERM, a short grace, then KILL
  [ -n "$G_PID" ] || return 0
  rp_g=$G_PID; G_PID=''
  case "$rp_g" in ''|*[!0-9]*|0|1|"$$") return 0 ;; esac
  rp_own=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' '); [ "$rp_g" != "$rp_own" ] || return 0
  [ "$(cat "$bd/logs/pgid.$rp_g" 2>/dev/null)" = "$rp_g $rp_g" ] || { kill "$rp_g" 2>/dev/null || :; return 0; }
  kill -TERM "-$rp_g" 2>/dev/null || :
  rp_i=0; while [ "$rp_i" -lt 15 ] && grp_alive "$rp_g"; do nap; rp_i=$((rp_i + 1)); done
  ! grp_alive "$rp_g" || kill -KILL "-$rp_g" 2>/dev/null || :
  wait "$rp_g" 2>/dev/null || :
}
run_session() { # ID RUNTIME PROMPT: the runtime's own command, in the project root; returns its exit status
  S_PM=$(cfgv dispatch.claude_permission_mode bypassPermissions); cd "$root" || return 1
  if [ "$2" = codex ]; then
    rs_sb=$(sed -n 's/^codex sandbox: \([a-z-]*\).*/\1/p' "$bd/SUMMARY.md" | head -1); rs_p=$3
    set -- -s workspace-write -c "$CODEX_NET"
    [ "$rs_sb" != danger-full-access ] || set -- -s danger-full-access   # only what the approved summary states, never config or env
    codex exec -C "$root" "$@" -c 'approval_policy="never"' --dangerously-bypass-hook-trust "$rs_p" < /dev/null
  else claude -p "$3" --permission-mode "$S_PM" < /dev/null; fi
}
# session ID RUNTIME: one clean headless lead session; its output goes to the task's log; returns the exit status
session() {
  s_log=$bd/logs/$1.log; s_p=$(prompt_for "$1"); mkdir -p "$bd/logs"; printf '\n--- session %s runtime=%s ---\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >> "$s_log"
  s_pm=$(cfgv dispatch.claude_permission_mode bypassPermissions)
  case "$s_pm" in bypassPermissions|acceptEdits|default) ;; *) die "invalid dispatch.claude_permission_mode: $s_pm" ;; esac
  s_to=$(cfgv batch.task_timeout 120); case "$s_to" in ''|*[!0-9]*|0) s_to=120 ;; esac
  s_cur=$bd/logs/$1.cur; : > "$s_cur"   # this session's own output: limit and auth detection read only it, never the cumulative log
  s_rcf=$bd/logs/$1.rc; rm -f "$s_rcf" "$bd"/logs/pgid.*; S_TO=0
  s_pre=''; set -m 2>/dev/null || :
  case $- in *m*) ;; *) ! command -v setsid >/dev/null 2>&1 || s_pre=setsid ;; esac
  # shellcheck disable=SC2086 # s_pre is empty or the one word setsid
  $s_pre sh "$here/batch.sh" _session "$1" "$2" "$s_p" >> "$s_cur" 2>&1 < /dev/null &
  G_PID=$!
  set +m 2>/dev/null || :
  s_dead=$(($(date +%s) + s_to * tick))
  while [ ! -f "$s_rcf" ]; do
    [ "$(date +%s)" -lt "$s_dead" ] || { S_TO=1; break; }
    nap
  done
  reap
  rm -f "$bd"/logs/pgid.*
  [ "$S_TO" = 0 ] || { printf '[batch] session of %s closed: it ran longer than batch.task_timeout (%s minutes)\n' "$1" "$s_to" >> "$s_cur"; echo 124 > "$s_rcf"; }
  cat "$s_cur" >> "$s_log"
  return "$(cat "$s_rcf" 2>/dev/null || echo 1)"
}
outcome() { # ID -> merged | FAILED | BLOCKED | question | none  (records only)
  if merged_pr "$1" >/dev/null; then echo merged; return 0; fi
  case "$(run_state "$1")" in FAILED) echo FAILED; return 0 ;; BLOCKED) echo BLOCKED; return 0 ;; esac
  if [ -n "$(open_question "$1")" ] || pending_approval "$1" >/dev/null; then echo question; return 0; fi
  echo none
}
stop() { st_stop "$1"; echo "batch: stopped: $1" >&2; sh "$here/batch.sh" status; exit 1; }
run() {
  sh "$agent" batch-check >/dev/null 2>&1 || die "no valid batch approval for the current summary: plan the batch (agent.sh batch-plan), then reply \"approve batch\" to the summary"
  [ -f "$bd/order.tsv" ] || die "no batch order: plan the batch first"
  if [ -f "$bd/LOCK" ]; then
    lp=$(cat "$bd/LOCK" 2>/dev/null || :)
    case "$lp" in ''|*[!0-9]*) ;; *) ! kill -0 "$lp" 2>/dev/null || die "a batch run is active (pid $lp): only one task at a time" ;; esac
    rm -f "$bd/LOCK"
  fi
  ( set -C; printf '%s\n' "$$" > "$bd/LOCK" ) 2>/dev/null || die "a batch run is active: only one task at a time"
  trap 'reap; rm -f "$bd/LOCK"' 0; trap 'exit 130' INT; trap 'exit 143' TERM
  [ -z "$(dirty)" ] || die "the working tree is not clean; commit or stash first"
  canon=$(cfgv canonical_branch main)
  [ "$(git -C "$root" branch --show-current)" = "$canon" ] || die "the current branch is not $canon"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth login)"
  if [ ! -f "$bd/state.tsv" ]; then awk -F'\t' '{ print $1 "\tpending\t\t" }' "$bd/order.tsv" > "$bd/state.tsv"; fi
  # resume: a running row is a killed driver; a skipped row is judged again; a parked row whose run is open and has no
  # question left (answered, reopened) goes back to pending and its session resumes the run
  grep -v '^# stopped:' "$bd/state.tsv" > "$bd/state.tsv.tmp" || :; mv "$bd/state.tsv.tmp" "$bd/state.tsv"
  for id in $(cut -f1 "$bd/order.tsv"); do
    case "$(st_get "$id" 2)" in
      running|skipped) st_set "$id" pending ;;
      parked)
        case "$(run_state "$id")" in FAILED|BLOCKED) continue ;; esac
        if [ -z "$(open_question "$id")" ] && ! pending_approval "$id" >/dev/null; then st_set "$id" pending; fi ;;
    esac
  done
  [ -d "$bd/logs" ] || mkdir -p "$bd/logs"
  rts=$(cfgv batch.runtimes ''); if [ -z "$rts" ]; then
    rts=$(cfgv runtime.lead claude); for o in claude codex; do [ "$o" = "$rts" ] || ! command -v "$o" >/dev/null 2>&1 || rts="$rts $o"; done
  fi
  exhausted=''
  for id in $(cut -f1 "$bd/order.tsv"); do
    [ "$(st_get "$id" 2)" = pending ] || continue
    for dep in $(awk -F'\t' -v t="$id" '$1 == t { gsub(/,/, " ", $3); print $3 }' "$bd/order.tsv"); do
      case "$(st_get "$dep" 2)" in parked|skipped) st_set "$id" skipped "depends on $dep ($(st_get "$dep" 2))"; break ;; esac
    done
    [ "$(st_get "$id" 2)" = pending ] || continue
    git -C "$root" checkout -q "$canon" 2>/dev/null && git -C "$root" pull -q --ff-only >/dev/null 2>&1 || stop "cannot update $canon before $id (git checkout and pull --ff-only failed)"
    head_sha=$(git -C "$root" rev-parse HEAD); [ "$head_sha" = "$ok_sha" ] || ci_gate "$head_sha" no   # no run for HEAD before the first merge is no signal
    st_set "$id" running
    wt_before=$(wt_list)
    while :; do
      rt=''; for r in $rts; do case " $exhausted " in *" $r "*) ;; *) rt=$r; break ;; esac; done
      if [ -z "$rt" ]; then st_set "$id" pending; stop "every runtime hit its usage limit"; fi
      sess_rc=0; session "$id" "$rt" || sess_rc=$?
      out=$(outcome "$id")
      if [ "$S_TO" = 1 ] && [ "$out" != merged ]; then out=timeout; break; fi
      if [ "$out" != merged ] && { [ "$sess_rc" -ne 0 ] || [ "$out" = none ]; }; then
        if [ "$sess_rc" -ne 0 ] && grep -Eiq 'not logged in|authentication|invalid api key|please run /login|401' "$bd/logs/$id.cur"; then st_set "$id" pending; stop "runtime $rt is not authenticated"; fi
        if grep -Eiq 'usage limit|rate limit|limit reached|quota' "$bd/logs/$id.cur"; then exhausted="$exhausted $rt"; continue; fi
      fi
      break
    done
    # agent hygiene: the worktrees the session added, the branch, no leftovers
    for w in $(wt_list); do case " $(printf '%s' "$wt_before" | tr '\n' ' ') " in *" $w "*) ;; *) git -C "$root" worktree remove --force "$w" >/dev/null 2>&1 && printf 'hygiene: removed worktree %s\n' "$w" >> "$bd/logs/$id.log" ;; esac; done
    git -C "$root" worktree prune
    case "$out" in
      merged) st_set "$id" merged ;;
      timeout) st_set "$id" parked timeout "no result within $(cfgv batch.task_timeout 120) minutes (see .agents/local/batch/logs/$id.log)" ;;
      FAILED|BLOCKED) st_set "$id" parked "$out" ;;
      question) q=$(open_question "$id"); [ -n "$q" ] || q="approval request: $(pending_approval "$id")"; st_set "$id" parked question "$q" ;;
      *) st_set "$id" parked "session ended without a result (see .agents/local/batch/logs/$id.log)" ;;
    esac
    git -C "$root" checkout -q "$canon" 2>/dev/null && [ -z "$(dirty)" ] || stop "the working tree is not on $canon or not clean after $id; deal with it, then run the batch again"
    if [ "$out" = merged ]; then   # the CI of the merge commit itself, never the latest run
      git -C "$root" pull -q --ff-only >/dev/null 2>&1 || stop "cannot update $canon after the merge of $id (git pull --ff-only failed)"
      mpr=$(merged_pr "$id" || :); msha=$(cd "$root" && gh pr view "$mpr" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null) || msha=''
      [ -n "$msha" ] || stop "cannot read the merge commit of PR $mpr ($id)"
      ci_gate "$msha" yes
    fi
  done
  echo "batch finished"
  sh "$here/batch.sh" status
}

# --- status ----------------------------------------------------------------------------------------------------------
status() {
  [ -f "$bd/SUMMARY.md" ] || { echo "no batch planned (agent.sh batch-plan <ID...|all>)"; return 0; }
  ap=$(grep -l "^bound: \"$(sha "$bd/SUMMARY.md")\"" "$root"/.agents/local/approvals/[0-9][0-9][0-9]-batch.yaml 2>/dev/null | sort | tail -1 || :)
  at=''; [ -z "$ap" ] || at=$(sed -n 's/^approved_at: //p' "$ap" | head -1)
  [ -z "$at" ] || at=$(date -r "$at" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$at" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$at")
  stopped=''; [ ! -f "$bd/state.tsv" ] || stopped=$(sed -n 's/^# stopped: //p' "$bd/state.tsv" | tail -1)
  printf 'batch %s, approved at %s\n' "$(bid)" "${at:-never}"
  [ -z "$stopped" ] || printf 'STOPPED: %s\n' "$stopped"
  printf '\n%s | %s | %s | %s | %s | %s\n' task result PR merge 'park reason' 'pending question'
  for id in $(cut -f1 "$bd/order.tsv"); do
    st=pending; why=''; pr=''; mt=''; q=''
    if [ -f "$bd/state.tsv" ] && [ -n "$(st_get "$id" 2)" ]; then st=$(st_get "$id" 2); why=$(st_get "$id" 3); fi
    if pr=$(merged_pr "$id"); then
      st=merged; why=''; mt=$(awk -F'\t' -v t="$id" '$1 == t { e = $3 } END { print e }' "$bd/merged.tsv")
      mt=$(date -r "$mt" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$mt" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$mt")
    else pr=''; fi
    [ "$st" != pending ] || [ -z "$stopped" ] || st=stopped
    [ "$st" != parked ] || q=$(open_question "$id")
    printf '%s | %s | %s | %s | %s | %s\n' "$id" "$st" "${pr:--}" "${mt:--}" "${why:--}" "${q:--}"
  done
  printf '\n'
  sh "$here/friction.sh" show 2>/dev/null || echo "no friction report"
  printf '\nresume: answer the open questions (or reopen a run), then run `proofline batch run`; merged tasks are not run again.\n'
}

case "${1:-}" in
  plan) shift; plan "$@" ;;
  run) run ;;
  _session) shift   # internal: the session itself, started by `session` as the leader of its own process group
    me=$$; printf '%s %s\n' "$me" "$(ps -o pgid= -p "$me" 2>/dev/null | tr -d ' ')" > "$bd/logs/pgid.$me"
    r=0; run_session "$1" "$2" "$3" || r=$?; echo "$r" > "$bd/logs/$1.rc" ;;
  status) status ;;
  *) echo "usage: batch.sh plan <ID...|all> | run | status" >&2; exit 2 ;;
esac
