#!/bin/sh
# Platform-independent specialist runner (D6, D7, D8). Runs ONE specialist step headless on the runtime
# the execution policy resolves. The specialist reports through `agent.sh submit` (the script builds the
# header, fingerprint and hashes and records the result); dispatch.sh reads the submission status and never
# parses the final message.
#
#   dispatch.sh <TASK-ID> <role> [--focus F] [--prompt-file F] [--model M] [--effort E] [--runtime RT]
#
# 1 decision: `agent.sh decide <ID> <role> [--focus F] [--model M] [--effort E] [--runtime RT]`
#   (key=value lines incl. runtime, model, effort, context_bytes). Nothing here re-decides them.
# 2 prompt: stable prefix = the role's instructions (role_instructions), then the task-specific suffix
#   (header + --prompt-file), which must fit the decision's context_bytes (never truncated).
# 3 run: codex `exec` (`-s workspace-write`, `--add-dir` the run folder and .agents/local), claude `-p` running the
#   generated agent (`--agent proofline-<role>` from .claude/agents/, else `--agents` JSON built from
#   .agents/roles/<role>.md and .agents/tools.conf; never the Agent/Task tools), or config
#   dispatch.command_template.<runtime> (D8), with a timeout (config dispatch.timeout_seconds, default 1800,
#   minimum 30). The implementer, and the designer while handoff is IMPLEMENTING, are bracketed by
#   `agent.sh window-open` / `window-close`; every other role must leave the product tree unchanged. A change
#   to .git/config (e.g. core.hooksPath) or to HEAD during the step is BLOCKED for every role.
# 4 the last message is saved as dispatch/<NNN>-<role>-<runtime>.md in the run (a log, never parsed; results/ holds recorded results only);
#   the runtime gets PROOFLINE_AGENT (a per-attempt token) and PROOFLINE_FOCUS in its environment, so its
#   `agent.sh submit` writes .agents/local/submissions/<token>.status. No valid submission: the step is run
#   once more with the rejection in its prompt, then BLOCKED. The raw runtime log goes to dispatch/.
#   While a step runs, dispatch/<NNN>-<role>-<runtime>.running says so (A124); a worker that wrote nothing is BLOCKED
#   with a reason and a non-empty log. An implementer prompt states that its window is already open (A124).
# Failover (D7) on a runtime failure (limit/quota/rate limit/429, missing binary, auth error), never on a
#   task failure: config `failover: auto` reruns the same step from its beginning on the other runtime
#   when it is installed and meets the role's capability floor (ledgered via `agent.sh ledger-note`);
#   `ask` stores a pending question through `agent.sh ask` (awaiting_input, ledgered; `agent.sh questions` shows
#   it and `next` stops for the user) and prints it as NEEDS_INPUT; `off`, floor unmet or no other runtime ->
#   BLOCKED.
# Claude workers get `--permission-mode` from config dispatch.claude_permission_mode (default
#   bypassPermissions; acceptEdits|default accepted): headless, they cannot be prompted, and the PreToolUse hook is the
#   confinement. bypassPermissions is refused (BLOCKED) when that hook is not wired in .claude/settings.json (A114).
# Codex runs with --dangerously-bypass-hook-trust: a headless `codex exec` never asks to trust the project's
#   hooks, so without it the proofline hooks (.codex/) would not load for the worker. The fingerprint and
#   .git/config/HEAD checks below stay the enforcement; the hooks are an extra layer (ENFORCEMENT.md).
# Exit: 0 recorded | 1 task failure or record rejected | 2 usage/config | 5 NEEDS_INPUT | 6 BLOCKED |
#   124 timeout.
# Runtime binaries: PROOFLINE_CODEX_BIN, PROOFLINE_CLAUDE_BIN (tests use fake runtimes).
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
config=$root/.agents/config.yaml
agent=$here/agent.sh

usage() { echo "usage: $0 <TASK-ID> <role> [--focus F] [--prompt-file F] [--model M] [--effort E] [--runtime RT]" >&2; exit 2; }
die() { echo "dispatch: $*" >&2; exit 2; }
tok() { case "$2" in ''|*[!A-Za-z0-9._+:-]*|-*) die "invalid value for $1: '$2'" ;; esac; }

[ $# -ge 2 ] || usage
id=$1 role=$2; shift 2
tok task-id "$id"; tok role "$role"
case "$role" in
  full_lifecycle) role=lead ;; implementation_worker) role=implementer ;; independent_reviewer) role=reviewer ;;
  independent_qa) role=qa ;; independent_verifier) role=verifier ;;
esac
focus='' prompt_file='' o_model='' o_effort='' o_runtime=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --focus) tok "$1" "$2"; focus=$2 ;; --prompt-file) prompt_file=$2 ;;
    --model) tok "$1" "$2"; o_model=$2 ;; --effort) tok "$1" "$2"; o_effort=$2 ;; --runtime) tok "$1" "$2"; o_runtime=$2 ;;
    *) usage ;;
  esac
  shift 2
done
[ -z "$prompt_file" ] || [ -f "$prompt_file" ] || die "no such prompt file: $prompt_file"
run=$root/.agents/runs/$id
[ -d "$run" ] || die "no such run: $id"
[ -f "$agent" ] || die "agent.sh not found next to dispatch.sh"

cfg() { # KEY... -> scalar from the flat YAML config (empty when absent)
  [ -f "$config" ] || return 0
  awk -v want="$*" '
    /^[[:space:]]*(#|$)/ { next }
    { ind = match($0, /[^ ]/) - 1; d = int(ind / 2); line = substr($0, ind + 1)
      if (index(line, ":") == 0) next
      key = line; sub(/:.*/, "", key); val = line; sub(/^[^:]*:[[:space:]]*/, "", val); sub(/[[:space:]]+#.*$/, "", val)
      if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
      for (i = d + 1; i < 32; i++) delete st[i]
      st[d] = key; p = st[0]; for (i = 1; i <= d; i++) p = p " " st[i]
      if (p == want) { print val; exit } }' "$config"
}
note() { "$agent" ledger-note "$id" "$*" >/dev/null; }
blocked() { # REASON : result-protocol block on stdout, ledgered, exit 6
  printf 'ROLE: %s\nTASK: %s\nRESULT: BLOCKED\nBLOCKED_REASON: %s\n' "$role" "$id" "$1"
  note "dispatch blocked role=$role reason=$1" || true
  exit 6
}
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
subst() { # TEMPLATE NAME VALUE : replace every {NAME}
  s_t=$1 s_o=''
  while :; do case "$s_t" in *"{$2}"*) s_o="$s_o${s_t%%"{$2}"*}$3"; s_t=${s_t#*"{$2}"} ;; *) break ;; esac; done
  printf '%s' "$s_o$s_t"
}

agent_name() { printf 'proofline-%s\n' "$(printf '%s' "$1" | tr _ -)"; }
# The role's stable instructions: the one place that knows where they live.
role_instructions() {
  for ri in "$root/.agents/roles/$1.md" "$root/.claude/agents/$(agent_name "$1").md" "$root/.codex/agents/$(agent_name "$1").toml"; do
    [ -f "$ri" ] && { printf '%s\n' "$ri"; return 0; }
  done
  return 1
}

# Tools that spawn agents: never granted to a dispatched role (no recursion).
spawn_tool() { printf '%s\n' "$1" | tr -s ', ' '\n' | grep -Eq '^(Agent|Task)([(]|$)'; }
json_str() { awk 'BEGIN { ORS = ""; printf "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if (NR > 1) printf "\\n"; printf "%s", $0 } END { printf "\"" }'; }
# --agents JSON for a role without a generated .claude agent: instructions + tools.conf list (minus Agent/Task).
agents_json() { # NAME INSTRUCTIONS-FILE ROLE
  aj_t=''
  for aj_c in "$root/.agents/tools.conf" "$root/.agents/roles/tools.conf"; do
    [ -f "$aj_c" ] || continue; aj_t=$(awk -v r="$3" '$1 == r { $1 = ""; print; exit }' "$aj_c"); break
  done
  [ -n "$(printf '%s' "$aj_t" | tr -d ' ,')" ] || aj_t='Read,Grep,Glob,Bash,Write,Edit'
  aj_l=''
  for aj_x in $(printf '%s' "$aj_t" | tr ',' ' '); do spawn_tool "$aj_x" || aj_l="$aj_l${aj_l:+,}$(printf '%s' "$aj_x" | json_str)"; done
  printf '{"%s":{"description":%s,"prompt":%s,"tools":[%s]}}' "$1" "$(printf 'proofline %s' "$3" | json_str)" "$(json_str < "$2")" "$aj_l"
}
# .git/config and HEAD: a dispatched step must change neither (hooksPath, branch, commits).
git_state() {
  gs_c=$(git -C "$root" rev-parse --git-path config 2>/dev/null) || { echo none; return 0; }
  case "$gs_c" in /*) ;; *) gs_c=$root/$gs_c ;; esac
  printf '%s|%s|%s\n' "$(cksum < "$gs_c" 2>/dev/null || echo none)" "$(git -C "$root" symbolic-ref -q HEAD 2>/dev/null || echo detached)" "$(git -C "$root" rev-parse -q --verify HEAD 2>/dev/null || echo none)"
}
handoff_state() { awk '$0 == "handoff:" { i = 1; next } i && /^[^ ]/ { exit } i && /^  state:/ { sub(/^  state:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' "$run/RUN.yaml" 2>/dev/null; }

timeout_s=$(cfg dispatch timeout_seconds); case "$timeout_s" in ''|*[!0-9]*) timeout_s=1800 ;; esac
# PROOFLINE_DISPATCH_MIN_TIMEOUT exists for the test suite only.
min_t=${PROOFLINE_DISPATCH_MIN_TIMEOUT:-30}; [ "$timeout_s" -ge "$min_t" ] || timeout_s=$min_t

# run_timed SECONDS LOG IN CMD... : CMD < IN > LOG 2>&1 with a portable watchdog. 124 on timeout.
run_timed() {
  rt_s=$1 rt_log=$2 rt_in=$3; shift 3
  rt_mark=$(mktemp "${TMPDIR:-/tmp}/dispatch-timeout.XXXXXX"); rm -f "$rt_mark"
  "$@" < "$rt_in" > "$rt_log" 2>&1 &
  rt_pid=$!
  (
    trap 'kill "$rt_sp" 2>/dev/null; exit 0' TERM
    sleep "$rt_s" & rt_sp=$!; wait "$rt_sp"
    : > "$rt_mark"; kill -TERM "$rt_pid" 2>/dev/null; (sleep 5; kill -KILL "$rt_pid") >/dev/null 2>&1 &
  ) &
  rt_wd=$!
  rt_rc=0; wait "$rt_pid" || rt_rc=$?
  kill -TERM "$rt_wd" 2>/dev/null || true; wait "$rt_wd" 2>/dev/null || true
  if [ -f "$rt_mark" ]; then rm -f "$rt_mark"; return 124; fi
  return "$rt_rc"
}

# Runtime failure (D7: the runtime could not do the step) vs task failure (it ran and failed).
runtime_failure_reason() { # LOG
  tail -n 60 "$1" 2>/dev/null | grep -Eiq 'error sending request|workspace routing discovery failed|Reconnecting\.\.\. 5/5' && { echo runtime_unavailable:network; return; }
  tail -n 60 "$1" 2>/dev/null | grep -Eiq 'usage limit|rate[ _-]?limit|quota|too many requests|(^|[^0-9])429([^0-9]|$)|limit (reached|exceeded)|hit your limit|overloaded' && { echo limit; return; }
  tail -n 60 "$1" 2>/dev/null | grep -Eiq 'not logged in|unauthori[sz]ed|authentication (failed|error|required)|invalid api key|please (run )?.*login|(^|[^0-9])401([^0-9]|$)' && { echo auth; return; }
  echo none
}

# The proofline PreToolUse hook is the confinement of a bypassPermissions worker (A114): the script must be
# present, non-empty and parse, and .claude/settings.json must wire it under PreToolUse (same logic as doctor).
pre_tool_hook_wired() {
  ph=$root/.agents/hooks/proofline-hook.sh; pj=$root/.claude/settings.json
  [ -s "$ph" ] && sh -n "$ph" 2>/dev/null && [ -f "$pj" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e '[(.hooks.PreToolUse // [])[] | (.hooks // [])[] | .command // ""] | any(contains("proofline-hook.sh"))' "$pj" >/dev/null 2>&1
  elif command -v node >/dev/null 2>&1; then
    node -e 'try { const g = (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks || {}).PreToolUse || [];
      process.exit(g.some((x) => (x.hooks || []).some((h) => String(h.command).includes("proofline-hook.sh"))) ? 0 : 1) } catch (e) { process.exit(1) }' "$pj"
  else return 1; fi # shortcut: no JSON tool means refuse (fail closed), install jq or node
}

# Extract the top-level "result" string of claude's --output-format json, unescaped.
claude_result() {
  awk 'BEGIN { RS = "\001" } {
    i = index($0, "\"result\":\""); if (!i) exit 1
    s = substr($0, i + 10); o = ""
    while (length(s) > 0) {
      c = substr(s, 1, 1)
      if (c == "\"") break
      if (c == "\\") { n = substr(s, 2, 1); s = substr(s, 3)
        if (n == "n") o = o "\n"; else if (n == "t") o = o "\t"; else if (n == "r") o = o "\r"
        else if (n == "u") { o = o "\\u" substr(s, 1, 4); s = substr(s, 5) } else o = o n
        continue }
      o = o c; s = substr(s, 2)
    }
    printf "%s\n", o }' "$1"
}

retry_note=''
subdir=$root/.agents/local/submissions
seq_n=$(find "$run/dispatch" -name '*.log' 2>/dev/null | wc -l | tr -d ' '); seq_n=$((seq_n + 1))
mkdir -p "$run/results" "$run/dispatch"
work=$(mktemp -d "${TMPDIR:-/tmp}/dispatch.XXXXXX")

# Metrics (A80): one `agent.sh metrics-dispatch` record per dispatch, written on every exit after the first attempt starts (usage errors before it write none). Duration is this
# script's own clock; tokens and turns are read from the runtime's structured output trailer (claude --output-format
# json: usage.input_tokens/output_tokens, num_turns; codex exec: its "tokens used" trailer). Absent = empty = null,
# never estimated. `metrics: off` is honoured by agent.sh. Never changes the exit status.
t0=$(date +%s); attempts=0 running='' noout=no m_in='' m_out='' m_tot='' m_turns=''
num_last() { grep -o "\"$1\":[[:space:]]*[0-9][0-9]*" "$log" 2>/dev/null | tail -n 1 | tr -cd '0-9'; }
num_first() { grep -o "\"$1\":[[:space:]]*[0-9][0-9]*" "$log" 2>/dev/null | head -n 1 | tr -cd '0-9'; }
add_n() { # VALUE ACCUMULATOR-VALUE : sum when VALUE is a number, else keep the accumulator
  case "$1" in ''|*[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$(( ${2:-0} + $1 ))" ;; esac
}
harvest() { # after one attempt: add what the runtime reported
  [ -z "$tmpl" ] && [ -f "$log" ] || return 0
  case "$rt" in
    claude)
      m_in=$(add_n "$(num_last input_tokens)" "$m_in"); m_out=$(add_n "$(num_last output_tokens)" "$m_out")
      m_turns=$(add_n "$(num_first num_turns)" "$m_turns") ;;
    codex)
      m_tot=$(add_n "$(grep -v "^[[:space:]]*$" "$log" 2>/dev/null | tail -n 3 | awk 'f { s = $0; gsub(/[^0-9]/, "", s); if (s != "") v = s; f = 0 }
        tolower($0) ~ /tokens used/ { s = $0; sub(/.*[Uu]sed/, "", s); gsub(/[^0-9]/, "", s); if (s != "") v = s; else f = 1 }
        END { print v }')" "$m_tot") ;;
  esac
}
finish() {
  fin_rc=$?
  if [ "$attempts" -gt 0 ]; then
    case "$fin_rc" in 0) fin_res=submitted ;; 124) fin_res=timeout ;; 5) fin_res=needs_input ;; 6) fin_res=blocked ;; *) fin_res=failed ;; esac
    # the claude runtime reports input and output; the total is their sum only when both were reported
    fin_tot=$m_tot; [ -n "$fin_tot" ] || { [ -z "$m_in" ] || [ -z "$m_out" ] || fin_tot=$((m_in + m_out)); }
    "$agent" metrics-dispatch "$id" "$role" "$focus" "${rt:-}" "${model:-}" "$(( $(date +%s) - t0 ))" "$m_in" "$m_out" "$fin_tot" "$m_turns" "$((attempts - 1))" "$fin_res" >/dev/null 2>&1 || true
  fi
  [ -z "$running" ] || rm -f "$running"
  rm -rf "$work"
}
trap finish EXIT

# attempt RUNTIME-OVERRIDE : sets $status (0 ok, 124 timeout, other failure), $rt, $out, $log
attempt() {
  attempts=$((attempts + 1)) noout=no
  # Every role writes its owned artifacts in the run dir; only the implementer, and the designer during
  # IMPLEMENTING, may touch the product tree, inside an attested window.
  writes_code=no; case "$role" in implementer) writes_code=yes ;; designer) [ "$(handoff_state)" != IMPLEMENTING ] || writes_code=yes ;; esac
  set --
  [ -n "$focus" ] && set -- "$@" --focus "$focus"
  [ -n "$o_model" ] && set -- "$@" --model "$o_model"
  [ -n "$o_effort" ] && set -- "$@" --effort "$o_effort"
  [ -n "$a_runtime" ] && set -- "$@" --runtime "$a_runtime"
  d_rc=0; decision=$("$agent" decide "$id" "$role" "$@" 2>"$work/decide.err") || d_rc=$?
  if [ "$d_rc" -ne 0 ]; then
    cat "$work/decide.err" >&2
    [ "$d_rc" -eq 4 ] && blocked "no decision for $role on ${a_runtime:-the configured runtime}: capability floor unmet or unresolvable"
    echo "dispatch: no execution decision for $id $role (exit $d_rc)" >&2; exit 1
  fi
  dv() { printf '%s\n' "$decision" | sed -n "s/^$1=//p" | head -1; }
  rt=$(dv runtime) model=$(dv model) effort=$(dv effort) budget=$(dv context_bytes)
  tok runtime "$rt"; tok model "$model"; tok effort "$effort"
  case "$budget" in ''|*[!0-9]*) die "decision has no context_bytes" ;; esac

  ins=$(role_instructions "$role") || die "no instructions for role $role (.agents/roles/$role.md, .claude/agents/proofline-$role.md or .codex/agents/proofline-$role.toml)"
  { printf 'TASK: %s\nROLE: %s\n' "$id" "$role"; [ -z "$focus" ] || printf 'FOCUS: %s\n' "$focus"
    printf 'RUN_DIR: .agents/runs/%s\nReport your result with: AGENT_ROLE=%s sh .agents/scripts/agent.sh submit %s --confidence <high|medium|low> [--focus F] [--artifact <path of your report>] [--findings FILE|none] [--report FILE|-] [--reason T] [--questions FILE]\nOnly one of --report/--findings may read stdin (-): use a file for the other, or one stdin document: report, a line "=== FINDINGS ===", then rows (severity|path:line|finding|evidence; answer-only: --findings none or info|-|answer|<one line>).\nThe script builds the header, fingerprint and hashes and returns any rejection to you: fix what it names and submit again. Your final message is not parsed.\n' "$id" "$role" "$id"
    [ "$role" != explorer ] || printf 'Explorer: write your report in your scratch folder and pass it with --report <file> (no --artifact); the script assigns the numbered reports/NNN-explorer.md name (A113).\n'
    # A124: the window is held by this script and leaves no file until window-close, and an assignment is optional;
    # say both, or a worker looks for them, finds nothing and reports BLOCKED.
    [ "$writes_code" = no ] || printf 'WINDOW: dispatch.sh opened your write window before starting you (window-open). It leaves no file until the step ends (window-close writes worker-evidence/WINDOW-<n>.yaml). Do not look for it; never report BLOCKED for a missing window.\n'
    [ -n "$prompt_file" ] || printf 'ASSIGNMENT: none was given. Do your role'"'"'s default step on this task from .agents/runs/%s/ (TASK.md, PLAN.md and their scope); never report BLOCKED for a missing assignment file.\n' "$id"
    [ -z "$retry_note" ] || printf '\n%s\n' "$retry_note"
    [ -z "$prompt_file" ] || { printf '\n'; cat "$prompt_file"; }
  } > "$work/suffix"
  sb=$(wc -c < "$work/suffix" | tr -d ' ')
  [ "$sb" -le "$budget" ] || blocked "task prompt is $sb bytes, over the resolved context budget of $budget (trim it; it is never truncated)"
  { cat "$ins"; printf '\n=== TASK ===\n'; cat "$work/suffix"; } > "$work/full"

  # A113: claim the sequence atomically (mkdir), so parallel dispatches never share a token, output or log
  while ! mkdir "$run/dispatch/.claim-$(printf '%03d' "$seq_n")" 2>/dev/null; do seq_n=$((seq_n + 1)); done
  token=d$(printf '%03d' "$seq_n")-$role-$rt
  out=$run/dispatch/$(printf '%03d' "$seq_n")-$role-$rt.md
  log=$run/dispatch/$(printf '%03d' "$seq_n")-$role-$rt.log
  [ -z "$running" ] || rm -f "$running"   # a retry or failover attempt replaces the previous attempt's marker
  running=${log%.log}.running
  seq_n=$((seq_n + 1)); : > "$out"
  pm=''; tmpl=$(cfg dispatch command_template "$rt")
  if [ -n "$tmpl" ]; then
    for ph in "prompt_file $work/full" "output_file $out" "root $root" "model $model" "effort $effort"; do
      tmpl=$(subst "$tmpl" "${ph%% *}" "$(sq "${ph#* }")")
    done
    set -- sh -c "$tmpl"
  else
    case "$rt" in
      codex)
        set -- "${PROOFLINE_CODEX_BIN:-codex}" exec -C "$root" -s workspace-write -m "$model" -c "model_reasoning_effort=$effort" -c 'approval_policy="never"' --dangerously-bypass-hook-trust -o "$out"
        # The specialist runs `agent.sh submit` itself, which writes its report, the recorded result, the gate
        # record and ledger (the run folder) and its status and locks (.agents/local). Codex's workspace-write
        # sandbox keeps .agents read-only, so both are granted explicitly; what a role may write stays decided by
        # owns.conf (PreToolUse hook) and the fingerprint check below.
        mkdir -p "$run/worker-evidence" "$run/reports" "$root/.agents/local"
        set -- "$@" --add-dir "$run" --add-dir "$root/.agents/local"
        # Mutation and base-run evidence needs `git worktree add` (a separate worktree, D10): .git is read-only in
        # this sandbox, so the worktree administration directory is granted (verified against the real sandbox).
        cd_gitdir=$(git -C "$root" rev-parse --git-common-dir 2>/dev/null || true)
        case "$cd_gitdir" in '') ;; /*) ;; *) cd_gitdir=$root/$cd_gitdir ;; esac
        if [ -n "$cd_gitdir" ] && mkdir -p "$cd_gitdir/worktrees" 2>/dev/null; then set -- "$@" --add-dir "$cd_gitdir/worktrees"; fi
        set -- "$@" - ;;
      claude)
        an=$(agent_name "$role"); af=$root/.claude/agents/$an.md
        if [ -f "$af" ]; then
          # the generated agent runs, so its tools: list applies
          at=$(sed -n 's/^tools:[[:space:]]*//p' "$af" | head -1)
          [ -n "$at" ] || blocked "$af has no tools: list (it would inherit every tool, Agent included)"
          ! spawn_tool "$at" || blocked "$af grants an agent-spawning tool (Agent/Task)"
          set -- "${PROOFLINE_CLAUDE_BIN:-claude}" -p --agent "$an"
        else
          aj_src=$root/.agents/roles/$role.md; [ -f "$aj_src" ] || aj_src=$ins
          set -- "${PROOFLINE_CLAUDE_BIN:-claude}" -p --agents "$(agents_json "$an" "$aj_src" "$role")" --agent "$an"
        fi
        # A headless worker cannot be prompted, so the permission mode is explicit (A114). bypassPermissions is
        # only used while the PreToolUse hook (the real confinement) is installed and wired for this project.
        pm=$(cfg dispatch claude_permission_mode); [ -n "$pm" ] || pm=bypassPermissions
        case "$pm" in bypassPermissions|acceptEdits|default) ;; *) die "invalid dispatch.claude_permission_mode: $pm (want bypassPermissions|acceptEdits|default)" ;; esac
        if [ "$pm" = bypassPermissions ]; then
          pre_tool_hook_wired ||
            blocked "claude worker not started: the proofline PreToolUse hook is not installed in .claude/settings.json (run 'proofline doctor', then install); a headless worker runs with bypassPermissions only while the hook confines it, or set dispatch.claude_permission_mode"
        fi
        note "dispatch claude_permission_mode=$pm role=$role" || true
        set -- "$@" --model "$model" --effort "$effort" --permission-mode "$pm" --output-format json ;;
      *) blocked "runtime $rt has no built-in invocation and no dispatch.command_template.$rt" ;;
    esac
  fi
  input=$work/full; [ "$rt" = claude ] && [ -z "$tmpl" ] && input=$work/suffix

  before='' fp_before='' gs_before=$(git_state)
  if [ "$writes_code" = no ]; then
    fp_before=$("$agent" fingerprint "$id") && [ -n "$fp_before" ] || { echo "dispatch: no product-tree fingerprint; $role not started" >&2; exit 1; }
  else
    before=$("$agent" window-open "$id" "$role") || { echo "dispatch: window-open refused; $role not started" >&2; exit 1; }
  fi
  echo "dispatch: $id $role runtime=$rt model=$model effort=$effort ($(dv model_reason)) writes_code=$writes_code${pm:+ permission_mode=$pm}" >&2
  status=0
  # A124: .md and .log stay empty until the worker exits, so a reader cannot tell a running dispatch from a dead one.
  printf 'pid=%s\nrole=%s\ndispatch in flight: %s %s on %s, started %s.\nThis dispatch.sh command has not returned: the .md and .log of this step stay empty until it does.\nWait for the command to return; do not re-dispatch this step or read these files as a result.\n' "$$" "$role" "$id" "$role" "$rt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$running"
  if [ -z "$tmpl" ] && ! command -v "$1" >/dev/null 2>&1; then status=127; echo "runtime binary not found: $1" > "$log"
  else (cd "$root" && export AGENT_ROLE="$role" PROOFLINE_AGENT="$token" PROOFLINE_FOCUS="$focus" &&
    if [ "$rt" = codex ] && [ -n "${PROOFLINE_CODEX_HOME_DIR:-}" ]; then
      HOME=$PROOFLINE_CODEX_HOME_DIR CODEX_HOME=$PROOFLINE_CODEX_HOME_DIR/.codex \
        run_timed "$timeout_s" "$log" "$input" "$@"
    elif [ "$rt" != codex ] && [ -n "${PROOFLINE_REAL_HOME:-}" ]; then
      # A Codex lead runs with an isolated HOME (the end-to-end harness, A21); a Claude specialist started
      # from it needs the operator's own HOME and login, or it fails with "not logged in" (failover run).
      HOME=$PROOFLINE_REAL_HOME run_timed "$timeout_s" "$log" "$input" "$@"
    else
      run_timed "$timeout_s" "$log" "$input" "$@"
    fi) || status=$?; fi
  if [ "$writes_code" = yes ]; then
    "$agent" window-close "$id" "$before" "$status" "$role" >&2 || { echo "dispatch: window-close failed (unattributed mutation?)" >&2; exit 1; }
  fi
  gs_after=$(git_state)
  if [ "$gs_after" != "$gs_before" ]; then
    note "policy_violation role=$role runtime=$rt changed .git/config or HEAD during the step" || true
    blocked "policy_violation: $role changed .git/config (hooks, config) or HEAD during the step; result not recorded"
  fi
  if [ "$writes_code" = no ]; then
    fp_after=$("$agent" fingerprint "$id") || fp_after=unknown
    if [ "$fp_after" != "$fp_before" ]; then
      # Never auto-reverted: the user's files are theirs. Changed paths are reported; the result is not recorded.
      changed=$(git -C "$root" diff-tree -r --name-only "$fp_before" "$fp_after" 2>/dev/null | tr '\n' ' ') || changed=''
      note "policy_violation role=$role runtime=$rt product tree changed by a role that does not write code: ${changed:-paths unknown}" || true
      blocked "policy_violation: $role changed the product tree (${changed:-paths unknown}); result not recorded, changes left in place"
    fi
  fi
  if [ "$status" -eq 0 ] && [ "$rt" = claude ] && [ -z "$tmpl" ]; then
    if grep -q '"is_error":[[:space:]]*true' "$log"; then status=1
    else claude_result "$log" > "$out" || status=1; fi
  fi
  [ "$status" -ne 0 ] || [ -s "$out" ] || { [ -n "$tmpl" ] && cp "$log" "$out"; } || true
  [ "$status" -ne 0 ] || [ -s "$out" ] || status=1
  # A124: a worker that wrote nothing at all leaves the lead nothing to act on; name it in the log and in BLOCKED.
  if [ "$status" -ne 0 ] && [ "$status" -ne 124 ] && [ ! -s "$log" ]; then
    noout=yes; echo "dispatch: $role on $rt exited with status $status and wrote nothing to its log" > "$log"
  fi
  harvest
  [ -s "$out" ] || rm -f "$out"
  return 0
}

a_runtime=$o_runtime
attempt
if [ "$status" -ne 0 ] && [ "$status" -ne 124 ]; then
  reason=$(runtime_failure_reason "$log"); [ "$status" -eq 127 ] && reason=missing_binary
  [ "$reason" != runtime_unavailable:network ] || blocked "runtime_unavailable:network: $rt worker could not reach its API; enable network access for the lead workspace-write sandbox and retry this step"
  if [ "$reason" != none ]; then
    case "$rt" in claude) other=codex ;; codex) other=claude ;; *) other='' ;; esac
    mode=$(cfg failover); [ -n "$mode" ] || mode=auto
    [ -n "$other" ] || blocked "runtime $rt failed ($reason) and has no failover peer"
    case "$mode" in
      off) blocked "runtime $rt failed ($reason); failover: off" ;;
      ask)
        if [ "$("$agent" run-language "$id" 2>/dev/null || echo en)" = tr ]; then
          { printf '1. Çalışma ortamı %s, %s adımını çalıştıramadı (%s). Bu adım baştan %s üzerinde yeniden çalıştırılsın mı?\n' "$rt" "$role" "$reason" "$other"
            printf '   seçenekler: yes | no\n   önerilen: yes, %s bu rol için uygunsa\n   neden: config failover değeri ask\n' "$other"
          } > "$work/question"
        else
        { printf '1. Runtime %s could not run %s (%s). Re-run this step from its beginning on %s?\n' "$rt" "$role" "$reason" "$other"
          printf '   options: yes | no\n   recommended: yes, if %s is acceptable for this role\n   why: config failover is ask\n' "$other"
        } > "$work/question"
        fi
        "$agent" ask "$id" --file "$work/question" >&2 || blocked "runtime $rt failed ($reason); failover: ask, but the question could not be stored"
        note "dispatch needs_input role=$role runtime=$rt reason=$reason" || true
        printf 'ROLE: %s\nTASK: %s\nRESULT: NEEDS_INPUT\nQUESTIONS:\n' "$role" "$id"; cat "$work/question"
        exit 5 ;;
      auto) ;;
      *) die "invalid failover mode in config: $mode (want auto|ask|off)" ;;
    esac
    sh "$here/runtime-detect.sh" has "$other" || blocked "runtime $rt failed ($reason); $other is not installed"
    from=$rt; o_model=''   # model ids are runtime-specific; the policy picks the other runtime's model
    note "failover from=$from to=$other reason=$reason role=$role" || blocked "runtime $rt failed ($reason); failover could not be ledgered"
    a_runtime=$other
    attempt
    if [ "$status" -ne 0 ] && [ "$status" -ne 124 ] && [ "$(runtime_failure_reason "$log")" != none ]; then
      blocked "runtime $from failed ($reason) and failover runtime $rt failed too"
    fi
  fi
fi
submissions=0
while :; do
  if [ "$status" -eq 124 ]; then
    note "dispatch timeout role=$role runtime=$rt after=${timeout_s}s" || true
    echo "dispatch: $role on $rt timed out after ${timeout_s}s; log: ${log#"$root"/}" >&2; exit 124
  fi
  [ "$noout" = no ] || blocked "$role on $rt produced no output (exit $status); log: ${log#"$root"/}. An empty result also follows a dispatch killed before it finished (its caller's time limit): run it once, alone, and wait for the command to return"
  if [ "$status" -ne 0 ]; then echo "dispatch: $role on $rt failed (exit $status); log: ${log#"$root"/}" >&2; exit 1; fi
  st=$subdir/$token.status
  state=$(sed -n 's/^status=//p' "$st" 2>/dev/null | head -n 1)
  if [ "$state" = ok ]; then
    sr=$(sed -n 's/^result=//p' "$st" | head -n 1); sg=$(sed -n 's/^gate=//p' "$st" | head -n 1); sw=$(sed -n 's/^raw=//p' "$st" | head -n 1)
    printf 'submitted: %s %s %s%s (%s)\n' "$id" "$role" "$sr" "${sg:+ gate=$sg}" "${sw:-no raw}"
    exit 0
  fi
  err=$(sed -n 's/^error=//p' "$st" 2>/dev/null | head -n 1)
  submissions=$((submissions + 1))
  if [ "$submissions" -ge 2 ]; then
    blocked "no valid submission from $role after one retry${err:+ (last rejection: $err)}; nothing recorded"
  fi
  # A127: name what was looked for and what exists, so a missing status file (a submit under another token) shows in the ledger
  seen=$(ls "$subdir" 2>/dev/null | tr '\n' ',')
  note "dispatch resubmit role=$role runtime=$rt reason=${err:-no submission} token=$token status_files=${seen:-none}" || true
  retry_note="Your previous attempt ended without a recorded result${err:+ (last rejection: $err)}. Your report files may already exist: check them, fix what the rejection names, then submit. Do not redo finished work."
  a_runtime=$rt; o_model=''
  attempt
done
