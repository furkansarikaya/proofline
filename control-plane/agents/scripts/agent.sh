#!/bin/sh
# proofline control plane: the deterministic lifecycle of one task run.
# Installed as <project>/.agents/scripts/agent.sh; the project root is two directories above this file.
# Normative description: .agents/WORKFLOW.md, GATES.md, PROTOCOL.md, ENFORCEMENT.md.
# POSIX sh only: no `local`; helper variables carry a per-function prefix so callers' id/dir survive.
# shellcheck disable=SC2010,SC2015 # ls|grep over our own fixed-pattern file names; A && B || C on read-only pipelines
set -eu
LC_ALL=C; export LC_ALL
# A194: every command this script (and build-record, verification, dispatch) starts runs uncompressed when the user has rtk (its documented switch)
RTK_DISABLED=1; export RTK_DISABLED

# A188: the folder of this script by parameter expansion (no dirname process; every hook event starts this script at least once)
case "$0" in */*) self_dir=${0%/*}; [ -n "$self_dir" ] || self_dir=/ ;; *) self_dir=. ;; esac
root=$(CDPATH='' cd "$self_dir/../.." && pwd)
agents=$root/.agents
config=$agents/config.yaml
scripts=$agents/scripts
# A185: shared_dir NAME is the ONE place the state that belongs to no single run (batch approvals metrics friction prompts) lives:
# <main working tree>/.agents/local/NAME, reached by path from the main tree and from every run worktree, never through a link (a
# link is a copy on Windows without symlink rights, and a copy would go stale). In the main tree sr_main is root, so nothing changes there.
sr_main=$root
if [ -f "$root/.git" ]; then   # a linked worktree has a .git file; only the ones proofline made under <main>/.agents/local/worktrees share
  sr_m=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); sr_p=$(cd "$root" && pwd -P)
  case "$sr_p" in "$sr_m"/.agents/local/worktrees/*) sr_main=$sr_m ;; esac
fi
shared_dir() { printf '%s/.agents/local/%s\n' "$sr_main" "$1"; }
PROOFLINE_SHARED_ROOT=$sr_main; export PROOFLINE_SHARED_ROOT

# Node migration (ADR 0001): a moved command runs in proofline-core.mjs, before anything below is parsed. Without a usable node the exec fails
# with 127. The leading --pl-argv0 argument hands over this script's own $0, so that a fallback to this code prints the same $0 in its error
# texts; the core uses it only when it names this very file.
# The commands that still run as shell code (listed here, one list); every other command, a name that is no command and no command at all run in
# proofline-core.mjs, which answers an unknown name with the usage text. tests/core/table.test.mjs checks the list against the Node handlers.
case "${1:-}" in
  friction|calibrate|build-record|lessons|rules|decide|\
  metrics-dispatch|wait-line|ledger-note|\
  worktree-add|worktree-path|worktree-remove|batch-plan|batch-cover|batch-status|batch-answer|\
  batch-answers|task-rename-plan|task-rename-apply|batch-next|\
  batch-awake|batch-park|test) ;;
  *)
    pl_sh=no
    # PROOFLINE_BRIDGED is set only by the core itself, when it hands one input to this code (no model or user sets it; the hook denies it): it stops the loop.
    [ -z "${PROOFLINE_BRIDGED:-}" ] || pl_sh=yes
    # A run worktree's scripts are tracked content a task could have rewritten (security round 3): from a worktree the PROJECT's (main tree's) core runs,
    # and --pl-argv0 below names the worktree's agent.sh, which tells the core which folder is the root. In the main tree pl_core_dir is self_dir.
    pl_core_dir=$self_dir
    [ "$sr_main" = "$root" ] || pl_core_dir=$sr_main/.agents/scripts
    # No core beside this file: a folder that is not an installed project (no manifest; a test fixture that copies agent.sh alone, test-lib.sh)
    # runs the shell code; an installed project fails closed (a guard that needs this command must deny, not see empty settings).
    if [ "$pl_sh" = no ] && { [ ! -f "$pl_core_dir/proofline-core.mjs" ] || [ ! -d "$pl_core_dir/core" ]; }; then
      if [ -f "$sr_main/.agents/.proofline-manifest" ]; then
        echo "proofline: $pl_core_dir/proofline-core.mjs or $pl_core_dir/core/ is missing: the command $1 runs in Node 22.13 or newer and needs both (run: proofline upgrade)" >&2; exit 127
      fi
      pl_sh=yes
    fi
    [ "$pl_sh" = yes ] || exec node "$pl_core_dir/proofline-core.mjs" --pl-argv0 "$0" "$@" ;;
esac
ctp_base=''   # set by cleanup of a delivered run and by delivered_mode (a run under its own delivery commit): task paths are then measured from base_sha, not HEAD

# A188: the digest is the first word of the tool's line (no awk process)
if command -v shasum >/dev/null 2>&1; then sha256() { sh_o=$(shasum -a 256) || :; [ -z "$sh_o" ] || printf '%s\n' "${sh_o%% *}"; }
else sha256() { sh_o=$(sha256sum) || :; [ -z "$sh_o" ] || printf '%s\n' "${sh_o%% *}"; }; fi
hash_file() { sha256 < "$1"; }
# seq3 FILE [raw]: the first three characters of the file's name (its sequence number), leading zeros removed unless `raw` (A188: replaces
# basename | cut -c1-3 | sed 's/^0*//', three processes per approval or request file).
seq3() { s3_b=${1##*/}; case $s3_b in ???*) s3_b=${s3_b%"${s3_b#???}"} ;; esac; [ "${2:-}" = raw ] || s3_b=${s3_b#"${s3_b%%[!0]*}"}; printf '%s\n' "$s3_b"; }
fail() { echo "$*" >&2; return 1; }
now_epoch() { date +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- Roles (D9/D11). Source role names stay accepted as aliases. ----------------
canon_role() {
  case "$1" in
    full_lifecycle) echo lead ;; implementation_worker) echo implementer ;; independent_reviewer) echo reviewer ;;
    independent_qa) echo qa ;; independent_verifier) echo verifier ;; *) printf '%s\n' "$1" ;;
  esac
}
valid_role() { case "$1" in lead|task_author|explorer|architect|data_architect|designer|qa|implementer|reviewer|security_reviewer|verifier) return 0 ;; *) return 1 ;; esac; }
execution_role=$(canon_role "${AGENT_ROLE:-lead}")
require_lead() { [ "$execution_role" = lead ] || fail "command denied for $execution_role (lead only)"; }

valid_task_id() { case "$1" in *[!A-Za-z0-9_-]*|'') return 1;; esac; }
run_dir() { printf '%s/.agents/runs/%s\n' "$root" "$1"; }

# A command holds its lock through the complete read/modify/write transaction. The
# local lock also protects shared ACTIVE_RUN, approval consumption and metrics.
held_locks=''
record_tmp=''
release_locks() {
  [ -z "$record_tmp" ] || rm -rf "$record_tmp"
  for rl_path in $held_locks; do
    if [ -f "$rl_path/pid" ] && [ "$(cat "$rl_path/pid")" = "$$" ]; then
      rm -f "$rl_path/pid"
      rmdir "$rl_path" 2>/dev/null || :
    fi
  done
}
# take_old_lock PATH (A199): the lock older versions took. Taken when the folder is writable; otherwise (a sandbox) only a live holder is waited for.
take_old_lock() {
  [ ! -f "$1/pid" ] || [ "$(cat "$1/pid" 2>/dev/null || :)" != "$PPID" ] || return 0   # 4B: the parent's own lock
  to_t=$(( ${PROOFLINE_LOCK_TIMEOUT:-120} * 5 )); to_n=0
  while [ "$to_n" -lt "$to_t" ]; do
    if mkdir "$1" 2>/dev/null; then rmdir "$1" 2>/dev/null || :; acquire_lock "$1"; return $?; fi
    [ -d "$1" ] || return 0   # not there and not creatable: the folder is read-only here
    wo_p=$(cat "$1/pid" 2>/dev/null || :)
    case "$wo_p" in ''|*[!0-9]*) acquire_lock "$1"; return $? ;; esac
    kill -0 "$wo_p" 2>/dev/null || { acquire_lock "$1"; return $?; }
    sleep 0.2; to_n=$((to_n + 1))
  done
  acquire_lock "$1"
}
acquire_lock() {
  al_path=$1
  case " $held_locks " in *" $al_path "*) return 0 ;; esac
  # 4B: a lock whose pid file names this process's parent is the parent's own transaction (a lock-holding command started this one as a child); it is neither waited for nor released here
  [ ! -f "$al_path/pid" ] || [ "$(cat "$al_path/pid" 2>/dev/null || :)" != "$PPID" ] || return 0
  al_timeout=${PROOFLINE_LOCK_TIMEOUT:-$(tm_scaled 120 1 3600)}
  case "$al_timeout" in ''|*[!0-9]*) fail "invalid PROOFLINE_LOCK_TIMEOUT: $al_timeout"; return 1 ;; esac
  [ -w "${al_path%/*}" ] || { fail "cannot take the lock $al_path: its directory is not writable by this process (a sandbox must grant .agents/local and the run folder)"; return 1; }
  al_tries=$((al_timeout * 5)) al_n=0 al_broke=''
  while ! mkdir "$al_path" 2>/dev/null; do
    if [ -f "$al_path/pid" ]; then
      al_pid=$(cat "$al_path/pid" 2>/dev/null || :)
      case "$al_pid" in ''|*[!0-9]*) ;; *)
        if ! kill -0 "$al_pid" 2>/dev/null; then
          # Take the pid file by rename and check whose it was: a holder that took the lock after our read
          # is put back untouched, never stripped of its pid. mkdir is still the arbiter among waiters.
          if mv "$al_path/pid" "$al_path/pid.brk.$$" 2>/dev/null; then
            if [ "$(cat "$al_path/pid.brk.$$" 2>/dev/null)" = "$al_pid" ]; then
              rm -f "$al_path/pid.brk.$$"
              rmdir "$al_path" 2>/dev/null || :
              al_broke=$al_pid
              continue
            fi
            mv "$al_path/pid.brk.$$" "$al_path/pid" 2>/dev/null || :
          fi
        fi ;;
      esac
    fi
    [ "$al_n" -lt "$al_tries" ] || { fail "lock timeout after ${al_timeout}s: $al_path"; return 1; }
    sleep 0.2
    al_n=$((al_n + 1))
  done
  printf '%s\n' "$$" > "$al_path/pid"
  held_locks="$al_path $held_locks"
  case "$al_path" in "$agents"/runs/*/.lock)
    if [ -n "$al_broke" ]; then
      al_id=${al_path%/.lock}; al_id=${al_id##*/}
      if gates_enforced "$al_id"; then ledger_append "$al_id" lock-break - - "stale lock holder pid=$al_broke"; fi
    fi ;;
  esac
}

# --- Config (.agents/config.yaml): indented YAML of scalars, read with awk. ---------
# One exception (A173): commands.build|test|lint may be a block list, one command per `- ` line under the key. The item lines
# become `key.0=...`, `key.1=...` (the key itself stays empty); config_items / cfg_cmds read them back.
# bin/lib/config.sh (cfg_lines) keeps the same awk for the CLI; tests/shared/check-shared.sh compares the two programs.
# Prints "dotted.key=value" for every key; comments and surrounding quotes are stripped.
config_lines() {
  awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      ind = match($0, /[^ ]/) - 1; lvl = int(ind / 2)
      body = substr($0, ind + 1)
      if (body ~ /^-([[:space:]]|$)/) {
        if (lastfull == "" || ind < lastind) next
        it = body; sub(/^-[[:space:]]*/, "", it); sub(/[[:space:]]+#.*$/, "", it); it = trim(it)
        if (it ~ /^".*"$/ || it ~ /^\047.*\047$/) it = substr(it, 2, length(it) - 2)
        print lastfull "." (cnt[lastfull]++) "=" it
        next
      }
      if ($0 !~ /:/) next
      k = body; sub(/:.*/, "", k)
      v = body; sub(/^[^:]*:/, "", v); sub(/[[:space:]]+#.*$/, "", v); v = trim(v)
      if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2)
      path[lvl] = k; full = path[0]; for (i = 1; i <= lvl; i++) full = full "." path[i]
      lastfull = full; lastind = ind
      print full "=" v
    }' "${1:-$config}"
}
# config_items <dotted.key>: reads config_lines on stdin; prints the items of a block list, one per line, in order.
config_items() { awk -v k="$1" 'index($0, k ".") == 1 { r = substr($0, length(k) + 2); n = index(r, "="); if (n > 1 && substr(r, 1, n - 1) ~ /^[0-9]+$/) print substr(r, n + 1) }'; }
# config_get <dotted.key> [file]: the value (the items one per line for a block list); exit 1 when the key is absent.
config_get() {
  config_lines "${2:-$config}" | awk -v k="$1" '
    index($0, k "=") == 1 && !f { v = substr($0, length(k) + 2); f = 1 }
    index($0, k ".") == 1 { r = substr($0, length(k) + 2); n = index(r, "="); if (n > 1 && substr(r, 1, n - 1) ~ /^[0-9]+$/) it[++c] = substr(r, n + 1) }
    END { if (!f && !c) exit 1; if (v == "" && c) { for (i = 1; i <= c; i++) print it[i]; exit 0 } print v }'
}
# cfg <dotted.key> [default]: the value, or the default when absent or empty.
# The config is parsed once per process; cfg looks keys up without spawning processes.
cfg_cache=''
if [ -f "$config" ]; then cfg_cache="
$(config_lines)
"; fi
cfg() {
  case "$cfg_cache" in *"
$1="*) cfg_v=${cfg_cache#*"
$1="}; cfg_v=${cfg_v%%"
"*} ;; *) cfg_v='' ;; esac
  [ -n "$cfg_v" ] || cfg_v=${2:-}; printf '%s\n' "$cfg_v"
}
# cfg_cmds <commands.build|test|lint|...>: the one helper for a configured command (A173). One command per line: the scalar, or
# every item of the block list; nothing when the key is empty or absent. Every consumer of commands.* uses this, never cfg.
cfg_cmds() {
  cfg_cv=$(cfg "$1" '')
  if [ -n "$cfg_cv" ]; then printf '%s\n' "$cfg_cv"; else printf '%s\n' "$cfg_cache" | config_items "$1"; fi
}

# --- Timeouts (A202 item 29): one multiplier for every duration ------------------------------------------------------------
# tm_scale: timeouts.scale (0.5 to 10, default 1); a missing, non-numeric or out-of-range value is 1, so no value can switch a timeout off or
# stretch it past the bound. tm_scaled N [MIN [MAX]]: N seconds times the scale, rounded up, kept between MIN (default 1) and MAX (default 28800).
# The approval fast-path budget (hook.approve_budget_seconds) is never passed through here: hook_knob keeps its own tight bound (trap z).
# dec0 N: N without leading zeros (08 is the number 8; a shell reads it as an octal error inside $(( ))). Every config number that feeds arithmetic passes here.
dec0() { d0_v=$1; while :; do case "$d0_v" in 0?*) d0_v=${d0_v#0} ;; *) break ;; esac; done; printf '%s\n' "$d0_v"; }
tm_milli=''   # timeouts.scale times 1000, read once per process (no process is started to scale a number: locks call tm_scaled)
tm_scale_milli() {
  [ -z "$tm_milli" ] || { printf '%s\n' "$tm_milli"; return 0; }
  tm_v=$(cfg timeouts.scale 1); tm_ip=${tm_v%%.*}; tm_fp=0
  case "$tm_v" in *.*) tm_fp=${tm_v#*.} ;; esac
  case "$tm_ip$tm_fp" in ''|*[!0-9]*) tm_milli=1000; printf '1000\n'; return 0 ;; esac
  [ -n "$tm_ip" ] || tm_ip=0; [ -n "$tm_fp" ] || tm_fp=0
  tm_fp="${tm_fp}000"; tm_fp=${tm_fp%"${tm_fp#???}"}
  while :; do case "$tm_ip" in 0?*) tm_ip=${tm_ip#0} ;; *) break ;; esac; done   # no octal reading of 010
  while :; do case "$tm_fp" in 0?*) tm_fp=${tm_fp#0} ;; *) break ;; esac; done
  tm_milli=$((tm_ip * 1000 + tm_fp))
  { [ "$tm_milli" -ge 500 ] && [ "$tm_milli" -le 10000 ]; } || tm_milli=1000
  printf '%s\n' "$tm_milli"
}
tm_scale() { tm_m=$(tm_scale_milli); awk -v m="$tm_m" 'BEGIN { print m / 1000 }'; }
tm_scaled() {
  ts_m=$(tm_scale_milli); ts_n=$(dec0 "$1"); ts_x=$(((ts_n * ts_m + 999) / 1000)); ts_lo=${2:-1}; ts_hi=${3:-28800}
  [ "$ts_x" -ge "$ts_lo" ] || ts_x=$ts_lo; [ "$ts_x" -le "$ts_hi" ] || ts_x=$ts_hi; printf '%s\n' "$ts_x"
}
# tm_warn_percent: how much of a step's time may pass before the lead is told (timeouts.warn_percent, 50 to 95, default 80)
tm_warn_percent() { tw_v=$(dec0 "$(cfg timeouts.warn_percent 80)"); case "$tw_v" in ''|*[!0-9]*) tw_v=80 ;; esac; [ "$tw_v" -ge 50 ] || tw_v=50; [ "$tw_v" -le 95 ] || tw_v=95; printf '%s\n' "$tw_v"; }
# verify_command_timeout: the limit of one build, test or install command of the build record and of one re-run of reproduced evidence (60 to 28800 before scaling)
verify_command_timeout() {
  vt_v=$(dec0 "$(cfg verification.command_timeout_seconds 1800)"); case "$vt_v" in ''|*[!0-9]*) vt_v=1800 ;; esac
  [ "$vt_v" -ge 60 ] || vt_v=60; [ "$vt_v" -le 28800 ] || vt_v=28800; tm_scaled "$vt_v" 60 28800
}
# hook_timeouts: the runtime's own time limit per hook event, one `event=seconds` line each (config hook.<event>_timeout_seconds, 10 to 600, times
# timeouts.scale), as init and upgrade write them into .claude/settings.json. hook.approve_budget_seconds is not scaled here or anywhere (trap z):
# a longer hook limit lets the runtime wait longer for the hook, it does not slow the approval step, which stops at its own budget. The prompt
# limit is kept at least that budget + 5, so the hook can always say that an approval was not recorded.
hook_timeouts() {
  ht_ab=$(hook_knob approve_budget_seconds 20 5 25)
  for ht_e in session:session:30 prompt:prompt:30 pretool:pretool:30 posttool:posttool:30 subagent-start:subagent_start:60 subagent-stop:subagent_stop:120 stop:stop:30; do
    ht_k=${ht_e#*:}; ht_d=${ht_k#*:}; ht_k=${ht_k%%:*}; ht_n=${ht_e%%:*}
    ht_v=$(dec0 "$(cfg "hook.${ht_k}_timeout_seconds" "$ht_d")"); case "$ht_v" in ''|*[!0-9]*) ht_v=$ht_d ;; esac
    [ "$ht_v" -ge 10 ] || ht_v=10; [ "$ht_v" -le 600 ] || ht_v=600
    ht_v=$(tm_scaled "$ht_v" 10 600)
    if [ "$ht_n" = prompt ] && [ "$ht_v" -lt $((ht_ab + 5)) ]; then ht_v=$((ht_ab + 5)); fi
    printf '%s=%s\n' "$ht_n" "$ht_v"
  done
}
# timeouts_info: every duration this install uses, as `name=seconds`, scaled and bounded as the code uses it (docs/concepts/timeouts.md)
timeouts_info() {
  printf 'scale=%s\nwarn_percent=%s\n' "$(tm_scale)" "$(tm_warn_percent)"
  printf 'dispatch.default=%s\n' "$(tm_dispatch_seconds '')"
  for ti_c in TRIVIAL STANDARD COMPLEX CRITICAL; do printf 'dispatch.%s=%s\n' "$ti_c" "$(tm_dispatch_seconds "$ti_c")"; done
  printf 'verification.command=%s\nlock=%s\nstatus_block=%s\n' "$(verify_command_timeout)" "$(tm_scaled 120 1 3600)" "$(tm_scaled "$(cfg tasks.status_block_seconds 20)" 1 900)"
  printf 'batch.ci_wait_minutes=%s\nbatch.ci_appear_minutes=%s\n' "$(batch_minutes batch.ci_wait_minutes 30)" "$(batch_minutes batch.ci_appear_minutes 10)"
  printf 'hook.approve_budget=%s (never scaled)\nhook.next_budget=%s\nhook.lock_wait=%s\n' "$(hook_knob approve_budget_seconds 20 5 25)" "$(hook_knob next_budget_seconds 10 2 20)" "$(hook_knob lock_wait_seconds 8 1 20)"
  hook_timeouts | sed 's/^/hook.timeout./'
}
batch_minutes() { # KEY DEFAULT: the CI wait in minutes, times the scale
  bm_v=$(cfg "$1" "$2"); case "$bm_v" in ''|*[!0-9]*) bm_v=$2 ;; esac; tm_scaled "$bm_v" 1 720
}
# scale_check (A202 item 29): 0 when the user's own message approved the proposed timeouts.scale (kind `scale`, bound to the sha256 of the proposal
# that `proofline doctor --scale` wrote after measuring this machine); an agent cannot write or answer for it.
scale_check() {
  sc_f=$(shared_dir scale)/PROPOSAL.tsv; [ -s "$sc_f" ] || fail "no scale proposal (proofline doctor --scale)"
  find_approval - scale "$(hash_file "$sc_f")" >/dev/null || fail "the user's newest message does not approve the scale: no unconsumed scale approval is bound to this proposal (ask: agent.sh request-approval - scale, relay it; the reply \"approve scale\" records the approval)"
  echo "scale $(hash_file "$sc_f" | cut -c1-12): approved by the user"
}
# tm_dispatch_seconds [CLASS]: the timeout of one dispatched step: the class value, else dispatch.timeout_seconds, times the scale (30 to 28800)
tm_dispatch_seconds() {
  td_t=$(cfg dispatch.timeout_seconds 5400); case "$td_t" in ''|*[!0-9]*) td_t=5400 ;; esac
  case "${1:-}" in TRIVIAL|STANDARD|COMPLEX|CRITICAL) td_c=$(cfg "pipelines.$1.dispatch_timeout_seconds" ''); case "$td_c" in ''|*[!0-9]*) ;; *) td_t=$td_c ;; esac ;; esac
  tm_scaled "$td_t" 30 28800
}

# --- Ecosystem facts (A173): .agents/ecosystems.tsv (generated from ecosystems.json) is the one source of what each language
# calls a manifest, lock, package-source setting or build-changing file. config.yaml keeps the project's own globs; these two
# sets are added to them at read time, so a new ecosystem or file kind reaches every project on upgrade without editing its
# config (a user edit of config.yaml is never touched). Empty when the definition is missing: the config alone then decides.
#   eco_risky_set       review.risky_paths += every risky glob (a change to these is never tier small)
#   eco_dependency_set  the signal whose check is `dependencies` += manifests, locks and package-source settings
eco_risky_set='' eco_dependency_set='' eco_loaded=0
eco_sh=$scripts/ecosystems.sh eco_tsv=$agents/ecosystems.tsv
# A188: the runtime hook asks these read-only questions on most tool calls; none of them reads the ecosystem sets, so the
# definition (two processes to read) is not loaded for them.
eco_lazy=no; case "${1:-}" in config-get|db-config|hook-config|worktree-root|in-knowledge-scope) eco_lazy=yes ;; esac
if [ "$eco_lazy" = no ] && { [ ! -s "$eco_tsv" ] || [ ! -f "$eco_sh" ]; }; then
  # The project's copy is missing. When this script runs from another folder than the project's .agents/ (the repository layout:
  # control-plane/agents/scripts), the definition shipped beside it is used, so risk never shrinks silently. In an installed project
  # the shipped copy IS the project's copy (same folder), so nothing is substituted and the warning and `doctor` apply.
  eco_ship=$(CDPATH='' cd "$self_dir/.." 2>/dev/null && pwd) || eco_ship=''
  if [ -n "$eco_ship" ] && [ "$eco_ship" != "$agents" ] && [ -s "$eco_ship/ecosystems.tsv" ] && [ -f "$eco_ship/scripts/ecosystems.sh" ]; then
    eco_sh=$eco_ship/scripts/ecosystems.sh eco_tsv=$eco_ship/ecosystems.tsv
  fi
fi
if [ "$eco_lazy" = no ] && [ -f "$eco_sh" ] && [ -s "$eco_tsv" ]; then
  # shellcheck source=/dev/null # ecosystems.sh next to this script
  . "$eco_sh"
  if eco_init "$eco_tsv"; then
    eco_loaded=1
    eco_both=$(eco_sets)
    eco_risky_set=${eco_both%%"
"*} eco_dependency_set=${eco_both#*"
"}
  fi
fi

# One visible line when the definition is not readable: risk is then judged by config.yaml alone, which no longer lists the language files (A174).
# Old runs are not failed over it (freeze and verify-freeze stay as they were); `proofline doctor` fails.
eco_warning() { [ "$eco_loaded" = 1 ] || printf 'warning: .agents/ecosystems.tsv is missing or empty, so the risky-path and dependency sets are empty and only the config.yaml globs apply: run proofline upgrade (proofline doctor shows it)\n'; }

config_check() {
  cc_file=${1:-$config}; [ -f "$cc_file" ] || fail "config missing: $cc_file"
  cc_out=$(config_lines "$cc_file" | awk -F= '
    function bad(m) { print m; n++ }
    function en(k, v, set,   n, a, i) { if (v == "") return; n = split(set, a, "|"); for (i = 1; i <= n; i++) if (v == a[i]) return; bad("invalid value for " k ": " v " (want " set ")") }
    function num(k, v) { if (v != "" && v !~ /^[0-9]+$/) bad("invalid number for " k ": " v) }
    {
      k = $1; v = substr($0, length(k) + 2); split(k, p, "."); top = p[1]
      if (top !~ /^(proofline_version|canonical_branch|default_topology|profile|runtime|failover|autonomy|review|git|approval|commands|tasks|design_docs|local_state|worktree|archive|verification|metrics|test_trust|writing|product|performance|budgets|capabilities|dispatch|default_mode|active_run_file|policy_source|knowledge_scope_root|safety|pipelines|execution_policy|database|hook|fingerprint|risk|security|contract|batch|validation|visual|rules|timeouts)$/) { bad("unknown top-level key: " top); next }
      if (top == "risk" && p[3] != "") {
        if (p[2] !~ /^[a-z_]+$/) bad("invalid risk signal name: " p[2])
        else if (p[3] == "check") en(k, v, "contract|concurrency|performance|config|migration|visual|dependencies|logging")
        else if (p[3] == "flag") en(k, v, "contract_change|concurrency|performance_critical|data_change|destructive|ui")
        else if (p[3] == "design_role") en(k, v, "architect|data_architect|designer")
        else if (p[3] != "paths" && p[3] != "content" && p[3] != "words") bad("unknown risk key: " k)
        if ((p[3] == "paths" || p[3] == "content" || p[3] == "words") && v != "") sig[p[2]] = 1
        if (p[3] == "words") wk[p[2]] = 1
        if (p[3] == "words" && v != "") wrd[p[2]] = 1
        if (p[3] == "content" && v != "") cnt[p[2]] = 1
        if (p[3] == "check" && v != "") chk[p[2]] = 1
      }
      if (k == "risk.unsupported") en(k, v, "block|report")
      if (top == "validation" && k != "validation" && k !~ /^validation\.(entry_words|entry_candidates|entry_input|entry_new|entry_output|entry_skip|code_patterns)$/) bad("unknown validation key: " k " (want validation.entry_words, entry_candidates, entry_input, entry_new, entry_output, entry_skip or code_patterns)")
      if (top == "rules" && k != "rules") { if (k !~ /^rules\.(budget_bytes|unused_after_reviews)$/) bad("unknown rules key: " k " (want rules.budget_bytes or rules.unused_after_reviews)"); else num(k, v) }
      if (top == "visual" && k != "visual") { if (k !~ /^visual\.(ascii_turkish_words|ascii_turkish_allow)$/) bad("unknown visual key: " k " (want visual.ascii_turkish_words or visual.ascii_turkish_allow)"); else if (v !~ /^[A-Za-z]*([ ,]+[A-Za-z]+)*[ ,]*$/) bad(k " must be ASCII words separated by spaces: " v) }
      if (top == "contract" && k != "contract" && k !~ /^contract\.(paths|ignore)$/) bad("unknown contract key: " k " (want contract.paths or contract.ignore)")
      if (top == "commands" && p[2] != "") {
        # A173: commands.build|test|lint is one command, or a block list of commands (`- ` lines under the key)
        if (p[3] != "") {
          if (p[2] !~ /^(build|test|lint)$/) bad("commands." p[2] " takes one command, not a list: " k)
          else if (p[3] !~ /^[0-9]+$/ || p[4] != "") bad("commands." p[2] " is a command or a list of commands (- command), not a map: " k)
          else if (v == "") bad("empty command in the commands." p[2] " list (item " (p[3] + 1) ")")
          else if ((p[2] SUBSEP v) in cmdseen) bad("duplicate command in the commands." p[2] " list: " v)
          else { cmdseen[p[2], v] = 1; hasl[p[2]] = 1 }
        } else if (p[2] ~ /^(build|test|lint)$/ && v ~ /^\[[^ ].*\]$/) bad(k " is an inline list; write a block list (one `- command` line per command): " v)
        if (p[3] == "" && v != "") hasv[p[2]] = 1
      }
      if (k == "default_topology") en(k, v, "standalone|orchestrated")
      else if (k == "profile") en(k, v, "max|balanced|economy")
      else if (k ~ /^runtime\.(lead|worker|reviewers)$/ || k ~ /^runtime\.roles\./) en(k, v, "claude|codex")
      else if (k == "failover") en(k, v, "auto|ask|off")
      else if (k ~ /^autonomy\./) { if (p[2] !~ /^(TRIVIAL|STANDARD|COMPLEX|CRITICAL)$/) bad("unknown class under autonomy: " p[2]); en(k, v, "autonomous|supervised") }
      else if (k == "review.waiver_followup") en(k, v, "none|task")
      else if (k ~ /^review\.(max_fix_rounds|small_max_files|small_max_lines)$/ || k ~ /^(test_trust|budgets|performance)\./) num(k, v)
      else if (k == "git.commit_format") en(k, v, "conventional|plain")
      else if (k == "git.push_requires_approval") en(k, v, "true|false")
      else if (k == "git.platform") en(k, v, "github|gitlab|azure|bitbucket|other")
      else if (k == "git.platform_host") { if (v != "" && v !~ /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/) bad("git.platform_host is a bare host name such as gitlab.company.com (no scheme, port, path or spaces): " v) }
      else if (k == "tasks.adapter") en(k, v, "markdown|github|jira|linear")
      else if (top == "design_docs" && p[2] == "design" && p[3] != "") {
        # design_docs.design is a path, or a mapping: shared (a document) and surfaces.<name>.doc|paths|mode
        if (p[3] == "shared" && p[4] == "") { if (v ~ /^\// || v ~ /(^|\/)\.\.(\/|$)/) bad(k " must be project-relative: " v) }
        else if (p[3] == "surfaces" && p[4] == "") hs = 1
        else if (p[3] == "surfaces" && p[5] == "") { if (p[4] !~ /^[A-Za-z0-9_-]+$/) bad("invalid surface name: " p[4] " (letters, digits, - and _)"); sn[p[4]] = 1 }
        else if (p[3] == "surfaces" && p[6] == "" && (p[5] == "doc" || p[5] == "paths" || p[5] == "mode")) {
          sn[p[4]] = 1
          if (p[5] == "doc") { if (v ~ /^\// || v ~ /(^|\/)\.\.(\/|$)/) bad(k " must be project-relative: " v); if (v != "") sd[p[4]] = 1 }
          else if (p[5] == "paths") { ne = split(v, pe, " "); for (ei = 1; ei <= ne; ei++) { pt = pe[ei]; if (gsub(/\*\*\//, "", pt) > 1) bad(k " allows one **/ per glob: " pe[ei]) } if (v ~ /[\\|]/) bad(k " may not contain \\ or |: " v); if (v ~ /^\// || v ~ /(^|[ \/])\.\.(\/|[ ]|$)/) bad(k " must be project-relative globs: " v); if (v != "") sp[p[4]] = 1 }
          else if (v != "" && v !~ /^[a-z][a-z-]*$/) bad(k " is a visitor mode in lower case, for example persuade or operate: " v)
        } else bad("unknown design_docs.design key: " k " (want shared or surfaces.<name>.doc|paths|mode)")
      }
      else if (k == "local_state" || k == "metrics") en(k, v, "on|off")
      else if (k == "writing.profile") en(k, v, "auto|ste|plain")
      else if (k == "writing.strictness") en(k, v, "relaxed|strict")
      else if (top == "writing" && k != "writing") bad("unknown writing key: " k " (want writing.profile or writing.strictness)")
      else if (k == "product.dir") { if (v ~ /^\// || v ~ /(^|\/)\.\.(\/|$)/) bad("product.dir must be project-relative: " v) }
      else if (k == "product.stale_days") { if (v != "" && v !~ /^[1-9][0-9]*$/) bad("product.stale_days must be a positive integer: " v) }
      else if (top == "product" && k != "product" && k != "product.vague_words") bad("unknown product key: " k " (want product.dir, product.vague_words or product.stale_days)")
      else if (k ~ /^pipelines\.[A-Z]+\.(evidence|qa|architect)$/) en(k, v, "yes|no")
      else if (k ~ /^pipelines\.[A-Z]+\.review$/) en(k, v, "yes|no|optional")
      else if (k ~ /^pipelines\.[A-Z]+\.(max_explorers|max_scope_paths)$/) num(k, v)
      else if (k ~ /^pipelines\.[A-Z]+\.dispatch_timeout_seconds$/) { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 30 || v + 0 > 28800)) bad(k " must be 30 to 28800") }
      else if (k ~ /^capabilities\.[^.]+\.[^.]+$/) en(k, v, "1|2|3")
      else if (k == "execution_policy.max_context_bytes" || k == "execution_policy.revision") num(k, v)
      else if (k == "worktree.copy_files") { if (v ~ /(^| )\// || v ~ /(^|[ \/])\.\.([ \/]|$)/ || v ~ /[|\\]/) bad("worktree.copy_files must be project-relative globs without a leading / or .. : " v) }
      else if (top == "worktree" && k != "worktree") bad("unknown worktree key: " k " (want worktree.copy_files)")
      else if (k == "archive.keep") num(k, v)
      else if (top == "archive" && k != "archive") bad("unknown archive key: " k " (want archive.keep)")
      else if (k == "verification.env_files") { if (v ~ /(^| )\// || v ~ /(^|[ \/])\.\.([ \/]|$)/ || v ~ /[*?|\\]/ || v ~ /\[|\]/) bad("verification.env_files must be project-relative file names (space-separated, no glob, no leading / or .. ): " v) }
      else if (k == "verification.doc_paths") { if (v ~ /(^| )\// || v ~ /(^|[ \/])\.\.([ \/]|$)/ || v ~ /[?|\\]/ || v ~ /\[|\]/) bad("verification.doc_paths must be project-relative entries: a directory prefix ending in /, an exact path or *.ext") }
      else if (top == "verification" && k != "verification" && k != "verification.command_timeout_seconds") bad("unknown verification key: " k " (want verification.env_files or verification.doc_paths)")
      else if (k == "batch.mutation_budget_cap") num(k, v)
      else if (k == "batch.ci_wait_minutes") { num(k, v); if (v ~ /^[0-9]+$/ && v + 0 < 1) bad(k " must be at least 1"); else if (v ~ /^[0-9]+$/ && v + 0 > 720) bad(k " must be at most 720") }
      else if (k == "batch.ci_appear_minutes") { num(k, v); if (v ~ /^[0-9]+$/ && v + 0 < 1) bad(k " must be at least 1"); else if (v ~ /^[0-9]+$/ && v + 0 > 240) bad(k " must be at most 240") }
      else if (k == "batch.task_timeout" || k == "batch.runtimes") { }   # belonged to the removed headless driver (0.0.32): accepted for old configs, not validated, ignored
      else if (top == "batch" && k != "batch") bad("unknown batch key: " k)
      else if (k == "dispatch.claude_permission_mode") en(k, v, "bypassPermissions|acceptEdits|default")
      else if (k == "dispatch.network_retries") { num(k, v); if (v ~ /^[0-9]+$/ && v + 0 > 6) bad("dispatch.network_retries is at most 6") }
      else if (k == "hook.approve_budget_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 5 || v + 0 > 25)) bad(k " must be 5 to 25 (the runtime stops a hook at 30 s)") }
      else if (k == "hook.next_budget_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 2 || v + 0 > 20)) bad(k " must be 2 to 20") }
      else if (k == "hook.lock_wait_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 1 || v + 0 > 20)) bad(k " must be 1 to 20") }
      else if (top == "hook" && k != "hook" && k !~ /^hook\.(session|prompt|pretool|posttool|subagent_start|subagent_stop|stop)_timeout_seconds$/) bad("unknown hook key: " k " (want hook.approve_budget_seconds, hook.next_budget_seconds, hook.lock_wait_seconds or hook.<event>_timeout_seconds)")
      else if (k == "timeouts.scale") { if (v != "" && (v !~ /^[0-9]+(\.[0-9]+)?$/ || v + 0 < 0.5 || v + 0 > 10)) bad("timeouts.scale must be a number from 0.5 to 10: " v) }
      else if (k == "timeouts.warn_percent") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 50 || v + 0 > 95)) bad(k " must be 50 to 95") }
      else if (top == "timeouts" && k != "timeouts") bad("unknown timeouts key: " k " (want timeouts.scale or timeouts.warn_percent)")
      else if (k ~ /^hook\.(session|prompt|pretool|posttool|subagent_start|subagent_stop|stop)_timeout_seconds$/) { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 10 || v + 0 > 600)) bad(k " must be 10 to 600") }
      else if (k == "verification.command_timeout_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 60 || v + 0 > 28800)) bad(k " must be 60 to 28800") }
      else if (k == "tasks.status_block_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 1 || v + 0 > 300)) bad(k " must be 1 to 300") }
      else if (k == "fingerprint.cache_min_bytes") { num(k, v); if (v ~ /^[0-9]+$/ && v + 0 < 65536) bad(k " must be at least 65536") }
      else if (top == "fingerprint" && k != "fingerprint") bad("unknown fingerprint key: " k)
      else if (k == "dispatch.network_backoff_seconds") num(k, v)
      else if (k == "dispatch.timeout_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && (v + 0 < 30 || v + 0 > 28800)) bad("dispatch.timeout_seconds must be 30 to 28800") }
      seen[k] = 1; gv[k] = v
    }
    END {
      for (s in hasl) if (hasv[s]) bad("commands." s " has both a value and a list of commands; keep one")
      ha = (gv["hook.approve_budget_seconds"] ~ /^[0-9]+$/) ? gv["hook.approve_budget_seconds"] + 0 : 20; hp = (gv["hook.prompt_timeout_seconds"] ~ /^[0-9]+$/) ? gv["hook.prompt_timeout_seconds"] + 0 : 30
      if (hp < ha + 5) bad("hook.prompt_timeout_seconds (" hp ") must be at least hook.approve_budget_seconds + 5 (" ha + 5 ")")
      if (!seen["canonical_branch"]) bad("missing key: canonical_branch")
      if (!seen["git.branch_prefix"]) bad("missing key: git.branch_prefix")
      if (seen["git.platform_host"] && gv["git.platform_host"] != "" && gv["git.platform"] == "") bad("git.platform_host needs git.platform (the platform that host runs)")
      for (s in sn) { if (!sd[s]) bad("design surface " s " has no doc (design_docs.design.surfaces." s ".doc)"); if (!sp[s]) bad("design surface " s " has no paths (design_docs.design.surfaces." s ".paths)") }
      for (s in sn) nsn++
      if (hs && !nsn) bad("design_docs.design.surfaces names no surface")
      if (seen["design_docs.design.shared"] && !hs) bad("design_docs.design.shared needs design_docs.design.surfaces")
      for (s in sig) if (!chk[s]) bad("risk signal " s " has patterns but no check")
      for (s in wrd) if (!cnt[s]) bad("risk signal " s " has words but no content (the pattern the line must match as well)")
      for (s in wk) if (!wrd[s]) bad("risk." s ".words is empty (a signal with words matches a line that names one of them; remove the content as well to switch the signal off)")
      if (cnt["log_sensitive"] && !wk["log_sensitive"]) bad("risk.log_sensitive.words is missing (without words every file that has a log call would open the logging focus)")
      exit n > 0
    }') && cc_out=$(for cc_k in validation.entry_words validation.entry_candidates validation.entry_input validation.entry_new validation.entry_output validation.entry_skip validation.code_patterns; do
      cc_v=$(config_get "$cc_k" "$cc_file" || true); [ -n "$cc_v" ] || continue
      cc_rc=0; printf '' | grep -Eq -- "$cc_v" 2>/dev/null || cc_rc=$?
      [ "$cc_rc" -lt 2 ] || echo "invalid regular expression for $cc_k"
    done
    # A162: risk.log_sensitive.content is matched by awk (risk_words_match), so awk is the one that must accept it
    cc_v=$(config_get risk.log_sensitive.content "$cc_file" || true)
    [ -z "$cc_v" ] || RISK_RE=$cc_v awk 'BEGIN { "" ~ ENVIRON["RISK_RE"] }' >/dev/null 2>&1 || echo "invalid regular expression for risk.log_sensitive.content") && [ -z "$cc_out" ] && { echo "config valid: ${cc_file#"$root"/}"; { [ "$cc_file" != "$config" ] || [ ! -f "$scripts/platform.sh" ] || sh "$scripts/platform.sh" warn -C "$root" 2>/dev/null; } >&2 || :; return 0; }
  printf '%s\n' "$cc_out" >&2; fail "config invalid: ${cc_file#"$root"/}"
}

# --- Active run selector (local state; absent or empty = no active task). --------
active_run_file() { printf '%s/%s\n' "$root" "$(cfg active_run_file .agents/local/ACTIVE_RUN)"; }
active_run() {
  marker=$(active_run_file)
  [ -f "$marker" ] || return 0
  count=$(sed '/^[[:space:]]*$/d' "$marker" | wc -l | tr -d ' ')
  [ "$count" = 0 ] && return 0
  [ "$count" = 1 ] || fail "ACTIVE_RUN must contain at most one task id"
  task=$(sed '/^[[:space:]]*$/d' "$marker")
  valid_task_id "$task" || fail "invalid active task id"
  [ -d "$(run_dir "$task")" ] || fail "active run not found: $task"
  printf '%s\n' "$task"
}
# Every run that is not terminated (FAILED/BLOCKED) and not cleaned up, as "<ID> <task branch|->". The
# commit and push hooks use it instead of ACTIVE_RUN, so emptying the selector never opens commits. Fails
# closed: a run directory without a RUN.yaml is listed without a branch.
open_runs() {
  for or_d in "$root"/.agents/runs/*; do
    [ -d "$or_d" ] || continue
    or_id=${or_d##*/}
    if [ ! -f "$or_d/RUN.yaml" ]; then printf '%s -\n' "$or_id"; continue; fi
    case "$(run_state "$or_d")" in FAILED|BLOCKED) continue ;; esac
    or_b=$(section_value "$or_d" repository task_branch); case "$or_b" in ''|PENDING) or_b=- ;; esac
    printf '%s %s\n' "$or_id" "$or_b"
  done
}
require_run() {
  valid_task_id "$1" || fail "invalid task id"; [ -d "$(run_dir "$1")" ] || fail "run not found: $1"
  [ ! -f "$(deliver_dir "$1")/SUMMARY.md" ] || delivered_mode "$1"   # A169: a run under its own delivery commit is judged from base_sha, like cleanup does
}


effective() {
  task=${1:-}; [ -n "$task" ] || task=$(active_run); [ -z "$task" ] || require_run "$task"
  run=''; [ -z "$task" ] || run=$(run_dir "$task")/RUN.yaml
  mode=''; [ -z "$run" ] || [ ! -f "$run" ] || mode=$(section_value "$(dirname "$run")" execution mode)
  case "$mode" in ''|PENDING) mode=$(cfg default_mode deterministic) ;; esac
  profile=$(run_profile "$task")
  policy=$agents/modes/$mode.yaml; [ -f "$policy" ] || fail "invalid mode: $mode"
  printf 'mode=%s\nprofile=%s\ntask=%s\nimplementation_allowed=%s\npolicy=%s\n' "$mode" "$profile" "${task:-none}" "$( [ -n "$task" ] && echo true || echo false )" "${policy#"$root"/}"
  awk '
    /^[a-z_]+:$/ { section=substr($0,1,length($0)-1); next }
    /^[[:space:]]+[a-z_]+:/ {
      line=$0; sub(/^[[:space:]]+/, "", line); key=line; sub(/:.*/, "", key)
      value=line; sub(/^[^:]*:[[:space:]]*/, "", value)
      if (value != "") print section "." key "=" value
    }
  ' "$policy"
}
run_profile() {
  rp=''; [ -z "${1:-}" ] || [ ! -f "$(run_dir "$1")/RUN.yaml" ] || rp=$(section_value "$(run_dir "$1")" execution profile)
  case "$rp" in max|balanced|economy) ;; *) rp=$(cfg profile balanced) ;; esac
  printf '%s\n' "$rp"
}

# --- RUN.yaml access -------------------------------------------------------------
run_state() { section_value "$1" execution state; }
require_open_run() { case "$(run_state "$(run_dir "$1")")" in FAILED|BLOCKED) fail "run $1 is $(run_state "$(run_dir "$1")") (terminal); it accepts no further lifecycle commands" ;; esac; }
baseline_status() { section_value "$1" baseline status; }
repository_base_sha() { section_value "$1" repository base_sha; }
# RUN.yaml reads are memoized per process (sv_dir, sv_cache); every writer calls sv_reset.
sv_dir='' sv_cache=''
sv_reset() { sv_dir=''; }
sv_load() {
  [ "$sv_dir" != "$1" ] || return 0
  sv_cache="
$(awk '/^[a-z_]+:[[:space:]]*$/ { s=$1; sub(/:.*/, "", s); next } /^[^[:space:]#]/ { s=""; next }
    s != "" && /^  [a-z_0-9]+:/ { k=$0; sub(/^  /, "", k); sub(/:.*/, "", k); v=$0; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/[[:space:]]+#.*$/, "", v); gsub(/"/, "", v)
      if (!((s "." k) in seen)) { seen[s "." k] = 1; print s "." k "=" v } }' "$1/RUN.yaml" 2>/dev/null)
"
  sv_dir=$1
}
section_value() {
  sv_load "$1"
  case "$sv_cache" in *"
$2.$3="*) sv_v=${sv_cache#*"
$2.$3="}; printf '%s\n' "${sv_v%%"
"*}" ;; esac
}
section_key_present() { sv_load "$1"; case "$sv_cache" in *"
$2.$3="*) return 0 ;; esac; return 1; }
replace_section_value() {
  awk -v section="$2" -v key="$3" -v value="$4" '
    $0 == section ":" { inside=1; print; next }
    inside && /^[^[:space:]#]/ { inside=0 }
    inside && $0 ~ "^  " key ":" { print "  " key ": \"" value "\""; found=1; next }
    { print }
    END { if (!found) exit 1 }
  ' "$1/RUN.yaml" > "$5"
}
set_run_value() {
  g_d=$(run_dir "$1")
  replace_section_value "$g_d" "$2" "$3" "$4" "$g_d/RUN.yaml.tmp" || { rm -f "$g_d/RUN.yaml.tmp"; fail "RUN.yaml has no $2.$3 to set"; }
  mv "$g_d/RUN.yaml.tmp" "$g_d/RUN.yaml"; sv_reset
}

# Deterministic per-task branch isolation (see GIT.md).
enforce_task_branch() {
  id=$1; dir=$(run_dir "$id")
  section_key_present "$dir" repository task_branch || return 0
  expected=$(section_value "$dir" repository task_branch)
  case "$expected" in ''|PENDING) fail "task branch not established for $id; run 'agent.sh branch $id' first" ;; esac
  current=$(git -C "$root" branch --show-current) || true
  [ -n "$current" ] || fail "detached HEAD: expected task branch $expected for $id"
  [ "$current" = "$expected" ] || fail "wrong git branch for $id: expected $expected, currently on $current"
}

# --- Baseline and path fingerprints ------------------------------------------------
fingerprint_path() {
  path=$1 target=$root/$1
  if [ -L "$target" ]; then
    case "$path" in
      AGENTS.md|CLAUDE.md) fail "cannot baseline symlink: $path. A symlinked $path is a product change (project rules every agent reads): replace the symlink with a regular file holding only the proofline block, or name $path in the plan scope (amendment and refreeze)." ;;
    esac
    fail "cannot baseline symlink: $path"
  fi
  if [ -f "$target" ]; then
    # A202 item 28: a big file is hashed once and remembered for the READ-ONLY commands (fp_fast=yes: next, digest, summary, status-block, ...).
    # The key is path, size, mtime (ns), inode and ctime (ns); any difference is a rehash, and a platform whose stat lacks one of them hashes
    # every time. Every command that seals or checks evidence (gate record, handoff, freeze, verify-*, delivery, approval) runs with fp_fast=no:
    # it never reads the cache and refreshes it. The cache is a speed-up of display and hooks only, never an integrity input.
    if [ "$fp_fast" = yes ] || [ "$fp_fast" = refresh ]; then
      fpc_k=$(fp_cache_key "$target" "$path") || fpc_k=''
      if [ -n "$fpc_k" ]; then
        if [ "$fp_fast" = yes ]; then fpc_h=$(fp_cache_get "$fpc_k") || fpc_h=''; [ -z "$fpc_h" ] || { printf '%s\n' "$fpc_h"; return 0; }; fi
        fpc_h=$(hash_file "$target"); fp_cache_put "$fpc_k" "$fpc_h"; printf '%s\n' "$fpc_h"; return 0
      fi
    fi
    hash_file "$target"; return 0
  fi
  [ ! -e "$target" ] && { printf '%s\n' missing; return 0; }
  fail "cannot baseline non-regular file: $path"
}
# fp_fast: no (default: always hash), yes (read-only commands: use the cache), refresh (sealing commands: hash, then store). Set by the CLI below.
fp_fast=no
fp_cache_file() { printf '%s/fp-cache\n' "$sr_main/.agents/local"; }
# fp_cache_key FILE PATH: "path|size|mtime_ns|inode|ctime_ns" of a file of at least fingerprint.cache_min_bytes (config, default 262144), else nothing
fp_cache_key() {
  fk_min=$(cfg fingerprint.cache_min_bytes 262144); case "$fk_min" in ''|*[!0-9]*) fk_min=262144 ;; esac
  fk_m=$(stat -c '%s|%.9Y|%i|%.9Z' "$1" 2>/dev/null) || fk_m=$(stat -f '%z|%Fm|%i|%Fc' "$1" 2>/dev/null) || return 1
  case "$fk_m" in *[!0-9.\|]*|'') return 1 ;; esac
  [ "${fk_m%%|*}" -ge "$fk_min" ] 2>/dev/null || return 1
  printf '%s|%s\n' "$2" "$fk_m"
}
fp_cache_usable() { [ ! -L "$sr_main/.agents" ] && [ ! -L "$sr_main/.agents/local" ] && [ ! -L "$(fp_cache_file)" ]; }   # a link there (a repository can commit one) is no cache: never read or written through
fp_cache_get() { fp_cache_usable && [ -f "$(fp_cache_file)" ] || return 1; awk -F'\t' -v k="$1" '$1 == k { h = $2 } END { if (h ~ /^[0-9a-f]{64}$/) print h; else exit 1 }' "$(fp_cache_file)"; }
fp_cache_put() {
  fp_cache_usable || return 0
  case "$1" in *[[:cntrl:]]*) return 0 ;; esac   # a file name with a control character is never written
  mkdir -p "$sr_main/.agents/local" 2>/dev/null || return 0
  if [ -f "$(fp_cache_file)" ] && [ "$(wc -l < "$(fp_cache_file)")" -gt 4000 ]; then rm -f "$(fp_cache_file).t" 2>/dev/null; (set -C; tail -n 1000 "$(fp_cache_file)" > "$(fp_cache_file).t") 2>/dev/null && mv "$(fp_cache_file).t" "$(fp_cache_file)" 2>/dev/null || :; fi
  printf '%s\t%s\n' "$1" "$2" >> "$(fp_cache_file)" 2>/dev/null || :
}
# A154: files `proofline init/upgrade` installs outside .agents/ are control plane, not product: the files the manifest
# lists (agent definitions, the entry skill) and, by pattern, the agent files of both runtimes, plus the proofline block
# of AGENTS.md and CLAUDE.md (only the block; the rest of those files is the project's). A path a plan scope names
# stays tracked (A152).
installed_control_path() { # PATH
  case "$1" in .claude/agents/proofline-*.md|.codex/agents/proofline-*.toml) return 0 ;; esac
  [ -f "$root/.agents/.proofline-manifest" ] || return 1
  awk -v p="$1" '!/^#/ && $2 == p { f = 1 } END { exit !f }' "$root/.agents/.proofline-manifest"
}
installed_control_paths() { # one path per line: manifest-listed files outside .agents/
  [ -f "$root/.agents/.proofline-manifest" ] || return 0
  awk '!/^#/ && NF >= 2 && $2 !~ /^\.agents\// { print $2 }' "$root/.agents/.proofline-manifest"
}
is_block_file() { case "$1" in AGENTS.md|CLAUDE.md) return 0 ;; esac; return 1; }
# strip_proofline_block FILE: the file without its FIRST marked proofline block (A155: a second begin/end pair and everything
# after the first end marker is product text). A begin marker without an end marker is left whole.
strip_proofline_block() {
  if grep -qx '<!-- proofline:begin -->' "$1" && grep -qx '<!-- proofline:end -->' "$1"; then
    awk '/^<!-- proofline:begin -->$/ && !d && !s { s = 1; next } /^<!-- proofline:end -->$/ && s { s = 0; d = 1; next } !s { print }' "$1"
  else cat "$1"; fi
}
# block_only_file FILE (A156): the whole file is the first marked proofline block: both markers present and nothing but
# whitespace outside them (text after the end marker, a second pair or a lone marker is product text).
block_only_file() {
  grep -qx '<!-- proofline:begin -->' "$1" && grep -qx '<!-- proofline:end -->' "$1" || return 1
  ! strip_proofline_block "$1" | grep -q '[^[:space:]]'
}
# control_plane_only PATH: a changed path whose change is control plane only: an installed file, or AGENTS.md/CLAUDE.md
# whose content outside the proofline block equals the committed one (HEAD), or (A161) a file HEAD does not have yet whose
# whole working-tree content is the block.
control_plane_only() {
  installed_control_path "$1" && return 0
  { is_block_file "$1" && [ -f "$root/$1" ] && [ ! -L "$root/$1" ]; } || return 1
  cpo_t=$(mktemp "${TMPDIR:-/tmp}/agent-cpo.XXXXXX")
  if ! git -C "$root" show "HEAD:$1" > "$cpo_t" 2>/dev/null; then
    # A161: a file not committed yet (untracked or newly added) is control plane when the whole working-tree file is the
    # block, the same rule control_plane_range_only applies to a committed new file (A156); extra text keeps it a product change
    rm -f "$cpo_t"
    git -C "$root" cat-file -e "HEAD:$1" 2>/dev/null && return 1
    block_only_file "$root/$1"; return
  fi
  cpo_a=$(strip_proofline_block "$cpo_t" | sha256); cpo_b=$(strip_proofline_block "$root/$1" | sha256); rm -f "$cpo_t"
  [ "$cpo_a" = "$cpo_b" ]
}
# control_plane_range_only BASE PATH MAPS (A155): the change of PATH between BASE and HEAD is control plane only, by the
# same definition as control_plane_only (an installed file, or AGENTS.md/CLAUDE.md outside its first proofline block).
# A path the plan scope names (MAPS) stays tracked.
control_plane_range_only() {
  authorized_path "$3" "$2" && return 1
  # A169 (4th argument `own`): the run's own bookkeeping is not a product change either: its task file moving between the
  # lifecycle folders, and the knowledge step's documents (wiki, ADRs, design documents) the plan scope does not name.
  # It counts only with proof that the change is the run's own: HEAD is the run's delivery commit chain (ci_chain_ok), or the
  # ledger recorded the task file move (task-source-done) / the knowledge step's file with this very content (knowledge-paths).
  # Someone else's commit to docs/wiki, an ADR or a same-named task file is a product change as before.
  if [ "${4:-}" = own ]; then
    cpr_id=$(basename "$dir"); cpr_td=$(cfg tasks.dir .agents/tasks); cpr_src=$(section_value "$dir" task_source path)
    case "$2" in "$cpr_td"/*)
      if [ -n "$cpr_src" ] && [ "$(basename "$2")" = "$(basename "$cpr_src")" ] \
        && { ci_chain_ok "$cpr_id" || grep -q ' event=task-source-done ' "$(ledger_file "$cpr_id")" 2>/dev/null; }; then return 0; fi ;;
    esac
    if in_knowledge_scope "$2"; then
      if ci_chain_ok "$cpr_id"; then return 0; fi
      cpr_h=$(git -C "$root" show "HEAD:$2" 2>/dev/null | sha256) || cpr_h=''
      if [ -n "$cpr_h" ] && ! git -C "$root" cat-file -e "HEAD:$2" 2>/dev/null; then cpr_h=''; fi
      if [ -n "$cpr_h" ] && awk -v t="$2@$cpr_h" '/ event=knowledge-paths / { l = $0; sub(/ detail=/, " detail= ", l); if (index(" " l " ", " " t " ")) f = 1 } END { exit !f }' "$(ledger_file "$cpr_id")" 2>/dev/null; then return 0; fi
    fi
  fi
  # like the fingerprint (task_changed_paths, verify_scope): .agents/ is control plane, except run evidence, local state and the tasks directory
  case "$2" in .agents/runs/*|.agents/local/*|"$(cfg tasks.dir .agents/tasks)"/*) return 1 ;; .agents/*) return 0 ;; esac
  installed_control_path "$2" && return 0
  is_block_file "$2" || return 1
  cpr_a=$(mktemp "${TMPDIR:-/tmp}/agent-cpr.XXXXXX"); cpr_b=$(mktemp "${TMPDIR:-/tmp}/agent-cpr.XXXXXX")
  if git -C "$root" show "$1:$2" > "$cpr_a" 2>/dev/null && git -C "$root" show "HEAD:$2" > "$cpr_b" 2>/dev/null; then
    [ "$(strip_proofline_block "$cpr_a" | sha256)" = "$(strip_proofline_block "$cpr_b" | sha256)" ]; cpr_rc=$?
  elif ! git -C "$root" cat-file -e "$1:$2" 2>/dev/null && git -C "$root" show "HEAD:$2" > "$cpr_b" 2>/dev/null; then
    # A156: the file was created in the range (missing at BASE, committed at HEAD): control plane only when the whole file is the block
    block_only_file "$cpr_b"; cpr_rc=$?
  else cpr_rc=1; fi
  rm -f "$cpr_a" "$cpr_b"; return "$cpr_rc"
}
# base_moved_control_only BASE: true iff every file changed between BASE and HEAD is control plane only (A155).
base_moved_control_only() { # BASE [own]: with `own` (A169) the run's own task file move and knowledge documents count too
  bmc_maps=$(scope_mappings "$dir/PLAN.md" 2>/dev/null) || bmc_maps=''
  git -C "$root" merge-base --is-ancestor "$1" HEAD 2>/dev/null || return 1
  bmc_list=$(git -C "$root" diff --no-renames --name-only "$1" HEAD 2>/dev/null) || return 1
  printf '%s\n' "$bmc_list" | while IFS= read -r bmc_p; do
    [ -n "$bmc_p" ] || continue
    control_plane_range_only "$1" "$bmc_p" "$bmc_maps" "${2:-}" || exit 1
  done
}
# base_moved_offenders BASE (A161): what in BASE..HEAD is not control plane, for the stale-plan message: up to five paths; an
# AGENTS.md/CLAUDE.md is marked, because the user cannot tell from the path why a file that upgrade also writes counts.
base_moved_offenders() {
  bmo_maps=$(scope_mappings "$dir/PLAN.md" 2>/dev/null) || bmo_maps=''
  git -C "$root" merge-base --is-ancestor "$1" HEAD 2>/dev/null || { printf '%s\n' "the old base is not an ancestor of HEAD (another history)"; return 0; }
  git -C "$root" diff --no-renames --name-only "$1" HEAD 2>/dev/null | while IFS= read -r bmo_p; do
    [ -n "$bmo_p" ] || continue
    control_plane_range_only "$1" "$bmo_p" "$bmo_maps" own && continue
    if is_block_file "$bmo_p" && ! authorized_path "$bmo_maps" "$bmo_p"; then printf '%s (project text outside the proofline block, a second marker pair, a symlink or no markers)\n' "$bmo_p"
    else printf '%s\n' "$bmo_p"; fi
  done | head -5 | tr '\n' ';' | sed 's/;$//; s/;/; /g'
}
current_tracked_paths() {
  if [ -n "$ctp_base" ]; then git -C "$root" diff --no-renames --name-only "$ctp_base"
  else git -C "$root" diff --no-renames --name-only; git -C "$root" diff --cached --no-renames --name-only; fi | sort -u
}
current_untracked_paths() { git -C "$root" ls-files --others --exclude-standard | sort -u; }
baseline_entries() {
  awk '
    /^baseline:$/ { inside=1; next }
    inside && /^[^[:space:]]/ { exit }
    inside && /^  (tracked|untracked):$/ { type=$1; sub(/:$/, "", type); next }
    inside && /^    - path: / { path=$0; sub(/^    - path: /, "", path); if (getline <= 0 || $0 !~ /^      sha256: /) exit 1; hash=$0; sub(/^      sha256: /, "", hash); gsub(/"/, "", hash); print type "|" path "|" hash }
  ' "$1/RUN.yaml"
}
baseline_fingerprint() {
  type=$1 path=$2 dir=$3
  (baseline_entries "$dir" | while IFS='|' read -r entry_type entry_path entry_hash; do [ "$entry_type" = "$type" ] && [ "$entry_path" = "$path" ] && { printf '%s\n' "$entry_hash"; break; }; done) || true
}
validate_captured_baseline() {
  dir=$1 sha=$(repository_base_sha "$1")
  case "$sha" in ''|PENDING|*'<'*|*[!0-9a-f]*) fail "invalid repository.base_sha";; esac
  git -C "$root" rev-parse --verify "${sha}^{commit}" >/dev/null 2>&1 || fail "repository.base_sha is not a known commit"
  awk '
    /^baseline:$/ { inside=1; next }
    inside && /^[^[:space:]]/ { exit }
    inside && /^  status: captured$/ { status=1; next }
    inside && /^  (tracked|untracked):$/ { type=$1; sub(/:$/, "", type); sections[type]=1; next }
    inside && /^    - path: / {
      path=$0; sub(/^    - path: /, "", path)
      if (path == "" || type == "" || getline <= 0 || $0 !~ /^      sha256: /) bad=1
      else { value=$0; sub(/^      sha256: /, "", value); gsub(/"/, "", value); if (!((length(value) == 64 && value ~ /^[0-9a-f]+$/) || (type == "tracked" && value == "missing"))) bad=1 }
    }
    END { if (!status || !sections["tracked"] || !sections["untracked"] || bad) exit 1 }
  ' "$dir/RUN.yaml" || fail "invalid captured baseline entries"
}

# --- Content fingerprint (D12/D14): git tree id of the working tree incl. untracked files,
# excluding .agents/ (A152: the control plane, `proofline upgrade` included, is not product content and must not make
# a gate stale; runs, local state and the task directory are part of it) and, since A154, the other files upgrade
# installs (manifest-listed files, the agent files, the proofline block of AGENTS.md/CLAUDE.md). Built in a temporary index; never touches
# the real one.
content_fingerprint() {
  cf_mode=${1:-}   # A161: `legacy` computes the value 0.0.12 and 0.0.13 recorded (a block-only AGENTS.md/CLAUDE.md stays in the tree as its stripped blob)
  cf_tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-fp.XXXXXX")
  cf_idx=$(git -C "$root" rev-parse --git-path index)
  case "$cf_idx" in /*) ;; *) cf_idx=$root/$cf_idx ;; esac
  cf_objs=$(git -C "$root" rev-parse --git-path objects)
  case "$cf_objs" in /*) ;; *) cf_objs=$root/$cf_objs ;; esac
  # cf_try OBJECT-DIR: the tree id of the working tree in a private index; "" uses the repository's own object
  # database. A read-only .git (a Codex workspace-write sandbox) cannot take new objects, so the retry writes
  # them into a private directory and reads the repository's objects through an alternate: the tree id is
  # content-addressed, so it is the same value either way.
  # A152: a path under .agents/ that a run's plan scope names is task-owned product content, so it stays in the tree.
  # A154: the files `upgrade` installs (installed_control_paths, the agent-file patterns) and the proofline block of
  # AGENTS.md/CLAUDE.md are control plane too; a path a plan scope names (cf_named) stays in whole.
  cf_td=$(cfg tasks.dir .agents/tasks); cf_keep='' cf_named='' cf_kn=''
  [ "$cf_mode" != gate ] || cf_kn=$(knowledge_scope_entries)
  for cf_pl in "$root"/.agents/runs/*/PLAN.md; do
    [ -f "$cf_pl" ] || continue
    for cf_p in $(scope_mappings "$cf_pl" 2>/dev/null | cut -d '|' -f1); do
      cf_named="$cf_named $cf_p"
      case "$cf_p" in .agents/runs/*|.agents/local/*) continue ;; .agents/*) ;; *) continue ;; esac
      case "$cf_p" in "$cf_td"|"$cf_td"/*) continue ;; esac
      [ -f "$root/$cf_p" ] && cf_keep="$cf_keep $cf_p"
    done
  done
  cf_try() {
    [ ! -f "$cf_idx" ] || cp "$cf_idx" "$cf_tmp/index"
    (
      GIT_INDEX_FILE=$cf_tmp/index; export GIT_INDEX_FILE
      if [ -n "$1" ]; then GIT_OBJECT_DIRECTORY=$1; GIT_ALTERNATE_OBJECT_DIRECTORIES=$cf_objs; export GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; fi
      [ -f "$cf_tmp/index" ] || git -C "$root" read-tree HEAD >/dev/null 2>&1 || true
      # A202 item 28: .agents/ is removed from this tree just below (a path a plan scope names is put back with add -f), so it is not read at all:
      # a run folder that is not git-ignored (26 MB of screenshots in a real project) cost a hash and a zlib pass of every file, on every call
      git -C "$root" add -A -- . ':(exclude).agents' >/dev/null 2>&1 || exit 1
      git -C "$root" rm -r -q --cached --ignore-unmatch -- .agents "$cf_td" >/dev/null 2>&1
      # A171: the knowledge step writes these after the gates ran; they are documentation, so a gate does not bind them
      # (mode gate). A path a plan scope names stays in whole (put back below); approvals bind the full tree (no mode).
      if [ "$cf_mode" = gate ]; then
        # Only documentation extensions leave the gate fingerprint: an executable or any other file under a knowledge path stays counted.
        # One ls-files and batched removals (a large docs tree must not cost a git call per file).
        : > "$cf_tmp/kn.list"
        for cf_x in $cf_kn; do printf '%s\n' "${cf_x%/}"; done > "$cf_tmp/kn.paths"
        if [ -s "$cf_tmp/kn.paths" ]; then
          # shellcheck disable=SC2046 # the entries are plain paths without whitespace (config values)
          git -C "$root" ls-files -z -- $(cat "$cf_tmp/kn.paths") 2>/dev/null | grep -zEi '\.(md|json|ya?ml|txt)$' > "$cf_tmp/kn.list" || :
          [ ! -s "$cf_tmp/kn.list" ] || xargs -0 -n 500 git -C "$root" rm -q --cached --ignore-unmatch -- < "$cf_tmp/kn.list" >/dev/null 2>&1 || :
        fi
        for cf_n in $cf_named; do
          if in_knowledge_scope "$cf_n" && [ -f "$root/$cf_n" ]; then git -C "$root" add -f -- "$cf_n" >/dev/null 2>&1 || exit 1; fi
        done
      fi
      for cf_k in $cf_keep; do git -C "$root" add -f -- "$cf_k" >/dev/null 2>&1 || exit 1; done
      for cf_i in '.claude/agents/proofline-*.md' '.codex/agents/proofline-*.toml' $(installed_control_paths); do
        git -C "$root" rm -r -q --cached --ignore-unmatch -- "$cf_i" >/dev/null 2>&1
      done
      # an installed file a plan scope names stays tracked: put back each named one (matched per file, not per pattern)
      for cf_n in $cf_named; do
        if installed_control_path "$cf_n" && [ -f "$root/$cf_n" ]; then git -C "$root" add -f -- "$cf_n" >/dev/null 2>&1 || exit 1; fi
      done
      for cf_b in AGENTS.md CLAUDE.md; do
        case " $cf_named " in *" $cf_b "*) continue ;; esac
        [ -f "$root/$cf_b" ] && [ ! -L "$root/$cf_b" ] || continue
        grep -qx '<!-- proofline:begin -->' "$root/$cf_b" && grep -qx '<!-- proofline:end -->' "$root/$cf_b" || continue
        # A156: a file that is only the block leaves the tree like a missing file, so an upgrade that creates it keeps the gates fresh
        if [ "$cf_mode" != legacy ] && block_only_file "$root/$cf_b"; then git -C "$root" rm -q --cached --ignore-unmatch -- "$cf_b" >/dev/null 2>&1; continue; fi
        cf_blob=$(strip_proofline_block "$root/$cf_b" | git -C "$root" hash-object -w --stdin) || exit 1
        git -C "$root" update-index --add --cacheinfo "100644,$cf_blob,$cf_b" >/dev/null 2>&1 || exit 1
      done
      git -C "$root" write-tree 2>/dev/null
    )
  }
  if cf_out=$(cf_try '') && [ -n "$cf_out" ]; then rm -rf "$cf_tmp"; printf '%s\n' "$cf_out"; return 0; fi
  mkdir -p "$cf_tmp/objects"
  if cf_out=$(cf_try "$cf_tmp/objects") && [ -n "$cf_out" ]; then rm -rf "$cf_tmp"; printf '%s\n' "$cf_out"; return 0; fi
  rm -rf "$cf_tmp"; fail "could not compute the content fingerprint"
}

# The fingerprint gates, results and waivers bind: the content fingerprint without the knowledge step's files (A171).
gate_fingerprint() { content_fingerprint gate; }

# legacy_fingerprint_match RECORDED (A161): a gate record written by 0.0.12 or 0.0.13 (before A156) holds a content fingerprint
# in which a block-only AGENTS.md/CLAUDE.md is still part of the tree. That value is accepted as the current one iff the tree
# computed the old way equals it: the two rules differ only in such a file, so every product byte is still bound, and the
# check can only match when a block-only file exists. Nothing is written; a record written since 0.0.14 never reaches it.
legacy_fingerprint_match() {
  lm_any=''
  for lm_f in AGENTS.md CLAUDE.md; do
    [ -f "$root/$lm_f" ] && [ ! -L "$root/$lm_f" ] && block_only_file "$root/$lm_f" && lm_any=1
  done
  [ -n "$lm_any" ] || return 1
  [ "$(content_fingerprint legacy)" = "$1" ]
}

# --- Path globs (gitignore-like: ** spans directories, * and ? stay in one segment,
# a pattern without / matches at any depth). ----------------------------------------
g2re_awk='
    function g2re(p,   r, i, c, n) {
      if (index(p, "/") == 0) p = "**/" p
      r = ""; n = length(p)
      for (i = 1; i <= n; i++) {
        c = substr(p, i, 1)
        if (c == "*") {
          if (substr(p, i + 1, 1) == "*") { if (substr(p, i + 2, 1) == "/") { r = r "(.*/)?"; i += 2 } else { r = r ".*"; i++ } }
          else r = r "[^/]*"
        } else if (c == "?") r = r "[^/]"
        else if (index(".+()|^$[]{}\\", c)) r = r "\\" c
        else r = r c
      }
      return "^" r "$"
    }'
path_matches() { # PATH "GLOB GLOB ..."
  printf '%s\n' "$1" | awk -v pats="$2" "$g2re_awk"'
    { n = split(pats, a, " "); for (j = 1; j <= n; j++) if (a[j] != "" && $0 ~ g2re(a[j])) { found = 1; exit } }
    END { exit !found }'
}

# --- Pipeline: the class selects artifacts and the QA gate (config `pipelines:`). ---
pipeline_value() { cfg "pipelines.$1.$2"; }
pipeline_class_valid() { case "$1" in TRIVIAL|STANDARD|COMPLEX|CRITICAL) return 0 ;; *) return 1 ;; esac; }
pipeline_class() { section_value "$(run_dir "$1")" pipeline classification; }
pipeline_declared() { gates_enforced "$1" && section_key_present "$(run_dir "$1")" pipeline classification; }
pipeline_needs() { # ID evidence|qa|architect
  pn_class=$(pipeline_class "$1")
  if pipeline_declared "$1" && pipeline_class_valid "$pn_class"; then pipeline_value "$pn_class" "$2"; return 0; fi
  if [ "$2" = evidence ]; then echo yes; else echo no; fi
}
# Whether the class requires review at all (tier floor small); CRITICAL is always full.
pipeline_review() {
  pr_class=$(pipeline_class "$1"); pr_value=$(pipeline_value "$pr_class" review)
  case "$pr_value" in
    yes|no) printf '%s\n' "$pr_value" ;;
    optional) if [ "$(section_value "$(run_dir "$1")" pipeline review)" = yes ]; then echo yes; else echo no; fi ;;
    *) echo no ;;
  esac
}
pipeline_signature() {
  if pipeline_declared "$1" && pipeline_class_valid "$(pipeline_class "$1")"; then printf '%s:review=%s\n' "$(pipeline_class "$1")" "$(pipeline_review "$1")"; fi
}
run_autonomy() { # ID -> supervised|autonomous (RUN.yaml execution.autonomy, else config autonomy.<CLASS>)
  ra=$(section_value "$(run_dir "$1")" execution autonomy)
  case "$ra" in supervised|autonomous) ;; *) ra=$(cfg "autonomy.$(pipeline_class "$1")" supervised) ;; esac
  printf '%s\n' "$ra"
}

# PLAN.md sections. `## Data` carries `destructive: yes|no` as its first non-blank line.
# plan_migration_shape PLAN -> expand_contract | single_step | missing | none (not destructive). A destructive
# plan carries the data-design step table in `## Data` (`| step | phase | operation | object | destructive | ...`):
# expand_contract = a non-destructive step in phase expand|backfill|switch, every destructive step in phase
# contract or deferred (a separate, later migration; A141: a destructive step in expand|backfill|switch is one step). single_step = the plan says `single_step: yes`, which the
# freeze accepts only with the user's `single_step` approval (A32).
plan_migration_shape() {
  [ "$(plan_destructive "$1")" = yes ] || { echo none; return 0; }
  pms=$(awk -F'|' '
    function t(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return tolower(s) }
    /^## / { inside = ($0 ~ /^## Data[[:space:]]*$/); next }
    !inside { next }
    /^[[:space:]]*(-|\*)?[[:space:]]*single_step:[[:space:]]*yes[[:space:]]*$/ { single = 1; next }
    /^\|/ && NF >= 7 {
      ph = t($3); dest = t($6)
      if (ph !~ /^(expand|backfill|switch|contract|deferred)$/) next
      if (dest == "yes") { if (ph == "deferred" || ph == "contract") late = 1; else early = 1 }
      else if (ph ~ /^(expand|backfill|switch)$/) pre = 1
    }
    END { if (single) print "single_step"; else if (pre && late && !early) print "expand_contract"; else print "missing" }' "$1")
  # A52: `single_step: yes` is only offered when the task states that the user wants one step.
  if [ "$pms" = single_step ] && ! grep -Eiq 'single[- ]step|one[- ]step|one migration|tek ad[ıi]m' "$(dirname "$1")/TASK.md" 2>/dev/null; then pms=missing; fi
  echo "$pms"
}
plan_section_present() { grep -q "^## $2[[:space:]]*\$" "$1" 2>/dev/null; }
plan_destructive() { # PLAN -> yes|no|invalid|absent
  plan_section_present "$1" Data || { echo absent; return 0; }
  awk '/^## Data[[:space:]]*$/ { i=1; next } i && /^[[:space:]]*$/ { next } i { v=$0; if (v ~ /^destructive:[[:space:]]*(yes|no)[[:space:]]*$/) { sub(/^destructive:[[:space:]]*/, "", v); sub(/[[:space:]]*$/, "", v); print v } else print "invalid"; exit }' "$1" | grep . || echo invalid
}

# --- Assumption register (A79) ------------------------------------------------------------------
# PLAN.md and a consolidated EVIDENCE.md carry `## Assumptions`: `none`, or the table
# `| id | assumption | source | risk | verification | status | decisions |` (id AS-<n>, risk low|medium|high,
# status verified|unverified). Freeze refuses an unverified high-risk assumption unless the user answered the
# question bound to it (`ASSUMPTION: <id>@<12 hex of sha256(text)>` in the question) with `accept <id>` (the id
# is part of the phrase and, as the answer must be words of the user's own captured prompt, of what the user said); the run then
# reports it as accepted-by-user with the answer file as reference. Mirrors validate-plan.mjs / verify-claims.mjs.
# assumption_scan FILE -> NOSECTION | ERR<TAB>message | ROW<TAB>id risk status text source method decisions
assumption_scan() {
  awk '
    function t(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    function nomethod(s) { s = tolower(t(s)); return s == "" || s ~ /^(none|n\/a|-|tbd|todo|unknown)$/ }
    function err(m) { printf "ERR\t%s\n", m }
    BEGIN { FS = "|" }
    /^## / { inside = ($0 ~ /^## Assumptions[ \t]*$/); if (inside) found++; next }
    !inside || found > 1 { next }
    /^[ \t]*$/ { next }
    tolower(t($0)) == "none" { none = 1; next }
    /^[ \t]*\|.*\|[ \t]*$/ {
      if (!hdr) {
        hdr = 1
        if (NF != 9 || tolower(t($2) "|" t($3) "|" t($4) "|" t($5) "|" t($6) "|" t($7) "|" t($8)) != "id|assumption|source|risk|verification|status|decisions") err("Assumptions: header must be | id | assumption | source | risk | verification | status | decisions |")
        next
      }
      if (t($2) ~ /^:?-+:?$/) next
      rows++
      id = t($2); risk = t($5); st = t($7)
      if (NF != 9) { err("Assumptions " id ": expected 7 columns"); next }
      if (id !~ /^AS-[0-9]+$/) err("Assumptions " id ": id must match AS-<n>")
      if (toupper(id) in seen) err("Assumptions " id ": duplicate id")
      seen[toupper(id)] = 1
      if (t($3) == "") err("Assumptions " id ": assumption text is empty")
      if (t($4) == "") err("Assumptions " id ": source is empty")
      if (risk != "low" && risk != "medium" && risk != "high") err("Assumptions " id ": risk must be low|medium|high")
      if (st != "verified" && st != "unverified") err("Assumptions " id ": status must be verified|unverified (accepted-by-user is recorded by the run, not written here)")
      if (st == "verified" && nomethod($6)) err("Assumptions " id ": verified without a verification method")
      if (risk == "high" && nomethod($6)) err("Assumptions " id ": a high-risk assumption needs a verification method")
      if (t($8) == "") err("Assumptions " id ": decisions is empty")
      printf "ROW\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", id, risk, st, t($3), t($4), t($6), t($8)
      next
    }
    { err("Assumptions: \"" t($0) "\" is not a table row (write none or the table)") }
    END {
      if (found == 0) { print "NOSECTION"; exit }
      if (found > 1) err("section \"## Assumptions\" appears more than once")
      else if (none && rows) err("Assumptions: \"none\" together with rows")
      else if (!none && !rows) err("section \"## Assumptions\" has no rows: write none or the table")
    }' "$1"
}
# assumption_shape_errors ID -> one problem per line (PLAN.md always, EVIDENCE.md when the pipeline needs it)
assumption_shape_errors() {
  ase_d=$(run_dir "$1")
  for ase_f in PLAN.md EVIDENCE.md; do
    if [ "$ase_f" = EVIDENCE.md ] && { [ ! -f "$ase_d/EVIDENCE.md" ] || [ "$(pipeline_needs "$1" evidence)" != yes ]; }; then continue; fi
    [ -f "$ase_d/$ase_f" ] || continue
    assumption_scan "$ase_d/$ase_f" | while IFS="$(printf '\t')" read -r ase_k ase_m; do
      case "$ase_k" in NOSECTION) echo "$ase_f: the mandatory '## Assumptions' section is missing (write 'none' or the register table)" ;; ERR) echo "$ase_f: $ase_m" ;; esac
    done
  done
}
# assumption_register ID -> merged register, one line per id: id risk status text source method decisions (TAB).
# An id present in PLAN.md and EVIDENCE.md is one assumption: the higher risk and the less verified status win.
assumption_register() {
  ar_d=$(run_dir "$1")
  { assumption_scan "$ar_d/PLAN.md"; [ ! -f "$ar_d/EVIDENCE.md" ] || assumption_scan "$ar_d/EVIDENCE.md"; } | awk -F'\t' '
    $1 != "ROW" { next }
    { rank = ($3 == "high") ? 3 : ($3 == "medium") ? 2 : 1
      if (!($2 in seen)) { seen[$2] = 1; order[++n] = $2; risk[$2] = $3; rr[$2] = rank; st[$2] = $4; line[$2] = $5 "\t" $6 "\t" $7 "\t" $8 }
      else { if (rank > rr[$2]) { rr[$2] = rank; risk[$2] = $3 } if ($4 == "unverified") st[$2] = "unverified" } }
    END { for (i = 1; i <= n; i++) { id = order[i]; printf "%s\t%s\t%s\t%s\n", id, risk[id], st[id], line[id] } }'
}
assumption_token() { printf '%s@%s\n' "$1" "$(printf '%s' "$2" | sha256 | cut -c1-12)"; } # ID TEXT
# assumption_state ID TOKEN -> accepted <answer file> | pending <question file> | declined <answer file> | none
assumption_state() {
  as_d=$(run_dir "$1"); as_pend='' as_decl=''
  for as_q in "$as_d"/questions/[0-9][0-9][0-9].md; do
    [ -e "$as_q" ] || continue
    grep -Eq "^[[:space:]]*ASSUMPTION: $2[[:space:]]*\$" "$as_q" || continue
    as_a=${as_q%.md}.answer.md
    if [ ! -e "$as_a" ]; then as_pend=questions/$(basename "$as_q"); continue; fi
    if [ "$(gate_field "$as_a" answered_by)" = user ] && sed '1,/^---$/d' "$as_a" | tr -s '[:space:]' ' ' | sed 's/^ //' | grep -Eiq "^accept(ed)?[[:space:]]+${2%@*}([^0-9]|\$)"; then
      echo "accepted questions/$(basename "$as_a")"; return 0
    fi
    as_decl=questions/$(basename "$as_a")
  done
  if [ -n "$as_pend" ]; then echo "pending $as_pend"; elif [ -n "$as_decl" ]; then echo "declined $as_decl"; else echo none; fi
}
# assumption_states ID -> id risk state ref text (TAB). state: verified | accepted-by-user (ref = the answer) |
# unverified (low/medium, listed) | blocked (high; ref = "<none|pending|declined> [file]").
assumption_states() {
  ast_id=$1
  assumption_register "$ast_id" | while IFS="$(printf '\t')" read -r ast_a ast_r ast_s ast_t _; do
    if [ "$ast_s" = verified ]; then printf '%s\t%s\tverified\t-\t%s\n' "$ast_a" "$ast_r" "$ast_t"; continue; fi
    ast_st=$(assumption_state "$ast_id" "$(assumption_token "$ast_a" "$ast_t")")
    case "$ast_st" in
      accepted*) printf '%s\t%s\taccepted-by-user\t%s\t%s\n' "$ast_a" "$ast_r" "${ast_st#accepted }" "$ast_t" ;;
      *) if [ "$ast_r" = high ]; then printf '%s\t%s\tblocked\t%s\t%s\n' "$ast_a" "$ast_r" "$ast_st" "$ast_t"
         else printf '%s\t%s\tunverified\t-\t%s\n' "$ast_a" "$ast_r" "$ast_t"; fi ;;
    esac
  done
}
assumption_blocked() { assumption_states "$1" | awk -F'\t' '$3 == "blocked"'; }

# --- Tier (D14): computed from the task-owned diff, recorded, never decreasing. ------
tier_rank() { case "$1" in docs) echo 0 ;; small) echo 1 ;; full) echo 2 ;; *) echo -1 ;; esac; }
tier_max() { if [ "$(tier_rank "$1")" -ge "$(tier_rank "$2")" ]; then echo "$1"; else echo "$2"; fi; }
# Paths the task changed against repository.base_sha (tracked, staged or not, plus untracked), minus the run
# directory, .agents/local/, the task files directory and baseline files whose content is unchanged.
# knowledge_doc_file PATH (round 6): only a regular, non-executable, non-symlink file with a documentation extension counts as knowledge output;
# anything else under the knowledge scope (a script, a link, an executable) stays task output and is scanned, sized and gated.
knowledge_doc_file() {
  kd_f=$root/$1
  { [ -f "$kd_f" ] && [ ! -L "$kd_f" ] && [ ! -x "$kd_f" ]; } || return 1
  case "$1" in *.md|*.mdx|*.rst|*.adoc|*.html|*.txt|*.png|*.jpg|*.jpeg|*.gif|*.svg|*.webp) ;; *) return 1 ;; esac
  case "$(dirname "$kd_f")" in "$root"|"$root"/*) ;; *) return 1 ;; esac
  [ "$(cd "$(dirname "$kd_f")" 2>/dev/null && pwd -P)" = "$(cd "$root" && pwd -P)/$(dirname "$1")" ] || return 1   # no linked folder on the way
}
task_changed_paths() {
  tcp_d=$(run_dir "$1"); tcp_base=$(repository_base_sha "$tcp_d"); case "$tcp_base" in ''|PENDING) tcp_base=HEAD ;; esac
  tcp_tasks=$(cfg tasks.dir .agents/tasks); tcp_maps=$(scope_mappings "$tcp_d/PLAN.md" 2>/dev/null) || tcp_maps=''
  # A184 (round 2): from CODE_DONE on, a knowledge-scope file (docs/wiki, design documents, ADR) the plan does not name is the knowledge step's
  # output, not task output: it never moves the tier, risk signals or the gates (knowledge_owned_paths and the SECRETS rescan own it). Before
  # CODE_DONE such a file still counts (verify-scope reports it as unauthorized).
  tcp_ks=no; case "$(section_value "$tcp_d" handoff state 2>/dev/null)" in CODE_DONE|DONE) tcp_ks=yes ;; esac
  { git -C "$root" diff --no-renames --name-only "$tcp_base" -- 2>/dev/null; current_untracked_paths; } | sort -u | while IFS= read -r tcp_p; do
    [ -n "$tcp_p" ] || continue
    case "$tcp_p" in .agents/runs/*|.agents/local/*|"$tcp_tasks"/*) continue ;; esac
    if [ "$tcp_ks" = yes ] && in_knowledge_scope "$tcp_p" && ! authorized_path "$tcp_maps" "$tcp_p" && knowledge_doc_file "$tcp_p"; then continue; fi
    # a control-plane file the plan scope does not name is the user's edit, not a task change (verify-scope lists it)
    case "$tcp_p" in .agents/*) authorized_path "$tcp_maps" "$tcp_p" || continue ;; esac
    # A154: nor is a file `upgrade` installs (or the proofline block of AGENTS.md/CLAUDE.md): an upgrade never moves the tier
    if control_plane_only "$tcp_p" && ! authorized_path "$tcp_maps" "$tcp_p"; then continue; fi
    tcp_prior=$(baseline_fingerprint tracked "$tcp_p" "$tcp_d"); [ -n "$tcp_prior" ] || tcp_prior=$(baseline_fingerprint untracked "$tcp_p" "$tcp_d")
    if [ -n "$tcp_prior" ] && [ "$tcp_prior" = "$(fingerprint_path "$tcp_p")" ]; then continue; fi
    printf '%s\n' "$tcp_p"
  done
}
# Changed line count (added + deleted) of one path; a binary file counts as large.
path_changed_lines() {
  pcl_base=$(repository_base_sha "$(run_dir "$1")"); case "$pcl_base" in ''|PENDING) pcl_base=HEAD ;; esac
  if git -C "$root" ls-files --error-unmatch -- "$2" >/dev/null 2>&1 || git -C "$root" cat-file -e "$pcl_base:$2" 2>/dev/null; then
    git -C "$root" diff --numstat --no-renames "$pcl_base" -- "$2" | awk '{ if ($1 == "-") s += 100000; else s += $1 + $2 } END { print s + 0 }'
  elif [ -f "$root/$2" ]; then
    if grep -Iq . "$root/$2" 2>/dev/null || [ ! -s "$root/$2" ]; then wc -l < "$root/$2" | tr -d ' '; else echo 100000; fi
  else echo 0; fi
}
diff_stats() { # ID -> "files lines"
  ds_f=0 ds_l=0
  for ds_p in $(task_changed_paths "$1"); do ds_f=$((ds_f + 1)); ds_l=$((ds_l + $(path_changed_lines "$1" "$ds_p"))); done
  printf '%s %s\n' "$ds_f" "$ds_l"
}
tier_compute() {
  tc_id=$1
  if [ "${rs_cache_id:-}" = "$tc_id" ] && [ -n "${rs_tier:-}" ]; then printf '%s\n' "$rs_tier"; return 0; fi   # risk_prime
  [ "$(pipeline_class "$tc_id")" != CRITICAL ] || { echo full; return 0; }
  tc_docs=yes tc_risky=no tc_files=0 tc_lines=0
  tc_cl=$(cfg review.code_like_markdown '.agents/** skills/** roles/** adapters/** .claude/** .codex/** AGENTS.md CLAUDE.md **/SKILL.md **/*.prompt.md')
  tc_rp="$(cfg review.risky_paths '') $eco_risky_set"; tc_rp=${tc_rp# }
  # A78: a path signal checked by the migration focus is risky too, so REVIEW_DATA exists to carry the check.
  tc_mg=''; for tc_n in $(risk_names); do [ "$(cfg "risk.$tc_n.check")" != migration ] || tc_mg="$tc_mg $(cfg "risk.$tc_n.paths")"; done
  # Risky paths and code-like markdown are checked first; only a plain-documentation extension is docs
  # (a directory such as docs/ never makes code documentation).
  for tc_p in $(task_changed_paths "$tc_id"); do
    tc_files=$((tc_files + 1)); tc_lines=$((tc_lines + $(path_changed_lines "$tc_id" "$tc_p")))
    if [ -n "$tc_rp" ] && path_matches "$tc_p" "$tc_rp"; then tc_risky=yes; tc_docs=no
    elif [ -n "${tc_mg# }" ] && path_matches "$tc_p" "$tc_mg" && ! path_matches "$tc_p" '*.md *.mdx *.rst *.adoc'; then tc_risky=yes; tc_docs=no
    elif path_matches "$tc_p" "$tc_cl" || ! path_matches "$tc_p" '*.md *.mdx *.rst *.adoc *.txt'; then tc_docs=no; fi
  done
  if [ "$tc_docs" = yes ]; then tc_t=docs
  elif [ "$tc_files" -le "$(cfg review.small_max_files 2)" ] && [ "$tc_lines" -le "$(cfg review.small_max_lines 30)" ] && [ "$tc_risky" = no ]; then tc_t=small
  else tc_t=full; fi
  [ "$(pipeline_review "$tc_id")" != yes ] || tc_t=$(tier_max "$tc_t" small)
  printf '%s\n' "$tc_t"
}
tier_effective() {
  te_rec=$(section_value "$(run_dir "$1")" pipeline tier)
  te_now=$(tier_compute "$1")
  case "$te_rec" in docs|small|full) tier_max "$te_rec" "$te_now" ;; *) printf '%s\n' "$te_now" ;; esac
}

# --- Risk signals (A78): deterministic signals select extra focuses inside the existing gates. -------------
# A signal comes from a changed path (diff), a PLAN.md scope path (scope; visible before FREEZE), the content
# added by the diff (diff, `content`), or a PLAN.md flag (plan). Config `risk.<name>.paths|content|flag|check|
# design_role` maps it to a focus (`check`) and the design role that declares it; the block is frozen
# (freeze.risk_sha256) and the lead never edits .agents/config.yaml during a run. A diff signal whose `flag` is
# not `yes` in PLAN.md is a blocking finding of its focus, added by `record` (the focus still runs).
risk_plan_flags='contract_change concurrency performance_critical'   # PLAN.md `## Risk`: `<flag>: yes|no`
risk_flags="$risk_plan_flags data_change destructive ui"            # data_change/destructive: `## Data`; ui: `## UI`
risk_focus_on_gate() { # FOCUS GATE
  case "$1:$2" in contract:REVIEW_RULES|concurrency:REVIEW_RULES|performance:REVIEW_RULES|config:REVIEW_RULES) return 0 ;;
    contract:REVIEW_SMALL|concurrency:REVIEW_SMALL|performance:REVIEW_SMALL|config:REVIEW_SMALL) return 0 ;;
    migration:REVIEW_DATA|visual:QA|dependencies:SECURITY|logging:SECURITY) return 0 ;; *) return 1 ;; esac
}
plan_flag() { # PLAN FLAG -> yes|no
  [ -f "$1" ] || { echo no; return 0; }
  case "$2" in
    data_change) if plan_section_present "$1" Data; then echo yes; else echo no; fi ;;
    ui) if plan_section_present "$1" UI; then echo yes; else echo no; fi ;;
    destructive) if [ "$(plan_destructive "$1")" = yes ]; then echo yes; else echo no; fi ;;
    *) awk -v f="$2" '/^## / { i = ($0 ~ /^## Risk[[:space:]]*$/); next } i { l = $0; sub(/^[-*][[:space:]]*/, "", l); if (l ~ ("^" f ":[[:space:]]*yes([[:space:]]|$)")) y = 1 } END { print (y ? "yes" : "no") }' "$1" ;;
  esac
}
# The block the freeze binds: the risk mapping, the performance thresholds (A87), every non-empty security.* key
# (A88: license policy, audit command) and every non-empty contract.* key (A83: contract.paths / contract.ignore
# globs), so a mid-run edit of any of them is refused. Empty security and contract keys are left out, so a config
# that does not set them hashes as before.
# A173: the ecosystem set that joins the signal whose check is `dependencies` is bound too (one synthetic line), so a changed
# definition cannot silently change a frozen run's signal.
rk_set=''
risk_config() {
  # A203: the config is read once per process; risk_prime keeps the block (subshells inherit it) instead of a grep per question
  if [ "$rk_set" = yes ]; then [ -z "$rk_val" ] || printf '%s\n' "$rk_val"; return 0; fi
  { printf '%s' "$cfg_cache" | grep -E '^(risk\.|performance\.|security\..*=.|contract\..*=.)' || true
    [ -z "$eco_dependency_set" ] || printf 'risk.ecosystems.dependencies=%s\n' "$eco_dependency_set"; }
}
# A162: `risk.log_sensitive` is a new default signal. A run frozen before it existed bound a risk block without it, and
# `proofline upgrade` adds the key to the config; the bounded legacy rule: a freeze whose recorded hash equals the hash
# of the block WITHOUT `risk.log_sensitive.*` stays valid, and that run keeps the signal set it was frozen with (the
# logging focus never opens for it). A run frozen under this rule hashes the key, so it cannot match the legacy value
# and an edit of the key is refused. A refreeze binds the current block (the key included).
# A173: a run frozen before the ecosystem set joined the block (0.0.29 and older) bound the block without the synthetic line;
# such a run keeps the signal paths it was frozen with (the config's own), and `verify-freeze` accepts its recorded hash.
risk_config_noeco() { risk_config | grep -v '^risk\.ecosystems\.'; }
risk_config_legacy() { risk_config | grep -v '^risk\.log_sensitive[.=]'; }   # (A162) without log_sensitive
risk_config_legacy_noeco() { risk_config_legacy | grep -v '^risk\.ecosystems\.'; }   # frozen by 0.0.28 or older: neither
risk_freeze_ok() { # RECORDED-HASH -> 0 when it is the current block or one of the bounded legacy forms
  [ "$1" = "$(risk_config | sha256)" ] || [ "$1" = "$(risk_config_noeco | sha256)" ] || [ "$1" = "$(risk_config_legacy | sha256)" ] || [ "$1" = "$(risk_config_legacy_noeco | sha256)" ]
}
risk_eco_unbound() { # ID -> 0 when the run was frozen on a block without the ecosystem set (it keeps its own paths)
  re_d=$(run_dir "$1"); re_h=$(section_value "$re_d" freeze risk_sha256 2>/dev/null || true); [ -n "$re_h" ] || return 1
  [ "$re_h" != "$(risk_config | sha256)" ] && { [ "$re_h" = "$(risk_config_noeco | sha256)" ] || [ "$re_h" = "$(risk_config_legacy_noeco | sha256)" ]; }
}
# risk_paths ID NAME -> the globs of one signal: its config value, plus the ecosystem set when its check is `dependencies`
# (unless the run was frozen before that set existed).
risk_paths() {
  rpa_g=$(cfg "risk.$2.paths")
  if [ "$(cfg "risk.$2.check")" = dependencies ] && [ -n "$eco_dependency_set" ] && ! risk_eco_unbound "$1"; then rpa_g="$rpa_g $eco_dependency_set"; fi
  printf '%s\n' "${rpa_g# }"
}
risk_legacy_frozen() { # ID -> 0 when the run was frozen on the block without risk.log_sensitive
  rl_d=$(run_dir "$1"); rl_h=$(section_value "$rl_d" freeze risk_sha256 2>/dev/null || true); [ -n "$rl_h" ] || return 1
  [ "$rl_h" != "$(risk_config | sha256)" ] && [ "$rl_h" != "$(risk_config_noeco | sha256)" ] && { [ "$rl_h" = "$(risk_config_legacy | sha256)" ] || [ "$rl_h" = "$(risk_config_legacy_noeco | sha256)" ]; }
}
# Verbatim copy of contract-proof's NOT_A_CONTRACT (skills stay standalone; risk-test asserts equality, A92).
risk_not_contract='(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|composer\.json|(ts|js)config[^/]*\.json|openapitools\.json|openapi-generator-config\.ya?ml|\.eslintrc[^/]*|\.prettierrc[^/]*|\.babelrc[^/]*|babel\.config\.json|\.stylelintrc[^/]*|\.markdownlint[^/]*|lerna\.json|nx\.json|turbo\.json|renovate\.json|deno\.jsonc?|bower\.json|pnpm-(lock|workspace)\.yaml|\.pre-commit-config\.yaml|\.gitlab-ci\.yml|docker-compose[^/]*\.ya?ml|compose\.ya?ml|mkdocs\.ya?ml|\.readthedocs\.ya?ml|codecov\.ya?ml|dependabot\.ya?ml)$|^\.github\/(workflows|actions|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE|DISCUSSION_TEMPLATE)\/|^\.github\/(dependabot|labeler|release|stale|FUNDING|config)\.ya?ml$|^(\.vscode|\.idea|\.agents|\.devcontainer)\/'
risk_names() { risk_config | awk -F= '$1 ~ /^risk\.[a-z_]+\.(paths|content)$/ && $2 != "" { split($1, p, "."); print p[2] }' | sort -u; }
# A162: the lines a path's diff adds against BASE (the whole file when it is new), and the line match of a `words`
# signal: a line matches `content` (extended regular expression, via ENVIRON so no backslash is rewritten) and names
# one of the words as a whole identifier part: case-insensitive, not inside a longer lowercase run (`password`,
# `user_password`, `userPassword`, `passwords` match; `classname` does not contain `ssn`; `discard` is not `card`).
risk_added_lines() { # BASE PATH
  if git -C "$root" cat-file -e "$1:$2" 2>/dev/null; then
    git -C "$root" diff --no-renames -U0 "$1" -- "$2" 2>/dev/null | awk '/^@@/ { h = 1; next } h && /^\+/ { print substr($0, 2) }'
  else cat "$root/$2" 2>/dev/null || true; fi
}
risk_words_match() { # CONTENT WORDS, lines on stdin -> exit 0 when one line matches
  RISK_RE=$1 RISK_WORDS=$2 awk '
    BEGIN { re = ENVIRON["RISK_RE"]; n = split(tolower(ENVIRON["RISK_WORDS"]), w, " ") }
    $0 ~ re {
      l = tolower($0)
      for (i = 1; i <= n && !found; i++) {
        s = 1
        while ((j = index(substr(l, s), w[i])) > 0) {
          pos = s + j - 1; e = pos + length(w[i])
          pc = (pos > 1) ? substr($0, pos - 1, 1) : ""; c = substr($0, pos, 1)
          okb = (pc == "" || pc !~ /[A-Za-z]/ || (c ~ /[A-Z]/ && pc ~ /[a-z]/))
          n1 = substr($0, e, 1); n2 = (n1 ~ /[sS]/) ? substr($0, e + 1, 1) : "x"
          oka = (n1 !~ /[a-z]/ || (n1 ~ /[sS]/ && n2 !~ /[a-z]/))
          if (okb && oka) { found = 1; break }
          s = pos + 1
        }
      }
    }
    END { exit found ? 0 : 1 }'
}
# risk_compute ID -> "name|source|path|why" lines (source diff|scope|plan). Plain documentation (.md .mdx .rst
# .adoc) never carries a path or content signal: a guide named like a migration is not one.
risk_compute() {
  rc_d=$(run_dir "$1"); rc_base=$(repository_base_sha "$rc_d"); case "$rc_base" in ''|PENDING) rc_base=HEAD ;; esac
  rc_changed=$(task_changed_paths "$1" | grep -v -E '\.(md|mdx|rst|adoc)$|^\.agents/' || true)
  rc_scope=$(scope_mappings "$rc_d/PLAN.md" 2>/dev/null | cut -d'|' -f1 | grep -v -E '\.(md|mdx|rst|adoc)$' || true)
  # A203: the "diff <path>" / "scope <path>" lines every path signal is matched against, built once (not two sed processes per signal)
  rc_tagged=$({ [ -z "$rc_changed" ] || printf '%s\n' "$rc_changed" | sed 's/^/diff /'; [ -z "$rc_scope" ] || printf '%s\n' "$rc_scope" | sed 's/^/scope /'; })
  rc_legacy=no; ! risk_legacy_frozen "$1" || rc_legacy=yes
  for rc_n in $(risk_names); do
    [ "$rc_n:$rc_legacy" != log_sensitive:yes ] || continue   # a run frozen before the signal keeps its focus set
    rc_g=$(risk_paths "$1" "$rc_n")
    if [ -n "$rc_g" ]; then
      { [ -z "$rc_tagged" ] || printf '%s\n' "$rc_tagged"; } |
        awk -v n="$rc_n" -v pats="$rc_g" "$g2re_awk"'
          { src = $1; p = substr($0, length(src) + 2); c = split(pats, a, " ")
            for (j = 1; j <= c; j++) if (a[j] != "" && p ~ g2re(a[j])) { print n "|" src "|" p "|" a[j]; break } }'
    fi
    rc_c=$(cfg "risk.$rc_n.content"); rc_w=$(cfg "risk.$rc_n.words")
    [ -n "$rc_c" ] && [ -n "$rc_changed" ] || continue
    printf '%s\n' "$rc_changed" | while IFS= read -r rc_p; do
      if [ -n "$rc_g" ] && path_matches "$rc_p" "$rc_g"; then continue; fi   # already a path signal
      # A162: a signal with `words` is matched on the lines the diff adds (not the whole file): one added line must
      # match `content` and name one of the words. It only opens a review, it is never a finding.
      if [ -n "$rc_w" ]; then
        risk_added_lines "$rc_base" "$rc_p" | risk_words_match "$rc_c" "$rc_w" &&
          printf '%s|diff|%s|added line matching risk.%s.content with a word of risk.%s.words\n' "$rc_n" "$rc_p" "$rc_n" "$rc_n" || true
        continue
      fi
      # A92: ordinary config is not a contract: contract.ignore and a minimal not-a-contract list skip the content check.
      if [ "$rc_n" = contract_file ]; then
        if printf '%s\n' "$rc_p" | grep -Eiq -- "$risk_not_contract"; then continue; fi
        rc_ig=$(cfg contract.ignore); if [ -n "$rc_ig" ] && path_matches "$rc_p" "$rc_ig"; then continue; fi
      fi
      # A92: a file that exists at base matches on its base version OR its whole current version (a root key such as
      # `openapi:` sits on an unchanged line, and a deleted operation adds none); a new file on its content.
      { git -C "$root" show "$rc_base:$rc_p" 2>/dev/null || true; [ ! -f "$root/$rc_p" ] || cat "$root/$rc_p"; } |
        grep -Eq -- "$rc_c" && printf '%s|diff|%s|content /%s/\n' "$rc_n" "$rc_p" "$(printf '%s' "$rc_c" | tr '|' '/')" || true
    done
  done
  for rc_f in $risk_flags; do
    [ -n "$(cfg "risk.$rc_f.check")" ] && [ "$(plan_flag "$rc_d/PLAN.md" "$rc_f")" = yes ] || continue
    case "$rc_f" in data_change) rc_w='## Data section' ;; destructive) rc_w='## Data destructive: yes' ;; ui) rc_w='## UI section' ;; *) rc_w="## Risk $rc_f: yes" ;; esac
    printf '%s|plan|PLAN.md|%s\n' "$rc_f" "$rc_w"
  done
  return 0
}
# risk_signals ID: risk_compute, cached for the process after risk_prime (subshells inherit the cache).
# The cache also holds the computed tier: within one command the tree does not change.
risk_prime() { rs_cache_id=''; rk_set=''; rk_val=$(risk_config); rk_set=yes; rs_tier=$(tier_compute "$1"); rs_cache=$(risk_compute "$1"); rs_focuses=$(risk_focuses_of "$1"); rs_cache_id=$1; }
risk_signals() { if [ "${rs_cache_id:-}" = "$1" ]; then [ -z "$rs_cache" ] || printf '%s\n' "$rs_cache"; else risk_compute "$1"; fi; }
risk_focuses_of() { risk_signals "$1" | cut -d'|' -f1 | sort -u | while IFS= read -r rfo_n; do cfg "risk.$rfo_n.check"; done | sed '/^$/d' | sort -u; }
risk_gate_focuses() { # ID GATE -> the risk focuses the gate carries for this run
  if [ "${rs_cache_id:-}" = "$1" ]; then rgf_all=$rs_focuses; else rgf_all=$(risk_focuses_of "$1"); fi
  for rgf_f in $rgf_all; do if risk_focus_on_gate "$rgf_f" "$2"; then printf '%s\n' "$rgf_f"; fi; done
}
# A96: a TRIVIAL run has no design phase and no QA gate, so a UI signal (ui_path, ui) is shown but never asks
# for the `ui` flag, a `## UI` section or a designer (A36: a copy edit in a UI file is TRIVIAL text).
risk_ui_exempt() { # ID SIGNAL -> 0 when the signal is a UI signal of a class without a design phase
  [ "$(cfg "risk.$2.check")" = visual ] && [ "$(pipeline_class "$1")" = TRIVIAL ]
}
# risk_missing_flags ID [FOCUS] -> "name|source|path|flag" for each path signal (of FOCUS) whose flag is not yes.
risk_missing_flags() {
  rmf_plan=$(run_dir "$1")/PLAN.md
  risk_signals "$1" | while IFS='|' read -r rmf_n rmf_src rmf_p _; do
    [ "$rmf_src" != plan ] || continue
    ! risk_ui_exempt "$1" "$rmf_n" || continue
    [ -z "${2:-}" ] || [ "$(cfg "risk.$rmf_n.check")" = "$2" ] || continue
    rmf_fl=$(cfg "risk.$rmf_n.flag"); [ -n "$rmf_fl" ] || continue
    [ "$(plan_flag "$rmf_plan" "$rmf_fl")" != yes ] || continue
    printf '%s|%s|%s|%s\n' "$rmf_n" "$rmf_src" "$rmf_p" "$rmf_fl"
  done
}
# risk_show ID: the signal lines of `pipeline` (A78).
risk_show() {
  rsh_sig=$(risk_signals "$1"); rsh_req=$(required_gates "$1")
  printf 'signals=%s\n' "$(printf '%s\n' "$rsh_sig" | cut -d'|' -f1 | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  for rsh_n in $(printf '%s\n' "$rsh_sig" | cut -d'|' -f1 | sed '/^$/d' | sort -u); do
    rsh_src=$(printf '%s\n' "$rsh_sig" | awk -F'|' -v n="$rsh_n" '$1 == n { s = s (s == "" ? "" : ",") $2 ":" $3 "(" $4 ")" } END { print s }')
    rsh_f=$(cfg "risk.$rsh_n.check"); rsh_g=''
    for rsh_x in $rsh_req; do if risk_focus_on_gate "$rsh_f" "$rsh_x"; then rsh_g=$rsh_x; fi; done
    rsh_fl=$(cfg "risk.$rsh_n.flag"); [ -z "$rsh_fl" ] || rsh_fl="$rsh_fl:$(plan_flag "$(run_dir "$1")/PLAN.md" "$rsh_fl")"
    if risk_ui_exempt "$1" "$rsh_n"; then
      printf 'signal.%s=source=%s check=- (class TRIVIAL: no design phase / no QA gate) flag=%s design_role=-\n' "$rsh_n" "$rsh_src" "${rsh_fl:--}"
      continue
    fi
    printf 'signal.%s=source=%s check=%s:%s%s flag=%s design_role=%s\n' "$rsh_n" "$rsh_src" "${rsh_g:--}" "$rsh_f" \
      "$([ -n "$rsh_g" ] || printf ' (no required gate carries it for this class and tier)')" "${rsh_fl:--}" "$(cfg "risk.$rsh_n.design_role" -)"
  done
  risk_missing_flags "$1" | while IFS='|' read -r rsh_n rsh_src rsh_p rsh_fl; do
    printf 'missing_flag.%s=%s:%s needs PLAN.md %s: yes (%s)\n' "$rsh_n" "$rsh_src" "$rsh_p" "$rsh_fl" \
      "$([ "$rsh_src" = diff ] && echo "a blocking finding of focus $(cfg "risk.$rsh_n.check"); the check still runs" || echo "declare it before FREEZE")"
  done
  for rsh_r in architect data_architect designer; do
    rsh_by=$(printf '%s\n' "$rsh_sig" | cut -d'|' -f1 | sed '/^$/d' | sort -u | while IFS= read -r rsh_n; do if [ "$(cfg "risk.$rsh_n.design_role")" = "$rsh_r" ] && ! risk_ui_exempt "$1" "$rsh_n"; then printf '%s ' "$rsh_n"; fi; done)
    [ -z "$rsh_by" ] || printf 'design_role.%s=%s\n' "$rsh_r" "${rsh_by% }"
  done
}
# risk_unsupported ID -> "GATE:focus|severity|finding|evidence" for each UNSUPPORTED finding of a current focus record
# (evidence: the record's `unsupported_evidence` path@sha12, A102, empty for a FAIL's unparsed-file rows)
# (never a PASS): severity info = unproven and reported (A98), blocking = a waiver or a measurement is needed.
risk_unsupported() {
  for ru_g in $(required_gates "$1"); do
    for ru_f in $(risk_gate_focuses "$1" "$ru_g"); do
      ru_r=$(gate_latest_file "$1" "$ru_g" "$ru_f"); [ -n "$ru_r" ] || continue
      ru_e=$(gate_field "$ru_r" unsupported_evidence)
      sed -n 's/^finding: [^|]*|\([a-z]*\)|[^|]*|\(UNSUPPORTED [^|]*\)|.*/\1|\2/p' "$ru_r" | sed "s#^#$ru_g:$ru_f|#; s#\$#|$ru_e#"
    done
  done
}
unsupported_label() { # SEVERITY
  if [ "$1" = info ]; then echo 'UNSUPPORTED (unproven, reported)'; else echo 'UNSUPPORTED (blocking: a waiver or a measurement is needed)'; fi
}

# --- Gates (D14): SECRETS, REVIEW_SMALL, REVIEW_PLAN, REVIEW_RULES, REVIEW_TESTS, REVIEW_DATA, SECURITY, QA, VERIFY.
required_gates() { # ID [TIER]
  pipeline_declared "$1" && pipeline_class_valid "$(pipeline_class "$1")" || return 0
  rg_tier=${2:-$(tier_effective "$1")}
  echo SECRETS
  case "$rg_tier" in
    small) echo REVIEW_SMALL ;;
    full) echo REVIEW_PLAN; echo REVIEW_RULES; echo REVIEW_TESTS
      # A78: a migration signal needs REVIEW_DATA even when PLAN.md has no `## Data` (the missing flag is a finding there).
      if { [ -f "$(run_dir "$1")/PLAN.md" ] && plan_section_present "$(run_dir "$1")/PLAN.md" Data; } || [ -n "$(risk_gate_focuses "$1" REVIEW_DATA)" ]; then echo REVIEW_DATA; fi
      echo SECURITY ;;
  esac
  if [ "$(pipeline_needs "$1" qa)" = yes ]; then echo QA; fi
  echo VERIFY
}
gate_owner() { case "$1" in REVIEW_*) echo reviewer ;; SECURITY) echo security_reviewer ;; QA) echo qa ;; VERIFY) echo verifier ;; SECRETS) echo secret-scan ;; esac; }
gate_focus() { case "$1" in REVIEW_SMALL) echo rules+tests ;; REVIEW_PLAN) echo plan ;; REVIEW_RULES) echo rules ;; REVIEW_TESTS) echo tests ;; REVIEW_DATA) echo data ;; esac; }
# A171: the build record (A148) is made before the review gate wave, not left to the first reviewer dispatch.
# build_record_missing ID: 0 when build/test are configured and the current tree has no finished record.
build_record_missing() {
  [ -n "$(cfg_cmds commands.build)$(cfg_cmds commands.test)" ] || return 1
  [ -f "$scripts/build-record.sh" ] || return 1
  sh "$scripts/build-record.sh" show >/dev/null 2>&1; [ $? -eq 3 ]
}
# A200: a build record that cannot be made is the lead's missing step, not an information note for the reviewers. 0 and the
# reason on stdout when the tree has no record and none can be made (commands.build and commands.test are both empty).
build_record_unmakeable() { # ID
  [ -z "$(cfg_cmds commands.build)$(cfg_cmds commands.test)" ] || return 1
  echo "commands.build and commands.test are empty, so no build record can be made for this tree and the reviewers and the verifier have none to read"
}
build_record_step_text() { printf 'proofline doctor --commands   (finds the commands, proves each by one run and asks the user ONE question; the user'"'"'s yes writes only the proven ones; then agent.sh build-record %s run). If the user declines, say in the completion report that no build or test was recorded\n' "$1"; }
# A171: gate dependencies, written in GATES.md "Gate dependencies". A gate that needs the output of another gate
# (VERIFY reads the visual evidence report that the QA visual focus produces) is offered by `next` and accepted by
# `decide` and `record` only when that dependency is satisfied for the current content.
gate_deps() { # ID GATE -> "GATE:focus" lines that must be satisfied before GATE runs
  case "$2" in
    VERIFY)
      required_gates "$1" | grep -Fxq QA || return 0
      risk_gate_focuses "$1" QA | grep -Fxq visual && echo QA:visual ;;
  esac
  return 0
}
gate_deps_unmet() { # ID GATE [NOW] -> the dependencies not satisfied for the current content, one per line
  gdu_now=${3:-$(gate_fingerprint)}
  for gdu_d in $(gate_deps "$1" "$2"); do
    gate_satisfied "$(gate_focus_status "$1" "${gdu_d%%:*}" "${gdu_d#*:}" reuse "$gdu_now")" || echo "$gdu_d"
  done
  return 0
}
gate_of() { # ROLE [FOCUS] [ID]: a rules-gate risk focus (A78) lands on REVIEW_SMALL when the run's tier is small
  case "$1:${2:-}" in
    reviewer:plan) echo REVIEW_PLAN ;; reviewer:rules) echo REVIEW_RULES ;; reviewer:tests) echo REVIEW_TESTS ;;
    reviewer:data|reviewer:migration) echo REVIEW_DATA ;; reviewer:rules+tests) echo REVIEW_SMALL ;;
    reviewer:contract|reviewer:concurrency|reviewer:performance|reviewer:config)
      if [ -n "${3:-}" ] && required_gates "$3" | grep -Fxq REVIEW_SMALL; then echo REVIEW_SMALL; else echo REVIEW_RULES; fi ;;
    security_reviewer:*) echo SECURITY ;; qa:*) echo QA ;; verifier:*) echo VERIFY ;; *) return 1 ;;
  esac
}

# A172: identity of the ids the control plane writes and reads (QA-n, AC-n, AS-n, finding ids <GATE>-<n> / <role id>-<n>).
# The form the producer wrote is canonical and is never rewritten; every check compares by KEY: case-insensitive, leading
# zeros of the number ignored. One place decides it, so a producer and its checker cannot disagree again (the QA plan step
# was submitted as QA-1 and recorded as qa-1). The node validators carry the same idKey (skills share no files).
id_key() { printf '%s\n' "$1" | tr '[:lower:]' '[:upper:]' | sed -E 's/-0+([0-9])/-\1/g'; }
id_eq() { [ "$(id_key "$1")" = "$(id_key "$2")" ]; }
# id_keys: stdin ids -> keys (for sort/comm/uniq over a list)
id_keys() { tr '[:lower:]' '[:upper:]' | sed -E 's/-0+([0-9])/-\1/g'; }

# A200: the answer to a batch pre-flight question (batch.sh answer: the user's own captured message, parsed by the script),
# valid only while the batch approval of the summary that asked it stands. Prints `letter<TAB>param<TAB>question` of the
# newest answer for the task and kind; nothing when there is none, when the batch is not approved or a new summary replaced it.
batch_answer_row() { # ID KIND
  [ -f "$(batch_dir)/answers.tsv" ] || return 0
  batch_approval >/dev/null 2>&1 || return 0
  bar_b=$(hash_file "$(batch_dir)/SUMMARY.md" | cut -c1-12)
  awk -F'\t' -v b="$bar_b" -v t="$1" -v k="$2" '$1 == b && $2 == t && $4 == k { r = $5 "\t" $6 "\t" $3 } END { if (r != "") print r }' "$(batch_dir)/answers.tsv"
}

# A200: the scope bound counts code paths. A content or document path (is_doc_path) is not a reason to split (forty content
# files with the same correction are one piece of work), but a path that holds code (review.executable_code) is always counted,
# whatever folder or suffix list it sits in. Every scope path stays in scope, is hashed in the plan and is reviewed as before.
path_kind() { # PATH -> content | code
  if [ -n "$(printf '%s\n' "$1" | paths_executable)" ]; then echo code
  elif is_doc_path "$1"; then echo content
  else echo code; fi
}

# A202: the scope table's optional `kind:` column (code | test | content | doc) is a claim, never an input. The script derives the kind of
# every path itself (a test path by test_code_path, a content or document path by path_kind, everything else code) and a claim that
# differs from it, or that is not one of the four words, is ignored: the path counts as code in the scope bound and in the selective
# gate re-run. Only a claim that makes the path stricter (code where it derived test) is honoured. A PLAN without the column is derived.
plan_kind_claims() { # PLAN -> "path|kind" for each scope entry that has a `kind:` line
  awk '
    /^scope:$/ { inside=1; next } inside && /^---$/ { exit }
    inside && /^  - path: / { path=$0; sub(/^  - path: /, "", path); next }
    inside && /^    kind: / { k=$0; sub(/^    kind: /, "", k); gsub(/["\047 ]/, "", k); print path "|" k }
  ' "$1"
}
derived_kind() { # PATH -> code | test | content
  if test_code_path "$1"; then echo test; else path_kind "$1"; fi
}
effective_kind() { # PATH CLAIM -> code | test | content: the derived kind when the claim is absent or equal to it (doc = content), else code
  ek_d=$(derived_kind "$1"); ek_c=$2
  [ "$ek_c" != doc ] || ek_c=content
  if [ -z "$ek_c" ] || [ "$ek_c" = "$ek_d" ]; then echo "$ek_d"; else echo code; fi
}
scope_kind_rows() { # PLAN -> path<TAB>claimed<TAB>derived<TAB>effective<TAB>exempt(yes|no) per scope path
  skr_cl=$(plan_kind_claims "$1")
  for skr_p in $(scope_mappings "$1" 2>/dev/null | cut -d '|' -f1); do
    skr_c=$(printf '%s\n' "$skr_cl" | grep -F -- "$skr_p|" | head -1 | cut -d '|' -f2)
    skr_x=no; [ -z "$(exempted_path "$1" "$skr_p")" ] || skr_x=yes
    printf '%s\t%s\t%s\t%s\t%s\n' "$skr_p" "${skr_c:--}" "$(derived_kind "$skr_p")" "$(effective_kind "$skr_p" "$skr_c")" "$skr_x"
  done
}
# the claimed kind of one path in the run's PLAN, empty when none
plan_path_claim() { # ID PATH
  plan_kind_claims "$(run_dir "$1")/PLAN.md" 2>/dev/null | grep -F -- "$2|" | head -1 | cut -d '|' -f2
}


# What a run requires: class artifacts, tier and every required gate with its status.
pipeline_show() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  pipeline_declared "$id" || fail "run $id has no pipeline block"
  class=$(pipeline_class "$id"); pipeline_class_valid "$class" || fail "run $id is not classified yet"
  risk_prime "$id"
  if [ "$eco_loaded" != 1 ]; then printf 'warning=%s\n' "$(eco_warning | sed 's/^warning: //')"; fi
  if ps_if=$(inflight_dispatch "$id"); then printf 'in_flight=dispatch.sh %s %s (pid %s): wait for the command to return\n' "$id" "${ps_if% *}" "${ps_if#* }"; fi
  ps_tier=$(tier_effective "$id"); ps_gates=$(required_gates "$id" "$ps_tier" | tr '\n' ' ' | sed 's/ $//')
  ps_art='TASK.md PLAN.md'
  [ "$(pipeline_needs "$id" evidence)" != yes ] || ps_art="$ps_art EVIDENCE.md"
  [ "$(pipeline_needs "$id" qa)" != yes ] || ps_art="$ps_art QA_PLAN.md QA_REPORT.md"
  ps_art="$ps_art VERIFY.md COMPLETION_REPORT.md"
  ps_round=$(fix_rounds_used "$id")
  printf 'classification=%s\nreview=%s\nevidence=%s\nqa_plan=%s\narchitect=%s\nmax_explorers=%s\nautonomy=%s\ntier=%s\nartifacts=%s\nfix_round=%s\nmax_fix_rounds=%s\nescalation=%s\ngates=%s\n' \
    "$class" "$(pipeline_review "$id")" "$(pipeline_needs "$id" evidence)" "$(pipeline_needs "$id" qa)" "$(pipeline_needs "$id" architect)" \
    "$(pipeline_value "$class" max_explorers)" "$(run_autonomy "$id")" "$ps_tier" "$ps_art" "$ps_round" "$(max_fix_rounds)" \
    "$( [ "$ps_round" -ge 2 ] && echo yes || echo no )" "$ps_gates"
  ps_fp=$(gate_fingerprint)
  for ps_g in $ps_gates; do
    printf 'gate.%s=%s\n' "$ps_g" "$(gate_status "$id" "$ps_g" reuse "$ps_fp")"
    ps_dn=$(gate_deps "$id" "$ps_g" | tr '\n' ',' | sed 's/,$//'); [ -z "$ps_dn" ] || printf 'gate.%s.needs=%s\n' "$ps_g" "$ps_dn"
    ps_u=$(gate_unsupported_focuses "$id" "$ps_g" reuse "$ps_fp"); [ -z "$ps_u" ] || printf 'gate.%s.unsupported=%s (unproven, reported; the gate is not a full pass)\n' "$ps_g" "$ps_u"
  done
  # A78: risk signals, the focus each one adds to a gate, the per-focus status and the design roles to dispatch.
  for ps_g in $ps_gates; do
    for ps_f in $(risk_gate_focuses "$id" "$ps_g"); do printf 'focus.%s.%s=%s\n' "$ps_g" "$ps_f" "$(gate_focus_status "$id" "$ps_g" "$ps_f" reuse "$ps_fp")"; done
  done
  risk_show "$id"
  validation_show "$id"
  risk_not_rerun "$id" | while IFS= read -r ps_n; do printf 'not_rerun.%s=NOT_RERUN (not reproduced proof): %s\n' "${ps_n%% *}" "${ps_n#* }"; done
  risk_unsupported "$id" | while IFS='|' read -r ps_k ps_v ps_t ps_e; do printf 'unsupported.%s=%s: %s%s\n' "$ps_k" "$(unsupported_label "$ps_v")" "${ps_t#UNSUPPORTED }" "${ps_e:+ (evidence: $ps_e)}"; done
}
# A130 (amends A107): "GATE:focus reason" for each current gate record that re-ran nothing: the `not_rerun` field, or
# the info row `NOT_RERUN:` that records of older versions carry. Not reproduced proof; never a finding.
risk_not_rerun() {
  for rn_g in $(required_gates "$1"); do
    for rn_fc in - $(risk_gate_focuses "$1" "$rn_g"); do
      rn_f=$(gate_latest_file "$1" "$rn_g" "$rn_fc"); [ -n "$rn_f" ] || continue
      rn_v=$(gate_field "$rn_f" not_rerun)
      [ -n "$rn_v" ] || rn_v=$(sed -n 's/^finding: [^|]*|info|[^|]*|NOT_RERUN: \([^|]*\)|.*/\1/p' "$rn_f" | head -1)
      [ -z "$rn_v" ] || printf '%s\n' "$rn_v"
    done
  done
}

freeze_hash_present() {
  awk '/^freeze:$/ { inside=1; next } inside && /^[^[:space:]]/ { exit } inside && /^[[:space:]]*(task|evidence|plan|policy)_sha256: "[0-9a-f][0-9a-f]/ { found=1 } END { exit !found }' "$1/RUN.yaml"
}
verify_freeze() {
  id=$1; require_run "$id"; dir=$(run_dir "$id"); run=$dir/RUN.yaml; [ -f "$run" ] || fail "RUN.yaml missing"
  mode=$(section_value "$dir" execution mode); case "$mode" in ''|PENDING) mode=$(cfg default_mode deterministic) ;; esac
  [ -f "$agents/modes/$mode.yaml" ] || fail "mode policy missing"
  for pair in "task TASK.md yes" "evidence EVIDENCE.md $(pipeline_needs "$id" evidence)" "plan PLAN.md yes" "qa_plan QA_PLAN.md $(pipeline_needs "$id" qa)"; do
    vf_k=${pair%% *} vf_rest=${pair#* }; vf_file=${vf_rest% *} vf_req=${vf_rest#* }
    stored=$(section_value "$dir" freeze "${vf_k}_sha256")
    if [ "$vf_req" = yes ]; then actual=$(hash_file "$dir/$vf_file"); else actual=not_required; [ -n "$stored" ] || continue; [ ! -e "$dir/$vf_file" ] || fail "$vf_file is not part of this run's pipeline; remove it"; fi
    [ -n "$stored" ] && [ "$stored" = "$actual" ] || fail "freeze mismatch: $vf_k"
  done
  if gates_enforced "$id"; then
    [ "$(section_value "$dir" freeze pipeline)" = "$(pipeline_signature "$id")" ] || fail "freeze mismatch: pipeline (the classification changed or was removed after freeze; an amendment and refreeze are required)"
  fi
  # A78: the risk signal mapping (config `risk:`) is frozen with the plan; it never changes under a frozen run.
  # A92: fail closed when the key is missing (a RUN.yaml from before A78): a refreeze inserts it.
  section_key_present "$dir" freeze risk_sha256 || fail "freeze mismatch: risk (RUN.yaml has no freeze.risk_sha256, so the risk mapping is unbound; record an amendment and refreeze to bind it)"
  vf_rh=$(section_value "$dir" freeze risk_sha256)
  risk_freeze_ok "$vf_rh" || fail "freeze mismatch: risk (the risk:, performance:, security: or contract: block of .agents/config.yaml changed after freeze; restore it, or record an amendment and refreeze)"
  stored=$(section_value "$dir" freeze policy_sha256); actual=$(hash_file "$agents/modes/$mode.yaml")
  [ -n "$stored" ] && [ "$stored" = "$actual" ] || fail "freeze mismatch: policy"
  echo "freeze verified: $id"
}
scope_mappings() {
  awk '
    /^scope:$/ { inside=1; next } inside && /^---$/ { exit }
    inside && /^  - path: / { if (path != "") bad=1; path=$0; sub(/^  - path: /, "", path); next }
    inside && /^    criteria: \[/ { c=$0; sub(/^    criteria: \[/, "", c); sub(/\]$/, "", c); if (path == "" || c == "") bad=1; else print path "|" c; path="" }
    END { if (bad || path != "") exit 1 }
  ' "$1"
}
# A101: the one scope-mapping check, shared by freeze and handoff IMPLEMENTING; nothing is recorded before it passes.
require_scope_mapping() { # ID
  rsm_m=$(scope_mappings "$(run_dir "$1")/PLAN.md") && [ -n "$rsm_m" ] || fail "invalid scope mapping: fix PLAN.md ## Scope entries: each entry needs \`path\` and \`criteria:\` (a non-empty flow list such as [AC-1]); run the plan-contract validator (skills/plan-contract/scripts/validate-plan.mjs)"
}
authorized_path() { printf '%s\n' "$1" | cut -d '|' -f1 | grep -Fxq -- "$2"; }

# A202: optional task sections the user writes into TASK.md: `Allowed scope`, `Forbidden scope`, `Existing pattern references`
# and `Completion response`. A section is a `##` (or an imported `###`) heading; HTML comments inside it are dropped. The run's
# copy of TASK.md is sealed at the freeze (and compared with the task file before it), so an agent cannot edit a boundary. An entry is a bullet of paths (every
# backticked token, else every word; commas split): a file, a folder (a parent of the plan path) or a glob. What cannot be read as one refuses the freeze.
task_section_lines() { # FILE HEADING [prefix] -> the section's lines without HTML comments; nothing when it is absent. `prefix`: a heading with trailing text ("Forbidden scope (do not touch)") is the section too
  [ -f "$1" ] || return 0
  awk -v h="$2" -v pre="${3:-}" '
    function strip(s,   o, p) { o = ""
      while (1) {
        if (inc) { p = index(s, "-->"); if (!p) return o; s = substr(s, p + 3); inc = 0 }
        else { p = index(s, "<!--"); if (!p) return o s; o = o substr(s, 1, p - 1); s = substr(s, p + 4); inc = 1 } } }
    BEGIN { want = tolower(h) }
    { s = strip($0)
      if (s ~ /^#+[ \t]/) { t = s; sub(/^#+[ \t]+/, "", t); sub(/[ \t\r]+$/, "", t); lt = tolower(t); on = (s ~ /^###?[ \t]/ && (lt == want || (pre != "" && index(lt, want) == 1 && substr(lt, length(want) + 1, 1) !~ /[a-z0-9]/))); next }
      if (on) print s }' "$1"
}
# task_scope_parse MODE FILE HEADING: every entry of a scope section, one per line. MODE ok: the entries; MODE bad: what could not be read
# as an entry (a token that is no path or glob, or a line that is no bullet), so the freeze can refuse instead of dropping it. A bullet with
# backticks gives each backticked token (commas split), without backticks every word (commas and spaces split) and each word must look
# like a path: it has a / or a glob character or a dotted name. `none` is no entry.
task_scope_parse() {
  task_section_lines "$2" "$3" prefix | awk -v mode="$1" '
    function emit(t, ticked) {
      gsub(/^[ \t]+|[ \t]+$/, "", t); sub(/[,;:]+$/, "", t)
      if (t == "") return
      if (t ~ badre || t ~ /^[.\/]+$/ || (!ticked && t !~ pathre)) { if (mode == "bad") print t; return }
      sub(/^\.\//, "", t); sub(/^\//, "", t); if (mode == "ok") print t }
    BEGIN { badre = "[ \t()<>|;{}\"\047$&\\\\]"; pathre = "[][/*?]|\\.[A-Za-z0-9]" }
    { gsub(/\r/, "") }
    /^[ \t]*$/ { next }
    /^[ \t]*([-*]|[0-9]+[.)])[ \t]+/ { l = $0; sub(/^[ \t]*([-*]|[0-9]+[.)])[ \t]+/, "", l)
      low = tolower(l); gsub(/^[ \t]+|[ \t]+$/, "", low); if (low == "none") next
      if (index(l, "`")) { rest = l
        while (match(rest, /`[^`]*`/)) { tk = substr(rest, RSTART + 1, RLENGTH - 2); rest = substr(rest, RSTART + RLENGTH); n = split(tk, P, ","); for (i = 1; i <= n; i++) emit(P[i], 1) } }
      else { n = split(l, P, /[ \t,]+/); for (i = 1; i <= n; i++) emit(P[i], 0) }
      next }
    { low = tolower($0); gsub(/^[ \t]+|[ \t]+$/, "", low); if (low == "none") next; if (mode == "bad") print substr($0, 1, 60) }'
}
task_scope_entries() { # FILE HEADING -> one path, folder or glob per line
  task_scope_parse ok "$1" "$2"
}
norm_rel_path() { # PATH -> the path without ./ segments, doubled or leading or trailing slashes, and with .. resolved lexically
  printf '%s\n' "$1" | awk '{ n = split($0, a, "/"); m = 0
    for (i = 1; i <= n; i++) { if (a[i] == "" || a[i] == ".") continue; if (a[i] == "..") { if (m > 0) m--; continue }; s[++m] = a[i] }
    o = ""; for (i = 1; i <= m; i++) o = o (i > 1 ? "/" : "") s[i]; print o }'
}
scope_entry_covers() { # ENTRY PATH [fold]: the entry is the path, a folder above it, or a glob that matches it; both are normalised
  # (./, //, .. and a trailing slash cannot walk around an entry); `fold` also ignores case (Forbidden scope and known issues: a case-insensitive
  # file system must not let IMPL.TXT slip past impl.txt; refusing more is the safe side there)
  sc_e=$(norm_rel_path "$1") sc_p=$(norm_rel_path "$2")
  if [ "${3:-}" = fold ]; then sc_e=$(printf '%s' "$sc_e" | tr '[:upper:]' '[:lower:]'); sc_p=$(printf '%s' "$sc_p" | tr '[:upper:]' '[:lower:]'); fi
  [ -n "$sc_e" ] || return 1
  # shellcheck disable=SC2254 # the glob is the point: the entry is a pattern the user wrote
  case "$sc_e" in *'*'*|*'?'*|*'['*) case "$sc_p" in $sc_e) return 0 ;; esac; return 1 ;; esac
  [ "$sc_p" != "$sc_e" ] || return 0
  case "$sc_p" in "$sc_e"/*) return 0 ;; esac
  return 1
}

# Approvals a freeze needs (D3): plan (supervised),
# scope (a refreeze that adds scope paths). Prints the approval files to consume, one per line.
# A60: a task that lists a pre-existing defect with `decision: fix` changes behaviour nobody asked for: the freeze
# needs the user's `scope` approval for the plan (the same kind an amendment adding paths needs). A defect with
# `decision: report` is a finding, never a change. TASK.md `## Pre-existing defects`: `- <path:symbol>: <what> --
# decision: report | fix`.
task_defect_fixes() { # TASK.md -> the lines that say `decision: fix`
  awk '/^##[#]?[[:space:]]+[Pp]re-existing defects[[:space:]]*$/ { i = 1; next } /^#/ { i = 0 } i && tolower($0) ~ /decision:[[:space:]]*fix/ { print }' "$1" 2>/dev/null
}
# A105 (amends A60): a COMPLEX or CRITICAL task whose request (title, Goal, `>` quotes, Suggested class line) names
# no defect, but whose Context, Acceptance criteria, Constraints or Risks speak of a defect or a fix, declares it
# under `## Pre-existing defects` (a `###` heading counts): otherwise a defect fix folded into the task (an answer
# such as "use your recommended option" turned into a criterion) would reach the plan as requested work. Every
# entry carries `decision: report | fix`. The task-author validator applies the same rule. Prints the errors.
# The one list of defect and fix words of a task's own sections (A105, A122): English words and Turkish stems.
defect_sec_re='defects?|bugs?|regression|fix|fixes|fixing'
defect_sec_tr='kusur|düzelt'
task_defect_errors() { # ID
  te_f=$(run_dir "$1")/TASK.md; [ -f "$te_f" ] || return 0
  te_big=0; case "$(pipeline_class "$1")" in COMPLEX|CRITICAL) te_big=1 ;; esac
  awk -v big="$te_big" -v sre="$defect_sec_re" -v str="$defect_sec_tr" '
    function w(s, re) { return (" " s " ") ~ ("[^a-z](" re ")[^a-z]") }
    /<!--/ { c = 1 } c { if (/-->/) c = 0; next }
    NR == 1 && /^# Task:/ { req = req " " tolower($0); next }
    /^##[#]?[[:space:]]/ { h = $0; sub(/^#+[[:space:]]+/, "", h); sub(/[[:space:]]+$/, "", h); d = (tolower(h) == "pre-existing defects")
      if ($0 ~ /^## /) sec = h; next }
    d && /^[[:space:]]*[-*][[:space:]]+[^[:space:]]/ { n++; if (tolower($0) !~ /decision:[[:space:]]*(report|fix)([^a-z]|$)/) { e = $0; sub(/^[[:space:]]*[-*][[:space:]]+/, "", e); print "entry without decision: report|fix: " e } ; next }
    d { next }
    /^[[:space:]]*>/ || sec == "Goal" || sec == "Suggested class" { req = req " " tolower($0); next }
    (sec == "Context" || sec == "Acceptance criteria" || sec == "Constraints" || sec == "Risks") && m == "" {
      l = tolower($0); if (w(l, sre) || l ~ str) { m = $0; sub(/^[[:space:]]*[-*][[:space:]]+/, "", m) } }
    END {
      if (!big || m == "" || n > 0) exit
      if (w(req, "bugs?|defects?|regression|broken|fix|fixes|fixed|wrong|incorrect|crash(es)?|disappears?|disappeared|unreachable") || req ~ /hata|bozuk|kaybol|yanlış|düzelt/) exit
      sub(/[.]$/, "", m); print "mentions a defect or a fix the request does not ask for: " substr(m, 1, 120)
    }' "$te_f"
}

# --- Task-source contract (projection hash; see WORKFLOW.md "Task-source contract") --
local_task_source_run() { [ "$(section_value "$(run_dir "$1")" task_source type)" = local_markdown ]; }
# The keys of the status block (A202): ONE list, used by the block generator (sbb_kv refuses any other key), by the contract-hash exclusion and by the
# block-only test of a task file (sb_strip), so they cannot drift apart.
SB_KEYS='run type class stage event updated branch start_commit runtime session question answer park failure pr ci delivered_commit estimate duration tokens look_at known_issues'
task_source_contract_hash() {
  awk -v id="$1" -v keys="$SB_KEYS" '
    { line[NR] = $0 }
    END {
      begin = "<!-- COMPLETION-REPORT:BEGIN:" id " -->"; endm = "<!-- COMPLETION-REPORT:END:" id " -->"
      # A202: the status block (the live status the control plane regenerates wholesale at each update) is excluded the same way, but only
      # while every line inside it is a `- <allowed key>: value` line or blank; any other line (free text, a heading, a criterion) stays hashed,
      # so nothing can be smuggled into the contract through the marked block.
      sbegin = "<!-- PROOFLINE-STATUS:BEGIN:" id " -->"; send = "<!-- PROOFLINE-STATUS:END:" id " -->"
      alt = keys; gsub(/ /, "|", alt); skeys = "^- (" alt "): "
      n = 0; stripped = 0; sstripped = 0
      for (i = 1; i <= NR; i++) {
        if (!sstripped && line[i] == "## Proofline Status") {
          j = i + 1
          while (j <= NR && line[j] ~ /^[[:space:]]*$/) j++
          if (j <= NR && line[j] == sbegin) {
            for (k = j + 1; k <= NR && line[k] != send; k++) { }
            if (k <= NR) {
              for (m = j + 1; m < k; m++) if (line[m] !~ /^[[:space:]]*$/ && line[m] !~ skeys) kept[++n] = line[m]
              i = k; sstripped = 1; continue
            }
          }
        }
        if (!stripped && line[i] == "## Completion Report") {
          j = i + 1
          while (j <= NR && line[j] ~ /^[[:space:]]*$/) j++
          if (j <= NR && line[j] == begin) {
            for (k = j + 1; k <= NR && line[k] != endm; k++) { }
            if (k <= NR) { i = k; stripped = 1; continue }
          }
        }
        out = line[i]
        if (out ~ /^\*\*Status:\*\*/) out = "**Status:**"
        kept[++n] = out
      }
      while (n > 0 && kept[n] ~ /^[[:space:]]*$/) n--
      for (i = 1; i <= n; i++) print kept[i]
    }
  ' "$2" | sha256
}
lifecycle_folder_status() {
  case "$(basename "$(dirname "$1")")" in
    backlog) echo backlog ;; todo) echo todo ;; in-progress) echo in-progress ;; "done") echo "done" ;;
  esac
}
declared_task_status() { sed -n 's/^\*\*Status:\*\*[[:space:]]*//p' "$1" | head -1 | sed 's/[[:space:]]*$//'; }
verify_task_source_status() {
  id=$1; dir=$(run_dir "$id"); local_task_source_run "$id" || return 0
  path=$(section_value "$dir" task_source path); want=$(lifecycle_folder_status "$path")
  [ -n "$want" ] && [ -f "$root/$path" ] || return 0
  have=$(declared_task_status "$root/$path"); [ -n "$have" ] || return 0
  [ "$have" = "$want" ] || fail "task source status mismatch: $path is under $want/ but declares **Status:** $have; run 'agent.sh task-source-status $id' (the Status value is bookkeeping and needs no re-baseline)"
}
task_source_bookkeeping_only() {
  id=$1 path=$2; dir=$(run_dir "$id"); local_task_source_run "$id" || return 1
  [ "$path" = "$(section_value "$dir" task_source path)" ] || return 1
  revision=$(section_value "$dir" task_source revision); case "$revision" in ''|PENDING|not_applicable) return 1 ;; esac
  [ -f "$root/$path" ] && [ ! -L "$root/$path" ] || return 1
  [ "$revision" = "$(task_source_contract_hash "$id" "$root/$path")" ]
}
local_task_source() {
  dir=$1 path=$(section_value "$1" task_source path)
  case "$path" in ''|/*|*'..'*|*'//'*) fail "invalid local Markdown task source path";; esac
  source=$root/$path
  [ ! -L "$source" ] || fail "task source must not be a symlink: $path"
  [ -f "$source" ] || fail "task source missing or non-regular: $path (if the task file was moved, record it with 'agent.sh task-source-relocate $(basename "$dir") <NEW-PATH>')"
  printf '%s\n' "$source"
}
verify_freshness() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  verify_freeze "$id"
  base=$(repository_base_sha "$dir"); head=$(git -C "$root" rev-parse HEAD)
  if [ "$base" != "$head" ] && ! { [ "$ctp_base" = "$base" ] && git -C "$root" merge-base --is-ancestor "$base" HEAD; }; then
    # A155: a commit of control-plane files only (an upgrade, a refreshed agent file or proofline block) is not a plan change
    if base_moved_control_only "$base"; then
      bm_line="base_sha moved ($base -> $head): the commits between touch control-plane files only; the plan stays fresh"
      echo "$bm_line"
      # once per accepted move: the ledger line is the record
      base_moved_lines "$id" | grep -qF "detail=$bm_line" || ledger_if "$id" base-moved - - "$bm_line"
      # A156: later diffs start at the new base; the old value stays in the ledger line above. Nothing frozen or sealed hashes base_sha.
      set_run_value "$id" repository base_sha "$head"
    elif base_moved_control_only "$base" own; then
      # A169: the run's own task file move and knowledge documents are no product change; base_sha stays (those documents are read from it)
      bm_line="base_sha is at $base, HEAD is $head: the commits between touch control-plane files, this run's task file and knowledge documents only; the plan stays fresh"
      echo "$bm_line"
      grep -qF "detail=$bm_line" "$(ledger_file "$id")" 2>/dev/null || ledger_if "$id" base-moved - - "$bm_line"
    else
      fail "stale plan: repository.base_sha changed ($base -> $head); amendment and refreeze required. Changed outside the control plane: $(base_moved_offenders "$base"). Amend and refreeze the plan to include them, or revert them; text in AGENTS.md or CLAUDE.md besides the proofline block is project rules every agent reads, so it counts as a product change (A161)"
    fi
  fi
  type=$(section_value "$dir" task_source type); revision=$(section_value "$dir" task_source revision)
  case "$type:$revision" in
    local_markdown:*)
      source=$(local_task_source "$dir") || return 1
      verify_task_source_status "$id"
      [ "$revision" = "$(task_source_contract_hash "$id" "$source")" ] || fail "stale plan: the frozen task contract changed (the Status value and the published completion-report block are bookkeeping and excluded; nothing else may change); amendment and refreeze required" ;;
    none:not_applicable) : ;;
    *) fail "task source revision unavailable or unsupported; amendment or adapter required" ;;
  esac
  echo "planning freshness verified: $id"
}

# --- Design surfaces ------------------------------------------------------------------
# design_docs.design is a path (one document) or a mapping (surfaces); both forms are read here and nowhere else:
#   design_docs:
#     design:
#       shared: docs/design/BASE.md                 (optional common base document)
#       surfaces:
#         site:                                     (name: letters, digits, - and _)
#           doc: docs/design/SITE.md
#           paths: apps/web/** apps/landing/**      (space-separated globs)
#           mode: persuade                          (the visitor mode: persuade, operate, ...)
# Glob: `*` and `**` match any characters including `/`, `**/` also zero directories, `?` one character, `[..]` a class; an entry ending in `/` is a directory prefix.
# `\` and `|` are refused in paths by config-check (the shell would read them as an escape and an alternation).
design_surface_names() { # the surface names in config order
  printf '%s\n' "$cfg_cache" | awk 'index($0, "design_docs.design.surfaces.") == 1 { r = substr($0, 29); n = index(r, "."); if (n > 1) { s = substr(r, 1, n - 1); if (!(s in q)) { q[s] = 1; print s } } }'
}
design_glob_one() { # PATH GLOB: `**/` also matches zero directories (git style), so apps/**/x.ts matches apps/x.ts
  # shellcheck disable=SC2254 # the glob from the config is the pattern
  case "$1" in $2) return 0 ;; esac
  case "$2" in *'**/'*) design_glob_one "$1" "${2%%'**/'*}${2#*'**/'}" ;; *) return 1 ;; esac
}
design_glob_match() { # PATH GLOBS: exit 0 when PATH matches one of the space-separated globs (read without pathname expansion)
  dg_rest=$2
  while :; do
    dg_rest=${dg_rest#"${dg_rest%%[! ]*}"}; [ -n "$dg_rest" ] || return 1
    dg_g=${dg_rest%% *}; dg_rest=${dg_rest#"$dg_g"}; dg_g=${dg_g#./}
    case "$dg_g" in */) dg_g="$dg_g*" ;; esac
    ! design_glob_one "$1" "$dg_g" || return 0
  done
}
# is_doc_path PATH (A197): a documentation path, which has no RED/GREEN evidence: under a design document of the config, the knowledge scope,
# or an entry of verification.doc_paths (default: docs/ and the *.md, *.mdx, *.rst and *.adoc suffixes; a directory entry ends in /).
is_doc_path() {
  in_knowledge_scope "$1" && return 0
  for ip_e in $(cfg verification.doc_paths 'docs/ *.md *.mdx *.rst *.adoc'); do
    case "$ip_e" in
      */) case "$1" in "$ip_e"*) return 0 ;; esac ;;
      '*.'*) case "$1" in *"${ip_e#\*}") return 0 ;; esac ;;
      *) [ "$1" != "$ip_e" ] || return 0 ;;
    esac
  done
  return 1
}
design_doc_paths() { # every design document of the config, one per line (the knowledge step may write all of them)
  for dp_k in architecture data_model api; do dp_v=$(cfg "design_docs.$dp_k" ""); [ -z "$dp_v" ] || printf '%s\n' "$dp_v"; done
  dp_n=$(design_surface_names)
  if [ -z "$dp_n" ]; then dp_v=$(cfg design_docs.design ""); [ -z "$dp_v" ] || printf '%s\n' "$dp_v"; return 0; fi
  dp_v=$(cfg design_docs.design.shared ""); [ -z "$dp_v" ] || printf '%s\n' "$dp_v"
  for dp_s in $dp_n; do dp_v=$(cfg "design_docs.design.surfaces.$dp_s.doc" ""); [ -z "$dp_v" ] || printf '%s\n' "$dp_v"; done
}
# design_surface <REL-PATH>: the design documents that apply to a file, as key=value lines (read-only).
#   mode=single|surfaces  status=ok|new-direction|no-surface|overlap  surface=<name|->  visitor_mode=<mode|->
#   doc=<document of the surface, or the one document|->  doc_exists=yes|no  shared=<shared document|->  shared_exists=yes|no
# new-direction: the surface matched but its document does not exist yet: design it as a new direction on the shared base, never
# conform it to another surface. no-surface: only the shared document applies (a warning when there is none). overlap: exit 1.
design_surface() {
  ds_f=${1#./}; ds_n=$(design_surface_names)
  if [ -z "$ds_n" ]; then
    ds_d=$(cfg design_docs.design docs/design/DESIGN.md); ds_e=no; [ ! -f "$root/$ds_d" ] || ds_e=yes
    printf 'mode=single\nstatus=ok\nsurface=-\nvisitor_mode=-\ndoc=%s\ndoc_exists=%s\nshared=-\nshared_exists=no\n' "$ds_d" "$ds_e"; return 0
  fi
  ds_sh=$(cfg design_docs.design.shared ""); ds_she=no; [ -z "$ds_sh" ] || [ ! -f "$root/$ds_sh" ] || ds_she=yes
  ds_hits=''; ds_c=0
  for ds_s in $ds_n; do
    if design_glob_match "$ds_f" "$(cfg "design_docs.design.surfaces.$ds_s.paths" "")"; then ds_hits="$ds_hits $ds_s"; ds_c=$((ds_c + 1)); fi
  done
  if [ "$ds_c" -gt 1 ]; then
    printf 'mode=surfaces\nstatus=overlap\nsurface=-\nsurfaces=%s\n' "${ds_hits# }"
    echo "design-surface: $ds_f matches more than one surface (${ds_hits# }): narrow the paths of design_docs.design.surfaces in .agents/config.yaml" >&2; return 1
  fi
  if [ "$ds_c" = 0 ]; then
    printf 'mode=surfaces\nstatus=no-surface\nsurface=-\nvisitor_mode=-\ndoc=-\ndoc_exists=no\nshared=%s\nshared_exists=%s\n' "${ds_sh:--}" "$ds_she"
    [ -n "$ds_sh" ] || echo "warning: no design surface matches $ds_f and design_docs.design.shared is not set: no design document applies to it" >&2
    return 0
  fi
  ds_s=${ds_hits# }; ds_d=$(cfg "design_docs.design.surfaces.$ds_s.doc" ""); ds_e=no; [ -z "$ds_d" ] || [ ! -f "$root/$ds_d" ] || ds_e=yes
  ds_st=ok; [ "$ds_e" = yes ] || ds_st="new-direction"
  printf 'mode=surfaces\nstatus=%s\nsurface=%s\nvisitor_mode=%s\ndoc=%s\ndoc_exists=%s\nshared=%s\nshared_exists=%s\n' "$ds_st" "$ds_s" "$(cfg "design_docs.design.surfaces.$ds_s.mode" "-")" "${ds_d:--}" "$ds_e" "${ds_sh:--}" "$ds_she"
}

# --- Scope ---------------------------------------------------------------------------
# Knowledge scope (Transaction B): space-separated entries of knowledge_scope_root; an entry ending in /
# is a directory prefix, any other entry an exact path. A plan-scoped path stays application scope.
# The configured design documents (design_docs.*) belong to it too (A159); an installed project without the key gets the default roots.
knowledge_scope_entries() { # the knowledge_scope_root entries plus the configured design documents (dir entries end in /)
  ks_r=$(cfg knowledge_scope_root 'docs/design/ docs/adr/ docs/wiki/ docs/product/')
  for ks_p in $(design_doc_paths); do ks_r="$ks_r $ks_p"; done
  ks_p=$(cfg design_docs.adr_dir ""); [ -z "$ks_p" ] || ks_r="$ks_r ${ks_p%/}/"
  printf '%s\n' "$ks_r"
}
in_knowledge_scope() {
  ks_r=$(knowledge_scope_entries)
  for ks_e in $ks_r; do
    case "$ks_e" in */) case "$1" in "$ks_e"*) return 0 ;; esac ;; *) [ "$1" != "$ks_e" ] || return 0 ;; esac
  done
  return 1
}
task_owned_paths() {
  id=$1; dir=$(run_dir "$id"); mappings=$(scope_mappings "$dir/PLAN.md") || return 1
  for type in tracked untracked; do
    paths=$( [ "$type" = tracked ] && current_tracked_paths || current_untracked_paths )
    printf '%s\n' "$paths" | while IFS= read -r changed; do
      [ -n "$changed" ] || continue; known_control_artifact "$id" "$changed" && continue
      prior=$(baseline_fingerprint "$type" "$changed" "$dir"); current=$(fingerprint_path "$changed")
      [ -n "$prior" ] && [ "$prior" = "$current" ] && continue
      authorized_path "$mappings" "$changed" || continue
      printf '%s\n' "$changed"
    done
  done | sort -u
}
task_patch_fingerprint() {
  id=$1; task_owned_paths "$id" | while IFS= read -r path; do [ -n "$path" ] && printf '%s %s\n' "$path" "$(fingerprint_path "$path")"; done | sha256
}
verify_scope() {
  id=$1 allow_knowledge=${2:-0}; require_run "$id"; dir=$(run_dir "$id"); enforce_task_branch "$id"; require_scope_mapping "$id"; mappings=$(scope_mappings "$dir/PLAN.md")
  # A200: a run reopened by amend/reopen has been through its knowledge step already; the pages that step wrote under the knowledge scope are
  # not task changes outside the fix scope, so the fix round's handoff and gates do not trip on them (any other path outside the scope still does)
  if [ "$allow_knowledge" = 0 ]; then for vs_f in "$(gates_dir "$id")"/*-REOPEN.yaml; do [ -f "$vs_f" ] && allow_knowledge=1; done; fi
  status=$(baseline_status "$dir"); [ "$status" = captured ] || fail "baseline required before scope verification: $id"
  validate_control_artifacts "$id"
  tmp=$(mktemp "${TMPDIR:-/tmp}/agent-scope.XXXXXX"); tmpcp=$tmp.cp
  for type in tracked untracked; do
    paths=$( [ "$type" = tracked ] && current_tracked_paths || current_untracked_paths )
    printf '%s\n' "$paths" | while IFS= read -r changed; do
      [ -n "$changed" ] || continue
      known_control_artifact "$id" "$changed" && continue
      task_source_bookkeeping_only "$id" "$changed" && continue
      if [ "$allow_knowledge" = 1 ] && in_knowledge_scope "$changed" && ! authorized_path "$mappings" "$changed"; then continue; fi
      prior=$(baseline_fingerprint "$type" "$changed" "$dir"); current=$(fingerprint_path "$changed")
      if [ -n "$prior" ] && [ "$prior" = "$current" ]; then continue; fi
      # A control-plane file under .agents/ outside the plan scope is the user's, not a task change: listed apart, never a failure.
      if authorized_path "$mappings" "$changed"; then continue; fi
      case "$changed" in .agents/*) printf '%s\n' "$changed" >> "$tmpcp"; continue ;; esac
      # A154: a file `proofline upgrade` installs (and the proofline block of AGENTS.md/CLAUDE.md) is control plane too
      if control_plane_only "$changed"; then printf '%s\n' "$changed" >> "$tmpcp.in"; continue; fi
      printf '%s\n' "$changed" >> "$tmp"
    done
  done
  unexpected=$(cat "$tmp"); rm "$tmp"
  if [ -s "$tmpcp" ]; then echo "control-plane files changed under .agents/ (not task changes, outside the plan scope):"; sed 's/^/  /' "$tmpcp"; fi; rm -f "$tmpcp"
  if [ -s "$tmpcp.in" ]; then echo "installed proofline files changed (not task changes, outside the plan scope):"; sed 's/^/  /' "$tmpcp.in"; fi; rm -f "$tmpcp.in"
  [ -z "$unexpected" ] || {
    echo "unexpected or unmapped task-introduced paths:" >&2; printf '%s\n' "$unexpected" >&2
    # A161: AGENTS.md/CLAUDE.md is control plane only as the proofline block; any other text in it is the project's rules
    if printf '%s\n' "$unexpected" | grep -Eqx 'AGENTS\.md|CLAUDE\.md'; then echo "AGENTS.md/CLAUDE.md here holds text besides the proofline block (or is a symlink, or has no markers): that is project rules every agent reads, so it is a product change. Name the file in the plan scope (amendment and refreeze), or move that text out and keep only the proofline block." >&2; fi
    return 1; }
  echo "scope check passed: $id"
}
# Knowledge-scope paths the task changed outside the frozen plan scope (written by the knowledge step).
knowledge_owned_paths() {
  id=$1; dir=$(run_dir "$id")
  mappings=$(scope_mappings "$dir/PLAN.md") || fail "invalid scope mapping"
  tmp=$(mktemp "${TMPDIR:-/tmp}/agent-knowledge-scope.XXXXXX")
  for type in tracked untracked; do
    paths=$( [ "$type" = tracked ] && current_tracked_paths || current_untracked_paths )
    printf '%s\n' "$paths" | while IFS= read -r changed; do
      [ -n "$changed" ] || continue
      known_control_artifact "$id" "$changed" && continue
      in_knowledge_scope "$changed" || continue
      authorized_path "$mappings" "$changed" && continue
      prior=$(baseline_fingerprint "$type" "$changed" "$dir"); current=$(fingerprint_path "$changed")
      if [ -n "$prior" ] && [ "$prior" = "$current" ]; then continue; fi
      printf '%s\n' "$changed" >> "$tmp"
    done
  done
  cat "$tmp"; rm -f "$tmp"
}
verify_knowledge_scope() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  status=$(baseline_status "$dir"); [ "$status" = captured ] || fail "baseline required before knowledge-scope verification: $id"
  owned=$(knowledge_owned_paths "$id")
  ks=$(section_value "$dir" execution knowledge_state)
  if [ -n "$owned" ]; then
    case "$ks" in
      KNOWLEDGE_DONE) ;;
      *) echo "knowledge-scope changes present but knowledge transaction not recorded complete (knowledge_state=$ks); run 'agent.sh knowledge-done' first, or these paths are unauthorized:" >&2; printf '%s\n' "$owned" >&2; return 1 ;;
    esac
  else
    [ "$ks" != KNOWLEDGE_DONE ] || fail "knowledge_state is KNOWLEDGE_DONE but no knowledge-scope changes were found — record 'not_applicable' with a one-sentence reason instead if no writes were needed (the script checks it)"
  fi
  echo "knowledge scope verified: $id"
}

# Run artifact registry (D10): the only files a run directory may hold. Unknown files are rejected.
known_control_artifact() {
  id=$1 path=$2
  case "$path" in .agents/runs/"$id"/*) ;; *)
    rundir=$(run_dir "$id")
    if [ "$(section_value "$rundir" completion_report published)" = true ] || ls "$rundir"/gates/*-REOPEN.yaml >/dev/null 2>&1; then
      source_path=$(section_value "$rundir" task_source path)
      [ -n "$source_path" ] && [ "$path" = "$source_path" ] && return 0
      # A163: the delivery commit moved the task file to done/ (the recorded path follows it): its old place is bookkeeping too
      kc_td=$(cfg tasks.dir .agents/tasks)
      case "$path" in "$kc_td"/*) [ -n "$source_path" ] && [ "$(basename "$path")" = "$(basename "$source_path")" ] && [ "$(lifecycle_folder_status "$source_path")" = "done" ] && [ ! -e "$root/$path" ] && return 0 ;; esac
    fi
    return 1 ;;
  esac
  kc_rel=${path#.agents/runs/"$id"/}
  case "$kc_rel" in
    TASK.md|PLAN.md|RUN.yaml|COMPLETION_REPORT.md|LEDGER.log|HOOKS.log|VERIFY.md|mutation_budget|.lock/pid) return 0 ;;
    amendments/*|dispatch/*|worker-evidence/*|decisions/*|gates/*|results/*|reports/*|questions/*|approvals/*|waivers/*|security/*|ci-fix/*) return 0 ;;   # ci-fix: A169
    scratch/*) return 0 ;;
    reviews/proof-review/plan/*|reviews/proof-review/rules/*|reviews/proof-review/small/*|reviews/test-trust/tests/*|reviews/test-trust/qa/*|reviews/data-design/*) return 0 ;;
    reviews/proof-review/config/*|reviews/contract-proof/*|reviews/concurrency-proof/*|reviews/performance-proof/*|reviews/data-migration/*|reviews/visual-proof/*) return 0 ;;   # A78
    design/*.md|design/*.json) return 0 ;;
    EVIDENCE.md) [ "$(pipeline_needs "$id" evidence)" = yes ] && return 0 ;;
    QA_PLAN.md|QA_REPORT.md) [ "$(pipeline_needs "$id" qa)" = yes ] && return 0 ;;
  esac
  return 1
}
validate_control_artifacts() {
  id=$1 dir=$(run_dir "$1") bad=''
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    path=${file#"$root"/}; known_control_artifact "$id" "$path" || bad="${bad}${path}
"
  done <<VCA_EOF
$(find "$dir" -type f -print)
VCA_EOF
  while IFS= read -r file; do [ -n "$file" ] || continue; bad="${bad}${file#"$root"/}
"; done <<VCA_EOF
$(find "$dir" -type l -print)
VCA_EOF
  [ -z "$bad" ] || { echo "unexpected run artifact:" >&2; printf '%s' "$bad" >&2; echo "the lead removes a stray regular file (never a known artifact) with: agent.sh discard-stray $id <top-level-file-name | evidence/file-name> (A119, A219)" >&2; return 1; }
}

# --- Classification check (A31): the class is the lead's claim, the diff is the fact. -----------
# TRIVIAL covers text and configuration changes. A TRIVIAL run whose diff changes an executable code file
# (config review.executable_code, default below) must be reclassified before IMPLEMENTED and CODE_DONE.
executable_code_default='*.go *.py *.pyw *.js *.mjs *.cjs *.jsx *.ts *.mts *.cts *.tsx *.java *.kt *.kts *.scala *.groovy *.rs *.c *.cc *.cpp *.cxx *.h *.hh *.hpp *.cs *.fs *.vb *.rb *.php *.swift *.m *.mm *.dart *.lua *.pl *.pm *.r *.jl *.ex *.exs *.erl *.hs *.ml *.clj *.sh *.bash *.zsh *.fish *.ps1 *.bat *.cmd *.sql *.vue *.svelte *.gradle'
paths_executable() { # stdin: one path per line -> " p1 p2" of the paths matching review.executable_code (A31, A115)
  pe_globs=$(cfg review.executable_code "$executable_code_default"); pe_hits=''
  while IFS= read -r pe_p; do [ -z "$pe_p" ] || ! path_matches "$pe_p" "$pe_globs" || pe_hits="$pe_hits $pe_p"; done
  printf '%s' "$pe_hits"
}

# --- Database guard (A40) -----------------------------------------------------------------------
# No agent touches a database file that is not a test suite's own throwaway database: not to read, copy,
# query or write it, and no migration, seed or SQL client runs against anything. The runtime hook denies the
# commands and file-tool calls (proofline-hook.sh asks `agent.sh db-config`); this is the after-the-fact check:
# the project's database files (config database.paths) are listed with size and mtime when a run starts and
# compared before freeze, IMPLEMENTED, CODE_DONE and DONE. A changed, new or removed file blocks the handoff.
db_paths_default='*.db *.sqlite *.sqlite3 *.db3 *.s3db *.sdb *.mdb *.accdb *.ldb *.mv.db *.duckdb *.rdb *.db-wal *.db-shm *.db-journal *.sqlite-wal *.sqlite-shm *.sqlite-journal'
db_clients_default='sqlite3 sqlite duckdb litecli psql pgcli pg_dump pg_dumpall pg_restore createdb dropdb mysql mysqldump mysqlsh mycli mariadb mongosh mongo mongodump mongorestore redis-cli sqlcmd sqlplus sqlite-utils usql clickhouse-client cockroach cqlsh'
db_migrate_default='(npm|pnpm|yarn|bun)( run)? (migrate|migration|migrations|seed|seeds|db[:-])[A-Za-z0-9:_-]*( |$), (^| )(npx|pnpm exec|bunx|yarn dlx) (prisma|drizzle-kit|knex|sequelize|sequelize-cli|typeorm|mikro-orm|db-migrate|node-pg-migrate)( |$), (^| )prisma (migrate|db) , (^| )drizzle-kit (push|migrate|drop), (^| )(knex|sequelize|sequelize-cli|typeorm|mikro-orm|umzug|db-migrate|node-pg-migrate) .*(migrat|seed|db:|schema:), (^| )alembic (upgrade|downgrade|stamp), (^| )flask( .*)? db (upgrade|downgrade|stamp|migrate), (manage\.py|django-admin)( .*)? (migrate|flush|sqlflush|loaddata|dbshell), (^| )(rails|rake|bin/rails)( .*)? db:, (^| )artisan (migrate|db:), (^| )(flyway|liquibase|dbmate|goose|atlas|sqitch|tern|phinx|diesel|sqlx|sea-orm-cli)( .*)? (migrate|up|down|apply|deploy|update|run|push|revert|redo|reset|drop|seed), (^| )dotnet ef (database|migrations) , (^| )mix ecto\.(migrate|rollback|reset|drop|setup|load), (^| )migrate( .*)? (up|down|goto|drop|force), (^| )db(:| )(seed|migrate|reset|drop|push|setup)'
db_config() { # paths | clients | migrate_commands | all
  case "$1" in
    paths) cfg database.paths "$db_paths_default" ;;
    clients) cfg database.clients "$db_clients_default" ;;
    migrate_commands) cfg database.migrate_commands "$db_migrate_default" ;;
    all) printf 'paths=%s\nclients=%s\nmigrate_commands=%s\n' "$(db_config paths)" "$(db_config clients)" "$(db_config migrate_commands)" ;;
    *) fail "usage: agent.sh db-config <paths|clients|migrate_commands|all>" ;;
  esac
}
# hook_config (A188): every config value the runtime hook needs on a tool call, in one run: the database settings (db-config all) and
# tasks.dir, canonical_branch and product.dir, empty when absent. The hook asks it once per event instead of one process tree per value.
hook_config() {
  db_config all
  printf 'tasks_dir=%s\ncanonical_branch=%s\nproduct_dir=%s\n' "$(cfg tasks.dir '')" "$(cfg canonical_branch '')" "$(cfg product.dir '')"
  printf 'approve_budget_seconds=%s\nnext_budget_seconds=%s\nlock_wait_seconds=%s\n' "$(hook_knob approve_budget_seconds 20 5 25)" "$(hook_knob next_budget_seconds 10 2 20)" "$(hook_knob lock_wait_seconds 8 1 20)"
}
# hook_knob KEY DEFAULT MIN MAX: the configured number moved into its bounds (a non-number is the default); no value can switch a budget off
hook_knob() {
  hn_v=$(dec0 "$(cfg "hook.$1" "$2")"); case "$hn_v" in ''|*[!0-9]*) hn_v=$2 ;; esac
  [ "$hn_v" -ge "$3" ] || hn_v=$3; [ "$hn_v" -le "$4" ] || hn_v=$4; printf '%s\n' "$hn_v"
}

# --- QA plan bound to the plan (A42) -------------------------------------------------------------
# The QA plan is derived from the final PLAN.md and cites its sha256 (`Plan sha256: <64 hex>`). Freeze and
# refreeze refuse a QA plan derived from another plan, a plan criterion without an acceptance scenario, a
# scenario for a criterion the plan lacks, and a scenario that expects a term PLAN.md `## Contracts` removes.
qa_removed_terms() { # PLAN.md -> one backticked term per line from `## Contracts` lines that remove, rename or drop
  awk '/^## / { i = ($0 ~ /^## Contracts[[:space:]]*$/); next }
    i && tolower($0) ~ /(remov|renam|drop|delet|no longer|deprecat)/ { l = $0
      while (match(l, /`[A-Za-z_][A-Za-z0-9_.-]*`/)) { print substr(l, RSTART + 1, RLENGTH - 2); l = substr(l, RSTART + RLENGTH) } }' "$1" | sort -u
}
# --- Input validation at entry points (A162) -------------------------------------------------------
# An entry point takes external input (HTTP endpoint, form handler, CLI argument, queue consumer, webhook). The one
# deterministic source before the freeze is PLAN.md `## Contracts`; each bullet falls in one of two tiers:
#   mandatory   the bullet DECLARES an entry point (validation.entry_words: a method and path, endpoint, webhook,
#               queue consumer, graphql mutation, rpc method, cli flag or command, ...) AND marks new or changed
#               input, and is not unchanged or removed:
#                 declares && !removed && !skip && (input || (new && !output))
#               input = validation.entry_input (accepts, takes, parameter, query, body, payload, argument, flag,
#               option, header, input, required ...); new = validation.entry_new (new, adds, introduces, creates,
#               field, gains ...), which counts only when no output word (validation.entry_output: response,
#               returns, omits, shape ...) is present; skip = validation.entry_skip (unchanged, documented, no change).
#               The removal exemption is the entry point's own removal (validation_removed), not any removal word.
#   information a bullet that only mentions a candidate word (validation.entry_candidates) or declares an entry point
#               without new input: listed by `pipeline` and a note at freeze, never refusing.
# A word counts only as a whole word: a `.` or `-` inside an identifier (`schema.graphql`, `order.schema.json`) is
# no boundary. The two node validators (plan-contract, qa-plan) carry the same expressions; a test compares them.
# A mandatory entry point is named by its first backticked token, else by the text before the first colon, and needs
# one `## Validation` bullet (`- <name>: accepts <what>; limits <limits>; rejected at <server-side place>`) and its
# QA plan one `[invalid-input]` scenario naming it. What the code does is information only (validation.code_patterns).
validation_removed='^[ `*_]*(remove[sd]?|drop(s|ped)?|deprecate[sd]?|retire[sd]?)([^A-Za-z0-9_]|$)|(is|are|was|will be|has been|gets?) +(now +)?(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)|[(:`] *(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)|no +longer +(exists?|available|supported|served|routed)|/[^ ]*`? +(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)'
validation_bl='(^|[^A-Za-z0-9_.-])'
validation_br='($|[^A-Za-z0-9_.-]|[.]([^A-Za-z0-9_]|$))'
entry_has() { # CONFIG-KEY TEXT -> 0 when the key's words occur in TEXT as whole words
  eh_w=$(cfg "validation.$1"); [ -n "$eh_w" ] || return 1
  printf '%s\n' "$2" | grep -Eiq -- "${validation_bl}(${eh_w})${validation_br}"
}
entry_tier() { # BULLET BODY -> mandatory | information | (nothing)
  if entry_has entry_words "$1"; then
    ! printf '%s\n' "$1" | grep -Eiq -- "$validation_removed" || return 0
    ! entry_has entry_skip "$1" || { echo information; return 0; }
    if entry_has entry_input "$1" || { entry_has entry_new "$1" && ! entry_has entry_output "$1"; }; then echo mandatory; else echo information; fi
  elif entry_has entry_candidates "$1" && ! printf '%s\n' "$1" | grep -Eiq -- "$validation_removed"; then echo information
  fi
}
entry_name() { # BULLET BODY -> the entry point's name
  case "$1" in *\`*\`*) en_n=${1#*\`}; en_n=${en_n%%\`*} ;; *) en_n=${1%%:*} ;; esac
  printf '%s\n' "$en_n" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}
plan_entries() { # PLAN.md TIER -> one entry point name per line (TIER mandatory|information)
  [ -f "$1" ] || return 0
  awk '/^## / { i = ($0 ~ /^## Contracts[[:space:]]*$/); next } i && /^[[:space:]]*[-*][[:space:]]+[^[:space:]]/ { print }' "$1" | while IFS= read -r pe_l; do
    pe_b=$(printf '%s\n' "$pe_l" | sed 's/^[[:space:]]*[-*][[:space:]]*//')
    [ "$(entry_tier "$pe_b")" = "$2" ] || continue
    pe_n=$(entry_name "$pe_b"); [ -z "$pe_n" ] || printf '%s\n' "$pe_n"
  done | awk '!seen[$0]++'
}
plan_entry_points() { plan_entries "$1" mandatory; } # PLAN.md -> one mandatory entry point name per line
plan_validation_missing() { # PLAN.md -> the entry points without a complete `## Validation` line
  pv_l=$(awk '/^## / { i = ($0 ~ /^## Validation[[:space:]]*$/); next } i && /^[[:space:]]*[-*][[:space:]]/ { print }' "$1")
  plan_entry_points "$1" | while IFS= read -r pv_n; do
    printf '%s\n' "$pv_l" | grep -F -- "$pv_n" | grep -i 'accepts' | grep -i 'limits' | grep -Eiq 'rejected at' || printf '%s\n' "$pv_n"
  done
}
qa_invalid_missing() { # PLAN.md QA_PLAN.md -> the entry points with no [invalid-input] scenario naming them
  plan_entry_points "$1" | while IFS= read -r qi_n; do
    QI_N=$qi_n awk '
      BEGIN { n = ENVIRON["QI_N"] }
      function flush() { if (inv && index(blk, n)) ok = 1 }
      toupper($0) ~ /^- QA-[0-9]+ \(/ { flush(); blk = $0; inv = ($0 ~ /\[invalid-input\]/); next }
      /^## / { flush(); blk = ""; inv = 0; next }
      /^- / { flush(); blk = ""; inv = 0; next }
      { blk = blk "\n" $0 }
      END { flush(); exit !ok }' "$2" || printf '%s\n' "$qi_n"
  done
}
validation_candidates() { # ID -> "scope|path" or "diff|path" for code that looks like an entry point (information only)
  vc_p=$(cfg validation.code_patterns); [ -n "$vc_p" ] || return 0
  vc_d=$(run_dir "$1"); vc_base=$(repository_base_sha "$vc_d"); case "$vc_base" in ''|PENDING) vc_base=HEAD ;; esac
  scope_mappings "$vc_d/PLAN.md" 2>/dev/null | cut -d'|' -f1 | grep -v -E '\.(md|mdx|rst|adoc)$' | while IFS= read -r vc_x; do
    [ -f "$root/$vc_x" ] && grep -Eq -- "$vc_p" "$root/$vc_x" 2>/dev/null && printf 'scope|%s\n' "$vc_x" || true
  done
  task_changed_paths "$1" | grep -v -E '\.(md|mdx|rst|adoc)$|^\.agents/' | while IFS= read -r vc_x; do
    if git -C "$root" ls-files --error-unmatch -- "$vc_x" >/dev/null 2>&1 || git -C "$root" cat-file -e "$vc_base:$vc_x" 2>/dev/null; then
      git -C "$root" diff --no-color --no-renames "$vc_base" -- "$vc_x" 2>/dev/null | grep '^+' | grep -v '^+++' | grep -Eq -- "$vc_p" && printf 'diff|%s\n' "$vc_x" || true
    elif [ -f "$root/$vc_x" ]; then grep -Eq -- "$vc_p" "$root/$vc_x" 2>/dev/null && printf 'diff|%s\n' "$vc_x" || true; fi
  done | awk '!seen[$0]++'
}
validation_show() { # ID: printed by `pipeline` only when there is something to say
  vs_p=$(run_dir "$1")/PLAN.md
  vs_n=$(plan_entry_points "$vs_p" | tr '\n' ',' | sed 's/,$//;s/,/, /g')
  vs_m=$(plan_validation_missing "$vs_p" | tr '\n' ',' | sed 's/,$//;s/,/, /g')
  vs_c=$(validation_candidates "$1" | sed 's/|/:/' | tr '\n' ',' | sed 's/,$//;s/,/, /g')
  [ -z "$vs_n" ] || printf 'validation.entry_points=%s (PLAN.md ## Contracts; each needs a ## Validation line and an [invalid-input] QA scenario)\n' "$vs_n"
  [ -z "$vs_m" ] || printf 'validation.missing=%s (no complete ## Validation line: the freeze refuses)\n' "$vs_m"
  vs_i=$(plan_entries "$vs_p" information | cut -c1-60 | tr '\n' ',' | sed 's/,$//;s/,/, /g')
  [ -z "$vs_i" ] || printf 'validation.possible=%s (information only: ## Contracts bullets that mention an entry point without new input; if one takes new or changed external input, say so in the bullet and give it a ## Validation line)\n' "$vs_i"
  [ -z "$vs_c" ] || printf 'validation.candidates=%s (information only: code that looks like an entry point; declare it in ## Contracts when it takes external input)\n' "$vs_c"
}

verify_qa_plan_bound() { # ID
  vq_id=$1; vq_d=$(run_dir "$vq_id")
  [ "$(pipeline_needs "$vq_id" qa)" = yes ] || return 0
  [ -f "$vq_d/QA_PLAN.md" ] && [ -f "$vq_d/PLAN.md" ] || return 0
  vq_cited=$(sed -n 's/^Plan sha256: \([0-9a-f]\{64\}\)[[:space:]]*$/\1/p' "$vq_d/QA_PLAN.md" | head -n 1)
  [ -n "$vq_cited" ] || fail "QA_PLAN.md must cite the plan it is derived from: a line 'Plan sha256: <64 hex>' (the sha256 of the final PLAN.md; 'node <qa-plan skill>/scripts/validate-qa.mjs hash PLAN.md'). Write the QA plan after PLAN.md is final"
  [ "$vq_cited" = "$(hash_file "$vq_d/PLAN.md")" ] || fail "QA_PLAN.md was derived from a different PLAN.md (it cites $(printf '%.12s' "$vq_cited")..., PLAN.md is $(printf '%.12s' "$(hash_file "$vq_d/PLAN.md")")...): re-derive the QA plan from the current plan (dispatch qa) before freeze; a plan or contract change changes the scenarios"
  # A172: criteria are compared by key (id_key: case-insensitive, leading zeros ignored); the text names them as written.
  vq_pacs=$( { awk '/^[[:space:]]*criteria:[[:space:]]*\[/ { l = toupper($0); while (match(l, /AC-[0-9]+/)) { print substr(l, RSTART, RLENGTH); l = substr(l, RSTART + RLENGTH) } }' "$vq_d/PLAN.md"
    awk '/^## / { i = ($0 ~ /^## Behavior[[:space:]]*$/); next } i && toupper($0) ~ /^[-*][[:space:]]+AC-[0-9]+:/ { l = toupper($0); match(l, /AC-[0-9]+/); print substr(l, RSTART, RLENGTH) }' "$vq_d/PLAN.md"; } | id_keys | sort -u)
  vq_qacs=$(awk 'toupper($0) ~ /^- QA-[0-9]+ \(AC-/ { l = toupper($0); sub(/^- QA-[0-9]+ \(/, "", l); sub(/\).*/, "", l); n = split(l, a, /,[[:space:]]*/); for (i = 1; i <= n; i++) print a[i] }' "$vq_d/QA_PLAN.md" | id_keys | sort -u)
  vq_acc=$(awk '
      /^## Adversarial scenarios[[:space:]]*$/ { skip = 1; next } /^## / { skip = 0 }
      !skip && toupper($0) ~ /^- QA-[0-9]+ \(AC-/ { l = toupper($0); sub(/^- QA-[0-9]+ \(/, "", l); sub(/\).*/, "", l); n = split(l, a, /,[[:space:]]*/); for (i = 1; i <= n; i++) print a[i] }' "$vq_d/QA_PLAN.md" | id_keys | sort -u)
  for vq_a in $vq_pacs; do
    printf '%s\n' "$vq_acc" | grep -Fxq "$vq_a" || fail "QA_PLAN.md has no acceptance scenario for $vq_a, a criterion of PLAN.md: derive the QA plan from the whole plan"
  done
  if [ -n "$vq_pacs" ]; then
    for vq_a in $vq_qacs; do
      printf '%s\n' "$vq_pacs" | grep -Fxq "$vq_a" || fail "QA_PLAN.md has a scenario for $vq_a, which PLAN.md does not contain: the QA plan contradicts the plan"
    done
  fi
  for vq_t in $(qa_removed_terms "$vq_d/PLAN.md"); do
    vq_bad=$(awk -v t="$vq_t" 'tolower($0) ~ /^[[:space:]]+expected:/ && index($0, t) && tolower($0) !~ /(absent|removed|no longer|not |never|without|omitted|missing|undefined|gone|must not|rejected|404|ignored)/ { print NR ": " $0; exit }' "$vq_d/QA_PLAN.md")
    [ -z "$vq_bad" ] || fail "QA_PLAN.md expects \`$vq_t\` ($vq_bad), which PLAN.md ## Contracts removes or renames: state that it is absent, or follow the new contract; the QA plan must not contradict the plan"
  done
  vq_inv=$(qa_invalid_missing "$vq_d/PLAN.md" "$vq_d/QA_PLAN.md" | tr '\n' ',' | sed 's/,$//;s/,/, /g')
  [ -z "$vq_inv" ] || fail "QA_PLAN.md has no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: $vq_inv. Add an adversarial scenario '- QA-<n> (AC-<k>) [invalid-input]: ...' that names each entry point in its title, input or expected line, with an input the server must reject (A162)"
}




# --- Defect tasks carry a debug-proof result (A35, A200). -----------------------------------------
# A STANDARD-or-higher task TYPED as a defect must have a `reports/NNN-debug.md` (reproduction, root cause,
# regression test) before IMPLEMENTED. A200: the trigger is the task's type or label (front matter `type`, `kind`,
# `label(s)`; a `**Type:**` / `Labels:` line; a `## Labels` or `## Type` section; an explicit bug/defect/regression in
# `## Suggested class`) or a declared `decision: fix` entry. The words "fix" or "duzelt" in prose no longer ask for
# the report: a feature that mentions a fix lost a debug report round for nothing. A task that is not labelled but
# fixes a bug is still asked for the root-cause proof by its reviewer (roles/reviewer.md), who may FAIL the gate.
# A202: the task type is the front matter `type:` line (feature|bug|refactor|content|docs|chore); a task without one is a feature,
# an unknown value is `invalid` (the validator refuses it; here it gets no exemption and no lighter path). The type is part of the task
# contract that the freeze hashes, so changing it after the freeze makes the run stale: an agent cannot relabel a bug to skip its gates.
task_type() { # TASK.md -> the type
  tt_v=$(awk '{ sub(/\r$/, "") } /^##/ { exit } !fm && $0 == "---" { fm = 1; next } fm && $0 == "---" { exit }
    fm && tolower($0) ~ /^type[[:space:]]*:/ { v = $0; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/[[:space:]]+#.*$/, "", v); gsub(/["'"'"'[:space:]]/, "", v); n++; r = (v == "" ? "?" : tolower(v)) }
    END { if (n > 1) print "?"; else if (n == 1) print r }' "$1" 2>/dev/null)
  case "$tt_v" in ''|feature) echo feature ;; defect) echo bug ;; bug|refactor|content|docs|chore) echo "$tt_v" ;; *) echo invalid ;; esac
}

verify_handoff() {
  id=$1 allow_knowledge=${2:-0}; require_run "$id"; dir=$(run_dir "$id")
  verify_scope "$id" "$allow_knowledge"; patch=$(task_patch_fingerprint "$id"); state=$(section_value "$dir" handoff state)
  for gate in implemented code_done; do
    recorded=$(section_value "$dir" handoff "${gate}_patch_sha256")
    case "$recorded" in ''|PENDING) continue;; esac
    [ "$recorded" = "$patch" ] || fail "${gate} stale: task-owned patch changed; rerun affected gate"
  done
  [ -n "$state" ] || fail "handoff state missing"
  verify_lifecycle_gates "$id"
  echo "handoff integrity verified: $id"
}
validate_run() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  for f in TASK.md PLAN.md RUN.yaml; do [ -f "$dir/$f" ] || fail "missing required artifact: $f"; done
  verify_bindings "$id"
  [ "$(pipeline_needs "$id" evidence)" != yes ] || [ -f "$dir/EVIDENCE.md" ] || fail "missing required artifact: EVIDENCE.md"
  [ "$(pipeline_needs "$id" qa)" != yes ] || [ -f "$dir/QA_PLAN.md" ] || fail "missing required artifact: QA_PLAN.md"
  if section_key_present "$dir" completion_report required; then [ -f "$dir/COMPLETION_REPORT.md" ] || fail "missing required artifact: COMPLETION_REPORT.md"; fi
  validate_control_artifacts "$id"
  scope_mappings "$dir/PLAN.md" >/dev/null
  [ "$(baseline_status "$dir")" = captured ] || fail "baseline missing or pending: $id"
  validate_captured_baseline "$dir"
  verify_freshness "$id"
  verify_scope "$id" 1
  verify_knowledge_scope "$id"
  verify_handoff "$id" 1
  echo "run validated: $id"
}

# --- Topology, worker evidence and TDD --------------------------------------------------
policy_enforced() { section_key_present "$1" worker_evidence required; }
resolve_topology() {
  topology=$(section_value "$1" execution topology)
  case "$topology" in standalone|orchestrated) printf '%s\n' "$topology"; return 0 ;; esac
  topology=$(cfg default_topology)
  case "$topology" in
    standalone|orchestrated) printf '%s\n' "$topology" ;;
    *) fail "no valid execution topology resolved: set execution.topology in RUN.yaml or default_topology in .agents/config.yaml" ;;
  esac
}
# The one place a topology becomes the expected implementation owner.
expected_implementation_owner() {
  case "$1" in standalone) echo lead ;; orchestrated) echo implementer ;; *) fail "invalid execution topology: $1" ;; esac
}
reject_generic_justification() {
  norm=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/[[:space:]]+/ /g')
  case "$norm" in ''|'tdd not needed'|'test not needed'|'no test needed'|'not needed'|'configuration change'|'n/a'|'na') return 1 ;; esac
  [ "${#norm}" -ge 20 ]
}
worker_evidence_dir() { printf '%s/worker-evidence\n' "$(run_dir "$1")"; }
next_evidence_seq() {
  nes_dir=$1 nes_phase=$2 n=0
  for f in "$nes_dir"/"$nes_phase"-*.yaml; do
    [ -e "$f" ] || continue
    seq=$(basename "$f" .yaml); seq=${seq#"$nes_phase"-}
    case "$seq" in *[!0-9]*|'') continue ;; esac
    [ "$seq" -gt "$n" ] && n=$seq
  done
  printf '%d\n' $((n + 1))
}
# A203: a gate or evidence record has some twenty `key: value` lines and a status check reads many of them: a shell read loop, no process per
# field (an awk per field was most of the processes of `next` and `digest`). The first line that starts with `key:` wins; leading spaces and
# every double quote of the value are dropped, as before. An unreadable file keeps the old awk path (same message, same status).
evidence_field() {
  if [ ! -r "$1" ]; then awk -v k="$2" 'index($0, k ":") == 1 { v = substr($0, length(k) + 2); sub(/^ */, "", v); gsub(/"/, "", v); print v; exit }' "$1"; return; fi
  ef_pre="$2:"
  while IFS= read -r ef_l || [ -n "$ef_l" ]; do
    case "$ef_l" in
      "$ef_pre"*)
        ef_v=${ef_l#"$ef_pre"}
        while :; do case "$ef_v" in " "*) ef_v=${ef_v# } ;; *) break ;; esac; done
        while :; do case "$ef_v" in *'"'*) ef_v=${ef_v%%'"'*}${ef_v#*'"'} ;; *) break ;; esac; done
        printf '%s\n' "$ef_v"; return 0 ;;
    esac
  done < "$1"
  return 0
}
evidence_targets() { sed -n 's/^target: *//p' "$1" | head -1 | tr ',' '\n'; }
evidence_covers_path() { evidence_targets "$1" | grep -Fxq -- "$2"; }
valid_evidence_file() {
  id=$1 dir=$2 file=$3 expected_role=$4
  [ "$(evidence_field "$file" task_id)" = "$id" ] || return 1
  [ "$(evidence_field "$file" task_sha256)" = "$(section_value "$dir" freeze task_sha256)" ] || return 1
  [ "$(evidence_field "$file" evidence_sha256)" = "$(section_value "$dir" freeze evidence_sha256)" ] || return 1
  [ "$(evidence_field "$file" plan_sha256)" = "$(section_value "$dir" freeze plan_sha256)" ] || return 1
  [ "$(canon_role "$(evidence_field "$file" role)")" = "$expected_role" ] || return 1
  session=$(evidence_field "$file" codex_session_id)
  if [ -n "$session" ] && [ -d "${CODEX_SESSION_DIR:-$HOME/.codex/sessions}" ]; then
    grep -RFl "\"$session\"" "${CODEX_SESSION_DIR:-$HOME/.codex/sessions}" >/dev/null 2>&1 || return 1
  fi
  return 0
}
parse_tdd_exemptions() {
  awk '
    /^scope:$/ { inside=1; next } inside && /^---$/ { exit }
    inside && /^  - path: / { path=$0; sub(/^  - path: /, "", path); next }
    inside && /^    tdd_exemption: / { e=$0; sub(/^    tdd_exemption: /, "", e); print path "|" e }
  ' "$1"
}
exempted_path() { parse_tdd_exemptions "$1" | grep -F -- "$2|" | head -1 | cut -d '|' -f2-; }
# A202: a content or docs task has the test-first exemption by default, but the plan must carry its reason for each document path, and a
# path that holds code (review.executable_code) is never exempt, whatever the task type says: it keeps its RED and GREEN evidence.
check_type_exemptions() { # RUN-DIR
  ct_ty=$(task_type "$1/TASK.md"); case "$ct_ty" in content|docs) ;; *) return 0 ;; esac
  for ct_p in $(scope_mappings "$1/PLAN.md" 2>/dev/null | cut -d '|' -f1); do
    ct_r=$(exempted_path "$1/PLAN.md" "$ct_p")
    if [ -n "$(printf '%s\n' "$ct_p" | paths_executable)" ]; then
      [ -z "$ct_r" ] || fail "the $ct_ty task type exempts document paths only; $ct_p holds code and is never exempt from test-first: remove its tdd_exemption and show RED and GREEN (or ask the user to change the task type)"
    elif is_doc_path "$ct_p" && [ -z "$ct_r" ]; then
      fail "the $ct_ty task type exempts document paths from test-first by default, with the reason written in the plan: add 'tdd_exemption: <specific reason, 20+ characters>' to $ct_p in PLAN.md scope"
    fi
  done
}
validate_tdd_exemptions() {
  mappings=$(scope_mappings "$1/PLAN.md") || fail "invalid scope mapping"
  check_type_exemptions "$1"
  for vt_p in $(printf '%s\n' "$mappings" | cut -d '|' -f1); do
    reason=$(exempted_path "$1/PLAN.md" "$vt_p"); [ -n "$reason" ] || continue
    reject_generic_justification "$reason" || fail "invalid TDD exemption for $vt_p: reason is missing or too generic"
  done
}
verify_worker_evidence() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  policy_enforced "$dir" || { echo "worker-evidence not policy-enforced for $id"; return 0; }
  verify_freeze "$id" >/dev/null
  validate_tdd_exemptions "$dir"
  topology=$(resolve_topology "$dir"); expected_role=$(expected_implementation_owner "$topology")
  evdir=$(worker_evidence_dir "$id"); mappings=$(scope_mappings "$dir/PLAN.md") || fail "invalid scope mapping"
  missing=''
  for vw_p in $(printf '%s\n' "$mappings" | cut -d '|' -f1); do
    [ -z "$(exempted_path "$dir/PLAN.md" "$vw_p")" ] || continue
    red_ok=0 green_ok=0
    for f in "$evdir"/RED-*.yaml; do [ -e "$f" ] && evidence_covers_path "$f" "$vw_p" && valid_evidence_file "$id" "$dir" "$f" "$expected_role" && red_ok=1; done
    for f in "$evdir"/GREEN-*.yaml "$evdir"/FIX-*.yaml; do [ -e "$f" ] && evidence_covers_path "$f" "$vw_p" && valid_evidence_file "$id" "$dir" "$f" "$expected_role" && green_ok=1; done
    [ "$red_ok" = 1 ] && [ "$green_ok" = 1 ] || missing="$missing $vw_p"
  done
  [ -z "$missing" ] || fail "worker-evidence verification failed: $id: missing valid RED+GREEN implementation evidence (topology=$topology, expected role=$expected_role; or TDD exemption) for:$missing"
  echo "worker-evidence verified: $id (topology=$topology)"
}

# --- Lifecycle gates, attested mutation ownership, ledger, reopen --------------------------
gates_enforced() { section_key_present "$(run_dir "$1")" lifecycle_gates required; }
max_fix_rounds() { mfr=$(cfg review.max_fix_rounds 2); case "$mfr" in ''|*[!0-9]*) mfr=2 ;; esac; printf '%s\n' "$mfr"; }
one_line() { printf '%s' "$1" | tr '\n\t' '  '; }

ledger_file() { printf '%s/LEDGER.log\n' "$(run_dir "$1")"; }
_lv() { printf '%s.%s=%s\n' "$2" "$3" "$(section_value "$1" "$2" "$3")"; }
lifecycle_digest() {
  g_d=$(run_dir "$1")
  { _lv "$g_d" execution state; _lv "$g_d" execution knowledge_state; _lv "$g_d" execution awaiting_input; _lv "$g_d" execution autonomy
    _lv "$g_d" handoff state; _lv "$g_d" handoff implemented_patch_sha256; _lv "$g_d" handoff code_done_patch_sha256
    _lv "$g_d" pipeline classification; _lv "$g_d" pipeline review; _lv "$g_d" pipeline tier
    _lv "$g_d" completion_report published; _lv "$g_d" completion_report adapter; _lv "$g_d" completion_report receipt
    if local_task_source_run "$1"; then _lv "$g_d" task_source path; _lv "$g_d" task_source revision; fi
  } | sha256
}
ledger_append() {
  g_id=$1 g_event=$2 g_from=$3 g_to=$4 g_detail=$(one_line "$5")
  g_file=$(ledger_file "$g_id"); g_seq=1 g_prev=genesis
  if [ -s "$g_file" ]; then
    g_last=$(tail -n 1 "$g_file")
    g_seq=$(( $(printf '%s' "$g_last" | sed -n 's/^seq=\([0-9][0-9]*\) .*/\1/p') + 1 ))
    g_prev=$(printf '%s' "$g_last" | sha256)
  fi
  printf 'seq=%s prev=%s event=%s role=%s from=%s to=%s digest=%s ts=%s epoch=%s detail=%s\n' "$g_seq" "$g_prev" "$g_event" "$execution_role" "${g_from:--}" "${g_to:--}" "$(lifecycle_digest "$g_id")" "$(now_iso)" "$(now_epoch)" "$g_detail" >> "$g_file" || fail "could not append to lifecycle ledger: $g_file"
}
verify_seal() {
  g_id=$1; gates_enforced "$g_id" || return 0
  g_d=$(run_dir "$g_id"); g_file=$(ledger_file "$g_id")
  if [ ! -s "$g_file" ]; then
    g_hs=$(section_value "$g_d" handoff state)
    case "$g_hs" in PLANNED|'') ;; *) fail "lifecycle ledger missing but handoff.state=$g_hs: manual lifecycle-state edit detected for $g_id" ;; esac
    [ "$(run_state "$g_d")" != CODE_DONE ] || fail "lifecycle ledger missing but execution.state=CODE_DONE: manual lifecycle-state edit detected for $g_id"
    [ "$(section_value "$g_d" completion_report published)" != true ] || fail "lifecycle ledger missing but a completion report is marked published: manual lifecycle-state edit detected for $g_id"
    return 0
  fi
  g_prev=genesis g_n=0 g_lastdigest=''
  while IFS= read -r g_line || [ -n "$g_line" ]; do
    g_n=$((g_n + 1))
    g_lseq=${g_line#seq=}; g_lseq=${g_lseq%% *}
    g_lprev=${g_line#* prev=}; g_lprev=${g_lprev%% *}
    case "$g_line" in "seq=$g_n prev=$g_prev event="*) ;; *) g_lseq=bad ;; esac
    [ "$g_lseq" = "$g_n" ] && [ "$g_lprev" = "$g_prev" ] || fail "lifecycle ledger chain broken at entry $g_n for $g_id: ledger was edited"
    g_lastdigest=${g_line#* digest=}; g_lastdigest=${g_lastdigest%% *}
    g_prev=$(printf '%s' "$g_line" | sha256)
  done < "$g_file"
  [ "$g_lastdigest" = "$(lifecycle_digest "$g_id")" ] || fail "lifecycle state of $g_id does not match its last recorded control-plane transition: RUN.yaml lifecycle fields were edited by hand. A completed run is reopened only with 'agent.sh amend'"
}

# Gate records: gates/NNN-<GATE>.yaml (+ .manifest). result is pass | pass_low | fail | reopen.
gates_dir() { printf '%s/gates\n' "$(run_dir "$1")"; }
gate_field() { evidence_field "$1" "$2"; }
gate_names_all() { ls -1 "$(gates_dir "$1")" 2>/dev/null | grep -E '^[0-9]{3}-(SECRETS|REVIEW_SMALL|REVIEW_PLAN|REVIEW_RULES|REVIEW_TESTS|REVIEW_DATA|SECURITY|QA|VERIFY|REOPEN)\.yaml$' | sort || true; }
# Only records bound in the ledger chain by the command that wrote them count; a hand-written or edited
# file is ignored by every evaluation (and reported by `validate`).
# A203: `next` and `digest` read the gate records dozens of times in one process and write none: gate_names_prime lists them once (every
# subshell inherits the list). Only those two commands call it, so a command that records a gate always reads the folder.
gn_memo_id=''
gate_names_prime() { gn_memo_id=''; gn_memo_val=$(gate_names "$1"); gn_memo_id=$1; }
gate_names() {
  if [ "$gn_memo_id" = "$1" ]; then [ -z "$gn_memo_val" ] || printf '%s\n' "$gn_memo_val"; return 0; fi
  gn_all=$(gate_names_all "$1"); [ -n "$gn_all" ] || return 0
  # shellcheck disable=SC2086 # file names without whitespace
  bound_names "$(run_dir "$1")" gates '(gate:|REOPEN$)' $gn_all | sort
}
# sha256_list FILE... -> "<sha256> <basename>" per file, in one process.
sha256_list() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@"; else sha256sum "$@"; fi | awk '{ n = $2; sub(/^\*/, "", n); sub(/.*\//, "", n); print $1, n }'
}
# bound_names RUNDIR SUBDIR EVENT-ERE NAME...: the names whose token "<SUBDIR>/<NAME>@<sha256>" appears in a
# ledger entry whose event matches EVENT-ERE (anchored at the event value).
bound_names() {
  bn_d=$1 bn_s=$2 bn_e=$3; shift 3
  [ $# -gt 0 ] && [ -s "$bn_d/LEDGER.log" ] || return 0
  (cd "$bn_d/$bn_s" && sha256_list "$@") | awk -v s="$bn_s" -v e="^event=$bn_e" '
    FNR == NR { if ($3 ~ e) { l = $0; sub(/ detail=/, " detail= ", l); L = L " " l " " } next }
    index(L, " " s "/" $2 "@" $1 " ") { print $2 }' "$bn_d/LEDGER.log" -
}
ledger_token() { printf '%s@%s' "$1" "$(hash_file "$(run_dir "$2")/$1")"; } # RUN-RELATIVE-PATH ID
verify_bindings() { # ID: every gate record and waiver is bound in the ledger
  gates_enforced "$1" || return 0
  vb_d=$(run_dir "$1"); vb_bad=''
  for vb_spec in 'gates (gate:|REOPEN$)' 'waivers waive$'; do
    vb_s=${vb_spec%% *}; vb_all=$(ls -1 "$vb_d/$vb_s" 2>/dev/null | grep -E '^[0-9]{3}-.*\.yaml$' || true); [ -n "$vb_all" ] || continue
    # shellcheck disable=SC2086
    vb_ok=$(bound_names "$vb_d" "$vb_s" "${vb_spec#* }" $vb_all)
    for vb_n in $vb_all; do printf '%s\n' "$vb_ok" | grep -Fxq -- "$vb_n" || vb_bad="$vb_bad $vb_s/$vb_n"; done
  done
  [ -z "$vb_bad" ] || fail "records not bound in the ledger by the command that writes them (hand-written or edited; every gate evaluation ignores them):$vb_bad"
}
# last_reopen_seq ID [any|terminal]: the seq of the last REOPEN record. Default: an `amend` reopen, which discards every
# earlier gate record. `terminal`: the last `reopen` of a FAILED/BLOCKED run (A152, marked `reopened_from`); its passing
# records stay, its non-passing ones do not. `any`: both (the fix-round allowance restarts at either).
last_reopen_seq() {
  n=0
  for f in $(gate_names "$1"); do case "$f" in *-REOPEN.yaml)
    lr_t=$(gate_field "$(gates_dir "$1")/$f" reopened_from)
    case "${2:-amend}:$lr_t" in amend:|any:*|terminal:?*) ;; *) continue ;; esac
    n=$(gate_field "$(gates_dir "$1")/$f" seq) ;; esac; done
  printf '%s\n' "$n"
}
patch_manifest() { task_owned_paths "$1" | while IFS= read -r p; do if [ -n "$p" ]; then printf '%s|%s\n' "$p" "$(fingerprint_path "$p")"; fi; done; }
gate_bound_to_contract() {
  g_bd=$(run_dir "$1")
  for g_bk in task evidence plan qa_plan; do [ "$(gate_field "$2" "${g_bk}_sha256")" = "$(section_value "$g_bd" freeze "${g_bk}_sha256")" ] || return 1; done
}
# A200 (item 5): a refreeze invalidates only the gates it affects. When the only frozen hash that changed is the QA plan's, a
# `pass` record of a gate that does not read the QA plan (SECRETS and SECURITY only: roles/security_reviewer.md reads TASK PLAN EVIDENCE; the reviewer role reads QA_PLAN.md, so every REVIEW_* gate reruns) stays bound; every other
# change (task, evidence, plan) and every other gate invalidates as before. The record's content fingerprint is still compared
# by gate_focus_status, so changed code never rides on this. Safe side: anything else is not bound.
gate_bound_after_refreeze() { # ID RECORD
  gba_d=$(run_dir "$1")
  for gba_k in task evidence plan; do [ "$(gate_field "$2" "${gba_k}_sha256")" = "$(section_value "$gba_d" freeze "${gba_k}_sha256")" ] || return 1; done
  [ "$(gate_field "$2" result)" = pass ] || return 1
  case "$(gate_field "$2" gate)" in SECRETS|SECURITY) return 0 ;; *) return 1 ;; esac
}
# Structural validity: task, frozen contract, policy and pipeline, manifest, author role and the bound artifact.
valid_gate_file() {
  g_id=$1 g_f=$2 g_d=$(run_dir "$1")
  [ "$(gate_field "$g_f" task_id)" = "$g_id" ] || return 1
  gate_bound_to_contract "$g_id" "$g_f" || gate_bound_after_refreeze "$g_id" "$g_f" || return 1
  [ "$(gate_field "$g_f" policy_sha256)" = "$(section_value "$g_d" freeze policy_sha256)" ] || return 1
  [ "$(gate_field "$g_f" pipeline)" = "$(section_value "$g_d" freeze pipeline)" ] || return 1
  g_m=${g_f%.yaml}.manifest; [ -f "$g_m" ] || return 1
  [ "$(gate_field "$g_f" manifest_sha256)" = "$(hash_file "$g_m")" ] || return 1
  [ "$(gate_field "$g_f" role)" = "$(gate_owner "$(gate_field "$g_f" gate)")" ] || return 1
  g_art=$(gate_field "$g_f" artifact)
  if [ -n "$g_art" ]; then [ -f "$g_d/$g_art" ] && [ "$(gate_field "$g_f" artifact_sha256)" = "$(hash_file "$g_d/$g_art")" ] || return 1; fi
  g_ue=$(gate_field "$g_f" unsupported_evidence); g_ue=${g_ue%@*}   # A102: evidence edited after the record -> stale
  if [ -n "$g_ue" ]; then [ -f "$g_d/$g_ue" ] && [ "$(gate_field "$g_f" unsupported_evidence_sha256)" = "$(hash_file "$g_d/$g_ue")" ] || return 1; fi
  return 0
}
# A waiver counts only when `waive` wrote it (ledger-bound) for exactly this gate record (name and sha256)
# and finding; SECRETS and SECURITY findings are never waived, whatever the waiver files say.
finding_waived() { # ID GATE-RECORD-FILE FINDING-ID
  fw_d=$(run_dir "$1"); fw_g=$(basename "$2")
  case "$(gate_field "$2" gate)" in SECRETS|SECURITY) return 1 ;; esac
  fw_all=$(ls -1 "$fw_d/waivers" 2>/dev/null | grep -E '^[0-9]{3}-.*\.yaml$' || true); [ -n "$fw_all" ] || return 1
  fw_rs=$(hash_file "$2"); fw_ck=''
  # shellcheck disable=SC2086
  for fw_n in $(bound_names "$fw_d" waivers 'waive$' $fw_all); do
    fw_f=$fw_d/waivers/$fw_n
    [ "$(gate_field "$fw_f" gate_record)" = "$fw_g" ] && [ "$(gate_field "$fw_f" gate_record_sha256)" = "$fw_rs" ] && [ "$(gate_field "$fw_f" finding)" = "$3" ] && return 0
    # the same finding on a later record of the same gate (a re-run): the waiver carries the finding's persistent key
    fw_wk=$(gate_field "$fw_f" finding_key)
    if [ -n "$fw_wk" ] && [ "$(gate_field "$fw_f" gate)" = "$(gate_field "$2" gate)" ]; then
      [ -n "$fw_ck" ] || fw_ck=$(finding_waiver_key "$2" "$3")
      [ -n "$fw_ck" ] && [ "$fw_ck" = "$fw_wk" ] && return 0
    fi
  done
  return 1
}
# The persistent identity of a finding, so that a waiver follows the finding and not the gate record. The key is a hash of
# gate and focus, the finding_key (path and the cited line's text, so a moved line is the same finding), the number of identical
# lines above it (the same text at a NEW place in a file is another finding) and the normalised finding text. The finding id is not
# part of it (a re-run may number its rows differently). No row of that id: empty (the waiver then binds the record only, the safe side).
finding_waiver_key() { # GATE-RECORD-FILE FINDING-ID
  fwk_row=$(awk -v want="$2" '/^finding: / { r = $0; sub(/^finding: /, "", r); split(r, p, "|"); if (p[1] == want) { print r; exit } }' "$1")
  [ -n "$fwk_row" ] || return 0
  fwk_loc=$(printf '%s' "$fwk_row" | cut -d'|' -f3 | tr -d ' '); fwk_txt=$(printf '%s' "$fwk_row" | cut -d'|' -f4)
  fwk_fp=$(gate_field "$1" fingerprint); fwk_fc=$(gate_field "$1" focus); fwk_k=$(finding_key "$fwk_fp" "$fwk_loc" "$fwk_txt"); fwk_ord=0
  fwk_n=${fwk_loc##*:}; fwk_n=${fwk_n%%-*}
  # No line number, or a cited line that no longer resolves: no order can be told, so no key (the waiver binds the record only).
  case "$fwk_n" in ''|*[!0-9]*) return 0 ;; esac
  [ "$fwk_loc" != "$fwk_n" ] || return 0
  fwk_lt=$(tree_line "$fwk_fp" "$fwk_loc"); [ -n "$fwk_lt" ] || return 0
  if [ "$fwk_n" -gt 1 ]; then
    fwk_ord=$(git -C "$root" cat-file -p "$fwk_fp:${fwk_loc%:*}" 2>/dev/null | fwk_t=$fwk_lt awk -v n="$fwk_n" 'NR < n && $0 == ENVIRON["fwk_t"] { c++ } END { print c + 0 }')
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$(gate_field "$1" gate)" "${fwk_fc:--}" "$fwk_k" "$fwk_ord" "$(printf '%s' "$fwk_txt" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' ' ' | sed 's/^ //;s/ $//')" | git hash-object --stdin
}
fail_fully_waived() { # ID GATE-RECORD-FILE
  fwf_any=no
  for fwf_x in $(blocking_finding_ids "$2"); do fwf_any=yes; finding_waived "$1" "$2" "$fwf_x" || return 1; done
  [ "$fwf_any" = yes ]
}
blocking_finding_ids() { sed -n 's/^finding: \([^|]*\)|\([a-z]*\)|.*/\1 \2/p' "$1" | awk '$2 != "info" { print $1 }'; }
# gate_status ID GATE [strict|patch] [NOW]: pass | pass_low | waived | fail | stale | missing.
# strict binds the content fingerprint (any byte); patch binds the task-owned patch (after CODE_DONE,
# when knowledge and report bookkeeping legitimately change the tree). reuse is strict plus selective repetition
# (focus_untouched): the view `next`, the digest, the summary and the CODE_DONE handoff share after a fix round.
# A gate is the worst status over its own focus and every risk focus it carries for the run (A78), so a gate
# is never satisfied while a required focus result is missing, stale or failing. A98: a focus recorded
# `unsupported` (unproven, reported) does not hold the gate open; it is never `pass` and the report lists it.
gate_status() {
  gs_id=$1 gs_gate=$2 gs_mode=${3:-strict} gs_now=${4:-}
  if [ "$gs_mode" != patch ]; then [ -n "$gs_now" ] || gs_now=$(gate_fingerprint)
  else [ -n "$gs_now" ] || gs_now=$(task_patch_fingerprint "$gs_id"); fi
  gs_worst=pass
  for gs_fc in - $(risk_gate_focuses "$gs_id" "$gs_gate"); do
    gs_s=$(gate_focus_status "$gs_id" "$gs_gate" "$gs_fc" "$gs_mode" "$gs_now")
    if [ "$(status_rank "$gs_s")" -gt "$(status_rank "$gs_worst")" ]; then gs_worst=$gs_s; fi
  done
  printf '%s\n' "$gs_worst"
}
status_rank() { case "$1" in pass|unsupported) echo 0 ;; waived) echo 1 ;; pass_low) echo 2 ;; missing) echo 3 ;; stale) echo 4 ;; *) echo 5 ;; esac; }
# Selective repetition (modes patch and reuse only, never strict): a `pass` risk-focus record stays fresh when the
# task-owned paths changed since its manifest (the file set it looked at) and none matches the focus's
# `risk.*.paths`. In reuse mode every path that differs between the record's tree and the current tree must also
# be one of those task-owned paths. Safe side = stale: the gate's own focus, SECRETS, a focus with a `content`
# signal, no path set, or no determinable change (delta empty) always rerun.
focus_untouched() { # ID RECORD FOCUS MODE NOW
  fu_pats=''
  case "$3" in -|'') return 1 ;; esac
  [ "$(gate_field "$2" gate)" != SECRETS ] || return 1
  for fu_n in $(risk_names); do
    [ "$(cfg "risk.$fu_n.check")" = "$3" ] || continue
    [ -z "$(cfg "risk.$fu_n.content")" ] || return 1
    fu_pats="$fu_pats $(risk_paths "$1" "$fu_n")"
  done
  [ -n "${fu_pats# }" ] || return 1
  fu_delta=$( { cat "${2%.yaml}.manifest"; patch_manifest "$1"; } | sed '/^$/d' | sort | uniq -u | cut -d '|' -f1 | sort -u ) || return 1
  [ -n "$fu_delta" ] || return 1
  for fu_p in $fu_delta; do ! path_matches "$fu_p" "$fu_pats" || return 1; done
  [ "$4" = reuse ] || return 0
  fu_tree=$(git -C "$root" diff-tree -r --name-only "$(gate_field "$2" fingerprint)" "$5" 2>/dev/null) || return 1
  [ -n "$fu_tree" ] || return 1
  for fu_p in $fu_tree; do printf '%s\n' "$fu_delta" | grep -Fxq -- "$fu_p" || return 1; done
  return 0
}
# A200 (item 5): selective repetition of a gate's OWN focus by input. A `pass` record of REVIEW_PLAN, REVIEW_RULES, REVIEW_DATA or
# SECURITY stays fresh in modes patch and reuse only when every path that changed since the record (its manifest delta; in reuse
# mode also every path the trees differ in) is a TEST path and, for SECURITY, no changed test touches security behavior (identity,
# authorization, input validation, secrets: the words in security_test_words, in the path or in a changed line). Everything else
# runs again: SECRETS, REVIEW_SMALL (it reads tests), REVIEW_TESTS, QA and VERIFY always; any changed product code, dependency or
# configuration path (not a test path) reruns every gate; an empty or undeterminable delta, a missing tree or a failed diff reruns.
# Safe side = run. A fail, pass_low or unsupported record is never carried.
test_path_globs='**/test/** **/tests/** **/__tests__/** *_test.* *.test.* *.spec.* test_*.* *Test.* *Tests.*'
# A path counts as a test only when it matches a test glob, has a code extension and is not a manifest, lockfile, env file,
# configuration or contract file (a file under tests/ that configures the build or the runtime is product input). Unknown -> no.
test_code_path() { # PATH
  tcp_b=${1##*/}
  path_matches "$1" "$test_path_globs" || return 1
  # the ecosystem data (manifests, locks, settings, risky paths) and the project's own risky_paths decide what is a dependency or build input
  # shellcheck disable=SC2086 # globs without whitespace
  [ "$eco_loaded" = 1 ] || return 1   # without the ecosystem data the manifests are unknown: nothing counts as a test (safe side)
  ! path_matches "$1" "$eco_risky_set $eco_dependency_set $(cfg review.risky_paths '')" || return 1
  case "$tcp_b" in
    *lock*|.env*|*.env|Dockerfile*|docker-compose*|compose.*|Makefile|*config*|*.conf|*.cfg|*.ini|*.toml|*require*|*constrain*|*depend*|openapi*|swagger*|*.proto|*.graphql|*.gql|*.sql|*.json|*.yaml|*.yml|*.xml|*.properties|.*rc) return 1 ;;
  esac
  case "$tcp_b" in
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.py|*.go|*.rs|*.java|*.kt|*.rb|*.php|*.cs|*.swift|*.sh|*.scala|*.ex|*.exs) return 0 ;;
    *_test.*|*.test.*|*.spec.*|test_*.*|*Test.*|*Tests.*) return 0 ;;   # a test by its own name (not a config/contract name: denied above)
  esac
  return 1
}
security_test_words='auth|login|logout|passw|credential|secret|token|session|cookie|csrf|xss|cors|permission|privilege|role|acl|rbac|admin|oauth|jwt|saml|sanitiz|escap|inject|validat|crypt|hash|signature|signing|tls|ssl|cert|owner|tenant|forbidden|unauthori|denied|allowlist|whitelist|blocklist|ssrf|traversal|redirect|upload|rate.?limit|csp|header'
gate_inputs_unchanged() { # ID RECORD GATE MODE NOW
  [ "$4" != strict ] || return 1
  case "$3" in REVIEW_PLAN|REVIEW_RULES|REVIEW_DATA|SECURITY) ;; *) return 1 ;; esac
  [ "$(gate_field "$2" result)" = pass ] || return 1
  giu_delta=$( { cat "${2%.yaml}.manifest"; patch_manifest "$1"; } | sed '/^$/d' | sort | uniq -u | cut -d '|' -f1 | sort -u ) || return 1
  [ -n "$giu_delta" ] || return 1
  for giu_p in $giu_delta; do
    test_code_path "$giu_p" || return 1
    giu_k=$(plan_path_claim "$1" "$giu_p"); [ -z "$giu_k" ] || [ "$giu_k" = test ] || return 1   # A202: the plan's own kind column says the path is not a test: run (a claim can only make the re-run stricter)
  done
  giu_rec=$(gate_field "$2" fingerprint); giu_cur=$5
  if [ "$4" = reuse ]; then
    giu_tree=$(git -C "$root" diff-tree -r --name-only "$giu_rec" "$giu_cur" 2>/dev/null) || return 1
    [ -n "$giu_tree" ] || return 1
    for giu_p in $giu_tree; do printf '%s\n' "$giu_delta" | grep -Fxq -- "$giu_p" || return 1; done
  fi
  [ "$3" = SECURITY ] || return 0
  # SECURITY: a changed test that covers security behavior reruns the gate. Needs both trees; without them: run.
  [ "$4" = reuse ] || giu_cur=$(gate_fingerprint)
  git -C "$root" cat-file -e "$giu_rec^{tree}" 2>/dev/null && git -C "$root" cat-file -e "$giu_cur^{tree}" 2>/dev/null || return 1
  for giu_p in $giu_delta; do
    ! printf '%s\n' "$giu_p" | grep -Eiq "$security_test_words" || return 1
  done
  # shellcheck disable=SC2086 # repository paths without whitespace; a path with one is not carried (the diff fails or misses it: run)
  giu_diff=$(git -C "$root" diff --no-color --no-ext-diff -U0 "$giu_rec" "$giu_cur" -- $giu_delta 2>/dev/null) || return 1
  [ -n "$giu_diff" ] || return 1
  ! printf '%s\n' "$giu_diff" | grep -E '^[+-][^+-]' | grep -Eiq "$security_test_words" || return 1
  return 0
}
# gate_amend_carry ID GATE MODE NOW: the latest record from before the last `amend` that the same input rules keep (gate_inputs_unchanged:
# REVIEW_PLAN, REVIEW_RULES, REVIEW_DATA and SECURITY, a pass, only test-path changes since the record, nothing security-related in them) and
# that is still bound to the frozen contract (a changed plan, task or evidence hash makes it stale in valid_gate_file). Nothing else is
# carried: SECRETS, REVIEW_SMALL, REVIEW_TESTS, QA and VERIFY run again. No answer = not carried.
gate_amend_carry() {
  gac_re=$(last_reopen_seq "$1"); [ "$gac_re" -gt 0 ] || return 0
  case "$2" in REVIEW_PLAN|REVIEW_RULES|REVIEW_DATA|SECURITY) ;; *) return 0 ;; esac
  gac_fc=$(gate_focus "$2"); gac_last=''
  for gac_n in $(gate_names "$1"); do
    gac_f=$(gates_dir "$1")/$gac_n
    [ "$(gate_field "$gac_f" gate)" = "$2" ] && [ "$(gate_field "$gac_f" seq)" -lt "$gac_re" ] && [ "$(gate_field "$gac_f" focus)" = "$gac_fc" ] || continue
    gac_last=$gac_f
  done
  [ -n "$gac_last" ] || return 0
  valid_gate_file "$1" "$gac_last" && gate_inputs_unchanged "$1" "$gac_last" "$2" "$3" "$4" || return 0
  printf '%s\n' "$gac_last"
}
# gate_focus_status ID GATE FOCUS MODE NOW: the latest record of that gate and focus ('-' = the gate's own focus).
gate_focus_status() {
  gfs_id=$1 gfs_gate=$2; gfs_key=fingerprint; [ "$4" != patch ] || gfs_key=patch_sha256
  gfs_last=$(gate_latest_file "$gfs_id" "$gfs_gate" "$3")
  # A200 (item 5): an `amend` discards the records before it, except a pass of a gate whose inputs did not change (same rules as in a fix round)
  if [ -z "$gfs_last" ] && [ "$3" = - ] && [ "$4" != strict ]; then gfs_last=$(gate_amend_carry "$gfs_id" "$gfs_gate" "$4" "$5"); fi
  [ -n "$gfs_last" ] || { echo missing; return 0; }
  if ! valid_gate_file "$gfs_id" "$gfs_last"; then echo stale; return 0; fi
  if [ "$(gate_field "$gfs_last" "$gfs_key")" != "$5" ] && ! { [ "$gfs_key" = fingerprint ] && legacy_fingerprint_match "$(gate_field "$gfs_last" fingerprint)"; }; then
    { [ "$4" != strict ] && [ "$(gate_field "$gfs_last" result)" = pass ] && { focus_untouched "$gfs_id" "$gfs_last" "$3" "$4" "$5" || { [ "$3" = - ] && gate_inputs_unchanged "$gfs_id" "$gfs_last" "$gfs_gate" "$4" "$5"; }; }; } || { echo stale; return 0; }
  fi
  case "$(gate_field "$gfs_last" result)" in
    pass) echo pass ;; pass_low) echo pass_low ;; unsupported) echo unsupported ;;
    fail)
      if fail_fully_waived "$gfs_id" "$gfs_last"; then echo waived
      elif [ "$(gate_field "$gfs_last" seq)" -le "$(last_reopen_seq "$gfs_id" terminal)" ]; then echo stale   # A152: a failure from before a reopen runs again
      else echo fail; fi ;;
    *) echo stale ;;
  esac
}
# A98: a gate that closes with an `unsupported` focus is never shown as a bare pass.
gate_unsupported_focuses() { # ID GATE MODE NOW -> comma list
  guf=''
  for guf_f in $(risk_gate_focuses "$1" "$2"); do
    if [ "$(gate_focus_status "$1" "$2" "$guf_f" "$3" "$4")" = unsupported ]; then guf="$guf${guf:+,}$guf_f"; fi
  done
  printf '%s' "$guf"
}
gate_label() { # ID GATE MODE NOW
  gl_s=$(gate_status "$@"); gl_u=$(gate_unsupported_focuses "$@")
  if [ -n "$gl_u" ]; then printf '%s (unsupported: %s)\n' "$gl_s" "$gl_u"; else printf '%s\n' "$gl_s"; fi
}
gate_satisfied() { case "$1" in pass|waived|unsupported) return 0 ;; *) return 1 ;; esac; }
verify_required_gates() { # ID strict|patch MESSAGE
  vrg_now=''; [ "$2" = patch ] || vrg_now=$(gate_fingerprint); risk_prime "$1"
  for vrg_g in $(required_gates "$1"); do
    vrg_s=$(gate_status "$1" "$vrg_g" "$2" "$vrg_now")
    gate_satisfied "$vrg_s" || fail "$3: required gate $vrg_g of $1 is $vrg_s for the current content. $(gate_fail_hint "$1" "$vrg_g" "$vrg_s") (all gates: 'agent.sh pipeline $1')"
  done
}
# A171: a late example of a finding class the reviewer missed does not use up a fix round. A FAIL record is free
# (carry-over) when every blocking row cites a line that is byte-identical in the revision the same gate and focus
# reviewed before (the line was already there, the reviewer missed it) and that no blocking row of that earlier
# record cited (so a line the implementer was asked to fix and did not still counts). Deterministic: it compares
# the tree of each record's fingerprint, nothing else. A row without a numeric path:line, a tree that is not in the
# object database, or no earlier record: not free.
# finding_key FINGERPRINT LOCATION TEXT: the identity of an observation across revisions. The cited line's text in that
# revision when the location resolves (so a moved line is the same finding), else the normalised finding text.
finding_key() {
  fk_loc=$(printf '%s' "$2" | tr -d ' ')
  fk_t=$(tree_line "$1" "$fk_loc")
  if [ -n "$(printf '%s' "$fk_t" | tr -d '[:space:]')" ]; then printf '%s@%s\n' "${fk_loc%:*}" "$(printf '%s' "$fk_t" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | git hash-object --stdin | cut -c1-12)"
  else printf '%s~%s\n' "${fk_loc%:*}" "$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' ' ' | sed 's/^ //;s/ $//' | git hash-object --stdin | cut -c1-12)"; fi
}
tree_line() { # FINGERPRINT PATH:LINE -> the text of that line in that tree (empty when unknown)
  tl_loc=$2; tl_p=${tl_loc%:*}; tl_n=${tl_loc##*:}; tl_n=${tl_n%%-*}
  case "$tl_n" in ''|*[!0-9]*) return 0 ;; esac
  [ "$tl_n" -gt 0 ] || return 0
  [ "$tl_p" != "$tl_loc" ] || return 0
  git -C "$root" cat-file -p "$1:$tl_p" 2>/dev/null | sed -n "${tl_n}p"
}
tree_line_before() { # OLD-TREE NEW-TREE PATH:LINE -> the line number in OLD-TREE of an unchanged line of NEW-TREE (fails when the diff touches it)
  tb_loc=$3; tb_p=${tb_loc%:*}; tb_n=${tb_loc##*:}; tb_n=${tb_n%%-*}
  case "$tb_n" in ''|*[!0-9]*) return 1 ;; esac
  [ "$tb_p" != "$tb_loc" ] && [ "$tb_n" -gt 0 ] || return 1
  git -C "$root" cat-file -e "$1:$tb_p" 2>/dev/null || return 1
  git -C "$root" diff --no-color --no-ext-diff -U0 "$1" "$2" -- "$tb_p" 2>/dev/null | awk -v n="$tb_n" '
    /^@@ / { h = $0; sub(/^@@ -/, "", h); split(h, a, " "); o = a[1]; c = a[2]; sub(/^\+/, "", c)
      ob = 1; if (index(o, ",")) { split(o, x, ","); ob = x[2] } ; cs = c; cd = 1; if (index(c, ",")) { split(c, y, ","); cs = y[1]; cd = y[2] }
      if (cd > 0 && n >= cs && n <= cs + cd - 1) bad = 1
      if ((cd > 0 && cs + cd - 1 < n) || (cd == 0 && cs < n)) off += ob - cd }
    END { if (bad) exit 1; print n + off }'
}
gate_prev_record() { # ID RECORD -> the latest earlier record of the same gate and focus on another revision (after the last reopen)
  gp_seq=$(gate_field "$2" seq); gp_g=$(gate_field "$2" gate); gp_fc=$(gate_field "$2" focus); gp_fp=$(gate_field "$2" fingerprint)
  gp_ro=$(last_reopen_seq "$1" any); gp_best=''; gp_bs=0
  for gp_n in $(gate_names "$1"); do
    gp_f=$(gates_dir "$1")/$gp_n
    [ "$(gate_field "$gp_f" gate)" = "$gp_g" ] && [ "$(gate_field "$gp_f" focus)" = "$gp_fc" ] || continue
    gp_s=$(gate_field "$gp_f" seq)
    [ "$gp_s" -lt "$gp_seq" ] && [ "$gp_s" -gt "$gp_ro" ] && [ "$gp_s" -gt "$gp_bs" ] || continue
    [ "$(gate_field "$gp_f" fingerprint)" != "$gp_fp" ] || continue
    gp_best=$gp_f; gp_bs=$gp_s
  done
  [ -n "$gp_best" ] && printf '%s\n' "$gp_best"
}
gate_carryover_free() { # ID RECORD -> 0 when the record only carries over examples of an earlier revision
  # only a reviewer gate can miss an example; a mechanical gate (VERIFY, SECRETS, QA) failing is a round
  case "$(gate_field "$2" gate)" in REVIEW_*) ;; *) return 1 ;; esac
  gc_prev=$(gate_prev_record "$1" "$2") || return 1
  gc_fp=$(gate_field "$2" fingerprint); gc_pfp=$(gate_field "$gc_prev" fingerprint)
  # a line that ANY earlier record of this gate and focus already cited (a pass in between does not forget it) is an unfixed
  # finding, not a missed example: it counts as a round
  gc_cited=''; gc_seq=$(gate_field "$2" seq); gc_g=$(gate_field "$2" gate); gc_fc=$(gate_field "$2" focus); gc_ro=$(last_reopen_seq "$1" any)
  for gc_n in $(gate_names "$1"); do
    gc_f=$(gates_dir "$1")/$gc_n
    [ "$(gate_field "$gc_f" gate)" = "$gc_g" ] && [ "$(gate_field "$gc_f" focus)" = "$gc_fc" ] || continue
    gc_s=$(gate_field "$gc_f" seq); [ "$gc_s" -lt "$gc_seq" ] && [ "$gc_s" -gt "$gc_ro" ] || continue
    gc_efp=$(gate_field "$gc_f" fingerprint)
    for gc_loc in $(awk -F'|' '/^finding: / && $2 != "info" { gsub(/ /, "", $3); print ($3 == "" ? "-" : $3) }' "$gc_f"); do
      gc_cited="$gc_cited
${gc_loc%:*}	$(tree_line "$gc_efp" "$gc_loc")"
    done
  done
  gc_rows=0
  for gc_loc in $(awk -F'|' '/^finding: / && $2 != "info" { gsub(/ /, "", $3); print ($3 == "" ? "-" : $3) }' "$2"); do
    gc_rows=$((gc_rows + 1))
    gc_txt=$(tree_line "$gc_fp" "$gc_loc"); [ -n "$(printf '%s' "$gc_txt" | tr -d '[:space:]')" ] || return 1
    # the cited line must exist UNCHANGED at its mapped position in the earlier tree (a new copy of an old line is new code)
    gc_old=$(tree_line_before "$gc_pfp" "$gc_fp" "$gc_loc") || return 1
    [ -n "$gc_old" ] && [ "$(tree_line "$gc_pfp" "${gc_loc%:*}:$gc_old")" = "$gc_txt" ] || return 1
    ! printf '%s\n' "$gc_cited" | grep -Fxq -- "${gc_loc%:*}	$gc_txt" || return 1
  done
  [ "$gc_rows" -gt 0 ]
}
# Fix rounds (D15): one round per distinct content that collected an unwaived blocking FAIL
# under the current frozen contract since the last reopen (A171: a carry-over record is not a round).
fix_rounds_used() {
  fr_reopen=$(last_reopen_seq "$1" any)
  for fr_n in $(gate_names "$1"); do
    fr_f=$(gates_dir "$1")/$fr_n
    [ "$(gate_field "$fr_f" result)" = fail ] || continue
    [ "$(gate_field "$fr_f" seq)" -gt "$fr_reopen" ] || continue
    gate_bound_to_contract "$1" "$fr_f" || continue
    fail_fully_waived "$1" "$fr_f" && continue
    gate_carryover_free "$1" "$fr_f" && continue
    gate_field "$fr_f" fingerprint
  done | sort -u | wc -l | tr -d ' '
}
# Fix rounds performed: fix_rounds_used counts failing contents, and the last failing content after the final fix
# has no round left (3 failing contents with a maximum of 2 is 2 rounds done), so reports never say "3 of 2".
fix_rounds_done() { fd_u=$(fix_rounds_used "$1"); fd_m=$(max_fix_rounds); if [ "$fd_u" -gt "$fd_m" ]; then echo "$fd_m"; else echo "$fd_u"; fi; }
latest_finding_file() {
  g_hit=''
  for g_n in $(gate_names "$1"); do
    g_f=$(gates_dir "$1")/$g_n
    gate_bound_to_contract "$1" "$g_f" || continue
    case "$(gate_field "$g_f" result)" in reopen|fail) g_hit=$g_f ;; esac
  done
  printf '%s\n' "$g_hit"
}
# A fix_scope entry is `path`, `path:line`, `path:line-line` or `path:symbol` (A77); it scopes to the path part.
# Prints the entries of a comma list reduced to paths, one per line, whitespace trimmed, empties dropped.
scope_entry_paths() { printf '%s\n' "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/:.*$//' | sed '/^$/d'; }
# A123: frozen plan-scope paths that share an acceptance criterion with a path of the fix_scope list ($2); a list path
# outside the plan scope contributes no criteria. Prints one path per line.
fix_scope_siblings() { # ID FIX_SCOPE
  scope_mappings "$(run_dir "$1")/PLAN.md" 2>/dev/null | awk -F'|' -v paths="$(scope_entry_paths "$2" | tr '\n' '|')" '
    BEGIN { n = split(paths, pa, "|"); for (i = 1; i <= n; i++) if (pa[i] != "") ip[pa[i]] = 1 }
    { P[NR] = $1; N[NR] = split($2, cs, ","); for (j = 1; j <= N[NR]; j++) { c = cs[j]; gsub(/[[:space:]]/, "", c); C[NR, j] = c; if ($1 in ip) want[c] = 1 } }
    END { for (r = 1; r <= NR; r++) for (j = 1; j <= N[r]; j++) if (C[r, j] in want) { print P[r]; break } }'
}
# The union fix_scope (comma list) of the failing records on the content of finding file $2.
fix_scope_union() { # ID FINDING_FILE
  fu_scope=$(gate_field "$2" fix_scope)
  if [ "$(gate_field "$2" result)" = fail ]; then
    fu_fp=$(gate_field "$2" fingerprint)
    for fu_n in $(gate_names "$1"); do
      fu_o=$(gates_dir "$1")/$fu_n
      [ "$(gate_field "$fu_o" result)" = fail ] && [ "$(gate_field "$fu_o" fingerprint)" = "$fu_fp" ] && fu_scope="$fu_scope,$(gate_field "$fu_o" fix_scope)"
    done
  fi
  printf '%s\n' "$fu_scope"
}
# A123: the paths a fix may touch, one per line: the finding paths plus the frozen plan scope paths sharing an acceptance
# criterion with them. Prints `*` when a finding names no path (any frozen scope path), nothing when no finding is open.
fix_allowed_paths() { # ID
  fa_ff=$(latest_finding_file "$1"); [ -n "$fa_ff" ] || return 0
  fa_sc=$(fix_scope_union "$1" "$fa_ff")
  if [ "$(scope_entry_paths "$fa_sc" | tr -d '\n')" = '*' ]; then echo '*'; return 0; fi
  # A127: a control artifact (PLAN.md, VERIFY.md, ...) is never a fix path: the implementer cannot edit it.
  { scope_entry_paths "$fa_sc"; fix_scope_siblings "$1" "$fa_sc"; } | sort -u | while IFS= read -r fa_p; do fix_path_control "$1" "$fa_p" || printf '%s\n' "$fa_p"; done
}
# A127: only the run's own files: a run path, or a top-level control name as findings spell it; a product path that shares a
# directory name (reports/, design/) is not one.
fix_path_control() { # ID PATH
  case "$2" in
    .agents/runs/"$1"/*) known_control_artifact "$1" "$2" ;;
    PLAN.md|VERIFY.md|TASK.md|RUN.yaml|LEDGER.log|QA_PLAN.md|QA_REPORT.md|EVIDENCE.md|COMPLETION_REPORT.md) known_control_artifact "$1" ".agents/runs/$1/$2" ;;
    *) return 1 ;;
  esac
}
# A127: the number of blocking rows of gate record $2 whose path is a control artifact (the plan answers them). Script rows
# (UNSUPPORTED, risk signal) are not counted, the same split `next` makes with ns_b.
finding_plan_rows() { # ID GATE_FILE
  fpr_n=0
  while IFS='|' read -r _ _ fpr_path fpr_text _; do
    case "$fpr_text" in 'UNSUPPORTED '*|'risk signal '*) continue ;; esac
    visual_row_text "$fpr_text" && continue   # A200: a missing visual report is answered by QA's visual focus, not by the plan
    if fix_path_control "$1" "${fpr_path%%:*}"; then fpr_n=$((fpr_n + 1)); fi
  done <<EOF
$(grep '^finding: [^|]*|blocking|' "$2" || true)
EOF
  printf '%s\n' "$fpr_n"
}
# A200 (item 9): a blocking row about the visual evidence report (missing, or a criterion without it). Neither the plan nor the
# implementer answers it: the QA visual focus produces reviews/visual-proof/report.json, then the verifier reads it.
visual_row_text() { # TEXT
  printf '%s\n' "$1" | grep -Fiq 'reviews/visual-proof/'
}
finding_visual_rows() { # GATE_FILE
  fvr_n=0
  while IFS='|' read -r _ _ _ fvr_text _; do
    case "$fvr_text" in 'UNSUPPORTED '*|'risk signal '*) continue ;; esac
    if visual_row_text "$fvr_text"; then fvr_n=$((fvr_n + 1)); fi
  done <<EOF
$(grep '^finding: [^|]*|blocking|' "$1" || true)
EOF
  printf '%s\n' "$fvr_n"
}
# A200 (item 9): the first blocking rows of a gate record as `ID path: text`, at most N, for the messages that name a failing gate.
gate_blocking_rows() { # GATE_FILE N
  sed -n 's/^finding: \([^|]*\)|blocking|\([^|]*\)|\([^|]*\)|.*/\1 \2: \3/p' "$1" | head -n "$2" | cut -c1-300
}
# gate_fail_hint ID GATE STATUS: the real finding and the real remedy for a gate that does not pass, one line.
gate_fail_hint() {
  gh_id=$1 gh_g=$2 gh_s=$3 gh_rows=''
  case "$gh_s" in
    fail)
      for gh_fc in - $(risk_gate_focuses "$gh_id" "$gh_g"); do
        gh_lf=$(gate_latest_file "$gh_id" "$gh_g" "$gh_fc"); [ -n "$gh_lf" ] || continue
        [ "$(gate_field "$gh_lf" result)" = fail ] || continue
        gh_rows="$gh_rows$(gate_blocking_rows "$gh_lf" 2 | tr '\n' ';')"
      done
      printf 'first blocking finding(s): %s next step: agent.sh next %s' "${gh_rows:-(none readable in the record)}" "$gh_id" ;;
    stale|missing)
      case "$gh_g" in
        SECRETS) printf 'run: agent.sh secret-scan %s' "$gh_id" ;;
        REVIEW_*) printf 'run: dispatch.sh %s reviewer --focus %s' "$gh_id" "$(gate_focus "$gh_g")" ;;
        *) printf 'run: dispatch.sh %s %s' "$gh_id" "$(gate_owner "$gh_g")" ;;
      esac ;;
  esac
}
# `next` lines naming the allowed fix paths of an open fix round, to paste into the implementer's ALLOWED_SCOPE (A123).
fix_paths_lines() { # ID
  fl_ff=$(latest_finding_file "$1"); [ "$(gate_field "${fl_ff:-/dev/null}" result 2>/dev/null)" = fail ] || return 0
  fix_allowed_paths "$1" | sed 's/^/fix_path=/'
}

# Tree-attested mutation ownership under orchestrated topology (dispatch.sh brackets the implementer
# with window-open / window-close).
window_files() { ls -1 "$(worker_evidence_dir "$1")" 2>/dev/null | grep -E '^WINDOW-[0-9]+\.yaml$' | sort -t - -k2,2n || true; }
pristine_tree() { printf '' | sha256; }
last_attested_tree() {
  n=$(pristine_tree)
  for f in $(window_files "$1"); do n=$(evidence_field "$(worker_evidence_dir "$1")/$f" after_sha256); done
  printf '%s\n' "$n"
}
verify_mutation_ownership() {
  g_id=$1 g_force=${2:-0}; gates_enforced "$g_id" || return 0
  g_d=$(run_dir "$g_id"); g_topo=$(resolve_topology "$g_d")
  [ "$g_topo" = orchestrated ] || return 0
  g_hs=$(section_value "$g_d" handoff state)
  case "$g_hs" in IMPLEMENTED|CODE_DONE|DONE) ;; *) [ "$g_force" = 1 ] || return 0 ;; esac
  g_prev_after=$(pristine_tree); g_ev=$(worker_evidence_dir "$g_id")
  for g_w in $(window_files "$g_id"); do
    case "$(canon_role "$(evidence_field "$g_ev/$g_w" role)")" in implementer|designer) ;;
      # a window the USER accepted with `tree-accept` (recovery): only when the ledger binds this very file to that command
      user) [ -n "$(bound_names "$g_d" worker-evidence 'tree-accept$' "$g_w")" ] || fail "worker window ${g_w%.yaml} claims the user's acceptance but no tree-accept command bound it in the ledger" ;;
      *) fail "worker window ${g_w%.yaml} was not attested for the implementer or designer" ;; esac
    [ "$(evidence_field "$g_ev/$g_w" before_sha256)" = "$g_prev_after" ] || fail "unattributed application/test mutation before ${g_w%.yaml}: the tree changed between worker windows outside the implementer"
    g_prev_after=$(evidence_field "$g_ev/$g_w" after_sha256)
  done
  g_tree=$(task_patch_fingerprint "$g_id")
  [ "$g_tree" = "$g_prev_after" ] || fail "application/test tree ($g_tree) is not the last implementer-attested tree ($g_prev_after): a mutation was made outside the implementer under orchestrated topology; undo it and route the change through the implementer (dispatch.sh), or keep the run: agent.sh tree-inspect '$g_id' shows the change and agent.sh tree-accept '$g_id' asks the user to accept it (every gate then runs again)"
}
window_role() { case "${1:-implementer}" in implementer|designer) printf '%s\n' "${1:-implementer}" ;; *) fail "worker windows bracket the implementer or the designer, not $1" ;; esac; }
window_open() { # ID [ROLE]
  g_id=$1; window_role "${2:-}" >/dev/null; require_run "$g_id"; gates_enforced "$g_id" || return 0
  require_open_run "$g_id"
  g_d=$(run_dir "$g_id"); [ "$(resolve_topology "$g_d")" = orchestrated ] || return 0
  [ "$(section_value "$g_d" handoff state)" != PLANNED ] || [ "$(plan_destructive "$g_d/PLAN.md")" != yes ] || fail "worker windows are opened only while handoff state is IMPLEMENTING: this destructive plan is frozen at PLANNED and needs a destructive approval bound to the current PLAN.md first ('agent.sh next $g_id', 'agent.sh request-approval $g_id destructive', then 'agent.sh handoff $g_id IMPLEMENTING')"
  [ "$(section_value "$g_d" handoff state)" = IMPLEMENTING ] || fail "worker windows are opened only while handoff state is IMPLEMENTING"
  verify_seal "$g_id"; verify_mutation_ownership "$g_id" 1
  task_patch_fingerprint "$g_id"
}
window_close() { # ID BEFORE [EXIT-STATUS] [ROLE]
  g_id=$1 g_before=$2 g_status=${3:-0}; g_wrole=$(window_role "${4:-}"); require_run "$g_id"; gates_enforced "$g_id" || return 0
  require_open_run "$g_id"
  g_d=$(run_dir "$g_id"); [ "$(resolve_topology "$g_d")" = orchestrated ] || return 0
  [ -n "$g_before" ] || fail "window-close requires the fingerprint printed by window-open"
  [ "$(section_value "$g_d" handoff state)" = IMPLEMENTING ] || fail "worker windows are closed only while handoff state is IMPLEMENTING"
  [ "$g_before" = "$(last_attested_tree "$g_id")" ] || fail "worker window began at a tree that is not the last attested one: unattributed mutation"
  g_ev=$(worker_evidence_dir "$g_id"); mkdir -p "$g_ev" || fail "cannot create $g_ev"
  g_n=$(next_evidence_seq "$g_ev" WINDOW)
  {
    printf 'task_id: "%s"\nseq: %s\nrole: "%s"\ntopology: "orchestrated"\n' "$g_id" "$g_n" "$g_wrole"
    printf 'before_sha256: "%s"\nafter_sha256: "%s"\nexit_status: "%s"\n' "$g_before" "$(task_patch_fingerprint "$g_id")" "$g_status"
    printf 'timestamp: "%s"\n' "$(now_iso)"
  } > "$g_ev/WINDOW-$g_n.yaml" || fail "could not write worker window record"
  echo "worker window recorded: $g_id WINDOW-$g_n"
}
verify_lifecycle_gates() {
  g_id=$1; gates_enforced "$g_id" || return 0
  g_hs=$(section_value "$(run_dir "$g_id")" handoff state)
  verify_seal "$g_id"
  verify_mutation_ownership "$g_id"
  case "$g_hs" in CODE_DONE|DONE) verify_required_gates "$g_id" patch "gate evidence missing or stale" ;; esac
}


hdr() { sed -n "s/^$1=//p" "$2" | head -1; }
next_num() { # DIR -> next NNN over files whose name starts with three digits
  nn_max=0
  for nn_f in "$1"/[0-9][0-9][0-9]*; do
    [ -e "$nn_f" ] || continue
    nn_v=$(seq3 "$nn_f"); nn_v=${nn_v:-0}
    [ "$nn_v" -le "$nn_max" ] || nn_max=$nn_v
  done
  printf '%03d\n' $((nn_max + 1))
}
# A200 (item 8): the comparison of a recorded output line with a re-run normalizes a NARROW, listed set of volatile fields, in
# both the recorded line and every re-run line, and nothing else. The list (each rule is tested, tests/enforcement and the
# reproduce scenarios):
#   1. an ISO-8601 timestamp (date, T or space, clock, optional fraction and zone)      -> <TIMESTAMP>
#   2. a wall-clock time HH:MM:SS (optional fraction)                                    -> <TIME>
#   3. a duration right after in / took / duration / elapsed / time (number and unit s, ms, sec, secs, seconds, min, m)  -> <DURATION>
#   4. a duration alone in parentheses, "(12ms)" or "(1.5 s)"                            -> (<DURATION>)
#   5. the build tool's completion line "[build] Complete!" (with or without a time prefix or a trailing duration) -> [build] Complete!
# Not in the list, so never normalized: counts, test names, versions, paths, dates without a clock, pids, hashes, ids, any word. A real
# difference ("3 passed" against "4 passed", "Done in 3s" against "Built in 3s") stays a difference.
repro_normalize() {
  sed -E \
    -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?/<TIMESTAMP>/g' \
    -e 's/(^|[^0-9:])[0-9]{1,2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?/\1<TIME>/g' \
    -e 's/((^|[^A-Za-z])([Ii]n|[Tt]ook|[Dd]uration|[Ee]lapsed|[Tt]ime)[ :=]+)[0-9]+(\.[0-9]+)? ?(ms|sec|secs|seconds|min|s|m)([^A-Za-z0-9]|$)/\1<DURATION>\6/g' \
    -e 's/\([0-9]+(\.[0-9]+)? ?(ms|s)\)/(<DURATION>)/g' \
    -e 's/^(<TIME> )?\[build\] Complete!( in <DURATION>| \(<DURATION>\))?$/[build] Complete!/'
}
# A102: an UNSUPPORTED result is backed by the skill validator's own saved output, not by a reason alone.
# unsupported_evidence_check ID ROLE FOCUS RAW -> "<path> <sha256>", or the refusal text and exit 1.
# The file: inside the run (the focus's report folder or reports/, normally the snapshot `submit` made, A43),
# its sha256 as cited, holding the validator's `RESULT: UNSUPPORTED` line (visual: or INCONCLUSIVE); a printed
# `BASE:` must be the run's base or a base before an accepted control-plane-only move (A161). Cross-checks that do not depend on the agent: every contract file this script's
# own signals found in the diff is listed by the differ (`FILE: compared|unsupported <path>`, at least one
# unsupported), and every changed .sql migration is listed `FILE: unsupported <path>` by validate-migration --repo.
# base_moved_lines ID: the run's real `base-moved` ledger lines, anchored to the line structure ledger_append writes
# (`seq=N prev=H event=base-moved role=R from=F to=T digest=D ts=T epoch=E detail=base_sha moved ...`). The free text of
# another event (a lead's ledger-note) can contain the same words; it is never at that position (A161).
base_moved_lines() {
  grep -E '^seq=[0-9]+ prev=[^ ]+ event=base-moved role=[^ ]* from=[^ ]* to=[^ ]* digest=[^ ]* ts=[^ ]* epoch=[^ ]* detail=base_sha moved \(' "$(ledger_file "$1")" 2>/dev/null || :
}
# --- Language check (A33): run artifacts are English. -----------------------------------------
# Heuristic: three or more letters outside ASCII and the common typographic symbols (UTF-8 lead bytes of
# Latin letters C3 C4 C5, Greek CE CF, Cyrillic D0-D4, CJK E3-E9) in one file are non-English text; one or
# two (a name such as "José") are tolerated. Exempt (A171, A172):
#  - a `>` quote line or a fenced line that repeats a line of a captured user prompt (prompts/history): the user's own words;
#  - product text: inline code (`...`), a double-quoted span ("..." or “...”), a `>` quote line or a fenced line (a JSON
#    string value is a double-quoted span) whose WHOLE inner text, whitespace normalized, occurs in the run's TASK.md or in
#    COMMITTED product content (`git grep` on HEAD outside .agents/: never the index, the working tree or an untracked file, because
#    an agent can create or stage a file holding its own text and quote it; only a commit, which a model cannot make, counts).
#    The piece is at least 4 characters and is matched on word boundaries: a letter right before or after the match is no match.
#    The match is on the inner text, never on the delimiter: a model cannot hide a sentence of its own behind a quote, a code span or a fence;
#  - machine output of the skills (reviews/visual-proof/, reports/qa-evidence/): measured and saved by tools, never written by a model.
#    An accepted, unchecked channel (A172): a model that is allowed to write there could put text there.
# language_scan FILE... -> prints "file:line" (where the third such letter appears) per offending file; exit 1.
# Cost: a file is scanned once without product text (an English write costs one awk pass). Only a file with a hit gathers its quoted
# pieces (language_awk cands), at most 1000 characters each, and looks them up without a scan per piece (language_ok_pieces); the
# committed text is read once per HEAD commit (language_head cache), and both sides are marked at word boundaries (language_mark).
language_awk() { # FILE OWN HISTORY-BLOB MODE(scan|cands) OK-PIECES-FILE|'' -> scan: the line where the third foreign letter appears; cands: the quoted pieces to look up
  LC_ALL=C awk -v own="$2" -v hist="$3" -v mode="$4" -v okf="$5" -v minc=4 '
    BEGIN { while ((getline l < hist) > 0) blob = blob "\n" l "\n"
      if (okf != "") { while ((getline l < okf) > 0) ok[l] = 1; close(okf) } }
    function trim(t) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", t); return t }
    function norm(t) { gsub(/[[:space:]]+/, " ", t); return trim(t) }
    function nchars(t) { gsub(/[\200-\277]/, "", t); return length(t) }
    function quoted(t) { t = trim(t); return t == "" || index(blob, "\n" t "\n") > 0 }
    function inprod(t) { t = norm(t); if (nchars(t) < minc || length(t) > 1000) return 0; if (mode == "cands") { want[t] = 1; return 0 } return (t in ok) }
    function foreign(t) { return gsub(/\303[\200-\226\230-\266\270-\277]|[\304\305\316\317\320-\324]|[\343-\351][\200-\277]/, "&", t) }
    function strip_spans(t,   out, rest, b, bo, i, after, j, inner, closer) {
      out = ""; rest = t
      while (1) {
        b = 0; bo = ""
        i = index(rest, "`");           if (i > 0 && (b == 0 || i < b)) { b = i; bo = "`" }
        i = index(rest, "\"");          if (i > 0 && (b == 0 || i < b)) { b = i; bo = "\"" }
        i = index(rest, "\342\200\234"); if (i > 0 && (b == 0 || i < b)) { b = i; bo = "\342\200\234" }
        if (b == 0) break
        closer = (bo == "\342\200\234") ? "\342\200\235" : bo
        after = substr(rest, b + length(bo)); j = index(after, closer)
        if (j == 0) break
        inner = substr(after, 1, j - 1)
        if (inprod(inner)) out = out substr(rest, 1, b - 1) " "
        else out = out substr(rest, 1, b - 1 + length(bo) + j - 1 + length(closer))
        rest = substr(after, j + length(closer))
      }
      return out rest
    }
    /^[[:space:]]*```/ { fence = !fence; next }
    { t = $0; skip = 0
      if (fence || $0 ~ /^[[:space:]]*>/) {
        if (own == "yes") skip = 1
        else { sub(/^[[:space:]]*>[[:space:]]?/, "", t); if (quoted(t) || inprod(t)) skip = 1 }
      }
      if (skip || foreign(t) == 0) next
      c = foreign(strip_spans(t))
      if (c > 0) { total += c; if (total >= 3 && !at) at = NR } }
    END { if (mode == "cands") { for (k in want) print k } else if (at) print at }' "$1"
}
# language_mark: stdin -> stdout, a control byte (\001) after every letter that ends a word and before every letter that starts one,
# and at the line edges. A word character is anything but ASCII punctuation, space and control bytes (every byte of a UTF-8 letter
# counts). A marked piece found in the marked corpus therefore begins and ends on word boundaries.
language_mark() {
  lm_s=$(printf '\001')
  sed -E "s/([^[:punct:][:space:][:cntrl:]])([[:punct:][:space:][:cntrl:]])/\\1${lm_s}\\2/g; s/([[:punct:][:space:][:cntrl:]])([^[:punct:][:space:][:cntrl:]])/\\1${lm_s}\\2/g; s/^([^[:punct:][:space:][:cntrl:]])/${lm_s}\\1/; s/([^[:punct:][:space:][:cntrl:]])\$/\\1${lm_s}/"
}
# language_head -> sets ls_hc (the marked, whitespace-collapsed COMMITTED product text: `git grep -I` on HEAD outside .agents/, text files
# only, capped at 50 MB) and ls_hw (its sorted unique words). Both are cached under .agents/local/language/ by the HEAD commit id, which
# fixes their content, so the 8 MB are read once per commit and not on every write. Empty when the repository has no commit.
language_head() {
  ls_hc=''; ls_hw=''
  lh_sha=$(git -C "$root" rev-parse -q --verify HEAD 2>/dev/null) || return 0
  lh_dir=$agents/local/language
  mkdir -p "$lh_dir" 2>/dev/null || lh_dir=$(mktemp -d "${TMPDIR:-/tmp}/proofline-lang-head.XXXXXX")
  ls_hc=$lh_dir/$lh_sha.corpus; ls_hw=$lh_dir/$lh_sha.words
  if [ ! -s "$ls_hw" ] || [ ! -f "$ls_hc" ]; then
    git -C "$root" grep -I -h -e '' HEAD -- . ':(exclude).agents' 2>/dev/null | head -c 50000000 | tr -s '[:space:]' ' ' | language_mark > "$ls_hc.$$" || :
    tr -s '[:punct:][:space:][:cntrl:]' '\n' < "$ls_hc.$$" | sed '/^$/d' | sort -u > "$ls_hw.$$"
    mv "$ls_hc.$$" "$ls_hc"; mv "$ls_hw.$$" "$ls_hw"   # the words file last: it marks the pair complete
    for lh_f in "$lh_dir"/*.corpus "$lh_dir"/*.words; do case "$lh_f" in "$lh_dir/$lh_sha".*) ;; *) rm -f "$lh_f" ;; esac; done
  fi
}
# language_extra FILE -> the path of a small marked corpus: the run's TASK.md and the captured user prompts. The run is the one FILE
# lives in (or LANG_HINT, the path the write hook passes), else the active run.
language_extra() {
  le_t=$(mktemp "${TMPDIR:-/tmp}/proofline-corpus.XXXXXX"); le_p=${LANG_HINT:-$1}; le_run=''
  case "$le_p" in *.agents/runs/*) le_run=${le_p#*.agents/runs/}; le_run=${le_run%%/*} ;; esac
  [ -n "$le_run" ] || le_run=$(head -n 1 "$root/.agents/local/ACTIVE_RUN" 2>/dev/null || :)
  case "$le_run" in ''|*[!A-Za-z0-9._-]*) le_run='' ;; esac
  {
    [ -z "$le_run" ] || cat "$(run_dir "$le_run")/TASK.md" 2>/dev/null || :
    cat "$(shared_dir prompts)"/history/*.txt 2>/dev/null || :
  } | tr -s '[:space:]' ' ' | language_mark > "$le_t"
  printf '%s\n' "$le_t"
}
# language_ok_pieces FILE OWN HISTORY-BLOB EXTRA -> the path of a file with the quoted pieces of FILE that occur in the product text.
# Three steps, none of them a scan per piece: (1) a piece with a word that no corpus holds is absent (comm over sorted word lists);
# (2) the few pieces whose words all exist are searched in ONE pass over each corpus with one alternation pattern, in chunks;
# (3) a piece counts when its marked form lies inside a match (a longer piece can hide a shorter one from the leftmost-longest match).
# language_confirm PIECE: the piece (whitespace normalized) occurs in one line of committed content (HEAD, outside .agents/), on word
# boundaries: a letter right before or after it is no match. Runs of spaces in the piece match any whitespace run. Exit 0 when it does.
language_confirm() {
  lc_pat=$(printf '%s' "$1" | sed -e 's/[][\\.^$*+?(){}|]/\\&/g' -e 's/ /[[:space:]]+/g')
  case "$1" in [[:punct:][:space:]]*) lc_pre='' ;; *) lc_pre='(^|[[:punct:][:space:]])' ;; esac
  case "$1" in *[[:punct:][:space:]]) lc_post='' ;; *) lc_post='($|[[:punct:][:space:]])' ;; esac
  git -C "$root" grep -q -I -E -e "$lc_pre$lc_pat$lc_post" HEAD -- . ':(exclude).agents' 2>/dev/null
}
language_ok_pieces() {
  lo_c=$(mktemp "${TMPDIR:-/tmp}/proofline-pieces.XXXXXX"); lo_o=$lo_c.ok; lo_h=$lo_c.h; lo_w=$lo_c.w; lo_a=$lo_c.a; lo_s=$lo_c.s; lo_m=$lo_c.m
  language_awk "$1" "$2" "$3" cands "" | sed '/^$/d' > "$lo_c"
  : > "$lo_o"
  if [ -s "$lo_c" ]; then
    tr -s '[:punct:][:space:][:cntrl:]' '\n' < "$lo_c" | sed '/^$/d' | sort -u > "$lo_w"
    { comm -23 "$lo_w" "${ls_hw:-/dev/null}"; } > "$lo_a"
    tr -s '[:punct:][:space:][:cntrl:]' '\n' < "$4" | sed '/^$/d' | sort -u > "$lo_w"
    comm -23 "$lo_a" "$lo_w" > "$lo_a.2"
    awk -v af="$lo_a.2" 'BEGIN { while ((getline w < af) > 0) gone[w] = 1 }
      { n = split($0, ws, /[[:punct:][:space:][:cntrl:]]+/); for (i = 1; i <= n; i++) if (ws[i] in gone) next; print }' "$lo_c" > "$lo_s"
    if [ -s "$lo_s" ]; then
      language_mark < "$lo_s" > "$lo_m"
      awk -v eo="$lo_o" -v ho="$lo_h" -v cf="$lo_m" -v c1="${ls_hc:-}" -v c2="$4" 'BEGIN {
          while ((getline l < cf) > 0) { m[++k] = l; e = l; gsub(/[][\\.^$*+?(){}|\/]/, "\\\\&", e); re = re (re == "" ? "" : "|") e }
          for (q = 1; q <= 2; q++) { f = (q == 1 ? c1 : c2); if (f == "") continue
            s = ""; getline s < f; n = length(s)
            for (p = 1; p <= n; p += 2000) { c = substr(s, p, 4000)
              while (match(c, re)) { hit[q, substr(c, RSTART, RLENGTH)] = 1; c = substr(c, RSTART + 1) } } }
          while ((getline o < ARGV[1]) > 0) { i++; inH = 0; inE = 0
            for (h in hit) { split(h, hk, SUBSEP); if (index(hk[2], m[i]) > 0) { if (hk[1] == 2) inE = 1; else inH = 1 } }
            if (inE) print o > eo; else if (inH) print o > ho } }' "$lo_s"
    fi
  fi
  # The cached committed text only PRE-FILTERS: a file under .agents/local/ can be written by a runtime with no write hook, so a piece
  # that only the cache vouches for is confirmed against HEAD itself (git grep, one per piece, never a scan of lines). A forged hit is
  # refused here; a forged miss only refuses a quote. TASK.md and the user's prompts need no confirmation.
  if [ -s "$lo_h" ]; then
    while IFS= read -r lo_p; do language_confirm "$lo_p" && printf '%s\n' "$lo_p" >> "$lo_o"; done < "$lo_h"
  fi
  rm -f "$lo_c" "$lo_w" "$lo_a" "$lo_a.2" "$lo_s" "$lo_m" "$lo_h"
  printf '%s\n' "$lo_o"
}
# language_question_file PATH: 0 when PATH is exactly <...>/.agents/runs/<ID>/questions/NNN.md (A178). The remainder after `.agents/runs/<ID>/`
# is compared as a whole, so a file in a deeper folder (results/questions/001.md, reviews/a/questions/001.md) is never taken for one.
language_question_file() {
  lq_r="/$1"; case "$lq_r" in *"/.agents/runs/"*) lq_r=${lq_r#*"/.agents/runs/"} ;; *) return 1 ;; esac
  case "$lq_r" in */*) lq_r=${lq_r#*/} ;; *) return 1 ;; esac   # drop <ID>/
  case "$lq_r" in questions/[0-9][0-9][0-9].md) return 0 ;; *) return 1 ;; esac
}
language_scan() {
  ls_rc=0; ls_blob=$(mktemp "${TMPDIR:-/tmp}/proofline-lang.XXXXXX"); ls_extra=''; ls_hc=''; ls_hw=''; ls_ready=no
  cat "$(shared_dir prompts)"/history/*.txt > "$ls_blob" 2>/dev/null || :
  for ls_f in "$@"; do
    [ -f "$ls_f" ] || continue
    case "$ls_f" in */runs/*/reviews/visual-proof/*|*/runs/*/reports/qa-evidence/*) continue ;; esac   # machine output (A172)
    ! language_question_file "$ls_f" || continue   # the question block `ask` and `record` store: addressed to the user in the user's language (A99, A178)
    # A171 (review): the user's answers are written by the script as a quote block and are exempt whole; in any other file a quote
    # line or a fenced line is exempt only when its text is a line of a captured user prompt (prompts/history) or product text
    # (A172, above), so a model cannot hide its own non-English text behind '> ' or a fence.
    ls_own=no; case "$ls_f" in */questions/*.answer.md|*/questions/*.answer.amended-*.md|*/approvals/*|*/runs/*/TASK.md) ls_own=yes ;; esac
    # A202: the summary block at the top of COMPLETION_REPORT.md (at most five lines, checked at publish) is written in the user's language;
    # its lines are blanked (line numbers kept) for the scan. Everything else in the report stays English.
    ls_scan=$ls_f
    case "$ls_f:${LANG_HINT:-}" in */COMPLETION_REPORT.md:*|*:*COMPLETION_REPORT.md)
      ls_scan=$(mktemp "${TMPDIR:-/tmp}/proofline-lang-sum.XXXXXX") && report_blank_summary "$ls_f" > "$ls_scan" || ls_scan=$ls_f ;;
    esac
    ls_hit=$(language_awk "$ls_scan" "$ls_own" "$ls_blob" scan "")
    if [ -n "$ls_hit" ]; then
      if [ "$ls_ready" = no ]; then language_head; ls_extra=$(language_extra "$ls_f"); ls_ready=yes; fi
      ls_ok=$(language_ok_pieces "$ls_scan" "$ls_own" "$ls_blob" "$ls_extra")
      ls_hit=$(language_awk "$ls_scan" "$ls_own" "$ls_blob" scan "$ls_ok")
      rm -f "$ls_ok"
    fi
    [ "$ls_scan" = "$ls_f" ] || rm -f "$ls_scan"
    if [ -n "$ls_hit" ]; then printf '%s:%s\n' "${ls_f#"$root"/}" "$ls_hit"; ls_rc=1; fi
  done
  rm -f "$ls_blob" "$ls_extra"
  return "$ls_rc"
}
language_fail_text() { printf "language: run artifacts are English, but %s holds non-English text. Do NOT transliterate it to ASCII (never turn the Turkish letters into plain c, s, g, i, u, o: product text and quotes stay as the project writes them) and do NOT ask the user: quote the text that exists in the project instead. A quote is exempt when it is inline code (\`...\`), a double-quoted span (\"...\"), a '> ' quote line or a JSON string value and its exact text (whitespace normalized, at least 4 characters) occurs in this run's TASK.md or in a product file COMMITTED to git (HEAD; never a staged, modified or untracked file) outside .agents/, on word boundaries; the user's own messages are quoted verbatim in a '> ' block. Text that this task writes into new or changed files cannot be quoted until it is committed, except through TASK.md: put the text in TASK.md to quote it (A171, A172). Write everything else in English" "$1"; }
# language_check FILE|- [PATH]: the write-time check (A171, the runtime write hook calls it with the text about to be written; stdin for -;
# PATH is the run-relative file being written, which names the run whose TASK.md holds the quotable product text).
# Exit 1 and the "file:line" hit when the text holds non-English text outside the exemptions above.
language_check() {
  lk_f=${1:--}; lk_t=''; LANG_HINT=${2:-}
  if [ "$lk_f" = - ]; then lk_t=$(mktemp "${TMPDIR:-/tmp}/proofline-lang.XXXXXX"); cat > "$lk_t"; lk_f=$lk_t; fi
  lk_hit=$(language_scan "$lk_f") && lk_rc=0 || lk_rc=1
  [ -z "$lk_t" ] || rm -f "$lk_t"
  if [ "$lk_rc" = 1 ]; then printf '%s\n' "$(language_fail_text "line ${lk_hit##*:}")"; return 1; fi
  return 0
}

# --- Submission: how a specialist's result enters a run (D12) ----------------------------------
# `submit` takes facts (result, confidence, findings, artifact) and builds the protocol header itself: the
# role, task, focus, content fingerprint and the artifact's run-relative path and sha256 are never typed by a
# model. The assembled message goes through `record`, so every validation rule stays in one place; a rejection
# is returned to the specialist immediately (exit 1). The outcome is also written to
# .agents/local/submissions/<AGENT>.status so a runtime hook or dispatch.sh reads the record instead of
# parsing a final message.
submission_dir() { printf '%s/local/submissions\n' "$agents"; }

# --- Mutation budget floor: one claim mutant per distinct AC of PLAN `## Tests` ----------------
plan_test_acs() { awk '/^## /{ i = ($0 ~ /^## Tests/); next } i && match(toupper($0), /^[ \t]*[-*][ \t]+AC-[0-9]+:/) { a = toupper(substr($0, RSTART, RLENGTH)); sub(/^[^A]*/, "", a); sub(/-0+/, "-", a); seen[a] = 1 } END { n = 0; for (k in seen) n++; print n }' "$1"; }
# Budget in force: the larger of config test_trust.mutation_budget and the user-approved per-run override.
mutation_budget() {
  mb_b=$(cfg test_trust.mutation_budget 20); mb_o=$(cat "$(run_dir "$1")/mutation_budget" 2>/dev/null || :)
  case "$mb_b" in ''|*[!0-9]*) mb_b=20 ;; esac; case "$mb_o" in ''|*[!0-9]*) mb_o=0 ;; esac; mb_o=$(printf '%s' "$mb_o" | sed 's/^0*//'); [ -n "$mb_o" ] || mb_o=0
  # the override counts only with the raise-budget ledger row that wrote it (a file alone could be written by any role)
  grep -q "event=raise-budget .*test_trust.mutation_budget $mb_o for this run" "$(ledger_file "$1")" 2>/dev/null || mb_o=0
  if [ "$mb_o" -gt "$mb_b" ]; then echo "$mb_o"; else echo "$mb_b"; fi
}

# --- Approvals (D3/D16): single-use, from a TTY or a runtime prompt capture ----------------
# Prompt capture: .agents/local/prompts/<session>.json, one JSON object written by a runtime hook:
#   {"session":"<id>","time":<epoch seconds>,"sha256":"<sha256 of text>","text":"<the user's prompt>"}
valid_approval_kind() {
  case "$1" in
    plan|destructive|single_step|scope|budget|mutation_budget|tree|commit|push|pr|merge|cleanup|report|batch|commands|rename|known-issue|scale) return 0 ;;
    waive:*|rule:*|reopen:*|rationale:*) case "${1#*:}" in ''|*[!A-Za-z0-9_.+-]*) return 1 ;; esac; return 0 ;;
    *) return 1 ;;
  esac
}
kind_slug() { printf '%s\n' "$1" | tr ':' '-'; }
approvals_dir() { if [ "$1" = - ]; then shared_dir approvals; else printf '%s/approvals\n' "$(run_dir "$1")"; fi; }
# approval_target ID KIND: a run, or `-` (no active run; commit and push approvals only, kept in .agents/local/).
approval_target() {
  valid_approval_kind "$2" || fail "invalid approval kind: $2 (want plan|destructive|single_step|scope|budget|mutation_budget|tree|commit|push|pr|merge|cleanup|report|batch|commands|rename|known-issue|scale|waive:<FINDING-ID>|rule:<LESSON-ID>|reopen:<ID>|rationale:<PATTERN-ID>)"
  if [ "$1" = - ]; then case "$2" in commit|push|pr|merge|cleanup|report|batch|commands|rename|known-issue|scale) return 0 ;; *) fail "approval kind $2 needs a run" ;; esac; fi
  require_run "$1"
  # A152: a FAILED or BLOCKED run takes the approvals of its reopen (the reopen itself and the budget decision asked first)
  case "$2" in
    reopen:*) [ "${2#reopen:}" = "$1" ] || fail "approval kind $2 names another run; the kind for $1 is reopen:$1"
      case "$(run_state "$(run_dir "$1")")" in FAILED|BLOCKED) return 0 ;; *) fail "approval kind $2 is for a FAILED or BLOCKED run; $1 is $(run_state "$(run_dir "$1")")" ;; esac ;;
    mutation_budget) return 0 ;;
  esac
  require_open_run "$1"
}
ledger_if() { if [ "$1" != - ] && gates_enforced "$1"; then ledger_append "$@"; fi; }
# commit/push bind the content fingerprint, plan-like kinds the PLAN.md hash, waive:<F> the failing gate
# record (name and sha256) and the finding id, so a later round's same-numbered finding never reuses it.
# A200 (item 6): a DESIGN.md `## Pattern justifications` line `- <pattern-id>: <reason>` downgrades a visual-proof pattern finding
# (blocking -> info) only when the USER approved that exact line: approval kind rationale:<pattern-id>, bound to the sha256 of the
# text "<pattern-id>: <reason>". An agent can write the line; it cannot write the approval (approve reads the user's reply).
design_md_candidates() { printf '%s\n' DESIGN.md docs/design/DESIGN.md docs/DESIGN.md design/DESIGN.md; }
rationale_line_in() { # PATTERN-ID FILE -> "<id>: <reason>" of the first non-empty justification line (the parser lint-source.mjs uses)
  awk -v id="$1" '
    /^[[:space:]]?[[:space:]]?[[:space:]]?#+[[:space:]]/ { h = $0; sub(/^[[:space:]]*#+[[:space:]]*/, "", h); sub(/[[:space:]]*#*[[:space:]]*$/, "", h); inside = (tolower(h) == "pattern justifications"); next }
    inside && match($0, /^[[:space:]]*[-*+][[:space:]]+`?[a-z][a-z0-9-]*`?[[:space:]]*:/) {
      l = $0; sub(/^[[:space:]]*[-*+][[:space:]]+/, "", l); k = l; sub(/[[:space:]]*:.*/, "", k); gsub(/`/, "", k)
      v = l; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v)
      if (k == id && v != "") { print id ": " v; exit } }' "$2"
}
rationale_line() { # PATTERN-ID [FILE] -> the line in the named file, else in the first DESIGN.md candidate that has it
  if [ -n "${2:-}" ]; then [ ! -f "$2" ] || rationale_line_in "$1" "$2"; return 0; fi
  for rl_c in $(design_md_candidates); do
    [ -f "$root/$rl_c" ] || continue
    rl_t=$(rationale_line_in "$1" "$root/$rl_c"); [ -z "$rl_t" ] || { printf '%s\n' "$rl_t"; return 0; }
  done
  return 0
}
rationale_bound() { # PATTERN-ID [FILE] -> sha256 of the justification line text, fails when there is none
  rb_t=$(rationale_line "$@"); [ -n "$rb_t" ] || fail "DESIGN.md has no non-empty '- ${1}: <reason>' line under '## Pattern justifications': write the reason first, then ask the user"
  printf '%s' "$rb_t" | sha256
}
# design-rationales ID: the justification lines of DESIGN.md and whether the user approved each (read-only). With --json: the object
# visual-proof's lint-source takes as --approved-rationales ({"approved": {"<pattern-id>": "<sha256 of the line>"}}).
design_rationales() { # ID [--json] [FILE]
  dr_id=$1 dr_json=no; shift
  [ "${1:-}" != --json ] || { dr_json=yes; shift; }
  dr_f=${1:-}
  if [ -z "$dr_f" ]; then for dr_c in $(design_md_candidates); do [ ! -f "$root/$dr_c" ] || { dr_f=$root/$dr_c; break; }; done; fi
  dr_ids=''
  [ -z "$dr_f" ] || dr_ids=$(awk '/^[[:space:]]?[[:space:]]?[[:space:]]?#+[[:space:]]/ { h = $0; sub(/^[[:space:]]*#+[[:space:]]*/, "", h); sub(/[[:space:]]*#*[[:space:]]*$/, "", h); inside = (tolower(h) == "pattern justifications"); next }
    inside && /^[[:space:]]*[-*+][[:space:]]+`?[a-z][a-z0-9-]*`?[[:space:]]*:/ { l = $0; sub(/^[[:space:]]*[-*+][[:space:]]+/, "", l); sub(/[[:space:]]*:.*/, "", l); gsub(/`/, "", l); print l }' "$dr_f" | sort -u)
  dr_sep='' dr_out=''
  for dr_i in $dr_ids; do
    dr_t=$(rationale_line "$dr_i" "$dr_f"); [ -n "$dr_t" ] || continue
    dr_b=$(printf '%s' "$dr_t" | sha256)
    if find_approval "$dr_id" "rationale:$dr_i" "$dr_b" >/dev/null; then dr_s=approved; else dr_s=unapproved; fi
    if [ "$dr_json" = yes ]; then
      [ "$dr_s" = approved ] || continue
      dr_out="$dr_out$dr_sep\"$dr_i\": \"$dr_b\""; dr_sep=', '
    else printf '%s\t%s\t%s\n' "$dr_i" "$dr_s" "${dr_t#*: }"; fi
  done
  [ "$dr_json" != yes ] || printf '{"approved": {%s}}\n' "$dr_out"
}
ab_fp=''   # the content fingerprint approve_kinds computed once for all the kinds of one reply (set only there; never read from the environment)
approval_bound() { # ID KIND
  case "$2" in
    commit|push|pr|merge|cleanup) if [ -n "$ab_fp" ]; then printf '%s\n' "$ab_fp"; else content_fingerprint; fi ;;
    report) hash_file "$(shared_dir friction)/latest.md" ;;
    batch) hash_file "$(shared_dir batch)/SUMMARY.md" ;;
    commands) hash_file "$(shared_dir commands)/PROPOSAL.tsv" ;;
    known-issue) hash_file "$(shared_dir known-issues)/PROPOSAL.tsv" ;;   # A202 item 27: the one proposed record
    scale) hash_file "$(shared_dir scale)/PROPOSAL.tsv" ;;   # A202 item 29
    rename) hash_file "$(shared_dir rename)/PROPOSAL.tsv" ;;   # A202: the proposal's own sha256   # A200 review: the proposal's own sha256
    plan|destructive|single_step|scope|budget|mutation_budget|reopen:*) hash_file "$(run_dir "$1")/PLAN.md" ;;
    tree) task_patch_fingerprint "$1" ;;   # the working tree the user inspected: another tree is another question
    rule:*) sh "$scripts/lessons.sh" bound "$1" "${2#rule:}" ;;
    rationale:*) rationale_bound "${2#rationale:}" ;;
    waive:*) ab_f=$(waive_target "$1" "${2#waive:}") || return 1; printf '%s@%s#%s\n' "$(basename "$ab_f")" "$(hash_file "$ab_f")" "${2#waive:}" ;;
  esac
}
kind_words() {
  case "$1" in
    destructive) echo 'destructive migration delete drop' ;;
    single_step) echo 'single step single-step one step tek adım tek adim' ;;
    budget) echo 'budget round rounds' ;;
    mutation_budget) echo 'mutation budget mutants' ;;
    report) echo 'friction report sürtünme surtunme raporu raporunu' ;;
    pr) echo 'pr pull request' ;;
    delivery) echo 'delivery teslimat teslimatı teslimati' ;;
    rule:*) printf 'rule %s\n' "${1#rule:}" ;;
    rationale:*) printf 'rationale %s\n' "${1#rationale:}" | tr '[:upper:]' '[:lower:]' ;;
    reopen:*) printf 'reopen %s\n' "$(printf '%s' "${1#reopen:}" | tr '[:upper:]' '[:lower:]')" ;;
    waive:*) printf '%s\n' "${1#waive:}" | tr '[:upper:]' '[:lower:]' ;;
    known-issue) echo 'known issue known issues known-issue bilinen sorun' ;;
    *) printf '%s\n' "$1" ;;
  esac
}
# capture_field FILE KEY: a JSON string value (unescaped) or number from a one-object capture file.
capture_field() {
  awk -v key="$2" '
    { buf = buf $0 "\n" }
    END {
      pat = "\"" key "\""; i = index(buf, pat); if (!i) exit 1
      s = substr(buf, i + length(pat)); sub(/^[[:space:]]*:[[:space:]]*/, "", s)
      if (substr(s, 1, 1) != "\"") { if (!match(s, /^[0-9]+/)) exit 1; printf "%s", substr(s, 1, RLENGTH); exit 0 }
      out = ""; n = length(s)
      for (j = 2; j <= n; j++) {
        c = substr(s, j, 1)
        if (c == "\\") { j++; d = substr(s, j, 1)
          if (d == "n") out = out "\n"; else if (d == "t") out = out "\t"; else if (d == "r") out = out "\r"; else if (d == "u") out = out "\\u"; else out = out d
          continue }
        if (c == "\"") { printf "%s", out; exit 0 }
        out = out c
      }
      exit 1
    }' "$1"
}
# safe_state_file FILE: a state file only a runtime hook or agent.sh writes (prompt captures, approvals): a
# regular file, not a symlink, with one hard link, and no symlink on its directory chain below the project
# root. A capture or approval planted as a link to another file is refused (defence in depth; ENFORCEMENT.md).
safe_state_file() {
  { [ ! -L "$1" ] && [ -f "$1" ]; } || return 1
  [ -n "$(find "$1" -prune -type f -links 1 2>/dev/null)" ] || return 1
  sf_d=$(dirname "$1")
  # A185: shared state (prompts, approvals of no run) lives in the main tree, which is not under a worktree's root: the walk ends at whichever
  # of the two roots holds the file, and every folder on the way is still checked
  sf_b=$root
  case "$sf_d" in "$root"|"$root"/*) ;; "$sr_main"|"$sr_main"/*)
    # round 6: outside its own root a session reaches only the shared folders and the registered run worktrees, not any file of the main tree
    sf_b=$sr_main; sf_ok=no
    for sf_n in $rw_shared; do case "$sf_d" in "$sr_main/.agents/local/$sf_n"|"$sr_main/.agents/local/$sf_n"/*) sf_ok=yes ;; esac; done
    case "$sf_d" in "$sr_main/.agents/local/worktrees/"*) sf_w=${sf_d#"$sr_main/.agents/local/worktrees/"}; sf_w=${sf_w%%/*}
      git -C "$sr_main" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | grep -Fxq -- "$sr_main/.agents/local/worktrees/$sf_w" && sf_ok=yes ;; esac
    [ "$sf_ok" = yes ] || return 1 ;;
  esac
  while [ "$sf_d" != "$sf_b" ]; do
    case "$sf_d" in "$sf_b"/*) ;; *) return 1 ;; esac
    [ ! -L "$sf_d" ] || return 1
    sf_d=$(dirname "$sf_d")
  done
}
latest_capture() { # -> the capture file with the greatest time, or exit 1; any unsafe capture file fails
  lc_best='' lc_t=-1
  for lc_f in "$(shared_dir prompts)"/*.json; do
    [ -e "$lc_f" ] || [ -L "$lc_f" ] || continue
    safe_state_file "$lc_f" || { fail "prompt capture ${lc_f#"$root"/} is not a regular single-link file on a symlink-free path; refusing every capture"; return 1; }
    lc_v=$(capture_field "$lc_f" time 2>/dev/null) || continue
    case "$lc_v" in ''|*[!0-9]*) continue ;; esac
    [ "$lc_v" -le "$lc_t" ] || { lc_t=$lc_v; lc_best=$lc_f; }
  done
  [ -n "$lc_best" ] || return 1
  printf '%s\n' "$lc_best"
}
# approval_norm: stdin -> words separated by single spaces. Case folding is ASCII only and locale independent
# (LC_ALL=C); ASCII punctuation becomes a space, apostrophes are dropped; hyphen and underscore stay (ids,
# `single-step`); every other byte, non-ASCII letters included, passes unchanged.
approval_norm() {
  LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C sed "s/'//g; s/’//g" | LC_ALL=C tr '!"#$%&()*+,./:;<=>?@[\\]^`{|}~' ' ' | LC_ALL=C tr -s '[:space:]' ' ' | LC_ALL=C sed 's/^ //; s/ $//'
}
# approval_norm_lines (A188): the same normalisation for many lines at once, one output line per input line (a line that normalises to
# nothing stays an empty line). The runtime hook records an approval on the user's prompt, where approval_norm ran five processes for each
# of the dozens of allowlisted sentences; here one pipeline does them all. The whitespace squeeze leaves newlines alone, so every line
# is normalised exactly as approval_norm would normalise it alone.
approval_norm_lines() {
  LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C sed "s/'//g; s/’//g" | LC_ALL=C tr '!"#$%&()*+,./:;<=>?@[\\]^`{|}~' ' ' | LC_ALL=C tr -s '[:blank:]\r\f\v' ' ' | LC_ALL=C sed 's/^ //; s/ $//'
}
# approval_phrases: the explicit approval allowlist (A108): `approval.phrases`, else the built-in English and Turkish list.
approval_phrases() { cfg approval.phrases 'approve, approved, yes, ok, okay, go ahead, lgtm, commit it, push it, onay, onaylıyorum, onayliyorum, onaylandı, onaylandi, onayladım, onayladim, evet, tamam, olur'; }
# approval_fillers: the words an approval reply may carry besides a phrase and the kind word (A108).
approval_fillers() { echo 'the, a, an, it, this, please, for, with, to, and, lütfen, lutfen, bu, planı, plani, için, icin'; }
# approval_sentences KIND [RUNID]: the full approval sentences of a kind (A134), one per line, English then Turkish (ASCII
# variants too; Turkish case folding is ASCII only, so an upper-case non-ASCII letter does not match). A reply that
# equals one of them after normalisation approves (with a run id also `... for <ID>` and `<ID> için ...`). The object word is the kind's own: a sentence of another kind never matches.
approval_sentences() {
  as_id=${1#waive:}; as_id=${as_id#rule:}; as_id=${as_id#reopen:}; as_id=${as_id#rationale:}
  case "$1" in
    plan) as_en='the plan'; as_tr='planı|plani' ;;
    destructive) as_en='the destructive step|the destructive change'; as_tr='yıkıcı adımı|yikici adimi|yıkıcı değişikliği|yikici degisikligi' ;;
    single_step) as_en='the single step'; as_tr='tek adımı|tek adimi' ;;
    scope) as_en='the scope'; as_tr='kapsamı|kapsami' ;;
    mutation_budget) as_en='the mutation budget'; as_tr='mutasyon bütçesini|mutasyon butcesini' ;;
    tree) as_en='the tree|the working tree|the change in the tree'; as_tr='çalışma ağacını|calisma agacini|ağacı|agaci' ;;
    budget) as_en='the budget|another round'; as_tr='bütçeyi|butceyi|bir round daha' ;;
    cleanup) as_en='the cleanup'; as_tr='temizliği|temizligi' ;;
    commands) as_en='the commands'; as_tr='komutları|komutlari' ;;
    known-issue) as_en='the known issue|the known issues'; as_tr='bilinen sorunu|bilinen sorunları|bilinen sorunlari' ;;
    rename) as_en='the renames|the rename'; as_tr='yeniden adlandırmayı|yeniden adlandirmayi' ;;
    scale) as_en='the scale|the timeout scale'; as_tr='ölçeği|olcegi' ;;
    report) as_en='the friction report'; as_tr='sürtünme raporunu|surtunme raporunu' ;;
    commit) as_en='the commit'; as_tr="commit'i" ;;
    push) as_en='the push'; as_tr="push'u" ;;
    pr) as_en='the pull request'; as_tr="pull request'i" ;;
    merge) as_en='the merge'; as_tr="merge'i" ;;
    delivery) as_en='the delivery'; as_tr='teslimatı|teslimati' ;;
    waive:*) as_en="the waiver of $as_id"; as_tr="$as_id feragatini" ;;
    rule:*) as_en="the rule $as_id"; as_tr="$as_id kuralını" ;;
    rationale:*) as_en="the rationale $as_id"; as_tr="$as_id gerekçesini|$as_id gerekcesini" ;;
    reopen:*) as_en="the reopen of $as_id"; as_tr="$as_id yeniden açılışını|$as_id yeniden acilisini" ;;
    *) return 0 ;;
  esac
  case "$1:${2:--}" in waive:*|rule:*|reopen:*|rationale:*|*:-) as_run='' ;; *) as_run=$2 ;; esac
  printf '%s\n' "$as_en" | tr '|' '\n' | while IFS= read -r as_o; do
    printf 'i approve %s\ni approved %s\n' "$as_o" "$as_o"
    [ -z "$as_run" ] || printf 'i approve %s for %s\ni approved %s for %s\n' "$as_o" "$as_run" "$as_o" "$as_run"
  done
  printf '%s\n' "$as_tr" | tr '|' '\n' | while IFS= read -r as_o; do
    printf '%s onaylıyorum\n%s onayliyorum\n%s onayladım\n%s onayladim\n' "$as_o" "$as_o" "$as_o" "$as_o"
    [ -z "$as_run" ] || printf '%s için %s onaylıyorum\n%s icin %s onayliyorum\n%s için %s onayladım\n%s icin %s onayladim\n' "$as_run" "$as_o" "$as_run" "$as_o" "$as_run" "$as_o" "$as_run" "$as_o"
  done
}
# approval_example KIND: the first English and the first Turkish full sentence, for the approval question.
approval_example() {
  ae_cap() { LC_ALL=C awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }'; }
  printf '"%s" | "%s"' "$(approval_sentences "$1" | sed -n 1p | ae_cap)" "$(approval_sentences "$1" | grep -m1 ' onaylıyorum$' | ae_cap)"
}
# text_has_approval TEXTFILE KIND [RUNID]: a positive grammar (A108). After normalisation every word of the reply must be a
# word of an allowlisted approval phrase, a word of the kind's own words (`kind_words`) or a filler word; the reply
# must hold a whole allowlisted phrase and a kind word, and no question mark. Any other word (a negation, a
# hesitation, an extra clause, anything unrelated) makes it ambiguous: not an approval, not a rejection.
text_has_approval() {
  tha_raw=$(cat "$1")
  case "$tha_raw" in *\?*) return 1 ;; esac
  tha_n=$(printf '%s\n' "$tha_raw" | approval_norm); [ -n "$tha_n" ] || return 1
  tha_low=" $tha_n "
  tha_full=$(approval_sentences "$2" "${3:-}" | approval_norm_lines)
  case "
$tha_full
" in *"
$tha_n
"*) return 0 ;; esac
  tha_pl=$(approval_phrases | tr ',' '\n' | approval_norm_lines)
  tha_kw=$(kind_words "$2" | approval_norm)
  tha_ok=" $(printf '%s' "$tha_pl" | tr '\n' ' ') $tha_kw $(approval_fillers | approval_norm) "
  for tha_t in $tha_n; do case "$tha_ok" in *" $tha_t "*) ;; *) return 1 ;; esac; done
  tha_hit=''
  while IFS= read -r tha_p; do
    [ -n "$tha_p" ] || continue
    case "$tha_low" in *" $tha_p "*) tha_hit=y; break ;; esac
  done <<EOF
$tha_pl
EOF
  [ -n "$tha_hit" ] || return 1
  for tha_w in $tha_kw; do case "$tha_low" in *" $tha_w "*) return 0 ;; esac; done
  return 1
}
# approval_unanswered REQFILE KIND [RUNID]: 0 when the newest user prompt is newer than the request and is no approval
# (ambiguous or a refusal); `next` then tells the lead to ask again (A108).
approval_unanswered() {
  au_c=$(latest_capture 2>/dev/null) || return 1
  au_t=$(capture_field "$au_c" time 2>/dev/null) || return 1
  [ "$au_t" -gt "$(gate_field "$1" requested_at)" ] 2>/dev/null || return 1
  au_f=$(mktemp "${TMPDIR:-/tmp}/proofline-answer.XXXXXX"); capture_field "$au_c" text > "$au_f" 2>/dev/null || :
  if text_has_approval "$au_f" "$2" "${3:-}"; then rm -f "$au_f"; return 1; fi
  rm -f "$au_f"; return 0
}
# approval_wait_o REQFILE KIND ID: the `next` line of a pending approval request. A newer user prompt that is no
# approval leaves the request pending and the lead asks again (A108).
approval_wait_o() {
  if approval_unanswered "$1" "$2" "$3"; then
    o "the user's last reply is not an explicit approval (an answer that is ambiguous or a refusal never approves): relay the question again verbatim with its accepted answers: agent.sh request-approval $3 $2 (relay verbatim), then wait for the reply and: agent.sh next $3"
  elif approval_retry "$1" "$2" "$3"; then
    o "the user's approval of $2 was recorded just now (the prompt hook had not finished it, A171; log .agents/local/approve.log): agent.sh next $3"
  else
    o "wait for the user's answer (the runtime records it from their reply; the lead never runs approve), then: agent.sh next $3"
  fi
}
# approval_retry REQFILE KIND ID (A171): the newest user message approves this request but no approval exists (the prompt hook
# was cut off or could not take the lock): record it now, so the user never has to run `approve` in a terminal. 0 when recorded.
approval_retry() {
  [ "$execution_role" = lead ] || return 1
  [ -z "${PROOFLINE_BRIDGED:-}" ] || return 1   # A210: the Node core records nothing from a file; this shell path is not reachable through the bridge guard
  ar_c=$(latest_capture 2>/dev/null) || return 1
  ar_t=$(capture_field "$ar_c" time 2>/dev/null) || return 1
  [ "$ar_t" -gt "$(gate_field "$1" requested_at)" ] 2>/dev/null || return 1
  ar_f=$(mktemp "${TMPDIR:-/tmp}/proofline-answer.XXXXXX"); capture_field "$ar_c" text > "$ar_f" 2>/dev/null || :
  if ! text_has_approval "$ar_f" "$2" "${3:-}"; then rm -f "$ar_f"; return 1; fi
  rm -f "$ar_f"
  ar_o=$(sh "$scripts/agent.sh" approve "$3" "$2" 2>&1 </dev/null) && ar_rc=0 || ar_rc=$?
  printf '%s target=%s kinds=%s rc=%s retry output: %s\n' "$(now_iso)" "$3" "$2" "$ar_rc" "$(printf '%s' "$ar_o" | tr '\n' ' ' | cut -c1-300)" >> "$sr_main/.agents/local/approve.log" 2>/dev/null || :
  [ "$ar_rc" = 0 ]
}
latest_request() { # ID KIND -> request file
  ls -1 "$(approvals_dir "$1")" 2>/dev/null | grep -E "^[0-9]{3}-request-$(kind_slug "$2")\.yaml\$" | sort | tail -1 | sed "s#^#$(approvals_dir "$1")/#" | grep . || return 1
}
# pending_request ID KIND -> the latest request file, only while no approval of that kind answers it (A155): a request
# that was approved (and perhaps consumed) is used up and never reused, even when its bound hash is unchanged.
pending_request() {
  pr_r=$(latest_request "$1" "$2") || return 1
  pr_n=$(seq3 "$pr_r")
  for pr_f in "$(approvals_dir "$1")"/[0-9][0-9][0-9]-"$(kind_slug "$2")".yaml; do
    [ -e "$pr_f" ] || continue
    [ "$(seq3 "$pr_f")" -lt "$pr_n" ] || return 1
  done
  printf '%s\n' "$pr_r"
}
# --- Several approvals in one message (A202 item 31). The single-approval grammar (text_has_approval) is NOT changed. A message that
# the grammar does not accept as a whole is split ONLY on commas and line breaks; each segment is tried alone with that same grammar
# against the open requests. A segment that is not exactly one approval of an open request is rejected alone and named; the others are
# recorded by `approve`, each as its own record bound to the same user prompt (capture id, hash, single-use per kind). Text that is a
# question, negated or conditional, quoted (a `>` line, a fenced block) or over the cap (approval.max_per_message, default 8) is never
# read as an approval. The mode is on only when at least two segments approve, or one approves and every other segment at least
# tried to ("approve the plan, but wait" stays refused as a whole). A new approval kind needs no change here: the open requests and
# valid_approval_kind are the table.
# approval_pending_pairs [RUNID]: "TARGET KIND" for every open request of the run and of the no-run scope.
approval_pending_pairs() {
  for pq_t in ${1:-} -; do
    [ -n "$pq_t" ] || continue
    [ "$pq_t" = - ] || [ -d "$(run_dir "$pq_t")" ] || continue
    pq_d=$(approvals_dir "$pq_t"); [ -d "$pq_d" ] || continue
    for pq_f in "$pq_d"/[0-9][0-9][0-9]-request-*.yaml; do
      [ -f "$pq_f" ] || continue
      pq_k=$(gate_field "$pq_f" kind)
      valid_approval_kind "$pq_k" || continue
      pending_request "$pq_t" "$pq_k" >/dev/null || continue   # A171: an answered request is used up; no process is started for it
      printf '%s %s\n' "$pq_t" "$pq_k"
    done
  done
}
# approval_words TARGET KIND: the words the open request is answered with (a delivery step: delivery; a joint reopen: reopen:<ID>).
approval_words() {
  aw_r=$(latest_request "$1" "$2") || { printf '%s\n' "$2"; return 0; }
  aw_w=$2; [ -z "$(gate_field "$aw_r" delivery)" ] || aw_w=delivery
  aw_j=$(gate_field "$aw_r" joint); [ -z "$aw_j" ] || aw_w=$aw_j
  printf '%s\n' "$aw_w"
}
# approval_say TARGET KIND: the exact phrase to type for that open request.
approval_say() {
  sy_w=$(approval_words "$1" "$2")
  case "$sy_w" in rule:*|reopen:*|rationale:*) printf 'approve %s\n' "$(kind_words "$sy_w")" ;; *) printf 'approve %s\n' "$(kind_words "$sy_w" | cut -d' ' -f1)" ;; esac
}
# approval_multi_scan TEXTFILE RUNID SHA: one line per segment, tab separated: `S ok "T|KIND T|KIND" SEGMENT` or `S no REASON SEGMENT`,
# then `M yes|no SHA`.
approval_multi_scan() {
  ms_tab=$(printf '\t')
  ms_max=$(cfg approval.max_per_message 8); case "$ms_max" in ''|*[!0-9]*) ms_max=8 ;; esac; { [ "$ms_max" -ge 1 ] && [ "$ms_max" -le 16 ]; } || ms_max=8
  # constant size: the first 8 KB and 64 lines only (what is beyond is never read as an approval)
  ms_seg=$(head -c 8192 "$1" | head -n 64 | LC_ALL=C tr '\t\r' '  ' | LC_ALL=C awk '
    function trim(s) { gsub(/^ +| +$/, "", s); return s }
    { t = trim($0)
      if (t ~ /^(```|~~~)/) { if (!f) { f = 1; print "Q\t" substr(t, 1, 40) } else f = 0; next }
      if (f) next
      if (t ~ /^>/) { print "Q\t" substr(t, 1, 40); next }
      n = split($0, p, ",")
      for (i = 1; i <= n; i++) { s = trim(p[i]); if (s == "") continue; print (split(s, w, " ") > 16 ? "L" : "T") "\t" substr(s, 1, 200) } }')
  ms_nt=$(printf '%s\n' "$ms_seg" | grep -c '^[TLQ]' || :)
  if [ "${ms_nt:-0}" -lt 2 ]; then printf 'M\tno\t%s\n' "$3"; return 0; fi
  ms_pg=''
  while read -r ms_t ms_k; do
    [ -n "$ms_k" ] || continue
    ms_pg="$ms_pg$ms_t|$(approval_words "$ms_t" "$ms_k")|$ms_k
"
  done <<EOF2
$(approval_pending_pairs "$2" | sort -u)
EOF2
  [ -n "$ms_pg" ] || { printf 'M\tno\t%s\n' "$3"; return 0; }
  ms_ex=$(printf '%s' "$ms_pg" | sed -n 1p); ms_ex=$(approval_say "${ms_ex%%|*}" "${ms_ex##*|}")
  ms_pl=$(approval_phrases | tr ',' '\n' | approval_norm_lines)
  ms_f=$(mktemp "${TMPDIR:-/tmp}/proofline-multi.XXXXXX")
  ms_i=0 ms_nok=0 ms_nnop=0 ms_over=0 ms_out='' ms_acc='' ms_rj='' ms_veto=''
  while IFS="$ms_tab" read -r ms_ty ms_s; do
    case "$ms_ty" in
      Q) ms_out="${ms_out}S${ms_tab}no${ms_tab}quoted or pasted text is never an approval${ms_tab}$ms_s
"; continue ;;
      T|L) ;;
      *) continue ;;
    esac
    ms_i=$((ms_i + 1))
    if [ "$ms_i" -gt "$ms_max" ]; then ms_over=$((ms_over + 1)); continue; fi
    ms_hit='' ms_c=''
    if [ "$ms_ty" = T ]; then
      printf '%s\n' "$ms_s" > "$ms_f"
      while IFS= read -r ms_p; do
        [ -n "$ms_p" ] || continue
        ms_pt=${ms_p%%|*}; ms_pr=${ms_p#*|}; ms_pw=${ms_pr%%|*}; ms_pk=${ms_pr#*|}; ms_key="$ms_pt|$ms_pw"
        case "$ms_c" in
          *";$ms_key=y;"*) ms_r=y ;;
          *";$ms_key=n;"*) ms_r=n ;;
          *) if text_has_approval "$ms_f" "$ms_pw" "$ms_pt"; then ms_r=y; else ms_r=n; fi; ms_c="$ms_c;$ms_key=$ms_r;" ;;
        esac
        [ "$ms_r" != y ] || ms_hit="$ms_hit $ms_pt|$ms_pk"
      done <<EOF2
$ms_pg
EOF2
    fi
    if [ -n "$ms_hit" ]; then
      ms_nok=$((ms_nok + 1)); ms_acc="$ms_acc $ms_hit"; ms_out="${ms_out}S${ms_tab}ok${ms_tab}${ms_hit# }${ms_tab}$ms_s
"; continue
    fi
    ms_n=$(printf '%s\n' "$ms_s" | approval_norm); ms_neg='' ms_has=''
    ms_hedge=' not no never dont cant wont if unless but maybe wait hold however hayir degil yok ama eger ancak fakat sonra bekle emin cancel undo stop ignore nope nah revoke reject withdraw abort halt disregard cannot isnt shouldnt negative refuse deny denied oppose jk iptal vazgectim hmm '   # negation, hedge and retraction words: they give a rejected segment its reason and, when the segment names no other open kind, veto the whole message; an accepted segment never reads this
    for ms_w in $ms_n; do case "$ms_hedge" in *" $ms_w "*) ms_neg=y ;; esac; done
    ms_low=" $ms_n "
    while IFS= read -r ms_w; do [ -z "$ms_w" ] || case "$ms_low" in *" $ms_w "*) ms_has=y; break ;; esac; done <<EOF2
$ms_pl
EOF2
    [ -n "$ms_has" ] || ms_nnop=$((ms_nnop + 1))
    # a negated, hedged or questioning segment vetoes the message unless it names an open kind of its own (checked after the scan against the accepted kinds)
    if [ "$ms_ty" = T ] && { [ -n "$ms_neg" ] || case "$ms_s" in *\?*) true ;; *) false ;; esac; }; then
      ms_nm=''
      while IFS= read -r ms_p; do
        [ -n "$ms_p" ] || continue
        ms_pt=${ms_p%%|*}; ms_pr=${ms_p#*|}; ms_pw=${ms_pr%%|*}; ms_pk=${ms_pr#*|}
        for ms_w in $(kind_words "$ms_pw"); do case "$ms_low" in *" $ms_w "*) ms_nm="$ms_nm $ms_pt|$ms_pk"; break ;; esac; done
      done <<EOF2
$ms_pg
EOF2
      if [ -z "$ms_nm" ]; then ms_veto=y; else ms_rj="$ms_rj$ms_nm
"; fi
    fi
    if [ "$ms_ty" = L ]; then ms_why='too long to be one approval'
    else case "$ms_s" in *\?*) ms_why='a question is not an approval' ;; *)
      if [ -n "$ms_neg" ]; then ms_why='negated, conditional or hedged'
      elif [ -n "$ms_has" ]; then ms_why="not one exact approval of an open request (type e.g. \"$ms_ex\")"
      else ms_why='no approval phrase in it'; fi ;; esac; fi
    ms_out="${ms_out}S${ms_tab}no${ms_tab}${ms_why}${ms_tab}$ms_s
"
  done <<EOF2
$ms_seg
EOF2
  rm -f "$ms_f"
  [ "$ms_over" -eq 0 ] || ms_out="${ms_out}S${ms_tab}no${ms_tab}more than $ms_max approvals in one message (limit $ms_max)${ms_tab}$ms_over extra segment(s)
"
  ms_mode=no ms_quiet=''
  for ms_a in $ms_acc; do case "
$ms_rj" in *" $ms_a"*|*"
$ms_a"*) ms_veto=y ;; esac; done
  if [ -n "$ms_veto" ]; then :
  elif [ "$ms_nok" -ge 2 ] || { [ "$ms_nok" -ge 1 ] && [ "$ms_nnop" -eq 0 ]; }; then ms_mode=yes; fi
  # one approval with a filler clause ("plan approved, go ahead") is a single approval: accepted whole, nothing to report
  if [ "$ms_mode" = yes ] && [ "$ms_nok" -le 1 ]; then
    while IFS= read -r ms_p; do
      [ -n "$ms_p" ] || continue
      ms_pr=${ms_p#*|}; text_has_approval "$1" "${ms_pr%%|*}" "${ms_p%%|*}" && { ms_quiet=quiet; break; }
    done <<EOF2
$ms_pg
EOF2
  fi
  printf '%sM\t%s\t%s\t%s\n' "$ms_out" "$ms_mode" "$3" "$ms_quiet"
}
# approval_scan_latest [RUNID]: the scan of the newest user prompt capture (its text checked against its hash, as `approve` does).
approval_scan_latest() {
  sl_cap=$(latest_capture 2>/dev/null) || return 1
  sl_f=$(mktemp "${TMPDIR:-/tmp}/proofline-multi.XXXXXX")
  capture_field "$sl_cap" text > "$sl_f" 2>/dev/null || { rm -f "$sl_f"; return 1; }
  sl_h=$(hash_file "$sl_f")
  [ "$sl_h" = "$(capture_field "$sl_cap" sha256 2>/dev/null || true)" ] || { rm -f "$sl_f"; return 1; }
  approval_multi_scan "$sl_f" "${1:-}" "$sl_h" || :
  rm -f "$sl_f"
}
# approval_scan_report SCAN NRECORDED: the user-facing lines of a multi-approval message (nothing for any other message).
approval_scan_report() {
  sr_tab=$(printf '\t')
  case "$1" in *"M${sr_tab}yes${sr_tab}"*) ;; *) return 0 ;; esac
  case "$1" in *"${sr_tab}quiet"*) return 0 ;; esac
  printf '%s\n' "$1" | awk -F'\t' -v n="${2:-0}" '
    $1 == "S" { t++; if ($2 == "ok") k++; else { m[++r] = "multi: not recorded: " substr($4, 1, 60) ": " $3 } }
    END { printf "multi: %d of %d segments read as approvals, %d approval record(s) written\n", k, t, n; for (i = 1; i <= r && i <= 10; i++) print m[i] }'
}
# approve_pending [ID]: run by the runtime's prompt hook right after it stored the user's prompt capture
# (A41). Every open approval request of the run (and of the no-run scope: commit, push) that this prompt
# satisfies becomes an approval. The lead never runs `approve` itself: the runtime hook denies it. Each
# kind is attempted in its own process, so a refusal ("no approval phrase") changes nothing.
approve_pending() {
  ap_run=${1:-}; ap_log=$sr_main/.agents/local/approve.log   # the shared log (A185): the prompt hook, the main tree and a worktree write one file
  mkdir -p "$sr_main/.agents/local" 2>/dev/null || :
  ap_scan=$(approval_scan_latest "$ap_run" 2>/dev/null) || ap_scan=''   # A202 item 31: read before the approvals use the requests up
  ap_resf=$(mktemp "${TMPDIR:-/tmp}/proofline-approvals.XXXXXX")
  approval_pending_pairs "$ap_run" | sort -u | awk '{ r = 0; if ($2 == "commit") r = 1; else if ($2 == "push") r = 2; else if ($2 == "pr") r = 3; else if ($2 == "merge") r = 4; else if ($2 == "cleanup") r = 5; print $1, r, $2 }' |
    sort -k1,1 -k2,2n -k3,3 | awk '{ if ($1 != t) { if (t != "") print t k; t = $1; k = "" } k = k " " $3 } END { if (t != "") print t k }' |
  while read -r ap_t ap_ks; do
    # one process per target, the delivery steps in their order (A169): a cut-off by the hook's time limit leaves a usable prefix
    # A171: its output goes to .agents/local/approve.log and one line per target to stdout (the hook shows what matters to the
    # lead and the user): "approved: ..." or "not recorded: <reason>" for a refusal that is not simply "this reply is no approval".
    # shellcheck disable=SC2086 # the kinds, one word each
    ap_o=$(sh "$scripts/agent.sh" approve "$ap_t" $ap_ks 2>&1 </dev/null) && ap_rc=0 || ap_rc=$?
    ap_l=$(printf '%s' "$ap_o" | tr '\n' ' ' | tr -s ' ' | cut -c1-300)
    printf '%s target=%s kinds=%s rc=%s output: %s\n' "$(now_iso)" "$ap_t" "${ap_ks# }" "$ap_rc" "$ap_l" >> "$ap_log" 2>/dev/null || :
    printf 'recorded-count: %s\n' "$(printf '%s\n' "$ap_o" | grep -c '^approval recorded' || :)"   # A202 item 31: counted before the line is cut
    if [ "$ap_rc" = 0 ]; then echo "approved: ${ap_t#-} ${ap_ks# }: $ap_l"
    else case "$ap_o" in *"contain no approval phrase"*|*"none of the open requests"*) ;; *) echo "not recorded: ${ap_t#-} ${ap_ks# }: $ap_l" ;; esac; fi
  done > "$ap_resf"
  ap_res=$(cat "$ap_resf"); rm -f "$ap_resf"
  ap_nrec=$(printf '%s\n' "$ap_res" | awk '/^recorded-count: / { n += $2 } END { print n + 0 }')
  ap_res=$(printf '%s\n' "$ap_res" | grep -v '^recorded-count: ' || :)
  [ -z "$ap_res" ] || printf '%s\n' "$ap_res"
  # A202 item 31: a message that held several approvals (commas or lines): one line says how many were recorded, one line per segment that was not
  ap_rep=$(approval_scan_report "$ap_scan" "$ap_nrec")
  if [ -n "$ap_rep" ]; then printf '%s\n' "$ap_rep"; printf '%s\n' "$ap_rep" | sed "s/^/$(now_iso) /" >> "$ap_log" 2>/dev/null || :; fi
  # A202 item 28: the hook's raw copies of the user's prompts (prompts/intake) are a safety net; those older than two days go
  [ ! -d "$sr_main/.agents/local/prompts/intake" ] || find "$sr_main/.agents/local/prompts/intake" -type f -mtime +2 -exec rm -f {} + 2>/dev/null || :
  # the log is shared by every tree: rotate it under a lock (a rotation racing an append would lose lines); a busy lock just skips the rotation
  if [ -f "$ap_log" ] && [ "$(wc -l < "$ap_log")" -gt 400 ] && mkdir "$ap_log.lock" 2>/dev/null; then
    tail -n 200 "$ap_log" > "$ap_log.tmp" && mv "$ap_log.tmp" "$ap_log"; rmdir "$ap_log.lock" 2>/dev/null || :
  fi
  return 0
}
# hook_time ID: the runtime hooks' own timings (A171). A hook appends `epoch|name|ms|result|note` to
# .agents/local/hook-times (a plain append, no lock, so a slow or killed hook still leaves its line; a killed one is found by the
# next hook through its in-flight marker and written with result=timeout). This command moves the lines into the run's HOOKS.log
# (A203; never the ledger) under the locks: one `hook` event per name (`name=<event or step> runs=<n> total_ms=<n> max_ms=<n>`) and one `hook-timeout`
# event per timeout (`name=<event> ms=<n> note=...`). The friction report counts both. A run without lifecycle gates takes none.
hook_time() {
  ht_id=${1:-}; require_lead; ht_f=$root/.agents/local/hook-times
  [ -s "$ht_f" ] || return 0
  [ -n "$ht_id" ] && [ "$ht_id" != - ] && [ -d "$(run_dir "$ht_id")" ] || return 0
  ht_w=$ht_f.$$; mv "$ht_f" "$ht_w" 2>/dev/null || return 0
  if gates_enforced "$ht_id"; then
    awk -F'|' '$2 ~ /^[A-Za-z0-9_.-]+$/ && $3 ~ /^[0-9]+$/ {
        if ($4 == "timeout") { print "hook-timeout\tname=" $2 " ms=" $3 ($5 != "" ? " note=" $5 : ""); next }
        n[$2]++; t[$2] += $3; if ($3 + 0 > m[$2]) m[$2] = $3 + 0 }
      END { for (k in n) print "hook\tname=" k " runs=" n[k] " total_ms=" t[k] " max_ms=" m[k] }' "$ht_w" | sort |
    while IFS="$(printf '\t')" read -r ht_ev ht_detail; do
      # A203: a hook timing is not a lifecycle transition: it goes to HOOKS.log of the run (same line shape, no sequence and no chain),
      # never into the hash-chained ledger (60 percent of a real ledger was hook lines)
      printf 'ts=%s epoch=%s event=%s role=%s detail=%s\n' "$(now_iso)" "$(now_epoch)" "$ht_ev" "$execution_role" "$(printf '%s' "$ht_detail" | tr -c 'A-Za-z0-9_.=,: -' '_')" >> "$(run_dir "$ht_id")/HOOKS.log"
    done
  fi
  rm -f "$ht_w"
}
# run_language [ID]: `tr` or `en`, the language the script's own questions are printed in (A99, A103). Sources
# are the user's own words, in order: a `Language: tr|en` line of the run's TASK.md; the `>` blockquote lines of
# TASK.md (A33); the OLDEST captured prompt of six or more words (.agents/local/prompts/history/, A60; shorter
# prompts such as `approve commit` are replies, never evidence). Turkish text: two or more Turkish-only letters
# or Turkish function words (a heuristic, the A67 limits apply). No signal is English.
run_language() {
  rl_id=${1:--}; rl_v=''; rl_t=
  [ "$rl_id" = - ] || rl_t="$(run_dir "$rl_id")/TASK.md"
  if [ -f "$rl_t" ]; then
    rl_v=$(sed -n 's/^[Ll]anguage:[[:space:]]*\([A-Za-z]*\).*/\1/p' "$rl_t" | head -1 | tr '[:upper:]' '[:lower:]')
  fi
  case "$rl_v" in tr|turkish|turkce) echo tr; return 0 ;; en|english) echo en; return 0 ;; esac
  if [ -f "$rl_t" ]; then
    rl_q=$(grep -E '^[[:space:]]*>' "$rl_t" 2>/dev/null || :)
    if [ "$(printf '%s\n' "$rl_q" | wc -w)" -ge 3 ]; then printf '%s\n' "$rl_q" | rl_detect; return 0; fi
  fi
  for rl_f in $(ls -1 "$(shared_dir prompts)"/history/*.txt 2>/dev/null | sort); do
    [ "$(wc -w < "$rl_f")" -ge 6 ] || continue
    rl_detect < "$rl_f"; return 0
  done
  echo en
}
# rl_detect: stdin text -> `tr` or `en`.
rl_detect() {
  LC_ALL=C awk '
    { l = tolower($0); a += gsub(/\303[\247\266\274]|\304[\237\261]|\305\237|\303[\207\226\234]|\304[\236\260]|\305\236/, "&")
      l = " " l " "; gsub(/[^a-z]+/, " ", l)
      n = split(" ve bir icin bu ile mi degil olarak lutfen yap gerekiyor kadar sonra ama cok var yok ben bunu sunu nasil neden evet hayir onay tamam ", w, " ")
      for (i = 1; i <= n; i++) { t = w[i]; while ((k = index(l, " " t " ")) > 0) { b++; l = substr(l, 1, k) substr(l, k + length(t) + 2) } } }
    END { print (a >= 2 || b >= 2) ? "tr" : "en" }'
}
request_approval() {
  rq_id=$1 rq_kind=$2; require_lead; approval_target "$rq_id" "$rq_kind"
  rq_kind=$(canon_kind "$rq_id" "$rq_kind")
  rq_ad=$(approvals_dir "$rq_id"); mkdir -p "$rq_ad"; rq_n=$(next_num "$rq_ad")
  rq_bound=$(approval_bound "$rq_id" "$rq_kind")
  printf 'kind: "%s"\nbound: "%s"\nrequested_at: %s\n' "$rq_kind" "$rq_bound" "$(now_epoch)" > "$rq_ad/$rq_n-request-$(kind_slug "$rq_kind").yaml"
  ledger_if "$rq_id" approval-request - - "$rq_kind bound=$rq_bound"
  rq_lang=$(run_language "$rq_id"); rq_tr=0; [ "$rq_lang" != tr ] || rq_tr=1
  rq_steps=''
  if [ "$rq_kind" = destructive ]; then
    rq_steps=$(awk -F'|' -v tr="$rq_tr" 'function t(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
      /^## / { i = ($0 ~ /^## Data[[:space:]]*$/); next }
      i && /^\|/ && NF >= 7 && tolower(t($6)) == "yes" { if (tr) printf "   yıkıcı adım %s (%s): %s, hedef %s; geri alma: %s\n", t($2), t($3), t($4), t($5), t($8); else printf "   destructive step %s (%s): %s on %s; rollback: %s\n", t($2), t($3), t($4), t($5), t($8) }' "$(run_dir "$rq_id")/PLAN.md")
  fi
  rq_rows=''
  if [ "$rq_kind" = destructive ]; then
    # A62: the plan's `## Data` carries a `rows:` line (the data at risk, from seed files and fixtures; no agent
    # opens a database): the user's question says how much data the step destroys.
    rq_rows=$(awk -v tr="$rq_tr" '/^## / { i = ($0 ~ /^## Data[[:space:]]*$/); next } i && /^[[:space:]]*rows:[[:space:]]*[^[:space:]]/ { sub(/^[[:space:]]*/, ""); print (tr ? "   risk altındaki veri: " : "   data at risk: ") substr($0, 6); exit }' "$(run_dir "$rq_id")/PLAN.md")
  fi
  [ "$rq_kind" != commands ] || rq_rows=$(awk -F'\t' '!/^#/ { print "   commands." $1 ": " $2 }' "$(shared_dir commands)/PROPOSAL.tsv" 2>/dev/null)
  [ "$rq_kind" != known-issue ] || rq_rows=$(awk -F'\t' '{ print "   known issue: " $1 " " $2 ": " $3 " (follow-up task " $4 ")" }' "$(shared_dir known-issues)/PROPOSAL.tsv" 2>/dev/null)
  [ "$rq_kind" != scale ] || rq_rows=$(awk -F'\t' '{ print "   timeouts." $1 ": " $2 }' "$(shared_dir scale)/PROPOSAL.tsv" 2>/dev/null)
  [ "$rq_kind" != rename ] || rq_rows=$(awk -F'\t' '{ print "   rename: " $1 " -> " $2 }' "$(shared_dir rename)/PROPOSAL.tsv" 2>/dev/null)
  case "$rq_kind" in rationale:*) rq_rows="   rationale line of DESIGN.md: $(rationale_line "${rq_kind#rationale:}")" ;; esac
  case "$rq_kind" in waive:*)
    # findings of the same rule are ONE decision: the count and the first ids here, the detail stays in the gate record and the report
    if [ "$rq_id" != - ] && rq_wr=$(waive_target "$rq_id" "${rq_kind#waive:}" 2>/dev/null); then
      rq_wg=$(waive_group_ids "$rq_wr" "${rq_kind#waive:}"); rq_wn=$(printf '%s\n' "$rq_wg" | wc -l | tr -d ' ')
      if [ "$rq_wn" -gt 1 ]; then rq_rows="   this one decision covers $rq_wn findings of the same rule in $(basename "$rq_wr"): $(printf '%s\n' "$rq_wg" | head -n 3 | tr '\n' ' ')... (detail: that gate record and the report); the lead records it with: agent.sh waive $rq_id ${rq_kind#waive:} --group --reason TEXT"; fi
    fi ;;
  esac
  [ "$rq_kind" != mutation_budget ] || rq_rows="   mutation budget: $(mutation_budget "$rq_id"), PLAN ## Tests criteria: $(plan_test_acs "$(run_dir "$rq_id")/PLAN.md")"
  if [ "$rq_kind" = batch ]; then printf 'QUESTIONS:\n1. Approve the night batch shown above (batch %s)?\n' "$(printf '%s' "$rq_bound" | cut -c1-12)"
  elif [ "$rq_tr" = 1 ]; then printf 'QUESTIONS:\n1. %s için %s onaylansın mı?\n' "$rq_id" "$rq_kind"
  else printf 'QUESTIONS:\n1. Approve %s for %s?\n' "$rq_kind" "$rq_id"; fi
  [ -z "$rq_steps" ] || printf '%s\n' "$rq_steps"
  [ -z "$rq_rows" ] || printf '%s\n' "$rq_rows"
  if [ "$rq_tr" = 1 ]; then
    printf '   seçenekler: approve | reject (onay için "approve %s" yazın, vazgeçmek için "reject")\n   kabul edilen onay sözcükleri: %s (tür sözcüğüyle birlikte, örn. "approve %s"; bunlardan başka yalnızca şu sözcükler: %s); ya da yanıtın tamamı tek bir tam cümle: %s; başka herhangi bir sözcük yanıtı belirsiz yapar: onay sayılmaz ve soru yeniden sorulur\n   önerilen: yok (karar kullanıcıya ait)\n   neden: %s\n' "$(kind_words "$rq_kind" | cut -d' ' -f1)" "$(approval_phrases)" "$(kind_words "$rq_kind" | cut -d' ' -f1)" "$(approval_fillers)" "$(approval_example "$rq_kind")" "$(approval_why "$rq_kind" "$rq_bound" tr)"
  else printf '   options: approve | reject\n   accepted answers: %s (with the kind word, for example "approve %s"; besides those only the words: %s); or the whole reply as one full sentence: %s; any other word makes the reply ambiguous: it is not an approval and the question is asked again\n   recommended: none (the user decides)\n   why: %s\n' "$(approval_phrases)" "$(kind_words "$rq_kind" | cut -d' ' -f1)" "$(approval_fillers)" "$(approval_example "$rq_kind")" "$(approval_why "$rq_kind" "$rq_bound")"; fi
  # A202 item 31: several open requests are answered by one message, one exact phrase per comma or line
  rq_sy=$(approval_pending_pairs "$rq_id" | sort -u | while read -r rq_t rq_k; do approval_say "$rq_t" "$rq_k"; done | awk '!s[$0]++' | head -n 8 | paste -s -d, - | sed 's/,/, /g')
  case "$rq_sy" in *,*) printf '   several open requests: one message answers them, one phrase per comma or line: %s\n' "$rq_sy" ;; esac
}
approval_why() { # KIND BOUND [tr]
  if [ "${3:-}" = tr ]; then
    case "$1" in
      plan) echo 'denetimli özerklik: plan yalnızca kullanıcı onayından sonra dondurulur' ;;
      destructive) echo 'plan yıkıcı bir veri değişikliği bildiriyor' ;;
      single_step) echo 'yıkıcı değişiklikte expand/contract adımı yok: okuma ile silme arasında durulacak nokta olmadan tek adımda çalışır' ;;
      scope) echo 'değişiklik kapsama yol ekliyor veya görev kimsenin istemediği mevcut bir kusuru düzeltiyor' ;;
      budget) echo 'düzeltme turları bitti: yeniden dondurma yeni bir düzeltme bütçesi başlatır' ;;
      mutation_budget) echo 'test_trust.mutation_budget planın ## Tests ölçütlerinden az: ölçüt başına bir mutant gerekir; bütçe yalnızca bu koşuda artar' ;;
      tree) echo 'çalışma ağacına bu koşunun hiçbir işçi penceresinin kaydetmediği bir değişiklik girdi: onaylarsanız koşu korunur ama bütün kapılar yeni içerik üzerinde yeniden çalışır' ;;
      commit|push|pr|merge) echo "içerik $2 için teslim açık onay gerektirir" ;;
      cleanup) echo 'birleştirmeden sonra koşu kanıtı silinir' ;;
      reopen:*) echo 'başarısız veya engellenmiş koşu yalnızca kullanıcı onayıyla yeniden açılır; plan değişmez, geçmeyen kapılar yeniden çalışır' ;;
      rule:*) echo "kanıttan çıkan ders proje kuralı olur: $(sh "$scripts/lessons.sh" text "${1#rule:}")" ;;
      rationale:*) echo 'DESIGN.md gerekçesi yalnızca sizin onayınızla bir desen bulgusunu engelleyici olmaktan çıkarır; ajanın yazdığı gerekçe bulguyu geçirmez' ;;
      report) echo 'anonim sürtünme raporu GitHub issue olarak yalnızca onayınızla gönderilir' ;;
      known-issue) echo 'bu bulgu, görevin dokunmadığı bir yerde zaten var ve bir takip görevi var: onayınızla bilinen sorun olur ve görevi durdurmaz; yeni bir bulgu ya da dokunulan yer yine engeller; SECRETS ve SECURITY hiçbir zaman listelenmez' ;;
      rename) echo 'sıradaki görev dosyaları yalnızca sizin onayınızla <ID>-<slug>.md adına taşınır; başlamış ya da raporu yayınlanmış görevlere dokunulmaz' ;;
      scale) echo 'bu makine için önerilen timeouts.scale değeri yalnızca sizin onayınızla .agents/config.yaml dosyasına yazılır; bütün süreler birlikte uzar, hiçbir denetim kapanmaz' ;;
      commands) echo 'boş commands.build|test|lint anahtarları için önerilen komutlar yalnızca sizin onayınızla .agents/config.yaml dosyasına yazılır' ;;
      batch) echo 'gece modu: bu tek özet, listelenen görevlerin plan, teslimat ve mutasyon bütçesi onaylarının yerine geçer; başka hiçbir şeyin yerine geçmez' ;;
      *) echo 'bir FAIL bulgusu yalnızca kullanıcının açık talimatıyla feragat edilir' ;;
    esac
    return 0
  fi
  case "$1" in
    plan) echo 'supervised autonomy: the plan freezes only after user approval' ;;
    destructive) echo 'the plan declares a destructive data change' ;;
    single_step) echo 'the destructive change has no expand/contract steps: it would run as one step, with no point to stop between reading and dropping' ;;
    scope) echo 'the amendment adds scope paths, or the task fixes a pre-existing defect nobody asked about' ;;
    budget) echo 'the fix rounds are exhausted: a refreeze would start a fresh fix budget' ;;
    mutation_budget) echo 'test_trust.mutation_budget is below the criteria of PLAN ## Tests (one mutant each is the minimum): the budget is raised for this run only, .agents/config.yaml is not edited' ;;
    tree) echo 'a change entered the working tree that no worker window of this run recorded (a failover worker, an editor, another process): you inspect it (agent.sh tree-inspect); accepting it keeps the run, but every gate runs again on the new content; declining leaves the run as it is' ;;
    commit|push|pr|merge) echo "delivery of content $2 needs explicit approval" ;;
    cleanup) echo 'after the merge the run evidence is deleted' ;;
    reopen:*) echo 'a FAILED or BLOCKED run is reopened only with your approval: the plan stays frozen, only gates that did not pass or whose inputs changed run again, and the fix-round allowance restarts' ;;
    rule:*) echo "a lesson from run evidence becomes a project rule: $(sh "$scripts/lessons.sh" text "${1#rule:}")" ;;
    rationale:*) echo 'a DESIGN.md pattern rationale downgrades a design finding from blocking to info only with your approval; a rationale an agent wrote does not pass the finding' ;;
    report) echo 'the anonymous friction report (.agents/local/friction/latest.md) is sent as a GitHub issue only with your approval' ;;
    known-issue) echo 'this finding already exists where the task does not touch, and a follow-up task owns it: with your approval it becomes a known issue and stops no task; a new finding or a touched place still blocks; SECRETS and SECURITY are never listed' ;;
    rename) echo 'queued task files are renamed to <ID>-<slug>.md only with your approval; a started task or one with a published report is never touched' ;;
    scale) echo 'the proposed timeouts.scale for this machine is written into .agents/config.yaml only with your approval; every duration grows together, no check is switched off' ;;
    commands) echo 'the proposed commands.build|test|lint are written into .agents/config.yaml only with your approval' ;;
    batch) echo 'night mode: this one summary stands in for the plan, delivery and mutation budget approvals of the listed tasks, and for nothing else' ;;
    *) echo 'a FAIL finding is waived only on explicit user instruction' ;;
  esac
}
approve() {
  ap_id=$1 ap_kind=$2; require_lead; approval_target "$ap_id" "$ap_kind"
  ap_kind=$(canon_kind "$ap_id" "$ap_kind")
  ap_req=$(latest_request "$ap_id" "$ap_kind") || fail "no approval request for $ap_kind: run 'agent.sh request-approval $ap_id $ap_kind' and relay it to the user first"
  safe_state_file "$ap_req" || fail "approval request $(basename "$ap_req") is not a regular single-link file on a symlink-free path"
  ap_reqn=$(seq3 "$ap_req" raw); ap_slug=$(kind_slug "$ap_kind"); ap_ad=$(approvals_dir "$ap_id")
  for ap_f in "$ap_ad"/[0-9][0-9][0-9]-"$ap_slug".yaml; do
    [ -e "$ap_f" ] || continue
    [ "$(seq3 "$ap_f")" -lt "$(seq3 "$ap_reqn")" ] || fail "request $(basename "$ap_req") is already approved; request again for a new approval"
  done
  ap_bound=$(approval_bound "$ap_id" "$ap_kind") || return 1
  [ "$ap_bound" = "$(gate_field "$ap_req" bound)" ] || fail "the content changed since the approval request; request again"
  # a step request of a delivery summary (deliver-plan) is answered by the one reply that approves the delivery
  ap_dlv=$(gate_field "$ap_req" delivery); ap_words=$ap_kind; [ -z "$ap_dlv" ] || ap_words=delivery
  # A154: the two requests of one reopen question carry `joint: reopen:<ID>`; the one reply approving that reopen answers both
  ap_jt=$(gate_field "$ap_req" joint); [ -z "$ap_jt" ] || ap_words=$ap_jt
  ap_txt=$(mktemp "${TMPDIR:-/tmp}/proofline-approve.XXXXXX")
  if [ -t 0 ] && [ -t 1 ]; then
    printf 'Approve %s for %s? Type an approval phrase (%s; for example "approve %s"): ' "$ap_kind" "$ap_id" "$(approval_phrases)" "$(kind_words "$ap_kind" | cut -d' ' -f1)" >&2
    IFS= read -r ap_line || ap_line=''
    printf '%s' "$ap_line" > "$ap_txt"; ap_src=tty ap_session=tty ap_time=$(now_epoch)
  else
    ap_cap=$(latest_capture) || { rm -f "$ap_txt"; fail "approval refused: no interactive terminal and no user prompt capture in .agents/local/prompts/"; }
    ap_time=$(capture_field "$ap_cap" time); ap_session=$(capture_field "$ap_cap" session 2>/dev/null || echo unknown)
    capture_field "$ap_cap" text > "$ap_txt" || { rm -f "$ap_txt"; fail "approval refused: capture has no text"; }
    [ "$(hash_file "$ap_txt")" = "$(capture_field "$ap_cap" sha256)" ] || { rm -f "$ap_txt"; fail "approval refused: capture sha256 does not match its text"; }
    [ "$ap_time" -gt "$(gate_field "$ap_req" requested_at)" ] || { rm -f "$ap_txt"; fail "approval refused: the latest user prompt is older than the approval request (stale capture)"; }
    case "$ap_kind" in waive:*)
      ap_ge=$(gate_field "$(gates_dir "$ap_id")/${ap_bound%%@*}" epoch)
      case "$ap_ge" in ''|*[!0-9]*) ap_ge=$(now_epoch) ;; esac
      [ "$ap_time" -gt "$ap_ge" ] || { rm -f "$ap_txt"; fail "approval refused: the latest user prompt is older than the failing gate record ${ap_bound%%@*}"; } ;;
    esac
    ap_src=prompt_capture
  fi
  ap_csha=$(hash_file "$ap_txt")
  # A106: single-use is per capture event (session + time + hash), never per text: the same words answer a later request.
  ap_cid="$ap_session:$ap_time:$ap_csha"
  text_has_approval "$ap_txt" "$ap_words" "$ap_id" || approval_multi_accepts "$ap_csha" "$ap_id" "$ap_kind" || { rm -f "$ap_txt"; fail "approval refused: the user's words contain no approval phrase for $ap_words (an explicit approval phrase from approval.phrases and the kind word '$(kind_words "$ap_words")', and no other word; the question stays pending)"; }
  if [ "$ap_src" = prompt_capture ] && grep -l "^capture_id: \"$ap_cid\"" "$ap_ad"/[0-9][0-9][0-9]-"$ap_slug".yaml >/dev/null 2>&1; then fail "approval refused: this user prompt already granted a $ap_kind approval (single-use)"; fi
  ap_n=$(next_num "$ap_ad")
  printf 'kind: "%s"\nbound: "%s"\nsource: "%s"\nsession: "%s"\ncapture_sha256: "%s"\ncapture_id: "%s"\ncapture_time: %s\nrequest: "%s"\nanswered_by: "user"\napproved_at: %s\nconsumed: "false"\n' \
    "$ap_kind" "$ap_bound" "$ap_src" "$ap_session" "$ap_csha" "$ap_cid" "$ap_time" "$(basename "$ap_req")" "$(now_epoch)" > "$ap_ad/$ap_n-$ap_slug.yaml"
  [ -z "$ap_dlv" ] || printf 'delivery: "%s"\n' "$ap_dlv" >> "$ap_ad/$ap_n-$ap_slug.yaml"
  ap_ref=$(gate_field "$ap_req" ref); [ -z "$ap_ref" ] || printf 'ref: "%s"\n' "$ap_ref" >> "$ap_ad/$ap_n-$ap_slug.yaml"   # A169
  # A171: the user's reply, verbatim, as a quote block (the language check exempts it; the first 20 lines)
  { printf 'reply: |\n'; head -n 20 "$ap_txt" | quote_block | sed 's/^/  /'; } >> "$ap_ad/$ap_n-$ap_slug.yaml"; rm -f "$ap_txt"
  ap_tok=''; [ "$ap_id" = - ] || ap_tok="$(ledger_token "approvals/$ap_n-$ap_slug.yaml" "$ap_id") "
  ledger_if "$ap_id" approval - - "${ap_tok}$ap_kind source=$ap_src answered_by=user bound=$ap_bound"
  echo "approval recorded: $ap_id $ap_kind ($ap_src)"
}
# approve_kinds ID KIND...: the user's one reply answers several open requests (A169: "approve delivery" answers the five steps of a
# summary). One process takes the locks and computes the content fingerprint once, then records each kind as `approve` would, in
# the order given; a kind that is refused (no phrase for it, already approved, content changed) changes nothing and does not stop
# the next. The runtime hook that calls this has a time limit (30 s in a Claude Code UserPromptSubmit hook): five processes that
# each took the locks and walked the tree were cut off after the fourth step in a real project, and the last step had no approval.
approval_multi_accepts() { # CAPTURE-SHA TARGET KIND: this exact prompt held several approvals and one segment of it approves this request
  [ "${ap_multi_sha:-}" = "$1" ] || return 1
  case " ${ap_multi_ok:-} " in *" $2|$3 "*) return 0 ;; esac
  return 1
}
approve_kinds() {
  ak_id=$1; shift
  # A202 item 31: scan the newest prompt once for several approvals (commas, lines); `approve` consults the result only after the whole-text grammar refused
  ap_multi_ok='' ap_multi_sha=''; ak_tab=$(printf '\t')
  if ! { [ -t 0 ] && [ -t 1 ]; }; then
    ak_scan=$(approval_scan_latest "$ak_id" 2>/dev/null) || ak_scan=''
    case "$ak_scan" in *"M${ak_tab}yes${ak_tab}"*)
      ap_multi_sha=$(printf '%s\n' "$ak_scan" | awk -F'\t' '$1 == "M" { print $3 }')
      ap_multi_ok=$(printf '%s\n' "$ak_scan" | awk -F'\t' '$1 == "S" && $2 == "ok" { print $3 }' | tr '\n' ' ') ;;
    esac
  fi
  if [ $# -eq 1 ]; then approve "$ak_id" "$1"; return; fi
  ak_need=''
  for ak_k in "$@"; do case "$ak_k" in commit|push|pr|merge|cleanup) ak_need=1 ;; esac; done
  require_lead
  [ -z "$ak_need" ] || ab_fp=$(content_fingerprint)
  ak_ok=''; exec 3<&0
  for ak_k in "$@"; do
    # an asynchronous subshell keeps `set -e` for the whole of `approve` (a failing `fail` stops it); `||` or `if` around a
    # foreground subshell would switch errexit off inside it. The EXIT trap (it releases this process's locks) is not the subshell's.
    # An asynchronous command reads /dev/null unless it is redirected: fd 3 keeps the caller's stdin, so a terminal still gets its prompt.
    ( trap - 0; approve "$ak_id" "$ak_k" ) <&3 & wait $! && ak_ok=1 || :
  done
  exec 3<&-
  ab_fp=''
  [ -n "$ak_ok" ] || fail "no approval was recorded: none of the open requests ($*) is answered by the user's latest message"
}
# Inside a ledgered run only approvals that `approve` wrote (ledger-bound, unchanged since) count.
find_approval() { # ID KIND BOUND [DELIVERY] -> newest unconsumed approval file with that binding (and delivery summary hash)
  fa_all=$(ls -1 "$(approvals_dir "$1")" 2>/dev/null | grep -E "^[0-9]{3}-$(kind_slug "$2")\.yaml\$" | sort -r || true)
  # shellcheck disable=SC2086
  if [ -n "$fa_all" ] && [ "$1" != - ] && gates_enforced "$1"; then fa_all=$(bound_names "$(run_dir "$1")" approvals 'approval$' $fa_all | sort -r); fi
  for fa_x in $fa_all; do
    fa_x=$(approvals_dir "$1")/$fa_x
    safe_state_file "$fa_x" || continue
    [ "$(gate_field "$fa_x" consumed)" = false ] && [ "$(gate_field "$fa_x" bound)" = "$3" ] && { [ -z "${4:-}" ] || [ "$(gate_field "$fa_x" delivery)" = "$4" ]; } && { printf '%s\n' "$fa_x"; return 0; }
  done
  return 1
}
consume_approval() { # ID FILE
  awk '/^consumed:/ { print "consumed: \"true\""; next } { print }' "$2" > "$2.tmp" && printf 'consumed_at: %s\n' "$(now_epoch)" >> "$2.tmp" && mv "$2.tmp" "$2"
  ledger_if "$1" approval-consumed - - "$(basename "$2") $(gate_field "$2" kind)"
}
approval_consume() { # ID KIND [FINGERPRINT [REF...]] — for the git hooks; exit 0 iff a valid approval was consumed
  acn_id=$1 acn_kind=$2 acn_fp=${3:-}
  if [ $# -gt 3 ]; then shift 3; else set --; fi   # what is left are the refs the pre-push hook gives (A169)
  require_lead; approval_target "$acn_id" "$acn_kind"
  if [ -n "$acn_fp" ]; then acn_b=$acn_fp; else acn_b=$(approval_bound "$acn_id" "$acn_kind"); fi
  acn_f=$(find_approval "$acn_id" "$acn_kind" "$acn_b") || fail "no unconsumed $acn_kind approval bound to $acn_b for $acn_id"
  # A169: an approval that names a ref (a delivery's push, a CI-fix push) covers a push to that ref and to nothing else
  acn_ref=$(gate_field "$acn_f" ref)
  if [ -n "$acn_ref" ]; then
    [ $# -gt 0 ] || fail "the $acn_kind approval is for $acn_ref; the refs of this push were not given, so it cannot be used"
    for acn_r in "$@"; do [ "$acn_r" = "$acn_ref" ] || fail "the $acn_kind approval is for $acn_ref, not for a push to $acn_r"; done
  fi
  consume_approval "$acn_id" "$acn_f"
  echo "approval consumed: $acn_id $acn_kind $(basename "$acn_f")"
}

# --- Night mode (A157): one approval of one summary stands in for the plan, delivery and mutation budget approvals of the
# listed tasks. The plan, the digest of its state and the report are batch.sh; here are only the approval checks and the cover.
batch_dir() { shared_dir batch; }
# batch_approval: the batch approval file, valid only while SUMMARY.md still has the hash it is bound to; it is never consumed.
batch_approval() {
  ba_s=$(batch_dir)/SUMMARY.md; [ -f "$ba_s" ] || return 1
  ba_f=$(find_approval - batch "$(hash_file "$ba_s")") || return 1
  [ "$(gate_field "$ba_f" answered_by)" = user ] || return 1
  case "$(gate_field "$ba_f" source)" in prompt_capture|tty) printf '%s\n' "$ba_f" ;; *) return 1 ;; esac
}
# batch_member ID: 0 when ID is a task of the approved batch (A200: the lead then goes on by itself after CODE_DONE and DONE)
batch_member() { batch_approval >/dev/null 2>&1 && awk -F'\t' -v t="$1" '$1 == t { f = 1 } END { exit !f }' "$(batch_dir)/order.tsv" 2>/dev/null; }
batch_continue_note() { # ID: one line for next_step
  ! batch_member "$1" || printf 'note=BATCH (A200): %s belongs to the approved batch. Do NOT stop at this state and do NOT hand the user a "Next step"; write ONE status line ("%s: <state>, <what runs now>, next: <task>") and go on: finish the knowledge step, the report and DONE, then agent.sh batch-next (its NEXT: deliver covers the delivery with batch-cover, never a question). During a wait of a minute or more (a CI run, a dispatch) write one status line, then wait.\n' "$1" "$1"
}
batch_check() { batch_approval >/dev/null || fail "no valid batch approval for the current summary (agent.sh batch-plan, then the user's reply \"approve batch\")"; hash_file "$(batch_dir)/SUMMARY.md"; }
# A200: commands-check: 0 when the user agreed to the commands proposal (`proofline doctor --commands`) in their OWN words: either
# a batch approval whose summary names this very proposal, or the newest captured prompt, newer than the proposal, which is an
# approval of the kind `commands` (the approval grammar of A108: "approve commands"). The proposal file is written by the CLI
# after it ran each command once; an agent cannot make it, change it or answer for the user.
commands_check() {
  cc_f=$(shared_dir commands)/PROPOSAL.tsv; [ -s "$cc_f" ] || fail "no commands proposal (proofline doctor --commands)"
  cc_h=$(hash_file "$cc_f" | cut -c1-12)
  if batch_approval >/dev/null 2>&1 && grep -qx "commands proposal: $cc_h" "$(batch_dir)/SUMMARY.md" 2>/dev/null; then echo "commands $cc_h: covered by the batch approval"; return 0; fi
  # A normal approval of the kind `commands`, bound to the sha256 of this proposal (a changed, replayed or forged proposal has no
  # approval), recorded by `approve` on the user's own prompt after the request, and consumed on apply (agent.sh approval-consume - commands).
  # Nothing here reads the proposal's own text for a time: the request's requested_at is the ledger time.
  find_approval - commands "$(hash_file "$cc_f")" >/dev/null || fail "the user's newest message does not approve the commands: no unconsumed commands approval is bound to this proposal (ask: agent.sh request-approval - commands, relay it; the reply \"approve commands\" records the approval)"
  echo "commands $cc_h: approved by the user"
}
# --- A202: consistent task file names: <ID>-<slug>.md ----------------------------------------------
# task-rename-plan lists the queued markdown task files (backlog/, todo/ and the top level of tasks.dir) that are named only by their ID or
# only by a slug and proposes <ID>-<slug-of-the-title>.md; it asks the user's approval (kind `rename`, bound to the proposal's sha256).
# task-rename-apply renames only after that approval, and re-checks every row first. A task that has a run or a worktree, one whose file
# holds a published completion report, and every file in in-progress/ or done/ is never proposed and never renamed.
# task_slug TITLE: the slug of a title, from the Node core (cli slug): the project's core beside this script, or the main tree's
task_slug() { node "$sr_main/.agents/scripts/proofline-core.mjs" cli slug "$1"; }
# pl_core ARGS...: the project's Node core (the main tree's, like the delegation at the top of this file); --pl-argv0 names this script, so that a
# run in a task worktree reads that worktree's config (A222: the execution-policy resolver is `pl_core cli exec-policy`)
pl_core() { node "$sr_main/.agents/scripts/proofline-core.mjs" --pl-argv0 "$0" "$@"; }
rename_candidate() { # ABS-FILE -> ABS-NEW-NAME on stdout when the file is a queued, non-conforming task file
  rc_f=$1; rc_b=$(basename "$rc_f" .md)
  rc_id=$(sed -n '1s/^# Task: *\([^ ]*\).*/\1/p' "$rc_f" 2>/dev/null | head -1)
  { [ -n "$rc_id" ] && valid_task_id "$rc_id"; } || return 1
  case "$rc_b" in "$rc_id"-FU[0-9]*) return 1 ;; esac
  { [ ! -e "$root/.agents/runs/$rc_id" ] && [ ! -e "$(shared_dir worktrees)/$rc_id" ]; } || return 1
  ! grep -q "COMPLETION-REPORT:BEGIN" "$rc_f" 2>/dev/null || return 1
  rc_idl=$(task_slug "$rc_id")
  case "$rc_b" in "$rc_id"-?*)
    rc_sl=${rc_b#"$rc_id"-}
    if [ "$rc_sl" = "$(task_slug "$rc_sl")" ] && [ "$rc_sl" != "$rc_idl" ]; then return 1; fi ;;
  esac
  rc_sl=$(task_slug "$(task_title_of "$rc_f")")
  { [ -n "$rc_sl" ] && [ "$rc_sl" != "$rc_idl" ]; } || return 1
  rc_new=$(dirname "$rc_f")/$rc_id-$rc_sl.md
  [ ! -e "$rc_new" ] || return 1
  printf '%s\n' "$rc_new"
}
task_rename_files() { # the queued task files
  trf_td=$root/$(cfg tasks.dir .agents/tasks)
  for trf_f in "$trf_td"/backlog/*.md "$trf_td"/todo/*.md "$trf_td"/*.md; do [ -f "$trf_f" ] && [ ! -L "$trf_f" ] && printf '%s\n' "$trf_f"; done
}
task_rename_plan() {
  require_lead; trp_pf=$(shared_dir rename)/PROPOSAL.tsv; mkdir -p "$(dirname "$trp_pf")"; trp_t=$trp_pf.tmp; : > "$trp_t"
  task_rename_files | while IFS= read -r trp_f; do
    trp_n=$(rename_candidate "$trp_f") || continue
    printf '%s\t%s\n' "${trp_f#"$root"/}" "${trp_n#"$root"/}"
  done > "$trp_t"
  if [ ! -s "$trp_t" ]; then rm -f "$trp_t" "$trp_pf"; echo "task-rename: every queued task file is already named <ID>-<slug>.md"; return 0; fi
  mv "$trp_t" "$trp_pf"; cat "$trp_pf"
  request_approval - rename
}
task_rename_apply() {
  require_lead; tra_pf=$(shared_dir rename)/PROPOSAL.tsv; [ -s "$tra_pf" ] || fail "no rename proposal (agent.sh task-rename-plan)"
  tra_app=$(find_approval - rename "$(hash_file "$tra_pf")") || fail "renaming task files needs the user's approval: 'agent.sh request-approval - rename' (task-rename-plan does it), relay it; the reply \"approve rename\" records the approval"
  while IFS="$(printf '\t')" read -r tra_o tra_n; do
    [ "$(rename_candidate "$root/$tra_o" 2>/dev/null)" = "$root/$tra_n" ] || fail "$tra_o is no longer a queued task file that needs this rename (started, reported, renamed or changed since the proposal); run task-rename-plan again"
  done < "$tra_pf"
  consume_approval - "$tra_app"
  while IFS="$(printf '\t')" read -r tra_o tra_n; do
    if git -C "$root" ls-files --error-unmatch -- "$tra_o" >/dev/null 2>&1; then git -C "$root" mv -- "$tra_o" "$tra_n"; else mv -- "$root/$tra_o" "$root/$tra_n"; fi
    echo "renamed: $tra_o -> $tra_n"
  done < "$tra_pf"
  rm -f "$tra_pf"
}
# --- the batch accept answer (A200; the known-issues list itself runs in the Node core since A222) -----------------------------------
# batch_accept_given: 0 when the batch approval of the CURRENT summary stands and the newest answer to its accept question (id batch,
# kind accept) is b, recorded from a user message the prompt hook captured (batch.sh answer). "all recommended" never gives b.
batch_accept_given() {
  batch_approval >/dev/null 2>&1 || return 1
  [ "$(batch_answer_row batch accept | cut -f1)" = b ] || return 1
  bag_m=$(awk -F'\t' -v b="$(hash_file "$(batch_dir)/SUMMARY.md" | cut -c1-12)" '$1 == b && $2 == "batch" && $4 == "accept" { m = $7 } END { print m }' "$(batch_dir)/answers.tsv")
  [ -n "$bag_m" ] && [ -f "$(shared_dir prompts)/history/$bag_m" ]
}
batch_plan() {
  require_lead; mkdir -p "$agents/local"
  bp_rc=0; sh "$scripts/batch.sh" plan "$@" || bp_rc=$?
  [ "$bp_rc" -ne 3 ] || return 0   # the same approved batch continues: no new plan, no new approval
  [ "$bp_rc" -eq 0 ] || return 1
  request_approval - batch
}
# batch_record ID KIND REQUEST BATCH-HASH [DELIVERY [CAP]]: an approval as `approve` writes it, marked source batch.
batch_record() {
  br_ad=$(approvals_dir "$1"); br_slug=$(kind_slug "$2"); br_n=$(next_num "$br_ad"); br_f=$br_ad/$br_n-$br_slug.yaml
  printf 'kind: "%s"\nbound: "%s"\nsource: "batch"\nrequest: "%s"\nanswered_by: "user"\napproved_at: %s\nconsumed: "false"\nvia_batch: "%s"\n' \
    "$2" "$(gate_field "$3" bound)" "$(basename "$3")" "$(now_epoch)" "$4" > "$br_f"
  [ -z "${5:-}" ] || printf 'delivery: "%s"\n' "$5" >> "$br_f"
  br_ref=$(gate_field "$3" ref); [ -z "$br_ref" ] || printf 'ref: "%s"\n' "$br_ref" >> "$br_f"   # A169
  [ -z "${6:-}" ] || printf 'cap: "%s"\n' "$6" >> "$br_f"
  ledger_if "$1" approval - - "$(ledger_token "approvals/$br_n-$br_slug.yaml" "$1") $2 source=batch answered_by=user bound=$(gate_field "$3" bound) via_batch=$4"
  echo "batch approval recorded: $1 $2"
}
# batch_cover ID KIND: records the approval of a plan, a delivery or a mutation budget as the user's, only while every check holds.
batch_cover() {
  bc_id=$1 bc_k=$2; require_lead
  case "$bc_k" in plan|delivery|mutation_budget) ;;
    rationale:*)
      # a DESIGN.md pattern justification the user accepted for this batch with the one accept answer; the line must be exactly the one the approved summary lists
      batch_accept_given || fail "no accepted list in the approved batch: the user has not answered the accept question of the summary with b"
      bc_rl=$(rationale_line "${bc_k#rationale:}"); [ -n "$bc_rl" ] || fail "DESIGN.md has no justification line for ${bc_k#rationale:}"
      grep -Fxq -- "- accept R $bc_rl" "$(batch_dir)/SUMMARY.md" || fail "the DESIGN.md line for ${bc_k#rationale:} is not the one the approved batch summary lists (changed or never listed): the user approves it on its own" ;;
    *) fail "$bc_k is not covered by the batch approval (only plan, delivery, mutation_budget, rationale:<pattern> accepted in the summary)" ;; esac
  batch_approval >/dev/null || fail "no valid batch approval for the current summary"
  bc_h=$(hash_file "$(batch_dir)/SUMMARY.md")
  awk -F'\t' -v t="$bc_id" '$1 == t { f = 1 } END { exit !f }' "$(batch_dir)/order.tsv" 2>/dev/null || fail "$bc_id is not in the batch (excluded or never planned)"
  require_run "$bc_id"; require_open_run "$bc_id"
  bc_c=$(pipeline_class "$bc_id")
  { pipeline_class_valid "$bc_c" && [ "$bc_c" != CRITICAL ]; } || fail "run $bc_id is classified ${bc_c:-unknown}: CRITICAL or unclassified work is not covered by the batch approval"
  bc_list=''
  if [ "$bc_k" = delivery ]; then
    [ -f "$(deliver_dir "$bc_id")/SUMMARY.md" ] || fail "no delivery summary for $bc_id (agent.sh deliver-plan $bc_id first)"
    bc_dh=$(hash_file "$(deliver_dir "$bc_id")/SUMMARY.md")
    for bc_s in commit push pr merge cleanup; do
      bc_rq=$(pending_request "$bc_id" "$bc_s") || continue
      [ "$(gate_field "$bc_rq" delivery)" = "$bc_dh" ] && [ "$(gate_field "$bc_rq" bound)" = "$(approval_bound "$bc_id" "$bc_s")" ] || continue
      bc_list="$bc_list $bc_s"
    done
    [ -n "$bc_list" ] || fail "no pending delivery step request of the current summary for $bc_id"
    for bc_s in $bc_list; do batch_record "$bc_id" "$bc_s" "$(pending_request "$bc_id" "$bc_s")" "$bc_h" "$bc_dh"; done
    return 0
  fi
  bc_rq=$(pending_request "$bc_id" "$bc_k") || fail "no pending $bc_k request for $bc_id"
  [ "$(gate_field "$bc_rq" bound)" = "$(approval_bound "$bc_id" "$bc_k")" ] || fail "the content changed since the $bc_k request; request again"
  if [ "$bc_k" = mutation_budget ]; then
    bc_cap=$(cfg batch.mutation_budget_cap 40); case "$bc_cap" in ''|*[!0-9]*) bc_cap=40 ;; esac
    bc_n=$(plan_test_acs "$(run_dir "$bc_id")/PLAN.md")
    [ "$bc_n" -le "$bc_cap" ] || fail "mutation budget: PLAN ## Tests names $bc_n criteria, above the batch cap $bc_cap: not covered by the batch approval"
    batch_record "$bc_id" "$bc_k" "$bc_rq" "$bc_h" '' "$bc_cap"
  else batch_record "$bc_id" "$bc_k" "$bc_rq" "$bc_h"; fi
}

# --- Waivers (D16) -------------------------------------------------------------------------
gate_latest_file() { # ID GATE [FOCUS] -> latest record after the last reopen (of that focus; '-' = the gate's own)
  gl_reopen=$(last_reopen_seq "$1"); gl_last=''
  gl_fc=${3:-}; [ "$gl_fc" != - ] || gl_fc=$(gate_focus "$2")
  for gl_n in $(gate_names "$1"); do
    gl_f=$(gates_dir "$1")/$gl_n
    [ "$(gate_field "$gl_f" gate)" = "$2" ] && [ "$(gate_field "$gl_f" seq)" -gt "$gl_reopen" ] || continue
    [ -z "${3:-}" ] || [ "$(gate_field "$gl_f" focus)" = "$gl_fc" ] || continue
    gl_last=$gl_f
  done
  printf '%s\n' "$gl_last"
}
# waive_target ID FINDING-ID [FINGERPRINT]: the gate record holding that open blocking finding on the current
# content; SECRETS and SECURITY findings are refused.
waive_target() {
  wt_now=${3:-$(gate_fingerprint)} wt_rec=''
  for wt_g in $(required_gates "$1"); do
    for wt_fc in - $(risk_gate_focuses "$1" "$wt_g"); do
      [ "$(gate_focus_status "$1" "$wt_g" "$wt_fc" strict "$wt_now")" = fail ] || continue
      wt_f=$(gate_latest_file "$1" "$wt_g" "$wt_fc")
      if blocking_finding_ids "$wt_f" | grep -Fxq -- "$2"; then wt_rec=$wt_f; fi
    done
  done
  # explicit returns: callers use it inside || where `set -e` is off
  [ -n "$wt_rec" ] || { fail "no open blocking finding $2 on the current content of $1"; return 1; }
  case "$(gate_field "$wt_rec" gate)" in SECRETS|SECURITY) fail "$(gate_field "$wt_rec" gate) findings are never waivable"; return 1 ;; esac
  printf '%s\n' "$wt_rec"
}
# A172: a finding id typed by a person (waive, the approval kind waive:<id>) is matched by key against the open blocking
# findings and used in the spelling the gate record holds; an id that matches nothing is returned as typed (waive_target refuses it).
waive_canon() { # ID FINDING-ID
  wc_rec=$(waive_target "$1" "$2" 2>/dev/null) || { printf '%s\n' "$2"; return 0; }
  wc_hit=$(blocking_finding_ids "$wc_rec" | while IFS= read -r wc_x; do if id_eq "$wc_x" "$2"; then printf '%s\n' "$wc_x"; break; fi; done)
  printf '%s\n' "${wc_hit:-$2}"
}
canon_kind() { # ID KIND -> the approval kind with a waive:<id> in the recorded spelling of the finding id
  case "$2" in waive:*) if [ "$1" = - ]; then printf '%s\n' "$2"; else printf 'waive:%s\n' "$(waive_canon "$1" "${2#waive:}")"; fi ;; *) printf '%s\n' "$2" ;; esac
}
# finding_rule_key RECORD FINDING-ID: the rule of a finding, for grouping: its text without numbers and colours, lower case.
finding_rule_key() {
  awk -v want="$2" '/^finding: / { r = $0; sub(/^finding: /, "", r); n = split(r, p, "|"); if (p[1] == want) { print tolower(p[4]); exit } }' "$1" | sed 's/#[0-9a-f]\{3,8\}//g; s/[0-9][0-9]*//g' | tr -cs 'a-z' ' ' | sed 's/^ //;s/ $//'
}
# waive_group_ids RECORD FINDING-ID: the open blocking findings of that gate record with the rule of FINDING-ID (FINDING-ID first), one per line.
waive_group_ids() {
  wg_k=$(finding_rule_key "$1" "$2"); printf '%s\n' "$2"
  [ -n "$wg_k" ] || return 0
  for wg_x in $(blocking_finding_ids "$1"); do
    [ "$wg_x" != "$2" ] || continue
    [ "$(finding_rule_key "$1" "$wg_x")" = "$wg_k" ] && printf '%s\n' "$wg_x"
  done
  return 0
}

# --- Questions (D13) -----------------------------------------------------------------------
questions_show() {
  qs_d=$(run_dir "$1")/questions; qs_any=no
  for qs_f in "$qs_d"/[0-9][0-9][0-9].md; do
    [ -e "$qs_f" ] || continue
    [ ! -e "${qs_f%.md}.answer.md" ] || continue
    qs_any=yes; printf '=== QUESTION %s (from %s)\n' "$(basename "$qs_f" .md)" "$(gate_field "$qs_f" from)"
    sed '1,/^---$/d' "$qs_f"
  done
  [ "$qs_any" = yes ] || echo "no pending questions: $1"
}
# assumption_prompt_accepts PROMPT ID: the user's captured prompt accepts assumption ID (A79) only when it STARTS with
# `accept <id>` (several leading `accept AS-n` clauses are allowed, joined by , ; & and) and the rest of the prompt
# holds no negation or condition word. A substring match would take "do not accept AS-1" or "never said accept AS-1".
assumption_prompt_accepts() {
  apa_p=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/^ //')
  apa_rest=$(printf '%s' "$apa_p" | sed -E 's/^((accept|accepted) as-[0-9]+( *(,|;|&|and) *)?)+//')
  [ "$apa_rest" != "$apa_p" ] || return 1
  apa_head=${apa_p%"$apa_rest"}
  printf '%s' "$apa_head" | grep -Eq "(accept|accepted) $(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')([^0-9]|\$)" || return 1
  # negations and conditions (English, Turkish): the prompt is then not a plain acceptance
  if printf ' %s ' "$apa_rest" | grep -Eq "(^|[^[:alpha:]])(not|never|no|nope|n't|don't|dont|do not|only if|if|unless|but|except|until|yet|wait|without|maybe|reject|rejected|decline|declined|or|actually|instead|rather|değil|degil|hayır|hayir|reddet|reddediyorum|yerine|olmasın|olmasin|sadece eğer|sadece eger|ama|eğer|eger)([^[:alpha:]]|$)"; then return 1; fi
  return 0
}
# quote_block: stdin -> the same text as a quote block, every line prefixed with '> ' (A171): the one syntax in which the
# user's own words (an answer, an approval) are kept verbatim in a run file; the language check exempts these lines.
epoch_iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$1"; }
quote_block() { sed 's/^\(.\)/> \1/; s/^$/>/'; }
# answer ID N [--captured|--amend]: record the answer to question N. --captured takes the NEWEST user message captured
# after the question was asked (A171; A171 replaces "oldest unused": a later correction by the user is what counts) and says
# which message it took. --amend replaces a recorded answer with a newer captured user message: the old answer file is kept,
# renamed NNN.answer.amended-K.md and marked `amended: true`; only a captured user message amends, never the lead's text.
answer() {
  an_id=$1 an_n=$2; require_run "$an_id"; require_lead; an_d=$(run_dir "$an_id")
  [ -z "${PROOFLINE_BRIDGED:-}" ] || fail "answer is a Node command: the shell code does not record answers through the bridge guard (A210)"
  case "$an_n" in ''|*[!0-9]*) fail "question number must be numeric" ;; esac
  an_q=$an_d/questions/$(printf '%03d' "$(printf '%s' "$an_n" | sed 's/^0*//; s/^$/0/')").md
  [ -f "$an_q" ] || fail "no question $an_n for $an_id"
  an_amend=no; [ "${3:-}" != --amend ] || an_amend=yes
  an_prev=${an_q%.md}.answer.md
  if [ "$an_amend" = yes ]; then
    [ -e "$an_prev" ] || fail "question $an_n has no answer to amend"
  else
    [ ! -e "$an_prev" ] || fail "question $an_n is already answered (a wrong answer is corrected with: agent.sh answer $an_id $an_n --amend, after the user's new message)"
  fi
  an_t=$(mktemp "${TMPDIR:-/tmp}/proofline-answer.XXXXXX"); an_cm=no an_used='' an_src=''
  if [ "${3:-}" = --captured ] || [ "$an_amend" = yes ]; then
    # The answer is the user's own message as the prompt hook captured it, not text the lead relays: a lead's rewrite never
    # matched, a short "1" was under the 3-character rule. A171: the NEWEST real prompt since the question (by its capture time),
    # not the oldest unused one: an earlier message may be a remark, the latest is what the user settled on.
    an_cm=yes; an_a0=$(gate_field "$an_q" asked_at); case "$an_a0" in ''|*[!0-9]*) an_a0=0 ;; esac
    an_prevsrc=''
    if [ "$an_amend" = yes ]; then
      an_pe=$(gate_field "$an_prev" answered_epoch); case "$an_pe" in ''|*[!0-9]*) an_pe=$an_a0 ;; esac
      an_a0=$an_pe; an_prevsrc=$(gate_field "$an_prev" source_message)
    fi
    an_pick=''
    for an_h in $(ls -1 "$(shared_dir prompts)"/history/*.txt 2>/dev/null | sort); do
      an_e=${an_h##*/}; an_e=${an_e%%-*}; case "$an_e" in ''|*[!0-9]*) continue ;; esac
      [ "$an_e" -ge "$an_a0" ] || continue
      grep -q '[^[:space:]]' "$an_h" && [ "$(head -c 19 "$an_h")" != '<task-notification>' ] || continue
      [ "${an_h##*/}" != "$an_prevsrc" ] || continue
      # an amend takes the newest message no answer has used (a used one belongs to another question)
      [ "$an_amend" = no ] || ! grep -qxF "${an_h##*/}" "$(shared_dir prompts)/consumed" 2>/dev/null || continue
      an_pick=$an_h
    done
    [ -n "$an_pick" ] || { rm -f "$an_t"; if [ "$an_amend" = yes ]; then fail "no captured user message newer than the recorded answer to question $an_n: only a new message of the user corrects an answer (ask the user, wait for the reply, then run this again)"; fi; fail "no captured user prompt since question $an_n was asked: the user has not answered it (or the prompt hook is not wired)"; }
    # one message answers one question: the newest message was already used by an earlier --captured answer
    if grep -qxF "${an_pick##*/}" "$(shared_dir prompts)/consumed" 2>/dev/null; then rm -f "$an_t"; fail "the user's newest message since question $an_n (${an_pick##*/}) already answered another question: the user has not answered this one yet"; fi
    cat "$an_pick" > "$an_t"; an_used=${an_pick##*/}; an_src=$an_used
  else cat > "$an_t"; fi
  grep -q '[^[:space:]]' "$an_t" || { rm -f "$an_t"; fail "empty answer"; }
  # answered_by user only when the newest prompt capture is not older than the question (epoch seconds), its sha256 matches its
  # text, and the trimmed answer (at least 3 characters) is contained in it.
  # A79: a question bound to an assumption: acceptance is stricter than a substring (assumption_prompt_accepts).
  an_tok=$(sed -n 's/^[[:space:]]*ASSUMPTION: \([^[:space:]]*\)[[:space:]]*$/\1/p' "$an_q" | head -1); an_acc=no
  an_by=lead an_asked=$(gate_field "$an_q" asked_at); case "$an_asked" in ''|*[!0-9]*) an_asked='' ;; esac
  an_norm=$(tr -s '[:space:]' ' ' < "$an_t" | sed 's/^ //; s/ $//')
  if [ "$an_cm" = yes ]; then
    an_by=user; if [ -n "$an_tok" ] && assumption_prompt_accepts "$an_norm" "${an_tok%@*}"; then an_acc=yes; fi
  elif [ -n "$an_asked" ] && [ "${#an_norm}" -ge 3 ] && an_cap=$(latest_capture); then
    an_ct=$(mktemp "${TMPDIR:-/tmp}/proofline-capture.XXXXXX")
    capture_field "$an_cap" text > "$an_ct" || :
    an_ctime=$(capture_field "$an_cap" time 2>/dev/null || echo 0)
    if [ "$an_ctime" -ge "$an_asked" ] && [ "$(hash_file "$an_ct")" = "$(capture_field "$an_cap" sha256 2>/dev/null || true)" ]; then
      an_cnorm=$(tr -s '[:space:]' ' ' < "$an_ct")
      case "$an_cnorm" in *"$an_norm"*) an_by=user ;; esac
      if [ "$an_by" = user ] && [ -n "$an_tok" ] && assumption_prompt_accepts "$an_cnorm" "${an_tok%@*}"; then an_acc=yes; fi
    fi
    rm -f "$an_ct"
  fi
  # An accept the user's prompt does not carry (negated, conditional, not at its start) is the lead's, never the user's;
  # the user's accept is stored normalized as exactly `accept <id>`.
  if [ -n "$an_tok" ] && printf '%s' "$an_norm" | grep -Eiq '^accept'; then
    if [ "$an_acc" = yes ]; then printf 'accept %s\n' "${an_tok%@*}" > "$an_t"; else an_by=lead; fi
  elif [ "$an_by" = user ]; then
    quote_block < "$an_t" > "$an_t.q" && mv "$an_t.q" "$an_t"   # A171: the user's words are kept as a verbatim quote block
  fi
  an_amends=''
  if [ "$an_amend" = yes ]; then
    an_k=1; while [ -e "${an_q%.md}.answer.amended-$an_k.md" ]; do an_k=$((an_k + 1)); done
    an_amends=$(basename "${an_q%.md}.answer.amended-$an_k.md")
    awk -v t="$(now_epoch)" 'NR == 1 { print "amended: true"; print "amended_at: " t } { print }' "$an_prev" > "$an_d/questions/$an_amends" && rm -f "$an_prev" || { rm -f "$an_t"; fail "could not keep the old answer of question $an_n"; }
  fi
  { printf 'answered_by: %s\ntime: %s\nanswered_epoch: %s\n' "$an_by" "$(now_iso)" "$(now_epoch)"
    [ -z "$an_src" ] || printf 'source_message: %s\n' "$an_src"
    [ -z "$an_amends" ] || printf 'amends: %s\n' "$an_amends"
    printf -- '---\n'; cat "$an_t"; } > "${an_q%.md}.answer.md"; rm -f "$an_t"; [ -z "${an_used:-}" ] || printf '%s\n' "$an_used" >> "$(shared_dir prompts)/consumed"   # consumed only once the answer is written
  an_left=no; for an_f in "$an_d"/questions/[0-9][0-9][0-9].md; do [ -e "$an_f" ] && [ ! -e "${an_f%.md}.answer.md" ] && an_left=yes; done
  if [ "$an_left" = no ] && section_key_present "$an_d" execution awaiting_input; then set_run_value "$an_id" execution awaiting_input false; fi
  # A79: a question bound to an assumption (`ASSUMPTION: <id>@<hash>`): the answer row names it; acceptance is
  # derived from the answer file (answered_by user, starting "accept <id>") by verify-assumptions.
  an_as=$(sed -n 's/^[[:space:]]*ASSUMPTION: \([^[:space:]]*\)[[:space:]]*$/ assumption=\1/p' "$an_q" | head -1)
  an_ev=answer; [ "$an_amend" = no ] || an_ev=answer-amend
  if gates_enforced "$an_id"; then ledger_append "$an_id" "$an_ev" - - "$(basename "$an_q") answered_by=$an_by${an_src:+ source=$an_src}${an_amends:+ amends=$an_amends}$an_as"; fi
  status_block_update "$an_id" answer
  echo "answer recorded: $an_id $(basename "$an_q" .md) answered_by=$an_by${an_amends:+ (amends $an_amends, the old record is kept)}"
  if [ -n "$an_src" ]; then echo "answer source: the user's message ${an_src} ($(epoch_iso "${an_src%%-*}")): $(tr -s '[:space:]' ' ' < "$(shared_dir prompts)/history/$an_src" | cut -c1-80)"; fi
  if [ -n "$an_as" ] && [ "$an_by" != user ]; then echo "note:${an_as}: not an acceptance the user's own prompt carries (answered_by=$an_by; the prompt must start with 'accept <id>' and hold no negation or condition), so the assumption stays unaccepted"; fi
}

role_results_count() { # ID ROLE [FOCUS] -> recorded results of exactly this role (and focus: the FOCUS header of the raw message)
  rc_n=0
  for rc_f in "$(run_dir "$1")"/results/[0-9][0-9][0-9]-"$2".result.md; do
    [ -f "$rc_f" ] || continue
    if [ -n "${3:-}" ]; then grep -qx "FOCUS: $3" "$rc_f" || continue; fi
    rc_n=$((rc_n + 1))
  done
  echo "$rc_n"
}
decision_files() { ls -1 "$(run_dir "$1")/decisions" 2>/dev/null | grep -E '^[0-9]{3}-.*\.decision$' | sort || true; }
latest_decision() { # ID ROLE [FOCUS]
  ld_tag=$2; [ -z "${3:-}" ] || ld_tag="$2-$(printf '%s' "$3" | tr '+' '-')"
  ld_hit=''; for ld_f in $(decision_files "$1"); do case "$ld_f" in [0-9][0-9][0-9]-"$ld_tag".decision) ld_hit=$(run_dir "$1")/decisions/$ld_f ;; esac; done
  printf '%s\n' "$ld_hit"
}
# A132: max_explorers bounds the explorer slots of one planning phase. A slot is a DELIVERED report (a DONE result
# recorded after the last freeze or refreeze) or an explorer dispatch still running. BLOCKED and NEEDS_INPUT hold
# no slot (their retry or ANSWERS re-dispatch completes the same slot); neither does a dispatch that ended without a
# result. A limit of 0 is not checked here (the class pipeline decides whether explorers exist).
explorer_slot_check() {
  es_id=$1 es_class=$2; es_max=$(pipeline_value "$es_class" max_explorers)
  case "$es_max" in ''|*[!0-9]*|0) return 0 ;; esac
  es_d=$(run_dir "$es_id"); es_l=$(ledger_file "$es_id"); es_floor=0
  if [ -f "$es_l" ]; then es_floor=$(awk '/ event=(freeze|refreeze) / { s = $1; sub(/^seq=/, "", s); f = s } END { print f + 0 }' "$es_l"); fi
  es_have='' es_keys=''
  for es_f in $(ls -1 "$es_d/results" 2>/dev/null | grep -E '^[0-9]{3}-explorer\.result\.md$' || true); do
    grep -qx 'RESULT: DONE' "$es_d/results/$es_f" || continue
    es_s=''; [ ! -f "$es_l" ] || es_s=$(grep "detail=results/$es_f " "$es_l" | sed -n 's/^seq=\([0-9]*\) .*/\1/p' | tail -n 1)
    [ -z "$es_s" ] || [ "$es_s" -gt "$es_floor" ] || continue
    # one explorer = one allocated report: a resubmitted (revised) report is another result file for the same slot
    es_k=$(sed -n 's/^ARTIFACT: [^ ]*\/[0-9a-f]\{12\}-\([^ ]*\) .*/\1/p' "$es_d/results/$es_f" | head -n 1)
    [ -z "$es_k" ] || case " $es_keys " in *" $es_k "*) continue ;; esac
    es_keys="$es_keys $es_k"
    es_have="$es_have $es_f"
  done
  es_open=0
  for es_m in "$es_d"/dispatch/*-explorer-*.running; do
    [ -f "$es_m" ] || continue
    # a dispatch whose submission is already recorded is counted as its delivered result, not twice
    es_b=${es_m##*/}; ! grep -qx 'status=ok' "$(submission_dir)/d${es_b%.running}.status" 2>/dev/null || continue
    ! inflight_pid_alive "$(sed -n 's/^pid=//p' "$es_m" | head -n 1)" "$es_m" || es_open=$((es_open + 1))
  done
  es_n=$(printf '%s\n' "$es_have" | wc -w | tr -d ' ')
  [ $((es_n + es_open)) -lt "$es_max" ] || fail "decide refused (A132): class $es_class allows $es_max explorer slot(s) (pipelines.$es_class.max_explorers) and run $es_id holds ${es_n} delivered result(s)${es_have:+ ($es_have )}and $es_open running explorer dispatch(es). Consolidate EVIDENCE.md from the delivered reports; a BLOCKED or NEEDS_INPUT result or a dispatch that returned nothing holds no slot and is re-dispatched. The count restarts at each freeze/refreeze, so an extra explorer after a plan amendment is allowed once the plan is refrozen"
}
ui_surface_signal() { # ID [MODE] -> 0 when the task's UI surface is persuade or experience
  uss_d=$(run_dir "$1")
  case "$2" in persuade|experience) return 0 ;; esac
  { [ ! -f "$uss_d/design/ui.json" ] || tr -d '\n' < "$uss_d/design/ui.json" | grep -oE '"visitor_mode"[[:space:]]*:[[:space:]]*\{[^}]*"mode"[[:space:]]*:[[:space:]]*"[a-z]+"' | sed 's/.*"//;s/"$//'
    [ ! -f "$uss_d/PLAN.md" ] || awk '/^## /{ui=($0 ~ /^## UI/)} ui && /^[-* ]*`?visitor_mode`?:/{ sub(/^[^:]*:[[:space:]]*/, ""); sub(/[[:space:]].*$/, ""); print }' "$uss_d/PLAN.md"
  } | grep -qxE 'persuade|experience'
}
decide() {
  dc_id=$1 dc_role=$(canon_role "$2"); shift 2; require_run "$dc_id"; require_lead; require_open_run "$dc_id"
  valid_role "$dc_role" || fail "invalid role: $dc_role"
  dc_class=$(pipeline_class "$dc_id"); pipeline_class_valid "$dc_class" || fail "run $dc_id is not classified: the execution policy is derived from its class"
  dc_focus='' dc_over='' dc_uimode='' dc_dry=no dc_ap=no dc_redo=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry) dc_dry=yes; shift ;;
      --agent-path) dc_ap=yes; shift ;;
      --redecide) dc_redo=yes; dc_ap=yes; shift ;;
      --ui-mode) dc_uimode=${2:?--ui-mode needs a value}; shift 2 ;;
      --focus) dc_focus=${2:?--focus needs a value}; shift 2 ;;
      --model|--effort|--context-bytes|--runtime|--runtime-reason) [ $# -ge 2 ] || fail "$1 needs a value"; dc_over="$dc_over $1 $2"; shift 2 ;;   # --runtime-reason: only dispatch.sh, for an automatic failover (A203)
      *) fail "unknown decide argument: $1" ;;
    esac
  done
  # A171: decide records the decision of one dispatch (a decisions/ file, a ledger event, an escalation count). It is run by dispatch.sh
  # (which sets PROOFLINE_DISPATCH) or, on the Agent path, once right before the Agent call (--agent-path). Called ahead of a `D`
  # dispatch it only duplicates the decision that dispatch.sh makes itself; to just read the decision use --dry (writes nothing).
  [ "$dc_dry$dc_ap" != yesyes ] || fail "decide --dry and --agent-path exclude each other: --dry only reads, --agent-path records"
  # The exemption is a per-dispatch nonce: dispatch.sh writes .agents/local/dispatch/nonce-<value> for the one decide it runs and
  # removes it right after, so setting the variable by hand (any spelling) proves nothing.
  # The nonce file holds the pid of the dispatch.sh that wrote it: it must be alive and an ancestor of this process; the file is
  # removed on acceptance (one use).
  dc_nonce=${PROOFLINE_DISPATCH:-}; dc_nok=no
  case "$dc_nonce" in ''|*[!0-9a-f]*) ;; *)
    dc_nf=$root/.agents/local/dispatch/nonce-$dc_nonce
    if [ "${#dc_nonce}" -ge 16 ] && [ -f "$dc_nf" ]; then
      dc_npid=$(head -n 1 "$dc_nf" 2>/dev/null)
      case "$dc_npid" in ''|*[!0-9]*) ;; *)
        if kill -0 "$dc_npid" 2>/dev/null; then
          dc_anc=$$; dc_hops=0
          while [ "$dc_hops" -lt 12 ] && [ -n "$dc_anc" ] && [ "$dc_anc" -gt 1 ]; do
            [ "$dc_anc" != "$dc_npid" ] || { dc_nok=yes; break; }
            dc_anc=$(ps -o ppid= -p "$dc_anc" 2>/dev/null | tr -d ' '); dc_hops=$((dc_hops + 1))
          done
        fi ;; esac
      [ "$dc_nok" != yes ] || [ "$dc_dry" = yes ] || [ "$dc_ap" = yes ] || rm -f "$dc_nf"
    fi ;; esac
  case "$dc_over " in *" --runtime-reason "*) [ "$dc_nok" = yes ] || fail "decide --runtime-reason is dispatch.sh's alone (an automatic failover): the lead does not label its own choice" ;; esac
  [ "$dc_dry" = yes ] || [ "$dc_ap" = yes ] || [ "$dc_nok" = yes ] ||
    fail "decide refused (A171): it records the decision of a dispatch and is not called ahead of one. Dispatch with dispatch.sh (it decides itself); to only read the decision run: agent.sh decide $dc_id $dc_role --dry (writes nothing); on the Agent path run it once, right before the Agent call: agent.sh decide $dc_id $dc_role --agent-path"
  [ "$dc_role" != explorer ] || explorer_slot_check "$dc_id" "$dc_class"
  # A171 (review): the Agent route decides once per step. A second --agent-path for the same role and focus is refused until a
  # result of that role is recorded after the first (explorers run in parallel and are bounded by their slots instead).
  if [ "$dc_redo" = yes ]; then
    [ "$execution_role" = lead ] || fail "decide --redecide is the lead's"
    gates_enforced "$dc_id" && ledger_append "$dc_id" note - - "decide --redecide $dc_role${dc_focus:+ focus=$dc_focus}: the earlier Agent-route decision stays in decisions/; another runtime or model is wanted"
  elif [ "$dc_ap" = yes ] && [ "$dc_role" != explorer ]; then
    dc_pv=$(latest_decision "$dc_id" "$dc_role" "$dc_focus")
    if [ -n "$dc_pv" ] && grep -qx 'via=agent-path' "$dc_pv" && [ "$(sed -n 's/^results_n=//p' "$dc_pv" | head -n 1)" = "$(role_results_count "$dc_id" "$dc_role" "$dc_focus")" ]; then
      fail "decide --agent-path refused: the $dc_role${dc_focus:+ ($dc_focus)} decision ${dc_pv##*/} was recorded for the Agent call and no result has been recorded since. Make the Agent call with that decision (agent.sh decide $dc_id $dc_role${dc_focus:+ --focus $dc_focus} --dry shows it again), or record its result first, or to choose another runtime or model: agent.sh decide $dc_id $dc_role${dc_focus:+ --focus $dc_focus} --redecide [--runtime R] [--model M]"
    fi
  fi
  # A171: a gate whose dependency has not completed is not dispatched
  if dc_dgate=$(gate_of "$dc_role" "$dc_focus" "$dc_id" 2>/dev/null) && [ -n "$(gate_deps "$dc_id" "$dc_dgate")" ]; then
    dc_unmet=$(gate_deps_unmet "$dc_id" "$dc_dgate" | tr '\n' ' ')
    [ -z "$dc_unmet" ] || fail "$dc_dgate needs ${dc_unmet% } first (GATES.md, Gate dependencies): dispatch that gate and let it pass for the current content, then run this again ('agent.sh next $dc_id' lists the order)"
  fi
  dc_tier=$(tier_effective "$dc_id"); dc_sig=''
  [ "$dc_class" != CRITICAL ] || dc_sig="$dc_sig critical_class"
  dc_stats=$(diff_stats "$dc_id"); if [ "${dc_stats% *}" -gt 15 ] || [ "${dc_stats#* }" -gt 400 ]; then dc_sig="$dc_sig large_diff"; fi
  [ "$(fix_rounds_used "$dc_id")" -lt 2 ] || dc_sig="$dc_sig fix_round_2"
  # 0.0.27 (A170): a UI task on a persuade or experience surface puts designer and implementer on the strongest model.
  # Detected from the run's own files: design/ui.json `visitor_mode.mode` (spec or any screen) or the PLAN.md `## UI`
  # line `visitor_mode: <mode>`; before the designer has written either, the lead names the surface with `--ui-mode`.
  case "$dc_role" in designer|implementer) ui_surface_signal "$dc_id" "$dc_uimode" && dc_sig="$dc_sig ui_persuade" ;; esac
  if dc_gate=$(gate_of "$dc_role" "$dc_focus" "$dc_id" 2>/dev/null); then
    dc_lf=$(gate_latest_file "$dc_id" "$dc_gate" "${dc_focus:--}")
    if [ -n "$dc_lf" ]; then
      case "$(gate_field "$dc_lf" result)" in fail) dc_sig="$dc_sig recent_fail_same_focus" ;; pass_low) dc_sig="$dc_sig low_confidence_pass" ;; esac
    fi
  fi
  # Runtime and profile are passed only when overridden (decide --runtime, RUN.yaml execution.profile), so the
  # resolver records the real reason from config otherwise.
  dc_prof=$(section_value "$(run_dir "$dc_id")" execution profile)
  set -- resolve --role "$dc_role" --class "$dc_class" --tier "$dc_tier"
  case "$dc_prof" in max|balanced|economy) set -- "$@" --profile "$dc_prof" ;; *) dc_prof=$(run_profile "$dc_id") ;; esac
  for dc_s in $dc_sig; do set -- "$@" --signal "$dc_s"; done
  dc_esc=0; for dc_f in $(decision_files "$dc_id"); do grep -qx 'escalated=yes' "$(run_dir "$dc_id")/decisions/$dc_f" && dc_esc=$((dc_esc + 1)); done
  set -- "$@" --escalations-used "$dc_esc"
  # shellcheck disable=SC2086 # overrides are flag/value pairs without whitespace
  set -- "$@" $dc_over
  dc_rc=0
  # A222: the resolver is the Node core's (cli exec-policy); a project's own .agents/scripts/exec-policy.sh (the fixture stub of the self-tests) is run by it instead
  dc_res=$(pl_core cli exec-policy "$@") || dc_rc=$?
  if [ "$dc_rc" != 0 ]; then [ "$dc_rc" != 1 ] || dc_rc=4; echo "decision refused by the execution policy (exit $dc_rc)" >&2; return "$dc_rc"; fi
  # A200: the Agent path runs a Claude Code subagent. A role the configuration gives to another runtime (Codex, a command template) is
  # dispatched with dispatch.sh; recording an Agent-path decision for it would run the role on the wrong runtime without a word.
  if [ "$dc_ap" = yes ]; then
    dc_rt=$(printf '%s\n' "$dc_res" | sed -n 's/^runtime=//p' | head -n 1)
    case "$dc_rt" in ''|claude) ;; *) fail "decide --agent-path refused (A200): the role $dc_role is configured for the runtime $dc_rt, not Claude Code, so it has no Agent path. Dispatch it instead: dispatch.sh $dc_id $dc_role${dc_focus:+ --focus $dc_focus} --prompt-file <assignment file> (it decides itself). To run this role on Claude Code instead, the user changes runtime.roles.$dc_role (or the group key) in .agents/config.yaml" ;; esac
  fi
  dc_body=$(printf '%s\nrole=%s\nfocus=%s\nclass=%s\ntier=%s\nprofile=%s\nsignals=%s\ndecided_at=%s\n' "$dc_res" "$dc_role" "$dc_focus" "$dc_class" "$dc_tier" "$dc_prof" "$(printf '%s' "$dc_sig" | sed 's/^ //' | tr ' ' ',')" "$(now_epoch)")
  [ "$dc_ap" != yes ] || dc_body="$dc_body
via=agent-path
results_n=$(role_results_count "$dc_id" "$dc_role" "$dc_focus")"
  # The first line is a one-line summary (role, runtime, model, effort, reason): a truncated output still reads right (A171).
  dc_v() { printf '%s\n' "$dc_body" | sed -n "s/^$1=//p" | head -n 1; }
  dc_sum="decision: role=$(dc_v role) runtime=$(dc_v runtime) model=$(dc_v model) effort=$(dc_v effort) reason=$(dc_v model_reason)"
  if [ "$dc_dry" = yes ]; then printf '%s (dry run: nothing recorded)\n%s\n' "$dc_sum" "$dc_body"; return 0; fi
  dc_dir=$(run_dir "$dc_id")/decisions; mkdir -p "$dc_dir"
  dc_tag=$dc_role; [ -z "$dc_focus" ] || dc_tag="$dc_role-$(printf '%s' "$dc_focus" | tr '+' '-')"
  dc_out=$dc_dir/$(next_num "$dc_dir")-$dc_tag.decision
  printf '%s\n' "$dc_body" > "$dc_out.tmp"
  mv "$dc_out.tmp" "$dc_out"
  if gates_enforced "$dc_id"; then ledger_append "$dc_id" decide - - "$(basename "$dc_out") runtime=$(sed -n 's/^runtime=//p' "$dc_out" | head -1) model=$(sed -n 's/^model=//p' "$dc_out" | head -1) effort=$(sed -n 's/^effort=//p' "$dc_out" | head -1) signals=${dc_sig# }"; fi
  printf '%s\n' "$dc_sum"; cat "$dc_out"; echo "decision_file=${dc_out#"$root"/}"
}

# ledger-note: a ledgered free-text note (lead or dispatch.sh: failover, policy violation, ...).
ledger_note() {
  ln_id=$1 ln_text=$2; require_run "$ln_id"; require_lead
  gates_enforced "$ln_id" || fail "ledger-note requires the lifecycle_gates policy"
  [ -n "$(printf '%s' "$ln_text" | tr -d '[:space:]')" ] || fail "ledger-note needs text"
  verify_seal "$ln_id"
  ln_s=$(section_value "$(run_dir "$ln_id")" handoff state)
  ledger_append "$ln_id" note "$ln_s" "$ln_s" "$ln_text"
  echo "ledger note recorded: $ln_id"
}

# friction-note (A171): the lead (or the Stop hook) records that the user was asked to run an internal command or a shell command.
# That is a proofline bug, never normal flow; the ledger event counts in the friction report. KIND is a controlled word (no free
# text, so nothing identifying reaches the report): user-command (an agent.sh/approve/answer command) | user-shell (a shell command) | proofline_bug (A196: any other proofline failure the lead had to work around).
friction_note() {
  fn_id=$1 fn_kind=${2:-}; require_run "$fn_id"; require_lead
  case "$fn_kind" in user-command|user-shell|proofline_bug) ;; *) fail "usage: agent.sh friction-note <ID> <user-command|user-shell|proofline_bug>" ;; esac
  gates_enforced "$fn_id" || { echo "friction noted (not ledgered: the run has no lifecycle_gates policy): $fn_kind"; return 0; }
  verify_seal "$fn_id"
  fn_s=$(section_value "$(run_dir "$fn_id")" handoff state)
  ledger_append "$fn_id" friction-note "$fn_s" "$fn_s" "$fn_kind"
  echo "friction noted: $fn_kind"
}
# wait-line (A171): the one-line status for a wait. `agent.sh wait-line <ID> ["WHAT"] [--done]` prints
# `waiting: <what>, <M>m<SS>s so far`; WHAT defaults to the dispatch in flight. The first call for a WHAT starts its clock
# (.agents/local/wait/); --done stops it. The lead prints this line and nothing more while it waits.
wait_line() {
  wl_id=$1 wl_what=${2:-} wl_done=no; require_run "$wl_id"; require_lead
  if [ "$wl_what" = --done ]; then wl_what=''; wl_done=yes; fi
  [ "${3:-}" != --done ] || wl_done=yes
  if [ -z "$wl_what" ]; then
    if wl_if=$(inflight_dispatch "$wl_id"); then wl_what="dispatch ${wl_if% *}"; else fail "nothing is in flight: name what you wait for, for example agent.sh wait-line $wl_id \"CI of the pull request\""; fi
  fi
  wl_what=$(printf '%s' "$wl_what" | tr -c 'A-Za-z0-9 ._-' ' ' | cut -c1-80)
  wl_f=$root/.agents/local/wait/$wl_id-$(printf '%s' "$wl_what" | tr -c 'A-Za-z0-9' '-' | cut -c1-60)
  if [ "$wl_done" = yes ]; then rm -f "$wl_f"; echo "wait over: $wl_what"; return 0; fi
  mkdir -p "$root/.agents/local/wait" 2>/dev/null || true
  [ -s "$wl_f" ] || now_epoch > "$wl_f" 2>/dev/null || true
  wl_s=$(cat "$wl_f" 2>/dev/null); case "$wl_s" in ''|*[!0-9]*) wl_s=$(now_epoch) ;; esac
  wl_e=$(( $(now_epoch) - wl_s ))
  wl_t=$(budget_usage "$wl_id" | head -n 1)
  printf 'waiting: %s, %dm%02ds so far%s\n' "$wl_what" $((wl_e / 60)) $((wl_e % 60)) "$([ -z "$wl_t" ] || { set -- $wl_t; printf ' (TIME: %d%% of its %dm limit)' $(($2 * 100 / $3)) $(($3 / 60)); })"
}

# task_size_of ID: the task-author's size estimate (front matter `size:`) from the run's frozen TASK.md; empty when none
# (the status block and the metrics run record read the same source)
task_size_of() {
  awk '/^---[[:space:]]*$/ { fm = !fm; if (!fm && seen) exit; seen = 1; next } fm && /^size:/ { sub(/^size:[ \t]*/, ""); print; exit }' "$(run_dir "$1")/TASK.md" 2>/dev/null | tr -cd 'A-Za-z0-9 ._-' | cut -c1-16
}
# metrics_json KIND TASK ROLE FOCUS GATE RUNTIME MODEL DURATION TOKENS_IN TOKENS_OUT TOKENS_TOTAL TURNS RETRIES
#   DELEGATIONS FIX_ROUNDS RESULT [SIZE SCOPE_PATHS] -> .agents/local/metrics/records.jsonl (A80). One JSON object per line, written
#   by the control plane from its own state and the runtime's structured output; no model-written text is copied in.
#   Empty or "-" is null; a number field that is not digits is null; strings are cut to [A-Za-z0-9._+:-], so a
#   record can never carry free text (and so never a secret). `metrics: off` writes nothing.
metrics_json() {
  [ "$(cfg metrics on)" != off ] || return 0
  mj_f=$(shared_dir metrics)/records.jsonl
  mkdir -p "$(dirname "$mj_f")" 2>/dev/null || return 0
  mj_s() { mj_v=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._+:-'); case "$mj_v" in ''|-) printf null ;; *) printf '"%s"' "$mj_v" ;; esac; }
  mj_n() { case "$1" in ''|*[!0-9]*) printf null ;; *) printf '%s' "$1" ;; esac; }
  printf '{"schema":"proofline.metrics/1","kind":%s,"time":"%s","task":%s,"role":%s,"focus":%s,"gate":%s,"runtime":%s,"model":%s,"duration_s":%s,"tokens_in":%s,"tokens_out":%s,"tokens_total":%s,"turns":%s,"retries":%s,"delegations":%s,"fix_rounds":%s,"result":%s,"size":%s,"scope_paths":%s}\n' \
    "$(mj_s "$1")" "$(now_iso)" "$(mj_s "$2")" "$(mj_s "$3")" "$(mj_s "$4")" "$(mj_s "$5")" "$(mj_s "$6")" "$(mj_s "$7")" \
    "$(mj_n "$8")" "$(mj_n "$9")" "$(mj_n "${10}")" "$(mj_n "${11}")" "$(mj_n "${12}")" "$(mj_n "${13}")" "$(mj_n "${14}")" "$(mj_n "${15}")" "$(mj_s "${16}")" "$(mj_s "${17:-}")" "$(mj_n "${18:-}")" >> "$mj_f" 2>/dev/null || true
}
# metrics-dispatch (called by dispatch.sh, lead only): one record per specialist dispatch.
metrics_dispatch() { # ID ROLE FOCUS RUNTIME MODEL DURATION TIN TOUT TTOTAL TURNS RETRIES RESULT
  require_run "$1"
  metrics_json dispatch "$1" "$2" "$3" "$(gate_of "$2" "$3" "$1" 2>/dev/null || true)" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" - - "${12}"
}

# --- next (deterministic next step; an interrupted step restarts from its beginning) -------
# A124: a dispatch.sh step in flight leaves dispatch/<NNN>-<role>-<runtime>.running (pid=, role=). Prints "ROLE PID" of the
# first marker whose pid is alive (status 1 when none). A marker whose pid is dead (killed dispatch) is stale:
# `inflight_sweep` removes it and prints its name.
# A live pid is not enough (pids are reused): a marker older than dispatch.timeout_seconds + 60 s is stale, since one
# attempt cannot outlive its timeout and every attempt writes a new marker. Args: PID MARKER-FILE.
inflight_pid_alive() {
  case "$1" in ''|*[!0-9]*|0) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  ipa_t=$(tm_dispatch_seconds '')
  # A171: the marker names the timeout of its own attempt (a class may run longer than the global one)
  ipa_m=$(sed -n 's/^timeout=//p' "$2" 2>/dev/null | head -n 1); case "$ipa_m" in ''|*[!0-9]*) ;; *) [ "$ipa_m" -le "$ipa_t" ] || ipa_t=$ipa_m ;; esac
  [ -z "$(find "$2" -mmin "+$(( (ipa_t + 119) / 60 ))" 2>/dev/null)" ]
}
inflight_sweep() { # ID
  for ifs_f in "$(run_dir "$1")"/dispatch/*.running; do
    [ -f "$ifs_f" ] || continue
    inflight_pid_alive "$(sed -n 's/^pid=//p' "$ifs_f" | head -n 1)" "$ifs_f" || { rm -f "$ifs_f"; printf '%s ' "${ifs_f##*/}"; }
  done
}
inflight_dispatch() { # ID
  ifd_d=$(run_dir "$1")/dispatch
  for ifd_f in "$ifd_d"/*.running; do
    [ -f "$ifd_f" ] || continue
    ifd_p=$(sed -n 's/^pid=//p' "$ifd_f" | head -n 1); ifd_r=$(sed -n 's/^role=//p' "$ifd_f" | head -n 1)
    if inflight_pid_alive "$ifd_p" "$ifd_f"; then printf '%s %s\n' "${ifd_r:-specialist}" "$ifd_p"; return 0; fi
  done
  return 1
}

# budget_usage ID: for every dispatched step of the run in flight that has used timeouts.warn_percent (default 80) of its time, one line
# `ROLE ELAPSED-S TIMEOUT-S` (A202 item 29). The time-out is last resort: the lead is told once per call, in `next` and `wait-line`,
# non-blocking; the marker holds the attempt's own start and limit (dispatch.sh), so a run without them says nothing.
budget_usage() {
  bu_pct=$(tm_warn_percent); bu_now=$(now_epoch)
  for bu_f in "$(run_dir "$1")"/dispatch/*.running; do
    [ -f "$bu_f" ] || continue
    inflight_pid_alive "$(sed -n 's/^pid=//p' "$bu_f" | head -n 1)" "$bu_f" || continue
    bu_t=$(sed -n 's/^timeout=//p' "$bu_f" | head -n 1); bu_s=$(sed -n 's/^started_epoch=//p' "$bu_f" | head -n 1)
    case "$bu_t$bu_s" in ''|*[!0-9]*) continue ;; esac
    [ -n "$bu_t" ] && [ -n "$bu_s" ] && [ "$bu_t" -gt 0 ] || continue
    bu_e=$((bu_now - bu_s))
    [ $((bu_e * 100)) -ge $((bu_t * bu_pct)) ] || continue
    printf '%s %s %s\n' "$(sed -n 's/^role=//p' "$bu_f" | head -n 1)" "$bu_e" "$bu_t"
  done
}
budget_note() { # ID: the one line for `next`
  budget_usage "$1" | while read -r bn_r bn_e bn_t; do
    printf 'note=TIME: dispatch %s has used %dm of its %dm limit (%d%%); at the limit it fails (never a pass) and the next dispatch of the step resumes from dispatch/RESUME-*.md. Do not stop it; tell the user in one line that this step is slow (proofline doctor --scale proposes a longer limit)\n' "${bn_r:-specialist}" $((bn_e / 60)) $((bn_t / 60)) $((bn_e * 100 / bn_t))
  done
}

next_step() {
  ns_id=$1; require_run "$ns_id"; ns_d=$(run_dir "$ns_id")
  # A203: `digest` has primed the risk signals and the gate list already (nothing changed since); `next` primes them here
  # (sv_load: RUN.yaml is parsed once here, so the subshells that read a value inherit the parsed copy instead of parsing it again)
  sv_load "$ns_d"
  [ "${dg_primed:-}" = "$ns_id" ] || { risk_prime "$ns_id"; case "$command" in next|digest) gate_names_prime "$ns_id" ;; esac; }
  ns_st=$(run_state "$ns_d"); ns_hs=$(section_value "$ns_d" handoff state)
  printf 'task=%s\nstate=%s\nhandoff=%s\n' "$ns_id" "$ns_st" "$ns_hs"
  o() { printf 'next=%s\n' "$*"; }
  r() { printf 'reason=%s\n' "$*"; }
  case "$ns_st" in FAILED|BLOCKED) o "report the evidence, then: agent.sh cleanup $ns_id"; r "run is terminal ($ns_st)"; return 0 ;; esac
  if [ "$(section_value "$ns_d" execution awaiting_input)" = true ]; then o "agent.sh questions $ns_id"; o "relay verbatim and ask the user to answer in their next message (the prompt hook records it when it matches an accepted form; a typed agent.sh answer $ns_id <N> is recorded as yours)"; r "a question is pending (a specialist's NEEDS_INPUT or the lead's ask)"; return 0; fi
  ns_stale=$(inflight_sweep "$ns_id")
  if ns_if=$(inflight_dispatch "$ns_id"); then
    o "wait: dispatch.sh $ns_id ${ns_if% *} in flight (pid ${ns_if#* }; others may be too, see dispatch/*.running); do not start other work on this step and do not read its log or result until the command returns; never end your turn while it runs: wait for the pid in a bounded wait loop and repeat it (DISPATCH.md, A227)"; r "a dispatch is running (A124)"; budget_note "$ns_id"; return 0
  fi
  [ -z "$ns_stale" ] || printf 'note=stale dispatch marker removed: %s\n' "${ns_stale% }"
  ns_class=$(pipeline_class "$ns_id")
  pipeline_class_valid "$ns_class" || { o "agent.sh classify $ns_id <TRIVIAL|STANDARD|COMPLEX|CRITICAL> [review]"; r "run is not classified (TRIVIAL is text and configuration only; a plan that changes code or adds tests is STANDARD or higher)"; return 0; }
  if section_key_present "$ns_d" repository task_branch; then
    case "$(section_value "$ns_d" repository task_branch)" in ''|PENDING) o "agent.sh branch $ns_id"; r "task branch not established"; return 0 ;; esac
  fi
  [ "$(baseline_status "$ns_d")" = captured ] || { o "agent.sh baseline $ns_id"; r "baseline not captured"; return 0; }
  if ! freeze_hash_present "$ns_d"; then
    if [ "$(pipeline_needs "$ns_id" evidence)" = yes ] && [ ! -f "$ns_d/EVIDENCE.md" ]; then o "dispatch.sh $ns_id explorer (one per bounded assignment, at most $(pipeline_value "$ns_class" max_explorers)); then consolidate EVIDENCE.md"; r "EVIDENCE.md missing"; return 0; fi
    # A200: the plan step is the time to fix empty verification commands: the plan's Verification commands and the build record need them
    if [ -z "$(cfg_cmds commands.build)$(cfg_cmds commands.test)" ]; then printf 'note=commands.build and commands.test are empty: run proofline doctor --commands (it finds them, proves each by one run and asks the user once; the PLAN Verification commands and the build record need them; this run does not wait for it)\n'; fi
    [ -f "$ns_d/PLAN.md" ] || { o "write PLAN.md (plan-contract)"; r "PLAN.md missing"; return 0; }
    if [ "$(pipeline_needs "$ns_id" architect)" = yes ] && ! plan_section_present "$ns_d/PLAN.md" Architecture; then o "dispatch.sh $ns_id architect (PLAN.md ## Architecture)"; r "the $ns_class pipeline needs an Architecture section"; return 0; fi
    # A78: a risk signal of the planned scope (or the diff so far) without its PLAN.md flag: the design role declares it.
    ns_mf=$(risk_missing_flags "$ns_id" | head -1)
    if [ -n "$ns_mf" ]; then
      ns_mn=${ns_mf%%|*}; ns_mfl=${ns_mf##*|}; ns_mp=${ns_mf#*|*|}; ns_mp=${ns_mp%|*}
      o "dispatch.sh $ns_id $(cfg "risk.$ns_mn.design_role" architect) (declare $ns_mfl in PLAN.md for risk signal $ns_mn: $ns_mp; see agent.sh pipeline $ns_id)"
      r "risk signal $ns_mn without its plan flag $ns_mfl (A78): after IMPLEMENT it is a blocking finding"; return 0
    fi
    if [ "$(pipeline_needs "$ns_id" qa)" = yes ] && [ ! -f "$ns_d/QA_PLAN.md" ]; then o "dispatch.sh $ns_id qa (QA_PLAN.md)"; r "QA_PLAN.md missing"; return 0; fi
    ns_ph=$(hash_file "$ns_d/PLAN.md")
    ns_shape=$(plan_migration_shape "$ns_d/PLAN.md")
    if [ "$ns_shape" = missing ]; then o "fix PLAN.md ## Data: expand/contract steps (data-design), or single_step: yes with the user's approval"; r "destructive plan without expand/contract steps"; return 0; fi
    ns_ae=$(assumption_shape_errors "$ns_id" | tr '\n' ';')
    if [ -n "$ns_ae" ]; then o "fix the '## Assumptions' section of PLAN.md / EVIDENCE.md (none, or the register table): $ns_ae"; r "assumption register invalid"; return 0; fi
    if [ -n "$(assumption_blocked "$ns_id")" ]; then o "agent.sh verify-assumptions $ns_id; verify each unverified high-risk assumption (update the register), or: agent.sh freeze $ns_id (records one NEEDS_INPUT question per assumption; relay it, the user answers 'accept <id>' or gives the corrected fact)"; r "unverified high-risk assumption blocks the freeze"; return 0; fi
    ns_te=''; ! gates_enforced "$ns_id" || ns_te=$(task_defect_errors "$ns_id" | head -1)
    if [ -n "$ns_te" ]; then o "fix TASK.md ## Pre-existing defects (task-author): list each defect the request does not ask for as '- <path:symbol>: <what> -- decision: report'; 'decision: fix' only on the user's own words, then a scope approval"; r "A105: $ns_te"; return 0; fi
    for ns_k in plan scope; do
      if [ "$ns_k" = plan ] && [ "$(run_autonomy "$ns_id")" != supervised ]; then continue; fi
      if [ "$ns_k" = scope ] && [ -z "$(task_defect_fixes "$ns_d/TASK.md")" ]; then continue; fi
      if ! find_approval "$ns_id" "$ns_k" "$ns_ph" >/dev/null; then
        ns_rq=$(latest_request "$ns_id" "$ns_k" 2>/dev/null || true)
        if [ -n "$ns_rq" ] && [ "$(gate_field "$ns_rq" bound)" = "$ns_ph" ]; then approval_wait_o "$ns_rq" "$ns_k" "$ns_id"
        else o "agent.sh request-approval $ns_id $ns_k (relay verbatim)"; fi
        r "$ns_k approval required before freeze"; return 0
      fi
    done
    o "agent.sh freeze $ns_id"; r "artifacts ready"; return 0
  fi
  case "$ns_hs" in
    PLANNED)
      ns_ph=$(hash_file "$ns_d/PLAN.md"); ns_ask=''
      if [ "$(plan_destructive "$ns_d/PLAN.md")" = yes ]; then
        ns_kinds=destructive; [ "$(plan_migration_shape "$ns_d/PLAN.md")" != single_step ] || ns_kinds="destructive single_step"
        for ns_k in $ns_kinds; do
          find_approval "$ns_id" "$ns_k" "$ns_ph" >/dev/null && continue
          ns_rq=$(latest_request "$ns_id" "$ns_k" 2>/dev/null || true)
          if [ -n "$ns_rq" ] && [ "$(gate_field "$ns_rq" bound)" = "$ns_ph" ]; then approval_wait_o "$ns_rq" "$ns_k" "$ns_id"
          else o "agent.sh request-approval $ns_id $ns_k (relay verbatim)"; fi
          r "$ns_k approval required before IMPLEMENT"; ns_ask=1; break
        done
      fi
      [ -n "$ns_ask" ] || { o "agent.sh handoff $ns_id IMPLEMENTING"; r "plan frozen"; } ;;
    IMPLEMENTING)
      # A200: an implementer DONE recorded after the last IMPLEMENTING handoff means the work is delivered: the only step is the handoff
      # (two next= lines made a lead read "dispatch the implementer again" or "wait for it to settle" and stop)
      if awk '/event=handoff:IMPLEMENTING/ { d = 0 } /event=record:implementer:DONE/ { d = 1 } END { exit !d }' "$ns_d/LEDGER.log" 2>/dev/null; then
        o "agent.sh handoff $ns_id IMPLEMENTED"; r "the implementer's DONE result is recorded: record IMPLEMENTED now, do not wait and do not dispatch it again"
      else o "dispatch.sh $ns_id implementer"; o "agent.sh handoff $ns_id IMPLEMENTED"; fix_paths_lines "$ns_id"; r "implementation in progress"; fi ;;
    IMPLEMENTED)
      ns_fp=$(gate_fingerprint); ns_fail='' ns_todo=''
      for ns_g in $(required_gates "$ns_id"); do
        ns_s=$(gate_status "$ns_id" "$ns_g" reuse "$ns_fp")
        case "$ns_s" in pass|waived) ;; fail) ns_fail="$ns_fail $ns_g" ;; *) ns_todo="$ns_todo $ns_g:$ns_s" ;; esac
      done
      if [ -n "$ns_fail" ]; then
        ns_used=$(fix_rounds_used "$ns_id")
        # A78: script findings are not fixed by the implementer: a missing flag is a plan amendment, UNSUPPORTED the user's call.
        ns_scr=0 ns_oth=0 ns_pl=0 ns_ac=0 ns_cov=0 ns_vp=0
        for ns_g in $ns_fail; do
          for ns_fc in - $(risk_gate_focuses "$ns_id" "$ns_g"); do
            ns_lf=$(gate_latest_file "$ns_id" "$ns_g" "$ns_fc"); [ -n "$ns_lf" ] || continue
            # A92: count script findings (UNSUPPORTED, missing flag) against the rows an implementer can fix.
            ns_a=$(grep -c '^finding: [^|]*|blocking|' "$ns_lf" || true)
            ns_b=$(grep -Ec '^finding: [^|]*\|blocking\|[^|]*\|(UNSUPPORTED |risk signal )' "$ns_lf" || true)
            ns_scr=$((ns_scr + ns_b)); ns_oth=$((ns_oth + ns_a - ns_b))
            ns_pl=$((ns_pl + $(finding_plan_rows "$ns_id" "$ns_lf")))
            ns_cov=$((ns_cov + $(grep -Ec '^finding: [^|]*\|blocking\|.*(maps to no scope path|requires tdd_exemption)' "$ns_lf" || true)))
            ns_vp=$((ns_vp + $(finding_visual_rows "$ns_lf")))
            ns_ac=$((ns_ac + $(grep -Ec '^finding: [^|]*\|blocking\|[^|]*\|(AC proof cites|re-running `|the recorded output line)' "$ns_lf" || true)))
            case "$(gate_field "$ns_lf" result | tr '[:upper:]' '[:lower:]')" in fail) [ "$ns_a" -gt 0 ] || ns_oth=$((ns_oth + 1)) ;; esac
            # shellcheck disable=SC2013 # finding ids contain no whitespace
            for ns_fid in $(sed -n 's/^finding: \([^|]*\)|blocking|[^|]*|UNSUPPORTED .*/\1/p' "$ns_lf"); do
              finding_waived "$ns_id" "$ns_lf" "$ns_fid" || o "agent.sh request-approval $ns_id waive:$ns_fid (blocking UNSUPPORTED $ns_fc: an INCONCLUSIVE measurement or risk.unsupported: block, never a PASS; the user decides whether to accept the gap, listed in the completion report)"
            done
            # shellcheck disable=SC2013 # finding ids contain no whitespace
            for ns_fid in $(sed -n 's/^finding: \([^|]*\)|blocking|[^|]*|risk signal .*/\1/p' "$ns_lf"); do
              finding_waived "$ns_id" "$ns_lf" "$ns_fid" || o "amend PLAN.md to declare the flag of $ns_fid (dispatch the design role), then agent.sh refreeze $ns_id <amendment>; or the user waives $ns_fid"
            done
          done
        done
        if [ "$ns_scr" -gt 0 ] && [ "$ns_oth" -eq 0 ]; then o "the implementer cannot clear these: only UNSUPPORTED or missing-flag findings fail (waive them, or amend PLAN.md and refreeze)"; o "agent.sh terminate $ns_id BLOCKED (reason and evidence on stdin), if the user declines the waiver and the plan cannot be amended"
        elif [ "$ns_vp" -gt 0 ] && [ "$ns_oth" -le "$ns_vp" ]; then
          # A200: the visual evidence report is missing or does not cover a criterion. The plan is fine; no PLAN.md amendment, no implementer fix round.
          o "dispatch.sh $ns_id qa --focus visual   (measures and writes reviews/visual-proof/report.json; the verifier cites it only after it exists)"
          o "then re-dispatch the verifier: dispatch.sh $ns_id verifier. Do not amend PLAN.md ## Verification commands for this: the finding is about the visual evidence report, not about a command"
        elif [ "$ns_pl" -gt 0 ] && [ "$ns_oth" -le "$ns_pl" ]; then
          # A127: the plan or its verification commands answer these rows, not the implementer: no fix round, no control-artifact fix_path.
          o "amend PLAN.md ## Verification commands (lead owns it; write amendments/<NNN>.md and edit PLAN.md), then agent.sh refreeze $ns_id <AMENDMENT>; a scope approval is needed only if the amendment adds scope paths"
          [ "$ns_cov" -eq 0 ] || o "a row that says an AC maps to no scope path, or that command proof requires tdd_exemption, is fixed in PLAN.md front matter: add the AC to \`criteria:\` of the scope entries that implement it, and plan a command that proves it (not only a ## Verification commands line)"
          o "the new plan hash voids the worker evidence and every gate: dispatch.sh $ns_id implementer re-records RED and GREEN against it (a real failing test and a real change; a path with a tdd_exemption needs none), then agent.sh handoff $ns_id IMPLEMENTED, then every gate again, VERIFY included"
          o "a commands-only amendment on a non-exempt path has no honest RED: complete Verification commands before freeze; if the verifier only failed to cite a planned or configured command, re-dispatch it instead (dispatch.sh $ns_id verifier)"
        elif [ "$ns_used" -le "$(max_fix_rounds)" ]; then o "agent.sh handoff $ns_id IMPLEMENTING (fix round $ns_used; findings of:$ns_fail)"; o "dispatch.sh $ns_id implementer (with the findings)"; fix_paths_lines "$ns_id"
        else o "agent.sh terminate $ns_id FAILED (reason and evidence on stdin)"; fi
        [ "$ns_ac" -eq 0 ] || o "re-dispatch the verifier citing only a configured or planned command with a recorded exit status and one stable output line (A107 rows); a command missing from Verification commands needs the amendment route"
        for ns_g in $ns_fail; do
          for ns_fc in - $(risk_gate_focuses "$ns_id" "$ns_g"); do
            ns_lf=$(gate_latest_file "$ns_id" "$ns_g" "$ns_fc"); [ -n "$ns_lf" ] && [ "$(gate_field "$ns_lf" result)" = fail ] || continue
            gate_blocking_rows "$ns_lf" 3 | sed "s|^|finding=$ns_g |"   # A200: the real finding, whatever the remedy below
          done
        done
        r "failing gates:$ns_fail"
      elif [ -n "$ns_todo" ]; then
        # A171: the build record the reviewers and the verifier read comes first; it is a missing step, not a reviewer's lowered confidence
        case "$ns_todo" in *REVIEW_*|*VERIFY*) if ns_bu=$(build_record_unmakeable "$ns_id"); then printf 'missing_step=lead, before the review gates: %s. Do: %s\n' "$ns_bu" "$(build_record_step_text "$ns_id")"; fi ;; esac
        case "$ns_todo" in *REVIEW_*|*VERIFY*) ! build_record_missing "$ns_id" || o "agent.sh build-record $ns_id run   (the build record is missing for this tree: make it before the review gates; reviewers and the verifier read it)" ;; esac
        for ns_x in $ns_todo; do
          ns_g=${ns_x%%:*}
          ns_um=$(gate_deps_unmet "$ns_id" "$ns_g" "$ns_fp" | tr '\n' ' ')
          if [ -n "$ns_um" ]; then printf 'note=%s waits for %s (gate dependency, A171): not offered before it passes\n' "$ns_g" "${ns_um% }"; continue; fi
          case "$ns_g" in SECRETS) o "agent.sh secret-scan $ns_id" ;; *)
            for ns_fc in - $(risk_gate_focuses "$ns_id" "$ns_g"); do
              gate_satisfied "$(gate_focus_status "$ns_id" "$ns_g" "$ns_fc" reuse "$ns_fp")" && continue
              if [ "$ns_fc" = - ]; then case "$ns_g" in REVIEW_*) o "dispatch.sh $ns_id reviewer --focus $(gate_focus "$ns_g")" ;; *) o "dispatch.sh $ns_id $(gate_owner "$ns_g")" ;; esac
              else o "dispatch.sh $ns_id $(gate_owner "$ns_g") --focus $ns_fc"; fi
            done ;;
          esac
        done
        r "gates not passing:$ns_todo"
      else
        unsupported_next "$ns_id"; not_rerun_next "$ns_id"; friction_reminder "$ns_id"
        o "agent.sh handoff $ns_id CODE_DONE"; r "every required gate passes"; fi ;;
    CODE_DONE)
      batch_continue_note "$ns_id"
      # A184 (round 2): a gate of the effective tier that is not satisfied for the task-owned patch cannot be recorded any more (gates are
      # recorded in IMPLEMENTED only, and only `amend` leaves CODE_DONE): never send the lead to dispatch reviewers whose results are refused
      ns_miss=''; ns_tp=$(task_patch_fingerprint "$ns_id")
      for ns_g in $(required_gates "$ns_id" "$(tier_effective "$ns_id")"); do gate_satisfied "$(gate_status "$ns_id" "$ns_g" patch "$ns_tp")" || ns_miss="$ns_miss $ns_g"; done
      if [ -n "$ns_miss" ]; then
        o "agent.sh amend $ns_id (reopens the run only when every required gate passes) or a new task for the extra work; do NOT dispatch reviewers: a gate result cannot be recorded in CODE_DONE"
        r "the effective tier is $(tier_effective "$ns_id") at CODE_DONE and these gates do not pass for the task-owned patch:$ns_miss (what raised it: agent.sh report-facts $ns_id)"; return 0
      fi
      case "$(section_value "$ns_d" execution knowledge_state)" in
        KNOWLEDGE_DONE|not_applicable)
          [ "$(section_value "$ns_d" completion_report published)" = true ] || friction_reminder "$ns_id"
          if [ "$(section_value "$ns_d" completion_report published)" != true ]; then unsupported_next "$ns_id"; not_rerun_next "$ns_id"; o "write COMPLETION_REPORT.md (top: the summary block of the template in the user's language, no Look-at lines, publish copies QA_REPORT.md Human checks; no counts of tests, gates, fix rounds or refreezes in your text unless they equal 'agent.sh report-facts $ns_id'; publish appends that Facts block); agent.sh publish-completion-report $ns_id"; r "completion report not published"
          else o "agent.sh handoff $ns_id DONE"; r "report published"; fi ;;
        *) ns_kd=$(knowledge_drift "$ns_id" | head -n 5 | tr '\n' ';')
           [ -z "$ns_kd" ] || printf 'note=design-sync drift in knowledge-scope documents (information for the knowledge step, which must fix it before knowledge-done): %s\n' "${ns_kd%;}"
           o "agent.sh knowledge-done $ns_id [not_applicable \"<reason>\"]"; r "knowledge transaction not recorded" ;;
      esac ;;
    DONE)
      batch_continue_note "$ns_id"
      # A169: once the merge step ran (a pull request is open) CI decides: merge and clean up, or a CI-fix round; resume continues from here
      if [ -f "$(deliver_dir "$ns_id")/PR" ]; then
        ci_progress "$ns_id" | while IFS= read -r ns_cl; do o "$ns_cl"; done
        r "the pull request is open (the merge step ran); its CI decides the next step (A169)"; return 0
      fi
      if batch_member "$ns_id"; then o "agent.sh batch-next (the delivery of $ns_id is covered by the batch approval: agent.sh batch-cover $ns_id delivery)"; r "run DONE, in the approved batch"; return 0; fi
      o "agent.sh request-approval $ns_id commit (delivery needs the user's approval)"; o "agent.sh cleanup $ns_id (after delivery)"; o "optional: agent.sh friction show; send it as a GitHub issue only if the user wants it: agent.sh request-approval - report, then agent.sh friction send"; r "run DONE" ;;
  esac
}
next_without_run() {
  nr_id=$(active_run)
  if [ -n "$nr_id" ]; then next_step "$nr_id"; return; fi
  printf 'task=none\nnext=agent.sh start <ID> [--title "<title>"] [--task-file <path>]\nreason=obtain a canonical task from task-author or an adapter import, then start it\n'
}



# --- Completion report (task-system agnostic; adapters in .agents/task-integrations/) ------
# A98: `next` names every UNSUPPORTED focus before CODE_DONE and the report: unproven, never a PASS.
unsupported_next() { # ID
  un_all=$(risk_unsupported "$1"); [ -n "$un_all" ] || return 0
  printf '%s\n' "$un_all" | while IFS='|' read -r un_k un_v un_t un_e; do
    o "$(unsupported_label "$un_v") $un_k: ${un_t#UNSUPPORTED }${un_e:+ (evidence: $un_e)} -> list it in COMPLETION_REPORT.md '## Unsupported Checks' as '- $un_k: <reason>; not proven: <what>'"
  done
  o "surface these unsupported checks to the user in your reply: they were not proven, never passed"
}
# A130: the finding ids of a required gate (info rows included, UNSUPPORTED rows are A98's) over its current records.
gate_report_ids() { # ID GATE [FOCUS] -> ids, one per line (FOCUS '-' = the gate's own; none = every focus)
  gri_id=$1 gri_g=$2 gri_fl=${3:-}
  [ -n "$gri_fl" ] || gri_fl="- $(risk_gate_focuses "$gri_id" "$gri_g")"
  for gri_fc in $gri_fl; do
    gri_f=$(gate_latest_file "$gri_id" "$gri_g" "$gri_fc"); [ -n "$gri_f" ] || continue
    sed -n 's/^finding: \([^|]*\)|[a-z]*|[^|]*|\([^|]*\)|.*/\1|\2/p' "$gri_f" | grep -v '|UNSUPPORTED ' | cut -d'|' -f1
  done | sort -u
}
# A130: every gate that re-ran nothing is named in the report on its own line, "not reproduced (NOT_RERUN)";
# `next` before the report lists what the report must carry, so the lead writes it right the first time.
not_rerun_next() { # ID
  risk_not_rerun "$1" | while IFS= read -r nn_l; do o "NOT_RERUN ${nn_l%% *}: not reproduced proof -> list it in COMPLETION_REPORT.md on its own line: '- ${nn_l%% *}: not reproduced (NOT_RERUN)'"; done
  for nn_g in $(required_gates "$1"); do
    nn_i=$(gate_report_ids "$1" "$nn_g" | tr '\n' ' ' | sed 's/ $//')
    [ -z "$nn_i" ] || o "gate $nn_g findings to name in COMPLETION_REPORT.md (on a line that also names $nn_g, e.g. '- $nn_g: <id> <severity> <what>'): $nn_i"
  done
}
# A202: the summary block. The first lines of COMPLETION_REPORT.md, between these markers, are a short note to the user in the user's
# language: what changed, what to look at, one command to verify. It is not evidence: the evidence checks read the report without it,
# the language scan blanks it, and the `Look at:` lines are never typed by the model (publish copies them from QA_REPORT.md).
REPORT_SUMMARY_BEGIN='<!-- proofline:summary:begin -->'
REPORT_SUMMARY_END='<!-- proofline:summary:end -->'
report_blank_summary() { # FILE -> the file with the summary block's lines blanked (line numbers kept)
  awk -v b="$REPORT_SUMMARY_BEGIN" -v e="$REPORT_SUMMARY_END" '$0 == b && !done { skip = 1; print ""; next } skip { if ($0 == e) { skip = 0; done = 1 } print ""; next } { print }' "$1"
}
# human_checks ID: the items of QA_REPORT.md `## Human checks` (what a machine measures badly: text naturalness, visual impression), at most three
human_checks() {
  hc_f=$(run_dir "$1")/QA_REPORT.md; [ -f "$hc_f" ] || return 0
  awk '/^## Human checks[ \t]*$/ { i = 1; next } /^## / { i = 0 } i && /^[-*][ \t]+[^ \t]/ { sub(/^[-*][ \t]+/, ""); sub(/[ \t]+$/, ""); if (n < 3) print; n++ }' "$hc_f"
}
# --- Report facts (A143, C-22): counts and statuses come from records, never from the model's text ---------
# report_facts ID: the Facts block, generated from the gate records, the ledger, the task-owned paths and the
# worker-evidence records. `publish-completion-report` appends it verbatim and refuses numbers in the lead's text
# that contradict it. No record carries the number of individual test cases, so none is stated.
evidence_run_counts() { # ID -> "<records> <passed>": the worker-evidence records (RED, GREEN, REFACTOR, FIX) and those with result pass
  ec_n=0; ec_p=0
  for ec_f in "$(run_dir "$1")"/worker-evidence/RED-*.yaml "$(run_dir "$1")"/worker-evidence/GREEN-*.yaml "$(run_dir "$1")"/worker-evidence/REFACTOR-*.yaml "$(run_dir "$1")"/worker-evidence/FIX-*.yaml; do
    [ -f "$ec_f" ] || continue
    ec_n=$((ec_n + 1)); ! grep -q '^result: "pass"' "$ec_f" || ec_p=$((ec_p + 1))
  done
  echo "$ec_n $ec_p"
}
# friction_count ID KIND (A200): the friction-note events of one kind recorded in the run's ledger
friction_count() { grep -c "event=friction-note .*detail=$2\$" "$(ledger_file "$1")" 2>/dev/null || true; }
# friction_reminder ID (A200): one line for next: a proofline limit worked around by a hand step is a proofline_bug note, said now
friction_reminder() {
  printf 'note=FRICTION (A200): if you got past a proofline limit in this run with a workaround (a script error, a refusal that was wrong for a legitimate step, a gate or hook you had to route around, a hand edit), record it now: agent.sh friction-note %s proofline_bug (proofline_bug notes so far: %s). The completion report lists the count; a workaround without a note is lost to the friction report.\n' "$1" "$(friction_count "$1" proofline_bug)"
}
report_facts() {
  rf_id=$1; require_run "$rf_id"; risk_prime "$rf_id"
  rf_fp=$(gate_fingerprint); rf_gl=$(required_gates "$rf_id")
  rf_wt=$(evidence_run_counts "$rf_id"); rf_wp=${rf_wt#* }; rf_wt=${rf_wt%% *}; rf_wp=${rf_wp%% *}
  printf '%s\n## Facts\n\nGenerated from the run records by %s when the report is published; never edited by hand. Numbers in the text above must match it.\n\n' "$REPORT_FACTS_BEGIN" "\`agent.sh report-facts $rf_id\`"
  printf -- '- Class: %s\n- Required gates: %s\n' "$(pipeline_class "$rf_id")" "$(printf '%s\n' "$rf_gl" | grep -c .)"
  for rf_g in $rf_gl; do
    rf_i=$(gate_report_ids "$rf_id" "$rf_g" - | tr '\n' ' ' | sed 's/ $//')
    printf -- '- Gate %s: %s; findings: %s\n' "$rf_g" "$(gate_label "$rf_id" "$rf_g" reuse "$rf_fp")" "${rf_i:-none}"
    # each risk sub-focus on a line of its own: its status and findings are never folded into the gate's
    for rf_fc in $(risk_gate_focuses "$rf_id" "$rf_g"); do
      rf_i=$(gate_report_ids "$rf_id" "$rf_g" "$rf_fc" | tr '\n' ' ' | sed 's/ $//')
      printf -- '  - Focus %s:%s: %s; findings: %s\n' "$rf_g" "$rf_fc" "$(gate_focus_status "$rf_id" "$rf_g" "$rf_fc" reuse "$rf_fp")" "${rf_i:-none}"
    done
  done
  rf_ks=$(section_value "$(run_dir "$rf_id")" execution knowledge_state); rf_kr=$(section_value "$(run_dir "$rf_id")" execution knowledge_reason)
  printf -- '- Friction notes recorded (A200): proofline_bug %s, user-command %s, user-shell %s\n' "$(friction_count "$rf_id" proofline_bug)" "$(friction_count "$rf_id" user-command)" "$(friction_count "$rf_id" user-shell)"
  printf -- '- Knowledge step: %s%s\n' "${rf_ks:-not_started}" "${rf_kr:+; not_applicable reason: $rf_kr}"
  printf -- '- Fix rounds: %s of %s\n- Refreezes: %s\n- Files changed (task-owned paths): %s\n' "$(fix_rounds_done "$rf_id")" "$(max_fix_rounds)" \
    "$(grep -c 'event=refreeze ' "$(ledger_file "$rf_id")" 2>/dev/null || true)" "$(task_owned_paths "$rf_id" 2>/dev/null | grep -c . || true)"
  printf -- '- Worker-evidence run records: total %s, ended pass %s, ended fail %s (a RED record ends fail on purpose; this is not a count of failing tests)\n' "$rf_wt" "$rf_wp" "$((rf_wt - rf_wp))"
  printf -- '- Test cases: no record carries the number of individual tests, so no such number is stated here.\n%s\n' "$REPORT_FACTS_END"
}
REPORT_FACTS_BEGIN='<!-- proofline:facts:begin -->'
REPORT_FACTS_END='<!-- proofline:facts:end -->'
# report_execution ID (A203): the `## Execution` section of the completion report, generated from the decision records (decisions/NNN-*.decision),
# one row per dispatch decision in order. The lead's own table was copied by hand and drifted from the records (a failover, an escalation or a
# model left out); publish replaces whatever the lead wrote under that heading with this text. Nothing is printed when no decision exists.
report_execution() {
  rx_id=$1; require_run "$rx_id"
  [ -n "$(decision_files "$rx_id")" ] || return 0
  printf '## Execution\n\nGenerated from the decision records by `agent.sh report-execution %s` when the report is published; never edited by hand.\n\n| role | focus | runtime | model | effort | signals | note |\n|---|---|---|---|---|---|---|\n' "$rx_id"
  (cd "$(run_dir "$rx_id")/decisions" && for rx_f in $(decision_files "$rx_id"); do cat "$rx_f"; printf '@@END@@\n'; done) | awk -F= '
    function c(s) { gsub(/\|/, "/", s); return s }
    function flush(   n) {
      if (role == "") return
      n = ""
      if (rr ~ /AUTOMATIC_FAILOVER/) n = n "failover (automatic) to " rt "; "
      else if (rr ~ /OPERATOR_OVERRIDE/) n = n "runtime set by the operator; "
      if (esc == "yes") n = n "escalated (" xr "); "
      if (via == "agent-path") n = n "agent path; "
      sub(/; $/, "", n)
      printf "| %s | %s | %s | %s | %s | %s | %s |\n", c(role), (focus == "" ? "-" : c(focus)), c(rt), c(model), c(effort), (sig == "" ? "none" : c(sig)), (n == "" ? "-" : c(n))
      role = focus = rt = model = effort = sig = rr = esc = xr = via = ""
    }
    $0 == "@@END@@" { flush(); next }
    { v = substr($0, length($1) + 2) }
    $1 == "role" { role = v } $1 == "focus" { focus = v } $1 == "runtime" { rt = v } $1 == "model" { model = v } $1 == "effort" { effort = v }
    $1 == "signals" { sig = v } $1 == "runtime_reason" { rr = v } $1 == "escalated" { esc = v } $1 == "escalation_reason" { xr = v } $1 == "via" { via = v }'
}
# --- Status block (A202): the one live status of a task, updated in place --------------------------------------------------
# The content is written by the control plane from RECORDED state only (RUN.yaml, the ledger, the questions, the delivery records, the
# metrics records, the batch state): no agent text is copied in except the three recorded reasons (a question, a park, a failure), and
# those go through sb_scrub (an allowlist: no path, address, key or token survives, one line, 160 characters). The adapter op
# `statusblock` places it (markdown: a marked section; GitHub, Jira, Linear: one comment found by its marker and edited). The update
# is best effort: it is bounded in time and never fails a run or a gate; an unreachable tracker is a logged note.
# sb_scrub: stdin -> one safe line. IPv4 and IPv6 addresses are replaced first; then a word with a slash, a backslash, a leading ~, a drive
# letter, an @, an = , a known key prefix (sk-, sk_live_, sk_test_, ghp_ ...), a word over 40 characters or 24+ letters-and-digits is replaced; a
# word naming a credential redacts the word after it; the characters that remain are letters, digits and . _ % + - ! ? & # only (the rest is
# dropped from each word, so no other symbol and no non-ASCII text survives); 160 characters at most.
sb_scrub() {
  tr -c '[:print:]' ' ' | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/REDACTEDX/g; s/([0-9A-Fa-f]{0,4}:){3,}[0-9A-Fa-f]{0,4}/REDACTEDX/g; s/[Ff][Ee]80::[0-9A-Fa-f:]*/REDACTEDX/g' | tr '<>`|()[]{}"'"'"',;:' ' ' | awk '{
    n = split($0, w, " "); out = ""; nx = 0
    for (i = 1; i <= n; i++) {
      t = w[i]
      if (nx) { nx = 0; t = "[redacted]" }
      else if (t ~ /REDACTEDX/ || length(t) > 40) t = "[redacted]"
      else if (t ~ /[\/\\]/ || t ~ /^~/ || t ~ /^[A-Za-z]:/) t = "[path]"
      else if (t ~ /@/ || t ~ /=/) t = "[redacted]"
      else if (t ~ /^(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-|sk_|pk_|rk_|AKIA|xox|AIza|eyJ)/ || t ~ /BEGIN/ || t ~ /_(live|test)_/) t = "[redacted]"
      else if (length(t) >= 24 && t ~ /[0-9]/ && t ~ /[A-Za-z]/) t = "[redacted]"
      else if (tolower(t) ~ /^(password|passwd|secret|token|apikey|api_key|bearer|authorization|credential|credentials)s?:?$/) { sub(/:$/, "", t); nx = 1 }
      if (t != "[redacted]" && t != "[path]") gsub(/[^A-Za-z0-9._%+!?&#-]/, "", t)
      if (t == "") continue
      out = out (out == "" ? "" : " ") t
    }
    print substr(out, 1, 160)
  }'
}
# sb_pr_link N: the pull request address, only for a github.com origin (credentials and every other form give "")
sb_pr_link() {
  sbl_u=$(git -C "$root" remote get-url origin 2>/dev/null) || return 0
  case "$sbl_u" in
    https://github.com/*/*) sbl_p=${sbl_u#https://github.com/} ;;
    git@github.com:*/*) sbl_p=${sbl_u#git@github.com:} ;;
    ssh://git@github.com/*/*) sbl_p=${sbl_u#ssh://git@github.com/} ;;
    *) return 0 ;;
  esac
  sbl_p=${sbl_p%.git}
  printf '%s' "$sbl_p" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || return 0
  printf 'https://github.com/%s/pull/%s\n' "$sbl_p" "$1"
}
# status_block_body ID EVENT [PR]: the block lines (`- key: value`), on stdout
status_block_body() {
  sbb_id=$1 sbb_ev=$2 sbb_pr=${3:-}; sbb_d=$(run_dir "$sbb_id"); sbb_has=no; [ -f "$sbb_d/RUN.yaml" ] && sbb_has=yes
  case "$sbb_ev" in run-start|ask|answer|parked|unparked|code-done|pr-opened|merged|failed) ;; *) sbb_ev=update ;; esac
  sbb_kv() { case " $SB_KEYS " in *" $1 "*) printf -- '- %s: %s\n' "$1" "$2" ;; *) echo "status block: key '$1' is not in SB_KEYS" >&2; return 1 ;; esac; }
  sbb_kv run "$sbb_id"
  sbb_type=''
  if [ "$sbb_has" = yes ]; then
    sbb_type=$(awk 'NR == 1 && $0 != "---" && /^# / { next } /^---[[:space:]]*$/ { fm = !fm; if (!fm && seen) exit; seen = 1; next } fm && /^type:/ { sub(/^type:[ \t]*/, ""); gsub(/["\047]/, ""); print tolower($0); exit } /^\*\*Type:\*\*/ { sub(/^\*\*Type:\*\*[ \t]*/, ""); print tolower($0); exit }' "$sbb_d/TASK.md" 2>/dev/null | tr -d ' \r')
    case "$sbb_type" in feature|bug|refactor|content|docs|chore) sbb_kv type "$sbb_type" ;; esac
    sbb_c=$(section_value "$sbb_d" pipeline classification); case "$sbb_c" in TRIVIAL|STANDARD|COMPLEX|CRITICAL) sbb_kv class "$sbb_c" ;; esac
  fi
  # stage, and the park / failure / question lines: a parked task never reads like a running one
  sbb_park=$(awk -F'\t' -v t="$sbb_id" '$1 == t && $2 == "parked" { print $3; exit }' "$(shared_dir batch)/state.tsv" 2>/dev/null || true)
  sbb_state=PLANNING sbb_hs=PLANNED sbb_wait=no
  if [ "$sbb_has" = yes ]; then
    sbb_state=$(run_state "$sbb_d"); sbb_hs=$(section_value "$sbb_d" handoff state)
    [ "$(section_value "$sbb_d" execution awaiting_input)" != true ] || sbb_wait=yes
  fi
  case "$sbb_ev:$sbb_state" in
    failed:*|*:FAILED|*:BLOCKED) sbb_stage="PARKED ($sbb_state)" ;;
    pr-opened:*) sbb_stage='PR OPEN (waiting for the merge)' ;;
    merged:*) sbb_stage=MERGED ;;
    *) if [ "$sbb_wait" = yes ]; then sbb_stage='PARKED (waiting for your answer)'
       elif [ -n "$sbb_park" ]; then sbb_stage='PARKED (by the lead)'
       elif [ "$sbb_has" = no ]; then sbb_stage='NOT STARTED'
       elif [ "$sbb_hs" = CODE_DONE ] || [ "$sbb_hs" = DONE ]; then sbb_stage="CODE_DONE (delivery next)"
       else sbb_stage="RUNNING ($sbb_state, handoff $sbb_hs)"; fi ;;
  esac
  sbb_kv stage "$sbb_stage"; sbb_kv event "$sbb_ev"; sbb_kv updated "$(now_iso)"
  if [ "$sbb_has" = yes ]; then
    sbb_b=$(section_value "$sbb_d" repository task_branch | tr -cd 'A-Za-z0-9._/-' | cut -c1-120); case "$sbb_b" in ''|PENDING) ;; *) sbb_kv branch "$sbb_b" ;; esac
    sbb_s=$(repository_base_sha "$sbb_d" | tr -cd '0-9a-f' | cut -c1-12); [ "${#sbb_s}" -ge 7 ] && sbb_kv start_commit "$sbb_s"
    sbb_kv runtime "$(cfg runtime.lead claude | tr -cd 'A-Za-z0-9._-' | cut -c1-32)"
    sbb_sess=$(printf '%s' "${CLAUDE_CODE_SESSION_ID:-${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}}" | tr -cd 'A-Za-z0-9_-' | cut -c1-64); [ -z "$sbb_sess" ] || sbb_kv session "$sbb_sess"
  fi
  if [ "$sbb_wait" = yes ]; then
    sbb_q=''; sbb_qn=''
    for sbb_f in "$sbb_d"/questions/[0-9][0-9][0-9].md; do
      [ -f "$sbb_f" ] && [ ! -e "${sbb_f%.md}.answer.md" ] || continue
      sbb_qn=${sbb_f##*/}; sbb_qn=${sbb_qn%.md}; sbb_q=$(grep -m1 -E '^[0-9]+\. [^[:space:]]' "$sbb_f" | sb_scrub)
    done
    sbb_kv question "${sbb_qn:+#$sbb_qn }${sbb_q:-pending}"
    sbb_kv answer "answer in your next message in the session; the prompt hook records it when it matches an accepted form"
  fi
  [ -z "$sbb_park" ] || sbb_kv park "$(printf '%s' "$sbb_park" | sb_scrub)"
  case "$sbb_state" in
    FAILED|BLOCKED) sbb_fr=$(grep -F ' event=terminate ' "$(ledger_file "$sbb_id")" 2>/dev/null | tail -n 1 | sed -n 's/.* detail=reason: \(.*\); evidence: .*/\1/p' | sb_scrub)
      sbb_kv failure "$sbb_state${sbb_fr:+: $sbb_fr}" ;;
  esac
  # after delivery: the pull request, its CI result and the merge commit
  sbb_dd=$(deliver_dir "$sbb_id"); [ -n "$sbb_pr" ] || sbb_pr=$(cat "$sbb_dd/PR" 2>/dev/null || true)
  case "$sbb_pr" in ''|*[!0-9]*) sbb_pr='' ;; esac
  case "$sbb_ev" in pr-opened|merged)
    if [ -n "$sbb_pr" ]; then sbb_lk=$(sb_pr_link "$sbb_pr" || true); sbb_kv pr "#$sbb_pr${sbb_lk:+ $sbb_lk}"; fi
    sbb_ci=$(sed -n 's/^ci: //p' "$sbb_dd/SUMMARY.md" 2>/dev/null | head -n 1 | sb_scrub); [ -z "$sbb_ci" ] || sbb_kv ci "$sbb_ci" ;;
  esac
  if [ "$sbb_ev" = merged ]; then   # the commit that was merged, read from git (no platform call: a squash merge makes its own commit, the platform shows it)
    sbb_mc=$(git -C "$root" rev-parse -q --verify HEAD 2>/dev/null | tr -cd '0-9a-f' | cut -c1-12) || sbb_mc=''
    [ "${#sbb_mc}" -lt 7 ] || sbb_kv delivered_commit "$sbb_mc"
  fi
  if [ "$sbb_has" = yes ]; then
    sbb_sz=$(task_size_of "$sbb_id")
    [ -z "$sbb_sz" ] || sbb_kv estimate "size $sbb_sz"
    sbb_t0=$(head -n 1 "$(ledger_file "$sbb_id")" 2>/dev/null | sed -n 's/.* epoch=\([0-9]*\) .*/\1/p')
    if [ -n "$sbb_t0" ]; then sbb_s=$(( $(now_epoch) - sbb_t0 )); [ "$sbb_s" -ge 0 ] && sbb_kv duration "$((sbb_s / 60)) min"; fi
    sbb_tk=$(awk -v t="\"task\":\"$sbb_id\"" 'index($0, t) && match($0, /"tokens_total":[0-9]+/) { v = substr($0, RSTART + 15, RLENGTH - 15) + 0; if (index($0, "\"kind\":\"step\"")) s += v; else if (index($0, "\"kind\":\"dispatch\"")) d += v }
      END { if (s > 0) print s; else if (d > 0) print d }' "$(shared_dir metrics)/records.jsonl" 2>/dev/null || true)
    [ -z "$sbb_tk" ] || sbb_kv tokens "$sbb_tk"
    # A202: what the user should look at is QA_REPORT.md's own list, copied here (scrubbed like every status line), never retyped
    human_checks "$sbb_id" | while IFS= read -r sbb_hc; do [ -z "$sbb_hc" ] || sbb_kv look_at "$(printf '%s' "$sbb_hc" | sb_scrub)"; done
  fi
  return 0
}
# status_block_run ID EVENT [PR]: build the block and hand it to the configured adapter
status_block_run() {
  sbr_id=$1; valid_task_id "$sbr_id" || { echo "invalid task id" >&2; return 1; }
  sbr_adapter=$(cfg tasks.adapter markdown)
  sbr_f=$(mktemp "${TMPDIR:-/tmp}/agent-status-block.XXXXXX") || return 1
  status_block_body "$sbr_id" "$2" "${3:-}" > "$sbr_f" || { rm -f "$sbr_f"; return 1; }
  sbr_rc=0; node "$sr_main/.agents/scripts/proofline-core.mjs" cli task-adapter "$sbr_adapter" statusblock "$sbr_id" "$sbr_f" >/dev/null || sbr_rc=$?   # A216: a project script or the built-in adapter
  rm -f "$sbr_f"; return "$sbr_rc"
}
# status_block_update ID EVENT [PR]: the lifecycle hook. Best effort in every way: a subshell (the run never sees a failure), bounded
# in time (an unreachable tracker cannot hold a run or a gate; tasks.status_block_seconds, default 20), a note in
# .agents/local/status-block.log. `tasks.status_block: off` switches it off.
status_block_update() {
  [ "$(cfg tasks.status_block on)" != off ] || return 0
  sbu_log=$(shared_dir status-block.log); sbu_err=$(mktemp "${TMPDIR:-/tmp}/agent-status-err.XXXXXX") || return 0
  sbu_max=$(cfg tasks.status_block_seconds 20); case "$sbu_max" in ''|*[!0-9]*) sbu_max=20 ;; esac; [ "$sbu_max" -ge 1 ] || sbu_max=1; [ "$sbu_max" -le 300 ] || sbu_max=300; sbu_max=$(tm_scaled "$sbu_max" 1 900)
  ( status_block_run "$@" ) >/dev/null 2>"$sbu_err" &
  sbu_pid=$!; sbu_n=0
  while kill -0 "$sbu_pid" 2>/dev/null; do
    sbu_n=$((sbu_n + 1))
    if [ "$sbu_n" -gt $((sbu_max * 5)) ]; then kill "$sbu_pid" 2>/dev/null || :; echo "timed out after ${sbu_max}s" > "$sbu_err"; wait "$sbu_pid" 2>/dev/null || :; sbu_pid=''; break; fi
    sleep 0.2
  done
  sbu_rc=0; [ -z "$sbu_pid" ] && sbu_rc=1 || wait "$sbu_pid" 2>/dev/null || sbu_rc=$?
  if [ "$sbu_rc" -ne 0 ]; then
    sbu_msg=$(head -n 3 "$sbu_err" | tr '\n' ' ' | sb_scrub)
    echo "note: the status block of $1 was not updated ($2): ${sbu_msg:-the adapter failed}; the run goes on" >&2
    mkdir -p "$(dirname "$sbu_log")" 2>/dev/null && printf '%s %s %s %s\n' "$(now_iso)" "$1" "$2" "${sbu_msg:-failed}" >> "$sbu_log" 2>/dev/null || :
  fi
  rm -f "$sbu_err"; return 0
}
# A171: design-sync drift in knowledge-scope documents that the verifier reported (design/SYNC.md) and that the current
# tree still shows. Printed as `<doc>:<line> -> <claim>`; empty when nothing is left, when the run has no SYNC.md (design-sync
# did not run for it) or when node / the design-sync script is not installed (nothing can be proven then: no block).
knowledge_drift() { # ID
  kdr_s=$(run_dir "$1")/design/SYNC.md; kdr_x=$root/.agents/skills/design-sync/scripts/design-sync.mjs
  [ -f "$kdr_s" ] && [ -f "$kdr_x" ] && command -v node >/dev/null 2>&1 || return 0
  kdr_j=$(mktemp "${TMPDIR:-/tmp}/agent-kdrift.XXXXXX")
  # run from the root with a relative script path: node compares the real path of the script with its own URL, so a
  # symlinked root (macOS /var) would make the script print nothing
  ( cd "$root" && node .agents/skills/design-sync/scripts/design-sync.mjs --root . ) > "$kdr_j" 2>/dev/null || :
  kdr_l=$(node -e '
    const fs = require("fs");
    let j; try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    const sync = fs.readFileSync(process.argv[2], "utf8");
    const m = /^## Drift\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(sync); const drift = m ? m[1] : "";
    for (const c of j.claims || []) if (c.status === "unmatched" && drift.includes(c.doc) && drift.includes(c.claim)) console.log(c.doc + ":" + c.line + " -> " + c.kind + " " + c.claim);
  ' "$kdr_j" "$kdr_s" 2>/dev/null || true)
  rm -f "$kdr_j"
  printf '%s\n' "$kdr_l" | while IFS= read -r kdr_r; do
    [ -n "$kdr_r" ] || continue
    in_knowledge_scope "${kdr_r%%:*}" && printf '%s\n' "$kdr_r"
  done
  return 0
}

# archive_run ID RUNDIR (A200): before cleanup or worktree-remove deletes a run's records, a compressed copy goes to
# <main tree>/.agents/local/archive/<ID>/<ID>-<UTC time>.tar.gz (git-ignored local state; the main tree's folder, so it outlives a worktree).
# The newest archive.keep runs are kept (default 10; 0 = no archive), older archive folders are removed. A copy that cannot be made and
# read back refuses the deletion: the records are the evidence. Removes nothing of the run itself.
archive_run() {
  ar_id=$1 ar_dir=$2; ar_keep=$(cfg archive.keep 10)
  case "$ar_keep" in ''|*[!0-9]*) ar_keep=10 ;; esac
  [ "$ar_keep" -gt 0 ] || return 0
  [ -d "$ar_dir" ] || return 0
  ar_root=$(shared_dir archive)
  for ar_p in "$(dirname "$ar_root")" "$ar_root" "$ar_root/$ar_id"; do
    [ ! -L "$ar_p" ] || fail "refusing to archive under $ar_p: it is a symlink; the run is kept"
  done
  mkdir -p "$ar_root/$ar_id" || fail "could not create $ar_root/$ar_id; the run is kept"
  ar_f=$ar_root/$ar_id/$ar_id-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
  (umask 077; tar -czf "$ar_f" -C "$(dirname "$ar_dir")" "$(basename "$ar_dir")") 2>/dev/null && tar -tzf "$ar_f" >/dev/null 2>&1 || { rm -f "$ar_f"; fail "could not archive the records of $ar_id into $ar_root/$ar_id; the run is kept (set archive.keep: 0 to skip the archive)"; }
  # keep the newest archive.keep run folders (by last write), whichever task they belong to
  ar_n=0
  ls -1t "$ar_root" 2>/dev/null | while IFS= read -r ar_d; do
    ar_n=$((ar_n + 1)); [ "$ar_n" -gt "$ar_keep" ] || continue
    case "$ar_d" in *[!A-Za-z0-9._-]*|''|.|..) continue ;; esac
    if [ -d "$ar_root/$ar_d" ] && [ ! -L "$ar_root/$ar_d" ]; then rm -rf "${ar_root:?}/$ar_d"; fi
  done
  echo "evidence archived: .agents/local/archive/$ar_id/${ar_f##*/} (the newest $ar_keep runs are kept)"
}



# --- One-command delivery: one summary, one reply, one approval per step -------------------------
# deliver-plan writes .agents/local/deliver/<ID>/SUMMARY.md (what every step will do) and one approval request per
# step (commit push pr [merge] cleanup), each bound to the content fingerprint and to the summary's sha256. The
# user's one reply "approve delivery" (prompt hook, approve-pending) approves every request; nothing else does.
# deliver-step checks the shown content still holds and its step's approval exists before each step, then prints
# the command the lead runs (agent.sh never commits, pushes or merges; the git hooks consume commit and push).
deliver_dir() { printf '%s/.agents/local/deliver/%s\n' "$root" "$1"; }
# deliver_platform: "PLATFORM CLI MERGE" of the origin remote (platform.sh), e.g. "gitlab glab cli" or "bitbucket none manual".
deliver_platform() { sh "$scripts/agent.sh" platform 2>/dev/null | awk -F': ' '$1 == "platform" { p = $2 } $1 == "cli" { c = $2 } $1 == "merge" { m = $2 } END { print (p ? p : "other"), (c ? c : "none"), (m ? m : "manual") }'; }
# deliver_watch_cmd PR: the command that shows the checks of the pull request until they finish (cli platforms)
deliver_watch_cmd() {
  case "$(deliver_platform | awk '{ print $2 }')" in
    glab) echo 'glab ci status --live' ;;
    az) printf 'az repos pr policy list --id %s -o table\n' "$1" ;;
    *) printf 'gh pr checks %s --watch --fail-fast\n' "$1" ;;
  esac
}
# --- CI red self-fix (A169) ------------------------------------------------------------------------------------------------------
# When the CI of the delivery's pull request is red after the merge step, that is a finding, not a question. `deliver-step ID ci-fix PR`
# reads the failed check through the platform adapter (platform.sh ci-failed: gh, glab, az; A186), opens one fix round through `amend` (inside the frozen scope, no refreeze), and the
# fix goes to the SAME pull request branch: ci-commit (after the gates passed again), ci-push, ci-merge. The user's delivery approval covers
# exactly these rounds: ci-commit records a commit and a push approval bound to the new content, to the delivery summary's hash and (push)
# to the branch ref, only after the pull request was opened and the merge step ran, only for an open attempt, at most ci_fix_max attempts.
# Every attempt is a record ci-fix/NNN.yaml bound in the ledger (ci-fix-open, -grant, -commit, -push, -stop), so the ledger shows which
# push belongs to which CI fix. The third red CI stops: one question to the user with the error and what was tried (a batch parks there).
ci_fix_max() { echo 2; }   # shortcut: a fixed limit of 2 attempts, make it a review.* key when a project needs another number
# ci_fix_recs ID: the attempt records bound in the ledger (an edited or hand-made file is ignored), oldest first
ci_fix_recs() {
  cfr_d=$(run_dir "$1"); [ -d "$cfr_d/ci-fix" ] || return 0
  cfr_n=$(ls -1 "$cfr_d/ci-fix" 2>/dev/null | grep -E '^[0-9]{3}\.yaml$' | sort || true); [ -n "$cfr_n" ] || return 0
  # shellcheck disable=SC2086 # file names without whitespace
  bound_names "$cfr_d" ci-fix 'ci-fix-' $cfr_n | sort | while IFS= read -r cfr_f; do printf '%s/ci-fix/%s\n' "$cfr_d" "$cfr_f"; done
}
# ci_chain_ok ID: HEAD is the delivery's own commit chain: the summary's HEAD, the one delivery commit on top of it, then the CI-fix
# commits the records name, each directly on the one before (nothing else in between)
ci_chain_ok() {
  cco_s=$(deliver_dir "$1")/SUMMARY.md; [ -f "$cco_s" ] || return 1
  cco_h0=$(sed -n 's/^head: //p' "$cco_s" | head -1); cco_msg=$(sed -n 's/^message: //p' "$cco_s" | head -1); cco_tip=$cco_h0
  case " $(sed -n 's/^steps: //p' "$cco_s" | head -1) " in *" commit "*)
    cco_c=$(git -C "$root" rev-list --reverse --ancestry-path "$cco_h0..HEAD" 2>/dev/null | head -1)
    [ -n "$cco_c" ] && [ "$(git -C "$root" rev-parse -q --verify "$cco_c^" 2>/dev/null || true)" = "$cco_h0" ] && [ "$(git -C "$root" log -1 --format=%s "$cco_c")" = "$cco_msg" ] || return 1
    cco_tip=$cco_c ;;
  esac
  for cco_f in $(ci_fix_recs "$1"); do
    cco_ch=$(gate_field "$cco_f" committed_head)
    case "$cco_ch" in ''|PENDING) continue ;; esac
    [ "$(git -C "$root" rev-parse -q --verify "$cco_ch^" 2>/dev/null || true)" = "$cco_tip" ] || return 1
    cco_tip=$cco_ch
  done
  [ "$(git -C "$root" rev-parse HEAD)" = "$cco_tip" ]
}
# delivered_mode ID (A169): a run whose HEAD is its own delivery commit chain has that commit under it, so its task paths are measured
# from base_sha, like cleanup of a delivered run does (verify_freshness then does not read the run's own commit as a changed base, and the
# gates, the handoff and the knowledge scope see the same diff as before the commit). Only while HEAD is exactly the chain ci_chain_ok
# describes: any other commit leaves the usual checks in force. Content is still bound by the patch fingerprints.
cdm_done=''
delivered_mode() {
  [ "$cdm_done" != "$1" ] || return 0
  cdm_done=$1; cdm_b=$(repository_base_sha "$(run_dir "$1")")
  case "$cdm_b" in ''|PENDING) return 0 ;; esac
  git -C "$root" merge-base --is-ancestor "$cdm_b" HEAD 2>/dev/null || return 0
  [ "$cdm_b" != "$(git -C "$root" rev-parse HEAD)" ] || return 0
  ci_chain_ok "$1" || return 0
  ctp_base=$cdm_b
}
# ci_progress ID: the commands that go on from here, one per line (next and resume print them; no gh needed)
ci_progress() {
  cpg_dd=$(deliver_dir "$1"); cpg_pr=$(cat "$cpg_dd/PR" 2>/dev/null || true); [ -n "$cpg_pr" ] || cpg_pr='<PR-NUMBER>'
  cpg_last=$(ci_fix_last "$1"); cpg_st=''; [ -z "$cpg_last" ] || cpg_st=$(gate_field "$cpg_last" state)
  cpg_a="agent.sh deliver-step $1"
  cpg_head=$(git -C "$root" rev-parse HEAD)
  case "$cpg_st" in
    open)
      if [ "$(run_state "$(run_dir "$1")")" = CODE_DONE ] && [ "$(section_value "$(run_dir "$1")" handoff state)" = DONE ]; then echo "$cpg_a ci-commit $cpg_pr"
      else echo "agent.sh next $1   (CI fix round $(gate_field "$cpg_last" attempt) of $(ci_fix_max): fix, gates, knowledge-done, report, handoff DONE; then $cpg_a ci-commit $cpg_pr)"; fi ;;
    granted)
      if [ "$cpg_head" = "$(gate_field "$cpg_last" failing_head)" ]; then echo "$cpg_a ci-commit $cpg_pr   (prints the commit lines again)"; else echo "$cpg_a ci-push $cpg_pr"; fi ;;
    committed)
      if [ "$(git -C "$root" rev-parse -q --verify "refs/remotes/origin/$(git -C "$root" branch --show-current)" 2>/dev/null || true)" = "$cpg_head" ]; then echo "$cpg_a ci-merge $cpg_pr"; else echo "$cpg_a ci-push $cpg_pr"; fi ;;
    *)
      echo "$(deliver_watch_cmd "$cpg_pr")"
      echo "if every check passed: proofline merge $cpg_pr, then $cpg_a cleanup $cpg_pr"
      echo "if a check is red: $cpg_a ci-fix $cpg_pr   (a CI-fix round, at most $(ci_fix_max); the command refuses when the CI is not red)" ;;
  esac
}
ci_fix_last() { ci_fix_recs "$1" | tail -n 1; }

# --- One worktree per run (A169) ---------------------------------------------------------------------------------
# A run lives in the worktree it was started in: `.agents/runs`, ACTIVE_RUN, the task file move and the open-run check
# (open_runs, the commit and push hooks) belong to that worktree. A task that waits for merge, is parked or is being fixed
# keeps its worktree and so blocks no other task and leaves the main working tree clean. Night mode makes one worktree per
# task; outside night mode `worktree-add` does the same for a second run. Folder: <main working tree>/.agents/local/worktrees/<ID>
# (git-ignored, inside the project so a sandboxed session may be given it, not scanned as a registered scratch worktree, A53).
# wt_linked: this tree is a linked worktree (its git-dir differs from the common git-dir, compared as physical paths).
wt_linked() {
  wl_g=$(cd "$root" 2>/dev/null && cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P) || return 1
  wl_c=$(cd "$root" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || return 1
  [ "$wl_g" != "$wl_c" ]
}
rw_main() { (cd "$root" && pwd -P); }   # the main working tree's folder (worktree-add runs only there)
rw_dir() { printf '%s/.agents/local/worktrees/%s\n' "$(rw_main)" "$1"; }
rw_valid_id() { valid_task_id "$1" && case "$1" in [!A-Za-z0-9]*|*..*) return 1 ;; esac; }
rw_registered() { git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | grep -Fxq -- "$1"; }
# A185: the state that belongs to no single run (batch approvals metrics friction prompts) is NOT linked into a worktree: every reader asks
# shared_dir, which names the main tree's folder by path. A link would be a copy where symlinks are not allowed (Git Bash without
# developer mode), and a copy goes stale. Per-run state (runs, ACTIVE_RUN, deliver, assignments, locks, windows, records) lives in the
# worktree that owns the run; the runtime hook resolves the same folder (adapters/claude/hooks/proofline-hook.sh, state root).
rw_shared='batch approvals metrics friction prompts'
rw_prepare() { # WORKTREE: the shared folders exist, the runtime config git does not track, dependency folders and local env files
  rp_w=$1; rp_m=$(rw_main); mkdir -p "$rp_w/.agents/local"
  for rp_s in $rw_shared; do mkdir -p "$rp_m/.agents/local/$rp_s"; done
  # runtime hooks and settings that are ignored or untracked are not in a checkout; without them the session would run unconfined
  for rp_f in .claude/settings.json .claude/settings.local.json .codex/hooks.json .codex/config.toml; do
    if [ -f "$rp_m/$rp_f" ] && [ ! -e "$rp_w/$rp_f" ]; then mkdir -p "$rp_w/$(dirname "$rp_f")"; cp "$rp_m/$rp_f" "$rp_w/$rp_f"; fi
  done
  # A200: commands.build|test|lint written into the main tree (doctor --apply-commands, after the user's yes) are an uncommitted change a worktree made from
  # the committed branch does not have; carried over only when the commands block is the ONLY difference between the two configs
  rp_mc=$rp_m/.agents/config.yaml; rp_wc=$rp_w/.agents/config.yaml
  if [ -f "$rp_mc" ] && [ -f "$rp_wc" ] && ! cmp -s "$rp_mc" "$rp_wc"; then
    rp_a=$(awk '/^commands:/ { k = 1; next } k && /^[^ #]/ { k = 0 } !k' "$rp_mc" | sha256); rp_b=$(awk '/^commands:/ { k = 1; next } k && /^[^ #]/ { k = 0 } !k' "$rp_wc" | sha256)
    [ "$rp_a" != "$rp_b" ] || cp "$rp_mc" "$rp_wc"
  fi
  # dependency folders (data: worktree_deps in ecosystems.json) become the worktree's own copies, never links into the main tree, and
  # the untracked local files of worktree.copy_files (default .env*) are copied in; both by worktree-prep.sh (A185)
  if [ -f "$scripts/worktree-prep.sh" ]; then
    sh "$scripts/worktree-prep.sh" "$rp_m" "$rp_w" "$(cfg worktree.copy_files '.env*')" >&2 || echo "warning: worktree preparation reported a problem (the worktree is usable; dependencies or env files may be missing)" >&2
  fi
}
# worktree_add ID: a detached worktree at the canonical branch's local tip, prepared; prints its folder. An existing one is reused.
worktree_add() {
  rw_valid_id "${1:-}" || fail "usage: agent.sh worktree-add <TASK-ID>"
  ! wt_linked || fail "worktree-add runs in the main working tree ($(git -C "$root" worktree list --porcelain | sed -n '1s/^worktree //p')), not inside a task worktree"
  wa_d=$(rw_dir "$1")
  if rw_registered "$wa_d" && [ -d "$wa_d" ]; then rw_prepare "$wa_d"; printf '%s\n' "$wa_d"; return 0; fi
  [ ! -e "$wa_d" ] || fail "$wa_d exists but is not a registered worktree; remove that folder, then run worktree-add again"
  wa_b=$(cfg canonical_branch); [ -n "$wa_b" ] || fail "canonical_branch not configured"
  wa_s=$(git -C "$root" rev-parse -q --verify "refs/heads/$wa_b") || fail "canonical branch not found locally: $wa_b"
  mkdir -p "$(dirname "$wa_d")"
  git -C "$root" worktree add -q --detach "$wa_d" "$wa_s" >/dev/null || fail "could not add the worktree $wa_d"
  rw_prepare "$wa_d"
  printf '%s\n' "$wa_d"
}
worktree_path() { # ID: the folder of a registered run worktree (exit 1 when there is none)
  rw_valid_id "${1:-}" || fail "usage: agent.sh worktree-path <TASK-ID>"
  wp_d=$(rw_dir "$1"); rw_registered "$wp_d" && [ -d "$wp_d" ] || return 1
  printf '%s\n' "$wp_d"
}
# worktree_root PATH (A184): the root of the run worktree that contains PATH, the ONE definition every path classification asks (the runtime
# hook calls `agent.sh worktree-root`; paths that agent.sh gets from git are already relative to the git worktree that contains them).
# PATH is a physical absolute path. A folder counts only when it is exactly <main working tree>/.agents/local/worktrees/<ID>, is
# registered by `git worktree list` of this project, is a linked worktree of the same common git-dir, and PATH is inside it; a crafted
# folder, a link, an unregistered or pruned worktree, a nested one: no answer (exit 1) and the caller keeps the old, stricter judgement.
worktree_root() {
  wo_p=$1; case "$wo_p" in /*) ;; *) return 1 ;; esac
  case "/$wo_p/" in */../*|*/./*) return 1 ;; esac
  wo_m=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); [ -n "$wo_m" ] || return 1
  wo_m=$(cd "$wo_m" 2>/dev/null && pwd -P) || return 1
  wo_c=$(cd "$wo_m" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || return 1
  wo_b=$wo_m/.agents/local/worktrees
  case "$wo_p" in "$wo_b"/*) ;; *) return 1 ;; esac
  wo_id=${wo_p#"$wo_b"/}; wo_id=${wo_id%%/*}
  rw_valid_id "$wo_id" || return 1
  wo_d=$wo_b/$wo_id
  [ -d "$wo_d" ] && [ ! -L "$wo_d" ] && [ -f "$wo_d/.git" ] || return 1
  [ "$(cd "$wo_d" 2>/dev/null && pwd -P)" = "$wo_d" ] || return 1
  git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | grep -Fxq -- "$wo_d" || return 1
  wo_g=$(cd "$wo_d" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || return 1
  [ "$wo_g" = "$wo_c" ] || return 1
  case "$wo_p" in "$wo_d"|"$wo_d"/*) printf '%s\n' "$wo_d" ;; *) return 1 ;; esac
}
# worktree_remove ID [--force]: only a worktree under .agents/local/worktrees; refused while it still holds a run (its evidence), unless forced.
worktree_remove() {
  rw_valid_id "${1:-}" || fail "usage: agent.sh worktree-remove <TASK-ID> [--force]"
  ! wt_linked || fail "worktree-remove runs in the main working tree, not inside a task worktree"
  wr_force=no; case "${2:-}" in '') ;; --force) wr_force=yes ;; *) fail "usage: agent.sh worktree-remove <TASK-ID> [--force]" ;; esac
  wr_d=$(rw_dir "$1")
  if ! rw_registered "$wr_d"; then git -C "$root" worktree prune; echo "no worktree for $1"; return 0; fi
  wr_runs=''
  for wr_r in "$wr_d"/.agents/runs/*; do [ -d "$wr_r" ] && wr_runs="$wr_runs ${wr_r##*/}"; done
  [ -z "$wr_runs" ] || [ "$wr_force" = yes ] || fail "the worktree of $1 still holds the run:$wr_runs (its evidence goes with it). Finish or clean up the run first, or: agent.sh worktree-remove $1 --force"
  for wr_r in "$wr_d"/.agents/runs/*; do [ ! -d "$wr_r" ] || archive_run "${wr_r##*/}" "$wr_r"; done   # A200: the records are archived before the worktree goes
  git -C "$root" worktree remove --force "$wr_d" >/dev/null 2>&1 || fail "could not remove the worktree $wr_d"
  git -C "$root" worktree prune
  rmdir "$(dirname "$wr_d")" 2>/dev/null || :
  echo "worktree removed: $1"
}

task_title_of() { sed -n '1s/^# Task: *[^ ]* *[-—]* *//p' "$1" 2>/dev/null | head -1; } # TASK.md -> the H1 title

# --- Read-only summary --------------------------------------------------------------------
ua() { if [ -n "$1" ]; then printf '%s' "$1"; else printf unavailable; fi; }
# report_tokens ID (A44, TR-2): the tokens a final report to the user must carry verbatim, one per line, only
# while the run is at a reporting state (CODE_DONE, DONE, FAILED, BLOCKED): the state, the class and every
# required gate name, plus `commit` and `push` once the run is CODE_DONE or DONE (the delivery stop). Gate names,
# classes, states and result values are never translated, in any language.
report_tokens() {
  rt_id=$1; require_run "$rt_id"; rt_d=$(run_dir "$rt_id")
  case "$(run_state "$rt_d")" in CODE_DONE|DONE|FAILED|BLOCKED) ;; *) return 0 ;; esac
  gates_enforced "$rt_id" && pipeline_class_valid "$(pipeline_class "$rt_id")" || return 0
  run_state "$rt_d"; pipeline_class "$rt_id"
  required_gates "$rt_id" | tr ' ' '\n' | grep .
  # A finished run is delivered only by the user: the report says that commit and push each await approval.
  case "$(run_state "$rt_d")" in CODE_DONE|DONE) printf '%s\n' commit push ;; esac
  # The regression test evidence (RED then GREEN) is named in the report (STANDARD S-11).
  if ls "$rt_d"/worker-evidence/RED-*.yaml >/dev/null 2>&1 && ls "$rt_d"/worker-evidence/GREEN-*.yaml >/dev/null 2>&1; then printf '%s\n' RED GREEN; fi
}
summary_run() {
  sm_id=${1:-}; [ -n "$sm_id" ] || sm_id=$(active_run); [ -n "$sm_id" ] || fail "no active task: pass a TASK-ID"; require_run "$sm_id"; sm_d=$(run_dir "$sm_id")
  printf 'STATUS: %s (handoff %s, knowledge %s)\n' "$(ua "$(run_state "$sm_d")")" "$(ua "$(section_value "$sm_d" handoff state)")" "$(ua "$(section_value "$sm_d" execution knowledge_state)")"
  [ "${2:-}" != --status ] || return 0   # the next-user table needs the first line only; the gate labels below are the slow part
  printf 'TASK: %s %s\n' "$sm_id" "$(sed -n '1s/^#[[:space:]]*//p' "$sm_d/TASK.md" 2>/dev/null | tr -d '\000-\037\177')"
  printf 'CLASS/TOPOLOGY: %s / %s\n' "$(ua "$(pipeline_class "$sm_id" | grep -v PENDING || true)")" "$(ua "$(resolve_topology "$sm_d" 2>/dev/null || true)")"
  if pipeline_declared "$sm_id" && pipeline_class_valid "$(pipeline_class "$sm_id")"; then
    sm_fp=$(gate_fingerprint)
    printf 'TIER: %s\n' "$(tier_effective "$sm_id")"
    for sm_g in $(required_gates "$sm_id"); do printf '%s: %s\n' "$sm_g" "$(gate_label "$sm_id" "$sm_g" reuse "$sm_fp")"; done
    printf 'FIX ROUNDS: %s of %s\n' "$(fix_rounds_done "$sm_id")" "$(max_fix_rounds)"
  fi
  printf 'DELIVERY: completion report published %s\n' "$(ua "$(section_value "$sm_d" completion_report published)")"
}

# plan-section ID SECTION: one PLAN.md section (heading to the next `## `), or `scope` for the YAML front matter.
plan_section() {
  ps_id=$1 ps_n=$2; require_run "$ps_id"; ps_f=$(run_dir "$ps_id")/PLAN.md; [ -f "$ps_f" ] || fail "PLAN.md not found: $ps_id"
  if [ "$ps_n" = scope ]; then awk 'NR==1 && /^---[[:space:]]*$/ { i=1; next } i && /^---[[:space:]]*$/ { exit } i' "$ps_f"; return 0; fi
  plan_section_present "$ps_f" "$ps_n" || fail "no PLAN.md section '$ps_n' in $ps_id (sections: scope $(sed -n 's/^## \(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$ps_f" | tr '\n' ' '))"
  awk -v n="$ps_n" '$0 ~ "^## " n "[[:space:]]*$" { i=1; print; next } i && /^## / { exit } i' "$ps_f"
}

# digest ID: stage, gates, open questions and the next step from the records alone (A150); the lead reads this
# instead of large outputs, and a fresh process rebuilds it after a context reset.
digest_run() {
  dg_id=$1; require_run "$dg_id"; dg_d=$(run_dir "$dg_id"); dg_q=0
  # A203: the risk signals and the gate list are computed once for the whole digest (the summary and the next step read them; nothing is written)
  sv_load "$dg_d"; risk_prime "$dg_id"; gate_names_prime "$dg_id"; dg_primed=$dg_id
  for dg_f in "$dg_d"/questions/[0-9][0-9][0-9].md; do if [ -e "$dg_f" ] && [ ! -e "${dg_f%.md}.answer.md" ]; then dg_q=$((dg_q + 1)); fi; done
  summary_run "$dg_id"
  printf 'OPEN QUESTIONS: %s\n' "$dg_q"
  # A202: the scope by derived kind, computed here and not written in any document; a claimed kind the script does not share is named
  if [ -f "$dg_d/PLAN.md" ]; then
    dg_k=$(scope_kind_rows "$dg_d/PLAN.md" 2>/dev/null) || dg_k=''
    if [ -n "$dg_k" ]; then
      printf '%s\n' "$dg_k" | awk -F'\t' '{ n[$4]++; if ($2 != "-" && $2 != $3 && !($2 == "doc" && $3 == "content")) bad = bad " " $1 } END { printf "SCOPE: code=%d test=%d content=%d", n["code"], n["test"], n["content"]; if (bad != "") printf " (kind claimed wrongly, counted as code:%s)", bad; printf "\n" }'
    fi
  fi
  next_step "$dg_id" | sed -n 's/^next=/NEXT: /p;s/^reason=/WHY: /p'
}

run_suites() { # every sibling *-test.sh
  for rs_t in "$scripts"/*-test.sh; do [ -f "$rs_t" ] || continue; echo "== ${rs_t##*/}"; sh "$rs_t"; done
}

# --- CLI ---------------------------------------------------------------------------------------
valid_role "$execution_role" || fail "invalid execution role: ${AGENT_ROLE:-}"
command=${1:-}
# A202 item 28: read-only commands may use the big-file fingerprint cache (fp_cache_key); everything else hashes and refreshes it, so no
# integrity check (gate record, handoff, freeze, verify-*, delivery, approval, window) ever trusts a remembered hash.
case "$command" in next|digest|summary|status-block|next-user|status|friction|batch-status|batch-next|insights) fp_fast=yes ;; *) fp_fast=refresh ;; esac
# A169: a run that lives in its own worktree (night mode, worktree-add) is served by that worktree's agent.sh, so `answer`, `questions`,
# `next`, `reopen` and the rest work for it from the main working tree too (the working directory becomes the worktree; use absolute paths).
if [ -n "${2:-}" ] && valid_task_id "$2" && [ ! -e "$root/.agents/runs/$2" ] && [ -d "$root/.agents/local/worktrees/$2/.agents/runs/$2" ] && [ -f "$root/.agents/local/worktrees/$2/.agents/scripts/agent.sh" ]; then
  case "$command" in start|worktree-add|worktree-path|worktree-remove|batch-*) ;; *) cd "$root/.agents/local/worktrees/$2" && exec sh .agents/scripts/agent.sh "$@" ;; esac
fi
read_only_commands='report-execution tree-inspect timeouts hook-timeouts verify-timeout tm-scaled scale-check human-checks repro-normalize design-rationales platform platform-warn language-check next-user in-knowledge-scope worktree-root design-surface report-facts build-record lessons rules calibrate debt role status open-runs effective pipeline tier next questions fingerprint config-get config-check verify-freeze verify-scope verify-knowledge-scope verify-handoff verify-worker-evidence verify-gates verify-seal verify-completion-report freshness validate patch-fingerprint summary plan-section digest help verify-qa-plan report-tokens verify-assumptions entry-tier ci-check ci-task-command path-kind scope-kinds task-scope-entries scope-covers test-path batch-answers commands-check task-type known-issue-list known-issue-candidates'
cmd_allowed() { for ca_c in $read_only_commands "$@"; do [ "$ca_c" != "$command" ] || return 0; done; return 1; }
case "$execution_role" in
  lead) ;;
  reviewer|security_reviewer|qa|verifier) cmd_allowed record gate submit || fail "command denied for $execution_role: $command" ;;
  implementer) cmd_allowed record submit worker-evidence handoff || fail "command denied for $execution_role: $command" ;;
  *) cmd_allowed record submit || fail "command denied for $execution_role: $command" ;;
esac
lock_command=yes
case " $read_only_commands " in *" $command "*) lock_command=no ;; esac
[ "$command" != tier ] || [ "$execution_role" != lead ] || lock_command=yes
# submit builds its message unlocked and hands it to `record`, which takes the locks in its own process.
# approve-pending only enumerates requests; each `approve` it starts takes the locks in its own process.
if [ "$command" = approve-pending ] || [ "$command" = friction ] || [ "$command" = batch-status ] || [ "$command" = batch-check ] || [ "$command" = batch-next ] || [ "$command" = batch-awake ] || [ "$command" = batch-park ] || [ "$command" = db-config ] || [ "$command" = hook-config ]; then lock_command=no; fi   # friction.sh send calls approval-consume, which takes the locks itself; db-config and hook-config (A188) only read the config, which is parsed before any lock
if [ "$command" = submit ]; then lock_command=no; trap '[ -z "$record_tmp" ] || rm -rf "$record_tmp"' 0; fi
if [ "$lock_command" = yes ]; then
  mkdir -p "$agents/local"
  trap 'release_locks' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # A185, A196, A199: the locks live in .agents/local/locks/, a folder of their own, so that a Codex worker can be granted that folder alone and
  # .agents/local stays read-only to it (windows, approvals, prompts, batch). The shared lock is the main tree's locks/shared.lock; a worktree
  # also takes its own locks/tree.lock. Older versions took .agents/local/.lock for the same jobs: a process that can write there still takes it
  # (so it excludes an older process), one that cannot waits, read-only, for a live holder of it.
  mkdir -p "$agents/local/locks" 2>/dev/null || :
  take_old_lock "$agents/local/.lock"
  if [ "$sr_main" = "$root" ]; then
    [ ! -d "$agents/local/locks" ] || acquire_lock "$agents/local/locks/shared.lock" || exit 1
  else
    [ ! -d "$agents/local/locks" ] || acquire_lock "$agents/local/locks/tree.lock" || exit 1
    if [ -d "$sr_main/.agents/local" ]; then
      take_old_lock "$sr_main/.agents/local/.lock"
      acquire_lock "$sr_main/.agents/local/locks/shared.lock" || exit 1
    fi
  fi
  if [ "$command" != start ] && [ -n "${2:-}" ] && valid_task_id "$2" && [ -d "$(run_dir "$2")" ]; then
    acquire_lock "$(run_dir "$2")/.lock"
  fi
fi
usage() {
  cat >&2 <<'USAGE'
usage: agent.sh <command> [args]   (AGENT_ROLE selects the role; default lead)
  role | status | effective [ID] | fingerprint [ID] | config-get <dotted.key> | config-check [FILE]
  start <ID> [--title TITLE] [--task-file PATH]
  classify <ID> <TRIVIAL|STANDARD|COMPLEX|CRITICAL> [review] | pipeline <ID> | tier <ID> | next [ID] | summary [ID] | digest <ID> | plan-section <ID> <section>
  branch <ID> | baseline <ID> | freeze <ID> | refreeze <ID> <AMENDMENT-FILE>
  handoff <ID> <IMPLEMENTING|IMPLEMENTED|CODE_DONE|DONE> | worker-evidence <ID> <RED|GREEN|REFACTOR|FIX> <pass|fail>
  tree-inspect <ID> | tree-accept <ID>   (recovery: a change entered the working tree outside every worker window; tree-inspect shows it read-only, tree-accept (lead) asks for the user's approval of exactly that tree (kind tree), attests it, sends the handoff back to IMPLEMENTING and so makes every gate run again; the run is not discarded)
  window-open <ID> [ROLE] | window-close <ID> <BEFORE> [EXIT-STATUS] [ROLE]   (ROLE implementer|designer)
  status-block <ID> [EVENT [PR]]   (lead, A202: rebuild the task's one status block from the records and place it through the task adapter; best effort, never fails a run)
  worktree-add <ID> | worktree-path <ID> | worktree-remove <ID> [--force]   (A169, lead, main working tree: one worktree per run under .agents/local/worktrees/<ID>; night mode uses it for every task)
  open-runs | discard-stray <ID> <FILE-NAME|evidence/FILE-NAME>   (lead: remove one stray, non-artifact regular file of the run directory or of its evidence/ folder, A219)
  submit <ID> [--result R] --confidence C [--focus F] [--artifact P] [--findings FILE|-] [--report FILE|-] [--reason T] [--questions F] [--agent TOKEN]
  record <ID> [--file F] | gate <ID> <GATE> <pass|fail> [ARTIFACT] | secret-scan <ID>
  decide <ID> <ROLE> --dry|--agent-path [--focus F] [--runtime RT] [--model M] [--effort E] [--context-bytes N] | ledger-note <ID> <TEXT>
  hook-time <ID> (runtime hooks: move the hook timings spooled in .agents/local/hook-times into the ledger) | language-check [FILE|-] (the write-time language check; exit 1 on non-English text outside a '> ' quote block)
  friction-note <ID> <user-command|user-shell|proofline_bug> | wait-line <ID> [WHAT] [--done]   (A171: record that the user was asked to run a command, a proofline bug; the one-line wait status)
  metrics-dispatch <ID> <ROLE> <FOCUS> <RUNTIME> <MODEL> <DURATION_S> <TOKENS_IN> <TOKENS_OUT> <TOKENS_TOTAL> <TURNS> <RETRIES> <RESULT>   (dispatch.sh only; empty = null)
  request-approval <ID> <KIND> | approve <ID> <KIND>... | approval-consume <ID> <KIND> [FINGERPRINT]
  waive <ID> <FINDING-ID> --reason TEXT [--group] (--group: the one approval of FINDING-ID waives every open blocking finding of the same gate record with the same rule, e.g. 93 lines of one visual rule; a waiver follows the finding across gate re-runs) | ask <ID> [--file F] | questions <ID> | answer <ID> <N> [--captured|--amend] (answer on stdin; --captured takes the user's newest message since the question; --amend replaces a recorded answer with a newer user message, the old record is kept)
  terminate <ID> <FAILED|BLOCKED> | raise-budget <ID> <N> | amend <ID> | reopen <ID> | knowledge-done <ID> [not_applicable "<reason>"]
  publish-completion-report <ID> [ADAPTER] | verify-completion-report <ID> | delivery-check <ID> | cleanup <ID>
  batch-answer | batch-answers [ID]   (A200: record the user's answers to the batch pre-flight questions from their captured message; read them)
  path-kind <path>...   (A200: content or code, for the scope bound)
  human-checks <ID>   (A202: QA_REPORT.md's list of what the user should look at, as the summary and the status block copy it)
  scope-kinds <ID>   (A202: per scope path: claimed kind, derived kind, effective kind, exemption; a claim never lowers the derived one)
  task-scope-entries <task-file> <heading> | scope-covers <entry> <path>   (A202: read a task's scope sections; does an entry cover a path)
  task-type <TASK.md>   (A202: the task type; a task without one is a feature)
  known-issue-propose <RUN> <FINDING-ID> --followup <TASK> | known-issue-apply | known-issue-list | known-issue-candidates   (A202: the user-approved known-issues list; apply only after the user's 'approve known issue')
  task-rename-plan | task-rename-apply   (A202: <ID>-<slug>.md names for queued tasks; apply only after the user's 'approve rename')
  test-path <path>...   (A200: `test` or `product` per path: whether selective repetition may treat it as a test)
  batch-plan [--replace] <ID...|all> | batch-cover <ID> <plan|delivery|mutation_budget|rationale:PATTERN> | batch-next [--tsv] | batch-status | batch-check | batch-ci <ID> | batch-awake | batch-park <ID> <reason>|--clear   (A157: night mode in the same session; lead only for plan, cover, awake, park)
  deliver-plan <ID> [--message MSG] | deliver-step <ID> <commit|push|pr|merge|cleanup|ci-fix|ci-commit|ci-push|ci-merge> [PR]   (one summary, one "approve delivery", one approval per step; A169: a red CI opens a CI-fix round, at most 2, pushed to the same PR branch)
  task-source-status <ID> | task-source-relocate <ID> <NEW-PATH> | task-source-done <ID>
  platform   (A180: the hosting platform of the origin remote, the installed tool and who merges: platform, cli, merge, owner, web)
  ci-check | ci-task-command   (A163: is there a pull_request workflow; the task line that adds one)
  verify-freeze|verify-scope|verify-knowledge-scope|verify-handoff|verify-worker-evidence|verify-gates|verify-seal|freshness|validate|patch-fingerprint <ID>
  entry-tier <BULLET TEXT>   (read-only: mandatory, information or none for one PLAN.md ## Contracts bullet, A162)
  verify-assumptions <ID>   (read-only: the assumption register; lists every unverified or accepted-by-user assumption)
  rules list|report|tally   (A202: the Project rules budget and proposals to merge, ask about or remove rules; it never edits a rule; `tally` is lead only)
  lessons derive|write|validate|count|bound|text|promote   (lesson candidates from run evidence, repeat count, promotion to AGENTS.md only with a rule:<ID> approval; `write` and `promote` are lead-only)
  friction <report ID|show|issue-cmd|send>   (A149: anonymous run-end friction report; `send` files a GitHub issue only after the user's `report` approval)
  calibrate   (A149: config suggestions from metrics and plans; read-only, never edits a file)
  debt [list|page]   (A153: the project's `shortcut: <limit>, <when to improve>` code comments with file:line; read-only, needs no run; `page` is lead-only and rewrites the one wiki page)
  build-record <ID> [run|show]   (one build and test run per tree, recorded under .agents/local/builds/; `run` is lead-only, `show` is read-only and exits 3 without a record)
  next-user [<command> [<ID>]] [--error[=<kind>]] | next-user --commands   (read-only, any role: the user's next step after a /proofline command, from the one table in core/nextuser.mjs, A159)
  design-surface <REL-PATH>   (read-only: the design documents that apply to a file, key=value lines; design_docs.design as one path or as surfaces; exit 1 when two surfaces match)
  worktree-root <ABS-PATH>   (read-only, A184: print the root of the registered run worktree (.agents/local/worktrees/<ID>) that contains the physical path, exit 1 when there is none; path classification judges a path relative to that root)
  in-knowledge-scope <REL-PATH>   (read-only: exit 0 when the path is knowledge scope or a design_docs path, the paths the lead may write in the knowledge step, A159)
  repro-normalize   (read-only filter: stdin to stdout, the listed volatile fields of a recorded output line normalized, A200)
  design-rationales <ID> [--json] [PATH]   (read-only: the DESIGN.md pattern justifications and whether the user approved each; --json prints the object lint-source takes as --approved-rationales, A200)
  report-execution <ID>   (read-only: the `## Execution` table publish-completion-report writes into the report, from the decision records)
  report-facts <ID>   (read-only: the Facts block publish-completion-report appends; gates, findings, fix rounds, refreezes, files, test runs from the records)
  test
USAGE
}
case "$command" in
  role) printf 'role=%s\n' "$execution_role" ;;
  status) id=$(active_run); echo "active_task=${id:-none}"; effective "$id" ;;
  open-runs) open_runs ;;
  effective) effective "${2:-}" ;;
  fingerprint) [ -z "${2:-}" ] || require_run "$2"; if [ "${3:-}" = full ]; then content_fingerprint; else gate_fingerprint; fi ;;
  config-get) config_get "${2:?usage: agent.sh config-get <dotted.key>}" || fail "config key not found: $2" ;;
  config-check) config_check "${2:-}" ;;
  pipeline) pipeline_show "${2:?usage: agent.sh pipeline <ID>}" ;;
  next) if [ -n "${2:-}" ]; then next_step "$2"; else next_without_run; fi ;;
  summary) summary_run "${2:-}" "${3:-}" ;;
  plan-section) plan_section "${2:?usage: agent.sh plan-section <ID> <section>}" "${3:?usage: agent.sh plan-section <ID> <section>}" ;;
  digest) digest_run "${2:?usage: agent.sh digest <ID>}" ;;
  friction) case "${2:-}" in report|send) require_lead ;; esac; sh "$scripts/friction.sh" "${2:-}" "${3:-}" ;;
  calibrate) sh "$scripts/friction.sh" calibrate ;;
  debt) case "${2:-}" in page) require_lead ;; esac; sh "$scripts/debt.sh" "${2:-list}" ;;
  build-record) require_run "${2:?usage: agent.sh build-record <ID> [run|show]}"; sh "$scripts/build-record.sh" "${3:-show}" ;;
  lessons) case "${2:-}" in write|promote) require_lead ;; esac; shift; sh "$scripts/lessons.sh" "$@" ;;
  rules) case "${2:-}" in tally) require_lead ;; esac; shift; sh "$scripts/rules.sh" "$@" ;;   # A202: project rules budget; proposes, never edits
  design-surface) design_surface "${2:?usage: agent.sh design-surface <REL-PATH>}" ;;
  worktree-root) worktree_root "${2:?usage: agent.sh worktree-root <ABS-PATH>}" ;;
  in-knowledge-scope) in_knowledge_scope "${2:?usage: agent.sh in-knowledge-scope <REL-PATH>}" ;;
  report-facts) report_facts "${2:?usage: agent.sh report-facts <ID>}" ;;
  report-execution) report_execution "${2:?usage: agent.sh report-execution <ID>}" ;;
  repro-normalize) repro_normalize ;;
  design-rationales) [ "${2:-}" = - ] || require_run "${2:?usage: agent.sh design-rationales <ID|-> [--json] [DESIGN-MD-PATH]}"; design_rationales "$2" "${3:-}" "${4:-}" ;;
  report-tokens) report_tokens "${2:?usage: agent.sh report-tokens <ID>}" ;;
  decide) require_lead; dcid=${2:?usage: agent.sh decide <ID> <ROLE> --dry|--agent-path [--focus F] [--ui-mode M] [overrides]}; dcr=${3:?usage: agent.sh decide <ID> <ROLE> ...}; shift 3; decide "$dcid" "$dcr" "$@" ;;
  verify-freeze) verify_freeze "${2:?usage: agent.sh verify-freeze <ID>}" ;;
  verify-scope) verify_scope "${2:?usage: agent.sh verify-scope <ID>}" ;;
  verify-knowledge-scope) verify_knowledge_scope "${2:?usage: agent.sh verify-knowledge-scope <ID>}" ;;
  freshness) verify_freshness "${2:?usage: agent.sh freshness <ID>}" ;;
  verify-handoff) verify_handoff "${2:?usage: agent.sh verify-handoff <ID>}" ;;
  entry-tier) et_o=$(entry_tier "${2:?usage: agent.sh entry-tier <bullet text>}"); echo "${et_o:-none}" ;;
  verify-qa-plan) require_run "${2:?usage: agent.sh verify-qa-plan <ID>}"; verify_qa_plan_bound "$2"; echo "QA plan bound to PLAN.md: $2" ;;
  verify-worker-evidence) verify_worker_evidence "${2:?usage: agent.sh verify-worker-evidence <ID>}" ;;
  request-approval) request_approval "${2:?usage: agent.sh request-approval <ID> <KIND>}" "${3:?usage: agent.sh request-approval <ID> <KIND>}" ;;
  approve) [ $# -ge 3 ] || fail "usage: agent.sh approve <ID> <KIND>..."; ap_a=$2; shift 2; approve_kinds "$ap_a" "$@" ;;
  hook-time) hook_time "${2:-}" ;;
  language-check) language_check "${2:--}" "${3:-}" ;;
  approve-pending) require_lead; approve_pending "${2:-}" ;;
  approval-consume) [ $# -ge 3 ] || fail "usage: agent.sh approval-consume <ID> <KIND> [FINGERPRINT [REF...]]"; shift; approval_consume "$@" ;;
  questions) require_run "${2:?usage: agent.sh questions <ID>}"; questions_show "$2" ;;
  metrics-dispatch) require_lead; [ $# -ge 13 ] || fail "usage: agent.sh metrics-dispatch <ID> <ROLE> <FOCUS> <RUNTIME> <MODEL> <DURATION_S> <TOKENS_IN> <TOKENS_OUT> <TOKENS_TOTAL> <TURNS> <RETRIES> <RESULT> (empty = null)"; shift; metrics_dispatch "$@" ;;
  friction-note) friction_note "${2:?usage: agent.sh friction-note <ID> <user-command|user-shell|proofline_bug>}" "${3:-}" ;;
  wait-line) wait_line "${2:?usage: agent.sh wait-line <ID> [WHAT] [--done]}" "${3:-}" "${4:-}" ;;
  ledger-note) ledger_note "${2:?usage: agent.sh ledger-note <ID> <TEXT>}" "${3:?usage: agent.sh ledger-note <ID> <TEXT>}" ;;
  answer) answer "${2:?usage: agent.sh answer <ID> <N> [--captured|--amend]}" "${3:?usage: agent.sh answer <ID> <N> [--captured|--amend]}" "${4:-}" ;;
  worktree-add) require_lead; worktree_add "${2:-}" ;;
  worktree-path) require_lead; worktree_path "${2:-}" ;;
  worktree-remove) require_lead; worktree_remove "${2:-}" "${3:-}" ;;
  batch-plan) shift; batch_plan "$@" ;;
  batch-cover) batch_cover "${2:?usage: agent.sh batch-cover <ID> <plan|delivery|mutation_budget|rationale:PATTERN>}" "${3:?usage: agent.sh batch-cover <ID> <plan|delivery|mutation_budget|rationale:PATTERN>}" ;;
  batch-status) sh "$scripts/batch.sh" status ;;
  batch-check) batch_check ;;
  commands-check) commands_check ;;
  scale-check) scale_check ;;
  timeouts) timeouts_info ;;
  hook-timeouts) hook_timeouts ;;
  verify-timeout) verify_command_timeout ;;
  tm-scaled) tm_scaled "${2:?usage: agent.sh tm-scaled <seconds> [min] [max]}" "${3:-1}" "${4:-28800}" ;;
  batch-answer) require_lead; sh "$scripts/batch.sh" answer ;;
  batch-answers) sh "$scripts/batch.sh" answers "${2:-}" ;;
  test-path) shift; [ $# -gt 0 ] || fail "usage: agent.sh test-path <path>..."; for tp_p in "$@"; do if test_code_path "$tp_p"; then printf 'test\t%s\n' "$tp_p"; else printf 'product\t%s\n' "$tp_p"; fi; done ;;
  task-scope-entries) [ $# -eq 3 ] || fail "usage: agent.sh task-scope-entries <task-file> <heading>"; task_scope_entries "$2" "$3" ;;
  scope-covers) [ $# -eq 3 ] || fail "usage: agent.sh scope-covers <entry> <path>"; scope_entry_covers "$2" "$3" ;;
  task-rename-plan) task_rename_plan ;;
  task-rename-apply) task_rename_apply ;;
  task-type) [ $# -eq 2 ] || fail "usage: agent.sh task-type <TASK.md>"; task_type "$2" ;;
  human-checks) human_checks "${2:?usage: agent.sh human-checks <ID>}" ;;
  scope-kinds) scope_kind_rows "$(run_dir "${2:?usage: agent.sh scope-kinds <ID>}")/PLAN.md" ;;
  path-kind) shift; [ $# -gt 0 ] || fail "usage: agent.sh path-kind <path>..."; for pk_p in "$@"; do printf '%s\t%s\n' "$(path_kind "$pk_p")" "$pk_p"; done ;;
  batch-next) shift; PROOFLINE_BATCH_ROLE=$execution_role sh "$scripts/batch.sh" next "$@" ;;   # every role may read the digest; only the lead claims the batch owner

  batch-awake) require_lead; sh "$scripts/batch.sh" awake ;;
  batch-park) require_lead; sh "$scripts/batch.sh" park "${2:?usage: agent.sh batch-park <ID> <reason>|--clear}" "${3:?usage: agent.sh batch-park <ID> <reason>|--clear}" ;;
  patch-fingerprint) require_run "${2:?usage: agent.sh patch-fingerprint <ID>}"; task_patch_fingerprint "$2" ;;
  window-open) require_lead; window_open "${2:?usage: agent.sh window-open <ID> [implementer|designer]}" "${3:-}" ;;
  window-close) require_lead; window_close "${2:?usage: agent.sh window-close <ID> <BEFORE> [EXIT-STATUS] [implementer|designer]}" "${3:-}" "${4:-0}" "${5:-}" ;;
  verify-gates) verify_lifecycle_gates "${2:?usage: agent.sh verify-gates <ID>}"; echo "lifecycle gates verified: $2" ;;
  verify-seal) verify_seal "${2:?usage: agent.sh verify-seal <ID>}"; echo "lifecycle seal verified: $2" ;;
  validate) validate_run "${2:?usage: agent.sh validate <ID>}" ;;
  db-config) db_config "${2:-all}" ;;
  hook-config) hook_config ;;
  test) require_lead; run_suites ;;
  help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
