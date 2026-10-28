#!/bin/sh
# proofline runtime hook: the extra enforcement layer for Claude Code and Codex (D2, D6, D12, D13, D16).
# The foundation stays agent.sh and the git hooks; this script never decides a gate, it only blocks tool
# calls early and feeds agent.sh. Normative description: docs/concepts/enforcement-layers.md.
#
#   proofline-hook.sh <pretool|posttool|subagent-start|subagent-stop|prompt|stop|session> [claude|codex]
#
# stdin: the runtime's hook JSON. JSON is read with jq, else node (PROOFLINE_JSON=jq|node|none overrides,
# for tests). Unparsable input while a run is active: PreToolUse denies (fail closed); everything else and
# any input without an active run passes (fail open). Without .agents/config.yaml and
# .agents/scripts/agent.sh in the project, every event is a no-op.
#
# Caller identity: a subagent carries agent_id/agent_type (`proofline-<role>`, optional `<plugin>:` prefix);
# a headless specialist started by dispatch.sh carries AGENT_ROLE in the hook's environment; anything else
# is the lead (non-proofline subagents get the lead's restrictions).
set -u
ev=${1:-}; rt=${2:-claude}
# A188: fewer processes. On Windows (Git Bash) every started process costs tens of milliseconds, so the hot paths use shell builtins
# and parameter expansion where the result is byte-identical, read the hook JSON in one pass (jprefetch) and take the clock once.
# hk_tick sets hk_v (epoch milliseconds, a millisecond clock only for the events a person waits on, else whole seconds times 1000)
# and hk_s (epoch seconds) without a subshell; the first date that gives no nanoseconds (macOS) switches to perl once, not on every tick.
hk_fine=no; case "$ev" in prompt|session|stop|subagent-start|subagent-stop) hk_fine=yes ;; esac
hk_mode=nano; [ "$hk_fine" = yes ] || hk_mode=sec
hk_tick() {
  hk_v=''
  if [ "$hk_mode" = nano ]; then
    hk_v=$(date +%s%N 2>/dev/null); case "$hk_v" in ''|*[!0-9]*) hk_v=''; hk_mode=perl ;; *) hk_v=$((hk_v / 1000000)) ;; esac
  fi
  if [ "$hk_mode" = perl ]; then
    hk_v=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null || :); case "$hk_v" in ''|*[!0-9]*) hk_v=''; hk_mode=sec ;; esac
  fi
  case "$hk_v" in ''|*[!0-9]*) hk_v=$(( $(date +%s) * 1000 )) ;; esac
  hk_s=$((hk_v / 1000))
}
hk_tick; hk_t0=$hk_v
kg_t0=$hk_s   # the kill guard's time budget (KG_BUDGET, below) covers the whole hook, so it starts here
NL='
'; TAB=$(printf '\t'); CR=$(printf '\r'); SEP=$(printf '\001'); US=$(printf '\002')
tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-hook.XXXXXX") || exit 0
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/in"

jp=${PROOFLINE_JSON:-}
if [ -z "$jp" ]; then
  if command -v jq >/dev/null 2>&1; then jp=jq; elif command -v node >/dev/null 2>&1; then jp=node; else jp=none; fi
fi
# jget [PATH...]: the first non-null value of dotted PATHs; strings raw, string arrays space-joined, other
# values as JSON. Without PATHs it only validates the input. Exit non-zero when the input is not JSON.
jget() {
  # A188: a value fetched by jprefetch is answered from memory (the same bytes jq or node would print)
  case "$JC" in *"$SEP$*$US"*) jg_v=${JC#*"$SEP$*$US"}; printf '%s' "${jg_v%%"$SEP"*}"; return 0 ;; esac
  case "$jp" in
    jq) jq -je --arg ps "$*" '. as $r | [($ps | split(" "))[] | . as $p | ($r | try getpath($p | split(".")) catch null) | select(. != null)]
          | (first // "") | if type == "string" then . elif type == "array" and all(type == "string") then join(" ") else tojson end' < "$tmp/in" 2>/dev/null ;;
    node) node -e 'let r; try { r = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch (e) { process.exit(1) }
          for (const p of process.argv.slice(1)) { let v = r; for (const k of p.split(".")) v = (v !== null && typeof v === "object") ? v[k] : undefined
            if (v !== undefined && v !== null) { process.stdout.write(typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : JSON.stringify(v)); break } }' "$@" < "$tmp/in" ;;
    *) return 1 ;;
  esac
}
# jprefetch GROUP...: one jq or node run reads every GROUP (the PATH list of one jget call, space-separated) and keeps the answers in $JC;
# a later `jget <the same list>` is then answered without a process. Fails when the input is not JSON, like jget without PATHs. Values that
# hold the separator characters (or a NUL) are not cached at all, so those fall back to the process.
JC=''
jprefetch() {
  jf_o=''; jf_g=''; for jf_a in "$@"; do jf_g=$jf_g$jf_a$NL; done
  case "$jp" in
    jq) jf_o=$(jq -je --arg ps "${jf_g%"$NL"}" '. as $r | [($ps | split("\n"))[] | split(" ") as $pl | [$pl[] | . as $p | ($r | try getpath($p | split(".")) catch null) | select(. != null)]
          | (first // "") | if type == "string" then . elif type == "array" and all(type == "string") then join(" ") else tojson end] as $vs
          | if ($vs | any(contains("\u0001") or contains("\u0002") or contains("\u0000"))) then "0\u0001" else ("1\u0001" + ($vs | map(. + "\u0001") | join(""))) end' < "$tmp/in" 2>/dev/null) || return 1 ;;
    node) jf_o=$(node -e 'let r; try { r = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch (e) { process.exit(1) }
          const vs = process.argv[1].split("\n").map(g => { for (const p of g.split(" ")) { let v = r; for (const k of p.split(".")) v = (v !== null && typeof v === "object") ? v[k] : undefined
            if (v !== undefined && v !== null) return typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : JSON.stringify(v) } return "" })
          process.stdout.write(vs.some(v => /[\u0000-\u0002]/.test(v)) ? "0\u0001" : "1\u0001" + vs.map(v => v + "\u0001").join(""))' "${jf_g%"$NL"}" < "$tmp/in" 2>/dev/null) || return 1 ;;
    *) return 1 ;;
  esac
  [ -n "$jf_o" ] || return 1
  [ "${jf_o%%"$SEP"*}" = 1 ] || return 0
  jf_o=${jf_o#*"$SEP"}
  for jf_a in "$@"; do JC=$JC$SEP$jf_a$US${jf_o%%"$SEP"*}; jf_o=${jf_o#*"$SEP"}; done
}
# jesc TEXT: JSON string body. Text without a backslash, quote, tab, carriage return or newline is already one (no process).
jesc() {
  case $1 in
    *\\*|*\"*|*"$TAB"*|*"$CR"*|*"$NL"*) printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if (NR > 1) print "\\n"; print }' ;;
    *) printf '%s' "$1" ;;
  esac
}
ctx() { # EVENT TEXT: additionalContext for the model
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$1" "$(jesc "$2")"; exit 0
}
# alt_hint MESSAGE (A200): the one-line permitted alternative for a denial that names none (result in alt_r, empty when the message already
# says what to do). It only SHOWS the allowed way; no rule is decided here, deny stays a deny.
alt_hint() {
  alt_r=''
  case "$1" in *nstead*|*Allowed*|*"run: "*|*"Write the file"*|*"wait for the user"*|*"proofline merge"*|*"Scratch files go under"*) return 0 ;; esac
  case "$1" in
    *"is not literal"*|*"is not allowed while run"*) alt_r='Instead of $A next write: sh .agents/scripts/agent.sh next (the command word, AGENT_ROLE and the subcommand are literal)' ;;
    *PROOFLINE_DISPATCH*) alt_r='Instead list by a literal path: ls .agents/local/windows (no glob or find over .agents/local)' ;;
    *"outside the project"*|*"under \$TMPDIR"*) alt_r='Instead: mkdir -p .agents/local/scratch && write there (in a run: .agents/runs/<ID>/scratch/); /tmp is only for git worktrees' ;;
    *"git hook bypass"*|*"wires the git hooks"*) alt_r='Instead commit without --no-verify or a hooksPath change; fix what the hook names, or ask the user' ;;
    *"does not match the caller"*) alt_r='Instead: prefix your own role, AGENT_ROLE=<your role> sh .agents/scripts/agent.sh ...' ;;
    *"never as a nested runtime"*) alt_r='Instead: sh .agents/scripts/dispatch.sh <ID> <role>' ;;
    *"links into or out of .agents"*) alt_r='Instead: cp the file to the project path you need, or read it where it is' ;;
    *"never submits a specialist result"*|*"verdicts enter a run only"*|*"opened and closed only by"*) alt_r='Instead: dispatch the specialist (sh .agents/scripts/dispatch.sh <ID> <role>); it submits, you read the result with agent.sh next' ;;
    *"a subagent never approves"*) alt_r='Instead: put the question to the lead; the user answers and the runtime records it from the reply' ;;
    *"read-only agent.sh"*|*"runs only agent.sh worker-evidence"*) alt_r='Instead: submit your result with AGENT_ROLE=<role> sh .agents/scripts/agent.sh submit <ID> --agent <token> ...' ;;
    *"cannot be resolved"*|*"cannot be read from the command text"*) alt_r='Instead: write the path literally, or use the Write tool on an allowed path (.agents/local/scratch/ for scratch files)' ;;
    *"destructive SQL"*|*"database client"*|*"migration, seed or schema"*|*"names the database file"*) alt_r='Instead: run the project test command (it builds its own throwaway database) and record what you could not check as an open point' ;;
    *"lead writes only"*|*"lead never edits"*|*"no run is active"*) alt_r='Instead: /proofline run <text>, or dispatch the implementer (sh .agents/scripts/dispatch.sh <ID> implementer) for a product change' ;;
    *"is outside the paths role"*) alt_r='Instead: write only inside the paths your role owns (.agents/owns.conf and the PLAN.md scope)' ;;
    *"parsed"*) alt_r='Instead: install jq or node, then retry' ;;
    *"ACTIVE_RUN is malformed"*) alt_r='Instead: sh .agents/scripts/agent.sh status shows the active run' ;;
    *"read-only in the project"*|*"changes the project working tree"*) alt_r='Instead: git worktree add --detach "$TMPDIR/<name>" HEAD in its own call, then git -C "$TMPDIR/<name>" ...' ;;
  esac
}
# hk_budget SECS OUTFILE CMD...: runs CMD with its output in OUTFILE and waits at most SECS seconds, then stops CMD and every process it started
# (by pid); status 124 on expiry, else CMD's own status. The runtime stops a hook at 30 s, so a step whose cost grows with the project (the
# session hook's `agent.sh next` took 26 s on a loaded machine, A200) is given a budget and the hook still answers in time. A188: 0.1 s
# steps for the first second, then 0.5 s (a sleep is a process).
hk_budget() {
  hb_s=$1 hb_o=$2; shift 2
  ( "$@" ) >"$hb_o" 2>&1 </dev/null &
  hb_pid=$!; hb_lim=$((hb_s * 10)); hb_i=0
  while kill -0 "$hb_pid" 2>/dev/null && [ "$hb_i" -lt "$hb_lim" ]; do
    if [ "$hb_i" -lt 10 ]; then sleep 0.1; hb_i=$((hb_i + 1)); else sleep 0.5; hb_i=$((hb_i + 5)); fi
  done
  if kill -0 "$hb_pid" 2>/dev/null; then
    hb_all=$hb_pid; hb_new=$hb_pid
    while [ -n "$hb_new" ]; do
      hb_next=''
      for hb_c in $hb_new; do hb_next="$hb_next $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$hb_c" '$2 == p { print $1 }')"; done
      hb_new=$(printf '%s\n' $hb_next); hb_all="$hb_all $hb_new"
    done
    # shellcheck disable=SC2086 # pids
    kill $hb_all 2>/dev/null || :
    { wait "$hb_pid"; } 2>/dev/null || :
    return 124
  fi
  hb_rc=0; wait "$hb_pid" 2>/dev/null || hb_rc=$?
  return "$hb_rc"
}
deny() {
  alt_hint "$*"
  [ -z "$alt_r" ] || set -- "$* | $alt_r"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(jesc "proofline: $*")"
  exit 0
}
# sha FILE: the SHA-256 of FILE (the digest is the first word of the tool's line; no awk)
if command -v shasum >/dev/null 2>&1; then sha() { sh_o=$(shasum -a 256 "$1") || :; [ -z "$sh_o" ] || printf '%s\n' "${sh_o%% *}"; }; else sha() { sh_o=$(sha256sum "$1") || :; [ -z "$sh_o" ] || printf '%s\n' "${sh_o%% *}"; }; fi
canon() { case "$1" in full_lifecycle) echo lead ;; implementation_worker) echo implementer ;; independent_reviewer) echo reviewer ;; independent_qa) echo qa ;; independent_verifier) echo verifier ;; *) printf '%s\n' "$1" ;; esac; }
valid_role() { case "$1" in lead|task_author|explorer|architect|data_architect|designer|qa|implementer|reviewer|security_reviewer|verifier) return 0 ;; *) return 1 ;; esac; }
safe() { case $1 in *[!A-Za-z0-9_.-]*) printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_' ;; *) printf '%s' "$1" ;; esac; }   # a name that is already safe needs no process
# dn_ P / bn_ P (A188): dirname and basename of P as parameter expansion (result in dn_r / bn_r), the same answers as the tools for the
# paths the hook builds (absolute, any number of trailing or doubled slashes); no process.
dn_() {
  dn_r=$1
  while case $dn_r in ?*/) true ;; *) false ;; esac; do dn_r=${dn_r%/}; done
  case $dn_r in
    */*) dn_r=${dn_r%/*}; while case $dn_r in ?*/) true ;; *) false ;; esac; do dn_r=${dn_r%/}; done; [ -n "$dn_r" ] || dn_r=/ ;;
    *) dn_r=. ;;
  esac
}
bn_() {
  bn_r=$1
  while case $bn_r in ?*/) true ;; *) false ;; esac; do bn_r=${bn_r%/}; done
  case $bn_r in /) ;; *) bn_r=${bn_r##*/} ;; esac
}

# A188: every value the event reads, in ONE parse (this also validates the input, as `jget` without PATHs did). The groups are exactly the
# argument lists the hook passes to jget below; a value read through another list is fetched by its own process as before.
parsed=yes
case "$ev" in
  pretool) jprefetch cwd agent_id agent_type tool_name 'tool_input.file_path tool_input.notebook_path tool_input.path' 'tool_input.command tool_input.cmd' session_id 'tool_input.file_path tool_input.path' tool_input.file_path tool_input.notebook_path tool_input.path tool_input.pattern || parsed=no ;;
  posttool) jprefetch cwd agent_id agent_type 'tool_input.file_path tool_input.notebook_path tool_input.path' || parsed=no ;;
  prompt) jprefetch cwd agent_id agent_type prompt session_id || parsed=no ;;
  stop) jprefetch cwd agent_id agent_type session_id last_assistant_message transcript_path stop_hook_active || parsed=no ;;
  *) jprefetch cwd agent_id agent_type session_id stop_hook_active agent_transcript_path transcript_path || parsed=no ;;
esac
cwd=''; [ "$parsed" = no ] || cwd=$(jget cwd)
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd=$PWD
root=${CLAUDE_PROJECT_DIR:-}
[ -n "$root" ] || root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=$cwd
root=$(CDPATH='' cd "$root" 2>/dev/null && pwd -P) || exit 0
agent=$root/.agents/scripts/agent.sh
# Not installed: every event is a no-op, except the merge guard of pretool (A136), which protects any project the hook runs in.
installed=yes; { [ -f "$root/.agents/config.yaml" ] && [ -f "$agent" ]; } || installed=no
# A185: ONE folder per kind of state. Per-run state (ACTIVE_RUN, windows, records, submissions, baseline, hook-times, in-flight marks) lives in the
# worktree that owns the run: sroot, the root of the run worktree the event belongs to (the path the tool touches when it is inside the
# project, else the working directory), as decided by agent.sh worktree-root; otherwise the project root. agent.sh of that worktree is the
# one that is asked, so it and the hook read and write the same run folder. State that belongs to no run (prompts, approvals of no run)
# is the main working tree's, reached by path (shared_local), never through a link. Outside a run worktree sroot is root: nothing changes.
main_root=$root
if [ -f "$root/.git" ]; then   # root itself is a linked worktree (CLAUDE_PROJECT_DIR or git named it): its main tree holds the shared state
  mr_m=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  case "$root" in "$mr_m"/.agents/local/worktrees/*) main_root=$mr_m ;; esac
fi
shared_local=$main_root/.agents/local
sroot=$root
ev_phys() { # P: the physical absolute path (existing parents resolved); nothing when it cannot be resolved
  ep_q=$1; case "$ep_q" in /*) ;; *) ep_q=$cwd/$ep_q ;; esac
  dn_ "$ep_q"; ep_d=$dn_r; bn_ "$ep_q"; ep_t=$bn_r
  while [ ! -d "$ep_d" ]; do bn_ "$ep_d"; ep_t=$bn_r/$ep_t; dn_ "$ep_d"; ep_n=$dn_r; [ "$ep_n" != "$ep_d" ] || return 0; ep_d=$ep_n; done
  ep_d=$(CDPATH='' cd "$ep_d" 2>/dev/null && pwd -P) || return 0
  printf '%s/%s\n' "$ep_d" "$ep_t"
}
if [ "$installed" = yes ] && [ "$main_root" = "$root" ]; then
  ev_p=''; [ "$parsed" = no ] || case "$ev" in pretool|posttool) ev_p=$(jget tool_input.file_path tool_input.notebook_path tool_input.path) ;; esac
  for ev_c in "$ev_p" "$cwd"; do
    [ -n "$ev_c" ] || continue
    ev_c=$(ev_phys "$ev_c"); [ -n "$ev_c" ] || continue
    case "$ev_c" in
      "$root"/.agents/local/worktrees/*)
        if ev_w=$(sh "$agent" worktree-root "$ev_c" 2>/dev/null) && [ -n "$ev_w" ] && [ -f "$ev_w/.agents/config.yaml" ] && [ -f "$ev_w/.agents/scripts/agent.sh" ]; then sroot=$ev_w; agent=$ev_w/.agents/scripts/agent.sh; fi
        break ;;
      "$root"|"$root"/*) break ;;   # a path inside the project but outside every run worktree: the main tree decides
    esac
  done
fi
local_dir=$sroot/.agents/local
# A200: the runtime stops a hook at 30 s, and agent.sh waits for a lock up to PROOFLINE_LOCK_TIMEOUT (default 120 s): one busy lock (a long build
# record, a dispatch) held a prompt, stop or subagent hook for the whole 30 s. Every agent.sh this hook starts now gives up on a lock after
# PROOFLINE_HOOK_LOCK_WAIT seconds (default 8), long before the limit; the step reports the refusal and the next `agent.sh next` retries it.
PROOFLINE_LOCK_TIMEOUT=${PROOFLINE_HOOK_LOCK_WAIT:-8}; export PROOFLINE_LOCK_TIMEOUT
# once: the same hook registered from several places (plugin, project, user; Codex runs it up to three times) runs
# once per identical event; a copy that starts less than two seconds after the first exits. Only for events with side
# effects (prompt, session).
once() {
  [ -d "$local_dir/hooklock" ] || mkdir -p "$local_dir/hooklock" 2>/dev/null || return 0
  find "$local_dir/hooklock" -type f -mmin +5 -exec rm -f {} + 2>/dev/null
  o_h=$(sha "$tmp/in"); o_h=${o_h%"${o_h#????????????????}"}
  o_k=$local_dir/hooklock/$ev.$o_h; o_n=$hk_s
  ( set -C; printf '%s\n' "$o_n" > "$o_k" ) 2>/dev/null && return 0
  o_p=$(cat "$o_k" 2>/dev/null); case "$o_p" in *[!0-9]*) o_p=0 ;; esac
  if [ -z "$o_p" ] || [ $((o_n - o_p)) -le 1 ]; then exit 0; fi   # empty: the first copy is still writing its stamp
  # an old stamp: one copy takes it over (mkdir is atomic), then checks that no other copy did
  mkdir "$o_k.t" 2>/dev/null || exit 0
  o_p=$(cat "$o_k" 2>/dev/null); case "$o_p" in ''|*[!0-9]*) o_p=0 ;; esac
  if [ $((o_n - o_p)) -le 1 ]; then rmdir "$o_k.t"; exit 0; fi
  printf '%s\n' "$o_n" > "$o_k"; rmdir "$o_k.t"
}

# Active run: the selector's single id; anything malformed counts as active (fail closed).
act=''
if [ -f "$local_dir/ACTIVE_RUN" ]; then
  # A188: the lines that hold more than white space, with spaces and tabs removed, joined by newlines (read loop, no sed or tr)
  while IFS= read -r ac_l || [ -n "$ac_l" ]; do
    case $ac_l in *[![:space:]]*) ;; *) continue ;; esac
    while case $ac_l in *" "*|*"$TAB"*) true ;; *) false ;; esac; do ac_l=${ac_l%%[ "$TAB"]*}${ac_l#*[ "$TAB"]}; done
    act=${act:+$act$NL}$ac_l
  done < "$local_dir/ACTIVE_RUN"
  case "$act" in '') ;; *[!A-Za-z0-9_-]*) act=INVALID ;; esac
fi

# --- hook timings (A171) ----------------------------------------------------------------------
# Every run leaves a line `epoch|name|ms|result|note` in .agents/local/hook-times (a plain append); a hook the runtime killed at its
# time limit leaves an in-flight marker instead, which the next prompt or session hook turns into a `timeout` line.
# `agent.sh hook-time <ID>` moves the lines into the ledger of the active run (the friction report counts them).
# Millisecond clocks exist for the events a person waits on (prompt, session, stop, subagent events); tool events use seconds.
# (hk_fine, hk_tick and hk_t0 are set at the top of the script, A188.)
hk_mark=''
hk_line() { # NAME MS RESULT [NOTE]: the line's epoch is the clock of the hk_tick that just measured MS
  [ "$installed" = yes ] || return 0
  printf '%s|%s|%s|%s|%s\n' "$hk_s" "$1" "$2" "$3" "${4:-}" >> "$local_dir/hook-times" 2>/dev/null || :
}
hk_step() { hk_tick; hk_line "$ev.$1" $(( hk_v - $2 )) ok; }   # STEP T0: the time of one step of this hook
hk_finish() {
  [ -z "$hk_mark" ] || { hk_tick; hk_line "$ev" $(( hk_v - hk_t0 )) ok; }   # the marker is removed by the EXIT trap's single rm (A188)
}
if [ "$installed" = yes ] && { [ -d "$local_dir/hooks-inflight" ] || mkdir -p "$local_dir/hooks-inflight" 2>/dev/null; }; then
  hk_mark=$local_dir/hooks-inflight/$ev.$$; printf '%s %s\n' "$$" "$hk_t0" > "$hk_mark" 2>/dev/null || hk_mark=''
fi
trap 'hk_finish; rm -rf "$tmp" ${hk_mark:+"$hk_mark"}' EXIT
hk_sweep() { # in-flight markers of hooks that are gone without finishing: the runtime killed them at its time limit
  for hk_f in "$local_dir"/hooks-inflight/*; do
    [ -f "$hk_f" ] && [ "$hk_f" != "$hk_mark" ] || continue
    read -r hk_p hk_st < "$hk_f" || :
    case "$hk_p:$hk_st" in *[!0-9:]*|:*|*:) rm -f "$hk_f"; continue ;; esac
    ! kill -0 "$hk_p" 2>/dev/null || continue
    hk_n=${hk_f##*/}; hk_n=${hk_n%.*}
    hk_tick; hk_line "$hk_n" $(( hk_v - hk_st )) timeout "killed-before-finish"
    rm -f "$hk_f"
  done
}
hk_flush() { # move the spool into the ledger of the active run; never waits long for the locks
  [ -s "$local_dir/hook-times" ] && [ -n "$act" ] && [ "$act" != INVALID ] || return 0
  (unset AGENT_ROLE; PROOFLINE_LOCK_TIMEOUT=3 sh "$agent" hook-time "$act" >/dev/null 2>&1) || :
}

aid=''; atype=''; [ "$parsed" = no ] || { aid=$(jget agent_id); atype=$(jget agent_type); }
envrole=$(canon "${AGENT_ROLE:-}")
role=lead; prole=''
t=${atype##*:}
case "$t" in proofline-*) r=${t#proofline-}; while case $r in *-*) true ;; *) false ;; esac; do r=${r%%-*}_${r#*-}; done; r=$(canon "$r"); if valid_role "$r" && [ "$r" != lead ]; then prole=$r; fi ;; esac
if [ -n "$aid" ] || [ -n "$atype" ]; then [ -z "$prole" ] || role=$prole
elif [ -n "$envrole" ] && [ "$envrole" != lead ] && valid_role "$envrole"; then role=$envrole; fi
sub=no; { [ -n "$aid" ] || [ -n "$atype" ]; } && sub=yes
aidf=$(safe "${aid:-unknown}")
# Read roles (A143) change nothing in the project working tree; mutation and trials run in an evidence worktree.
ro=no; case "$role" in qa|reviewer|security_reviewer|verifier) ro=yes ;; esac
# shellcheck disable=SC2016 # literal $TMPDIR in the message
ro_tail() { [ "$ro" = yes ] || return 0; printf ' (role %s is read-only in the project working tree, A143: mutation, trials and fix attempts run only in an evidence worktree, a git worktree outside the project that you create under $TMPDIR: git worktree add --detach "$TMPDIR/<name>" HEAD, in its own call, then use literal paths inside it; git worktree list shows it. Allowed in the project: your run result files and .agents/runs/<ID>/scratch/)' "$role"; }

# --- path policy ----------------------------------------------------------------------------
tasks_dir=''
# relpath P: project-relative path of P (resolved against cwd; symlinks in every existing parent directory
# resolved); "@outside" when outside the project, "@unknown" when it cannot be resolved (incl. a dangling
# symlink among the parents). The last component is not followed; target_ok refuses links there.
relpath() {
  rp=$1; case "$rp" in /*) ;; *) rp=$cwd/$rp ;; esac
  dn_ "$rp"; rp_dir=$dn_r; bn_ "$rp"; rp_tail=$bn_r
  while [ ! -d "$rp_dir" ]; do
    [ ! -L "$rp_dir" ] || { echo @unknown; return; }
    bn_ "$rp_dir"; rp_tail=$bn_r/$rp_tail; dn_ "$rp_dir"; rp_dir=$dn_r
  done
  case "/$rp_tail/" in */../*|*/./*) echo @unknown; return ;; esac
  rp_dir=$(CDPATH='' cd "$rp_dir" 2>/dev/null && pwd -P) || { echo @unknown; return; }
  rp=$rp_dir/$rp_tail
  # A184 (review): a session whose project root is a run worktree still protects the MAIN tree: a path inside main_root (the main working tree of
  # the same git common dir) that is not inside the session's own worktree is judged with the main tree's rules, relative to main_root, never as
  # "outside the project" (that would let the lead write .agents/local/approvals there). In the main tree main_root is root: nothing changes.
  rp_b=''
  case "$rp" in "$root"|"$root"/*) rp_b=$root ;; "$main_root"|"$main_root"/*) rp_b=$main_root ;; esac
  [ -n "$rp_b" ] || { echo @outside; [ "${2:-}" != abs ] || printf '%s\n' "$rp"; return; }   # (an empty base would make "$rp_b"/* match every path)
  case "$rp" in "$rp_b") echo . ;; "$rp_b"/*) rp_r=${rp#"$rp_b"/}
    # A184: a path inside a run's own git worktree (.agents/local/worktrees/<ID>/...) is judged relative to THAT worktree's root, so its
    # .agents/runs/<ID>/ obeys the rules of the main tree and its .agents/local/** stays runtime state. Whether the folder is a registered
    # worktree of this project is decided by agent.sh worktree-root (the one definition, never inferred from the path string here); any
    # doubt (agent.sh missing, not registered, a link, a crafted folder) keeps the project-relative path, which is denied as runtime state.
    case "$rp_r" in .agents/local/worktrees/*/*)
      if [ "$installed" = yes ] && rp_w=$(sh "$agent" worktree-root "$rp" 2>/dev/null) && [ -n "$rp_w" ]; then
        case "$rp" in "$rp_w"/*) rp_r=${rp#"$rp_w"/} ;; esac
      fi ;;
    esac
    printf '%s\n' "$rp_r" ;;
  *) echo @outside; [ "${2:-}" != abs ] || printf '%s\n' "$rp" ;; esac
}
# outside_ok P: may a Write/Edit tool write P, which relpath put outside the project? Only inside a registered
# worktree or the runtime's own storage (~/.claude/projects/*/memory, tool-results, ~/.claude/plans); a sibling such as <project>-x is outside (A120, C-18).
outside_ok() {
  oo_p=$(relpath "$1" abs | sed -n 2p); oo_p=${oo_p#/private}
  oo_h=$(printf '%s' "${HOME:-/nonexistent-home}" | sed 's|//*|/|g'); oo_h=${oo_h#/private}
  case "$oo_p" in "$oo_h"/.claude/projects/*/memory/*|"$oo_h"/.claude/projects/*/tool-results/*|"$oo_h"/.claude/plans/*) return 0 ;; esac
  git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' > "$tmp/oo_wts"
  while IFS= read -r oo_w; do
    [ "${oo_w#/private}" != "${root#/private}" ] || continue
    case "$oo_p" in "${oo_w#/private}"/*) return 0 ;; esac
  done < "$tmp/oo_wts"
  echo "$1 is outside the project. A run writes nothing outside the copy (registered worktrees and the runtime's own storage excepted); a path that merely shares a prefix with the project root is outside too"
  return 1
}
# always_protected REL: the git hooks and the git config that wires them; never written by an agent.
always_protected() { case "$1" in .agents/githooks|.agents/githooks/*|.git/config|.git/config.*) return 0 ;; esac; return 1; }
# target_ok P: may the caller write P now? A symlink or a multiply hard-linked file is never a write target
# during a run (it would land elsewhere); otherwise path_ok on the resolved project-relative path.
target_ok() {
  to_p=$1; case "$to_p" in /*) ;; *) to_p=$cwd/$to_p ;; esac
  if [ -L "$to_p" ]; then echo "the target is a symbolic link; writes through links are never allowed during a run"; return 1; fi
  if [ -f "$to_p" ] && [ -n "$(find "$to_p" -prune -links +1 2>/dev/null)" ]; then echo "the target has several hard links; writes through links are never allowed during a run"; return 1; fi
  path_ok "$(relpath "$1")"
}
# erasable P: may a deletion of P pass although the path policy refuses it? Only a file or symlink the run itself
# created: in the run's scratch/, or elsewhere one git neither tracks nor ignores that changed after the run began
# (an audit output in the repository root). Protected state (.git, .agents outside scratch, runtime config) never.
erasable() {
  er_r=$(relpath "$1")
  case "$er_r" in
    @*|.|.git|.git/*|.claude/*|.codex/*) return 1 ;;
    .agents/runs/"$act"/scratch/*) ;;
    .agents/*) return 1 ;;
  esac
  er_p=$1; case "$er_p" in /*) ;; *) er_p=$cwd/$er_p ;; esac
  [ -f "$er_p" ] || [ -L "$er_p" ] || return 1
  case "$er_r" in .agents/runs/"$act"/scratch/*) return 0 ;; esac
  [ "$ro" = no ] || return 1   # A143: a read role leaves the project tree unchanged
  ! always_protected "$er_r" || return 1
  [ -z "$(git -C "$sroot" ls-files -- "$er_r" 2>/dev/null)" ] || return 1
  ! git -C "$sroot" check-ignore -q -- "$er_r" 2>/dev/null || return 1
  # not in the untracked set recorded when the run's first hook event came (the user's own work in progress is in it)
  [ -f "$local_dir/baseline/$act" ] && ! grep -qxF -- "$er_r" "$local_dir/baseline/$act"
}
# baseline: once per run, the untracked, unignored files that exist before the run changes anything.
baseline() {
  [ "$installed" = yes ] && [ -n "$act" ] && [ "$act" != INVALID ] && [ ! -f "$local_dir/baseline/$act" ] || return 0
  mkdir -p "$local_dir/baseline" 2>/dev/null || return 0
  # git's own status is checked (a pipe into tr would hide its failure); a failed git writes no baseline, so erasable() refuses
  if git -C "$sroot" ls-files -z --others --exclude-standard >"$local_dir/baseline/.$act.raw" 2>/dev/null &&
     tr '\0' '\n' <"$local_dir/baseline/.$act.raw" >"$local_dir/baseline/.$act.tmp"; then
    mv "$local_dir/baseline/.$act.tmp" "$local_dir/baseline/$act"
  fi
  rm -f "$local_dir/baseline/.$act.raw" "$local_dir/baseline/.$act.tmp"
}
# ro_operand KIND WORD (A143): may a read role pass WORD, an operand of an in-place editing command (KIND P: only an
# existing file counts, the program text is also an operand) or of a script editor (KIND Q: any path counts)?
# Prints the reason on refusal. A path outside the project is left to the shell-write rules; a variable path that
# starts with neither $TMPDIR nor $HOME cannot be read, so it is refused.
ro_operand() {
  ro_v=$2
  case "$ro_v" in .) ro_v=$cwd ;; */.) ro_v=${ro_v%/.} ;; esac   # patch: its targets are named in the diff, so the directory counts
  # shellcheck disable=SC2016 # literal $TMPDIR in the command text
  case "$ro_v" in '$TMPDIR'/*|'${TMPDIR}'/*) ro_v=${TMPDIR:-/tmp}/${ro_v#*/} ;; '~'/*|'$HOME'/*|'${HOME}'/*) ro_v=${HOME:-/nonexistent-home}/${ro_v#*/} ;; esac
  case "$ro_v" in
    *'$'*|*'`'*|'~'*)
      case "$ro_v" in *[[:space:]]*|*';'*|*'{'*|*'('*|*'='*) return 0 ;; esac
      echo "the path '$2' of an in-place edit cannot be resolved from the command text"; return 1 ;;
  esac
  case "$ro_v" in /*) ro_a=$ro_v ;; *) ro_a=$cwd/$ro_v ;; esac
  [ "$1" = Q ] || [ -e "$ro_a" ] || return 0
  case "$(relpath "$ro_v")" in @outside) return 0 ;; esac
  target_ok "$ro_v"
}
# own_match REL TOKEN BASE: does owns.conf TOKEN (relative to BASE) cover REL? A token ending in / covers
# its subtree, any other token one exact path; NNN in a token stands for three digits.
own_match() {
  om_t=$3$2
  case "$om_t" in */) case "$1" in "$om_t"*) return 0 ;; esac; return 1 ;; esac
  om_p=$(printf '%s' "$om_t" | sed 's/NNN/[0-9][0-9][0-9]/g')
  # shellcheck disable=SC2254 # om_p is a pattern on purpose (NNN); tokens contain no other glob characters
  case "$1" in $om_p) return 0 ;; esac; return 1
}
# knowledge_stage (A159): is the active run in the knowledge step, CODE_DONE not yet DONE, or FAILED/BLOCKED? Any doubt: no.
knowledge_stage() {
  ks_s=$(sh "$agent" summary "$act" 2>/dev/null | sed -n 's/^STATUS: \([A-Z_]*\) (handoff \([A-Za-z_]*\),.*/\1 \2/p')
  case "$ks_s" in "CODE_DONE DONE") return 1 ;; CODE_DONE\ *|FAILED\ *|BLOCKED\ *) return 0 ;; esac
  return 1
}
# path_ok REL: may the caller write REL now? Prints the reason on refusal.
path_ok() {
  po=$1; run=.agents/runs/$act
  if [ -z "$tasks_dir" ]; then
    if hcfg_load; then tasks_dir=$hc_tasks; else tasks_dir=$(sh "$agent" config-get tasks.dir 2>/dev/null) || tasks_dir=''; fi
    tasks_dir=${tasks_dir%/}; [ -n "$tasks_dir" ] || tasks_dir=.agents/tasks
  fi
  case "$po" in @outside) return 0 ;; @unknown) echo "cannot resolve the target path"; return 1 ;; esac
  if always_protected "$po"; then echo "$po wires the git hooks; it is never changed by an agent"; return 1; fi
  # The lead writes dispatch assignments (DISPATCH.md); nothing else under .agents/local/.
  case "$role:$po" in lead:.agents/local/assignments/*) return 0 ;; esac
  # Scratch files live in the run folder (D10, A56): writable by every role, never gate input.
  case "$po" in "$run"/scratch/*) return 0 ;; esac
  case "$po" in
    .claude/settings.json|.claude/settings.local.json|.codex/hooks.json|.codex/config.toml|.agents/hooks|.agents/hooks/*)
      echo "$po holds the runtime hooks; it is never edited during a run"; return 1 ;;
    "$run"/RUN.yaml|"$run"/LEDGER.log|"$run"/mutation_budget|"$run"/gates/*|"$run"/approvals/*|"$run"/waivers/*|"$run"/questions/*|"$run"/decisions/*|"$run"/dispatch/*|"$run"/worker-evidence/*|"$run"/ci-fix/*|"$run"/results/*.result.md|"$run"/results/dispatch-*|.agents/local|.agents/local/*)
      echo "$po is written only by agent.sh and the runtime hooks"; return 1 ;;
  esac
  case "$role" in
    lead)
      case "$po" in
        "$run"/TASK.md|"$run"/PLAN.md|"$run"/EVIDENCE.md|"$run"/COMPLETION_REPORT.md|"$run"/amendments/*|"$tasks_dir"/*) return 0 ;;
      esac
      # A159: the knowledge step (after CODE_DONE, or a FAILED/BLOCKED run) needs the wiki and the design documents:
      # knowledge scope and design_docs paths only, nowhere else; any other stage keeps the prohibition. Fail closed.
      if knowledge_stage && sh "$agent" in-knowledge-scope "$po" >/dev/null 2>&1; then return 0; fi
      echo "the lead writes only run artifacts (TASK.md PLAN.md EVIDENCE.md COMPLETION_REPORT.md amendments/), task files and .agents/local/assignments/ while run $act is active, plus knowledge scope and design_docs paths (docs/design/ docs/adr/ docs/wiki/ docs/product/) in the knowledge step after CODE_DONE (A159); product changes go through the implementer (D2)"; return 1 ;;
  esac
  # Specialists: the role's owned paths from .agents/owns.conf (generated; `<role> <token>...`).
  # Token: run-relative path; `/<path>` project-relative (own_match); PRODUCT_SCOPE = the frozen PLAN.md
  # scope paths (a path ending in / covers its subtree) plus the run dir. Without a line for the role:
  # implementer PRODUCT_SCOPE, task_author the run dir and tasks.dir, everyone else the run dir only.
  # Implementer and designer subagents write outside the run dir only inside their window.
  po_own=''
  [ -f "$sroot/.agents/owns.conf" ] && po_own=$(awk -v r="$role" '$1 == r { $1 = ""; print; exit }' "$sroot/.agents/owns.conf")
  if [ -z "$po_own" ]; then
    case "$role" in implementer) po_own=PRODUCT_SCOPE ;; task_author) po_own="@run /$tasks_dir/" ;; *) po_own=@run ;; esac
  fi
  po_hit=no
  for po_t in $po_own; do
    case "$po_t" in
      @run) case "$po" in "$run"/*) po_hit=yes ;; esac ;;
      PRODUCT_SCOPE)
        case "$po" in "$run"/*) po_hit=yes ;; esac
        # shellcheck disable=SC2013 # scope paths contain no whitespace (agent.sh scope format)
        for po_s in $(awk '/^scope:$/ { i = 1; next } i && /^---$/ { exit } i && /^  - path: / { sub(/^  - path: /, ""); gsub(/["\047]/, ""); print }' "$sroot/$run/PLAN.md" 2>/dev/null); do
          case "$po_s" in */) case "$po" in "$po_s"*) po_hit=yes ;; esac ;; *) [ "$po" != "$po_s" ] || po_hit=yes ;; esac
        done ;;
      /*) ! own_match "$po" "${po_t#/}" '' || po_hit=yes ;;
      *) ! own_match "$po" "$po_t" "$run/" || po_hit=yes ;;
    esac
    [ "$po_hit" = no ] || break
  done
  if [ "$po_hit" = no ]; then echo "$po is outside the paths role $role owns ($po_own; .agents/owns.conf, PLAN.md scope)"; return 1; fi
  case "$role:$sub:$po" in
    implementer:yes:"$run"/*|designer:yes:"$run"/*) ;;
    implementer:yes:*|designer:yes:*)
      # A headless specialist (dispatch.sh, also the failover codex -> claude) has AGENT_ROLE in the hook's
      # environment: dispatch.sh opened its window before starting it; SubagentStart does not run in that process.
      [ -f "$local_dir/windows/$aidf" ] || [ "$envrole" = "$role" ] || { echo "no $role window is open for this subagent (SubagentStart window-open failed or was skipped); the change would be unattributed"; return 1; } ;;
  esac
  return 0
}

# nr_path_ok REL (A169): may the lead (main session) write REL while NO run is active? The ban on product code (D2) does
# not end with a run: a "fix this" outside a run goes to a light run (/proofline run <text>), so push approval can bind
# to a run. Allowed: task files (tasks.dir), the control plane (.agents/), the knowledge scope and design documents
# (docs/design/ docs/adr/ docs/wiki/ docs/product/: task, product, wiki, docs commands write them from the main session),
# files git ignores (build output, caches, local env) and paths outside the project (the shell guard judges those).
nr_path_ok() {
  np=$1
  if [ -z "$tasks_dir" ]; then
    if hcfg_load; then tasks_dir=$hc_tasks; else tasks_dir=$(sh "$agent" config-get tasks.dir 2>/dev/null) || tasks_dir=''; fi
    tasks_dir=${tasks_dir%/}; [ -n "$tasks_dir" ] || tasks_dir=.agents/tasks
  fi
  case "$np" in @outside) return 0 ;; @unknown) echo "cannot resolve the target path"; return 1 ;; esac
  # State only agent.sh and the runtime hooks write (the in-run set of path_ok, for every run), the runtime hooks, and
  # .agents/local/ except the lead's own working folders: a hand-written approval or ledger line must never exist.
  case "$np" in
    .agents/runs/*/RUN.yaml|.agents/runs/*/LEDGER.log|.agents/runs/*/mutation_budget|.agents/runs/*/gates/*|.agents/runs/*/approvals/*|.agents/runs/*/waivers/*|.agents/runs/*/questions/*|.agents/runs/*/decisions/*|.agents/runs/*/dispatch/*|.agents/runs/*/worker-evidence/*|.agents/runs/*/ci-fix/*|.agents/runs/*/results/*.result.md|.agents/runs/*/results/dispatch-*|.agents/hooks|.agents/hooks/*)
      echo "$np is written only by agent.sh and the runtime hooks"; return 1 ;;
    .claude/settings*|.codex/*|.agents/scripts/*|.agents/config.yaml|.agents/ecosystems.json|.agents/ecosystems.tsv|.agents/ecosystems.mjs)
      echo "$np holds the runtime hooks, the control-plane scripts, the configuration or the ecosystem definition (the risky-path and dependency sets, A174); the lead never edits it itself (A169)"; return 1 ;;
    .agents/local/scratch/*|.agents/local/explain/*|.agents/local/assignments/*|.agents/local/product-spec/*|.agents/local/product-discovery/*|.agents/local/intent-grill/*|.agents/local/task-author/*) return 0 ;;
    .agents/local|.agents/local/*) echo "$np is runtime state (approvals, prompts, windows, records); the lead writes under .agents/local/ only in scratch/, explain/, assignments/ and the standalone skill folders (product-spec, product-discovery, intent-grill, task-author)"; return 1 ;;
  esac
  case "$np" in "$tasks_dir"/*|.agents/*) return 0 ;; esac
  ! git -C "$sroot" check-ignore -q -- "$np" 2>/dev/null || return 0
  sh "$agent" in-knowledge-scope "$np" >/dev/null 2>&1 && return 0
  # product.dir (product-spec output) may be set to another folder than docs/product
  if hcfg_load; then np_pd=$hc_product; else np_pd=$(sh "$agent" config-get product.dir 2>/dev/null) || np_pd=''; fi
  np_pd=${np_pd%/}
  case "$np_pd" in ''|.|/*|*..*) ;; *) case "$np" in "$np_pd"/*) return 0 ;; esac ;; esac
  echo "no run is active, and the lead never edits product files itself (D2, A169). Propose a light run (TRIVIAL or STANDARD) with '/proofline run <text>' and let the implementer make the change; the push approval then binds to that run. Without a run the lead writes only task files ($tasks_dir/), .agents/, the knowledge scope (docs/design/ docs/adr/ docs/wiki/ docs/product/) and git-ignored files"
  return 1
}
# nr_bash_guard (A169): the shell writes the scanner found (W records in $tmp/scan), judged by nr_path_ok. Only for the
# lead's main session while no run is active; same heuristic limits as the in-run write rule.
nr_bash_guard() {
  while IFS= read -r rec; do
    k=${rec%%"$TAB"*}; [ "$k" = W ] || continue
    v=$(printf '%s' "${rec#*"$TAB"}" | tr '\002' '\n')
    [ -n "$v" ] || continue
    case "$v" in /dev/*) continue ;; esac
    case "$v" in
      *'$'*|*'*'*|*'?'*|*'['*)
        # shellcheck disable=SC2016 # literal $TMPDIR in the command text
        case "$v" in /tmp/*|/private/tmp/*|'$TMPDIR'/*|'${TMPDIR'*) continue ;; esac
        deny "the command writes '$v', which cannot be resolved, and no run is active (A169): the lead edits no product file itself. Propose a light run with '/proofline run <text>', or write an allowed path literally" ;;
    esac
    why=$(nr_path_ok "$(relpath "$v")") || deny "the command writes '$v': $why"
  done < "$tmp/scan"
}

# scan_cmd: reads shell command text, prints one record per finding, "<K><TAB><value>" (newlines in a value
# as \002). A heuristic tokenizer, not a parser: quotes are removed (agent.s""h = agent.sh), heredoc bodies
# skipped, `sh|bash -c STRING`, "$(...)" and "`...`" inside double quotes are scanned as nested commands.
#   W path   the command writes path (redirection, tee, sed -i, perl -i, cp/mv/install/rsync/ln target, mv
#            sources, touch/rm/truncate/unlink/rmdir/shred, chmod/chown/chgrp operands, dd of=)
#   E path   additionally, for each operand of rm and unlink: the command deletes path (see erasable)
#   P word   an operand (program text included) of a command that edits files in place (sed -i, perl/ruby -i,
#            awk -i inplace, patch); only the read-role guard reads it (A143)
#   Q word   an operand of an editor run from a script (ed, ex, vi, vim); only the read-role guard reads it (A143)
#   L arg    an ln operand (link or link target)
#   A l sub  an agent.sh invocation; l = 1 when the subcommand word is literal
#   R value  an AGENT_ROLE=value assignment (anywhere: prefix, env, export, plain word)
#   N word   a nested headless runtime (claude -p/--print, codex exec|e)
#   X why    refused while a run is active (non-literal command word or script, eval, env -S, a shell
#            reading stdin, indirect AGENT_ROLE, nesting beyond one level, copies of agent.sh)
#   B why    a git hook bypass; refused always
#   C word args   every simple command: its command word and its arguments joined with \003 (database guard)
#   F path   the command word is a literal path (./x, scripts/run): the file the command runs (kill guard, A161)
#   V what   a fact about the next C record for the kill guard: `xargs` (it runs as an xargs command, its arguments
#            come from stdin too), `psub` (a process substitution <(...) follows), `cwd\tDIR` (a `cd DIR` came before it)
#   (A171) A NAME=value word the same command line assigns on its own, in sequence (`ID=T-6; sh agent.sh next $ID`), with a
#            literal value of plain characters, is substituted into the later arguments of a command, so $ID is read as T-6. Never
#            the command word or the script path, never a value from a substitution, `read`, a loop or a subshell.
#   H cmd\003path\003body   a here-document: the command it feeds, the file that command writes (cat > f <<EOF; empty
#            otherwise) and the body (newlines as \002, at most 200000 characters); the body of an unquoted
#            delimiter is also scanned for $(...) and backtick commands, which the shell runs (A161)
scan_cmd() {
  awk 'BEGIN { RS = "\001" }
  function out(k, v) { if ((k == "W" || k == "E" || k == "P" || k == "Q" || k == "F") && cwdp != "" && substr(v, 1, 1) != "/" && substr(v, 1, 1) != "~") v = cwdp "/" v; gsub(/\n/, "\002", v); print k "\t" v }
  function base(x) { sub(/.*\//, "", x); return x }
  function isassign(x) { return x ~ /^[A-Za-z_][A-Za-z0-9_]*=/ }
  function push(t, d) {
    if (d > 4) { out("B", "commands nested more than four levels deep"); return }
    if (d > 1) out("X", "a nested shell command inside a nested shell command")
    qs[++qn] = t; qd[qn] = d
  }
  function pushraw(t, d) {   # a command inside a here-document body: no nesting complaint, only the depth limit
    if (d > 4) { out("B", "commands nested more than four levels deep"); return }
    qs[++qn] = t; qd[qn] = d
  }
  function hdsubs(b,   p, m, ch, e) {   # $(...) and backtick commands in an unquoted here-document body
    m = length(b); p = 1
    while (p <= m) {
      ch = substr(b, p, 1)
      if (ch == "\\") { p += 2; continue }
      if (ch == "$" && substr(b, p + 1, 1) == "(") { e = mparen(b, p + 1); pushraw(substr(b, p + 2, e - p - 2), dep + 1); p = e + 1; continue }
      if (ch == "`") { e = index(substr(b, p + 1), "`"); if (!e) e = m - p + 1; pushraw(substr(b, p + 1, e - 1), dep + 1); p += e + 1; continue }
      p++
    }
  }
  function mparen(s, p,   d, c2, m) { d = 0; m = length(s); for (; p <= m; p++) { c2 = substr(s, p, 1); if (c2 == "(") d++; else if (c2 == ")") { d--; if (!d) return p } } return m }
  function endword() {
    if (!have) return
    if (redir) { out("W", cur); lastw = (substr(cur, 1, 1) != "/" && cwdp != "") ? cwdp "/" cur : cur; redir = 0 } else if (inredir) { if (inredir == 2) { hdn++; hdw[hdn] = cur; hdq[hdn] = quo; hdt[hdn] = hdd } else out("C", "<\t" cur); inredir = 0 } else if (dup) { dup = 0 } else { w[++nw] = cur; L[nw] = lit; L0[nw] = lit; dynw[nw] = dyn }
    cur = ""; have = 0; lit = 1; quo = 0; dyn = 0
  }
  function takesval(wr, x) {
    if (wr == "env") return x ~ /^(-u|--unset|-C|--chdir)$/
    if (wr == "sudo" || wr == "doas") return x ~ /^-[ugCDhpRrTt]$/
    if (wr == "nice") return x == "-n"
    if (wr == "xargs") return x ~ /^-[IiLlnPsdEa]$/
    if (wr == "timeout") return x ~ /^(-s|-k|--signal|--kill-after)$/
    if (wr == "stdbuf") return x ~ /^-[ioe]$/
    if (wr == "ionice") return x ~ /^-[cnp]$/
    if (wr == "exec") return x == "-a"
    return 0
  }
  function gitcfg(v) { v = tolower(v); if (v ~ /hookspath/ || v ~ /^include/ || v ~ /^alias\./) out("B", "git -c " v) }
  function gitchk(k,   j, x, lx, sc, m, ch) {
    sc = ""
    for (j = k + 1; j <= nw; j++) {
      x = w[j]; lx = tolower(x)
      if (sc == "") {
        if (x == "-c" || lx == "--config-env") { gitcfg(w[j + 1]); j++; continue }
        if (x ~ /^-c./) { gitcfg(substr(x, 3)); continue }
        if (lx ~ /^--config-env=/) { gitcfg(substr(x, 14)); continue }
        if (lx ~ /^--(git-dir|exec-path)/) { out("B", "git " x); continue }
        if (x == "-C" || lx == "--namespace" || lx == "--work-tree" || lx == "--super-prefix") { j++; continue }
        if (x ~ /^-/) continue
        sc = lx; continue
      }
      if (lx ~ /^--no-v/) out("B", "git " sc " " x)
      if (sc == "commit") {
        if (x ~ /^(-m|-F|-C|-c|-t|--author|--date|--file|--message|--template|--reuse-message|--reedit-message|--fixup|--squash|--trailer|--cleanup|--pathspec-from-file)$/) { j++; continue }
        if (x ~ /^-[A-Za-z]/ && x !~ /^--/) {
          for (m = 2; m <= length(x); m++) { ch = substr(x, m, 1); if (ch ~ /[mFCct]/) break; if (ch == "n" || ch == "N") { out("B", "git commit " x); break } }
        }
      }
      if (sc == "config" && (lx ~ /^(core|include|includeif|alias)(\.|$)/ || lx ~ /hookspath/ || x == "-e" || lx == "--edit")) out("B", "git config " x)
    }
  }
  function script(j) {   # operand j of sh/bash/./source is the script path
    if (!L0[j]) out("X", "the script path " w[j] " is not literal")
    else if (base(w[j]) == "agent.sh" && j + 1 <= nw) out("A", L[j + 1] "\t" w[j + 1])
  }
  function vsafe(v) { return v != "" && v ~ /^[A-Za-z0-9_.\/:@%+,=-]+$/ }
  function vexpand(t,   o, p, e, nm) {   # t with every $NAME / ${NAME} replaced by a known literal value; fails (xfail) on anything else
    xfail = 0; o = ""
    if (ifsset) { xfail = 1; return t }
    while ((p = index(t, "$")) > 0) {
      o = o substr(t, 1, p - 1); t = substr(t, p + 1)
      if (substr(t, 1, 1) == "{") { e = index(t, "}"); if (!e) { xfail = 1; return t }; nm = substr(t, 2, e - 2); t = substr(t, e + 1) }
      else if (match(t, /^[A-Za-z_][A-Za-z0-9_]*/)) { nm = substr(t, 1, RLENGTH); t = substr(t, RLENGTH + 1) }
      else { xfail = 1; return t }
      if (!(nm in kvs)) { xfail = 1; return t }
      o = o kvs[nm]
    }
    return o t
  }
  function vclear(   a) { for (a in kvs) delete kvs[a] }
  function endcmd(   h) {   # a here-document belongs to the command it was written on: its word and the file it writes
    cc = ""; endcmd0()
    for (h = hdfirst; h <= hdn; h++) { hdc[h] = cc; hdp[h] = lastw }
    hdfirst = hdn + 1; lastw = ""; prevsep = sep
  }
  function endcmd0(   k, c, j, x, wr, tdone, viax, nopt, tgt, hasc, hass, first, refm, allas, nm, vv) {
    if (nw == 0) return
    k = 1; wr = ""; tdone = 0; viax = 0
    while (k <= nw) {
      x = w[k]
      if (isassign(x)) { k++; continue }
      if (wr != "" && x ~ /^-/) {
        if (wr == "env" && x ~ /^(-[A-Za-z]*S|--split-string)/) out("X", "env -S runs a split string")
        if (takesval(wr, x)) k++
        k++; continue
      }
      if (wr == "timeout" && !tdone) { tdone = 1; k++; continue }
      if (base(x) ~ /^(sudo|doas|env|command|builtin|exec|nohup|time|nice|ionice|stdbuf|timeout|xargs|then|do|else|elif|if|while|until|!|\{|\})$/) { wr = base(x); tdone = 0; if (wr == "xargs") viax = 1; k++; continue }
      break
    }
    # A171: literal variables. An assignment-only command (every word NAME=value), first in its list and ended by `;`, a newline or
    # `&&`, outside parentheses, records NAME = value when the value is plain and literal (or built from known variables); any other
    # way a variable can change (a prefix or export assignment, read, unset, a loop, set, local, a non-literal value) forgets it.
    allas = (nw > 0)
    for (j = 1; j <= nw; j++) if (!isassign(w[j])) allas = 0
    for (j = 1; j <= nw; j++) if (w[j] ~ /^IFS\+?=/) { ifsset = 1; vclear() }   # once IFS changes, word splitting is unknowable
    if (allas) {
      for (j = 1; j <= nw; j++) {
        nm = w[j]; sub(/=.*/, "", nm); vv = w[j]; sub(/^[^=]*=/, "", vv)
        if (!L[j]) { vv = vexpand(vv); if (xfail || dynw[j]) vv = "" }
        if (prevsep == "p" && (sep == "p" || sep == "a") && pd <= 0 && vsafe(vv)) kvs[nm] = vv; else delete kvs[nm]
      }
    } else {
      for (j = 1; j <= nw; j++) {
        if (isassign(w[j])) { nm = w[j]; sub(/=.*/, "", nm); delete kvs[nm] }
        else if (w[j] ~ /^[A-Za-z_][A-Za-z0-9_]*\+=/) vclear()
      }
    }
    # k is the command word (nw + 1 when there is none). A NAME=value word before it is an environment prefix and
    # gets a C env record; one after it is an argument (ps -o pid=, dd of=x) and is not one (A161). AGENT_ROLE and
    # the git variables are checked on every word, a prefix or not.
    if (k <= nw) {
      c = base(w[k])
      if (c ~ /^(read|unset|getopts|mapfile|readarray|declare|typeset|local|set|shift|select|for|case|wait|trap|eval|source|\.|let)$/) vclear()
      if (c == "printf") for (j = k + 1; j <= nw; j++) if (w[j] ~ /^-v/) vclear()
      for (j = k + 1; j <= nw; j++) if (!L[j] && !dynw[j]) { vv = vexpand(w[j]); if (!xfail) { w[j] = vv; L[j] = 1 } }
    }
    for (j = 1; j <= nw; j++) {
      x = w[j]
      if (isassign(x)) {
        c = x; sub(/=.*/, "", c)
        if (j < k) out("C", "env\t" x)
        if (c == "AGENT_ROLE") out("R", substr(x, 12))
        if (c ~ /^GIT_CONFIG/ || c == "GIT_DIR" || c == "GIT_COMMON_DIR" || c == "GIT_EXEC_PATH") out("B", "setting " c " can disable or redirect the git hooks")
        continue
      }
      if (x !~ /AGENT_ROL/) continue
      c = x; gsub(/\$\{?AGENT_ROLE/, "", c); if (c !~ /AGENT_ROL/) continue
      if (x == "AGENT_ROLE" && (base(w[1]) == "export" || base(w[1]) == "unset")) continue
      out("X", "AGENT_ROLE is set or named indirectly (" x ")")
    }
    if (k > nw) { nw = 0; return }
    if (!L[k]) out("X", "the command word " w[k] " is not literal")
    c = base(w[k]); cc = c
    ca = ""; for (j = k + 1; j <= nw; j++) ca = ca (j > k + 1 ? "\003" : "") w[j]
    if (L[k] && w[k] ~ /\//) out("F", w[k])
    if (viax) out("V", "xargs")
    if (cwdp != "") out("V", "cwd\t" cwdp)
    out("C", c "\t" ca)
    # cd: later relative write targets in this command line resolve against it (heuristic, like the rest)
    if (c == "cd") {
      cdkey = qn SUBSEP k SUBSEP nw SUBSEP w[k + 1]
      if (cdkey != lastcd) {
        lastcd = cdkey
        if (k + 1 <= nw && L[k + 1] && w[k + 1] != "-") { d0 = w[k + 1]; cwdp = (substr(d0, 1, 1) == "/" || cwdp == "") ? d0 : cwdp "/" d0 } else cwdp = ""
      }
    }
    if (c == "eval") out("X", "eval runs an unparsed string")
    else if (c ~ /^(sh|bash|dash|zsh|ksh|ash|mksh|posh|yash)$/) {
      hasc = 0; hass = 0
      for (j = k + 1; j <= nw; j++) {
        x = w[j]
        if (x ~ /^[-+][oO]$/ || x == "--rcfile" || x == "--init-file") { j++; continue }
        if (x == "--") { j++; break }
        if (x ~ /^--/) continue
        if (x ~ /^[-+][A-Za-z]+$/) { if (x ~ /^-[A-Za-z]*c/) hasc = 1; if (x ~ /^-[A-Za-z]*s/) hass = 1; continue }
        break
      }
      if (hasc) { if (j <= nw) push(w[j], dep + 1) }
      else if (hass || j > nw) out("X", "a shell reading its commands from stdin")
      else script(j)
    }
    else if (c == "." || c == "source") { if (k + 1 <= nw) script(k + 1) }
    else if (c == "agent.sh") { if (k + 1 <= nw) out("A", L[k + 1] "\t" w[k + 1]) }
    else if (c == "claude") { for (j = k + 1; j <= nw; j++) if (w[j] == "-p" || w[j] == "--print") { out("N", "claude " w[j]); break } }
    else if (c == "codex") { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/) { if (w[j] == "exec" || w[j] == "e") out("N", "codex " w[j]); break } }
    else if (c == "git") gitchk(k)
    else if (c == "tee") { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/) { out("W", w[j]); if (lastw == "") lastw = (substr(w[j], 1, 1) != "/" && cwdp != "") ? cwdp "/" w[j] : w[j] } }
    else if (c ~ /^(touch|rm|truncate|unlink|rmdir|shred)$/) {
      for (j = k + 1; j <= nw; j++) {
        if (w[j] ~ /^-/) { if ((c == "truncate" && w[j] ~ /^-[sr]$/) || (c == "touch" && w[j] ~ /^-[tdr]$/)) j++; continue }
        out("W", w[j]); if (c ~ /^(rm|unlink)$/) out("E", w[j])
      }
    }
    else if (c ~ /^(chmod|chown|chgrp)$/) {
      first = 1; refm = 0
      for (j = k + 1; j <= nw; j++) {
        x = w[j]
        if (x ~ /^--reference/) { refm = 1; continue }
        if (x ~ /^--/ || x ~ /^-[RfvchHLP]+$/) continue
        if (first && !refm) { first = 0; continue }   # mode / owner operand
        out("W", x)
      }
    }
    else if (c ~ /^(ed|ex|vi|vim|view|nvim)$/) {
      for (j = k + 1; j <= nw; j++) {
        if (w[j] ~ /^(-c|-S|-u|-U|-i|-w|-W|--cmd)$/) { j++; continue }
        if (w[j] !~ /^[-+]/ && w[j] != "") out("Q", w[j])
      }
    }
    else if (c ~ /^(patch|gpatch)$/) { out("P", "."); for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/ && w[j] != "") out("P", w[j]) }
    else if (c ~ /^(ruby|awk|gawk|mawk)$/) {
      hasc = 0
      for (j = k + 1; j <= nw; j++) {
        if (c == "ruby" ? w[j] ~ /^-[0adlnpsSwWxXvuT]*i/ : (w[j] ~ /^-i?inplace/ || w[j] == "--include=inplace" || ((w[j] == "-i" || w[j] == "--include") && w[j + 1] ~ /^inplace/))) hasc = 1
      }
      if (hasc) { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/ && w[j] != "") out("P", w[j]); if (nw > k + 1) out("W", w[nw]) }
    }
    else if (c == "sed" || c == "gsed" || c == "perl") {
      for (j = k + 1; j <= nw; j++) if (w[j] ~ /^-[0adlnpsSwWxXvuTEe]*i/ || w[j] ~ /^--in-place/) { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/ && w[j] != "") out("P", w[j]); break }
      if (c == "sed") for (j = k + 1; j <= nw; j++) { if (w[j] ~ /^-[A-Za-z]*i[A-Za-z-]+$/) { out("S", "sed " w[j]); break } if (j < nw && w[j] ~ /^-[A-Za-z]*i$/ && w[j + 1] ~ /^-[A-Za-z-]/) { out("S", "sed " w[j] " " w[j + 1]); break } } for (j = k + 1; j <= nw; j++) if (w[j] ~ /^-[A-Za-z]*i/ || w[j] ~ /^--in-place/) { if (nw > k + 1) out("W", w[nw]); break } }
    else if (c ~ /^(cp|mv|install|ln|rsync)$/) {
      nopt = 0; tgt = ""
      for (j = k + 1; j <= nw; j++) {
        x = w[j]
        if (x == "-t" || x == "--target-directory") { tgt = w[++j]; continue }
        if (x ~ /^--target-directory=/) { tgt = substr(x, 20); continue }
        if (x ~ /^-/) { if ((c == "install" && x ~ /^-[mogS]$/) || (c == "rsync" && x ~ /^-[ef]$/)) j++; continue }
        op[++nopt] = x
        if (base(x) == "agent.sh") out("X", c " of agent.sh")
      }
      if (c == "ln") for (j = 1; j <= nopt; j++) out("L", op[j])
      if (c == "mv") for (j = 1; j < nopt + (tgt != ""); j++) out("W", op[j])
      if (tgt != "") out("W", tgt); else if (nopt >= 2) out("W", op[nopt]); else if (c == "ln" && nopt == 1) out("W", base(op[1]))
    }
    else if (c == "dd") { for (j = k + 1; j <= nw; j++) if (w[j] ~ /^of=/) out("W", substr(w[j], 4)) }
    nw = 0
  }
  function parse(s,   n, i, ch, q, e, line, k2) {
    n = length(s); i = 1; q = ""; cur = ""; have = 0; lit = 1; hdn = 0; hdfirst = 1; hdbody = 0; pd = 0; quo = 0; hdd = 0; lastw = ""; nw = 0; redir = 0; inredir = 0; dup = 0
    vclear(); prevsep = "p"; sep = "p"; dyn = 0
    while (i <= n) {
      ch = substr(s, i, 1)
      if (q == "\047") { if (ch == "\047") q = ""; else cur = cur ch; i++; continue }
      if (q == "\"") {
        if (ch == "\\" && i < n) { cur = cur substr(s, i + 1, 1); i += 2; continue }
        if (ch == "\"") { q = ""; i++; continue }
        if (ch == "$" && substr(s, i + 1, 1) == "(") { e = mparen(s, i + 1); push(substr(s, i + 2, e - i - 2), dep + 1); cur = cur substr(s, i, e - i + 1); lit = 0; i = e + 1; continue }
        if (ch == "`") { e = index(substr(s, i + 1), "`"); if (!e) e = n - i + 1; push(substr(s, i + 1, e - 1), dep + 1); lit = 0; dyn = 1; i += e + 1; continue }
        if (ch == "$") lit = 0
        cur = cur ch; i++; continue
      }
      if (ch == "\047" || ch == "\"") { q = ch; have = 1; quo = 1; i++; continue }
      if (ch == "\\" && i < n) { if (substr(s, i + 1, 1) != "\n") { cur = cur substr(s, i + 1, 1); have = 1; quo = 1 } i += 2; continue }
      if (ch == "#" && !have && cur == "") { e = index(substr(s, i), "\n"); i = e ? i + e - 1 : n + 1; continue }   # a comment runs to the end of the line
      if (ch == " " || ch == "\t") { endword(); i++; continue }
      if (ch == "\n") {
        sep = "p"; endword(); endcmd(); i++
        for (hi = hdbody + 1; hi <= hdn; hi++) {   # the bodies follow the line, in order, up to their delimiter line
          body = ""
          while (i <= n) {
            e = index(substr(s, i), "\n"); line = (e ? substr(s, i, e - 1) : substr(s, i)); i = (e ? i + e : n + 1)
            if (hdt[hi]) sub(/^\t+/, "", line)   # only <<- ignores leading tabs of the delimiter line
            if (line == hdw[hi]) break
            if (length(body) < 200000) body = body line "\n"
          }
          out("H", hdc[hi] "\003" hdp[hi] "\003" body)
          if (!hdq[hi]) hdsubs(body)
        }
        hdbody = hdn
        continue
      }
      if (ch == "|" && nw == 0 && pd <= 0 && match(substr(s, i + 1), /^[^ \t\n;&|()<>]*(\|[^ \t\n;&|()<>]*)*\)/)) { i += RLENGTH + 1; cur = ""; have = 0; continue }   # a case label with alternatives (kill|pkill)
      if (ch == ")" && pd <= 0) { cur = ""; have = 0; nw = 0; i++; continue }   # a case label (stop|kill) is not a command
      if (ch == ";" || ch == "|" || ch == "(" || ch == ")" || ch == "`") { if (ch == "(") pd++; else if (ch == ")") pd--; sep = (ch == ";") ? "p" : "o"; endword(); endcmd(); i++; continue }
      if (ch == "&") { if (substr(s, i + 1, 1) == ">") { endword(); i += 2; if (substr(s, i, 1) == ">") i++; redir = 1; continue } if (substr(s, i + 1, 1) == "&") { sep = "a"; endword(); endcmd(); i += 2; continue } sep = "o"; endword(); endcmd(); i++; continue }
      if (ch == ">") {
        if (have && cur ~ /^[0-9]+$/) { cur = ""; have = 0 } else endword()
        i++; if (substr(s, i, 1) == ">" || substr(s, i, 1) == "|") i++
        if (substr(s, i, 1) == "&") { i++; dup = 1; continue }
        if (substr(s, i, 1) == "(") continue
        redir = 1; continue
      }
      if (ch == "<") {
        if (have && cur ~ /^[0-9]+$/) { cur = ""; have = 0 } else endword()
        k2 = 0; while (substr(s, i, 1) == "<") { i++; k2++ }
        hdd = (substr(s, i, 1) == "-"); if (hdd) i++
        if (substr(s, i, 1) == "&") { i++; dup = 1; continue }
        if (substr(s, i, 1) == "(") { inredir = 0; out("V", "psub"); continue }   # < <(cmd): a process substitution, not a file
        inredir = (k2 == 2) ? 2 : 1; continue
      }
      if (ch == "$" && substr(s, i + 1, 2) == "((") { e = mparen(s, i + 1); cur = cur substr(s, i, e - i + 1); have = 1; lit = 0; i = e + 1; continue }
      if (ch == "$") lit = 0
      cur = cur ch; have = 1; i++
    }
    sep = "p"; endword(); endcmd()
  }
  { qn = 1; qs[1] = $0; qd[1] = 0; for (qi = 1; qi <= qn; qi++) { dep = qd[qi]; parse(qs[qi]) } }'
}

# tmp_is_scratch_root: true when $TMPDIR itself is /tmp (then /tmp is the scratch space and nothing is denied).
tmp_is_scratch_root() {
  case "${TMPDIR:-}" in ''|/tmp|/tmp/*|/private/tmp|/private/tmp/*) return 0 ;; esac
  return 1
}
# stray_tmp_path TEXT: the first /tmp (or /private/tmp) path in TEXT that is not inside the project root.
stray_tmp_path() {
  printf '%s' "$1" | grep -Eo '(/private)?/tmp(/[^[:space:]"'"'"';|&)<>]*)?' > "$tmp/tmp-paths" || :
  while IFS= read -r sp_p; do
    sp_q=${sp_p#/private}
    sp_r=${root#/private}
    case "$sp_q" in "$sp_r"|"$sp_r"/*) continue ;; esac
    # A171: the runtime's own background task output (/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output) is read-only
    # evidence the lead is told to read; it is allowed unless the same command writes to it (any W/E/P/Q/L record names it).
    # Exactly /tmp/claude-<uid>/<project>/<session>/tasks/<file>.output, and only as the operand of a read-only reader
    # (cat, head, tail, grep, wc, sed -n): never run, sourced or fed to a shell.
    if printf '%s\n' "$sp_p" | grep -Eq '^(/private)?/tmp/claude-[0-9]+/[^/]+/[^/]+/tasks/[^/]+\.output$' && ! printf '%s\n' "$sp_p" | grep -Fq '..'; then
      awk -F"$TAB" -v p="$sp_p" '
        $1 ~ /^[WEPQL]$/ && $2 == p { bad = 1 }
        $1 == "C" && index($3, p) > 0 {
          if ($2 !~ /^(cat|head|tail|grep|wc|sed)$/) bad = 1
          else if ($2 == "sed") { n = split($3, a, "\003"); if (!(n == 3 && a[1] == "-n" && a[2] ~ /^([0-9]+(,[0-9]+)?|\$)p$/ && a[3] == p)) bad = 1 }
        }
        END { exit bad }' "$tmp/scan" 2>/dev/null && continue
    fi
    printf '%s\n' "$sp_p"; return 0
  done < "$tmp/tmp-paths"
  return 0
}

# --- database guard (A40, A50) -----------------------------------------------------------------
# Whenever proofline is installed (a run open or not: a task author or an explorer works before any run) no agent (lead included) reads, copies, queries or writes a database file, runs a SQL
# client against one, or runs a migration/seed command; destructive steps run in no environment before the
# user's approval. The only database an agent may meet is a test suite's own throwaway database: in memory or a
# scratch file under $TMPDIR/tmp outside the project. Paths, clients and migrate commands come from the config
# (`agent.sh db-config`, language-independent defaults). A heuristic like the rest: token and command-word
# matching on the command text; a script that opens a database by itself is caught after the fact by
# `agent.sh db-check` (size and mtime of every database file, compared at freeze and each handoff).
# hcfg_load: ask agent.sh hook-config ONCE per event (A188) for tasks.dir, canonical_branch, product.dir and the database settings; the
# answers are in hc_tasks hc_branch hc_product hc_paths hc_clients hc_migrate. Fails (the callers then ask for each value as before)
# when agent.sh does not know the command or refuses it for this role (hook-config is allowed for the same roles as db-config).
hcfg_state=''
hcfg_load() {
  case $hcfg_state in ok) return 0 ;; no) return 1 ;; esac
  hcfg_state=no
  [ "$installed" = yes ] && sh "$agent" hook-config > "$tmp/hcfg" 2>/dev/null || return 1
  hc_tasks='' hc_branch='' hc_product='' hc_paths='' hc_clients='' hc_migrate=''
  while IFS= read -r hc_l || [ -n "$hc_l" ]; do
    case $hc_l in
      tasks_dir=*) hc_tasks=${hc_l#tasks_dir=} ;; canonical_branch=*) hc_branch=${hc_l#canonical_branch=} ;; product_dir=*) hc_product=${hc_l#product_dir=} ;;
      paths=*) hc_paths=${hc_l#paths=} ;; clients=*) hc_clients=${hc_l#clients=} ;; migrate_commands=*) hc_migrate=${hc_l#migrate_commands=} ;;
    esac
  done < "$tmp/hcfg"
  hcfg_state=ok
}
db_loaded=no
db_load() {
  [ "$db_loaded" = no ] || return 0
  db_loaded=yes
  # A188: one agent.sh run answers every config question of this event (hcfg_load); the three db-config lines are then read in a loop
  # (it was db-config plus three sed and three head processes). Without hook-config the old db-config call is used.
  if hcfg_load; then db_paths=$hc_paths db_clients=$hc_clients db_migrate=$hc_migrate
  else
    sh "$agent" db-config all > "$tmp/dbconf" 2>/dev/null || : > "$tmp/dbconf"
    db_paths='' db_clients='' db_migrate='' dl_p=no dl_c=no dl_m=no
    while IFS= read -r dl_l || [ -n "$dl_l" ]; do
      case $dl_l in
        paths=*) [ "$dl_p" = yes ] || { db_paths=${dl_l#paths=}; dl_p=yes; } ;;
        clients=*) [ "$dl_c" = yes ] || { db_clients=${dl_l#clients=}; dl_c=yes; } ;;
        migrate_commands=*) [ "$dl_m" = yes ] || { db_migrate=${dl_l#migrate_commands=}; dl_m=yes; } ;;
      esac
    done < "$tmp/dbconf"
  fi
  # the migration patterns, split at commas and trimmed once (db_guard_cmd matches every command against them)
  db_mig_all=''; dl_r=$db_migrate
  while [ -n "$dl_r" ]; do
    case $dl_r in *,*) dl_i=${dl_r%%,*}; dl_r=${dl_r#*,} ;; *) dl_i=$dl_r; dl_r='' ;; esac
    dl_i=${dl_i#"${dl_i%%[![:space:]]*}"}; dl_i=${dl_i%"${dl_i##*[![:space:]]}"}
    [ -z "$dl_i" ] || db_mig_all=${db_mig_all:+$db_mig_all$NL}$dl_i
  done
  [ -n "$db_paths" ] || db_paths='*.db *.sqlite *.sqlite3 *.db3'
}
# scratch_path P: a throwaway location (the runtime's $TMPDIR or /tmp) outside the project root; a project that
# itself lives under /tmp is not scratch.
scratch_path() {
  sc_p=${1#/private}; sc_r=${root#/private}
  case "$sc_p" in "$sc_r"|"$sc_r"/*) return 1 ;; esac
  # shellcheck disable=SC2016 # literal $TMPDIR in the command text
  case "$sc_p" in /tmp/*|/var/folders/*|'$TMPDIR'/*|'${TMPDIR}'/*) return 0 ;; esac
  if [ -n "${TMPDIR:-}" ]; then sc_t=${TMPDIR%/}; sc_t=${sc_t#/private}; case "$sc_p" in "$sc_t"/*) return 0 ;; esac; fi
  return 1
}
# db_is_path TOKEN: does TOKEN name a database file (config database.paths)?
db_is_path() {
  for dp_g in $db_paths; do
    # shellcheck disable=SC2254 # config database.paths entries are glob patterns on purpose
    case "$dp_g" in
      */*) case "$1" in $dp_g|*/$dp_g) return 0 ;; esac ;;
      *)case "${1##*/}" in $dp_g) return 0 ;; esac ;;
    esac
  done
  return 1
}
# db_check_token TOKEN WHAT: deny unless TOKEN is no database file or a scratch one.
db_check_token() {
  db_is_path "$1" || return 0
  scratch_path "$1" && return 0
  deny "$2 names the database file '$1'. No agent reads, copies, queries or writes a database file while a run is open (a test suite's own throwaway database under \$TMPDIR is the only exception). Existing rows are evidence only through the project's seed files and the test suite; record what you could not check as an open point in EVIDENCE.md"
}
# db_guard_cmd: the command text ($1) and its scan records ($tmp/scan).
dg_dsql='(^|[^a-z_])(drop[[:space:]]+(table|column|index|view|schema|database|trigger)|alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]|truncate[[:space:]]+(table[[:space:]]+)?[a-z_"`]|delete[[:space:]]+from[[:space:]])'
db_guard_cmd() {
  db_load
  set -f
  # Every word the command passes (command words, arguments, redirection targets; heredoc bodies are not
  # commands and are skipped), split at separators so --db=x.db, URLs and code strings are caught.
  while IFS= read -r dg_rec; do
    case "${dg_rec%%"$TAB"*}" in C|W) ;; *) continue ;; esac
    printf '%s\n' "${dg_rec#*"$TAB"}" | tr -s '[:space:]\003\002;|&()<>"`'"'"'=,:' '\n'
  done < "$tmp/scan" > "$tmp/dbtoks"
  while IFS= read -r dg_t; do
    [ -n "$dg_t" ] || continue
    db_check_token "$dg_t" "the command"
  done < "$tmp/dbtoks"
  while IFS= read -r dg_rec; do
    [ "${dg_rec%%"$TAB"*}" = C ] || continue
    dg_rest=${dg_rec#*"$TAB"}; dg_cw=${dg_rest%%"$TAB"*}
    dg_args=$(printf '%s' "${dg_rest#*"$TAB"}" | tr '\003' '\n')
    # Destructive SQL runs in no environment, a scratch or in-memory database included (A52): the argument of a
    # SQL client, inline code of a script interpreter, or a SQL file fed to either through `<`.
    dg_isql=no
    case " $db_clients " in *" $dg_cw "*) dg_isql=yes ;; esac
    # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
    case "$dg_cw" in node|nodejs|deno|bun|python|python3|ruby|php|perl) case " $(printf '%s' "$dg_args" | tr '\n' ' ') " in *" -e "*|*" -c "*|*" -p "*|*" --eval "*|*" -r "*) dg_isql=yes ;; esac ;; esac
    if [ "$dg_isql" = yes ] && printf '%s\n' "$dg_args" | grep -Eiq "$dg_dsql"; then
      deny "$dg_cw would run a destructive SQL statement (drop, alter ... drop, truncate, delete from). Destructive steps run in no environment, in-memory or scratch databases included; the project's tests exercise migrations, and the user's destructive approval gates the plan, not an agent's command"
    fi
    if [ "$dg_cw" = "<" ]; then
      dg_src=$(printf '%s' "$dg_args" | head -n 1)
      if [ -f "$dg_src" ] && grep -Eiq "$dg_dsql" "$dg_src" 2>/dev/null; then
        deny "the command feeds '$dg_src', which holds a destructive SQL statement, to a program. Destructive steps run in no environment, in-memory or scratch databases included"
      fi
    fi
    case " $db_clients " in *" $dg_cw "*)
      case "$dg_cw" in
        sqlite3|sqlite|duckdb|litecli)
          dg_first=''; dg_skip=0
          while IFS= read -r dg_a; do
            if [ "$dg_skip" = 1 ]; then dg_skip=0; continue; fi
            case "$dg_a" in -init|-cmd|-separator|-newline|-nullvalue|-vfs|-mmap|-A) dg_skip=1; continue ;; -*) continue ;; esac
            dg_first=$dg_a; break
          done <<DBARGS
$dg_args
DBARGS
          case "$dg_first" in
            ''|:memory:|file::memory:*) ;;
            *) scratch_path "$dg_first" || deny "$dg_cw would open '$dg_first'. A SQL client runs only against :memory: or a scratch file under \$TMPDIR outside the project (a test suite's own throwaway database); never against a project or environment database" ;;
          esac ;;
        *) deny "$dg_cw is a database client; no agent connects to a database while a run is open (a test suite builds its own throwaway database)" ;;
      esac ;;
    esac
    dg_joined="$dg_cw $(printf '%s' "$dg_args" | tr '\n' ' ')"
    # A188: ONE grep with the whole newline-separated pattern list (any match denies, as the per-pattern loop did). Status 1 = no match;
    # status 2 = some pattern is not a valid regular expression, and the per-pattern loop below then judges each one on its own.
    if [ -n "$db_mig_all" ]; then
      dg_rc=0; printf '%s\n' "$dg_joined" | grep -Eq -- "$db_mig_all" || dg_rc=$?
      dg_re_list=''; [ "$dg_rc" -lt 2 ] || dg_re_list=$db_mig_all
      if [ "$dg_rc" = 0 ]; then dg_hit=yes; else dg_hit=no; fi
      while [ -n "$dg_re_list" ]; do
        case $dg_re_list in *"$NL"*) dg_re=${dg_re_list%%"$NL"*}; dg_re_list=${dg_re_list#*"$NL"} ;; *) dg_re=$dg_re_list; dg_re_list='' ;; esac
        if printf '%s\n' "$dg_joined" | grep -Eq -- "$dg_re"; then dg_hit=yes; break; fi
      done
      if [ "$dg_hit" = yes ]; then
        deny "'$dg_cw' runs a migration, seed or schema command (matches database.migrate_commands). No agent runs one in any environment: the project's test command exercises migrations on the suite's own throwaway database, and applying a destructive step is the user's decision after the destructive approval"
      fi
    fi
  done < "$tmp/scan"
  set +f
}

# scratch_guard: scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/);
# $TMPDIR is only for git worktrees (D10, A56). A write whose target is under $TMPDIR or /tmp and not inside a
# registered worktree is refused, and so is `mktemp` without a template outside them. Heuristic, like the rest.
scratch_guard() {
  sg_t=${TMPDIR:-}; sg_t=${sg_t%/}
  [ -n "$sg_t" ] || sg_t=/tmp
  sg_wts=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  while IFS= read -r sg_rec; do
    sg_k=${sg_rec%%"$TAB"*}; sg_v=$(printf '%s' "${sg_rec#*"$TAB"}" | tr '\002' '\n')
    case "$sg_k" in
      W)
        # shellcheck disable=SC2016 # literal $TMPDIR and $HOME in the command text
        case "$sg_v" in '$TMPDIR'/*|'${TMPDIR}'/*) sg_v=$sg_t/${sg_v#*/} ;; '~'/*|'$HOME'/*|'${HOME}'/*) sg_v=${HOME:-/nonexistent-home}/${sg_v#*/} ;; esac
        case "$sg_v" in /dev/*) continue ;; /*) ;; *) continue ;; esac
        sg_n=$(printf '%s' "${sg_v#/private}" | sed 's|//*|/|g')
        # Inside the project: the path policy decides. Inside a registered worktree: allowed. Anywhere else
        # (/tmp, $TMPDIR, $HOME, any absolute path) a shell write is refused: a run leaves nothing outside the copy (C-18).
        case "$sg_n" in "${root#/private}"|"${root#/private}"/*) continue ;; esac
        sg_in=no
        for sg_w in $sg_wts; do
          [ "${sg_w#/private}" != "${root#/private}" ] || continue
          case "$sg_n" in "${sg_w#/private}"/*) sg_in=yes ;; esac
        done
        [ "$sg_in" = yes ] || deny "the command writes '$sg_v', outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); \$TMPDIR is only for git worktrees. Create the folder there and write inside it" ;;
      C)
        sg_rest=${sg_rec#*"$TAB"}; sg_cw=${sg_rest%%"$TAB"*}
        if [ "$sg_cw" = mktemp ]; then
          sg_a=$(printf '%s' "${sg_rest#*"$TAB"}" | tr '\003' ' ')
          case "$sg_a" in
            *scratch/*) ;;
            *) deny "mktemp would create its file or folder under \$TMPDIR. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); \$TMPDIR is only for git worktrees: mkdir there and name the path" ;;
          esac
        fi ;;
    esac
  done < "$tmp/scan"
}
# lead_tmp_check: the lead (and any session without a run, the intake roles included) keeps scratch files out of
# /tmp too (A52). Runs after the specific checks so their reasons win.
lead_tmp_check() {
  tmp_is_scratch_root && return 0
  lt_p=$(stray_tmp_path "$cmd")
  [ -z "$lt_p" ] || deny "$lt_p is outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); only git worktrees go under \$TMPDIR (${TMPDIR:-unset})"
}

# A143: what a read role's `find -delete|-exec ...` and `xargs ...` must not run outside an evidence worktree (text is
# space-joined first). Writers: the direct forms (rm, mv, cp, tee, ..., sed/perl/ruby -i, awk -i inplace, tree-changing git).
RO_W='rm|mv|cp|tee|truncate|ed|ex|patch|install|dd|chmod|chown|ln|shred|unlink|rmdir|touch'
RO_G='reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|stash|rm|mv|pull'
RO_I='(sed|gsed|perl|ruby)( +[^ ]+)* +(-[A-Za-z0-9]*i[^ ]*|--in-place)( |$)'
RO_FIND_WRITER="(^| )-delete( |\$)|(^| )-(exec|execdir|ok|okdir) +(/[^ ]*/)?(($RO_W)( |\$)|$RO_I|(awk|gawk)( .*)?inplace|git +(-C +[^ ]+ +)?($RO_G)( |\$))"
RO_XARGS_WRITER="xargs[^;&|]* (/[^ ]*/)?(($RO_W)( |\$)|$RO_I|git +(-C +[^ ]+ +)?($RO_G)( |\$))"
# ro_in_wt DIR: is DIR inside a registered worktree other than the project? (uses $sh_wts of stash_guard)
ro_in_wt() {
  [ -n "$1" ] || return 1
  while IFS= read -r ri_w; do
    [ -n "$ri_w" ] || continue
    [ "${ri_w#/private}" != "${root#/private}" ] || continue
    case "${1#/private}/" in "${ri_w#/private}"/*) return 0 ;; esac
  done <<EOF
$sh_wts
EOF
  return 1
}
# stash_path P BASE: P resolved against BASE (physical when it exists; leading $TMPDIR and $HOME expanded).
# Prints nothing when the path cannot be resolved from the text (another variable, command substitution, `-`,
# an unknown base, `..` through a path that does not exist): the caller then treats it as the project (A111).
stash_path() {
  sp_p=$1
  # shellcheck disable=SC2016 # literal $TMPDIR in the command text
  case "$sp_p" in '$TMPDIR'/*|'${TMPDIR}'/*) sp_p=${TMPDIR:-/tmp}/${sp_p#*/} ;; '~'/*|'$HOME'/*|'${HOME}'/*) sp_p=${HOME:-/nonexistent}/${sp_p#*/} ;; esac
  case "$sp_p" in ''|-|'~'*|*'$'*|*'`'*|*'*'*|*'?'*) return 0 ;; /*) ;; *) [ -n "${2:-}" ] || return 0; sp_p=$2/$sp_p ;; esac
  # a directory that does not exist now is unresolved (a failed cd leaves the shell in the project; a link may be made later)
  [ -d "$sp_p" ] || return 0
  (CDPATH='' cd -P "$sp_p" 2>/dev/null && pwd -P)
}
# stash_guard: a specialist runs no `git stash` subcommand (list and show included) against the project's
# working tree (A71, A111); a registered evidence worktree is free. The target directory is the hook cwd moved by
# `cd` and `git -C` / --work-tree in the scanned commands, and it is the PROJECT whenever the text cannot say
# (unexpanded variable, substitution, `cd -`, pushd/popd, `env -C`, a `cd` inside a subshell, pipe or background
# job before the stash). The cost of a wrong denial is one retry with a literal path. Reads $tmp/scan.
stash_guard() {
  sh_wts=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  sh_cd=$cwd; sh_sep=$(printf '\003'); sh_cdseen=no; sh_ok=0; sh_rok=0; sh_force=no
  # shellcheck disable=SC2016 # literal $TMPDIR in the message
  sh_msg='git stash (every subcommand, list and show included) must not run in the project working tree from a specialist (A71). Use an evidence worktree: create it in its own call (git worktree add "$TMPDIR/<name>" HEAD), then run git -C "$TMPDIR/<name>" stash ... in a separate call with a literal path that exists (a variable, substitution, cd -, a missing directory, a cd inside a subshell or pipe, or a git stash behind a wrapper is read as the project)'
  sh_pre=${cmd%stash*}
  sh_nl=$(printf '%s' "$sh_pre" | sed -e 's/&&//g' -e 's/[0-9]*>&[0-9-]*//g' -e 's/&>//g')
  sh_nonlin=no
  case "$sh_nl" in *'('*|*'|'*|*'&'*|*'{'*|*'`'*) sh_nonlin=yes ;; esac
  if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_.-])(env|sudo|doas)[[:space:]]+([^;&|]*[[:space:]])?(-[A-Za-z]*[CD]|--chdir|--chdir=)'; then sh_cd=''; fi
  while IFS= read -r sh_rec; do
    case "$sh_rec" in C"$TAB"*) ;; *) continue ;; esac
    sh_rest=${sh_rec#*"$TAB"}; sh_cw=${sh_rest%%"$TAB"*}
    case "$sh_rest" in *"$TAB"*) sh_args=${sh_rest#*"$TAB"} ;; *) sh_args='' ;; esac
    case "$sh_cw" in
      cd)
        sh_cdseen=yes
        sh_ifs=$IFS; IFS=$sh_sep; set -f
        # shellcheck disable=SC2086 # split on \003 on purpose
        set -- $sh_args
        IFS=$sh_ifs; set +f
        while [ $# -gt 0 ]; do case "$1" in -P|-L|-e|-@|--) shift ;; *) break ;; esac; done
        if [ $# -eq 0 ]; then sh_cd=''; else sh_cd=$(stash_path "$1" "$sh_cd"); fi ;;
      pushd|popd) sh_cdseen=yes; sh_cd='' ;;
      find)
        # a read role's `find -delete` or `find -exec <writer>` starts in an evidence worktree or is refused (A143)
        [ "$ro" = yes ] || continue
        sh_fa=$(printf '%s' "$sh_args" | tr '\003' ' ')
        printf '%s\n' "$sh_fa" | grep -Eq "$RO_FIND_WRITER" || continue
        sh_fd=$sh_cd; sh_f1=${sh_args%%"$sh_sep"*}
        case "$sh_f1" in -*|'('|'!'|'') ;; *) sh_fd=$(stash_path "$sh_f1" "$sh_cd") ;; esac
        ro_in_wt "$sh_fd" || deny "find with -delete or -exec of a command that writes starts outside an evidence worktree (or its start directory cannot be read from the command text)$(ro_tail)" ;;
      env) case "$sh_args" in GIT_WORK_TREE=*|GIT_DIR=*) sh_cd=''; sh_force=yes ;; esac ;;
      git)
        sh_dir=$sh_cd
        if [ "$sh_cdseen" = yes ] && [ "$sh_nonlin" = yes ]; then sh_dir=''; fi
        sh_ifs=$IFS; IFS=$sh_sep; set -f
        # shellcheck disable=SC2086 # split on \003 on purpose
        set -- $sh_args
        IFS=$sh_ifs; set +f
        sh_hit=no; sh_wtopt=$sh_force; sh_sub=stash
        while [ $# -gt 0 ]; do
          case "$1" in
            -C) [ $# -ge 2 ] || break; shift; sh_dir=$(stash_path "$1" "$sh_dir") ;;
            --work-tree) [ $# -ge 2 ] || break; shift; sh_wtopt=yes ;;
            --work-tree=*) sh_wtopt=yes ;;
            -c) [ $# -ge 2 ] || break; shift; case "$1" in [Cc][Oo][Rr][Ee].[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee]=*) sh_wtopt=yes ;; esac ;;
            --namespace|--config-env|--super-prefix|--git-dir|--exec-path|--attr-source|--list-cmds|--exec) [ $# -ge 2 ] || break; shift ;;
            -*) ;;
            stash) sh_hit=yes; sh_sub=stash; break ;;
            reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|rm|mv|pull)
              # a read role changes no file of the project tree with git either (A143)
              if [ "$ro" = yes ]; then sh_hit=yes; sh_sub=$1; break; fi
              break ;;
            *)
              # a first word that is not a plausible subcommand name (a value of an option this list does not know)
              # followed by the word stash is read as a stash
              case "$1" in *[!a-z-]*) shift; for sh_a in "$@"; do [ "$sh_a" != stash ] || sh_hit=yes; done ;; esac
              break ;;
          esac
          [ $# -eq 0 ] || shift
        done
        [ "$sh_hit" = yes ] || continue
        # --work-tree, core.worktree and GIT_WORK_TREE move the target away from what -C or cd says: the project
        [ "$sh_wtopt" = no ] || sh_dir=''
        sh_in=no
        if [ -n "$sh_dir" ]; then
          while IFS= read -r sh_w; do
            [ -n "$sh_w" ] || continue
            [ "${sh_w#/private}" != "${root#/private}" ] || continue
            case "${sh_dir#/private}/" in "${sh_w#/private}"/*) sh_in=yes ;; esac
          done <<EOF
$sh_wts
EOF
        fi
        if [ "$sh_in" != yes ]; then
          [ "$sh_sub" = stash ] && deny "$sh_msg$(ro_tail)"
          deny "git $sh_sub changes the project working tree; its directory is not a registered evidence worktree (or cannot be read from the command text: a variable, substitution, cd -, a missing directory, a cd inside a subshell or pipe)$(ro_tail)"
        fi
        if [ "$sh_sub" = stash ]; then sh_ok=$((sh_ok + 1)); else sh_rok=$((sh_rok + 1)); fi ;;
    esac
  done < "$tmp/scan"
  # `xargs <writer>` takes its files from stdin, so the directory the command ends in must be an evidence worktree.
  if [ "$ro" = yes ] && printf '%s' "$cmd" | tr '\n\t' '  ' | grep -Eq "$RO_XARGS_WRITER"; then
    ro_in_wt "$sh_cd" || deny "xargs of a command that writes runs outside an evidence worktree (or the directory cannot be read from the command text)$(ro_tail)"
  fi
  # Safety net on the text: every `git ... stash` in command position that the records above did not resolve to
  # an evidence worktree is refused (unquoted substitutions, wrappers such as find -exec, watch, ssh, su -c, a
  # variable or substitution where the subcommand goes). Words that merely print or search (echo, grep) are skipped.
  sh_n=$(printf '%s' "$cmd" | stash_net_count)
  [ "${sh_n:-0}" -le "$sh_ok" ] || deny "$sh_msg$(ro_tail)"
  # The same net for a read role's other tree-changing subcommands (wrappers such as find -exec hide them from the records).
  if [ "$ro" = yes ]; then
    sh_rn=$(printf '%s' "$cmd" | grep -Eo '(^|[^[:alnum:]_.-])git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?(reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|rm|mv|pull)([[:space:]]|$)' | wc -l | tr -d ' ')
    [ "${sh_rn:-0}" -le "$sh_rok" ] || deny "git changes the project working tree, or a wrapper hides which directory it runs in; use git -C <evidence worktree> or cd there with a literal path$(ro_tail)"
  fi
}
# stash_net_count: stdin is the command text; prints how many `git [options] stash` (or a `$`/backtick where the
# subcommand goes) sit in command position, not after a printing or searching word.
stash_net_count() {
  awk 'BEGIN { RS = "\001" }
  {
    q = "\047"
    val = "(\"[^\"]*\"|" q "[^" q "]*" q "|\\$\\([^)]*\\)|`[^`]*`|[^ \t;&|\"" q "`]+)"
    opt = "(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|--attr-source|--list-cmds|--exec)[ \t]+" val
    re = "(^|[^A-Za-z0-9_.-])git([ \t]+(" opt "|-[^ \t;&|]+))*[ \t]+(stash([ \t;&|)$`{}]|$)|[$`])"
    n = 0; s = $0; off = 0
    while (match(s, re)) {
      st = RSTART; ln = RLENGTH
      gs = st; if (substr(s, st, 1) != "g") gs = st + 1
      before = substr($0, 1, off + gs - 1)
      k = 0
      for (i = length(before); i >= 1; i--) { c = substr(before, i, 1); if (c == ";" || c == "&" || c == "|" || c == "(" || c == "{" || c == "\n" || c == "`") { k = i; break } }
      t = substr(before, k + 1)
      while (match(t, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) t = substr(t, RLENGTH + 1)
      sub(/^[ \t]+/, "", t); split(t, wd, /[ \t]+/)
      # `git -C $W status`: the `$` the pattern stopped at is the VALUE of a value-taking option, not a subcommand
      # (a real `git -C $W stash` matches longer, through the option alternative, and is counted)
      m = substr(s, st, ln)
      # Skipped only when the option itself is not a value (`git -c -c $S`, `git -C -C $S`) and what follows the
      # value is whitespace and a bare literal word (status, apply, worktree): a quote, `$`, backtick, `-` or the
      # end after it keeps the count (`git -C $W "$S" list`, `git -C $W -C $S`).
      skip = 0
      vopt = "^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|--attr-source|--list-cmds|--exec)$"
      if (m ~ /(^|[ \t])(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|--attr-source|--list-cmds|--exec)[ \t]+[$`]$/) {
        nt = split(m, mt, /[ \t]+/)
        if (nt < 3 || mt[nt - 2] !~ vopt) {
          rest = substr(s, st + ln); lc = substr(m, length(m), 1)
          if (lc == "`") { if (match(rest, /`/)) rest = substr(rest, RSTART + 1); else rest = "" }
          else if (substr(rest, 1, 1) == "(") { if (match(rest, /\)/)) rest = substr(rest, RSTART + 1); else rest = "" }
          else if (substr(rest, 1, 1) == "{") { if (match(rest, /\}/)) rest = substr(rest, RSTART + 1); else rest = "" }
          else { match(rest, "^[^ \t;&|\"" q "`]*"); rest = substr(rest, RLENGTH + 1) }
          if (rest ~ /^[ \t]+[A-Za-z][A-Za-z0-9_-]*([ \t;&|)\n]|$)/) skip = 1
        }
      }
      if (!skip && !(wd[1] ~ /^(echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|less|more|man|sed|awk|head|tail|wc|tr|cut|sort|uniq|jq|diff|ls|test|type|which|true)$/)) n++
      off += st + ln - 1; s = substr($0, off + 1)
    }
    print n
  }'
}

# --- merge guard (A136) --------------------------------------------------------------------------
# Merging is possible only through `proofline merge <PR>` (bin/lib/merge.sh), which merges a pull request only when
# a fresh check shows every check green on its current head. Every other merge path is denied for every caller,
# a run open or not, proofline installed in the project or not: gh pr merge (any flags, --admin and --auto
# included), gh api calls to a merge endpoint / GraphQL merge mutation / protected-ref update, gh alias, git push
# to a protected branch (or a bare push while one is checked out), git merge on one. Token matching on the scan's
# command records, like the rest: a script that merges by itself is not seen (see A136, known limits).
# A180: the same single merge path on the other platforms: glab mr merge, glab api merge endpoints and glab alias, az repos pr update
# that completes (--status completed, --auto-complete), az rest / az devops invoke aimed at pull requests, and an HTTP client aimed at
# a GitLab merge request or an Azure DevOps pull request.
MG_MSG='merging a pull request goes only through `proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]`, which checks that every check is green on the current head and then merges (A136); --admin and --auto are never allowed'
mg_prot=''
mg_isprot() { case " $mg_prot " in *" $1 "*) return 0 ;; esac; return 1; }
mg_load() {
  [ -z "$mg_prot" ] || return 0
  mg_cb=''; [ "$installed" = no ] || if hcfg_load; then mg_cb=$hc_branch; else mg_cb=$(sh "$agent" config-get canonical_branch 2>/dev/null) || mg_cb=''; fi
  mg_oh=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^[^/]*/||') || mg_oh=''
  mg_prot="main master $mg_cb $mg_oh"
}
# mg_ref REF: is REF (one side of a refspec) a protected branch? A variable or substitution cannot be read: protected.
mg_ref() {
  mr=${1#+}; mr=${mr#refs/heads/}
  case "$mr" in *'$'*|*'`'*) return 0 ;; esac
  mg_isprot "$mr"
}
# mg_git ARGS: the arguments of one git command, one per line. State from merge_guard: mg_cd (directory after
# `cd`), mg_envu (an env/sudo -C, GIT_DIR, GIT_WORK_TREE made the directory unreadable).
mg_git() {
  mg_ifs=$IFS; IFS='
'; set -f
  # shellcheck disable=SC2086 # split on newlines on purpose
  set -- $1
  IFS=$mg_ifs; set +f
  mg_dir=$mg_cd; [ "$mg_envu" = no ] || mg_dir=@unknown
  mg_sub=''
  while [ $# -gt 0 ]; do
    case "$1" in
      -C) [ $# -ge 2 ] || break; if [ "$mg_dir" != @unknown ]; then mg_dir=$(stash_path "$2" "$mg_dir"); [ -n "$mg_dir" ] || mg_dir=@unknown; fi; shift ;;
      --git-dir=*|--work-tree=*) mg_dir=@unknown ;;
      --git-dir|--work-tree) mg_dir=@unknown; shift ;;
      -c|--namespace|--config-env|--exec-path|--super-prefix|--attr-source) shift ;;
      -*) ;;
      *) mg_sub=$1; shift; break ;;
    esac
    shift
  done
  mg_cur=''
  [ "$mg_dir" = @unknown ] || mg_cur=$(git -C "$mg_dir" symbolic-ref -q --short HEAD 2>/dev/null) || mg_cur=''
  case "$mg_sub" in
    push)
      # A real -n / --dry-run pushes nothing; the value of -o / --push-option / --receive-pack / --exec / --repo is not a flag.
      mg_skip=no
      for mg_a in "$@"; do
        if [ "$mg_skip" = yes ]; then mg_skip=no; continue; fi
        case "$mg_a" in -n|--dry-run) return 0 ;; -o|--push-option|--receive-pack|--exec|--repo) mg_skip=yes ;; esac
      done
      mg_np=0; mg_head=no; mg_skip=no
      for mg_a in "$@"; do
        if [ "$mg_skip" = yes ]; then mg_skip=no; continue; fi
        case "$mg_a" in
          --all|--mirror) deny "git push $mg_a would push the protected branch: $MG_MSG" ;;
          --repo) mg_np=1; mg_skip=yes; continue ;;
          --repo=*) mg_np=1; continue ;;
          -o|--push-option|--receive-pack|--exec) mg_skip=yes; continue ;;
          -*) continue ;;
        esac
        mg_np=$((mg_np + 1))
        [ "$mg_np" -ge 2 ] || continue
        case "$mg_a" in
          *:*) ! mg_ref "${mg_a#*:}" || deny "git push to the protected branch ($mg_a): $MG_MSG" ;;
          HEAD|@) mg_head=yes ;;
          *) ! mg_ref "$mg_a" || deny "git push of the protected branch ($mg_a): $MG_MSG" ;;
        esac
      done
      # no refspec, or HEAD: the pushed branch is the checked-out one
      if [ "$mg_np" -lt 2 ] || [ "$mg_head" = yes ]; then
        [ "$mg_dir" != @unknown ] || deny "git push whose directory cannot be read from the command text (cd -, a variable, GIT_DIR, env -C, a cd in a subshell or pipe) pushes an unknown branch: $MG_MSG"
        ! mg_isprot "$mg_cur" || deny "git push while the protected branch $mg_cur is checked out: $MG_MSG"
      fi ;;
    merge)
      for mg_a in "$@"; do case "$mg_a" in --abort|--quit|--continue) return 0 ;; esac; done
      [ "$mg_dir" != @unknown ] || deny "git merge whose directory cannot be read from the command text may merge into a protected branch: $MG_MSG"
      ! mg_isprot "$mg_cur" || deny "git merge on the protected branch $mg_cur: $MG_MSG"
      mg_alt=$(printf '%s' "$mg_prot" | tr -s ' ' '|' | sed 's/^|//; s/|$//')
      ! printf '%s' "$cmd" | grep -Eq "(checkout|switch)[[:space:]]+([^;&|]*[[:space:]])?($mg_alt)([[:space:]]|;|&|\\||\$)" \
        || deny "git merge in a command that switches to a protected branch: $MG_MSG" ;;
    update-ref)
      for mg_a in "$@"; do case "$mg_a" in refs/heads/*) ! mg_ref "$mg_a" || deny "git update-ref of a protected branch: $MG_MSG" ;; esac; done ;;
    # A200: the other ways to put a task branch onto a protected branch (branch -f, fetch . task:main, reset/cherry-pick/rebase/pull . on it)
    branch)
      mg_f=no
      for mg_a in "$@"; do case "$mg_a" in -f|--force|-M|-C) mg_f=yes ;; esac; done
      [ "$mg_f" = no ] || for mg_a in "$@"; do case "$mg_a" in -*) ;; *) ! mg_ref "$mg_a" || deny "git branch -f/-M/-C on the protected branch $mg_a moves it without proofline merge: $MG_MSG" ;; esac; done ;;
    fetch)
      for mg_a in "$@"; do case "$mg_a" in -*) ;; *:*) ! mg_ref "${mg_a#*:}" || deny "git fetch into the protected branch ($mg_a) moves it without proofline merge: $MG_MSG" ;; esac; done ;;
    reset|cherry-pick|rebase|am|revert)
      for mg_a in "$@"; do case "$mg_a" in --abort|--quit|--continue|--skip) return 0 ;; esac; done
      if [ "$mg_sub" = reset ]; then   # only a reset that moves the branch to another commit; an unstage or a reset to HEAD~N stays
        mg_mv=no; mg_fl=no
        for mg_a in "$@"; do case "$mg_a" in --hard|--soft|--keep|--merge) mg_fl=yes ;; -*) ;; HEAD|HEAD~*|HEAD^*|@|@~*) ;; *) mg_mv=yes ;; esac; done
        [ "$mg_fl$mg_mv" = yesyes ] || return 0
      fi
      [ "$mg_dir" != @unknown ] || deny "git $mg_sub whose directory cannot be read from the command text may move a protected branch: $MG_MSG"
      ! mg_isprot "$mg_cur" || deny "git $mg_sub while the protected branch $mg_cur is checked out advances it without proofline merge: $MG_MSG" ;;
    pull)
      for mg_a in "$@"; do case "$mg_a" in .|./|..|../*|/*) ! mg_isprot "$mg_cur" || deny "git pull from a local path onto the protected branch $mg_cur merges a task branch without proofline merge: $MG_MSG" ;; esac; done ;;
  esac
  return 0
}
# mg_api ARGS: a `gh api` call (arguments one per line).
mg_api() {
  mg_aw=no; mg_atxt=$(printf '%s' "$1" | tr '\n' ' ')
  ! printf '%s\n' "$1" | grep -Eq '^(-X|--method|-f|-F|--field|--raw-field|--input)(=.*)?$|^-X.' || mg_aw=yes
  printf '%s\n' "$1" | grep -Eiq '^--input|=@|mutation|/pulls/[^/[:space:]]*/merge|/merge_requests/[^/[:space:]]*/(merge|cancel_merge)|merge_when_pipeline_succeeds|state_event|/pullrequests/|/merges?([[:space:]?#]|$)|mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|auto_merge|git/refs/heads/(main|master)' \
    && deny "gh api call with a merge endpoint, a GraphQL mutation, --input or a field read from a file (=@) is denied: $MG_MSG"
  [ "$mg_aw" = no ] || {
    printf '%s' "$mg_atxt" | grep -Eiq '/contents/' && deny "gh api write to repository contents (default branch included) is denied: $MG_MSG"
    printf '%s' "$mg_atxt" | grep -Eiq '/git/(refs|commits|trees)' && printf '%s' "$mg_atxt" | grep -Eiq 'main|master|[$`]' \
      && deny "gh api write to git refs of a protected branch (or to a ref built from a variable) is denied: $MG_MSG"
  }
  return 0
}
merge_guard() {
  mg_load
  mg_flat=$(printf '%s' "$cmd" | tr '\n' ' ')
  case "$cmd" in *PROOFLINE_SELFTEST*) deny "PROOFLINE_SELFTEST is a self-test switch (it lifts the wrapper's PATH-shadowing rule); a model command never names it: $MG_MSG" ;; esac
  # (a) a variable, substitution or backtick where the gh subcommand goes
  printf '%s' "$mg_flat" | grep -Eq '(^|[^[:alnum:]_./-])(gh|glab)([[:space:]]+(-R|--repo)[[:space:]]+[^[:space:]]+)?([[:space:]]+[A-Za-z][A-Za-z-]*)?[[:space:]]+["'"'"']?[$`]' \
    && deny "a variable or substitution where the gh subcommand goes cannot be checked (gh pr \$m, gh \$SUB ...); write the subcommand literally: $MG_MSG"
  # (d) merge text piped, heredoc'd or passed to a shell / interpreter / eval / git alias
  mg_pay='(^|[^[:alnum:]_])(pr|mr)["'"'"'[:space:]]+merge([^[:alnum:]_]|$)|repos[[:space:]]+pr[[:space:]]+update[^;&|]*(completed|auto-complete)|/merge_requests/[^[:space:]]*merge|/pulls/[^[:space:]]*merge|mergePullRequest|enablePullRequestAutoMerge|git[[:space:]]+([^;&|]*[[:space:]])?push[^;&|]*[[:space:]:/+](main|master)([^[:alnum:]_.-]|$)|git[[:space:]]+merge'
  mg_sink='\|[[:space:]]*((env|sudo|command|exec)[[:space:]]+)*(/[^[:space:]|;&]*/)?(sh|bash|zsh|dash|ksh|ash)([[:space:]]|;|&|\)|$)|(^|[^[:alnum:]_.-])(sh|bash|zsh|dash|ksh)([[:space:]]+-[A-Za-z]+)*[[:space:]]*<<|(sh|bash|zsh|dash|ksh)[[:space:]]+(-[A-Za-z]+[[:space:]]+)*-s([[:space:]]|$)|(^|[^[:alnum:]_.-])(python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua)[[:space:]]+(-[A-Za-z]*[ceErp]|--eval)([[:space:]]|$)|awk[^|;&]*system[[:space:]]*\(|(^|[;&|({[:space:]])eval[[:space:]]|alias\.[A-Za-z0-9_-]+=["'"'"']?!'
  if printf '%s' "$mg_flat" | grep -Eq "$mg_sink" && printf '%s' "$mg_flat" | grep -Eq "$mg_pay"; then
    deny "merge text passed to a shell, an interpreter, eval or a git alias cannot be checked: $MG_MSG"
  fi
  mg_cd=$cwd; mg_envu=no
  # env/sudo -C, --chdir move the directory away from what the text says
  ! printf '%s' "$mg_flat" | grep -Eq '(env|sudo|doas)[[:space:]]+([^;&|]*[[:space:]])?(-[A-Za-z]*[CD]|--chdir)' || mg_envu=yes
  mg_nl=$(printf '%s' "$cmd" | sed -e 's/&&//g' -e 's/[0-9]*>&[0-9-]*//g' -e 's/&>//g')
  mg_nonlin=no; case "$mg_nl" in *'('*|*'|'*|*'&'*|*'{'*|*'`'*) mg_nonlin=yes ;; esac
  while IFS= read -r mg_rec; do
    case "$mg_rec" in C"$TAB"*) ;; *) continue ;; esac
    mg_rest=${mg_rec#*"$TAB"}; mg_cw=${mg_rest%%"$TAB"*}
    case "$mg_rest" in *"$TAB"*) mg_args=$(printf '%s' "${mg_rest#*"$TAB"}" | tr '\003\002' '\n\n') ;; *) mg_args='' ;; esac
    case "$mg_cw" in
      cd)
        mg_first=$(printf '%s\n' "$mg_args" | grep -v '^-' | head -n 1)
        if [ -z "$mg_first" ] || [ "$mg_cd" = @unknown ]; then mg_cd=@unknown; else mg_cd=$(stash_path "$mg_first" "$mg_cd"); [ -n "$mg_cd" ] || mg_cd=@unknown; fi
        if [ "$mg_nonlin" = yes ]; then mg_cd=@unknown; fi
        continue ;;
      pushd|popd) mg_cd=@unknown; continue ;;
      env|export)
        ! printf '%s\n' "$mg_args" | grep -Eq '^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=' || mg_envu=yes
        if printf '%s\n' "$mg_args" | grep -q '^PATH=' && printf '%s' "$mg_flat" | grep -Eq 'merge|proofline|(^|[^[:alnum:]_.-])gh([^[:alnum:]_]|$)'; then
          deny "setting PATH in a command that runs gh or proofline merge could substitute a fake gh: $MG_MSG"
        fi
        continue ;;
      curl|wget|http|https|xh|xhs|aria2c)
        # (b) an HTTP client aimed at GitHub's merge / refs / contents / graphql endpoints
        if printf '%s\n' "$mg_args" | grep -Eiq 'github' && printf '%s\n' "$mg_args" | grep -Eiq '/pulls/[^[:space:]]*/merge|/merges|git/refs|/contents/|graphql|mergePull|auto_merge'; then
          deny "$mg_cw aimed at a GitHub merge, refs, contents or graphql endpoint is denied: $MG_MSG"
        fi
        # path shapes of the merge / completion endpoints of any host (GitHub pulls, GitLab merge requests, Azure pullrequests), whatever the host name
        if printf '%s\n' "$mg_args" | grep -Eiq '/pulls/[^[:space:]]*/merge|/merge_requests/[^[:space:]]*(merge|state_event)|state_event|merge_when_pipeline_succeeds|/pullrequests/|_apis/git/[^[:space:]]*pullrequests'; then
          deny "$mg_cw aimed at a pull request / merge request merge or completion endpoint is denied: $MG_MSG"
        fi
        continue ;;
      echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|less|more|man|sed|awk|head|tail|wc|tr|cut|sort|uniq|jq|diff|ls|test|type|which|true|agent.sh|proofline|'<') continue ;;
    esac
    if [ "$mg_cw" = git ]; then mg_git "$mg_args"; continue; fi
    # every other command word (gh itself, ssh, xargs, a variable): the words pr merge, api, alias
    mg_pr=no mg_mg=no mg_ap=no mg_al=no mg_mr=no mg_cp=no mg_rs=no mg_vb=no mg_sc=no
    while IFS= read -r mg_t; do
      mg_t=$(printf '%s' "$mg_t" | tr '[:upper:]' '[:lower:]')   # Completed, COMPLETED and --Status=Completed are the same words
      case "$mg_t" in pr) mg_pr=yes ;; mr) mg_mr=yes ;; merge|accept) mg_mg=yes ;; api) mg_ap=yes ;; alias) mg_al=yes ;; update|create|set-vote) mg_vb=yes ;; completed|--status=completed) mg_sc=yes ;; --auto-complete|--auto-complete=*|--bypass-policy|--bypass-policy=*) mg_cp=yes ;; rest|invoke) mg_rs=yes ;; esac
    done <<MGARGS
$mg_args
MGARGS
    [ "$mg_pr$mg_mg" != yesyes ] || deny "$mg_cw pr merge is denied: $MG_MSG"
    [ "$mg_mr$mg_mg" != yesyes ] || deny "$mg_cw mr merge is denied: $MG_MSG"
    [ "$mg_cw$mg_pr$mg_cp" != az''yesyes ] || deny "az repos pr with --auto-complete or --bypass-policy (any verb) completes or merges a pull request and is denied: $MG_MSG"
    [ "$mg_cw$mg_pr$mg_vb$mg_sc" != az''yesyesyes ] || deny "az repos pr update/create/set-vote with --status completed completes a pull request and is denied: $MG_MSG"
    if [ "$mg_cw$mg_rs" = az''yes ] && printf '%s' "$mg_flat" | grep -Eiq 'pullrequest|_apis/git'; then deny "az rest / az devops invoke aimed at a pull request is denied: $MG_MSG"; fi
    [ "$mg_cw$mg_al" != gh''yes ] || deny "gh alias could hide a merge command: $MG_MSG"
    [ "$mg_cw$mg_al" != glab''yes ] || deny "glab alias could hide a merge command: $MG_MSG"
    [ "$mg_ap" = no ] || mg_api "$mg_args"
  done < "$tmp/scan"
}

# --- kill guard (A156, A161) ---------------------------------------------------------------------
# A process is stopped only by the PID of one the agent started itself. Denied for every caller, a run open or not,
# proofline installed or not: pkill, killall, skill, slay, fuser -k (kill by name or port), `kill` aimed at everything
# (-1, 0 in any spelling: 00, +0, $((0))) and `kill` whose PIDs come from pgrep / pidof / ps / lsof / fuser: as a
# substitution, through xargs, through a variable or loop variable the same command fills from such a search, or
# through `find -exec kill`. `kill <pid>`, `kill $!`, `kill $PID` and `kill $(cat pidfile)` pass.
# A161 reads further, still only the command text and files the command names: the commands in an unquoted
# here-document body, interpreter one-liners and here-documents (python, perl, node, ruby, php, lua, awk, osascript),
# script files the command runs (sh x.sh, ./x, source x, python x.py) when they are under the project or a temp dir,
# `eval`, and a variable command word whose value the same command assigns. It is a tripwire against an honest
# mistake, not a security boundary against a hostile agent (a payload built at run time, a file written by another
# tool call and run from outside the project and temp dirs, anything inside a binary are not seen: A161). Token and
# text matching on the scan's records like the merge guard; this hook sees only the model's own tool calls.
KG_MSG='kill only a process you started yourself, by its PID (kill <pid>, kill $!); pkill, killall and kill by pattern, by name, by port or by a process search are forbidden (A156, A161)'
# appended to a denial that came from the text of interpreter code, a script file or a here-document (A161)
KG_TXT='Text in code or a script that contains a kill-by-name word (pkill, killall, slay, fuser -k) cannot be told from a command the code runs, so it is denied even when the code only prints or matches it; if the user really wants this command, the user can run it themselves with the ! prefix in the terminal'
KG_DEPTH=0
KG_SEP=$(printf '\003')
kg_verb_re='(^|[^A-Za-z0-9_.$-])(pkill|killall5?|slay)([^A-Za-z0-9_-]|$)'
kg_lit_re="\"([^\"\\\\]|\\\\.)*\"|'([^'\\\\]|\\\\.)*'"
kg_no() { printf '%s: %s\n' "$1" "$KG_MSG"; exit 1; }   # only inside the $(...) subshells that kg_run, kg_text and kg_code run in
kg_is_search() { case "$1" in pgrep|pidof|ps|lsof|fuser|pkill|netstat|ss|pstree|jps) return 0 ;; esac; return 1; }
# kg_num WORD: the integer a literal (00, +0, -01) or constant arithmetic ($((1-1))) stands for; nothing otherwise.
kg_num() {
  kn=$1
  case "$kn" in
    '$(('*'))')
      kn_e=${kn#'$(('}; kn_e=${kn_e%'))'}
      case "$kn_e" in ''|*[!0-9+*/%\ \(\)\<\>\&\|^~!-]*) return 0 ;; esac   # a letter, $ or quote: not a constant
      kn_v=$( (eval "printf %s \$(( $kn_e ))") 2>/dev/null ) || return 0
      kn=$kn_v ;;
  esac
  kn_s=''; kn_d=$kn
  case "$kn_d" in [+-]*) kn_s=${kn_d%"${kn_d#?}"}; kn_d=${kn_d#?} ;; esac
  case "$kn_d" in ''|*[!0-9]*) return 0 ;; esac
  kn_d=$(printf '%s' "$kn_d" | sed 's/^0*//'); [ -n "$kn_d" ] || kn_d=0
  if [ "$kn_s" = - ] && [ "$kn_d" != 0 ]; then kn_d=-$kn_d; fi
  printf '%s\n' "$kn_d"
}
# kg_expand TEXT: $NAME and ${NAME} replaced by the value this command assigned ($kg_tbl, NAME=value lines).
kg_expand() {
  kx=$1
  kx_i=0
  while [ "$kx_i" -lt 3 ]; do
    kx_i=$((kx_i + 1))
    kx=$(printf '%s\n' "$kx" | KGT=$kg_tbl awk 'BEGIN { n = split(ENVIRON["KGT"], L, "\n"); for (i = 1; i <= n; i++) { p = index(L[i], "="); if (p) V[substr(L[i], 1, p - 1)] = substr(L[i], p + 1) } }
      { s = $0; o = ""; while (match(s, /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/)) { nm = substr(s, RSTART + 1, RLENGTH - 1); gsub(/[{}]/, "", nm); o = o substr(s, 1, RSTART - 1) ((nm in V) ? V[nm] : substr(s, RSTART, RLENGTH)); s = substr(s, RSTART + RLENGTH) } print o s }')
  done
  printf '%s\n' "$kx"
}
# kg_rp PATH: a relative script path resolved against the directory a `cd DIR &&` earlier in the command changed to.
kg_rp() {
  case "$1" in /*|~*|'') printf '%s\n' "$1" ;; *) if [ -n "${kg_cd:-}" ]; then printf '%s/%s\n' "$kg_cd" "$1"; else printf '%s\n' "$1"; fi ;; esac
}
# kg_check_time FILE: the guard's own time budget (A161, fix B). Reading scripts costs time; a hook that is cut off by
# the runtime's timeout lets the command through untouched. After KG_BUDGET seconds the guard decides itself: a command
# or text that holds a kill word (kill, slay, fuser) is denied, anything else is let through (without such a word no
# rule can fire).
KG_BUDGET=${PROOFLINE_KG_BUDGET:-20}
# kg_t0 is taken at hook entry (top of the script): the budget covers everything the hook does, not only the guard.
kg_check_time() {
  case "$kg_t0" in ''|*[!0-9]*) kg_t0=$(date +%s) ;; esac
  [ $(( $(date +%s) - kg_t0 )) -ge "$KG_BUDGET" ] || return 0
  if grep -aEq 'kill|slay|fuser' "$1" 2>/dev/null; then
    kg_no "the guard ran out of time (${KG_BUDGET}s) reading a command or script that names a kill verb, and cannot clear it; split the command or run it from a short script"
  fi
  exit 0
}
# kg_has_words TEXT: could TEXT hold a kill rule at all? Every rule needs kill, slay or fuser in the text (quotes and
# backslashes removed, as the shell removes them), or a variable in command position that the text may fill with one.
kg_has_words() {
  # grep reads all of its input (no -q): with -q it exits at the first match and closes the pipe while printf is still
  # writing a large script, which printf reports as "write error: Broken pipe" on stderr. The verdict is the same.
  printf '%s' "$1" | tr -d "'\"\\\\" | grep -E 'kill|slay|fuser|(^|[;&|({]|then|do|else)[[:space:]]*\$[A-Za-z_{(]' >/dev/null
}
# kg_file_ok PATH: prints the resolved path of a text file the guard may read: a regular file (no link) under the
# project (third-party node_modules and .git excluded) or a temp dir, at most 256 KB.
kg_file_ok() {
  kf=$1; case "$kf" in /*) ;; *) kf=$cwd/$kf ;; esac
  [ -f "$kf" ] && [ ! -L "$kf" ] || return 1
  kf_d=$(CDPATH='' cd "$(dirname "$kf")" 2>/dev/null && pwd -P) || return 1
  kf=$kf_d/$(basename "$kf")
  case "$kf" in */node_modules/*|"$root"/.git/*) return 1 ;; esac
  kf_t=$(CDPATH='' cd "${TMPDIR:-/nonexistent}" 2>/dev/null && pwd -P) || kf_t=/nonexistent
  case "$kf" in "$root"/*|"$kf_t"/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;; *) return 1 ;; esac
  [ "$(wc -c < "$kf")" -le 262144 ] || return 1
  grep -Iq . "$kf" 2>/dev/null || return 1   # binary (or empty): nothing to read
  printf '%s\n' "$kf"
}
# kg_scan IN OUT: scan_cmd IN > OUT under the time budget. scan_cmd is one awk run (about 7 s for 250 KB), so it runs in the
# background and is polled; once the budget is spent it is stopped (it is this function's own child) and kg_check_time decides
# on the text: a kill word is denied, anything else passes.
kg_scan() {
  kg_check_time "$1"
  # small text (the usual case: a string literal, a short command) is scanned in the foreground, no polling cost
  if [ "$(wc -c < "$1")" -le "${PROOFLINE_KG_BGMIN:-16384}" ]; then scan_cmd < "$1" > "$2"; return 0; fi
  scan_cmd < "$1" > "$2" &
  ksc_p=$!
  while kill -0 "$ksc_p" 2>/dev/null; do
    if [ $(( $(date +%s) - kg_t0 )) -ge "$KG_BUDGET" ]; then
      kill "$ksc_p" 2>/dev/null; wait "$ksc_p" 2>/dev/null
      kg_check_time "$1"
    fi
    sleep 0.1 2>/dev/null || sleep 1
  done
  wait "$ksc_p" 2>/dev/null || :
}
# kg_text TEXT: the shell text as a command line; kg_code LANG TEXT: interpreter code. Each runs in a $(...) subshell
# and prints the reason (status 1) when it kills by pattern.
kg_text() {
  [ "$KG_DEPTH" -lt 5 ] || return 0
  KG_DEPTH=$((KG_DEPTH + 1))
  printf '%s\n' "$1" > "$tmp/kgt.$KG_DEPTH"
  kg_scan "$tmp/kgt.$KG_DEPTH" "$tmp/kgs.$KG_DEPTH"
  kg_run "$tmp/kgs.$KG_DEPTH"
}
kg_sub() { kg_r=$(kg_text "$1") || { printf '%s\n' "$kg_r"; exit 1; }; }
kg_chk_code() {
  kg_r=$(kg_code "$1" "$2") || { case "$kg_r" in *"$KG_TXT"*) ;; *) kg_r="$kg_r. $KG_TXT" ;; esac; printf '%s\n' "$kg_r"; exit 1; }
}
kg_code() {
  kc_l=$1; kc_t=$2
  [ "$KG_DEPTH" -lt 5 ] || return 0
  KG_DEPTH=$((KG_DEPTH + 1))
  printf '%s\n' "$kc_t" > "$tmp/kgc.$KG_DEPTH"
  kc_g() { grep -Eq "$1" "$tmp/kgc.$KG_DEPTH"; }
  # awk is denied only where it can run a command: system(), a pipe into a command or out of one, a coprocess. A
  # pattern or a printed text (awk '/killall/ {print}' README.md) is not an exec target.
  if [ "$kc_l" = awk ] && ! kc_g 'system[[:space:]]*\(|\|&|\|[[:space:]]*getline|(print|printf)[^/]*\|[[:space:]]*["A-Za-z_$]'; then return 0; fi
  ! kc_g "$kg_verb_re" || kg_no "$kc_l code runs pkill, killall or slay"
  ! kc_g '(^|[^A-Za-z0-9_$-])fuser[^A-Za-z0-9]+-[A-Za-z]*k' || kg_no "$kc_l code runs fuser -k"
  kc_z='([+-]?0+|-[[:space:]]*0*1)'
  case "$kc_l" in
    # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
    python) kc_re='os\.kill(pg)?\([[:space:]]*'$kc_z'[[:space:]]*[,)]|os\.killpg\([[:space:]]*os\.getpgrp\(' ;;
    node) kc_re='process\.kill\([[:space:]]*'$kc_z'[[:space:]]*[,)]' ;;
    # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
    ruby) kc_re='Process\.kill[[:space:](][^,)]*,[[:space:]]*'$kc_z'[[:space:]]*([,)]|$)' ;;
    perl) kc_re='(^|[^A-Za-z0-9_$.>-])kill[[:space:](]*[^,;)]*,[[:space:]]*'$kc_z'[[:space:]]*([,;)]|$)' ;;
    *) kc_re='' ;;
  esac
  [ -z "$kc_re" ] || ! kc_g "$kc_re" || kg_no "$kc_l code signals every process (pid 0 or -1)"
  # a kill of a PID that a process search produced: psutil's loop, or a kill call (os.kill, process.kill, a bare kill
  # in a command string) in code that also runs a search; a kill method of the code's own child handle (child.kill()) is not one
  # A161 (fix B): the kill-by-name verbs above, pid 0 / -1 / the caller's own group, and a psutil loop that kills what
  # process_iter lists are denied. A kill of a PID the code spawned itself (child.pid, proc.pid, a Popen handle) is
  # allowed even when the same code reads /proc or runs `ps -o rss= -p <pid>`: a code-level "kill fed by a process
  # search" cannot be told from that and denying it broke ordinary benchmark and test scripts.
  if kc_g 'process_iter' && kc_g '\.(kill|terminate)\('; then kg_no "$kc_l code kills processes it finds by listing them"; fi
  # a kill call in code that runs pgrep, pidof or lsof (name and port searches) kills what the search names; ps and /proc
  # reads are not such a search (a script measures its own child with ps -o rss= -p <pid>)
  if kc_g '(os|process|Process|signal)\.(kill|killpg)|(^|[^A-Za-z0-9_$.])kill([^A-Za-z0-9_]|$)' \
     && kc_g "(^|[^A-Za-z0-9_.\$-])(pgrep|pidof|lsof)([^A-Za-z0-9_-]|\$)"; then
    kg_no "$kc_l code kills PIDs it takes from pgrep, pidof or lsof"
  fi
  # a search EARLIER IN THE SAME COMMAND feeds the code its PIDs (pgrep x | python3 -c 'os.kill(int(p), 9) ...'), unless the code spawned the PID
  if [ "$kg_searched" = yes ] && kc_g '(os|process|Process|signal)\.(kill|killpg)|(^|[^A-Za-z0-9_$.])kill([^A-Za-z0-9_]|$)' \
     && ! kc_g '(^|[^A-Za-z0-9_])(Popen|spawn|spawnSync|fork|execFile|subprocess\.run|child_process)|\.pid([^A-Za-z0-9_]|$)'; then
    kg_no "$kc_l code kills PIDs a process search earlier in the command produced"
  fi
  # string literals are command lines (os.system("kill 0"), subprocess.run(["kill", "-9", "0"]))
  printf '%s\n' "$kc_t" | grep -Eo "$kg_lit_re" 2>/dev/null | head -n 60 > "$tmp/kgl.$KG_DEPTH" || :
  kc_k=''
  while IFS= read -r kc_s; do
    kc_s=${kc_s#?}; kc_s=${kc_s%?}
    [ -n "$kc_s" ] || continue
    case "$kc_s" in *kill*|*slay*|*fuser*) kg_sub "$kc_s" ;; esac   # only a literal that names a kill verb can be one
    if [ "$kc_s" = kill ]; then kc_k='kill'; elif [ -n "$kc_k" ] && [ "${#kc_k}" -lt 80 ]; then kc_k="$kc_k $kc_s"; fi
  done < "$tmp/kgl.$KG_DEPTH"
  [ -z "$kc_k" ] || kg_sub "$kc_k"
  return 0
}
# kg_script LANG TEXT: the content of a script, a here-document or piped text; LANG sh, auto (shebang or extension), or an interpreter.
kg_script() {
  ks_l=$1; ks_t=$2
  kg_has_words "$ks_t" || return 0   # the cheap pre-filter: no kill word, no rule
  if [ "$ks_l" = auto ]; then
    ks_h=$(printf '%s\n' "$ks_t" | head -n 1)
    case "$ks_h" in
      '#!'*python*) ks_l=python ;; '#!'*node*|'#!'*deno*|'#!'*bun*) ks_l=node ;; '#!'*perl*) ks_l=perl ;; '#!'*ruby*) ks_l=ruby ;; '#!'*php*) ks_l=php ;;
      '#!'*) ks_l='sh' ;;
      *) case "${kg_spath:-}" in *.py) ks_l=python ;; *.js|*.mjs|*.cjs) ks_l=node ;; *.pl) ks_l=perl ;; *.rb) ks_l=ruby ;; *) ks_l='sh' ;; esac ;;
    esac
  fi
  case "$ks_l" in sh) kg_sub "$ks_t" ;; *) kg_chk_code "$ks_l" "$ks_t" ;; esac
}
# kg_interp LANG: an interpreter command ($kg_args): its code operands are checked now, its script operand is queued
# (kg_run), no code and no script means it reads its program from stdin.
kg_interp() {
  ki_l=$1; ki_nx=''; ki_dd=no; ki_sc=''; ki_code=no
  while IFS= read -r ki_a; do
    if [ -n "$ki_nx" ]; then
      case "$ki_nx" in code) ki_code=yes; kg_chk_code "$ki_l" "$ki_a" ;; file) ki_sc=$ki_a ;; esac
      ki_nx=''; continue
    fi
    if [ "$ki_dd" = no ]; then
      case "$ki_a" in
        --) ki_dd=yes; continue ;;
        -) ki_code=yes; kg_stdin="$kg_stdin $ki_l"; continue ;;
      esac
      case "$ki_l" in
        # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
        python) case "$ki_a" in -m) ki_code=yes; ki_nx=skip; continue ;; -W|-X) ki_nx=skip; continue ;; -c|-[A-Za-z]c) ki_nx=code; continue ;; esac ;;
        node) case "$ki_a" in -e|--eval|-p|--print|-pe|-ep) ki_nx=code; continue ;; -r|--require|--import|--loader) ki_nx=skip; continue ;; esac
          [ "$ki_a" != eval ] || { ki_nx=code; continue; } ;;
        # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
        perl|ruby) case "$ki_a" in -*[!A-Za-z0-9]*|--*) case "$ki_a" in -I|-r) ki_nx=skip; continue ;; esac ;; -*[eE]) ki_nx=code; continue ;; esac ;;
        # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
        php) case "$ki_a" in -r) ki_nx=code; continue ;; -d) ki_nx=skip; continue ;; -f) ki_nx='file'; continue ;; esac ;;
        lua|osascript) case "$ki_a" in -e) ki_nx=code; continue ;; esac ;;
        awk) case "$ki_a" in -f) ki_nx='file'; continue ;; -F|-v|-e) ki_nx=skip; continue ;; esac ;;
      esac
      case "$ki_a" in -*) continue ;; esac
    fi
    # the first operand: awk's program text, else the script file
    if [ "$ki_l" = awk ] && [ "$ki_code" = no ]; then ki_code=yes; kg_chk_code awk "$ki_a"; break; fi
    ki_sc=$ki_a; break
  done <<KIARGS
$kg_args
KIARGS
  if [ -n "$ki_sc" ]; then
    printf '%s\003%s\n' "$ki_l" "$(kg_rp "$ki_sc")" >> "$tmp/kgr.$KG_DEPTH"
  elif [ "$ki_code" = no ]; then
    kg_stdin="$kg_stdin $ki_l"
  fi
}
kg_run() {
  kr_f=$1
  : > "$tmp/kgr.$KG_DEPTH"; : > "$tmp/kgh.$KG_DEPTH"; : > "$tmp/kge.$KG_DEPTH"
  kg_tbl=$(awk -F'\t' '$1 == "C" && ($2 == "env" || $2 == "export" || $2 == "local" || $2 == "declare" || $2 == "readonly" || $2 == "typeset") {
    n = split($3, a, "\003"); for (i = 1; i <= n; i++) if (a[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ && a[i] !~ /\002/) print a[i] }' "$kr_f")
  kg_prev='' kg_pend=no kg_searched=no kg_find=no kg_cand='' kg_taint='' kg_fpath='' kg_stdin='' kg_w1='' kg_viax='' kg_cwd='' kg_nrec=0
  # a process substitution <(...) that runs a search feeds a `read` or `mapfile` loop that is written BEFORE it
  # (while read p; do kill $p; done < <(pgrep x)): the loop is read once the search is known
  kg_psub=no
  if grep -q "^V$TAB"psub "$kr_f" && awk -F'\t' '$1 == "C" { split($2, a, "/"); if ($2 ~ /^(pgrep|pidof|ps|lsof|fuser|netstat|ss|pstree|jps)$/) f = 1 } END { exit !f }' "$kr_f"; then kg_psub=yes; fi
  # a shell or interpreter in the command that may read a program from stdin: `cat x.sh | sh` makes the file's text matter
  kg_rdr=no
  if awk -F'\t' '$1 == "C" && $2 ~ /^(sh|bash|dash|zsh|ksh|ash|mksh|posh|yash|python[0-9.]*|pypy3?|node|nodejs|deno|bun|perl|ruby|php|lua|osascript|awk|gawk|mawk|nawk)$/ { f = 1 } END { exit !f }' "$kr_f"; then kg_rdr=yes; fi
  while IFS= read -r kg_rec; do
    kg_nrec=$((kg_nrec + 1))
    if [ $((kg_nrec % 20)) = 0 ]; then kg_check_time "$kr_f"; fi
    case "$kg_rec" in
      F"$TAB"*) kg_fpath=${kg_rec#*"$TAB"}; continue ;;
      V"${TAB}xargs") kg_viax=yes; continue ;;
      V"${TAB}cwd$TAB"*) kg_cwd=${kg_rec#*"$TAB"cwd"$TAB"}; continue ;;
      W"$TAB"*) kg_w1=${kg_rec#*"$TAB"}; continue ;;
      H"$TAB"*) printf '%s\n' "${kg_rec#*"$TAB"}" >> "$tmp/kgh.$KG_DEPTH"; continue ;;
      C"$TAB"*) ;;
      *) continue ;;
    esac
    kg_fp=$kg_fpath; kg_fpath=''; kg_wp=$kg_w1; kg_w1=''; kg_vx=$kg_viax; kg_viax=''; kg_cd=$kg_cwd
    kg_rest=${kg_rec#*"$TAB"}; kg_cw=${kg_rest%%"$TAB"*}
    # Cost (A161, fix B): most records of a script are ordinary commands (cd, grep, echo, [ ...). Only the words below can
    # take part in a kill rule, so only they get the argument decoding, which forks. echo, printf, a redirected file,
    # an assignment and cat matter only when the record names a kill verb, a search or a variable.
    kg_full=no
    case "$kg_cw" in
      busybox|'$'*|kill|pkill|killall|killall5|skill|slay|fuser|eval|find|fd|fdfind|setsid|caffeinate|unbuffer|watch|flock|taskset|chrt|nsenter|strace|ltrace|runuser|su|systemd-run|script|sh|bash|dash|zsh|ksh|ash|mksh|posh|yash|source|.|python|python[0-9]*|pypy|pypy3|node|nodejs|deno|bun|perl|ruby|php|lua|osascript|awk|gawk|mawk|nawk|read|mapfile|readarray|for) kg_full=yes ;;
      echo|printf|'<'|cat)
        case "$kg_rest" in *kill*|*slay*|*fuser*) kg_full=yes ;; esac
        [ "$kg_cw$kg_find" != catyes ] || kg_full=yes
        [ "$kg_cw$kg_rdr" != catyes ] || kg_full=yes ;;
      env|export|local|declare|readonly|typeset)   # a binding matters when it names a search, is open (NAME= or ...$) or can use a tainted name
        case "$kg_rest" in *kill*|*slay*|*fuser*|*pgrep*|*pidof*|*lsof*|*ps*|*=|*'$'|*'='"$KG_SEP"*|*'$'"$KG_SEP"*) kg_full=yes ;; esac
        [ -z "$kg_taint" ] || case "$kg_rest" in *'$'*) kg_full=yes ;; esac ;;
    esac
    [ -z "$kg_fp" ] || kg_full=yes
    kg_args=''; kg_joined=''; kg_srch=no
    if [ "$kg_full" = yes ]; then
      case "$kg_rest" in *"$TAB"*) kg_args=$(printf '%s' "${kg_rest#*"$TAB"}" | tr '\003\002' '\n\n') ;; esac
      if [ "$kg_cw" = busybox ]; then   # busybox pkill / busybox kill: the applet is the first word
        kg_cw=$(printf '%s\n' "$kg_args" | head -n 1); kg_args=$(printf '%s\n' "$kg_args" | sed 1d)
      fi
      kg_joined=$(printf '%s' "$kg_args" | tr '\n' ' ')
      printf '%s\n' "$kg_joined" | grep -Eq '(^|[^A-Za-z0-9_.$-])(pgrep|pidof|ps|lsof|fuser|pkill)([^A-Za-z0-9_-]|$)' && kg_srch=yes
    fi
    # an environment prefix record (FOO=1 pgrep x) sits between a substitution's opening and its command: it is not that command
    kg_was=$kg_pend; [ "$kg_cw" = env ] || kg_pend=no
    if [ "$kg_was" = yes ] && kg_is_search "$kg_cw"; then kg_no "kill with PIDs taken from a process search (pgrep, pidof, ps, lsof, fuser)"; fi
    # a binding (NAME=value, for, read) that the search right before it fills: the name is tainted
    if [ -n "$kg_cand" ] && [ "$kg_cw" != env ] && [ "$kg_cw" != '$' ]; then   # a lone $ is the opening of a $(...) the binding is filled from
      if kg_is_search "$kg_cw"; then kg_taint="$kg_taint $kg_cand"; fi
      kg_cand=''
    fi
    if kg_is_search "$kg_cw"; then kg_searched=yes; fi
    if [ "$kg_full" = no ]; then kg_prev="$kg_prev $kg_cw"; continue; fi
    case "$kg_cw" in
      env|export|local|declare|readonly|typeset)
        while IFS= read -r kg_a; do
          case "$kg_a" in [A-Za-z_]*=*) ;; *) continue ;; esac
          kg_n=${kg_a%%=*}; kg_v=${kg_a#*=}
          kg_ref=no
          for kg_t in $kg_taint; do case "$kg_v" in *'$'"$kg_t"|*'$'"$kg_t"[!A-Za-z0-9_]*|*'${'"$kg_t"[!A-Za-z0-9_]*) kg_ref=yes ;; esac; done
          if [ "$kg_ref" = yes ] || printf '%s\n' "$kg_v" | grep -Eq '(^|[^A-Za-z0-9_.-])(pgrep|pidof|ps|lsof|fuser|pkill)([^A-Za-z0-9_-]|$)'; then kg_taint="$kg_taint $kg_n"; kg_searched=yes
          else case "$kg_v" in ''|*'$') kg_cand="$kg_cand $kg_n" ;; esac; fi
        done <<KGENV
$kg_args
KGENV
        ;;
      for)
        kg_n=$(printf '%s\n' "$kg_args" | head -n 1)
        kg_ref=no
        for kg_t in $kg_taint; do case "$kg_joined" in *'$'"$kg_t"|*'$'"$kg_t"[!A-Za-z0-9_]*|*'${'"$kg_t"[!A-Za-z0-9_]*) kg_ref=yes ;; esac; done
        if [ "$kg_srch" = yes ] || [ "$kg_ref" = yes ]; then kg_taint="$kg_taint $kg_n"; kg_searched=yes
        else case "$(printf '%s\n' "$kg_args" | tail -n 1)" in in|*'$') kg_cand="$kg_cand $kg_n" ;; esac; fi ;;
      read|mapfile|readarray)   # fed by a search earlier in the command (a pipe, a file, a process substitution)
        if [ "$kg_searched" = yes ] || [ "$kg_psub" = yes ]; then
          while IFS= read -r kg_a; do case "$kg_a" in -*|'') ;; *) kg_taint="$kg_taint $kg_a" ;; esac; done <<KGREAD
$kg_args
KGREAD
        else kg_cand="$kg_cand $(printf '%s\n' "$kg_args" | grep -Ev '^-' | tr '\n' ' ')"; fi ;;
    esac
    # a variable command word, eval, kill with a variable: the same command's assignments are substituted
    case "$kg_cw" in
      '$'*|eval|kill)
        if [ -n "$kg_tbl" ]; then
          kg_x=$(kg_expand "$kg_cw $kg_joined")
          if [ "$kg_x" != "$kg_cw $kg_joined" ] && [ "$kg_x" != "$kg_cw $kg_joined " ]; then kg_sub "$kg_x"; fi
        fi ;;
    esac
    case "$kg_cw" in
      pkill|killall|killall5|skill|slay)
        # no arguments (a usage error, also what `command -v killall` leaves) and --help / --version read only
        # (under xargs the patterns arrive on stdin: `xargs pkill` is a kill by pattern with the pattern hidden)
        case "$(printf '%s\n' "$kg_args" | head -n 1)" in
          "") [ "$kg_vx" != yes ] || kg_no "$kg_cw under xargs kills by the patterns that arrive on stdin" ;;
          --help|-h|--version|-V) ;;
          *) kg_no "$kg_cw kills by name or pattern" ;;
        esac ;;
      fuser) ! printf '%s\n' "$kg_args" | grep -Eq '^-[A-Za-z]*k' || kg_no "fuser -k kills whatever uses a file or port" ;;
      eval) kg_sub "$kg_joined" ;;
      '$'*) ;;
      kill)
        # signal options (-0 liveness probe, -s 0, -TERM) are not PIDs; an operand 0 or -1 signals everything
        kg_ops=0; kg_dd=no; kg_skip=no; kg_dl=no
        while IFS= read -r kg_a; do
          case "$kg_a" in *'$'*) kg_dl=yes ;; esac
          if [ "$kg_skip" = yes ]; then kg_skip=no; continue; fi
          if [ "$kg_dd" = no ]; then
            case "$kg_a" in
              --) kg_dd=yes; continue ;;
              -s|-n|--signal) kg_skip=yes; continue ;;
              -[0-9]*) [ "$(kg_num "$kg_a")" != -1 ] || kg_no "kill -1 signals every process"; continue ;;
              -*) continue ;;
            esac
          fi
          [ -n "$kg_a" ] || continue
          [ "$kg_a" = '{}' ] || kg_ops=$((kg_ops + 1))
          case "$kg_a" in [0-9+-]*|'$(('*) kg_v=$(kg_num "$kg_a") ;; *) kg_v='' ;; esac
          [ "$kg_v" != 0 ] || kg_no "kill $kg_a signals the whole process group"
          [ "$kg_v" != -1 ] || kg_no "kill $kg_a signals every process"
          for kg_t in $kg_taint; do
            case "$kg_a" in *'$'"$kg_t"|*'$'"$kg_t"[!A-Za-z0-9_]*|*'${'"$kg_t"[!A-Za-z0-9_]*) kg_no "kill \$$kg_t: the variable holds PIDs from a process search (pgrep, pidof, ps, lsof, fuser)" ;; esac
          done
          if [ "$kg_searched" = yes ]; then
            case "$kg_a" in '$@'|'$*'|'${@}'|'${*}'|'$@'*|'$1'|'$0'|'${1}'|'${0}') kg_no "kill of the arguments of a command fed by a process search" ;; esac
          fi
          # the scan leaves a bare `$` for "$(...)" and nothing for a backtick; the substituted command is the next record
          case "$kg_a" in *'$('*|*'$') kg_pend=yes ;; esac
        done <<KGARGS
$kg_args
KGARGS
        # no PID operand (or only xargs' {}) after a process search: the PIDs arrive on stdin
        [ "$kg_ops" != 0 ] || kg_pend=yes   # a backtick substitution, or PIDs on stdin (xargs)
        if [ "$kg_ops" = 0 ] && [ "$kg_dl" = no ]; then   # a variable among the arguments (-$pgid) is not "PIDs on stdin"
          case " $kg_prev " in *" pgrep "*|*" pidof "*|*" ps "*|*" lsof "*|*" fuser "*|*" pkill "*|*" netstat "*|*" ss "*|*" pstree "*|*" jps "*) kg_no "kill fed from a process search (pgrep, pidof, ps, lsof, fuser)" ;; esac
          [ "$kg_find" = no ] || kg_no "kill fed from find: PIDs chosen by file name are a kill by pattern"
        fi ;;
      find|fd|fdfind)
        kg_fx=no; kg_fn=''; kg_fb=''; kg_fl=''
        while IFS= read -r kg_a; do
          if [ "$kg_fx" = yes ]; then
            if [ -z "$kg_fn" ]; then kg_fn=${kg_a##*/}; kg_fl=$kg_fn; fi
            case "$kg_a" in ';'|'+') kg_fx=no; kg_fn='' ;; *) kg_fb="$kg_fb $kg_a" ;; esac
            case "$kg_fn" in
              kill|pkill|killall|killall5|skill|slay|fuser) kg_no "$kg_cw -exec $kg_fn acts on what find matched, a kill by pattern" ;;
              sh|bash|dash|zsh|ksh|ash) case "$kg_fb" in *[!A-Za-z0-9_.$-]kill[!A-Za-z0-9_-]*|*[!A-Za-z0-9_.$-]pkill*|*[!A-Za-z0-9_.$-]killall*|*' kill') kg_no "$kg_cw -exec $kg_fn -c runs kill on what find matched" ;; esac ;;
            esac
            continue
          fi
          case "$kg_a" in -exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch) kg_fx=yes; kg_fn=''; kg_fb='' ;; esac
        done <<KGFIND
$kg_args
KGFIND
        case "$kg_fl" in cat|head|tail|grep) ;; *) kg_find=yes ;; esac ;;
      cat)   # cat x.sh | sh: the file is the text the shell reads (like `sh < x.sh`); only files the guard may read
        kg_find=no
        kg_n=0
        while IFS= read -r kg_a; do
          case "$kg_a" in -*|'') continue ;; esac
          kg_n=$((kg_n + 1)); [ "$kg_n" -le 3 ] || break
          if kg_fo=$(kg_file_ok "$(kg_rp "$kg_a")"); then head -c 262144 "$kg_fo" | tr '\n' '\002' >> "$tmp/kge.$KG_DEPTH"; printf '\n' >> "$tmp/kge.$KG_DEPTH"; fi
        done <<KGCAT
$kg_args
KGCAT
        ;;
      setsid|caffeinate|unbuffer|watch|flock|taskset|chrt|nsenter|strace|ltrace|runuser|su|systemd-run|script)
        # a wrapper this scan does not know: the first kill verb among its arguments starts the wrapped command
        kg_wr=''
        while IFS= read -r kg_a; do
          if [ -n "$kg_wr" ]; then kg_wr="$kg_wr $kg_a"; continue; fi
          case "$kg_a" in
            pkill|killall|killall5|skill|slay|kill|fuser|/*/pkill|/*/killall|/*/kill) kg_wr=$kg_a ;;
            *' '*) kg_sub "$kg_a" ;;
          esac
        done <<KGWRAP
$kg_args
KGWRAP
        [ -z "$kg_wr" ] || kg_sub "$kg_wr" ;;
      sh|bash|dash|zsh|ksh|ash|mksh|posh|yash)
        ks_c=no; ks_o=''; ks_skip=no; ks_s=no
        while IFS= read -r kg_a; do
          if [ "$ks_skip" = yes ]; then ks_skip=no; continue; fi
          case "$kg_a" in
            -o|+o|-O|+O|--rcfile|--init-file) ks_skip=yes ;;
            --) ;;
            --*) ;;   # a long option (--norc, --posix) is not -c or -s, whatever letters it holds
            -*|+*) case "$kg_a" in -*c*) ks_c=yes ;; esac; case "$kg_a" in -*s*) ks_s=yes ;; esac ;;
            *) ks_o=$kg_a; break ;;
          esac
        done <<KGSH
$kg_args
KGSH
        if [ "$ks_c" = yes ]; then :   # the -c string is scanned as a nested command
        elif [ -n "$ks_o" ] && [ "$ks_s" = no ]; then printf 'sh\003%s\n' "$(kg_rp "$ks_o")" >> "$tmp/kgr.$KG_DEPTH"
        else kg_stdin="$kg_stdin sh"; fi ;;
      source|.) kg_a=$(printf '%s\n' "$kg_args" | head -n 1); [ -z "$kg_a" ] || printf 'sh\003%s\n' "$(kg_rp "$kg_a")" >> "$tmp/kgr.$KG_DEPTH" ;;
      python|python[0-9]*|pypy|pypy3) kg_interp python ;;
      node|nodejs|deno|bun) kg_interp node ;;
      perl) kg_interp perl ;;
      # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
      ruby) kg_interp ruby ;;
      # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
      php|lua|osascript) kg_interp "$kg_cw" ;;
      awk|gawk|mawk|nawk) kg_interp awk ;;
      echo|printf)   # text a later stdin-reading shell may run, or the content of a file this command writes
        kg_et=$(printf '%s\n' "$kg_args" | grep -Ev '^-[neE]+$' | awk '{ gsub(/\\n/, "\n"); print }')
        kg_ej=$(printf '%s\n' "$kg_et" | tr '\n' ' ')
        printf '%s\n' "$kg_et" | tr '\n' '\002' >> "$tmp/kge.$KG_DEPTH"; printf '\n' >> "$tmp/kge.$KG_DEPTH"
        if [ "$kg_cw" = echo ]; then printf '%s\n' "$kg_ej" >> "$tmp/kge.$KG_DEPTH"; fi
        if [ -n "$kg_wp" ]; then
          if [ "$kg_cw" = echo ]; then kg_ec=$kg_ej; else kg_ec=$(printf '%s\n' "$kg_et" | tr '\n' '\002'); fi
          printf '%s\003%s\003%s\n' "$kg_cw" "$kg_wp" "$(printf '%s' "$kg_ec" | tr '\n' '\002')" >> "$tmp/kgh.$KG_DEPTH"
        fi ;;
      '<') kg_a=$(printf '%s\n' "$kg_args" | head -n 1)
        if kg_fo=$(kg_file_ok "$kg_a"); then head -c 262144 "$kg_fo" | tr '\n' '\002' >> "$tmp/kge.$KG_DEPTH"; printf '\n' >> "$tmp/kge.$KG_DEPTH"; else printf '%s\n' "$kg_a" >> "$tmp/kge.$KG_DEPTH"; fi ;;
      *) [ -z "$kg_fp" ] || printf 'auto\003%s\n' "$kg_fp" >> "$tmp/kgr.$KG_DEPTH" ;;
    esac
    kg_prev="$kg_prev $kg_cw"
  done < "$kr_f"
  # script files the command runs (a file the same command writes with a here-document is read from the command)
  while IFS="$KG_SEP" read -r kg_l kg_p; do
    [ -n "$kg_p" ] || continue
    kg_np=${kg_p#./}; kg_body=''; kg_got=no
    while IFS="$KG_SEP" read -r kg_hc kg_hp kg_hb; do
      [ -n "$kg_hp" ] || continue
      if [ "${kg_hp#./}" = "$kg_np" ]; then kg_body=$(printf '%s' "$kg_hb" | tr '\002' '\n'); kg_got=yes; fi
    done < "$tmp/kgh.$KG_DEPTH"
    if [ "$kg_got" = no ] && kg_fo=$(kg_file_ok "$kg_p"); then kg_body=$(cat "$kg_fo"); kg_got=yes; fi
    [ "$kg_got" = yes ] || continue
    kg_spath=$kg_p
    kg_r=$(kg_script "$kg_l" "$kg_body") || { printf 'the script %s: %s\n' "$kg_p" "$kg_r"; exit 1; }
  done < "$tmp/kgr.$KG_DEPTH"
  # a shell or interpreter that reads its program from stdin: here-documents, echo/printf text and files fed to it
  for kg_l in $kg_stdin; do
    while IFS="$KG_SEP" read -r kg_hc kg_hp kg_hb; do
      # eco-ok: an interpreter whose inline code this safety guard reads, not an ecosystem's build or test command (A187)
      case "$kg_hc" in sh|bash|dash|zsh|ksh|ash|python*|node*|perl|ruby|php|lua|awk|cat|tee|echo|printf|osascript|deno|bun) ;; *) continue ;; esac
      kg_r=$(kg_script "$kg_l" "$(printf '%s' "$kg_hb" | tr '\002' '\n')") || { printf 'the here-document: %s\n' "$kg_r"; exit 1; }
    done < "$tmp/kgh.$KG_DEPTH"
    while IFS= read -r kg_hb; do
      [ -n "$kg_hb" ] || continue
      kg_r=$(kg_script "$kg_l" "$(printf '%s' "$kg_hb" | tr '\002' '\n')") || { printf 'the text piped or redirected into %s: %s\n' "$kg_l" "$kg_r"; exit 1; }
    done < "$tmp/kge.$KG_DEPTH"
  done
  return 0
}
kill_guard() {
  kg_r=$(kg_run "$tmp/scan") || deny "$kg_r"
  return 0
}

# --- events -----------------------------------------------------------------------------------
[ "$ev" = pretool ] || [ "$installed" = yes ] || exit 0
case "$ev" in
pretool)
  if [ "$parsed" = no ]; then
    [ -z "$act" ] || deny "hook input could not be parsed (jq or node is required) while run $act is active; failing closed"
    exit 0
  fi
  [ "$act" != INVALID ] || deny ".agents/local/ACTIVE_RUN is malformed; fix it with agent.sh before editing"
  baseline
  tool=$(jget tool_name)
  # A193: every proofline skill is disable-model-invocation, so the Skill tool cannot start one. A call that targets a proofline skill (the
  # lead's or a subagent's) is redirected in one line to reading the file; a skill that is not proofline's is not touched.
  if [ "$tool" = Skill ] && [ "$installed" = yes ]; then
    sk_n=$(jget tool_input.skill tool_input.name)
    sk_pre=no; case "$sk_n" in proofline:*) sk_pre=yes; sk_n=${sk_n#proofline:} ;; esac
    case "$sk_n" in ''|*[!A-Za-z0-9_-]*) sk_n='' ;; esac
    if [ -n "$sk_n" ]; then
      sk_f=''
      if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/skills/$sk_n/SKILL.md" ]; then sk_f=$CLAUDE_PLUGIN_ROOT/skills/$sk_n/SKILL.md
      elif [ -f "$root/.agents/skills/$sk_n/SKILL.md" ]; then sk_f=$root/.agents/skills/$sk_n/SKILL.md; fi
      # without the proofline: prefix the name counts only when no skill of the user's own bears it
      if [ "$sk_pre" = no ] && { [ -d "$root/.claude/skills/$sk_n" ] || [ -d "${HOME:-/nonexistent}/.claude/skills/$sk_n" ]; }; then sk_f=''; fi
      [ -z "$sk_f" ] || deny "do not use the Skill tool; read $sk_f and continue with the same step"
    fi
    exit 0
  fi
  cmd=''
  case "$tool" in Bash|shell|local_shell|exec_command|unified_exec) cmd=$(jget tool_input.command tool_input.cmd) ;; esac
  TAB=$(printf '\t')
  if [ "$installed" = no ]; then   # installed projects run merge_guard below, after the older rules, so their reasons win
    [ -z "$cmd" ] || { printf '%s\n' "$cmd" | scan_cmd > "$tmp/scan"; merge_guard; kill_guard; }
    exit 0
  fi
  if [ -n "$cmd" ]; then
    # A171: the dispatch marker is set by dispatch.sh alone; a model never sets it to record a decision ahead of a dispatch.
    # Checked on the text as written and with quotes, backslashes and variable references removed (so a name split by quotes or
    # joined from a variable is caught too); agent.sh itself accepts only a per-dispatch nonce file, which this text never names.
    # A188: a command with no quote, backslash or dollar sign is its own normal form (no sed)
    case "$cmd" in
      *'"'*|*"'"*|*'\'*|*'$'*) cmd_norm=$(printf '%s' "$cmd" | sed -e "s/[\"'\\\\]//g" -e 's/\${[^}]*}//g' -e 's/\$[A-Za-z_][A-Za-z0-9_]*//g') ;;
      *) cmd_norm=$cmd ;;
    esac
    case "$cmd$cmd_norm" in *PROOFLINE_DISPATCH*|*DISPATCH=*|*nonce-*|*.agents/local/dispatch*) deny "PROOFLINE_DISPATCH is set by dispatch.sh alone (A171). To only read a decision run: sh .agents/scripts/agent.sh decide <ID> <role> --dry" ;; esac
    # A name built at run time (printf 'PROOFLINE_%s' DISPATCH), a glob or a find over the folders that could hold the nonce file.
    dn_hit=no; case "$cmd_norm" in *PROOFLINE*) case "$cmd_norm" in *DISPATCH*) dn_hit=yes ;; esac ;; esac
    if [ "$dn_hit" = yes ] \
       || { case "$cmd" in *.agents*) true ;; *) false ;; esac && printf '%s' "$cmd" | grep -Eq '\.agents/[^/[:space:]]*[*?[]|\.agents/local/[^/[:space:]]*[*?[]|find[[:space:]][^;&|]*\.agents(/local)?/?([[:space:]]|$)'; }; then
      deny "PROOFLINE_DISPATCH and the dispatch nonce are dispatch.sh's alone (A171); list .agents/local by a literal path, no glob or find over .agents or .agents/local"
    fi
    # A102: the capability probes' self-test switches are never set by a model (they would hide a browser or benchmark).
    case "$cmd" in *PROOFLINE_PROBE_ROOT*|*PROOFLINE_SELFTEST*) deny "PROOFLINE_PROBE_ROOT and PROOFLINE_SELFTEST are self-test switches of the capability probes (A102); a model command never sets or names them" ;; esac
    # A specialist never mutates the live tree with git (stash, reset, checkout --, restore, clean, ...):
    # mutation evidence runs in a separate worktree (`git worktree add`, then `git -C <worktree> ...`).
    # (A read role is checked precisely by stash_guard below: effective directory, `git -C`, `cd`.)
    if [ -n "$act" ] && [ "$ro" = no ] && { [ "$sub" = yes ] || [ "$role" != lead ]; } \
       && printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|[[:space:]])git[[:space:]]+(reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout[[:space:]]+--)([[:space:]]|$)' \
       && ! printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+-C[[:space:]]|git[[:space:]]+worktree|--work-tree'; then
      deny "git must not change the live working tree from a specialist (stash, reset, clean, restore, checkout --, switch, ...); run mutation evidence in a separate worktree (git worktree add, then git -C <worktree> ...) and leave the tree as you found it$(ro_tail)"
    fi
    # Scratch space is $TMPDIR (the runtime's private temp dir), never /tmp directly: files outside the project
    # and $TMPDIR are what a run must not leave behind. A project that itself lives under /tmp is not scratch.
    printf '%s\n' "$cmd" | scan_cmd > "$tmp/scan"
    # A194: a command that produces evidence never runs through the user's rtk hook, which compresses output. rtk documents
    # `RTK_DISABLED=1 <command>` (docs/guide/getting-started/configuration.md); the prefix is demanded only when rtk and its hook are there.
    ev_re='agent[.]sh[[:space:]]+(build-record|verify-[a-z-]+)|(^|[;&|(]|[[:space:]])((npm|pnpm|yarn|bun)[[:space:]]+(run[[:space:]]+)?(test|build|lint)|pytest|go[[:space:]]+(test|build|vet)|cargo[[:space:]]+(test|build|clippy)|dotnet[[:space:]]+(test|build)|mvn|gradle|jest|vitest|make[[:space:]]+(test|build|check)|node[[:space:]]+--test|sh[[:space:]]+tests/)([[:space:]]|$)'
    rtk_need=no
    if printf '%s' "$cmd" | grep -Eq "$ev_re"; then rtk_need=yes
    else case "$role" in reviewer|security_reviewer|verifier) printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|[[:space:]])git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?(diff|show)([[:space:]]|$)' && rtk_need=yes ;; esac; fi
    if [ "$rtk_need" = yes ]; then
      case "$cmd" in
        *RTK_DISABLED=1*|*'rtk bypass'*) ;;
        *) if [ "${PROOFLINE_RTK:-}" != no ] && command -v rtk >/dev/null 2>&1 && grep -qs rtk "${HOME:-/nonexistent}/.claude/settings.json" "$root/.claude/settings.json" "$root/.claude/settings.local.json"; then
             deny "rtk is installed and its hook compresses command output, but this command produces evidence (agent.sh, build record, verification, tests, review diff) and must run uncompressed: prefix it with RTK_DISABLED=1, for example RTK_DISABLED=1 <command> (rtk configuration docs)"
           fi ;;
      esac
    fi
    if [ -n "$act" ] && { [ "$sub" = yes ] || [ "$role" != lead ]; } && ! tmp_is_scratch_root; then
      stray=$(stray_tmp_path "$cmd")
      # shellcheck disable=SC2016 # literal $TMPDIR in the message
      [ -z "$stray" ] || deny "$stray is outside the project. Allowed: reading the runtime's own background task output (/tmp/claude-*/**/tasks/<id>.output). Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); only git worktrees go under \$TMPDIR (${TMPDIR:-unset})"
    fi
    # A111: every `git stash` subcommand is refused in the project tree for a specialist (evidence worktrees are free).
    if [ -n "$act" ] && { [ "$sub" = yes ] || [ "$role" != lead ]; }; then stash_guard; fi
    # Hook and gate bypasses: never, for anyone, while proofline is installed.
    while IFS= read -r rec; do
      k=${rec%%"$TAB"*}; v=$(printf '%s' "${rec#*"$TAB"}" | tr '\002' '\n')
      case "$k" in
        S) deny "$v: on BSD/macOS sed the text glued to -i or the word after it is the backup suffix, so it leaves a stray file named like the target plus that token (QA_PLAN.md-E) that blocks handoff. Write the file with the Write/Edit tool, or sed -E ... file > scratch && mv scratch file, or perl -pi -e ... (sed -i '' is BSD-only, bare sed -i GNU-only)" ;;
        B) deny "git hook bypass is never allowed ($v); the git hooks enforce identity, gates and approvals" ;;
        A) case "${v#*"$TAB"}" in
             approve|approve-pending) deny "no model runs agent.sh ${v#*"$TAB"}: an approval is the user's. The runtime records it from the user's reply (the prompt hook) and agent.sh refuses it without that reply; wait for the user's answer, then run agent.sh next" ;;
             # A169: the turn runs a command that ends in a final report (completion report, deliver, batch status summary):
             # the Stop hook checks the identifiers of this turn's last message, and of no other message
             publish-completion-report|cleanup|terminate|deliver-plan|deliver-step|delivery-check|batch-status|batch-check)
               if [ "$role" = lead ] && [ "$sub" = no ]; then
                 rt_s=$(safe "$(jget session_id)"); [ -n "$rt_s" ] || rt_s=unknown
                 mkdir -p "$local_dir/report-turn" 2>/dev/null && : > "$local_dir/report-turn/$rt_s" 2>/dev/null
               fi ;;
           esac ;;
        W) ! always_protected "$(relpath "$v")" || deny "the command writes '$v', which wires the git hooks; it is never changed by an agent (git hook bypass)" ;;
      esac
    done < "$tmp/scan"
    # The merge guard is not run-scoped either (A136).
    merge_guard
    kill_guard
    # The database guard is not run-scoped: a task author or an explorer runs before any run exists (A50).
    db_guard_cmd "$cmd"
    [ -n "$act" ] || { [ "$role" != lead ] || [ "$sub" = yes ] || nr_bash_guard; scratch_guard; lead_tmp_check; exit 0; }
    has_role=no; grep -q "^R$TAB" "$tmp/scan" && has_role=yes
    while IFS= read -r rec; do
      k=${rec%%"$TAB"*}; v=$(printf '%s' "${rec#*"$TAB"}" | tr '\002' '\n')
      case "$k" in
        X) deny "$v is not allowed while run $act is active; write agent.sh, AGENT_ROLE and shell commands literally (only an argument may be a variable the same command assigns a plain literal: ID=T-1; sh .agents/scripts/agent.sh next \$ID)" ;;
        R) [ "$(canon "$v")" = "$role" ] || deny "AGENT_ROLE=$v does not match the caller's role ($role); a role never acts as another" ;;
        N) deny "specialists run through dispatch.sh (window, decision and recording), never as a nested runtime started by hand ($v)" ;;
        L) case "$v" in *.agents*) deny "ln '$v': links into or out of .agents/ are never made during a run" ;; esac
           case "$(relpath "$v")" in .agents|.agents/*) deny "ln '$v': links into or out of .agents/ are never made during a run" ;; esac ;;
        A) lit=${v%%"$TAB"*} sc=${v#*"$TAB"}
          [ "$lit" = 1 ] || deny "agent.sh subcommand '$sc' is not literal. Allowed form: ID=T-1; sh .agents/scripts/agent.sh next \$ID (a variable the same command assigns a plain literal) or write the subcommand out"
          case "$sc" in
            record|gate) deny "verdicts enter a run only through agent.sh submit, recorded for the SubagentStop hook or dispatch.sh (agent.sh $sc is never run by the lead or a subagent, D12)" ;;
            window-open|window-close) deny "implementer and designer windows are opened and closed only by the runtime hooks and dispatch.sh" ;;
          esac
          if [ "$sub" = yes ] || [ "$role" != lead ]; then
            case "$sc" in approve|waive|answer) deny "a subagent never approves, waives or answers; only the user does, through the lead (D13, D16)" ;; esac
            case "$role:$sc" in
              *:status|*:pipeline|*:fingerprint|*:verify-*|*:build-record) ;;   # build-record: `run` is refused for a non-lead role by the script itself
              *:submit)
                [ "$role" != lead ] || deny "the lead never submits a specialist result (D12)"
                [ "$has_role" = yes ] || deny "agent.sh submit runs as your role: prefix AGENT_ROLE=$role"
                if [ -n "$aid" ]; then
                  stok=$(printf '%s' "$cmd" | sed -n 's/.*--agent[ =]\{1,\}\([A-Za-z0-9_.-]*\).*/\1/p' | head -n 1)
                  [ "$stok" = "$aidf" ] || deny "agent.sh submit needs your agent token: add --agent $aidf" 
                fi ;;
              implementer:worker-evidence) [ "$has_role" = yes ] || deny "agent.sh worker-evidence runs only as the implementer: prefix AGENT_ROLE=implementer" ;;
              implementer:*) deny "the implementer runs only agent.sh worker-evidence status pipeline fingerprint verify-* (not $sc)" ;;
              *:next) ;;
              *) deny "role $role runs only the read-only agent.sh status pipeline fingerprint next verify-* (not $sc); state changes belong to the lead" ;;
            esac
          fi ;;
        W)
          [ -n "$v" ] || continue
          case "$v" in /dev/*) continue ;; esac
          # A read role writes through no `..` component: $TMPDIR/<worktree>/../../<project path> would pass the worktree check
          [ "$ro" = no ] || case "/$v/" in */../*) deny "the command writes '$v', which goes through a .. component and cannot be placed inside an evidence worktree$(ro_tail)" ;; esac
          case "$v" in
            *'$'*|*'*'*|*'?'*|*'['*)
              # shellcheck disable=SC2016 # literal $TMPDIR in the command text
              case "$v" in /tmp/*|/private/tmp/*|'$TMPDIR'/*|'${TMPDIR'*) continue ;; esac
              case "$role" in implementer|designer) case "$v" in *.agents*|*.claude/settings*|*.codex/*|*.git/*) deny "the command writes '$v', which may be protected run state" ;; esac; continue ;; esac
              deny "the command writes '$v', which cannot be resolved; while run $act is active the lead and read-only roles write only their run artifacts (shell write detection is a heuristic; use the Write tool on an allowed path)$(ro_tail)" ;;
          esac
          # A file the run created (untracked, or a link in scratch/) may be deleted by `rm`/`unlink` when that is the only write to it.
          why=$(target_ok "$v") || { [ "$(grep -cFx "W$TAB$v" "$tmp/scan")" = "$(grep -cFx "E$TAB$v" "$tmp/scan")" ] && erasable "$v" && continue; deny "the command writes '$v': $why$(ro_tail)"; } ;;
        P|Q)
          [ "$ro" = yes ] || continue
          why=$(ro_operand "$k" "$v") || deny "the command edits '$v' in place: $why$(ro_tail)" ;;
      esac
    done < "$tmp/scan"
    scratch_guard
    lead_tmp_check
    exit 0
  fi
  : > "$tmp/targets"
  case "$tool" in
    Edit|Write|MultiEdit|NotebookEdit)
      p=$(jget tool_input.file_path tool_input.notebook_path tool_input.path)
      [ -n "$p" ] || { [ -z "$act" ] || deny "$tool without a target path"; exit 0; }
      printf '%s\n' "$p" > "$tmp/targets" ;;
    *[Pp]atch*)   # Codex apply_patch: file headers inside the patch text
      jget tool_input | grep -Eo '\*\*\* (Add|Update|Delete) File: [^\\"]+|\*\*\* Move to: [^\\"]+' | sed 's/^\*\*\* [A-Za-z ]*: //' > "$tmp/targets" || : ;;
  esac
  while IFS= read -r tg; do ! always_protected "$(relpath "$tg")" || deny "$tool $tg wires the git hooks; it is never changed by an agent"; done < "$tmp/targets"
  case "$tool" in
    Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|*[Pp]atch*)
      db_load; set -f
      { while IFS= read -r tg_l || [ -n "$tg_l" ]; do printf '%s\n' "$tg_l"; done < "$tmp/targets"; for dk in tool_input.file_path tool_input.notebook_path tool_input.path tool_input.pattern; do jget "$dk"; printf '\n'; done; } > "$tmp/dbt"
      while IFS= read -r tg; do [ -z "$tg" ] || db_check_token "$tg" "$tool"; done < "$tmp/dbt"
      set +f ;;
  esac
  if [ -z "$act" ]; then   # A169: no run, the lead's main session: the ban on product files holds here too
    if [ "$role" = lead ] && [ "$sub" = no ]; then
      while IFS= read -r tg; do
        why=$(nr_path_ok "$(relpath "$tg")") || deny "$tool $tg: $why"
      done < "$tmp/targets"
    fi
    exit 0
  fi
  case "$tool" in *[Pp]atch*) jget tool_input | grep -Eo '\*\*\* Delete File: [^\\"]+' | sed 's/^\*\*\* Delete File: //' > "$tmp/erase" || : ;; esac
  while IFS= read -r tg; do
    # a patch that only deletes a file the run created (see erasable)
    why=$(target_ok "$tg") || { [ "$(grep -cFx -- "$tg" "$tmp/targets")" = 1 ] && grep -qFx -- "$tg" "$tmp/erase" 2>/dev/null && erasable "$tg" && continue; deny "$tool $tg: $why$(ro_tail)"; }
    # A120: the file tools write nothing outside the copy (the shell guard handles shell writes, A97)
    [ "$(relpath "$tg")" != @outside ] || why=$(outside_ok "$tg") || deny "$tool $tg: $why"
  done < "$tmp/targets"
  # A171: run files are English; the check runs when the file is written, not at the end of the run. The text about to be written
  # (Write content, Edit new_string, MultiEdit edits) goes through `agent.sh language-check`; the user's own words are kept
  # in a quote block (every line starts with '> '), which the check exempts. Raw logs, dispatch output, scratch and gates are exempt.
  case "$tool" in
    Write|Edit|MultiEdit)
      lp=$(relpath "$(jget tool_input.file_path tool_input.path)")
      # A178: exactly .agents/runs/<ID>/questions/NNN.md (the question block for the user, in the user's language) is not checked; the remainder after
      # the run folder is compared whole, so results/questions/001.md or reviews/a/questions/001.md are not taken for one. (agent.sh writes it;
      # target_ok denies every other writer first, so this line is a consistency guard, not a reachable path.)
      case "$lp" in .agents/runs/*/*) lq=${lp#.agents/runs/}; lq=${lq#*/}; case "$lq" in questions/[0-9][0-9][0-9].md) exit 0 ;; esac ;; esac
      case "$lp" in
        .agents/runs/*/dispatch/*|.agents/runs/*/scratch/*|.agents/runs/*/gates/*|.agents/runs/*/LEDGER.log) ;;
        .agents/runs/*/reviews/visual-proof/*|.agents/runs/*/reports/qa-evidence/*) ;;   # A172: machine output of the skills
        .agents/runs/*/*.md|.agents/runs/*/*.yaml|.agents/runs/*/*.json)
          if [ "$tool" = MultiEdit ]; then   # the new_string of every edit, as text (a JSON array would hide the line starts)
            case "$jp" in
              jq) jq -r '.tool_input.edits[]? | .new_string // empty' < "$tmp/in" > "$tmp/lang" 2>/dev/null || : ;;
              node) node -e 'try { for (const e of (JSON.parse(require("fs").readFileSync(0, "utf8")).tool_input.edits || [])) if (typeof e.new_string === "string") console.log(e.new_string) } catch (e) {}' < "$tmp/in" > "$tmp/lang" 2>/dev/null || : ;;
              *) : > "$tmp/lang" ;;
            esac
          else jget tool_input.content tool_input.new_string > "$tmp/lang"; fi
          if lres=$(unset AGENT_ROLE; sh "$agent" language-check - "$lp" < "$tmp/lang" 2>&1); then :; else deny "$tool $lp: $lres"; fi ;;
      esac ;;
  esac
  exit 0 ;;

subagent-start)
  [ "$parsed" = yes ] && [ -n "$prole" ] && [ -n "$act" ] && [ "$act" != INVALID ] || exit 0
  mkdir -p "$local_dir/windows" "$local_dir/records" "$local_dir/submissions"
  # A127: submit trusts a typed --agent over PROOFLINE_AGENT only for a registered subagent. The file holds the path of the
  # subagent's session log, where agent.sh reads the tokens it used (metrics_step); the path is the runtime's own, never typed.
  stp=$(jget agent_transcript_path); if [ -z "$stp" ]; then stp=$(jget transcript_path); [ -z "$stp" ] || stp=${stp%.jsonl}/subagents/agent-$aid.jsonl; fi
  printf '%s\n%s\n' "$stp" "$(date +%s)" > "$local_dir/submissions/$aidf.started"   # line 2: when this (re)start began; metrics_step times the step from it (A200)
  if [ "$prole" = implementer ] || [ "$prole" = designer ]; then
    if before=$(unset AGENT_ROLE; sh "$agent" window-open "$act" "$prole" 2>"$tmp/err"); then printf '%s\n' "$before" > "$local_dir/windows/$aidf"
    else printf 'proofline: window-open refused for proofline-%s (%s): %s\n' "$prole" "$aidf" "$(tr '\n' ' ' < "$tmp/err")" >> "$local_dir/records/$aidf.txt"; fi
  fi
  case "$prole" in explorer) rart="--report .agents/runs/$act/scratch/$aidf-report.md (write the report to EXACTLY this file, never a generic scratch name such as r.md, or pass --report - with the text on stdin; the script assigns the numbered report name, pass no --artifact)" ;; *) rart='[--artifact <path of your report>]' ;; esac
  ctx SubagentStart "proofline: active run $act (run dir .agents/runs/$act). You are role $prole; your agent token is $aidf. Prefix every state-changing agent.sh command with AGENT_ROLE=$prole. Report your result with: AGENT_ROLE=$prole sh .agents/scripts/agent.sh submit $act --agent $aidf --confidence <high|medium|low> [--focus F] $rart [--findings FILE] [--reason T] [--questions FILE]. The script builds the header, fingerprint and hashes and returns any rejection to you: fix what it names and submit again. Your final message is free text; the result is the submission." ;;

subagent-stop)
  # The result is the specialist's `agent.sh submit` (its status file under .agents/local/submissions/);
  # the final message is never parsed. A specialist that stops without a recorded submission is sent back
  # once with the last rejection; the second stop is accepted and reported to the lead as "no result".
  [ "$parsed" = yes ] && [ -n "$prole" ] || exit 0
  [ -n "$act" ] && [ "$act" != INVALID ] || exit 0
  rec=$local_dir/records; sdir=$local_dir/submissions; mkdir -p "$rec" "$local_dir/windows" "$sdir"
  st=$sdir/$aidf.status; out=$rec/$aidf.txt
  state=$(sed -n 's/^status=//p' "$st" 2>/dev/null | head -n 1)
  if [ "$state" != ok ]; then
    err=$(sed -n 's/^error=//p' "$st" 2>/dev/null | head -n 1)
    mark=$sdir/$aidf.retried; now=$(date +%s); prev=$(cat "$mark" 2>/dev/null || :)
    case "$prev" in *[!0-9]*) prev='' ;; esac
    # stop_hook_active is the runtime's "already sent back once"; a second hook layer firing for the same
    # stop (within two seconds) gives the same answer.
    if [ "$(jget stop_hook_active)" != true ] && { [ -z "$prev" ] || [ $((now - prev)) -le 2 ]; }; then
      [ -n "$prev" ] || printf '%s\n' "$now" > "$mark"
      case "$prole" in explorer) rart="--report .agents/runs/$act/scratch/$aidf-report.md (or - for stdin; the script assigns the numbered report name, pass no --artifact)" ;; *) rart='[--artifact <report path>]' ;; esac
      reason="proofline: you stopped without a recorded result. Run AGENT_ROLE=$prole sh .agents/scripts/agent.sh submit $act --agent $aidf --confidence <high|medium|low> [--focus F] $rart [--findings FILE] [--reason T] [--questions FILE]${err:+ (last rejection: $err)}, fix what it names, then finish."
      printf '{"decision":"block","reason":"%s"}\n' "$(jesc "$reason")"
      exit 0
    fi
    : > "$sdir/$aidf.final"
  fi
  rm -f "$sdir/$aidf.started"   # A127: the final stop; the status check above is done
  mkdir "$rec/$aidf.lock" 2>/dev/null || exit 0   # one record per subagent even when two hook layers fire
  if { [ "$prole" = implementer ] || [ "$prole" = designer ]; } && [ -f "$local_dir/windows/$aidf" ]; then
    if (unset AGENT_ROLE; sh "$agent" window-close "$act" "$(cat "$local_dir/windows/$aidf")" 0 "$prole") >"$tmp/o" 2>&1; then rm -f "$local_dir/windows/$aidf"
    else printf 'proofline: window-close rejected for proofline-%s: %s\n' "$prole" "$(tr '\n' ' ' < "$tmp/o")" >> "$out"; fi
  fi
  if [ "$state" = ok ]; then
    printf 'proofline: proofline-%s submitted: %s %s%s (%s)\n' "$prole" "$(sed -n 's/^role=//p' "$st" | head -n 1)" "$(sed -n 's/^result=//p' "$st" | head -n 1)" \
      "$(g=$(sed -n 's/^gate=//p' "$st" | head -n 1); [ -z "$g" ] || printf ' gate=%s' "$g")" "$(sed -n 's/^raw=//p' "$st" | head -n 1)" >> "$out"
  else
    printf 'proofline: proofline-%s ended without a recorded result%s; nothing recorded (no valid agent.sh submit)\n' "$prole" "${err:+ (last rejection: $err)}" >> "$out"
  fi
  exit 0 ;;

posttool)
  # Relay record/window outcomes to the lead (SubagentStop context reaches only the subagent).
  [ "$parsed" = yes ] && [ "$sub" = no ] && [ "$role" = lead ] || exit 0
  : > "$tmp/all"
  for f in "$local_dir"/records/*.txt; do
    [ -f "$f" ] || continue
    cat "$f" >> "$tmp/all"; rm -f "$f"; rmdir "${f%.txt}.lock" 2>/dev/null || :
  done
  [ -s "$tmp/all" ] || exit 0
  ctx PostToolUse "$(cat "$tmp/all")" ;;

prompt)
  # User-prompt capture for approvals and answered_by (GATES.md "Approvals"). Never for a dispatched
  # specialist, whose prompt is the lead's.
  [ "$parsed" = yes ] && [ "$sub" = no ] && [ "$role" = lead ] || exit 0
  pt=$(jget prompt; printf x) || exit 0; pt=${pt%x}   # the prompt exactly as sent (A188: kept in a variable; the x keeps trailing newlines)
  printf '%s' "$pt" > "$tmp/text"
  # A finished background agent arrives as a "prompt" (<task-notification>): not the user's words. It must not replace
  # the user's capture (an answer recorded afterwards compared against it) and cannot approve anything.
  case "$pt" in "<task-notification>"*) exit 0 ;; esac
  once
  sess=$(safe "$(jget session_id)"); [ -n "$sess" ] || sess=unknown
  [ -d "$shared_local/prompts" ] || mkdir -p "$shared_local/prompts" || exit 0
  # A171: the order is fixed. 1. the critical records (this prompt's capture and history file: they are what an approval or an
  # answer is checked against), nothing else before them; 2. housekeeping; 3. the approval, bounded in time; 4. the ledger flush.
  hk_tick; hk_c0=$hk_v
  h=$(sha "$tmp/text")
  pj=$(jesc "${pt}x"); pj=${pj%x}
  printf '{"session":"%s","time":%s,"sha256":"%s","text":"%s"}\n' "$sess" "$hk_s" "$h" "$pj" > "$shared_local/prompts/.$sess.tmp" &&
    mv "$shared_local/prompts/.$sess.tmp" "$shared_local/prompts/$sess.json"
  # Every prompt is kept (raw text) so an answer recorded as the user's can be checked against what was said (A60).
  { [ -d "$shared_local/prompts/history" ] || mkdir -p "$shared_local/prompts/history"; } && printf '%s' "$pt" > "$shared_local/prompts/history/$hk_s-$(printf '%.8s' "$h").txt" 2>/dev/null || :
  hk_step capture "$hk_c0"
  # The previous run of this hook did not finish (killed at the runtime's timeout): say so plainly. An .approving- marker of
  # another session that is older than two minutes is left over from a killed hook too: removed (A171), never reported here.
  warn=''; if [ -f "$shared_local/prompts/.approving-$sess" ]; then warn="proofline: the approval hook for the user's previous message did not finish (it timed out), so an approval in that message was NOT recorded. Tell the user plainly that the approval was not recorded and ask them to repeat it."; rm -f "$shared_local/prompts/.approving-$sess"; fi
  for ap_m in "$shared_local/prompts"/.approving-*; do   # A188: find starts only when a marker exists
    [ -e "$ap_m" ] || continue
    find "$shared_local/prompts" -maxdepth 1 -name '.approving-*' -mmin +2 -exec rm -f {} + 2>/dev/null || :
    break
  done
  hk_sweep
  [ "$(wc -l < "$local_dir/hook-times" 2>/dev/null || echo 0)" -le 5000 ] || { tail -n 2000 "$local_dir/hook-times" > "$local_dir/hook-times.t" && mv "$local_dir/hook-times.t" "$local_dir/hook-times"; } 2>/dev/null || :
  # Approvals are recorded here, by the runtime, from the user's own reply (A41): every open request this
  # prompt satisfies (approval phrase and kind word, single-use) becomes an approval. The lead never runs
  # `agent.sh approve`; a prompt that approves nothing changes nothing.
  # Fast path: agent.sh starts only when an approval request is open; a marker left behind means a timeout.
  # A171: the output goes to .agents/local/approve.log; a refusal is shown as one line to the lead and the user; the step is
  # stopped after PROOFLINE_HOOK_APPROVE_BUDGET seconds (default 20 of the runtime's 30) and a lock is waited for at most
  # PROOFLINE_HOOK_LOCK_WAIT seconds (default 8), so the hook ends in time, writes the reason and the next `agent.sh next` retries.
  msgs=''
  req=no; for f in "$sroot/.agents/runs/$act/approvals/"[0-9][0-9][0-9]-request-*.yaml "$shared_local/approvals/"[0-9][0-9][0-9]-request-*.yaml; do [ ! -f "$f" ] || req=yes; done
  if [ "$act" != INVALID ] && [ "$req" = yes ]; then
    hk_tick; hk_a0=$hk_v; printf '%s\n' "$h" > "$shared_local/prompts/.approving-$sess"
    ( unset AGENT_ROLE; PROOFLINE_LOCK_TIMEOUT=${PROOFLINE_HOOK_LOCK_WAIT:-8}; export PROOFLINE_LOCK_TIMEOUT; exec sh "$agent" approve-pending "$act" ) >"$tmp/ap.out" 2>&1 </dev/null &
    ap_pid=$!; ap_lim=$(( ${PROOFLINE_HOOK_APPROVE_BUDGET:-20} * 10 )); ap_i=0
    while kill -0 "$ap_pid" 2>/dev/null && [ "$ap_i" -lt "$ap_lim" ]; do   # A188: 0.1 s steps for the first second, then 0.5 s (a sleep is a process)
      if [ "$ap_i" -lt 10 ]; then sleep 0.1; ap_i=$((ap_i + 1)); else sleep 0.5; ap_i=$((ap_i + 5)); fi
    done
    if kill -0 "$ap_pid" 2>/dev/null; then
      # the step started children (agent.sh approve takes the lock in its own process): stop the whole tree, by pid
      ap_all=$ap_pid; ap_new=$ap_pid
      while [ -n "$ap_new" ]; do
        ap_next=''
        for ap_c in $ap_new; do ap_next="$ap_next $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$ap_c" '$2 == p { print $1 }')"; done
        ap_new=$(printf '%s\n' $ap_next); ap_all="$ap_all $ap_new"
      done
      # shellcheck disable=SC2086 # pids
      kill $ap_all 2>/dev/null || :
      { wait "$ap_pid"; } 2>/dev/null || :
      hk_tick; hk_line "$ev.approve" $(( hk_v - hk_a0 )) timeout "stopped-by-hook-budget"
      printf '%s approval step stopped after %ss (prompt hook budget)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PROOFLINE_HOOK_APPROVE_BUDGET:-20}" >> "$local_dir/approve.log" 2>/dev/null || :
      msgs="proofline: the approval step ran out of time and was stopped, so an approval in your last message may NOT be recorded; the lead retries it at the next 'agent.sh next' (details: .agents/local/approve.log)."
    else
      wait "$ap_pid" 2>/dev/null || :
      hk_step approve "$hk_a0"
      ap_ok=$(sed -n 's/^approved: //p' "$tmp/ap.out" | head -n 3 | tr '\n' ';')
      ap_bad=$(sed -n 's/^not recorded: //p' "$tmp/ap.out" | head -n 1)
      [ -z "$ap_ok" ] || msgs="proofline: approval recorded: ${ap_ok%;}"
      [ -z "$ap_bad" ] || msgs="${msgs:+$msgs }proofline: approval NOT recorded: $(printf '%s' "$ap_bad" | cut -c1-240) (the lead retries at the next 'agent.sh next'; log: .agents/local/approve.log). No command is needed from you."
    fi
  fi
  # A185 (round 2): a prompt has no path and the session's working directory is usually the main tree, so the run of a worktree (night mode,
  # worktree-add) is not `act` here. Its pending request (scope, waive:*, destructive, single_step, budget, reopen) is found by a glob of the main
  # tree's worktree folder (no process when none exists, A188) and approved by THAT worktree's agent.sh, which agent.sh worktree-root must
  # confirm as a registered worktree of this project (never the path string alone); the same budget, the log is the shared approve.log.
  wl=''
  for f in "$shared_local"/worktrees/*/.agents/runs/*/approvals/[0-9][0-9][0-9]-request-*.yaml; do
    [ -f "$f" ] || continue
    wl_r=${f#"$shared_local"/worktrees/}; wl_d=$shared_local/worktrees/${wl_r%%/*}
    [ "$wl_d" != "$sroot" ] || continue   # the session's own worktree is the run handled above
    wl_run=${wl_r#*/.agents/runs/}; wl_run=${wl_run%%/*}
    case "$wl_run" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
    case " $wl " in *" $wl_d|$wl_run "*) continue ;; esac
    wl="$wl $wl_d|$wl_run"
  done
  # round 6: one reply must not approve the unrelated requests of several runs. With more than one run waiting (the main tree's counts) only a run
  # whose id the reply names is approved; one waiting run alone needs no name
  if [ -n "$wl" ]; then
    wl_n=0; for wl_e in $wl; do wl_n=$((wl_n + 1)); done
    [ "$req" != yes ] || wl_n=$((wl_n + 1))
    if [ "$wl_n" -gt 1 ]; then
      wl_all=$wl; wl=''
      for wl_e in $wl_all; do case "$pt" in *"${wl_e#*|}"*) wl="$wl $wl_e" ;; esac; done
      [ -n "$wl" ] || msgs="${msgs:+$msgs }proofline: several runs wait for an approval ($(for wl_e in $wl_all; do printf '%s ' "${wl_e#*|}"; done)); an approval records for the run named in your reply: say which run you approve (for example \"approve scope <ID>\")."
    fi
  fi
  if [ -n "$wl" ] && [ "$act" != INVALID ]; then
    [ -e "$shared_local/prompts/.approving-$sess" ] || printf '%s\n' "$h" > "$shared_local/prompts/.approving-$sess"
    hk_tick; hk_a2=$hk_v; : > "$tmp/apw.all"
    ap_lim=$(( ${PROOFLINE_HOOK_APPROVE_BUDGET:-20} * 10 )); ap_i=${ap_i:-0}
    for wl_e in $wl; do
      wl_d=${wl_e%%|*}; wl_run=${wl_e#*|}
      wl_ok=$(sh "$agent" worktree-root "$wl_d" 2>/dev/null) || continue
      # the worktree's agent.sh is a tracked file a task could have rewritten: it runs only when it is byte-identical to the main tree's own
      [ "$wl_ok" = "$wl_d" ] && [ -f "$wl_d/.agents/scripts/agent.sh" ] && cmp -s "$wl_d/.agents/scripts/agent.sh" "$agent" || continue
      ( unset AGENT_ROLE; PROOFLINE_LOCK_TIMEOUT=${PROOFLINE_HOOK_LOCK_WAIT:-8}; export PROOFLINE_LOCK_TIMEOUT; exec sh "$wl_d/.agents/scripts/agent.sh" approve-pending "$wl_run" ) >"$tmp/apw.out" 2>&1 </dev/null &
      ap_pid=$!
      while kill -0 "$ap_pid" 2>/dev/null && [ "$ap_i" -lt "$ap_lim" ]; do
        if [ "$ap_i" -lt 10 ]; then sleep 0.1; ap_i=$((ap_i + 1)); else sleep 0.5; ap_i=$((ap_i + 5)); fi
      done
      if kill -0 "$ap_pid" 2>/dev/null; then
        ap_all=$ap_pid; ap_new=$ap_pid
        while [ -n "$ap_new" ]; do
          ap_next=''
          for ap_c in $ap_new; do ap_next="$ap_next $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$ap_c" '$2 == p { print $1 }')"; done
          ap_new=$(printf '%s\n' $ap_next); ap_all="$ap_all $ap_new"
        done
        # shellcheck disable=SC2086 # pids
        kill $ap_all 2>/dev/null || :
        { wait "$ap_pid"; } 2>/dev/null || :
        hk_tick; hk_line "$ev.approve" $(( hk_v - hk_a2 )) timeout "stopped-by-hook-budget"
        printf '%s approval step of worktree run %s stopped after %ss (prompt hook budget)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$wl_run" "${PROOFLINE_HOOK_APPROVE_BUDGET:-20}" >> "$shared_local/approve.log" 2>/dev/null || :
        msgs="${msgs:+$msgs }proofline: the approval step of run $wl_run ran out of time and was stopped, so an approval in your last message may NOT be recorded (details: .agents/local/approve.log)."
        break
      fi
      wait "$ap_pid" 2>/dev/null || :
      cat "$tmp/apw.out" >> "$tmp/apw.all"
    done
    hk_step approve "$hk_a2"
    ap_ok=$(sed -n 's/^approved: //p' "$tmp/apw.all" | head -n 3 | tr '\n' ';')
    ap_bad=$(sed -n 's/^not recorded: //p' "$tmp/apw.all" | head -n 1)
    [ -z "$ap_ok" ] || msgs="${msgs:+$msgs }proofline: approval recorded: ${ap_ok%;}"
    [ -z "$ap_bad" ] || msgs="${msgs:+$msgs }proofline: approval NOT recorded: $(printf '%s' "$ap_bad" | cut -c1-240) (the lead retries at the next 'agent.sh next'; log: .agents/local/approve.log). No command is needed from you."
  fi
  [ ! -e "$shared_local/prompts/.approving-$sess" ] || rm -f "$shared_local/prompts/.approving-$sess"
  hk_flush
  [ -z "$warn" ] || msgs="$warn${msgs:+ $msgs}"
  [ -n "$msgs" ] || exit 0
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$(jesc "$msgs")" "$(jesc "$msgs")"
  exit 0 ;;

stop)
  # The final report to the user carries the run's state, class and gate names verbatim (A44, TR-2): they are
  # identifiers, never translated. Every final message of a reporting state is checked (A68). A154: a message that
  # lacks identifiers is no longer sent back for a rewrite. A Stop hook cannot edit the assistant's message, so the
  # hook supplies the missing lines itself, taken verbatim from `agent.sh summary`, as a systemMessage shown to the
  # user next to the report; the turn ends (no block, no loop).
  # A159: every /proofline command ends with one "Next step:" line (a user command, never an internal one). When the
  # lead left it out, the hook adds it, from the user's last prompt (the command) and the run state (`agent.sh next-user`).
  [ "$parsed" = yes ] && [ "$sub" = no ] && [ "$role" = lead ] || exit 0
  [ "$installed" = yes ] || exit 0
  hk_flush
  # A169: the identifier check runs only for the final report of a run, the message that ends a turn in which the lead
  # ran a report command (marked by pretool, see report-turn); an ordinary answer gets nothing appended.
  sess=$(safe "$(jget session_id)"); [ -n "$sess" ] || sess=unknown
  final_report=no
  if [ -f "$local_dir/report-turn/$sess" ]; then final_report=yes; rm -f "$local_dir/report-turn/$sess"; fi
  msg=$(jget last_assistant_message)
  if [ -z "$msg" ]; then
    tp=$(jget transcript_path)
    if [ -n "$tp" ] && [ -f "$tp" ] && command -v jq >/dev/null 2>&1; then
      msg=$(jq -rs '[.[] | select(.type == "assistant")] | last | .message.content | if type == "array" then map(select(.type == "text") | .text) | join("\n") else . end' "$tp" 2>/dev/null) || msg=''
    fi
  fi
  [ -n "$msg" ] || exit 0
  out=''
  if [ "$final_report" = yes ] && [ -n "$act" ] && [ "$act" != INVALID ]; then
    need=$(unset AGENT_ROLE; sh "$agent" report-tokens "$act" 2>/dev/null) || need=''
    missing=''
    for tk in $need; do printf '%s' "$msg" | grep -Fqw -- "$tk" || missing="$missing $tk"; done
    if [ -n "$missing" ]; then
      summ=$(unset AGENT_ROLE; sh "$agent" summary "$act" 2>/dev/null) || summ=''
      lines=''
      for tk in $missing; do
        l=$(printf '%s\n' "$summ" | grep -Fw -- "$tk" | head -n 1)
        [ -n "$l" ] || l=$tk
        case "
$lines
" in *"
$l
"*) ;; *) lines="$lines
$l" ;; esac
      done
      out="proofline: the final report lacks these identifiers:$missing. They are appended here verbatim from 'agent.sh summary $act' (never translated):$lines"
    fi
  fi
  # the command of the user's last prompt: "/proofline <command> [<TASK-ID>]" ("$proofline" for Codex)
  # A188: the first line of the capture file, its "text" value up to the first escaped newline (it was sed, sed and head)
  pc=''
  if [ -f "$shared_local/prompts/$sess.json" ]; then
    IFS= read -r pc_l < "$shared_local/prompts/$sess.json" || :
    case $pc_l in *'"text":"'*'"}') pc=${pc_l#*'"text":"'}; pc=${pc%'"}'}; pc_n='\n'; pc=${pc%%"$pc_n"*} ;; esac
  fi
  case "$pc" in
    '/proofline '*|'$proofline '*)
      # shellcheck disable=SC2086 # the prompt's words are split on purpose
      set -- $pc; pcmd=${2:-}; pid=${3:-}
      case "$pid" in -*|*[!A-Za-z0-9_-]*) pid='' ;; esac
      case "$pid" in *-*) ;; *) pid='' ;; esac
      if ! printf '%s' "$msg" | grep -Fq 'Next step:'; then
        nu=$(unset AGENT_ROLE; sh "$agent" next-user "$pcmd" ${pid:+"$pid"} 2>/dev/null) || nu=''
        if [ -n "$nu" ]; then out="${out:+$out
}$nu"; fi
      fi ;;
  esac
  # A171: the lead never asks the user to run an internal command (agent.sh approve, answer, ...). When the message does, that
  # is a proofline bug: the hook records a friction note (counted in the friction report) and says so in one line.
  # Only a request counts: the command sits on a line that asks the user to run it ("please run", "run:", an imperative line), or in a
  # code fence announced by such a line. A report of what the lead itself ran ("I ran agent.sh next") is not one.
  # A193: Claude Code rejects a Skill call for a proofline skill itself (disable-model-invocation) before any hook runs, so the hook cannot answer it.
  # What it can do is catch the turn that gives up on it: a message that quotes that error, or asks the user to run /proofline:proofline-<skill>,
  # is sent back once with the file to read.
  case "$msg" in *disable-model-invocation*|*'/proofline:proofline-'*)
    if [ "$(jget stop_hook_active)" != true ]; then
      if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then sk_rf=$CLAUDE_PLUGIN_ROOT/skills; else sk_rf=$root/.agents/skills; fi
      printf '{"decision":"block","reason":"%s"}\n' "$(jesc "proofline: do not ask the user to run a proofline skill and do not stop at the Skill tool error: every proofline skill is disable-model-invocation. Read the skill file ($sk_rf/<name>/SKILL.md, for example $sk_rf/proofline-lead/SKILL.md) and continue with the same step.")"
      exit 0
    fi ;;
  esac
  # A193: the request is also refused (the message is sent back once) and it covers --no-verify, the edit of a file under .agents/ and a
  # command started with "!"; a command that is the user's own work (git push, gh auth login, a plugin update) is never matched.
  fr_hit=no   # A188: the patterns below name agent.sh, --no-verify or .agents/, so a message without that text cannot match (no awk)
  case "$msg" in *agent.sh*|*--no-verify*|*.agents/*) fr_hit=$(printf '%s\n' "$msg" | awk -v re='agent\\.sh[[:space:]]+[a-z]|--no-verify' -v mut='(edit|modify|change|append|overwrite|delete|remove|rm|mv|cp|sed|tee|touch|vim|nano|echo|printf|cat)[[:space:]]|>' '
    function asks(t) { t = tolower(t); return t ~ /(please|kindly)[[:space:]]+(run|execute|paste|type|enter|edit|modify|change)/ || t ~ /you[[:space:]]+(should|can|could|must|need to|have to|may)[[:space:]]+(run|execute|paste|type|enter|edit|modify|change)/ || t ~ /(run|execute|paste|type|enter)[[:space:]]*:/ || t ~ /^[[:space:]>*-]*(run|execute|paste|type|enter|edit|modify|change)[[:space:]]/ || t ~ /(in|into) (your|a) terminal/ || t ~ /^[[:space:]>*-]*!/ }
    function named(t) { return t ~ re || (t ~ /[.]agents\// && tolower(t) ~ mut) }
    /^[[:space:]]*```/ { fence = !fence; if (fence) fa = prev; next }
    { if (fence) { if (named($0) && fa) hit = 1 } else { if (named($0) && asks($0)) hit = 1; prev = asks($0) } }
    END { print hit ? "yes" : "no" }') ;;
  esac
  if [ "$fr_hit" = yes ]; then
    sh_again=$(jget stop_hook_active)
    if [ "$sh_again" != true ] && [ -n "$act" ] && [ "$act" != INVALID ]; then (unset AGENT_ROLE; sh "$agent" friction-note "$act" user-command >/dev/null 2>&1) || :; fi
    fr_msg="Do not make the user do this: this message asks the user to run an internal command (agent.sh, approve, answer, --no-verify) or to edit a file under .agents/ by hand. Either do it yourself through the right path, or report it in one line as a proofline bug and write it to the friction report (A171, A193). The user's own work (git push, gh auth login, a plugin update) may stay in the message."
    if [ "$sh_again" != true ]; then   # sent back once; the runtime sets stop_hook_active on the retry, which then ends the turn
      printf '{"decision":"block","reason":"%s"}\n' "$(jesc "proofline: $fr_msg")"
      exit 0
    fi
    out="${out:+$out
}proofline: this message asks the user to run an internal command (agent.sh ...). That is a proofline bug (A171), noted in the friction report. The lead runs internal commands itself and tells the user only the one-line state and a /proofline next step."
  fi
  [ -n "$out" ] || exit 0
  printf '{"systemMessage":"%s"}\n' "$(jesc "$out")"
  exit 0 ;;

session)
  [ "$role" = lead ] && [ "$sub" = no ] || exit 0
  once
  hk_sweep; hk_flush
  case "$rt" in
    codex) skill=.agents/skills/proofline-lead/SKILL.md ;;
    *) if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then skill=$CLAUDE_PLUGIN_ROOT/skills/proofline-lead/SKILL.md; else skill=.agents/skills/proofline-lead/SKILL.md; fi ;;
  esac
  if [ -n "$act" ] && [ "$act" != INVALID ]; then
    # A200: bounded (PROOFLINE_HOOK_NEXT_BUDGET seconds, default 10 of the runtime's 30): the session starts at once and the lead asks `agent.sh next` itself
    hb_rc=0; hk_budget "${PROOFLINE_HOOK_NEXT_BUDGET:-10}" "$tmp/next.out" sh "$agent" next "$act" || hb_rc=$?
    nxt=$(sed -n 's/^next=//p' "$tmp/next.out" | awk 'BEGIN { ORS = "" } { if (NR > 1) print "; "; print }')
    [ "$hb_rc" != 124 ] || nxt="run sh .agents/scripts/agent.sh next $act (the session check did not finish within the hook's time budget)"
  else nxt="no active run: start one with the proofline-lead skill"; fi
  # A194: the plugin and the project's install are different versions: one line, and the lead says so before it starts a run
  sv_msg=''
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
    sv_p=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json" | head -n 1)
    sv_i=$(sed -n 's/^proofline_version:[[:space:]]*"\{0,1\}\([0-9][0-9.]*\).*/\1/p' "$root/.agents/config.yaml" | head -n 1)
    if [ -n "$sv_p" ] && [ -n "$sv_i" ] && [ "$sv_p" != "$sv_i" ]; then
      sv_msg="proofline version mismatch: plugin $sv_p, this project's install $sv_i; run /proofline upgrade (or update the plugin if the project is the newer one)"
    fi
  fi
  if [ -n "$sv_msg" ]; then
    sv_c="proofline installed; you are the lead; use the proofline-lead skill ($skill) by reading that file (never through the Skill tool: every proofline skill is disable-model-invocation and the call fails); active run: ${act:-none}; next step: ${nxt:-agent.sh next ${act} failed}. $sv_msg. Tell the user this before you start a run."
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(jesc "$sv_msg")" "$(jesc "$sv_c")"; exit 0
  fi
  ctx SessionStart "proofline installed; you are the lead; use the proofline-lead skill ($skill) by reading that file (never through the Skill tool: every proofline skill is disable-model-invocation and the call fails); active run: ${act:-none}; next step: ${nxt:-agent.sh next ${act} failed}" ;;

*) echo "usage: proofline-hook.sh <pretool|posttool|subagent-start|subagent-stop|prompt|stop|session> [claude|codex]" >&2; exit 0 ;;
esac
