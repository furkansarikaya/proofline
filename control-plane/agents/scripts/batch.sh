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
# and the CI polling, so a test needs seconds, not hours. Under PROOFLINE_TEST=1 only, PROOFLINE_BATCH_PGMETHOD=setm|setsid|perl|python|none
# forces ONE process-group method (none: no method works), so every fallback is tested on every machine.
# sessions/<ID>.<n>.rec (key=value, written by the driver at session start and end) is what `status` reads for the session report.
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
# The Codex night sandbox (A161): the legacy workspace-write mode keeps .git, .agents and .codex read-only and `network_access` is a legacy key,
# so a session could not commit, branch, add a worktree or write its run records. A named permissions profile (documented
# [permissions.<name>] tables, verified with `codex sandbox -P`) gives: read everywhere, write the project folder INCLUDING .git and .agents,
# but .git/hooks and .git/config stay read-only (a hook or core.hooksPath would run code outside the sandbox), the temp dir, and network on.
# The profile is passed as -c overrides, no file is written. `.codex` stays read-only. danger-full-access only through the approved summary.
# Package managers write caches under $HOME (npm: ~/.npm, which the profile keeps read-only: `npm view` died with EPERM). $HOME stays read-only;
# instead shell_environment_policy.set points the caches into the writable temp dir (CODEX_PKG, one folder per user). Verified on codex-cli 0.163.0 with
# `codex sandbox -P` and the real tools in a temp project: npm (npm_config_cache), pnpm 10 (npm_config_store_dir), yarn 4 (YARN_CACHE_FOLDER and
# YARN_GLOBAL_FOLDER), pip (PIP_CACHE_DIR), go (GOCACHE, GOPATH, which holds the module cache and sumdb). NOT verified, so not claimed: cargo (not
# installed where this was checked), any other package manager, a corepack download of a tool version that is not cached. This list is CODEX_VERIFIED.
CODEX_PROFILE='proofline_night'
CODEX_FS='{":root"="read",":workspace_roots"={"."="write",".git"="write",".git/hooks"="read",".git/config"="read",".agents"="write"},":tmpdir"="write"}'
CODEX_VERIFIED='npm, pnpm, yarn, pip, go'
CODEX_MIN='0.163.0'   # the profile was verified on this codex-cli; an older or unparsable one is refused (no unknown sandbox)
codex_env() { # -> the TOML inline table for shell_environment_policy.set
  ce=${TMPDIR:-/tmp}; case "$ce" in *[!A-Za-z0-9_./+-]*) ce=/tmp ;; esac
  ce=${ce%/}/proofline-pkg-$(id -u); mkdir -p "$ce" 2>/dev/null && chmod 700 "$ce" 2>/dev/null || :
  printf '{npm_config_cache="%s/npm",npm_config_update_notifier="false",npm_config_store_dir="%s/pnpm-store",YARN_CACHE_FOLDER="%s/yarn",YARN_GLOBAL_FOLDER="%s/yarn-global",PIP_CACHE_DIR="%s/pip",GOCACHE="%s/go-build",GOPATH="%s/go"}' "$ce" "$ce" "$ce" "$ce" "$ce" "$ce" "$ce"
}
# codex --version -> "major.minor.patch" or nothing. Under PROOFLINE_TEST=1 only, PROOFLINE_CODEX_VERSION replaces the output of `codex --version`.
codex_ver() {
  if [ "${PROOFLINE_TEST:-}" = 1 ] && [ -n "${PROOFLINE_CODEX_VERSION+x}" ]; then cv=$PROOFLINE_CODEX_VERSION; else cv=$(codex --version 2>/dev/null | head -1 || :); fi
  printf '%s\n' "$cv" | awk 'match($0, /[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?/) { print substr($0, RSTART, RLENGTH); exit }'
}
codex_ver_ok() { # VERSION: at least CODEX_MIN (a pre-release of the minimum itself counts as lower)
  case "$1" in '') return 1 ;; esac
  awk -v v="$1" -v m="$CODEX_MIN" 'BEGIN { pre = index(v, "-") > 0; sub(/-.*/, "", v); split(v, a, "."); split(m, b, ".")
    for (i = 1; i <= 3; i++) { if (a[i] + 0 > b[i] + 0) exit 0; if (a[i] + 0 < b[i] + 0) exit 1 } exit pre }'
}
# The runtimes the driver tries, in order: batch.runtimes, else the lead runtime then the other installed one (the fallback when one hits its limit).
rt_list() {
  rl=$(cfgv batch.runtimes ''); if [ -z "$rl" ]; then
    rl_lead=$(cfgv runtime.lead claude); rl=$rl_lead; for o in claude codex; do [ "$o" = "$rl_lead" ] || ! command -v "$o" >/dev/null 2>&1 || rl="$rl $o"; done
  fi
  printf '%s\n' "$rl"
}

# --- plan ------------------------------------------------------------------------------------------------------------
cls_of() { awk '/^## Suggested class[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && match($0, /(TRIVIAL|STANDARD|COMPLEX|CRITICAL)/) { print substr($0, RSTART, RLENGTH); exit }' "$1"; }
deps_of() { awk 'NR > 1 && /^## / { exit } /^---[[:space:]]*$/ { fm = !fm; next } fm && /^depends_on:/ { sub(/^depends_on:[[:space:]]*/, ""); gsub(/["\[\]]/, ""); gsub(/[,[:space:]]+/, ","); sub(/^,/, ""); sub(/,$/, ""); print; exit }' "$1"; }
plan() {
  [ "$(cfgv tasks.adapter markdown)" = markdown ] || die "night mode runs markdown task files only, but tasks.adapter is $(cfgv tasks.adapter markdown) (a design decision, A161: the unattended driver must not depend on network calls to resolve ids and order). Next step: set tasks.adapter to markdown in .agents/config.yaml, import each task with '/proofline task <issue reference>' (it writes <tasks.dir>/<ID>.md with its Suggested class and depends_on), then run '/proofline batch <ID...>' again"
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
    for f in SUMMARY.md order.tsv state.tsv merged.tsv logs sessions; do [ ! -e "$bd/$f" ] || mv "$bd/$f" "$hd/"; done
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
    else printf 'codex sandbox: proofline_night profile (project folder including .git and .agents, but not .git/hooks or .git/config; network on; $HOME read-only, package-manager caches redirected into the temp dir, verified for: %s; other package managers are not verified)\n' "$CODEX_VERIFIED"; fi
    # A161: a Codex session may run as the lead (batch.runtimes, the lead runtime, or the fallback when the first runtime hits its limit).
    pl_rts=$(rt_list); pl_codex=no; for r in $pl_rts; do [ "$r" != codex ] || pl_codex=yes; done
    if [ "$pl_codex" = yes ]; then   # the Codex version the driver will use is part of what is approved
      pl_cv=$(codex_ver); if [ -z "$pl_cv" ]; then printf 'codex version: unknown (codex --version gave no version; the driver refuses it, minimum %s)\n' "$CODEX_MIN"
      elif codex_ver_ok "$pl_cv"; then printf 'codex version: %s (minimum %s)\n' "$pl_cv" "$CODEX_MIN"
      else printf 'codex version: %s (below the minimum %s; the driver refuses it)\n' "$pl_cv" "$CODEX_MIN"; fi
    fi
    # Seatbelt cannot nest, so a sandboxed Codex lead cannot start a sandboxed `codex exec` worker; a warning, never a block (the hash binds it).
    if [ "$danger" != yes ] && [ "$pl_codex" = yes ]; then
      nest=''; for nr in task_author explorer architect data_architect designer implementer reviewer security_reviewer qa verifier; do
        [ "$(sh "$here/exec-policy.sh" runtime "$nr" 2>/dev/null || :)" != codex ] || nest="$nest $nr"; done
      if [ -n "$nest" ]; then
        if [ "$(cfgv runtime.lead claude)" = codex ] && [ -z "$(cfgv batch.runtimes '')" ]; then pl_who='the lead runs on Codex'
        else pl_who="a lead session can run on Codex (runtimes tried, in order: $pl_rts)"; fi
        printf 'WARNING: %s and these roles also run on Codex:%s. On macOS a sandboxed Codex lead cannot start sandboxed Codex workers (sandboxes do not nest). Either set the worker and reviewer runtimes to claude (proofline init --worker claude --reviewers claude, and remove any --role ROLE=codex override), keep Codex out of batch.runtimes, or plan again with --codex-danger-full-access.\n' "$pl_who" "$nest"
      fi
    fi
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
# The headless session is the leader of its own process group (A161). Methods, in order: `set -m` (job control gives the background job its own
# pgid; needs a shell that can do it, a tty is not required where it works), `setsid` (not on macOS), a perl one-liner (`setpgid(0,0)` then
# exec; perl ships with macOS), python3 (`os.setpgid`). A method counts only when a probe process it started reports pgid == pid; the session
# itself checks the same before it does anything and exits 125 otherwise. No method that works: the batch is refused, there is no weaker mode.
# The driver signals only a group it started and verified (never 0, 1, its own group): TERM, a grace, KILL. No pkill, killall or pgrep.
G_PID=''; S_TO=0; B_SB=''; PG_METHOD=''
nap() { sleep 0.2 2>/dev/null || sleep 1; }
grp_alive() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }
# pg_start METHOD OUT CMD...: start CMD in the background as a group leader by METHOD (G_PID is its pid); 1 when the method is unavailable
pg_start() {
  pgs_m=$1; pgs_o=$2; shift 2
  case "$pgs_m" in
    setm) case $- in *m*) ;; *) set -m 2>/dev/null || return 1 ;; esac
      case $- in *m*) ;; *) return 1 ;; esac
      "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$!; set +m 2>/dev/null || : ;;
    setsid) command -v setsid >/dev/null 2>&1 || return 1
      setsid "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    perl) command -v perl >/dev/null 2>&1 || return 1
      perl -e 'use POSIX; setpgid(0, 0) or die "setpgid: $!\n"; exec @ARGV or die "exec: $!\n"' "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    python) command -v python3 >/dev/null 2>&1 || return 1
      python3 -c 'import os, sys; os.setpgid(0, 0); os.execvp(sys.argv[1], sys.argv[1:])' "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    *) return 1 ;;
  esac
}
pg_probe_one() { # METHOD: 0 when a process started by that method is the leader of a group of its own
  ppo_f=$bd/logs/pgprobe.$$; rm -f "$ppo_f"; G_PID=''
  pg_start "$1" "$bd/logs/pgprobe.out" sh "$here/batch.sh" _pgprobe "$ppo_f" || { G_PID=''; return 1; }
  ppo_i=0; while [ ! -s "$ppo_f" ] && [ "$ppo_i" -lt 50 ]; do nap; ppo_i=$((ppo_i + 1)); done
  ppo_v=$(cat "$ppo_f" 2>/dev/null || :); wait "$G_PID" 2>/dev/null || :
  ppo_p=$G_PID; G_PID=''; rm -f "$ppo_f"
  case "$ppo_p" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ "$ppo_v" = "$ppo_p $ppo_p" ]
}
pg_select() { # sets PG_METHOD, or refuses the batch
  mkdir -p "$bd/logs"
  pgm='setm setsid perl python'
  if [ "${PROOFLINE_TEST:-}" = 1 ] && [ -n "${PROOFLINE_BATCH_PGMETHOD:-}" ]; then pgm=$PROOFLINE_BATCH_PGMETHOD; fi
  for m in $pgm; do
    if pg_probe_one "$m"; then PG_METHOD=$m; rm -f "$bd/logs/pgprobe.out"; return 0; fi
  done
  rm -f "$bd/logs/pgprobe.out"
  die "no way to start a headless session in its own process group on this machine (tried: $pgm; need job control in sh, setsid, perl or python3); the batch is not run, because a hung session could not be closed with its children"
}
reap() { # close the session's own process group: TERM, a short grace, then KILL
  [ -n "$G_PID" ] || return 0
  rp_g=$G_PID; G_PID=''
  case "$rp_g" in ''|*[!0-9]*|0|1|"$$") return 0 ;; esac
  rp_own=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' '); [ "$rp_g" != "$rp_own" ] || return 0
  [ "$(cat "$bd/logs/pgid.$rp_g" 2>/dev/null)" = "$rp_g $rp_g" ] || { kill "$rp_g" 2>/dev/null || :; return 0; }
  kill -TERM "-$rp_g" 2>/dev/null || :
  rp_i=0; while [ "$rp_i" -lt 15 ] && grp_alive "$rp_g"; do nap; rp_i=$((rp_i + 1)); done
  ! grp_alive "$rp_g" || kill -KILL "-$rp_g" 2>/dev/null || :
  rp_i=0; while [ "$rp_i" -lt 10 ] && grp_alive "$rp_g"; do nap; rp_i=$((rp_i + 1)); done
  wait "$rp_g" 2>/dev/null || :
}
run_session() { # ID RUNTIME PROMPT SANDBOX: the runtime's own command, in the project root; returns its exit status
  S_PM=$(cfgv dispatch.claude_permission_mode bypassPermissions); cd "$root" || return 1
  if [ "$2" = codex ]; then
    rs_sb=$4; rs_p=$3   # the choice the driver read once, right after batch-check
    set -- -c "default_permissions=\"$CODEX_PROFILE\"" -c "permissions.$CODEX_PROFILE.network.enabled=true" -c "permissions.$CODEX_PROFILE.filesystem=$CODEX_FS" -c "shell_environment_policy.set=$(codex_env)"
    [ "$rs_sb" != danger-full-access ] || set -- -s danger-full-access   # only what the approved summary states, never config or env
    codex exec -C "$root" "$@" -c 'approval_policy="never"' --dangerously-bypass-hook-trust "$rs_p" < /dev/null
  else claude -p "$3" --permission-mode "$S_PM" < /dev/null; fi
}
# Session records (A161): sessions/<ID>.<n>.rec, key=value lines. The driver writes id, n, runtime, method, log, start (epoch) when the session
# starts and end, exit and timeout when it ends; `status` shows them. A record without an end belongs to a driver that was stopped.
rec_new() { # ID RUNTIME -> sets REC (the file)
  mkdir -p "$bd/sessions"; rn_n=1; while [ -e "$bd/sessions/$1.$rn_n.rec" ]; do rn_n=$((rn_n + 1)); done
  REC=$bd/sessions/$1.$rn_n.rec
  printf 'id=%s\nn=%s\nruntime=%s\nmethod=%s\nlog=%s\nstart=%s\n' "$1" "$rn_n" "$2" "$PG_METHOD" ".agents/local/batch/logs/$1.log" "$(date +%s)" > "$REC"
}
rec_end() { # EXIT TIMEOUT(0|1)
  printf 'end=%s\nexit=%s\ntimeout=%s\n' "$(date +%s)" "$1" "$2" >> "$REC"
}
# session ID RUNTIME: one clean headless lead session; its output goes to the task's log; returns the exit status
S_ISO=0
session() {
  s_log=$bd/logs/$1.log; s_p=$(prompt_for "$1"); mkdir -p "$bd/logs"; printf '\n--- session %s runtime=%s ---\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >> "$s_log"
  s_pm=$(cfgv dispatch.claude_permission_mode bypassPermissions)
  case "$s_pm" in bypassPermissions|acceptEdits|default) ;; *) die "invalid dispatch.claude_permission_mode: $s_pm" ;; esac
  s_to=$(cfgv batch.task_timeout 120); case "$s_to" in ''|*[!0-9]*|0) s_to=120 ;; esac
  s_cur=$bd/logs/$1.cur; : > "$s_cur"   # this session's own output: limit and auth detection read only it, never the cumulative log
  s_rcf=$bd/logs/$1.rc; rm -f "$s_rcf" "$bd"/logs/pgid.*; S_TO=0; S_ISO=0
  rec_new "$1" "$2"
  if ! pg_start "$PG_METHOD" "$s_cur" sh "$here/batch.sh" _session "$1" "$2" "$s_p" "$B_SB"; then
    G_PID=''; echo 125 > "$s_rcf"; printf '[batch] process-group method %s is no longer available\n' "$PG_METHOD" >> "$s_cur"; S_ISO=1
  fi
  s_dead=$(($(date +%s) + s_to * tick))
  while [ ! -f "$s_rcf" ]; do
    [ "$(date +%s)" -lt "$s_dead" ] || { S_TO=1; break; }
    nap
  done
  reap
  rm -f "$bd"/logs/pgid.*
  [ "$S_TO" = 0 ] || { printf '[batch] session of %s closed: it ran longer than batch.task_timeout (%s minutes)\n' "$1" "$s_to" >> "$s_cur"; echo 124 > "$s_rcf"; }
  s_rc=$(cat "$s_rcf" 2>/dev/null || echo 1)
  [ "$s_rc" != 125 ] || S_ISO=1   # the session found itself outside a group of its own and did nothing
  rec_end "$s_rc" "$S_TO"
  cat "$s_cur" >> "$s_log"
  return "$s_rc"
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
  # The Codex sandbox the approved summary states is read ONCE, here, right after batch-check; a session cannot edit SUMMARY.md to widen it for later sessions.
  B_SB=$(sed -n 's/^codex sandbox: \([a-z_-]*\).*/\1/p' "$bd/SUMMARY.md" | head -1)
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
  pg_select   # a verified way to give every session its own process group, or the batch is refused (A161)
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
  rts=$(rt_list)
  # A161: a Codex runtime runs only on a codex-cli the profile was verified on; the version is read once, here (a runtime named in the
  # configuration or the lead is refused, an installed fallback is left out with one line)
  case " $rts " in *" codex "*)
    if [ "$B_SB" != danger-full-access ]; then
      B_CV=$(codex_ver)
      if ! codex_ver_ok "$B_CV"; then
        if [ -n "$B_CV" ]; then bad="codex-cli $B_CV is below the minimum $CODEX_MIN the proofline_night profile was verified on"; else bad="codex --version gave no parsable version (minimum $CODEX_MIN, the version the proofline_night profile was verified on)"; fi
        if [ -n "$(cfgv batch.runtimes '')" ] || [ "$(cfgv runtime.lead claude)" = codex ]; then die "$bad; update Codex or use runtime claude"; fi
        printf 'batch: %s: Codex is left out of this batch\n' "$bad" >&2
        nr=''; for r in $rts; do [ "$r" = codex ] || nr="$nr $r"; done; rts=${nr# }
      fi
    fi ;;
  esac
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
      if [ "$S_ISO" = 1 ]; then st_set "$id" pending; stop "a session could not be started as the leader of its own process group (method $PG_METHOD); nothing was run for $id"; fi
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
fmt_ts() { [ -n "$1" ] || { echo "-"; return 0; }; date -r "$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$1"; }
rec_get() { sed -n "s/^$2=//p" "$1" | head -1; }
# sessions_report: from the session records only (A161); a batch from before them has none and prints nothing
sessions_report() {
  ls "$bd"/sessions/*.rec >/dev/null 2>&1 || return 0
  printf 'sessions (from records; the log path is relative to the project):\n'
  printf '%s | %s | %s | %s | %s | %s | %s | %s\n' task '#' runtime start end exit 'park reason' log
  for id in $(cut -f1 "$bd/order.tsv"); do
    last=$(ls "$bd/sessions/$id".*.rec 2>/dev/null | awk -F. '{ print $(NF-1) "\t" $0 }' | sort -n | tail -1 | cut -f2)
    for rf in $(ls "$bd/sessions/$id".*.rec 2>/dev/null | awk -F. '{ print $(NF-1) "\t" $0 }' | sort -n | cut -f2); do
      st=$(rec_get "$rf" start); en=$(rec_get "$rf" end); ex=$(rec_get "$rf" exit); why=''
      if [ -z "$en" ]; then en='no end recorded'; ex='-'; fi
      [ "$(rec_get "$rf" timeout)" != 1 ] || ex="$ex (timeout)"
      if [ "$rf" = "$last" ] && [ -f "$bd/state.tsv" ] && [ "$(st_get "$id" 2)" = parked ]; then why=$(st_get "$id" 3); fi
      printf '%s | %s | %s | %s | %s | %s | %s | %s\n' "$id" "$(rec_get "$rf" n)" "$(rec_get "$rf" runtime)" "$(fmt_ts "$st")" "$([ "$en" = 'no end recorded' ] && echo "$en" || fmt_ts "$en")" "${ex:--}" "${why:--}" "$(rec_get "$rf" log)"
    done
  done
  printf '\n'
}
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
  sessions_report
  sh "$here/friction.sh" show 2>/dev/null || echo "no friction report"
  printf '\nresume: answer the open questions (or reopen a run), then run `proofline batch run`; merged tasks are not run again.\n'
}

case "${1:-}" in
  plan) shift; plan "$@" ;;
  run) run ;;
  _pgprobe) me=$$; printf '%s %s\n' "$me" "$(ps -o pgid= -p "$me" 2>/dev/null | tr -d ' ')" > "$2.tmp" && mv "$2.tmp" "$2" ;;   # internal: what pg_probe_one checks
  _session) shift   # internal: the session itself, started by `session` as the leader of its own process group
    me=$$; pg=$(ps -o pgid= -p "$me" 2>/dev/null | tr -d ' '); printf '%s %s\n' "$me" "$pg" > "$bd/logs/pgid.$me"
    # a session that is not the leader of a group of its own does nothing: the driver could not close its children
    [ "$pg" = "$me" ] || { echo "batch: the session is not the leader of its own process group (pid $me, pgid ${pg:-?}); nothing was started" >&2; echo 125 > "$bd/logs/$1.rc"; exit 125; }
    r=0; run_session "$1" "$2" "$3" "${4:-}" || r=$?; echo "$r" > "$bd/logs/$1.rc" ;;
  status) status ;;
  *) echo "usage: batch.sh plan <ID...|all> | run | status" >&2; exit 2 ;;
esac
