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
# Placeholders in the table: <ID> the task id, {WORK} the next queued task or a new task, {NEW} the newest task
# file, {Q} the first open question.
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
batch|*|run proofline batch run in a terminal; the morning table is proofline batch status
EOF
}
commands() { table | awk -F'|' '{ n = split($1, a, ","); for (i = 1; i <= n; i++) print a[i] }' | sort -u; }

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

cmd='' id='' err=no kind=''
for a in "$@"; do
  case "$a" in
    --commands) commands; exit 0 ;;
    --error) err=yes ;;
    --error=*) err=yes; kind=${a#--error=} ;;
    *) if [ -z "$cmd" ]; then cmd=$a; elif [ -z "$id" ]; then id=$a; fi ;;
  esac
done
case "$id" in -*|*[!A-Za-z0-9_-]*) id='' ;; esac
[ -n "$cmd" ] || cmd=help
if [ "$err" = no ]; then commands | grep -Fqx -- "$cmd" || { echo "next-user: unknown command: $cmd" >&2; exit 2; }; fi

# the state of the run the command is about
installed=no; { [ -f "$root/.agents/config.yaml" ] && [ -f "$agent" ]; } && installed=yes
state=none; ks=''
if [ "$installed" = yes ]; then
  if [ -z "$id" ]; then
    id=$(sh "$agent" status 2>/dev/null | sed -n 's/^active_task=//p' | head -n 1)
    [ "$id" != none ] || id=''
  fi
  if [ -n "$id" ] && [ -d "$root/.agents/runs/$id" ]; then
    sm=$(sh "$agent" summary "$id" 2>/dev/null | sed -n 's/^STATUS: \([A-Z_a-z]*\) (handoff \([A-Za-z_]*\), knowledge \([A-Za-z_]*\)).*/\1 \2 \3/p')
    st=${sm%% *}; sm=${sm#* }; hs=${sm%% *}; ks=${sm#* }
    state=active
    case "$st:$hs" in
      FAILED:*|BLOCKED:*) state=failed ;;
      *:DONE) state=finished ;;
      CODE_DONE:*) state=codedone ;;
    esac
    if [ "$state" != failed ] && grep -Eq '^  awaiting_input: "?true' "$root/.agents/runs/$id/RUN.yaml" 2>/dev/null; then state=question; fi
  fi
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
  case "$text" in *'{Q}'*) text=$(sub "$text" '{Q}' "$(question)") ;; esac
  text=$(sub "$text" '<ID>' "${id:-<TASK-ID>}")
fi
printf 'Next step: %s\n' "$text"
