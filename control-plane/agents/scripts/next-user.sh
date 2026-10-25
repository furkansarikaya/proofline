#!/bin/sh
# The user's next step (A159): the ONE table from (command, project or run state) to the line that ends every
# /proofline command. Run through `agent.sh next-user`; read-only; any role may call it. Never prints an
# internal command: the suggestion is a `/proofline ...` or `proofline ...` command, or an action the user does.
#
#   next-user.sh [<command> [<ID>]] [--error[=<kind>]]   one line, "Next step: ..."
#   next-user.sh --commands                              every command of the table, one per line
#
# <command> is a command of `proofline help` (without the leading slash). <ID> is the task the command named.
# Without <ID> the active run decides. Run state seen by the table: none (no run), active, question (a question
# waits for the user), codedone, finished (handoff DONE) and failed (FAILED or BLOCKED).
# --error: the command failed; the suggestion is the command that fixes it. <kind> is not-installed, dirty-tree,
# knowledge, failed-run, doctor or usage; without it the kind is read from the state.
# `batch`, `batch status` and `batch stop` (A163) read the batch folder (.agents/local/batch) instead of a run. States: nobatch, unapproved, running (the driver is alive), approved, stopped,
# finished-parked and finished-clean. `deliver` for a run that still exists is also delivered (cleanup approval consumed), or merge-open (deliver/<ID>/PR
# holds the pull request number: the merge step started), read from the delivery records. No CI is not a state (A180): it is a
# warning in the summary, and proofline merge verifies the commit locally instead.
# Placeholders in the table: <ID> the task id, {WORK} the next queued task or a new task, {NEW} the newest task
# file, {Q} the first open question,
# {LOG} the driver log, {PARKED} what to do with the first parked task of the batch.
set -u
root=${PROOFLINE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
agent=$root/.agents/scripts/agent.sh

# command[,command...] | state[,state...] or * | suggestion; the first matching row wins
table() {
  cat <<'EOF'
init|*|/proofline doctor
doctor|*|/proofline task --grill
upgrade|*|commit the changed files yourself, then run /proofline doctor
version|*|/proofline doctor
task|*|{NEW}
design|*|{WORK}
status,resume,queue,run|question|reply in this session to the open question: {Q}
status,resume,queue,run|codedone,finished|/proofline deliver <ID>
status,resume,queue,run|failed|/proofline reopen <ID>
status,resume,queue,run|active|/proofline resume
status,resume,queue,run|none|{WORK}
deliver|delivered|{WORK}
deliver|merge-open|proofline merge {PR}
deliver|question|reply in this session to the open question: {Q}
deliver|codedone,finished|reply "approve delivery" in this session to deliver <ID>
deliver|failed|/proofline reopen <ID>
deliver|active|/proofline resume
deliver|none|{WORK}
knowledge|failed|/proofline reopen <ID>
knowledge|*|/proofline deliver <ID>
reopen|*|/proofline resume
merge|*|{WORK}
clean|*|{WORK}
debt|*|/proofline task --grill
review|*|/proofline task --grill
audit|*|/proofline task --grill
debug|*|/proofline task --grill
insights|*|/proofline status
explain|*|/proofline status
docs|*|/proofline docs audit
wiki|*|/proofline wiki lint
batch|nobatch|{WORK}
batch|unapproved|reply "approve batch" in this session to start the batch
batch|running|driver started, log: {LOG}. In the morning: /proofline batch status
batch|approved,stopped|run proofline batch run in a terminal to start the batch; merged tasks are not run again
batch|finished-parked,finished-clean|/proofline batch status
batch-status|nobatch,finished-clean|{WORK}
batch-status|unapproved|reply "approve batch" in this session to start the batch
batch-status|running|wait for the driver to finish, then run /proofline batch status again
batch-status|approved,stopped|run proofline batch run in a terminal to resume the batch; merged tasks are not run again
batch-status|finished-parked|{PARKED}
batch-stop|*|/proofline batch status
product-prd|*|/proofline product review <SLUG>
product-review|dnship|/proofline product prd <SLUG> to revise the PRD, then /proofline product review <SLUG> again
product-review|dnship2|/proofline product prd <SLUG> if you revise the PRD (both review rounds are used, so what happens next is your call)
product-review|*|/proofline product split <SLUG>
product-split|*|{NEW}
product-discover-frame|*|/proofline product discover research <SLUG>
product-discover-research|*|/proofline product discover interviews <SLUG>
product-discover-interviews|*|/proofline product discover competitors <SLUG>
product-discover-competitors|*|/proofline product discover opportunities <SLUG>
product-discover-opportunities|*|/proofline product assess assumptions <SLUG>
product-assess-assumptions|*|/proofline product assess probes <SLUG>
product-assess-probes|*|/proofline product assess premortem <SLUG>
product-assess-premortem|*|/proofline product assess redteam <SLUG>
product-assess-redteam|*|/proofline product assess decision <SLUG>
product-assess-decision|stop|/proofline product discover frame <SLUG> to frame a different problem (the decision is stop, so no PRD is split)
product-assess-decision|clarify|/proofline product discover research <SLUG> to close what is unclear, then /proofline product assess decision <SLUG> again
product-assess-decision|*|/proofline product prd <SLUG>
product-outcome|*|/proofline status
trace|*|/proofline status
EOF
}
table_names() { table | awk -F'|' '{ n = split($1, a, ","); for (i = 1; i <= n; i++) print a[i] }' | sort -u; }
# the commands of `proofline help`; batch-status and batch-stop are the table's names for `batch status` and `batch stop`
commands() { table_names | grep -v '^batch-' | sed 's/^product-.*/product/' | sort -u; }

# sub TEXT FROM TO: TEXT with every FROM replaced by TO
sub() {
  s=$1; o=''
  while :; do case "$s" in *"$2"*) o=$o${s%%"$2"*}$3; s=${s#*"$2"} ;; *) break ;; esac; done
  printf '%s%s' "$o" "$s"
}
tasks_dir() {
  td=$(awk '/^tasks:/ { i = 1; next } /^[^[:space:]#]/ { i = 0 } i && $1 == "dir:" { gsub(/"/, "", $2); print $2; exit }' "$root/.agents/config.yaml" 2>/dev/null)
  td=${td%/}; [ -n "$td" ] || td=.agents/tasks
  printf '%s\n' "$root/$td"
}
# task_id FILE: the id prefix of a task file (TASK-002-title.md -> TASK-002), else its name without .md
task_id() {
  b=$(basename "$1" .md); p=$(printf '%s' "$b" | sed -n 's/^\([A-Za-z][A-Za-z]*-[0-9][0-9]*\).*/\1/p')
  printf '%s\n' "${p:-$b}"
}
# queued: ids of the task files without a run, todo/ before backlog/, then file order
queued() {
  td=$(tasks_dir)
  for f in "$td"/todo/*.md "$td"/backlog/*.md "$td"/*.md; do
    [ -f "$f" ] || continue
    q=$(task_id "$f"); [ ! -d "$root/.agents/runs/$q" ] || continue
    [ ! -d "$root/.agents/local/worktrees/$q/.agents/runs/$q" ] || continue   # A169: its run lives in a worktree of its own
    printf '%s\n' "$q"
  done
}
newest_task() {
  td=$(tasks_dir); set --
  for f in "$td"/todo/*.md "$td"/backlog/*.md "$td"/*.md; do
    [ -f "$f" ] || continue
    set -- "$@" "$f"
  done
  [ $# -gt 0 ] || return 0
  nf=$(ls -t -- "$@" | head -n 1)
  [ -z "$nf" ] || task_id "$nf"
}
work() {
  w=$(queued | head -n 1)
  if [ -n "$w" ]; then printf '/proofline run %s' "$w"; else printf '/proofline task --grill'; fi
}
question() {
  q=$(sh "$agent" questions "$id" 2>/dev/null | sed '/^===/d; /^[[:space:]]*$/d' | head -n 1 | tr -d '`' | cut -c1-120)
  printf '%s' "${q:-see the question above}"
}

cmd='' id='' id2='' id3='' err=no kind=''
for a in "$@"; do
  case "$a" in
    --commands) commands; exit 0 ;;
    --error) err=yes ;;
    --error=*) err=yes; kind=${a#--error=} ;;
    *) if [ -z "$cmd" ]; then cmd=$a; elif [ -z "$id" ]; then id=$a; elif [ -z "$id2" ]; then id2=$a; elif [ -z "$id3" ]; then id3=$a; fi ;;
  esac
done
case "$id" in -*|*[!A-Za-z0-9_-]*) id='' ;; esac
[ -n "$cmd" ] || cmd=help
if [ "$cmd" = batch ]; then case "$id" in status|stop) cmd=batch-$id; id='' ;; run) id='' ;; esac; fi
if [ "$cmd" = product ]; then case "$id" in prd|review|split|outcome) cmd=product-$id; id=$id2; case "$id" in -*|*[!A-Za-z0-9_-]*) id='' ;; esac ;; discover|assess) case "$id2" in ''|-*|*[!a-z]*) cmd=product-prd; id='' ;; *) cmd=product-$id-$id2; id=$id3; case "$id" in -*|*[!A-Za-z0-9_-]*) id='' ;; esac ;; esac ;;
  *) cmd=product-prd; id='' ;; esac; fi
if [ "$err" = no ]; then table_names | grep -Fqx -- "$cmd" || { echo "next-user: unknown command: $cmd" >&2; exit 2; }; fi

# the state of the run the command is about
installed=no; { [ -f "$root/.agents/config.yaml" ] && [ -f "$agent" ]; } && installed=yes
state=none; ks=''
bd=$root/.agents/local/batch
# run_state ID: state and ks of the run ID (none when it has no run)
# A169: a night-mode task's run lives in .agents/local/worktrees/<ID>; agent.sh forwards the commands for it there, and inwt marks it
run_state() {
  state=none; ks=''; inwt=''; rs_r=$root
  if [ -n "$1" ] && [ ! -d "$root/.agents/runs/$1" ] && [ -d "$root/.agents/local/worktrees/$1/.agents/runs/$1" ]; then rs_r=$root/.agents/local/worktrees/$1; inwt=yes; fi
  if [ -n "$1" ] && [ -d "$rs_r/.agents/runs/$1" ]; then
    sm=$(sh "$agent" summary "$1" --status 2>/dev/null | sed -n 's/^STATUS: \([A-Z_a-z]*\) (handoff \([A-Za-z_]*\), knowledge \([A-Za-z_]*\)).*/\1 \2 \3/p')
    st=${sm%% *}; sm=${sm#* }; hs=${sm%% *}; ks=${sm#* }
    state=active
    case "$st:$hs" in
      FAILED:*|BLOCKED:*) state=failed ;;
      *:DONE) state=finished ;;
      CODE_DONE:*) state=codedone ;;
    esac
    if [ "$state" != failed ] && grep -Eq '^  awaiting_input: "?true' "$rs_r/.agents/runs/$1/RUN.yaml" 2>/dev/null; then state=question; fi
  fi
}
# drv_alive: the recorded driver is alive, holds the LOCK and is a batch.sh process (as batch.sh drv_live)
drv_alive() {
  dp=$(awk 'NR == 1 { print $1 }' "$bd/driver.pid" 2>/dev/null)
  case "$dp" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ "$(cat "$bd/LOCK" 2>/dev/null)" = "$dp" ] || return 1
  ps -o command= -p "$dp" 2>/dev/null | grep -q 'batch\.sh'
}
batch_state() {
  if drv_alive; then echo running; return; fi
  bs=nobatch
  if [ -f "$bd/SUMMARY.md" ]; then
    if ! sh "$agent" batch-check >/dev/null 2>&1; then bs=unapproved
    elif [ ! -f "$bd/state.tsv" ]; then bs=approved
    elif grep -q '^# stopped:' "$bd/state.tsv"; then bs=stopped
    elif awk -F'\t' '$2 == "pending" || $2 == "running" { f = 1 } END { exit !f }' "$bd/state.tsv"; then bs=approved
    elif awk -F'\t' '$2 == "parked" { f = 1 } END { exit !f }' "$bd/state.tsv"; then bs=finished-parked
    else bs=finished-clean; fi
  fi
  echo "$bs"
}
# parked_line: what to do with the first parked task of the batch (its full id; the question text when it waits for one)
parked_line() {
  pk=$(awk -F'\t' '$2 == "parked" { print $1; exit }' "$bd/state.tsv" 2>/dev/null)
  [ -n "$pk" ] || { work; return; }
  id=$pk; run_state "$id"
  if [ "$inwt" = yes ]; then   # A169: the run is in its task's worktree: answer or reopen from here (forwarded), the driver resumes it
    case "$state" in
      question)
        q=$(question); [ "$q" != 'see the question above' ] || q=$(awk -F'\t' -v t="$id" '$1 == t && $4 != "" { print $4; exit }' "$bd/state.tsv" | tr -d '`' | cut -c1-120)
        printf 'reply in this session to the open question: %s, then run proofline batch run' "${q:-see the question above}" ;;
      failed) printf '/proofline reopen %s, then run proofline batch run' "$id" ;;
      *) printf 'run proofline batch run: it resumes %s in its worktree' "$id" ;;
    esac
    return 0
  fi
  case "$state" in
    none) printf '/proofline run %s' "$id" ;;
    question)
      q=$(question)
      [ "$q" != 'see the question above' ] || q=$(awk -F'\t' -v t="$id" '$1 == t && $4 != "" { print $4; exit }' "$bd/state.tsv" | tr -d '`' | cut -c1-120)
      printf '/proofline resume %s, then reply in this session to the open question: %s' "$id" "${q:-see the question above}" ;;
    failed) printf '/proofline reopen %s' "$id" ;;
    codedone|finished) printf '/proofline deliver %s' "$id" ;;
    *) printf '/proofline resume %s' "$id" ;;
  esac
}
if [ "$installed" = yes ]; then
  case "$cmd" in
    batch|batch-status|batch-stop) state=$(batch_state) ;;
    product-*)
      # product-review: the verdict line of <product.dir>/<slug>/REVIEW.md (do-not-ship asks for a revised PRD)
      pd=$(awk '/^product:/ { i = 1; next } /^[^[:space:]#]/ { i = 0 } i && $1 == "dir:" { gsub(/"/, "", $2); print $2; exit }' "$root/.agents/config.yaml" 2>/dev/null); pd=${pd%/}
      state=none
      rf=$root/${pd:-docs/product}/$id/REVIEW.md
      if [ "$cmd" = product-assess-decision ] && [ -n "$id" ]; then
        state=$(grep -E '^decision:[[:space:]]*(build|clarify|stop)[[:space:]]*$' "$root/${pd:-docs/product}/$id/DECISION.md" 2>/dev/null | tail -n 1 | sed 's/^decision:[[:space:]]*//; s/[[:space:]]*$//'); [ -n "$state" ] || state=none
      fi
      if [ "$cmd" = product-review ] && [ -n "$id" ] && grep -qs '^verdict:[[:space:]]*do-not-ship' "$rf"; then
        state=dnship; grep -qs '^round:[[:space:]]*[2-9]' "$rf" && state=dnship2
      fi ;;
    *)
      if [ -z "$id" ]; then
        id=$(sh "$agent" status 2>/dev/null | sed -n 's/^active_task=//p' | head -n 1)
        [ "$id" != none ] || id=''
      fi
      run_state "$id"
      if [ "$err" = no ] && [ "$cmd" = deliver ] && { [ "$state" = codedone ] || [ "$state" = finished ]; }; then
        # the delivery's own records (no gh): a consumed cleanup approval means it is delivered; deliver/<ID>/PR is written
        # when the merge step started, so a run that still exists then stopped at the merge (a check is red, or it was refused)
        pr=$(cat "$root/.agents/local/deliver/$id/PR" 2>/dev/null)
        case "$pr" in ''|*[!0-9]*) pr='' ;; esac
        if grep -qs '^consumed: "\{0,1\}true' "$root/.agents/runs/$id"/approvals/[0-9][0-9][0-9]-cleanup.yaml; then state=delivered
        elif [ -n "$pr" ]; then state=merge-open; fi
      fi ;;
  esac
fi

if [ "$err" = yes ]; then
  if [ -z "$kind" ]; then
    if [ "$installed" = no ]; then kind=not-installed
    elif [ "$state" = failed ]; then kind=failed-run
    elif [ "$state" = codedone ] && [ "$ks" != KNOWLEDGE_DONE ] && [ "$ks" != not_applicable ]; then kind=knowledge
    elif [ "$cmd" = doctor ]; then kind=doctor
    fi
  fi
  case "$kind" in
    not-installed) text='proofline init' ;;
    usage) text='proofline help' ;;
    dirty-tree) text="commit or stash your changes yourself, then run /proofline $cmd${id:+ $id} again" ;;
    knowledge) text="/proofline knowledge ${id:-<TASK-ID>}" ;;
    failed-run) text="/proofline reopen ${id:-<TASK-ID>}" ;;
    doctor) text='fix what /proofline doctor reported (each failed check names its fix), then run /proofline doctor again' ;;
    *) text='/proofline status' ;;
  esac
else
  text=$(table | awk -F'|' -v c="$cmd" -v s="$state" '
    function has(list, w,   a, n, i) { n = split(list, a, ","); for (i = 1; i <= n; i++) if (a[i] == w || a[i] == "*") return 1; return 0 }
    has($1, c) && has($2, s) { print $3; exit }')
  case "$text" in
    *'{WORK}'*) text=$(sub "$text" '{WORK}' "$(work)") ;;
  esac
  case "$text" in
    *'{NEW}'*) n=$(newest_task); if [ -n "$n" ]; then n="/proofline run $n"; else n='/proofline task --grill'; fi; text=$(sub "$text" '{NEW}' "$n") ;;
  esac
  case "$text" in *'{PR}'*) text=$(sub "$text" '{PR}' "$pr") ;; esac
  case "$text" in *'{LOG}'*) text=$(sub "$text" '{LOG}' '.agents/local/batch/driver.log') ;; esac
  case "$text" in *'{PARKED}'*) text=$(parked_line) ;; esac
  case "$text" in *'{Q}'*) text=$(sub "$text" '{Q}' "$(question)") ;; esac
  case "$cmd" in product-*) text=$(sub "$text" '<SLUG>' "${id:-<slug>}") ;; esac
  text=$(sub "$text" '<ID>' "${id:-<TASK-ID>}")
fi
printf 'Next step: %s\n' "$text"
