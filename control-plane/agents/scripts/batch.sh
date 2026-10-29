#!/bin/sh
# shellcheck disable=SC2010,SC2013,SC2015,SC2016 # task IDs and our own file names are word-safe; A && B || stop on purpose
# Night mode (A157): the batch plan, the digest of its state and the morning report. Run through `agent.sh batch-plan|batch-next|
# batch-status|batch-ci|batch-awake|batch-park` and `proofline batch status`. There is no driver: the lead runs the tasks in the SAME
# session, one after the other (run, then deliver, and only when the task is merged the next one); this script only plans, reads the
# state from the records and answers "what is next".
#   batch.sh plan [--replace] <ID...|all>
#                              order the tasks (depends_on), leave out what a batch must not run, write .agents/local/batch/SUMMARY.md and
#                              order.tsv (agent.sh then requests the `batch` approval). The same approved batch that is not finished is
#                              continued instead (exit 3: nothing written, no new approval); --replace plans anew.
#   batch.sh next [--tsv]      read-only: the batch's state from records only (merged.tsv, the runs, their questions and approvals, ci.tsv,
#                              state.tsv) and the next action: `NEXT: run|resume|cover|deliver|ci <ID> ...`, `NEXT: finished` or `NEXT: approve`.
#                              The lead calls it before every task, so it continues at the right place after a context compaction or a restart.
#   batch.sh answer            (A200) record the user's answers to the summary's pre-flight questions from their newest captured message
#   batch.sh answers [ID]      (A200) the recorded answers, one per line
#   batch.sh status            the morning table, from the same records, never from a log
#   batch.sh ci <ID>           one check of the CI run of the merge commit of the merged task ID (exit 0 green or not applicable, 1 red,
#                              2 still running, 3 unreadable, 4 no run yet); a green result is recorded in ci.tsv
#   batch.sh awake             macOS: caffeinate -i -w <the session's pid>; Linux: systemd-inhibit held while the session lives
#   batch.sh park <ID> <reason> | park <ID> --clear
#                              the lead's own park of a task that has no run to carry a question (state.tsv)
# (A169) Each task runs in a git worktree of its own, .agents/local/worktrees/<ID> (agent.sh worktree-add): its run, ACTIVE_RUN and task-file
# move stay there, so a parked task, one waiting for merge or one in a CI-fix round blocks no independent task and never dirties the main
# working tree. A task starts only when every dependency is merged. A merged task's worktree is removed; a parked one keeps it.
# Files under .agents/local/batch/: SUMMARY.md, order.tsv (ID class depends_on), state.tsv (ID parked reason question: only the lead's own
# parks), merged.tsv (ID PR epoch, written by deliver-step merge), ci.tsv (ID sha epoch: the CI of its merge commit was checked), awake.pid /
# awake (the sleep inhibitor), history/<batch id>/. Test seams (PROOFLINE_TEST=1 only): PROOFLINE_UNAME replaces `uname -s`,
# PROOFLINE_BATCH_INHIBIT=none says no sleep inhibitor is installed, PROOFLINE_SESSION_PID names the session process.
set -eu
LC_ALL=C; export LC_ALL
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
agent=$here/agent.sh
bd=${PROOFLINE_SHARED_ROOT:-$root}/.agents/local/batch   # A185: the main tree's folder from any worktree, by path
wtb=$(cd "$root" && pwd -P)/.agents/local/worktrees   # A169: one worktree per task, <wtb>/<ID>

die() { echo "batch: $*" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 < "$1" | awk '{print $1}'; }; else sha() { sha256sum < "$1" | awk '{print $1}'; }; fi
cfgv() { v=$(sh "$agent" config-get "$1" 2>/dev/null) || v=''; [ -n "$v" ] || v=${2:-}; printf '%s\n' "$v"; }
tsv() { printf '%s' "$*" | tr '\t\n' '  '; }
bid() { sha "$bd/SUMMARY.md" | cut -c1-12; }
PLUG_LINE='Keep the computer awake (plugged in, lid open) and this session open.'   # one place so other texts can reuse it
# --- plan ------------------------------------------------------------------------------------------------------------
cls_of() { awk '/^## Suggested class[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && match($0, /(TRIVIAL|STANDARD|COMPLEX|CRITICAL)/) { print substr($0, RSTART, RLENGTH); exit }' "$1"; }
deps_of() { awk 'NR > 1 && /^## / { exit } /^---[[:space:]]*$/ { fm = !fm; next } fm && /^depends_on:/ { sub(/^depends_on:[[:space:]]*/, ""); gsub(/["\[\]]/, ""); gsub(/[,[:space:]]+/, ","); sub(/^,/, ""); sub(/,$/, ""); print; exit }' "$1"; }
# ci_absent (A163, A180): true when the project has no pull_request workflow. That is a WARNING, no longer a blocker: proofline merge
# then verifies each commit with the project's build and test commands in a clean copy and says "verified locally, no CI".
ci_absent() { ci_out=$(sh "$agent" ci-check 2>/dev/null) || :; [ "$(printf '%s\n' "$ci_out" | head -1)" = 'ci: absent' ]; }
ci_warning() { printf 'WARNING: %s Every pull request of this batch is merged only after its build and test pass in a clean copy of the commit. To get real checks instead: %s\n' "$(sh "$agent" ci-check 2>/dev/null | sed -n 2p)" "$(sh "$agent" ci-task-command 2>/dev/null)"; }
# --- plan-lint (A200): the questions a plan would raise at freeze, asked before the approval --------------------------------
# lint_task ID FILE CLASS appends rows to $tmp/lint.raw: kind, text, options (a|b|c), recommended letter, param. Everything is read from the
# task file alone (the plan does not exist yet), so each question is a prediction; the freeze asks again whatever turns out otherwise.
# The recommended option is always the safe one (split, a test, no new dependency, criteria rewritten, class kept).
lint_paths() { # FILE: the repository-looking paths a task names in backticks
  grep -o '`[^` ]*`' "$1" 2>/dev/null | tr -d '`' | grep -E '^[A-Za-z0-9_./@-]+$' | grep -Ev '://|^-|^[.]+$' | grep -E '/|[.][A-Za-z][A-Za-z0-9]{0,4}$' | sort -u || :
}
lint_task() {
  lt_id=$1; lt_f=$2; lt_c=$3
  lt_paths=$(lint_paths "$lt_f"); lt_code=0; lt_cont=0; lt_cl=''
  if [ -n "$lt_paths" ]; then
    # shellcheck disable=SC2086 # paths of the safe character set above
    lt_k=$(sh "$agent" path-kind $lt_paths 2>/dev/null) || lt_k=''
    lt_code=$(printf '%s\n' "$lt_k" | awk -F'\t' '$1 == "code"' | wc -l | tr -d ' ')
    lt_cont=$(printf '%s\n' "$lt_k" | awk -F'\t' '$1 == "content"' | wc -l | tr -d ' ')
    lt_cl=$(printf '%s\n' "$lt_k" | awk -F'\t' '$1 == "content" { print $2 }' | head -4 | tr '\n' ' ' | sed 's/ $//')
  fi
  lt_max=$(cfgv "pipelines.$lt_c.max_scope_paths" 15)
  if [ "$lt_code" -gt "$lt_max" ]; then
    lt_ceil=$((lt_code + (lt_code + 1) / 2))
    printf '%s\tsplit\tThe task names %s code paths (%s content or document paths are not counted); the %s limit is %s. Split it? Otherwise the freeze would stop and ask.\ta) split it into at least %s tasks (task-author) [recommended]|b) proceed without splitting, up to %s code paths (more than that asks again at freeze)\ta\t%s\n' "$lt_id" "$lt_code" "$lt_cont" "$lt_c" "$lt_max" "$(( (lt_code + lt_max - 1) / lt_max ))" "$lt_ceil" "$lt_ceil" >> "$tmp/lint.raw"
  fi
  if [ "$lt_cont" -gt 0 ]; then
    printf '%s\texempt\tThe task names %s content or document path(s) (%s%s). A document has no RED/GREEN to show, so the plan needs a tdd_exemption for each, or a test. Which?\ta) tdd_exemption with a specific reason per path, verified by the check the task names [recommended]|b) a test for each path (the plan names it)\ta\t-\n' "$lt_id" "$lt_cont" "$lt_cl" "$([ "$lt_cont" -gt 4 ] && echo ', ...')" >> "$tmp/lint.raw"
  fi
  if grep -Eiq '(new|add(s|ed|ing)?|introduc(e|es|ed|ing)|install(s|ed|ing)?|upgrade|bump)[^.]{0,40}(depend(ency|encies)|librar(y|ies)|package|module|crate|gem)|npm (i|install) |pip install|go get |cargo add|yarn add|pnpm add' "$lt_f"; then
    printf '%s\tdep\tThe task reads as if it adds or changes a dependency. A new dependency needs your own approval, which this batch does not cover. Which?\ta) no new dependency: the task uses what exists [recommended]|b) a dependency is needed: park the task until you decide it yourself\ta\t-\n' "$lt_id" >> "$tmp/lint.raw"
  fi
  lt_ac=$(awk '/^## Acceptance criteria[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && /^[[:space:]]*([-*]|[0-9]+[.])?[[:space:]]*AC-[0-9]+:/ { n++ } END { print n + 0 }' "$lt_f")
  lt_vague=$(awk '/^## Acceptance criteria[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && /AC-[0-9]+:/ && tolower($0) ~ /(^|[^a-z])(better|nicer|improve[sd]?|faster|good|clean(er)?|appropriate(ly)?|as needed|user-friendly|robust|properly|etc|and so on|reasonable|intuitive|nice)([^a-z]|$)/ { sub(/^[[:space:]]*[-*0-9.]*[[:space:]]*/, ""); print substr($0, 1, 70); exit }' "$lt_f")
  if [ "$lt_ac" -eq 0 ]; then
    printf '%s\tac\tThe task has no acceptance criteria (AC-<n>: ...), so nothing can be tested or reviewed. Which?\ta) park the task until its criteria are written (task-author) [recommended]|b) run it anyway (the plan stops at freeze)\ta\t-\n' "$lt_id" >> "$tmp/lint.raw"
  elif [ -n "$lt_vague" ]; then
    printf '%s\tac\tA criterion cannot be measured as written: "%s". Which?\ta) park the task until it is rewritten with a number, a path or an observable result (task-author) [recommended]|b) run it as written (QA may block on it)\ta\t-\n' "$lt_id" "$lt_vague" >> "$tmp/lint.raw"
  fi
  lt_n=$((lt_code + lt_cont))
  case "$lt_c:$([ "$lt_n" -le 6 ] && echo small)" in COMPLEX:small)
    lt_why=$(awk '/^## Suggested class[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && NF { print substr($0, 1, 90); exit }' "$lt_f")
    printf '%s\tclass\tClassified COMPLEX (%s path(s) named). Its reason: "%s". COMPLEX adds an architect, a stricter review and more gates (more time). Keep it?\ta) keep COMPLEX [recommended]|b) STANDARD (you take the lighter review)|c) another class: say which in your answer\ta\t-\n' "$lt_id" "$lt_n" "${lt_why:-none written}" >> "$tmp/lint.raw" ;;
  esac
}
# ans_row ID KIND: the newest recorded answer for the batch in force: letter<TAB>question number
ans_row() {
  [ -f "$bd/answers.tsv" ] || return 0
  awk -F'\t' -v b="$(bid)" -v t="$1" -v k="$2" '$1 == b && $2 == t && $4 == k { r = $5 "\t" $3 } END { if (r != "") print r }' "$bd/answers.tsv"
}

plan() {
  [ "$(cfgv tasks.adapter markdown)" = markdown ] || die "night mode runs markdown task files only, but tasks.adapter is $(cfgv tasks.adapter markdown) (a design decision, A161: the order and the classes are read from the task files, not from network calls). Next step: set tasks.adapter to markdown in .agents/config.yaml, import each task with '/proofline task <issue reference>' (it writes <tasks.dir>/<ID>.md with its Suggested class and depends_on), then run '/proofline batch <ID...>' again"
  repl=no; for a in "$@"; do shift; case "$a" in --replace) repl=yes ;; --codex-danger-full-access) die "--codex-danger-full-access is gone: night mode runs in your own session (removed in 0.0.32), so the session's own permissions apply" ;; *) set -- "$@" "$a" ;; esac; done
  td=$root/$(cfgv tasks.dir .agents/tasks)
  # the same approved batch, not finished: continue it instead of planning a new one (a new plan has a new summary and needs a new approval)
  if [ "$repl" = no ] && [ -f "$bd/order.tsv" ] && sh "$agent" batch-check >/dev/null 2>&1 && [ "$(derive_state)" = approved ]; then
    rs_sel="$*"; [ "$rs_sel" != all ] || rs_sel=$(for f in "$td"/todo/*.md "$td"/*.md; do [ -f "$f" ] && basename "$f" .md; done | sort -u | tr '\n' ' ')
    rs_out=''; for a in $rs_sel; do grep -q "^$a	" "$bd/order.tsv" || grep -q "^- $a:" "$bd/SUMMARY.md" || rs_out="$rs_out $a"; done
    if [ -n "$rs_out" ]; then
      die "batch $(bid) is approved and not finished, and it does not contain:$rs_out. Continue it with /proofline batch (no task IDs), or plan a new batch that includes them with agent.sh batch-plan --replace <ID...|all> (a new summary and a new approval)"
    else
      printf 'batch %s is approved and not finished: continuing it, no new plan and no new approval (to plan a new batch instead: agent.sh batch-plan --replace <ID...|all>).\n\n' "$(bid)"
      next_report; return 3
    fi
  fi
  [ $# -gt 0 ] || die "usage: agent.sh batch-plan [--replace] <ID...|all> (no task IDs: only to continue an approved batch)"
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
  # a batch that did work goes to history; an unworked plan is simply replaced
  mkdir -p "$bd"
  if [ -f "$bd/state.tsv" ] || [ -s "$bd/merged.tsv" ] || [ -f "$bd/ci.tsv" ] || [ -f "$bd/answers.tsv" ]; then
    hd=$bd/history/$( [ -f "$bd/SUMMARY.md" ] && bid || echo previous ); mkdir -p "$hd"
    for f in SUMMARY.md order.tsv state.tsv merged.tsv ci.tsv lint.tsv answers.tsv paths.tsv; do [ ! -e "$bd/$f" ] || mv "$bd/$f" "$hd/"; done
  fi
  cap=$(cfgv batch.mutation_budget_cap 40)
  # A200: plan-lint and the commands proposal, before the summary (the approval is bound to the summary's hash, so to both)
  : > "$tmp/lint.raw"
  while IFS="$(printf '\t')" read -r _k lid lcls _d _t; do
    lf=$td/$lid.md; [ -f "$lf" ] || lf=$td/todo/$lid.md; [ -f "$lf" ] || lf=$td/backlog/$lid.md
    lint_task "$lid" "$lf" "$lcls"
  done < "$tmp/kept"
  # A200: the code paths each task names (content and document paths are left out): a task that shares one with an earlier task that is not merged waits for it
  : > "$tmp/paths.tsv"
  while IFS="$(printf '\t')" read -r _k lid _c _d _t; do
    lf=$td/$lid.md; [ -f "$lf" ] || lf=$td/todo/$lid.md; [ -f "$lf" ] || lf=$td/backlog/$lid.md
    lp=$(lint_paths "$lf")
    # shellcheck disable=SC2086 # paths of the safe character set of lint_paths
    [ -z "$lp" ] || sh "$agent" path-kind $lp 2>/dev/null | awk -F'\t' -v t="$lid" '$1 == "code" { print t "\t" $2 }' >> "$tmp/paths.tsv" || :
  done < "$tmp/kept"
  awk -F'\t' -v OFS='\t' '{ print "Q" NR, $1, $2, $3, $4, $5, $6 }' "$tmp/lint.raw" > "$tmp/lint.tsv"   # Qn id kind text options rec param
  pf=${PROOFLINE_SHARED_ROOT:-$root}/.agents/local/commands/PROPOSAL.tsv
  cmd_empty=''; for ck in build test lint; do [ -n "$(sh "$agent" config-get "commands.$ck" 2>/dev/null)" ] || cmd_empty="$cmd_empty $ck"; done
  {
    printf '# Night batch\n\nnonce: %s-%s\n\n' "$(date +%s)" "$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo $$)"
    if ci_absent; then
      printf '## WARNING\n\n%s\n\n' "$(ci_warning)"
    fi
    printf 'One approval of this summary stands in for the approvals listed below, for the tasks in the table and for nothing else.\nThe batch id is the first 12 hex digits of the sha256 of this file; the approval is bound to that hash.\n\n'
    printf '## Order (one task at a time, in this session: run it, deliver it, and only when it is merged the next one; each task in a git worktree of its own)\n\n| # | task | title | class | depends_on |\n|---|------|-------|-------|------------|\n'
    p=0
    while IFS="$(printf '\t')" read -r oid ocls odep; do
      p=$((p + 1)); ot=$(awk -F'\t' -v t="$oid" '$2 == t { print $5 }' "$tmp/kept")
      printf '| %s | %s | %s | %s | %s |\n' "$p" "$oid" "$ot" "$ocls" "$odep"
    done < "$tmp/order"
    printf '\n## What the approval covers, per task\n\n'
    printf -- '- plan: the freeze of the plan (kind plan), after classification and the usual checks\n'
    printf -- '- delivery: commit, push, pull request, merge only when CI is green and every gate passed (proofline merge), cleanup\n'
    printf -- '- CI red after the pull request is open: up to 2 CI-fix rounds, each a normal fix round that passes the gates again, pushed to the same pull request branch and nothing else; the delivery approval covers exactly those pushes, then the task is parked with the error and what was tried\n'
    printf -- '- mutation budget: a raise of test_trust.mutation_budget (now %s) up to the cap batch.mutation_budget_cap = %s\n' "$(cfgv test_trust.mutation_budget 20)" "$cap"
    printf '\n## Pre-flight questions (plan-lint, A200)\n\n'
    if [ -s "$tmp/lint.tsv" ]; then
      printf 'These are the questions the plan of each task would raise at freeze, asked now so that no task parks on them overnight. Answer with the letters ("Q1 a, Q2 b"), in your own words ("Q1: do not split", "Q3 hayir"), or "all recommended". Your message is recorded as it is (agent.sh batch-answer) and applied when each plan freezes; a question you leave open is asked again at freeze, as before. An answer is never an approval of anything else.\n\n'
      while IFS="$(printf '\t')" read -r qn qid qkind qtext qopts _qrec _qp; do
        printf -- '- %s [%s, %s] %s\n' "$qn" "$qid" "$qkind" "$qtext"
        printf '%s\n' "$qopts" | tr '|' '\n' | sed 's/^/    /'
      done < "$tmp/lint.tsv"
    else printf -- '- none: no task raises a question that can be told from its task file\n'; fi
    printf '\n## Verification commands (A200)\n\n'
    if [ -z "$cmd_empty" ]; then printf -- '- commands.build, commands.test and commands.lint are configured\n'
    elif [ -s "$pf" ]; then
      printf -- '- commands.%s are empty. Proven by one run each, proposed for .agents/config.yaml (your approval of this batch covers writing them: proofline doctor --apply-commands):\n' "$(printf '%s' "$cmd_empty" | sed 's/^ //; s/ /, commands./g')"
      awk -F'\t' '!/^#/ { print "    commands." $1 ": " $2 }' "$pf"
      printf 'commands proposal: %s\n' "$(sha "$pf" | cut -c1-12)"
    else printf -- '- commands.%s are empty and no proven proposal exists: no build record can be made and the verify gate has nothing to run for them. Before approving, run proofline doctor --commands and plan the batch again (agent.sh batch-plan --replace ...); the proposal then appears here\n' "$(printf '%s' "$cmd_empty" | sed 's/^ //; s/ /, commands./g')"; fi
    printf '\n## Stop rules\n\n'
    printf -- '- a task that needs anything else is parked with its question and the batch goes on; a task that depends on it is skipped\n'
    printf -- '- every task works in its own git worktree (.agents/local/worktrees/<ID>, made from the canonical branch just before the task starts): a parked task, one waiting for its merge and one in a CI-fix round keep theirs and block no task that does not depend on them; the main working tree is never touched. A task starts only when every task it depends on is merged; a merged task'"'"'s worktree is removed\n'
    printf -- '- after every merge the lead checks the CI run of the merge commit itself (not the latest run, agent.sh batch-ci): the batch stops when that run is red, still running after batch.ci_wait_minutes (%s), or when no run for it appears within batch.ci_appear_minutes (%s)\n' "$(cfgv batch.ci_wait_minutes 30)" "$(cfgv batch.ci_appear_minutes 10)"
    printf -- '- the batch stops when the session closes, a usage limit is hit or the computer sleeps; the same approved batch continues with /proofline batch and never runs a merged task again\n'
    printf '\n## NOT covered (each stays a question the batch parks on)\n\n'
    printf -- '- a waiver of a finding, a scope expansion, a new dependency, a reopen of a FAILED or BLOCKED run\n'
    printf -- '- a destructive or single_step data change, a rule promotion, sending the friction report, a new fix-round budget\n'
    printf -- '- a mutation budget above the cap, and any CRITICAL task\n'
    printf '\n## Not in this batch\n\n'
    if awk -F'\t' '$1 == "X" { f = 1 } END { exit !f }' "$tmp/split"; then awk -F'\t' '$1 == "X" { print "- " $2 ": " $3 }' "$tmp/split"; else printf -- '- none\n'; fi
    printf '\n## Keep the computer awake and this session open\n\n'
    printf 'The batch runs in THIS session, task after task; there is no background process. It stops when the session closes, a usage limit is hit or the computer sleeps. %s\n' "$PLUG_LINE"
    printf 'On macOS the session offers to start caffeinate -i -w <this session'"'"'s pid>, which keeps the Mac awake exactly as long as the session lives (agent.sh batch-awake).\n'
    printf 'After an interruption run /proofline batch again: the approved batch continues where it stopped and a merged task is never run again.\n'
  } > "$tmp/SUMMARY.md"
  mv "$tmp/SUMMARY.md" "$bd/SUMMARY.md"
  mv "$tmp/order" "$bd/order.tsv"
  mv "$tmp/lint.tsv" "$bd/lint.tsv"
  mv "$tmp/paths.tsv" "$bd/paths.tsv"
  cat "$bd/SUMMARY.md"
  printf '\nbatch id: %s\n\n' "$(bid)"
}

# --- state -----------------------------------------------------------------------------------------------------------
st_get() { [ -f "$bd/state.tsv" ] || return 0; awk -F'\t' -v t="$1" -v c="$2" '$1 == t { print $c; exit }' "$bd/state.tsv"; }
merged_pr() { awk -F'\t' -v t="$1" '$1 == t { p = $2; f = 1 } END { if (f) print p; exit !f }' "$bd/merged.tsv" 2>/dev/null; }
# rroot ID: where the task's run lives (A169): its own worktree, else the main working tree (a run an older batch left there)
rroot() { if [ -d "$wtb/$1/.agents" ]; then printf '%s\n' "$wtb/$1"; else printf '%s\n' "$root"; fi; }
rsec() { # ID SECTION KEY: a value of the run's RUN.yaml
  awk -v s="$2" -v k="$3" '$0 == s ":" { i = 1; next } i && /^[^ #]/ { exit } i && $0 ~ "^  " k ":" { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' "$(rroot "$1")/.agents/runs/$1/RUN.yaml" 2>/dev/null || :
}
has_run() { [ -f "$(rroot "$1")/.agents/runs/$1/RUN.yaml" ]; }
open_question() { # ID: the first line of the first unanswered question, from the run's records
  oq_a=$(rroot "$1")/.agents/scripts/agent.sh; [ -f "$oq_a" ] || oq_a=$agent
  sh "$oq_a" questions "$1" 2>/dev/null | sed -n '/^=== QUESTION/{n;p;q;}' || :
}
pending_approval() { # ID: the kind of an approval request nobody answered
  pa_d=$(rroot "$1")/.agents/runs/$1/approvals
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
fmt_ts() { [ -n "$1" ] || { echo "-"; return 0; }; date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$1"; }

# own_state ID: sets DS (open|parked), DD (the detail: the action of an open task, the reason of a parked one), DQ (the question), from the
# lead's own parks and the task's run records. A run with an unanswered question, a FAILED or BLOCKED run, an approval request the batch does
# not cover and an open pull request park the task; an answered question or a reopened run un-parks it by itself.
own_state() {
  os_id=$1; DS=open; DD=run; DQ=''
  if [ "$(st_get "$os_id" 2)" = parked ]; then DS=parked; DD=$(st_get "$os_id" 3); DQ=$(st_get "$os_id" 4); return 0; fi
  # A200: a task whose pre-flight answer is "park until it is decided or written" never starts; the answer is the user's own
  if ! has_run "$os_id"; then
    for os_k in dep ac; do
      os_a=$(ans_row "$os_id" "$os_k")
      if [ "$(printf '%s' "$os_a" | cut -f1)" = b ] && [ "$os_k" = dep ]; then DS=parked; DD="new dependency"; DQ="you answered $(printf '%s' "$os_a" | cut -f2) with b: a dependency is needed and only you approve it; decide it, then agent.sh batch-park $os_id --clear"; return 0; fi
      if [ "$(printf '%s' "$os_a" | cut -f1)" = a ] && [ "$os_k" = ac ]; then DS=parked; DD="criteria to write"; DQ="you answered $(printf '%s' "$os_a" | cut -f2) with a: the acceptance criteria are written (task-author) first; then agent.sh batch-park $os_id --clear"; return 0; fi
    done
  fi
  has_run "$os_id" || return 0
  DD=resume
  case "$(rsec "$os_id" execution state)" in FAILED|BLOCKED) DS=parked; DD=$(rsec "$os_id" execution state); return 0 ;; esac
  os_q=$(open_question "$os_id"); if [ -n "$os_q" ]; then DS=parked; DD=question; DQ=$os_q; return 0; fi
  os_k=$(pending_approval "$os_id") || os_k=''
  case "$os_k" in
    '') ;;
    plan|mutation_budget) DD="cover $os_k"; return 0 ;;
    commit|push|pr|merge|cleanup) DD="cover delivery"; return 0 ;;
    *) DS=parked; DD="approval request"; DQ="$os_k"; return 0 ;;
  esac
  if [ -s "$(rroot "$os_id")/.agents/local/deliver/$os_id/PR" ]; then
    # the merge step ran but merged.tsv has no record: ask the platform (a session died after the merge, or the user merged by hand)
    os_pr=$(cat "$(rroot "$os_id")/.agents/local/deliver/$os_id/PR" 2>/dev/null)
    case "$os_pr" in ''|*[!0-9]*) os_ps=unreadable ;; *) os_ps=$(sh "$agent" pr-state "$os_pr" 2>/dev/null | sed -n 1p | awk '{ print $1 }') ;; esac
    case "$os_ps" in
      MERGED) DD="deliver cleanup"; DQ=$os_pr; return 0 ;;
      OPEN) DS=parked; DD="awaiting merge"; DQ="pull request $os_pr is open and not merged"; return 0 ;;
      *) DS=parked; DD="awaiting merge"; DQ="pull request $os_pr: its state cannot be read (platform tool missing, not logged in or not supported); look at it yourself"; return 0 ;;
    esac
  fi
  # the user merges (platform other, a local origin): the delivered commit is kept in MERGE_HEAD; git says whether it was merged (round 3)
  os_dd=$(rroot "$os_id")/.agents/local/deliver/$os_id
  # the hand-off file, or (round 5) a pushed delivery where the user merges whose pr step did not run: both wait for the user's merge
  if [ -s "$os_dd/MERGE_HEAD" ] || { grep -qs '^merge_by: user$' "$os_dd/SUMMARY.md" && git -C "$(rroot "$os_id")" rev-parse -q --verify "refs/remotes/origin/$(sed -n 's/^branch: //p' "$os_dd/SUMMARY.md" | head -n 1)" >/dev/null 2>&1; }; then
    if sh "$agent" deliver-merged "$os_id" --check >/dev/null 2>&1; then DD="deliver merged"; return 0; fi
    DS=parked; DD="awaiting merge"; DQ="the branch of $os_id is pushed and waits for YOUR merge into origin's $(cfgv canonical_branch main) (for example: git push origin <branch>:$(cfgv canonical_branch main)); then /proofline batch continues"; return 0
  fi
  case "$(rsec "$os_id" handoff state)" in CODE_DONE|DONE) DD=deliver ;; esac
}
# derive: one row per task of order.tsv, in order: ID state detail question PR merge-epoch
#   state merged | parked | skipped (a dependency is parked or skipped) | waiting (a dependency is still open) | open (detail: the action)
derive() {
  [ -f "$bd/order.tsv" ] || return 0
  dv=$(mktemp "${TMPDIR:-/tmp}/proofline-batchrows.XXXXXX"); : > "$dv"
  for dr_id in $(cut -f1 "$bd/order.tsv"); do
    dr_s=''; dr_d=''; dr_q=''; dr_p=''; dr_t=''
    if dr_p=$(merged_pr "$dr_id"); then
      dr_s=merged; dr_t=$(awk -F'\t' -v t="$dr_id" '$1 == t { e = $3 } END { print e }' "$bd/merged.tsv")
    else
      dr_p=''
      for dep in $(awk -F'\t' -v t="$dr_id" '$1 == t { gsub(/,/, " ", $3); print $3 }' "$bd/order.tsv"); do
        case "$dep" in -|'') continue ;; esac
        if merged_pr "$dep" >/dev/null; then continue; fi
        dr_ds=$(awk -F'\t' -v t="$dep" '$1 == t { print $2; exit }' "$dv")
        case "$dr_ds" in
          '') ;;   # done before this batch: planned only when it is in done/
          parked|skipped) dr_s=skipped; dr_d="depends on $dep ($dr_ds)"; break ;;
          *) dr_s=waiting; dr_d="depends on $dep (not merged yet)"; break ;;
        esac
      done
      # A200: a task that names a code path an earlier task of the batch names too waits until that task is merged (the same file in two
      # open branches is a conflict at merge); a dependency that is not earlier in the order is not "done before this batch" either
      if [ -z "$dr_s" ]; then
        for dep in $(awk -F'\t' -v t="$dr_id" '$1 == t { gsub(/,/, " ", $3); print $3 }' "$bd/order.tsv"); do
          case "$dep" in -|'') continue ;; esac
          if merged_pr "$dep" >/dev/null; then continue; fi
          awk -F'\t' -v t="$dep" '$1 == t { f = 1 } END { exit !f }' "$bd/order.tsv" || continue
          awk -F'\t' -v t="$dep" '$1 == t { f = 1 } END { exit !f }' "$dv" || { dr_s=waiting; dr_d="depends on $dep (later in the order, not merged yet)"; break; }
        done
      fi
      if [ -z "$dr_s" ] && [ -s "$bd/paths.tsv" ]; then
        dr_o=$(awk -F'\t' -v t="$dr_id" 'NR == FNR { if ($1 == t) mine[$2] = 1; next } ($1 != t) && ($2 in mine) { print $1 "\t" $2 }' "$bd/paths.tsv" "$bd/paths.tsv" | while IFS="$(printf '\t')" read -r dr_x dr_y; do
            # only a task that comes EARLIER in the order and is not merged
            if awk -F'\t' -v t="$dr_x" -v me="$dr_id" '$1 == me { exit } $1 == t { f = 1 } END { exit !f }' "$bd/order.tsv" && ! merged_pr "$dr_x" >/dev/null; then printf '%s\t%s\n' "$dr_x" "$dr_y"; break; fi
          done)
        if [ -n "$dr_o" ]; then
          dr_x=${dr_o%%	*}; dr_ds=$(awk -F'\t' -v t="$dr_x" '$1 == t { print $2; exit }' "$dv")
          case "$dr_ds" in parked|skipped) dr_s=skipped; dr_d="shares ${dr_o#*	} with $dr_x ($dr_ds)" ;; *) dr_s=waiting; dr_d="shares ${dr_o#*	} with $dr_x (not merged yet)" ;; esac
        fi
      fi
      if [ -z "$dr_s" ]; then own_state "$dr_id"; dr_s=$DS; dr_d=$DD; dr_q=$DQ; fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$dr_id" "$dr_s" "$(tsv "$dr_d")" "$(tsv "$dr_q")" "$dr_p" "$dr_t" >> "$dv"
  done
  cat "$dv"; rm -f "$dv"
}
# ci_pending: the latest merged task of this batch whose merge commit's CI was not checked yet (the lead checks it before the next task)
ci_pending() {
  [ -s "$bd/merged.tsv" ] || return 1
  cp_id=$(awk -F'\t' 'NR == FNR { o[$1] = 1; next } ($1 in o) { l = $1 } END { print l }' "$bd/order.tsv" "$bd/merged.tsv")
  [ -n "$cp_id" ] || return 1
  awk -F'\t' -v t="$cp_id" '$1 == t { f = 1 } END { exit !f }' "$bd/ci.tsv" 2>/dev/null && return 1
  printf '%s\n' "$cp_id"
}
# derive_state: nobatch | unapproved | approved (work is left) | finished-parked | finished-clean
derive_state() {
  [ -f "$bd/SUMMARY.md" ] && [ -f "$bd/order.tsv" ] || { echo nobatch; return 0; }
  sh "$agent" batch-check >/dev/null 2>&1 || { echo unapproved; return 0; }
  ds_rows=$(derive)
  if printf '%s\n' "$ds_rows" | awk -F'\t' '$2 == "open" || $2 == "waiting" { f = 1 } END { exit !f }' || ci_pending >/dev/null; then echo approved
  elif printf '%s\n' "$ds_rows" | awk -F'\t' '$2 == "parked" || $2 == "skipped" { f = 1 } END { exit !f }'; then echo finished-parked
  else echo finished-clean; fi
}
approved_at() {
  ap=$(grep -l "^bound: \"$(sha "$bd/SUMMARY.md")\"" "${PROOFLINE_SHARED_ROOT:-$root}"/.agents/local/approvals/[0-9][0-9][0-9]-batch.yaml 2>/dev/null | sort | tail -1 || :)
  at=''; [ -z "$ap" ] || at=$(sed -n 's/^approved_at: //p' "$ap" | head -1)
  [ -z "$at" ] || fmt_ts "$at"
}
awake_line() {
  [ -f "$bd/awake.pid" ] && [ -f "$bd/awake" ] || return 0
  aw_p=$(cat "$bd/awake.pid" 2>/dev/null || :)
  case "$aw_p" in ''|*[!0-9]*|0|1) return 0 ;; esac
  aw_s=$(ps -o stat= -p "$aw_p" 2>/dev/null | tr -d ' ' || :)
  case "$aw_s" in ''|Z*) printf 'awake: the sleep inhibitor ended (the session it was tied to is gone)\n' ;; *) cat "$bd/awake" ;; esac
}
# claim_owner: one session works a batch. owner holds the pid of the session that last asked `next`; another live session gets `wait`
# (its pid is printed), a dead owner is taken over. Without a findable session process there is no guard.
# Only the lead claims or is told to wait (PROOFLINE_BATCH_ROLE is set by agent.sh batch-next); any other role gets the digest and writes nothing.
claim_owner() {
  [ "${PROOFLINE_BATCH_ROLE:-}" = lead ] || return 0
  co_me=$(session_pid) || return 0
  co_o=$(cut -f1 "$bd/owner" 2>/dev/null || :)
  if [ -n "$co_o" ] && [ "$co_o" != "$co_me" ]; then
    co_s=$(ps -o stat= -p "$co_o" 2>/dev/null | tr -d ' ' || :)
    case "$co_s" in ''|Z*) ;; *) printf '%s\n' "$co_o"; return 1 ;; esac
  fi
  printf '%s\t%s\n' "$co_me" "$(date +%s)" > "$bd/owner"
}
# next_report [--tsv]: the digest the lead re-reads before every task
next_report() {
  nr_state=$(derive_state); nr_rows=$(derive)
  if [ "${1:-}" = --tsv ]; then printf 'state\t%s\n' "$nr_state"; [ -z "$nr_rows" ] || printf '%s\n' "$nr_rows" | cut -f1-4; return 0; fi
  case "$nr_state" in
    nobatch) echo "no batch planned (agent.sh batch-plan <ID...|all>)"; return 0 ;;
    unapproved) printf 'batch %s: NOT approved (or the summary changed): the user replies "approve batch" to the summary; nothing runs before.\n' "$(bid)"
      echo "NEXT: approve"; return 0 ;;
  esac
  printf 'batch %s, approved at %s\n' "$(bid)" "$(approved_at)"
  awake_line
  nr_wait=''; nr_wait=$(claim_owner) || :
  printf '%s | %s | %s | %s\n' task state detail 'pending question'
  printf '%s\n' "$nr_rows" | awk -F'\t' '{ printf "%s | %s | %s | %s\n", $1, $2, ($3 == "" ? "-" : $3), ($4 == "" ? "-" : $4) }'
  nr_ci=$(ci_pending) || nr_ci=''
  nr_open=$(printf '%s\n' "$nr_rows" | awk -F'\t' '$2 == "open" { print $1 "\t" $3; exit }')
  if [ -n "$nr_wait" ]; then
    echo "NEXT: wait (owned by pid $nr_wait)   (pid $nr_wait is another live session; if it is yours, run the batch there or close it; do not start a second one. If that session is gone, ask again: a dead owner is taken over)"
  elif [ -n "$nr_ci" ]; then
    echo "NEXT: ci $nr_ci   (agent.sh batch-ci $nr_ci: the CI of its merge commit; red or no run in time: stop the batch)"
  elif [ -n "$nr_open" ]; then
    nr_id=${nr_open%%	*}; nr_act=${nr_open#*	}
    case "$nr_act" in
      run) echo "NEXT: run $nr_id   (agent.sh worktree-add $nr_id, then /proofline run $nr_id with .agents/local/worktrees/$nr_id as the working folder)" ;;
      resume) echo "NEXT: resume $nr_id   (agent.sh next $nr_id, in $(rroot "$nr_id" | sed "s|^$root/*||; s|^$|the main working tree|"))" ;;
      "cover "*) echo "NEXT: cover $nr_id ${nr_act#cover }   (agent.sh batch-cover $nr_id ${nr_act#cover })" ;;
      "deliver cleanup") nr_pr=$(printf '%s\n' "$nr_rows" | awk -F'\t' -v t="$nr_id" '$1 == t { print $4 }'); echo "NEXT: deliver $nr_id cleanup $nr_pr   (pull request $nr_pr is merged but not recorded: agent.sh deliver-step $nr_id cleanup $nr_pr records the merge and cleans up)" ;;
      "deliver merged") echo "NEXT: deliver $nr_id merged   (the user merged it on origin: agent.sh deliver-merged $nr_id proves that from git, records the merge and cleans up the run and its worktree)" ;;
      deliver) echo "NEXT: deliver $nr_id   (the whole delivery of the lead skill; the approval is covered by batch-cover $nr_id delivery)" ;;
    esac
  else
    case "$nr_state" in finished-parked) echo "NEXT: finished   (parked or skipped tasks wait for the user: answer their questions or reopen the run, then /proofline batch continues)" ;; *) echo "NEXT: finished" ;; esac
  fi
}

# --- the user's answers to the pre-flight questions (A200) ---------------------------------------------------------------------
# answer: the answers are the user's own message, as the prompt hook captured it: the newest captured message newer than the
# summary and not used by another answer. The script parses it; the lead relays nothing and decides nothing. A letter after a
# question number ("Q2 b"), a natural-language reply to a split question, or "all recommended" are understood; whatever is not
# understood stays unanswered and is asked again at freeze. A later message corrects an earlier answer to the same question.
prompts_dir() { printf '%s\n' "${PROOFLINE_SHARED_ROOT:-$root}/.agents/local/prompts"; }
neg_re='(^|[^a-z])(not|never|no|nope|n.t|dont|do not|without|degil|değil|hayir|hayır|bolme|bölme)([^a-z]|$)'
answer_cmd() {
  [ -f "$bd/lint.tsv" ] && [ -f "$bd/SUMMARY.md" ] || die "no batch plan to answer (agent.sh batch-plan <ID...|all>)"
  [ -s "$bd/lint.tsv" ] || { echo "batch: the summary asks no pre-flight question"; return 0; }
  an_h=$(prompts_dir)/history; an_b=$(bid)
  an_from=$(stat -f %m "$bd/SUMMARY.md" 2>/dev/null || stat -c %Y "$bd/SUMMARY.md" 2>/dev/null || echo 0)
  an_pick=''
  for an_f in $(ls -1 "$an_h"/*.txt 2>/dev/null | sort); do
    an_e=${an_f##*/}; an_e=${an_e%%-*}; case "$an_e" in ''|*[!0-9]*) continue ;; esac
    [ "$an_e" -ge "$an_from" ] || continue
    grep -q '[^[:space:]]' "$an_f" && [ "$(head -c 19 "$an_f")" != '<task-notification>' ] || continue
    grep -qxF "${an_f##*/}" "$(prompts_dir)/consumed" 2>/dev/null && continue
    # a message that carries no question number and no "recommended" is not an answer: it may be the approval or a remark
    tr '[:upper:]' '[:lower:]' < "$an_f" | grep -Eq '(^|[^a-z0-9])q[0-9]+|recommended|önerilen|onerilen' || continue
    an_pick=$an_f
  done
  [ -n "$an_pick" ] || die "no captured user message since the summary answers a question (the user answers Q1, Q2 ... or says 'all recommended'; then run this again)"
  an_low=$(tr '[:upper:]' '[:lower:]' < "$an_pick" | tr '\n' ' ' | tr -s ' ')
  an_n=0; an_rec=0
  printf '%s' "$an_low" | grep -Eq '(all|every|hepsi|tümü|tumu)[^.]{0,20}(recommended|önerilen|onerilen)|(recommended|önerilen|onerilen)[^.]{0,12}(all|for all|hepsi|tümü|tumu)' && an_rec=1
  while IFS="$(printf '\t')" read -r qn qid qkind _qtext qopts qrec qparam; do
    # the segment of this question: after "qN" up to the next "qM"
    an_seg=$(printf '%s' "$an_low" | awk -v q="$(printf '%s' "$qn" | tr '[:upper:]' '[:lower:]')" '{
      s = $0
      while (match(s, /(^|[^a-z0-9])q[0-9]+/)) {
        tok = substr(s, RSTART, RLENGTH); sub(/^[^q]*/, "", tok); s = substr(s, RSTART + RLENGTH)
        if (match(s, /(^|[^a-z0-9])q[0-9]+/)) seg = substr(s, 1, RSTART - 1); else seg = s
        if (tok == q) { print seg; exit }
      } }')
    an_l=''
    if [ -n "$an_seg" ]; then
      an_t=$(printf '%s' "$an_seg" | sed 's/^[ :.)=,-]*//')
      an_one=$(printf '%s' "$an_t" | sed 's/^\(option\|answer\|choose\|seçenek\|secenek\) *//; s/[ ,.;)(-]*$//')
      case "$an_one" in [a-e]) an_l=$an_one ;; esac
      if [ -z "$an_l" ]; then
        case "$qkind" in
          split)
            if printf '%s' "$an_t" | grep -Eq 'proceed without splitting|do not split|dont split|don.t split|no split|(^|[^a-z])(bölme|bolme)([^a-z]|$)|bölmeden|bolmeden'; then an_l=b
            elif printf '%s' "$an_t" | grep -Eq '^(no|hayır|hayir)([^a-z]|$)'; then
              # a leading "no" that also says to split ("no problem, split it") is ambiguous: left unanswered, asked again at freeze
              if printf '%s' "$an_t" | grep -Eq '(^|[^a-z])(split|böl|bol)'; then an_l=''; else an_l=b; fi
            elif printf '%s' "$an_t" | grep -Eq '(^|[^a-z])(split|böl|bol|yes|evet|recommended|önerilen|onerilen)([^a-z]|$)' && ! printf '%s' "$an_t" | grep -Eq "$neg_re"; then an_l=a; fi ;;
          *)
            if printf '%s' "$an_t" | grep -Eq '^(recommended|your recommendation|önerilen|onerilen|yes|evet|ok|okay|keep)([^a-z]|$)' && ! printf '%s' "$an_t" | grep -Eq "$neg_re"; then an_l=$qrec; fi ;;
        esac
        # question c of class: "standard" or "complex" in words
        if [ -z "$an_l" ] && [ "$qkind" = class ]; then case "$an_t" in standard*) an_l=b ;; esac; fi
      fi
    elif [ "$an_rec" = 1 ]; then an_l=$qrec; fi
    [ -n "$an_l" ] || continue
    printf '%s' "$qopts" | grep -q "$an_l)" || continue
    case "$qkind:$an_l" in split:b) an_p=$qparam ;; *) an_p=- ;; esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$an_b" "$qid" "$qn" "$qkind" "$an_l" "$an_p" "${an_pick##*/}" >> "$bd/answers.tsv"
    an_n=$((an_n + 1)); echo "batch: $qn ($qid, $qkind): option $an_l recorded from the user's message ${an_pick##*/}"
  done < "$bd/lint.tsv"
  [ "$an_n" -gt 0 ] || die "the user's message ${an_pick##*/} answers no question in a form this script understands (letters after the question number, or 'all recommended'); the unanswered questions are asked again at freeze"
  printf '%s\n' "${an_pick##*/}" >> "$(prompts_dir)/consumed"
}
answers_cmd() { # [ID]
  [ -f "$bd/answers.tsv" ] || { echo "no answers recorded"; return 0; }
  awk -F'\t' -v b="$(bid)" -v t="${1:-}" '$1 == b && (t == "" || $2 == t) { print $3 " " $2 " " $4 ": option " $5 (($6 != "-") ? " (up to " $6 ")" : "") }' "$bd/answers.tsv"
}

# --- status ----------------------------------------------------------------------------------------------------------
status() {
  [ -f "$bd/SUMMARY.md" ] && [ -f "$bd/order.tsv" ] || { echo "no batch planned (agent.sh batch-plan <ID...|all>)"; return 0; }
  printf 'batch %s, approved at %s\n' "$(bid)" "$(approved_at)"
  awake_line
  printf '\n%s | %s | %s | %s | %s | %s\n' task result PR merge 'park reason' 'pending question'
  derive | while IFS="$(printf '\t')" read -r st_id st_s st_d st_q st_p st_t; do
    case "$st_s" in open|waiting) st_s=pending; st_d='' ;; esac
    [ -z "$st_t" ] || st_t=$(fmt_ts "$st_t")
    printf '%s | %s | %s | %s | %s | %s\n' "$st_id" "$st_s" "${st_p:--}" "${st_t:--}" "${st_d:--}" "${st_q:--}"
  done
  printf '\n'
  sh "$here/friction.sh" show 2>/dev/null || echo "no friction report"
  printf '\nresume: answer the open questions (or reopen a run), then run /proofline batch in a session; merged tasks are not run again.\n'
}

# --- the CI of a merge commit ------------------------------------------------------------------------------------------
# ci_once SHA: the CI runs of exactly that commit, once. 0 green, 1 red, 2 still running, 3 unreadable, 4 no run appeared. A red run wins over a
# running one; an older green run never counts.
ci_once() {
  co_j=$(cd "$root" && gh run list --branch "$(cfgv canonical_branch main)" --commit "$1" --limit 30 --json status,conclusion 2>/dev/null) || return 3
  co_v=$(printf '%s' "$co_j" | tr '}' '\n' | awk '/"status"/ { n++; if ($0 !~ /"status":"completed"/) r = 1; else if ($0 !~ /"conclusion":"(success|skipped|neutral)"/) x = 1 }
    END { if (x) print "red"; else if (!n) print "none"; else if (r) print "running"; else print "green" }')
  case "$co_v" in green) return 0 ;; red) return 1 ;; none) return 4 ;; *) return 2 ;; esac
}
ci_record() { printf '%s\t%s\t%s\n' "$1" "$2" "$(date +%s)" >> "$bd/ci.tsv"; }
ci_cmd() { # ID
  cc_id=${1:?usage: batch.sh ci <ID>}
  cc_pr=$(merged_pr "$cc_id") || die "$cc_id is not merged (no record in merged.tsv)"
  if [ "$(sh "$agent" ci-check 2>/dev/null | head -1)" = 'ci: absent' ]; then ci_record "$cc_id" none; echo "ci: not applicable (no CI check runs on pull requests; the merge was verified locally)"; return 0; fi
  cc_pf=$(sh "$here/platform.sh" field platform -C "$root" 2>/dev/null || echo other)
  cc_pe=$(sh "$here/platform.sh" env -C "$root" 2>/dev/null || true)   # a private host (A186)
  case "$cc_pe" in GH_HOST=*) GH_HOST=${cc_pe#GH_HOST=}; export GH_HOST ;; esac
  if [ "$cc_pf" != github ] || ! command -v gh >/dev/null 2>&1; then ci_record "$cc_id" none; echo "ci: not checked here (the CI of a merge commit is read through gh on GitHub; platform $cc_pf): look at it yourself before you go on"; return 0; fi
  cc_sha=$(cd "$root" && gh pr view "$cc_pr" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null) || cc_sha=''
  [ -n "$cc_sha" ] || { echo "ci: cannot read the merge commit of PR $cc_pr ($cc_id)"; return 3; }
  cc_s7=$(printf '%s' "$cc_sha" | cut -c1-7); cc_rc=0; ci_once "$cc_sha" || cc_rc=$?
  case "$cc_rc" in
    0) ci_record "$cc_id" "$cc_sha"; echo "ci: green (run of $cc_s7)" ;;
    1) echo "ci: RED (run of $cc_s7): stop the batch" ;;
    2) echo "ci: still running (run of $cc_s7): ask again in a minute, give up after $(cfgv batch.ci_wait_minutes 30) minutes" ;;
    4) echo "ci: no run for $cc_s7 yet: ask again in a minute, give up after $(cfgv batch.ci_appear_minutes 10) minutes" ;;
    *) echo "ci: cannot be read (gh run list failed)" ;;
  esac
  return "$cc_rc"
}

# --- keep the computer awake (the sleep inhibitor belongs to the session, not to a driver) ---------------------------------
uname_s() { if [ "${PROOFLINE_TEST:-}" = 1 ] && [ -n "${PROOFLINE_UNAME:-}" ]; then printf '%s\n' "$PROOFLINE_UNAME"; else uname -s; fi; }
inhibit_kind() { # caffeinate | systemd-inhibit | none
  if [ "${PROOFLINE_TEST:-}" = 1 ] && [ "${PROOFLINE_BATCH_INHIBIT:-}" = none ]; then echo none; return 0; fi
  case "$(uname_s)" in
    Darwin) if command -v caffeinate >/dev/null 2>&1; then echo caffeinate; else echo none; fi ;;
    Linux) if command -v systemd-inhibit >/dev/null 2>&1; then echo systemd-inhibit; else echo none; fi ;;
    *) echo none ;;
  esac
}
# session_pid: the agent session's own process (claude or codex), found by walking up the parents of this script
session_pid() {
  if [ "${PROOFLINE_TEST:-}" = 1 ] && [ -n "${PROOFLINE_SESSION_PID:-}" ]; then printf '%s\n' "$PROOFLINE_SESSION_PID"; return 0; fi
  sp_p=$$; sp_i=0
  while [ "$sp_i" -lt 12 ]; do
    sp_p=$(ps -o ppid= -p "$sp_p" 2>/dev/null | tr -d ' ') || break
    case "$sp_p" in ''|*[!0-9]*|0|1) break ;; esac
    sp_c=$(ps -o comm= -p "$sp_p" 2>/dev/null | sed 's|.*/||')
    case "$sp_c" in claude|codex) printf '%s\n' "$sp_p"; return 0 ;; esac
    sp_i=$((sp_i + 1))
  done
  return 1
}
awake() {
  aw_k=$(inhibit_kind)
  if [ "$aw_k" = none ]; then echo "sleep inhibitor: none available (no caffeinate or systemd-inhibit); the machine may sleep and stop the batch. $PLUG_LINE"; return 0; fi
  aw_s=$(session_pid) || { echo "could not find the agent session process to tie the sleep inhibitor to; start one yourself in a terminal: $([ "$aw_k" = caffeinate ] && echo 'caffeinate -i' || echo 'systemd-inhibit --what=idle:sleep sleep infinity'). $PLUG_LINE"; return 1; }
  mkdir -p "$bd"
  if [ -f "$bd/awake.pid" ] && [ "$(cat "$bd/awake" 2>/dev/null | sed -n 's/.*(session pid \([0-9]*\)).*/\1/p')" = "$aw_s" ]; then
    aw_o=$(cat "$bd/awake.pid" 2>/dev/null || :); aw_t=$(ps -o stat= -p "$aw_o" 2>/dev/null | tr -d ' ' || :)
    case "$aw_t" in ''|Z*) ;; *) cat "$bd/awake"; echo "$PLUG_LINE"; return 0 ;; esac
  fi
  case "$aw_k" in
    caffeinate) nohup caffeinate -i -w "$aw_s" >/dev/null 2>&1 < /dev/null & aw_txt="sleep inhibitor: caffeinate -i -w $aw_s (session pid $aw_s): the Mac does not idle-sleep while this session lives" ;;
    *) nohup systemd-inhibit --what=idle:sleep --who=proofline --why="night batch is running" sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 5; done' _ "$aw_s" >/dev/null 2>&1 < /dev/null & aw_txt="sleep inhibitor: systemd-inhibit --what=idle:sleep (session pid $aw_s): held while this session lives" ;;
  esac
  echo $! > "$bd/awake.pid"; printf '%s\n' "$aw_txt" > "$bd/awake"
  cat "$bd/awake"; echo "$PLUG_LINE the lid still sleeps most machines when closed."
}
park() { # ID REASON | ID --clear
  pk_id=${1:?usage: batch.sh park <ID> <reason> | park <ID> --clear}; pk_r=${2:?usage: batch.sh park <ID> <reason> | park <ID> --clear}
  [ -f "$bd/order.tsv" ] && awk -F'\t' -v t="$pk_id" '$1 == t { f = 1 } END { exit !f }' "$bd/order.tsv" || die "$pk_id is not in the batch"
  { if [ -f "$bd/state.tsv" ]; then awk -F'\t' -v t="$pk_id" '$1 != t' "$bd/state.tsv"; fi
    [ "$pk_r" = --clear ] || printf '%s\tparked\t%s\t\n' "$pk_id" "$(tsv "$pk_r")"; } > "$bd/state.tsv.tmp" && mv "$bd/state.tsv.tmp" "$bd/state.tsv"
  if [ "$pk_r" = --clear ]; then echo "batch: $pk_id is no longer parked by the lead"; else echo "batch: $pk_id parked: $pk_r"; fi
}

case "${1:-}" in
  plan) shift; plan "$@" ;;
  next) shift; next_report "$@" ;;
  status) status ;;
  answer) answer_cmd ;;
  answers) answers_cmd "${2:-}" ;;
  ci) ci_cmd "${2:-}" ;;
  awake) awake ;;
  park) shift; park "$@" ;;
  run|start|stop) echo "batch: the headless batch driver is gone (removed in 0.0.32): the batch runs in the session. Plan it with /proofline batch <ID...|all>, approve it, and continue an interrupted one with /proofline batch" >&2; exit 2 ;;
  *) echo "usage: batch.sh plan [--replace] <ID...|all> | next [--tsv] | status | ci <ID> | awake | park <ID> <reason>|--clear" >&2; exit 2 ;;
esac
