#!/bin/sh
# shellcheck disable=SC2154,SC2016 # fixture vars come from test-lib.sh; literal command text
# Measurement (A188), not run by CI: how many external processes one run of the runtime hook starts per event, and how long it takes.
# A PATH shim logs every external command the hook (and the agent.sh it calls) executes; shell builtins and command-substitution
# forks are not counted, so on Windows (Git Bash, where every fork is slow) the real cost is higher than the count suggests.
#   sh tests/bench/hook-procs.sh [HOOK-SCRIPT]       prints `event  execs  ms  top commands`; set REPEAT=<n> (default 3, the median is shown)
#   sh tests/bench/hook-procs.sh adapters/claude/hooks/proofline-hook.mjs   the Node hook (stage 3), run with `node`; the project's core is copied beside agent.sh
set -u
if [ -z "${HP_INNER:-}" ]; then
  repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
  HP_INNER=1 HP_REPO=$repo HP_HOOK=${1:-$repo/adapters/claude/hooks/proofline-hook.sh} exec sh -c '. "$0"; . "$1"' "$repo/control-plane/agents/scripts/test-lib.sh" "$repo/tests/bench/hook-procs.sh"
fi
hook=$HP_HOOK
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT PROOFLINE_JSON 2>/dev/null || true
PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY
scaffold orchestrated no COMPLEX ""
node "$tl_agents/../../tests/legacy-githooks/install.mjs" .agents/githooks; mkdir -p .agents/hooks src; cp "$hook" .agents/hooks/proofline-hook.sh
hrun=sh
case "$hook" in
  *.mjs)
    hrun=node
    cp -R "$(dirname "$hook")/." .agents/hooks/
    cp "$tl_agents/scripts/proofline-core.mjs" .agents/scripts/; cp -R "$tl_agents/scripts/core" .agents/scripts/core
    printf '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n' >> .git/info/exclude ;;
esac
printf '.agents/githooks/\n.agents/hooks/\n' >> .git/info/exclude
git config core.hooksPath .agents/githooks; git config commit.gpgsign false
CLAUDE_PROJECT_DIR=$PWD; export CLAUDE_PROJECT_DIR   # the runtime always sets it
shim=$base/shim; mkdir -p "$shim"; log=$base/procs.log; export HP_LOG=$log
for c in jq awk sed tr cat dirname basename date mkdir find git grep cut shasum sha256sum head tail wc mv rm cp sort mktemp node perl sleep kill ps ls readlink uname id touch chmod ln xargs expr rmdir stat sh tee env od uniq; do
  real=$(command -v "$c" 2>/dev/null) || continue
  case "$real" in /*) ;; *) continue ;; esac
  if [ -n "${HP_TRACE:-}" ]; then pl='printf "%%s %%.70s\\n" "%s" "$*" >> "$HP_LOG"'; else pl='printf "%%s\\n" "%s" >> "$HP_LOG"'; fi
  printf '#!/bin/sh\n'"$pl"'\nexec %s "$@"\n' "$c" "$real" > "$shim/$c"; chmod +x "$shim/$c"
done
ms() { v=$(date +%s%N 2>/dev/null); case "$v" in ''|*[!0-9]*) perl -MTime::HiRes=time -e 'printf "%d", time()*1000' ;; *) echo $((v / 1000000)) ;; esac; }
measure() { # NAME EVENT JSON: median of REPEAT runs
  m_n=$1; m_e=$2; m_j=$3; m_r=${REPEAT:-3}; m_i=0; : > "$base/counts"; : > "$base/times"
  [ -z "${HP_PRE:-}" ] || eval "$HP_PRE"; printf '%s' "$m_j" | $hrun "$hook" "$m_e" claude >/dev/null 2>&1   # warm-up: first-run state (baseline, folders) is not measured
  while [ "$m_i" -lt "$m_r" ]; do
    [ -z "${HP_PRE:-}" ] || eval "$HP_PRE"
    : > "$log"; t0=$(ms)
    printf '%s' "$m_j" | PATH="$shim:$PATH" $hrun "$hook" "$m_e" claude >/dev/null 2>&1
    t1=$(ms); wc -l < "$log" | tr -d ' ' >> "$base/counts"; echo $((t1 - t0)) >> "$base/times"; m_i=$((m_i + 1))
  done
  c=$(sort -n "$base/counts" | sed -n "$(( (m_r + 1) / 2 ))p"); t=$(sort -n "$base/times" | sed -n "$(( (m_r + 1) / 2 ))p")
  [ -z "${HP_TRACE:-}" ] || { echo "--- $m_n" >&2; cat "$log" >&2; }
  top=$(sort "$log" | uniq -c | sort -rn | head -n 6 | awk '{ printf "%s%s=%s", (NR > 1 ? " " : ""), $2, $1 }')
  printf '%-22s execs=%-4s ms=%-6s %s\n' "$m_n" "$c" "$t" "$top"
  printf '%s %s\n' "$t" "$m_n" >> "$base/slowest"
}
j() { printf '{"hook_event_name":"%s","session_id":"s1","cwd":"%s"%s}' "$1" "$PWD" "$2"; }
sub=',"agent_type":"proofline-implementer","agent_id":"a1"'
j SubagentStart "$sub" | $hrun "$hook" subagent-start claude >/dev/null 2>&1   # opens the implementer's window, so the write below is allowed
HP_PRE='rm -rf .agents/local/hooklock'   # the duplicate guard (once) would turn a fast hook's repeated run into a no-op
measure pretool-write-impl pretool "$(j PreToolUse ",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"impl.txt\"}$sub")"
measure pretool-read pretool "$(j PreToolUse ',"tool_name":"Read","tool_input":{"file_path":"src/a.txt"}')"
measure pretool-bash pretool "$(j PreToolUse ',"tool_name":"Bash","tool_input":{"command":"git status --short"}')"
measure posttool posttool "$(j PostToolUse ',"tool_name":"Agent","tool_input":{},"tool_response":{}')"
measure prompt-plain prompt "$(j UserPromptSubmit ',"prompt":"looks fine, thanks"')"
HP_PRE='rm -rf .agents/local/hooklock; A request-approval LC plan >/dev/null 2>&1; sleep 1'
measure prompt-approval prompt "$(j UserPromptSubmit ',"prompt":"plan approved, go ahead"')"
HP_PRE='rm -rf .agents/local/hooklock'
measure stop stop "$(j Stop ',"stop_hook_active":false,"last_assistant_message":"done"')"
measure session session "$(j SessionStart '')"
measure subagent-start subagent-start "$(j SubagentStart "$sub")"
measure subagent-stop subagent-stop "$(j SubagentStop ",\"stop_hook_active\":false$sub,\"last_assistant_message\":\"done\"")"
# A200: the runtime stops a hook at 30 s. The slowest path is named; HP_LIMIT_MS=<ms> makes the script fail when a path is slower (a gate for a
# quiet machine, not for CI: a loaded runner is slower than the project's own hook).
sort -rn "$base/slowest" | head -n 1 | awk '{ printf "slowest: %s %s ms (runtime limit 30000)\n", $2, $1 }'
if [ -n "${HP_LIMIT_MS:-}" ]; then sort -rn "$base/slowest" | head -n 1 | awk -v l="$HP_LIMIT_MS" '{ exit !($1 + 0 > l + 0) }' && { echo "slower than HP_LIMIT_MS=$HP_LIMIT_MS" >&2; exit 1; }; fi
