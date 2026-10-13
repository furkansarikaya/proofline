#!/bin/sh
# proofline control plane: the deterministic lifecycle of one task run.
# Installed as <project>/.agents/scripts/agent.sh; the project root is two directories above this file.
# Normative description: .agents/WORKFLOW.md, GATES.md, PROTOCOL.md, ENFORCEMENT.md.
# POSIX sh only: no `local`; helper variables carry a per-function prefix so callers' id/dir survive.
# shellcheck disable=SC2010,SC2015 # ls|grep over our own fixed-pattern file names; A && B || C on read-only pipelines
set -eu
LC_ALL=C; export LC_ALL

root=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
agents=$root/.agents
config=$agents/config.yaml
scripts=$agents/scripts
ctp_base=''   # set only by cleanup of a delivered run: task paths are then measured from base_sha, not HEAD

if command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 | awk '{print $1}'; }
else sha256() { sha256sum | awk '{print $1}'; }; fi
hash_file() { sha256 < "$1"; }
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
is_gate_role() { case "$1" in reviewer|security_reviewer|qa|verifier) return 0 ;; *) return 1 ;; esac; }
execution_role=$(canon_role "${AGENT_ROLE:-lead}")
require_lead() { [ "$execution_role" = lead ] || fail "command denied for $execution_role (lead only)"; }
require_full_lifecycle() { require_lead; }

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
acquire_lock() {
  al_path=$1
  case " $held_locks " in *" $al_path "*) return 0 ;; esac
  al_timeout=${PROOFLINE_LOCK_TIMEOUT:-120}
  case "$al_timeout" in ''|*[!0-9]*) fail "invalid PROOFLINE_LOCK_TIMEOUT: $al_timeout"; return 1 ;; esac
  [ -w "$(dirname "$al_path")" ] || { fail "cannot take the lock $al_path: its directory is not writable by this process (a sandbox must grant .agents/local and the run folder)"; return 1; }
  al_tries=$((al_timeout * 5)) al_n=0 al_broke=''
  while ! mkdir "$al_path" 2>/dev/null; do
    if [ -f "$al_path/pid" ]; then
      al_pid=$(cat "$al_path/pid" 2>/dev/null || :)
      case "$al_pid" in ''|*[!0-9]*) ;; *)
        if ! kill -0 "$al_pid" 2>/dev/null; then
          # Another waiter may win after removal; mkdir is still the arbiter.
          rm -f "$al_path/pid"
          rmdir "$al_path" 2>/dev/null || :
          al_broke=$al_pid
          continue
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
# Prints "dotted.key=value" for every key; comments and surrounding quotes are stripped.
config_lines() {
  awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    $0 !~ /:/ { next }
    {
      ind = match($0, /[^ ]/) - 1; lvl = int(ind / 2)
      body = substr($0, ind + 1); k = body; sub(/:.*/, "", k)
      v = body; sub(/^[^:]*:/, "", v); sub(/[[:space:]]+#.*$/, "", v); v = trim(v)
      if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2)
      path[lvl] = k; full = path[0]; for (i = 1; i <= lvl; i++) full = full "." path[i]
      print full "=" v
    }' "${1:-$config}"
}
# config_get <dotted.key> [file]: the value; exit 1 when the key is absent.
config_get() { config_lines "${2:-$config}" | awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); f = 1; exit } END { exit !f }'; }
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
config_value() { cfg "$1"; }

config_check() {
  cc_file=${1:-$config}; [ -f "$cc_file" ] || fail "config missing: $cc_file"
  cc_out=$(config_lines "$cc_file" | awk -F= '
    function bad(m) { print m; n++ }
    function en(k, v, set,   n, a, i) { if (v == "") return; n = split(set, a, "|"); for (i = 1; i <= n; i++) if (v == a[i]) return; bad("invalid value for " k ": " v " (want " set ")") }
    function num(k, v) { if (v != "" && v !~ /^[0-9]+$/) bad("invalid number for " k ": " v) }
    {
      k = $1; v = substr($0, length(k) + 2); split(k, p, "."); top = p[1]
      if (top !~ /^(proofline_version|canonical_branch|default_topology|profile|runtime|failover|autonomy|review|git|approval|commands|tasks|design_docs|local_state|metrics|test_trust|performance|budgets|capabilities|dispatch|default_mode|active_run_file|policy_source|knowledge_scope_root|safety|pipelines|execution_policy|database|risk|security|contract)$/) { bad("unknown top-level key: " top); next }
      if (top == "risk" && p[3] != "") {
        if (p[2] !~ /^[a-z_]+$/) bad("invalid risk signal name: " p[2])
        else if (p[3] == "check") en(k, v, "contract|concurrency|performance|config|migration|visual|dependencies")
        else if (p[3] == "flag") en(k, v, "contract_change|concurrency|performance_critical|data_change|destructive|ui")
        else if (p[3] == "design_role") en(k, v, "architect|data_architect|designer")
        else if (p[3] != "paths" && p[3] != "content") bad("unknown risk key: " k)
        if ((p[3] == "paths" || p[3] == "content") && v != "") sig[p[2]] = 1
        if (p[3] == "check" && v != "") chk[p[2]] = 1
      }
      if (top == "contract" && k != "contract" && k !~ /^contract\.(paths|ignore)$/) bad("unknown contract key: " k " (want contract.paths or contract.ignore)")
      if (k == "default_topology") en(k, v, "standalone|orchestrated")
      else if (k == "profile") en(k, v, "max|balanced|economy")
      else if (k ~ /^runtime\.(lead|worker|reviewers)$/ || k ~ /^runtime\.roles\./) en(k, v, "claude|codex")
      else if (k == "failover") en(k, v, "auto|ask|off")
      else if (k ~ /^autonomy\./) { if (p[2] !~ /^(TRIVIAL|STANDARD|COMPLEX|CRITICAL)$/) bad("unknown class under autonomy: " p[2]); en(k, v, "autonomous|supervised") }
      else if (k == "review.waiver_followup") en(k, v, "none|task")
      else if (k ~ /^review\.(max_fix_rounds|small_max_files|small_max_lines)$/ || k ~ /^(test_trust|budgets|performance)\./) num(k, v)
      else if (k == "git.commit_format") en(k, v, "conventional|plain")
      else if (k == "git.push_requires_approval") en(k, v, "true|false")
      else if (k == "tasks.adapter") en(k, v, "markdown|github|jira|linear")
      else if (k == "local_state" || k == "metrics") en(k, v, "on|off")
      else if (k ~ /^pipelines\.[A-Z]+\.(evidence|qa|architect)$/) en(k, v, "yes|no")
      else if (k ~ /^pipelines\.[A-Z]+\.review$/) en(k, v, "yes|no|optional")
      else if (k ~ /^pipelines\.[A-Z]+\.(max_explorers|max_scope_paths)$/) num(k, v)
      else if (k ~ /^capabilities\.[^.]+\.[^.]+$/) en(k, v, "1|2|3")
      else if (k == "execution_policy.max_context_bytes" || k == "execution_policy.revision") num(k, v)
      else if (k == "dispatch.timeout_seconds") { num(k, v); if (v ~ /^[0-9]+$/ && v + 0 < 30) bad("dispatch.timeout_seconds must be at least 30") }
      seen[k] = 1
    }
    END {
      if (!seen["canonical_branch"]) bad("missing key: canonical_branch")
      if (!seen["git.branch_prefix"]) bad("missing key: git.branch_prefix")
      for (s in sig) if (!chk[s]) bad("risk signal " s " has patterns but no check")
      exit n > 0
    }') && { echo "config valid: ${cc_file#"$root"/}"; return 0; }
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
require_run() { valid_task_id "$1" || fail "invalid task id"; [ -d "$(run_dir "$1")" ] || fail "run not found: $1"; }

start_run() { # ID [--title TITLE] [--task-file PATH]; otherwise read the task body on stdin
  require_lead
  sr_id=${1:-}; [ -n "$sr_id" ] || fail 'usage: agent.sh start <TASK-ID> [--title TITLE] [--task-file PATH]'
  shift
  valid_task_id "$sr_id" || fail "invalid task id: $sr_id"
  case "$sr_id" in [!A-Za-z0-9]*|*..*) fail "invalid task id: $sr_id" ;; esac
  sr_title='' sr_file=''
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || fail 'start option needs a value'
    case "$1" in --title) sr_title=$2 ;; --task-file) sr_file=$2 ;; *) fail "unknown start option: $1" ;; esac
    shift 2
  done
  sr_dir=$(run_dir "$sr_id")
  [ ! -e "$sr_dir" ] || fail "run already exists: $sr_id"
  sr_open=$(open_runs); [ -z "$sr_open" ] || fail "another open run exists in this worktree: $sr_open"
  sr_active=$(active_run); [ -z "$sr_active" ] || fail "another active run exists: $sr_active"
  sr_adapter=$(cfg tasks.adapter markdown)
  sr_tool=$agents/task-integrations/markdown.sh
  [ -f "$sr_tool" ] || fail 'markdown task adapter is missing'
  sr_tasks=$(cfg tasks.dir .agents/tasks)
  case "$sr_tasks" in /*|*..*) fail "tasks.dir must be project-relative: $sr_tasks" ;; esac
  sr_tmp=$(mktemp "${TMPDIR:-/tmp}/agent-start.XXXXXX")
  if [ -n "$sr_file" ]; then
    case "$sr_file" in "$root"/*) sr_rel=${sr_file#"$root"/} ;; *) sr_rel=${sr_file#./} ;; esac
    case "$sr_rel" in "$sr_tasks"/*) ;; *) rm -f "$sr_tmp"; fail "task file must be under tasks.dir ($sr_tasks): $sr_file" ;; esac
    case "$sr_rel" in *..*) rm -f "$sr_tmp"; fail "invalid task path: $sr_file" ;; esac
    [ -f "$root/$sr_rel" ] || { rm -f "$sr_tmp"; fail "task file missing: $sr_file"; }
    sr_name=${sr_rel##*/}; case "$sr_name" in "$sr_id".md|"$sr_id"-*.md) ;; *) rm -f "$sr_tmp"; fail "task file name must start with $sr_id: $sr_file" ;; esac
    sr_rc=0; sh "$sr_tool" import "$sr_rel" "$sr_tmp" || sr_rc=$?
    if [ "$sr_rc" -ne 0 ]; then rm -f "$sr_tmp"; return "$sr_rc"; fi
    [ "$(sed -n '1s/^# Task: \([^ ]*\) .*/\1/p' "$sr_tmp")" = "$sr_id" ] || { rm -f "$sr_tmp"; fail "task file ID does not match $sr_id"; }
    sr_path=$(sh "$sr_tool" status "$sr_id" in-progress "$sr_rel") || { rm -f "$sr_tmp"; fail 'could not move task to in-progress'; }
  else
    cat > "$sr_tmp"
    [ -n "$sr_title" ] || sr_title=$(sed -n '1s/^# Task: [^ ]* — //p' "$sr_tmp")
    [ -n "$sr_title" ] || { printf 'MISSING title\n'; rm -f "$sr_tmp"; return 3; }
    sr_rc=0; sr_path=$(sh "$sr_tool" create "$sr_id" "$sr_title" "$sr_tmp") || sr_rc=$?
    if [ "$sr_rc" -ne 0 ]; then printf '%s\n' "$sr_path"; rm -f "$sr_tmp"; return "$sr_rc"; fi
    sh "$sr_tool" import "$sr_path" "$sr_tmp" || { rm -f "$sr_tmp"; fail 'created task could not be imported'; }
  fi
  mkdir -p "$sr_dir" "$(dirname "$(active_run_file)")"
  awk -v id="$sr_id" -v path="$sr_path" -v adapter="$sr_adapter" '
    /^task:$/ { section="task" } /^task_source:$/ { section="task_source" } /^completion_report:$/ { section="completion_report" }
    /^[^[:space:]#]/ && $0 !~ /^(task|task_source|completion_report):$/ { section="" }
    section=="task" && /^  id:/ { print "  id: " id; next }
    section=="task_source" && /^  type:/ { print "  type: local_markdown"; next }
    section=="task_source" && /^  path:/ { print "  path: " path; next }
    section=="completion_report" && /^  adapter:/ { print "  adapter: " adapter; next }
    { print }
  ' "$agents/templates/RUN.yaml" > "$sr_dir/RUN.yaml"
  cp "$sr_tmp" "$sr_dir/TASK.md"; rm -f "$sr_tmp"
  printf '%s\n' "$sr_id" > "$(active_run_file)"
  ledger_append "$sr_id" start - PLANNED "task=$sr_path adapter=$sr_adapter"
  db_guard_baseline "$sr_id"
  echo "run started: $sr_id task=$sr_path"
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
  [ ! -L "$target" ] || fail "cannot baseline symlink: $path"
  if [ -f "$target" ]; then hash_file "$target"; return 0; fi
  [ ! -e "$target" ] && { printf '%s\n' missing; return 0; }
  fail "cannot baseline non-regular file: $path"
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
remove_pending_baseline() { awk '/^baseline:$/ { inside=1; next } inside && /^[^[:space:]]/ { inside=0 } !inside { print }' "$1" > "$2"; }
baseline() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  [ "$(run_state "$dir")" != CODE_DONE ] || fail "cannot record a baseline for CODE_DONE run: $id"
  status=$(baseline_status "$dir"); case "$status" in ''|pending) ;; *) fail "baseline already exists for $id; refusing to overwrite";; esac
  enforce_task_branch "$id"
  tmp=$dir/RUN.yaml.tmp; remove_pending_baseline "$dir/RUN.yaml" "$tmp"
  base_sha=$(git -C "$root" rev-parse HEAD)
  awk -v sha="$base_sha" '/^repository:$/ { i=1; print; next } i && /^[^[:space:]]/ { i=0 } i && /^  base_sha:/ { print "  base_sha: \"" sha "\""; f=1; next } { print } END { exit !f }' "$tmp" > "$tmp.base" || { rm -f "$tmp" "$tmp.base"; fail "RUN.yaml requires repository.base_sha"; }
  mv "$tmp.base" "$tmp"
  {
    printf '\nbaseline:\n  status: captured\n  tracked:\n'
    current_tracked_paths | while IFS= read -r path; do [ -n "$path" ] || continue; printf '    - path: %s\n      sha256: "%s"\n' "$path" "$(fingerprint_path "$path")"; done
    printf '  untracked:\n'
    current_untracked_paths | while IFS= read -r path; do [ -n "$path" ] || continue; printf '    - path: %s\n      sha256: "%s"\n' "$path" "$(fingerprint_path "$path")"; done
  } >> "$tmp"
  mv "$tmp" "$dir/RUN.yaml"; sv_reset; echo "baseline recorded: $id"
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
# excluding .agents/runs/ and .agents/local/. Built in a temporary index; never touches the real one.
content_fingerprint() {
  cf_tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-fp.XXXXXX")
  cf_idx=$(git -C "$root" rev-parse --git-path index)
  case "$cf_idx" in /*) ;; *) cf_idx=$root/$cf_idx ;; esac
  cf_objs=$(git -C "$root" rev-parse --git-path objects)
  case "$cf_objs" in /*) ;; *) cf_objs=$root/$cf_objs ;; esac
  # cf_try OBJECT-DIR: the tree id of the working tree in a private index; "" uses the repository's own object
  # database. A read-only .git (a Codex workspace-write sandbox) cannot take new objects, so the retry writes
  # them into a private directory and reads the repository's objects through an alternate: the tree id is
  # content-addressed, so it is the same value either way.
  cf_try() {
    [ ! -f "$cf_idx" ] || cp "$cf_idx" "$cf_tmp/index"
    (
      GIT_INDEX_FILE=$cf_tmp/index; export GIT_INDEX_FILE
      if [ -n "$1" ]; then GIT_OBJECT_DIRECTORY=$1; GIT_ALTERNATE_OBJECT_DIRECTORIES=$cf_objs; export GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; fi
      [ -f "$cf_tmp/index" ] || git -C "$root" read-tree HEAD >/dev/null 2>&1 || true
      git -C "$root" add -A -- . >/dev/null 2>&1 || exit 1
      git -C "$root" rm -r -q --cached --ignore-unmatch -- .agents/runs .agents/local "$(cfg tasks.dir .agents/tasks)" >/dev/null 2>&1
      git -C "$root" write-tree 2>/dev/null
    )
  }
  if cf_out=$(cf_try '') && [ -n "$cf_out" ]; then rm -rf "$cf_tmp"; printf '%s\n' "$cf_out"; return 0; fi
  mkdir -p "$cf_tmp/objects"
  if cf_out=$(cf_try "$cf_tmp/objects") && [ -n "$cf_out" ]; then rm -rf "$cf_tmp"; printf '%s\n' "$cf_out"; return 0; fi
  rm -rf "$cf_tmp"; fail "could not compute the content fingerprint"
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
# deferred (a separate, later migration: a destructive step in this change's own phases is one step). single_step = the plan says `single_step: yes`, which the
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
      if (dest == "yes") { if (ph == "deferred") late = 1; else early = 1 }
      else if (ph ~ /^(expand|backfill|switch)$/) pre = 1
    }
    END { if (single) print "single_step"; else if (pre && late && !early) print "expand_contract"; else print "missing" }' "$1")
  # A52: `single_step: yes` is only offered when the task states that the user wants one step.
  if [ "$pms" = single_step ] && ! grep -Eiq 'single[- ]step|one[- ]step|one migration|tek ad[ıi]m' "$(dirname "$1")/TASK.md" 2>/dev/null; then pms=missing; fi
  echo "$pms"
}
plan_section_present() { grep -q "^## $2[[:space:]]*\$" "$1"; }
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
      if (id in seen) err("Assumptions " id ": duplicate id")
      seen[id] = 1
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
# verify_assumptions ID [ask]: shape of both registers, then every unverified high-risk assumption must be
# answered `accept` by the user. With `ask` (freeze) each one without a question gets its NEEDS_INPUT question.
verify_assumptions() {
  va_id=$1; require_run "$va_id"; va_d=$(run_dir "$va_id")
  [ -f "$va_d/PLAN.md" ] || fail "missing PLAN.md"
  va_err=$(assumption_shape_errors "$va_id" | tr '\n' ';')
  [ -z "$va_err" ] || fail "invalid '## Assumptions': $va_err"
  va_all=$(assumption_states "$va_id")
  [ -z "$va_all" ] || printf '%s\n' "$va_all" | awk -F'\t' '$3 != "verified" { printf "%s risk=%s status=%s", $1, $2, $3; if ($4 != "-") printf " ref=%s", $4; printf "\n" }'
  va_blocked=$(printf '%s\n' "$va_all" | awk -F'\t' '$3 == "blocked"')
  if [ -z "$va_blocked" ]; then echo "assumptions verified: $va_id"; return 0; fi
  va_msg=''
  while IFS="$(printf '\t')" read -r va_a _ _ va_ref va_t; do
    va_ask=no
    case "$va_ref" in
      pending*) va_msg="$va_msg $va_a: its question ${va_ref#pending } is unanswered (relay it: 'agent.sh questions $va_id'; the user answers 'accept $va_a' or gives the corrected fact);" ;;
      declined*)
        if [ "${2:-}" = ask ]; then va_ask=yes; va_msg="$va_msg $va_a: the answer ${va_ref#declined } did not accept it (not the user's own accept, or a corrected fact: change the plan or verify the assumption);"
        else va_msg="$va_msg $va_a: the answer ${va_ref#declined } did not accept it (verify it or change the decisions it affects in the plan, then freeze again);"; fi ;;
      *)
        if [ "${2:-}" = ask ]; then va_ask=yes
        else va_msg="$va_msg $va_a: no question bound to it yet ('agent.sh freeze $va_id' records one);"; fi ;;
    esac
    if [ "$va_ask" = yes ]; then
      va_row=$(assumption_register "$va_id" | awk -F'\t' -v i="$va_a" '$1 == i')
      va_q=$(mktemp "${TMPDIR:-/tmp}/proofline-assumption.XXXXXX")
      printf '1. High-risk assumption %s is unverified: %s\n   source: %s; verification: %s; affects: %s\n   ASSUMPTION: %s\n   options: "accept %s" (the id is part of the phrase; proceed on this assumption, recorded as accepted-by-user with your answer) | the corrected fact (the plan is changed and the assumption checked again)\n   recommended: the corrected fact when it can be checked, otherwise accept\n   why: freeze refuses an unverified high-risk assumption; it is never accepted silently\n' \
        "$va_a" "$va_t" "$(printf '%s' "$va_row" | cut -f5)" "$(printf '%s' "$va_row" | cut -f6)" "$(printf '%s' "$va_row" | cut -f7)" "$(assumption_token "$va_a" "$va_t")" "$va_a" > "$va_q"
      ask_question "$va_id" "$va_q" >/dev/null; rm -f "$va_q"
      va_msg="$va_msg $va_a: question recorded (relay it: 'agent.sh questions $va_id');"
    fi
  done <<EOF
$va_blocked
EOF
  fail "unverified high-risk assumption(s) block the freeze; they are never accepted silently, the user answers each:$va_msg"
}

# --- Tier (D14): computed from the task-owned diff, recorded, never decreasing. ------
tier_rank() { case "$1" in docs) echo 0 ;; small) echo 1 ;; full) echo 2 ;; *) echo -1 ;; esac; }
tier_max() { if [ "$(tier_rank "$1")" -ge "$(tier_rank "$2")" ]; then echo "$1"; else echo "$2"; fi; }
# Paths the task changed against repository.base_sha (tracked, staged or not, plus untracked), minus the run
# directory, .agents/local/, the task files directory and baseline files whose content is unchanged.
task_changed_paths() {
  tcp_d=$(run_dir "$1"); tcp_base=$(repository_base_sha "$tcp_d"); case "$tcp_base" in ''|PENDING) tcp_base=HEAD ;; esac
  tcp_tasks=$(cfg tasks.dir .agents/tasks)
  { git -C "$root" diff --no-renames --name-only "$tcp_base" -- 2>/dev/null; current_untracked_paths; } | sort -u | while IFS= read -r tcp_p; do
    [ -n "$tcp_p" ] || continue
    case "$tcp_p" in .agents/runs/*|.agents/local/*|"$tcp_tasks"/*) continue ;; esac
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
  tc_rp=$(cfg review.risky_paths '')
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
# Records the effective tier when it rose (lead only; a no-op for other roles and for runs without the key).
tier_record() {
  tr_id=$1; tr_d=$(run_dir "$1"); tr_t=$(tier_effective "$tr_id")
  if [ "$execution_role" = lead ] && section_key_present "$tr_d" pipeline tier && [ "$(section_value "$tr_d" pipeline tier)" != "$tr_t" ]; then
    tr_prev=$(section_value "$tr_d" pipeline tier)
    set_run_value "$tr_id" pipeline tier "$tr_t"
    ledger_append "$tr_id" tier "$tr_prev" "$tr_t" "effective tier"
  fi
  printf '%s\n' "$tr_t"
}

# --- Risk signals (A78): deterministic signals select extra focuses inside the existing gates. -------------
# A signal comes from a changed path (diff), a PLAN.md scope path (scope; visible before FREEZE), the content
# added by the diff (diff, `content`), or a PLAN.md flag (plan). Config `risk.<name>.paths|content|flag|check|
# design_role` maps it to a focus (`check`) and the design role that declares it; the block is frozen
# (freeze.risk_sha256) and the lead never edits .agents/config.yaml during a run. A diff signal whose `flag` is
# not `yes` in PLAN.md is a blocking finding of its focus, added by `record` (the focus still runs).
risk_plan_flags='contract_change concurrency performance_critical'   # PLAN.md `## Risk`: `<flag>: yes|no`
risk_flags="$risk_plan_flags data_change destructive ui"            # data_change/destructive: `## Data`; ui: `## UI`
# The focus set is fixed here; config only chooses which focus a signal triggers. Its gate follows from it.
risk_focus_role() { case "$1" in contract|concurrency|performance|config|migration) echo reviewer ;; visual) echo qa ;; dependencies) echo security_reviewer ;; *) return 1 ;; esac; }
risk_focus_on_gate() { # FOCUS GATE
  case "$1:$2" in contract:REVIEW_RULES|concurrency:REVIEW_RULES|performance:REVIEW_RULES|config:REVIEW_RULES) return 0 ;;
    contract:REVIEW_SMALL|concurrency:REVIEW_SMALL|performance:REVIEW_SMALL|config:REVIEW_SMALL) return 0 ;;
    migration:REVIEW_DATA|visual:QA|dependencies:SECURITY) return 0 ;; *) return 1 ;; esac
}
risk_focus_report() { case "$1" in contract) echo reviews/contract-proof/ ;; concurrency) echo reviews/concurrency-proof/ ;; performance) echo reviews/performance-proof/ ;;
  config) echo reviews/proof-review/config/ ;; migration) echo reviews/data-migration/ ;; visual) echo reviews/visual-proof/ ;; dependencies) echo security/dependencies/ ;; esac; }
plan_flag() { # PLAN FLAG -> yes|no
  [ -f "$1" ] || { echo no; return 0; }
  case "$2" in
    data_change) if plan_section_present "$1" Data; then echo yes; else echo no; fi ;;
    ui) if plan_section_present "$1" UI; then echo yes; else echo no; fi ;;
    destructive) if [ "$(plan_destructive "$1")" = yes ]; then echo yes; else echo no; fi ;;
    *) awk -v f="$2" '/^## / { i = ($0 ~ /^## Risk[[:space:]]*$/); next } i { l = $0; sub(/^[-*][[:space:]]*/, "", l); if (l ~ ("^" f ":[[:space:]]*yes([[:space:]]|$)")) y = 1 } END { print (y ? "yes" : "no") }' "$1" ;;
  esac
}
plan_risk_invalid() { # PLAN -> the first `## Risk` line that is not `<flag>: yes|no [note]`
  awk '/^## / { i = ($0 ~ /^## Risk[[:space:]]*$/); next } i && /[^[:space:]]/ { l = $0; sub(/^[-*][[:space:]]*/, "", l); if (l !~ /^(contract_change|concurrency|performance_critical):[[:space:]]*(yes|no)([[:space:]].*)?$/) { print; exit } }' "$1"
}
# The block the freeze binds: the risk mapping, the performance thresholds (A87), every non-empty security.* key
# (A88: license policy, audit command) and every non-empty contract.* key (A83: contract.paths / contract.ignore
# globs), so a mid-run edit of any of them is refused. Empty security and contract keys are left out, so a config
# that does not set them hashes as before.
risk_config() { printf '%s' "$cfg_cache" | grep -E '^(risk\.|performance\.|security\..*=.|contract\..*=.)' || true; }
# Minimal duplicate of contract-proof's NOT_A_CONTRACT (skills stay standalone; keep in sync by hand, A92).
risk_not_contract='(^|/)(package(-lock)?\.json|composer\.json|(ts|js)config[^/]*\.json|openapitools\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|biome\.jsonc?|lerna\.json|nx\.json|turbo\.json|renovate\.json|deno\.jsonc?|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$|^\.github/(workflows|actions)/|^(\.vscode|\.idea|\.agents|\.devcontainer)/'
risk_names() { risk_config | awk -F= '$1 ~ /^risk\.[a-z_]+\.(paths|content)$/ && $2 != "" { split($1, p, "."); print p[2] }' | sort -u; }
# risk_compute ID -> "name|source|path|why" lines (source diff|scope|plan). Plain documentation (.md .mdx .rst
# .adoc) never carries a path or content signal: a guide named like a migration is not one.
risk_compute() {
  rc_d=$(run_dir "$1"); rc_base=$(repository_base_sha "$rc_d"); case "$rc_base" in ''|PENDING) rc_base=HEAD ;; esac
  rc_changed=$(task_changed_paths "$1" | grep -v -E '\.(md|mdx|rst|adoc)$|^\.agents/' || true)
  rc_scope=$(scope_mappings "$rc_d/PLAN.md" 2>/dev/null | cut -d'|' -f1 | grep -v -E '\.(md|mdx|rst|adoc)$' || true)
  for rc_n in $(risk_names); do
    rc_g=$(cfg "risk.$rc_n.paths")
    if [ -n "$rc_g" ]; then
      { [ -z "$rc_changed" ] || printf '%s\n' "$rc_changed" | sed 's/^/diff /'; [ -z "$rc_scope" ] || printf '%s\n' "$rc_scope" | sed 's/^/scope /'; } |
        awk -v n="$rc_n" -v pats="$rc_g" "$g2re_awk"'
          { src = $1; p = substr($0, length(src) + 2); c = split(pats, a, " ")
            for (j = 1; j <= c; j++) if (a[j] != "" && p ~ g2re(a[j])) { print n "|" src "|" p "|" a[j]; break } }'
    fi
    rc_c=$(cfg "risk.$rc_n.content")
    [ -n "$rc_c" ] && [ -n "$rc_changed" ] || continue
    printf '%s\n' "$rc_changed" | while IFS= read -r rc_p; do
      if [ -n "$rc_g" ] && path_matches "$rc_p" "$rc_g"; then continue; fi   # already a path signal
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
risk_prime() { rs_cache_id=''; rs_tier=$(tier_compute "$1"); rs_cache=$(risk_compute "$1"); rs_focuses=$(risk_focuses_of "$1"); rs_cache_id=$1; }
risk_signals() { if [ "${rs_cache_id:-}" = "$1" ]; then [ -z "$rs_cache" ] || printf '%s\n' "$rs_cache"; else risk_compute "$1"; fi; }
risk_focuses_of() { risk_signals "$1" | cut -d'|' -f1 | sort -u | while IFS= read -r rfo_n; do cfg "risk.$rfo_n.check"; done | sed '/^$/d' | sort -u; }
risk_gate_focuses() { # ID GATE -> the risk focuses the gate carries for this run
  if [ "${rs_cache_id:-}" = "$1" ]; then rgf_all=$rs_focuses; else rgf_all=$(risk_focuses_of "$1"); fi
  for rgf_f in $rgf_all; do if risk_focus_on_gate "$rgf_f" "$2"; then printf '%s\n' "$rgf_f"; fi; done
}
# risk_missing_flags ID [FOCUS] -> "name|source|path|flag" for each path signal (of FOCUS) whose flag is not yes.
risk_missing_flags() {
  rmf_plan=$(run_dir "$1")/PLAN.md
  risk_signals "$1" | while IFS='|' read -r rmf_n rmf_src rmf_p _; do
    [ "$rmf_src" != plan ] || continue
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
    printf 'signal.%s=source=%s check=%s:%s%s flag=%s design_role=%s\n' "$rsh_n" "$rsh_src" "${rsh_g:--}" "$rsh_f" \
      "$([ -n "$rsh_g" ] || printf ' (no required gate carries it for this class and tier)')" "${rsh_fl:--}" "$(cfg "risk.$rsh_n.design_role" -)"
  done
  risk_missing_flags "$1" | while IFS='|' read -r rsh_n rsh_src rsh_p rsh_fl; do
    printf 'missing_flag.%s=%s:%s needs PLAN.md %s: yes (%s)\n' "$rsh_n" "$rsh_src" "$rsh_p" "$rsh_fl" \
      "$([ "$rsh_src" = diff ] && echo "a blocking finding of focus $(cfg "risk.$rsh_n.check"); the check still runs" || echo "declare it before FREEZE")"
  done
  for rsh_r in architect data_architect designer; do
    rsh_by=$(printf '%s\n' "$rsh_sig" | cut -d'|' -f1 | sed '/^$/d' | sort -u | while IFS= read -r rsh_n; do [ "$(cfg "risk.$rsh_n.design_role")" != "$rsh_r" ] || printf '%s ' "$rsh_n"; done)
    [ -z "$rsh_by" ] || printf 'design_role.%s=%s\n' "$rsh_r" "${rsh_by% }"
  done
}
# risk_unsupported ID -> "GATE:focus|finding" for each UNSUPPORTED finding of a current focus record (never a PASS).
risk_unsupported() {
  for ru_g in $(required_gates "$1"); do
    for ru_f in $(risk_gate_focuses "$1" "$ru_g"); do
      ru_r=$(gate_latest_file "$1" "$ru_g" "$ru_f"); [ -n "$ru_r" ] || continue
      sed -n 's/^finding: [^|]*|blocking|[^|]*|\(UNSUPPORTED [^|]*\)|.*/\1/p' "$ru_r" | sed "s#^#$ru_g:$ru_f|#"
    done
  done
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
gate_of() { # ROLE [FOCUS] [ID]: a rules-gate risk focus (A78) lands on REVIEW_SMALL when the run's tier is small
  case "$1:${2:-}" in
    reviewer:plan) echo REVIEW_PLAN ;; reviewer:rules) echo REVIEW_RULES ;; reviewer:tests) echo REVIEW_TESTS ;;
    reviewer:data|reviewer:migration) echo REVIEW_DATA ;; reviewer:rules+tests) echo REVIEW_SMALL ;;
    reviewer:contract|reviewer:concurrency|reviewer:performance|reviewer:config)
      if [ -n "${3:-}" ] && required_gates "$3" | grep -Fxq REVIEW_SMALL; then echo REVIEW_SMALL; else echo REVIEW_RULES; fi ;;
    security_reviewer:*) echo SECURITY ;; qa:*) echo QA ;; verifier:*) echo VERIFY ;; *) return 1 ;;
  esac
}
# Default report artifact per gate for the compatibility `gate` command.
gate_default_artifact() {
  case "$1" in REVIEW_PLAN) echo reviews/proof-review/plan/REPORT.md ;; REVIEW_RULES) echo reviews/proof-review/rules/REPORT.md ;; REVIEW_SMALL) echo reviews/proof-review/small/REPORT.md ;;
    REVIEW_TESTS) echo reviews/test-trust/tests/REPORT.md ;; REVIEW_DATA) echo reviews/data-design/REVIEW.md ;; SECURITY) echo security/REPORT.md ;; QA) echo QA_REPORT.md ;; VERIFY) echo VERIFY.md ;; esac
}
valid_gate_name() { case "$1" in SECRETS|REVIEW_SMALL|REVIEW_PLAN|REVIEW_RULES|REVIEW_TESTS|REVIEW_DATA|SECURITY|QA|VERIFY) return 0 ;; *) return 1 ;; esac; }

# Freeze-time artifact contract: required artifacts exist, unrequired ones do not, class plan rules hold.
pipeline_check() {
  id=$1; dir=$(run_dir "$id")
  if gates_enforced "$id"; then
    pipeline_declared "$id" || fail "RUN.yaml has no pipeline block (create the run from .agents/templates/RUN.yaml)"
    pipeline_class_valid "$(pipeline_class "$id")" || fail "run $id is not classified: run 'agent.sh classify $id <TRIVIAL|STANDARD|COMPLEX|CRITICAL>' first"
  fi
  class=$(pipeline_class "$id")
  for pc in "evidence EVIDENCE.md" "qa QA_PLAN.md"; do
    pc_key=${pc% *} pc_file=${pc#* }
    if [ "$(pipeline_needs "$id" "$pc_key")" = yes ]; then [ -f "$dir/$pc_file" ] || fail "missing $pc_file (required by the ${class:-default} pipeline)"
    else [ ! -e "$dir/$pc_file" ] || fail "$pc_file is not part of the ${class:-default} pipeline; remove it (no artifacts without a consumer)"; fi
  done
  if [ "$(pipeline_needs "$id" architect)" = yes ]; then
    plan_section_present "$dir/PLAN.md" Architecture || fail "the $class pipeline requires an '## Architecture' section in PLAN.md (the Architect's contribution)"
  fi
  [ "$(plan_destructive "$dir/PLAN.md")" != invalid ] || fail "PLAN.md '## Data' must start with 'destructive: yes' or 'destructive: no'"
  pc_bad=$(plan_risk_invalid "$dir/PLAN.md")
  [ -z "$pc_bad" ] || fail "PLAN.md '## Risk' holds only flag lines '<flag>: yes|no' (flags: $risk_plan_flags); not one: $pc_bad"
  pc_max=$(pipeline_value "$class" max_scope_paths)
  if [ -n "$pc_max" ]; then
    pc_n=$(scope_mappings "$dir/PLAN.md" | wc -l | tr -d ' ')
    [ "$pc_n" -le "$pc_max" ] || fail "the $class pipeline allows at most $pc_max scope paths; this plan has $pc_n — reclassify"
  fi
}

# What a run requires: class artifacts, tier and every required gate with its status.
pipeline_show() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  pipeline_declared "$id" || fail "run $id has no pipeline block"
  class=$(pipeline_class "$id"); pipeline_class_valid "$class" || fail "run $id is not classified yet"
  risk_prime "$id"
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
  ps_fp=$(content_fingerprint)
  for ps_g in $ps_gates; do printf 'gate.%s=%s\n' "$ps_g" "$(gate_status "$id" "$ps_g" strict "$ps_fp")"; done
  # A78: risk signals, the focus each one adds to a gate, the per-focus status and the design roles to dispatch.
  for ps_g in $ps_gates; do
    for ps_f in $(risk_gate_focuses "$id" "$ps_g"); do printf 'focus.%s.%s=%s\n' "$ps_g" "$ps_f" "$(gate_focus_status "$id" "$ps_g" "$ps_f" strict "$ps_fp")"; done
  done
  risk_show "$id"
  risk_unsupported "$id" | while IFS='|' read -r ps_k ps_t; do printf 'unsupported.%s=%s\n' "$ps_k" "$ps_t"; done
}
class_rank() { case "$1" in TRIVIAL) echo 0 ;; STANDARD) echo 1 ;; COMPLEX) echo 2 ;; CRITICAL) echo 3 ;; *) echo 0 ;; esac; }
classify() {
  id=$1 class=$2 opt=${3:-}; require_run "$id"; dir=$(run_dir "$id"); require_lead
  gates_enforced "$id" || fail "classify requires the lifecycle_gates policy"
  pipeline_declared "$id" || fail "RUN.yaml has no pipeline block (create the run from .agents/templates/RUN.yaml)"
  require_open_run "$id"
  [ "$(run_state "$dir")" != CODE_DONE ] || fail "cannot reclassify a completed run: $id"
  pipeline_class_valid "$class" || fail "invalid classification: $class (want TRIVIAL|STANDARD|COMPLEX|CRITICAL)"
  # A61: a class below the task's own Suggested class is refused: the task author reads the request, a lower class
  # skips the evidence and QA plan and was only caught after IMPLEMENT (STANDARD.tr, C-4). Change the task's
  # Suggested class (a task change) or classify at least that.
  cl_sug=$(awk '/^## Suggested class[[:space:]]*$/ { g = 1; next } /^## / { g = 0 } g && match($0, /(TRIVIAL|STANDARD|COMPLEX|CRITICAL)/) { print substr($0, RSTART, RLENGTH); exit }' "$dir/TASK.md" 2>/dev/null)
  if [ -n "$cl_sug" ] && [ "$(class_rank "$class")" -lt "$(class_rank "$cl_sug")" ]; then
    fail "classification refused: TASK.md suggests $cl_sug and $class is lower. Classify at least $cl_sug, or change the task's '## Suggested class' with the reason (a task change before freeze)"
  fi
  # CLASSIFY precedes BRANCH (WORKFLOW.md): the branch is enforced once it is established.
  case "$(section_value "$dir" repository task_branch)" in ''|PENDING) ;; *) enforce_task_branch "$id" ;; esac
  verify_seal "$id"
  if [ -f "$dir/PLAN.md" ] && [ "$(plan_destructive "$dir/PLAN.md")" = yes ] && [ "$class" != CRITICAL ]; then fail "PLAN.md declares a destructive data change: the class is CRITICAL"; fi
  configured=$(pipeline_value "$class" review)
  case "$configured" in
    yes|no) [ -z "$opt" ] || fail "the $class pipeline fixes review=$configured; the 'review' option exists only where a pipeline says optional"; review=$configured ;;
    optional) case "$opt" in '') review=no ;; review) review=yes ;; *) fail "unknown option: $opt (want: review)" ;; esac ;;
    *) fail "no pipelines.$class entry in .agents/config.yaml" ;;
  esac
  set_run_value "$id" pipeline classification "$class"; set_run_value "$id" pipeline review "$review"
  ledger_append "$id" classify "$(section_value "$dir" handoff state)" "$(section_value "$dir" handoff state)" "$class review=$review"
  echo "classified: $id $class (autonomy: $(run_autonomy "$id"))"
}

# --- Freeze ------------------------------------------------------------------------
replace_hashes() {
  dir=$1 target=$2; id=$(basename "$dir"); mode=$(section_value "$dir" execution mode); case "$mode" in ''|PENDING) mode=$(cfg default_mode deterministic) ;; esac
  task_hash=$(hash_file "$dir/TASK.md"); plan_hash=$(hash_file "$dir/PLAN.md"); policy_hash=$(hash_file "$agents/modes/$mode.yaml")
  evidence_hash=not_required; [ "$(pipeline_needs "$id" evidence)" != yes ] || evidence_hash=$(hash_file "$dir/EVIDENCE.md")
  qa_plan_hash=not_required; [ "$(pipeline_needs "$id" qa)" != yes ] || qa_plan_hash=$(hash_file "$dir/QA_PLAN.md")
  scope_paths=$(scope_mappings "$dir/PLAN.md" | cut -d '|' -f1 | tr '\n' ',' | sed 's/,$//')
  awk -v a="$task_hash" -v b="$evidence_hash" -v c="$plan_hash" -v d="$policy_hash" -v e="$qa_plan_hash" -v f="$(pipeline_signature "$id")" -v s="$scope_paths" -v r="$(risk_config | sha256)" '
    /^freeze:$/ { i=1; print; next }
    i && /^[^[:space:]#]/ { if (!rk) print "  risk_sha256: \"" r "\""; rk=1; i=0 }
    i && /^  task_sha256:/ { print "  task_sha256: \"" a "\""; next }
    i && /^  evidence_sha256:/ { print "  evidence_sha256: \"" b "\""; next }
    i && /^  plan_sha256:/ { print "  plan_sha256: \"" c "\""; next }
    i && /^  qa_plan_sha256:/ { print "  qa_plan_sha256: \"" e "\""; next }
    i && /^  policy_sha256:/ { print "  policy_sha256: \"" d "\""; next }
    i && /^  pipeline:/ && f != "" { print "  pipeline: \"" f "\""; next }
    i && /^  scope_paths:/ { print "  scope_paths: \"" s "\""; next }
    i && /^  risk_sha256:/ { print "  risk_sha256: \"" r "\""; rk=1; next }
    { print }
    END { if (i && !rk) print "  risk_sha256: \"" r "\"" }
  ' "$dir/RUN.yaml" > "$target"
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
  [ "$(section_value "$dir" freeze risk_sha256)" = "$(risk_config | sha256)" ] || fail "freeze mismatch: risk (the risk:, performance:, security: or contract: block of .agents/config.yaml changed after freeze; restore it, or record an amendment and refreeze)"
  stored=$(section_value "$dir" freeze policy_sha256); actual=$(hash_file "$agents/modes/$mode.yaml")
  [ -n "$stored" ] && [ "$stored" = "$actual" ] || fail "freeze mismatch: policy"
  echo "freeze verified: $id"
}
scope_mappings() {
  awk '
    /^scope:$/ { inside=1; next } inside && /^---$/ { exit }
    inside && /^  - path: / { path=$0; sub(/^  - path: /, "", path); next }
    inside && /^    criteria: \[/ { c=$0; sub(/^    criteria: \[/, "", c); sub(/\]$/, "", c); if (path == "" || c == "") bad=1; else print path "|" c; path="" }
    END { if (bad || path != "") exit 1 }
  ' "$1"
}
authorized_path() { printf '%s\n' "$1" | cut -d '|' -f1 | grep -Fxq -- "$2"; }

# Approvals a freeze needs (D3): plan (supervised),
# scope (a refreeze that adds scope paths). Prints the approval files to consume, one per line.
# A60: a task that lists a pre-existing defect with `decision: fix` changes behaviour nobody asked for: the freeze
# needs the user's `scope` approval for the plan (the same kind an amendment adding paths needs). A defect with
# `decision: report` is a finding, never a change. TASK.md `## Pre-existing defects`: `- <path:symbol>: <what> --
# decision: report | fix`.
task_defect_fixes() { # TASK.md -> the lines that say `decision: fix`
  awk '/^## Pre-existing defects[[:space:]]*$/ { i = 1; next } /^## / { i = 0 } i && tolower($0) ~ /decision:[[:space:]]*fix/ { print }' "$1" 2>/dev/null
}
# Answers recorded as the user's must be the user's words (A60): in INTENT.md `## Rounds`, a round answering a
# `scope` decision with answered_by user must appear in a captured user prompt (.agents/local/prompts/history/).
verify_intent_provenance() { # ID
  vi_id=$1
  vi_f=$(run_dir "$vi_id")/design/INTENT.md
  [ -f "$vi_f" ] || vi_f=$root/$(cfg tasks.dir .agents/tasks)/$vi_id/design/INTENT.md
  vi_h=$root/.agents/local/prompts/history
  [ -f "$vi_f" ] && [ -d "$vi_h" ] || return 0
  vi_all=$(cat "$vi_h"/* 2>/dev/null | tr -s ' \t\n' ' ')
  vi_scope=$(awk -F'|' '/^## Decision tree/ { i = 1; next } /^## / { i = 0 }
    i && NF >= 8 { id = $2; br = $3; gsub(/^[ \t]+|[ \t]+$/, "", id); gsub(/^[ \t]+|[ \t]+$/, "", br); if (br == "scope") print id }' "$vi_f")
  awk -F'|' '/^## Rounds/ { i = 1; next } /^## / { i = 0 }
    i && NF >= 5 { a = $3; t = $4; by = $5; gsub(/^[ \t]+|[ \t]+$/, "", a); gsub(/^[ \t]+|[ \t]+$/, "", t); gsub(/^[ \t]+|[ \t]+$/, "", by)
      if (by == "user" && a ~ /^D-[0-9]+$/) print a "\t" t }' "$vi_f" | while IFS="$(printf '\t')" read -r vi_a vi_t; do
    printf '%s\n' "$vi_scope" | grep -Fxq -- "$vi_a" || continue
    vi_n=$(printf '%s' "$vi_t" | tr -s ' \t\n' ' ')
    case "$vi_all" in *"$vi_n"*) ;; *) echo "$vi_a"; ;; esac
  done
}
# K-6: approvals the handoff PLANNED -> IMPLEMENTING needs: destructive (PLAN `## Data` destructive: yes) and, for
# a single_step shape, single_step; both bound to the sha256 of the frozen PLAN.md (a refreeze drops them).
# Prints the approval files to consume, one per line.
implement_approvals() { # ID
  ia_id=$1; ia_d=$(run_dir "$1")
  [ "$(plan_destructive "$ia_d/PLAN.md")" = yes ] || return 0
  ia_plan=$(hash_file "$ia_d/PLAN.md")
  ia_f=$(find_approval "$ia_id" destructive "$ia_plan") || fail "PLAN.md declares a destructive data change: a destructive approval bound to the frozen PLAN.md is required before IMPLEMENT ('agent.sh request-approval $ia_id destructive'; relay it, the runtime records the user's reply; a refreeze drops an earlier approval)"
  printf '%s\n' "$ia_f"
  if [ "$(plan_migration_shape "$ia_d/PLAN.md")" = single_step ]; then
    ia_f=$(find_approval "$ia_id" single_step "$ia_plan") || fail "PLAN.md '## Data' declares single_step: yes: a destructive migration without expand/contract steps needs the user's explicit single-step approval bound to the frozen PLAN.md before IMPLEMENT ('agent.sh request-approval $ia_id single_step')"
    printf '%s\n' "$ia_f"
  fi
}
freeze_approvals() {
  fa_id=$1 fa_mode=$2; fa_d=$(run_dir "$1"); fa_plan=$(hash_file "$fa_d/PLAN.md")
  if [ "$(run_autonomy "$fa_id")" = supervised ]; then
    fa_f=$(find_approval "$fa_id" plan "$fa_plan") || fail "supervised freeze requires a plan approval for this PLAN.md: run 'agent.sh request-approval $fa_id plan', relay it, then 'agent.sh approve $fa_id plan'"
    printf '%s\n' "$fa_f"
  fi
  # K-6: the destructive / single_step approvals are not a freeze condition: they stop the run after the freeze,
  # before IMPLEMENT (implement_approvals), bound to the frozen PLAN.md hash. The freeze validates the shape only.
  if [ "$(plan_destructive "$fa_d/PLAN.md")" = yes ]; then
    case "$(plan_migration_shape "$fa_d/PLAN.md")" in
      expand_contract|single_step) ;;
      *) fail "PLAN.md '## Data' is destructive without expand/contract steps: the step table needs a non-destructive step in phase expand, backfill or switch, and every destructive step in phase deferred (a separate, later migration, not part of this change). Only the user's explicit single-step approval allows one step: add 'single_step: yes' (the approval is requested after the freeze, before IMPLEMENT)" ;;
    esac
  fi
  if [ -n "$(task_defect_fixes "$fa_d/TASK.md")" ]; then
    fa_f=$(find_approval "$fa_id" scope "$fa_plan") || fail "TASK.md lists a pre-existing defect with 'decision: fix': changing behaviour nobody asked for needs the user's scope approval for this PLAN.md ('agent.sh request-approval $fa_id scope'), or list it as 'decision: report' and leave it unchanged"
    printf '%s\n' "$fa_f"
  fi
  fa_bad=$(verify_intent_provenance "$fa_id" | tr '\n' ' ')
  [ -z "$fa_bad" ] || fail "INTENT.md records the user's answer to scope decision(s) $fa_bad, but those words are in no captured user prompt: an answer recorded as the user's must be what the user said (a blanket 'use your recommended option' is recorded as that)"
  # D15: an exhausted fix budget ends in `terminate FAILED`; a refreeze (which starts a fresh budget) needs
  # the user's explicit budget approval.
  if [ "$fa_mode" = refreeze ] && [ "$(fix_rounds_used "$fa_id")" -gt "$(max_fix_rounds)" ]; then
    fa_f=$(find_approval "$fa_id" budget "$fa_plan") || fail "the fix rounds are exhausted: only 'agent.sh terminate $fa_id FAILED', or a refreeze with the user's budget approval for this PLAN.md ('agent.sh request-approval $fa_id budget')"
    printf '%s\n' "$fa_f"
  fi
  if [ "$fa_mode" = refreeze ] && section_key_present "$fa_d" freeze scope_paths; then
    fa_old=$(section_value "$fa_d" freeze scope_paths); fa_new=''
    for fa_p in $(scope_mappings "$fa_d/PLAN.md" | cut -d '|' -f1); do
      printf '%s\n' "$fa_old" | tr ',' '\n' | grep -Fxq -- "$fa_p" || fa_new="$fa_new $fa_p"
    done
    if [ -n "$fa_new" ]; then
      fa_f=$(find_approval "$fa_id" scope "$fa_plan") || fail "the amendment adds scope paths ($fa_new ): a scope approval for this PLAN.md is required ('agent.sh request-approval $fa_id scope')"
      printf '%s\n' "$fa_f"
    fi
  fi
}
# Scope entries may carry `new: true` (the path does not exist yet at freeze). Checked for every path a
# freeze adds: a `new: true` path that exists FAILS; a path without it that does not exist FAILS.
scope_new_paths() { awk '/^scope:$/ { i=1; next } i && /^---$/ { exit } i && /^  - path: / { p=$0; sub(/^  - path: /, "", p); next } i && /^    new:[[:space:]]*true[[:space:]]*$/ { print p }' "$1"; }
verify_scope_existence() { # ID freeze|refreeze
  vse_d=$(run_dir "$1"); vse_old=''; [ "$2" != refreeze ] || vse_old=$(section_value "$vse_d" freeze scope_paths)
  vse_new=$(scope_new_paths "$vse_d/PLAN.md")
  for vse_p in $(scope_mappings "$vse_d/PLAN.md" | cut -d '|' -f1); do
    if [ -n "$vse_old" ] && printf '%s\n' "$vse_old" | tr ',' '\n' | grep -Fxq -- "$vse_p"; then continue; fi
    if printf '%s\n' "$vse_new" | grep -Fxq -- "$vse_p"; then
      [ ! -e "$root/$vse_p" ] || fail "scope path $vse_p is marked 'new: true' but already exists"
    else
      [ -e "$root/$vse_p" ] || fail "scope path $vse_p does not exist; mark it 'new: true' when the task creates it"
    fi
  done
}
freeze() {
  id=$1; require_run "$id"; db_guard_check "$id"; dir=$(run_dir "$id"); for f in TASK.md PLAN.md RUN.yaml; do [ -f "$dir/$f" ] || fail "missing $f"; done
  require_open_run "$id"
  [ "$(run_state "$dir")" != CODE_DONE ] || fail "cannot freeze completed run: $id"; [ "$(baseline_status "$dir")" = captured ] || fail "baseline required before freeze: $id"
  enforce_task_branch "$id"
  verify_seal "$id"
  verify_task_source_status "$id"
  # A destructive data change makes the task CRITICAL (D9/D14), whatever was classified.
  if gates_enforced "$id" && [ "$(plan_destructive "$dir/PLAN.md")" = yes ] && [ "$(pipeline_class "$id")" != CRITICAL ]; then
    fz_prev=$(pipeline_class "$id")
    set_run_value "$id" pipeline classification CRITICAL; set_run_value "$id" pipeline review "$(pipeline_value CRITICAL review)"
    ledger_append "$id" classify "$(section_value "$dir" handoff state)" "$(section_value "$dir" handoff state)" "CRITICAL (forced: destructive data change; was $fz_prev)"
    echo "classification forced to CRITICAL: PLAN.md declares a destructive data change"
  fi
  pipeline_check "$id"
  fz_mode=freeze
  if freeze_hash_present "$dir"; then
    [ "${2:-}" = refreeze ] && [ -n "${3:-}" ] || fail "existing freeze requires explicit amendment"
    case "$3" in */*|*..*) fail "invalid amendment name: $3" ;; esac
    [ -f "$dir/amendments/$3" ] || fail "existing freeze requires explicit amendment"
    ! grep -F "event=refreeze " "$(ledger_file "$id")" 2>/dev/null | grep -Fq "detail=amendment $3" || fail "amendment $3 was already used for a refreeze; write a new amendment"
    fz_mode=refreeze
  fi
  verify_scope_existence "$id" "$fz_mode"
  # A79: the mandatory `## Assumptions` registers are well-formed and no unverified high-risk assumption stands
  # without the user's `accept` answer (the missing ones are recorded as NEEDS_INPUT questions).
  verify_assumptions "$id" ask >/dev/null
  if gates_enforced "$id"; then verify_qa_plan_bound "$id"; fi
  fz_lang=$(for fz_f in TASK.md PLAN.md EVIDENCE.md QA_PLAN.md; do [ ! -f "$dir/$fz_f" ] || printf '%s\n' "$dir/$fz_f"; done)
  # shellcheck disable=SC2086
  fz_hits=$(language_scan $fz_lang) || fail "$(language_fail_text "$(printf '%s' "$fz_hits" | tr '\n' ' ')")"
  fz_approvals=''
  if gates_enforced "$id"; then fz_approvals=$(freeze_approvals "$id" "$fz_mode"); fi
  fz_oldplan=$(section_value "$dir" freeze plan_sha256)
  tmp=$dir/RUN.yaml.tmp; replace_hashes "$dir" "$tmp"
  if [ "$fz_mode" = refreeze ] && gates_enforced "$id"; then
    [ "$(sed -n '/^freeze:$/,/^[^ ]/p' "$dir/RUN.yaml" | grep -v scope_paths)" != "$(sed -n '/^freeze:$/,/^[^ ]/p' "$tmp" | grep -v scope_paths)" ] || { rm -f "$tmp"; fail "refreeze changes nothing: an amendment must change the task, evidence, plan, QA plan or classification"; }
  fi
  mv "$tmp" "$dir/RUN.yaml"; sv_reset; set_task_source_revision "$dir"
  if gates_enforced "$id"; then
    if [ "$fz_mode" = refreeze ]; then refreeze_lifecycle "$id" "$3" "$fz_oldplan"
    else ledger_append "$id" freeze "$(section_value "$dir" handoff state)" "$(section_value "$dir" handoff state)" "$(section_value "$dir" freeze pipeline)"; fi
    for fz_a in $fz_approvals; do consume_approval "$id" "$fz_a"; done
  fi
  echo "freeze recorded: $id"
  if [ "$fz_mode" = refreeze ] && gates_enforced "$id" && [ "$(plan_destructive "$dir/PLAN.md")" = yes ]; then
    if [ "$(section_value "$dir" handoff state)" = PLANNED ] && [ "$fz_oldplan" != "$(section_value "$dir" freeze plan_sha256)" ]; then
      echo "refreeze: PLAN.md has a new hash; an earlier destructive / single_step approval was bound to the old one and no longer counts. The run is back at PLANNED: the implementer cannot work, and IMPLEMENTED/CODE_DONE are unreachable, until a destructive approval for this PLAN.md exists ('agent.sh request-approval $id destructive', then 'agent.sh handoff $id IMPLEMENTING')"
    fi
  fi
}

# --- Task-source contract (projection hash; see WORKFLOW.md "Task-source contract") --
local_task_source_run() { [ "$(section_value "$(run_dir "$1")" task_source type)" = local_markdown ]; }
task_source_contract_hash() {
  awk -v id="$1" '
    { line[NR] = $0 }
    END {
      begin = "<!-- COMPLETION-REPORT:BEGIN:" id " -->"; endm = "<!-- COMPLETION-REPORT:END:" id " -->"
      n = 0; stripped = 0
      for (i = 1; i <= NR; i++) {
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
set_task_source_revision() {
  dir=$1 type=$(section_value "$1" task_source type)
  case "$type" in
    local_markdown) source=$(local_task_source "$dir") || return 1; replace_section_value "$dir" task_source revision "$(task_source_contract_hash "$(basename "$dir")" "$source")" "$dir/RUN.yaml.tmp" && mv "$dir/RUN.yaml.tmp" "$dir/RUN.yaml"; sv_reset ;;
    none) [ "$(section_value "$dir" task_source revision)" = not_applicable ] || fail "task source none requires revision: not_applicable" ;;
    *) fail "task source adapter unavailable: ${type:-missing}" ;;
  esac
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
  [ "$base" = "$head" ] || { [ "$ctp_base" = "$base" ] && git -C "$root" merge-base --is-ancestor "$base" HEAD; } || fail "stale plan: repository.base_sha changed ($base -> $head); amendment and refreeze required"
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
task_source_relocate() {
  id=$1 new=$2; require_run "$id"; dir=$(run_dir "$id"); require_lead
  local_task_source_run "$id" || fail "task-source-relocate requires a local Markdown task source"
  freeze_hash_present "$dir" || fail "the task source can be relocated only after the run is frozen"
  [ "$(section_value "$dir" completion_report published)" != true ] || fail "cannot relocate the task source after the completion report is published: its receipt binds the location"
  verify_freeze "$id" >/dev/null; enforce_task_branch "$id"; verify_seal "$id"
  case "$new" in ''|/*|*'..'*|*'//'*) fail "invalid task source path: $new" ;; esac
  old=$(section_value "$dir" task_source path)
  [ "$new" != "$old" ] || fail "the task source is already recorded at $old"
  { [ ! -e "$root/$old" ] && [ ! -L "$root/$old" ]; } || fail "the task source still exists at $old: a relocation is a move, not a copy"
  [ ! -L "$root/$new" ] || fail "task source must not be a symlink: $new"
  [ -f "$root/$new" ] || fail "task source missing or non-regular: $new"
  [ "$(section_value "$dir" task_source revision)" = "$(task_source_contract_hash "$id" "$root/$new")" ] || fail "the task contract at $new differs from the frozen contract (only the Status value and the published completion-report block may differ); amendment and refreeze required"
  set_run_value "$id" task_source path "$new"
  if gates_enforced "$id"; then ledger_append "$id" task-source-relocate "$(section_value "$dir" handoff state)" "$(section_value "$dir" handoff state)" "$old -> $new"; fi
  echo "task source relocated: $id $old -> $new"
}
task_source_status() {
  id=$1; require_run "$id"; dir=$(run_dir "$id"); require_lead; require_open_run "$id"
  local_task_source_run "$id" || fail "task-source-status requires a local Markdown task source"
  [ "$(section_value "$dir" completion_report published)" != true ] || fail "cannot change the task source status after the completion report is published: its receipt binds the task source"
  enforce_task_branch "$id"; verify_seal "$id"
  path=$(section_value "$dir" task_source path); source=$(local_task_source "$dir")
  want=$(lifecycle_folder_status "$path")
  [ -n "$want" ] || fail "task source $path is not under a lifecycle folder (backlog/, todo/, in-progress/ or done/): nothing to synchronize"
  have=$(declared_task_status "$source"); [ -n "$have" ] || fail "task source $path has no **Status:** line"
  [ "$have" != "$want" ] || { echo "task source status already $want: $id"; return 0; }
  revision=$(section_value "$dir" task_source revision)
  tmp=$(mktemp "${TMPDIR:-/tmp}/agent-task-status.XXXXXX")
  awk -v s="$want" '/^\*\*Status:\*\*/ { print "**Status:** " s; next } { print }' "$source" > "$tmp"
  case "$revision" in ''|PENDING|not_applicable) : ;; *)
    [ "$revision" = "$(task_source_contract_hash "$id" "$tmp")" ] || { rm -f "$tmp"; fail "refusing to change the task source: the frozen task contract would change; amendment and refreeze required"; } ;;
  esac
  cat "$tmp" > "$source"; rm -f "$tmp"
  if gates_enforced "$id"; then ledger_append "$id" task-source-status "$(section_value "$dir" handoff state)" "$(section_value "$dir" handoff state)" "$path: $have -> $want"; fi
  echo "task source status synchronized: $id $path $have -> $want"
}

# --- Scope ---------------------------------------------------------------------------
# Knowledge scope (Transaction B): space-separated entries of knowledge_scope_root; an entry ending in /
# is a directory prefix, any other entry an exact path. A plan-scoped path stays application scope.
in_knowledge_scope() {
  for ks_e in $(cfg knowledge_scope_root ''); do
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
  id=$1 allow_knowledge=${2:-0}; require_run "$id"; dir=$(run_dir "$id"); enforce_task_branch "$id"; mappings=$(scope_mappings "$dir/PLAN.md") || fail "invalid scope mapping"; [ -n "$mappings" ] || fail "scope mapping missing"
  status=$(baseline_status "$dir"); [ "$status" = captured ] || fail "baseline required before scope verification: $id"
  validate_control_artifacts "$id"
  tmp=$(mktemp "${TMPDIR:-/tmp}/agent-scope.XXXXXX")
  for type in tracked untracked; do
    paths=$( [ "$type" = tracked ] && current_tracked_paths || current_untracked_paths )
    printf '%s\n' "$paths" | while IFS= read -r changed; do
      [ -n "$changed" ] || continue
      known_control_artifact "$id" "$changed" && continue
      task_source_bookkeeping_only "$id" "$changed" && continue
      if [ "$allow_knowledge" = 1 ] && in_knowledge_scope "$changed" && ! authorized_path "$mappings" "$changed"; then continue; fi
      prior=$(baseline_fingerprint "$type" "$changed" "$dir"); current=$(fingerprint_path "$changed")
      if [ -n "$prior" ] && [ "$prior" = "$current" ]; then continue; fi
      authorized_path "$mappings" "$changed" || printf '%s\n' "$changed" >> "$tmp"
    done
  done
  unexpected=$(cat "$tmp"); rm "$tmp"
  [ -z "$unexpected" ] || { echo "unexpected or unmapped task-introduced paths:" >&2; printf '%s\n' "$unexpected" >&2; return 1; }; echo "scope check passed: $id"
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
    [ "$ks" != KNOWLEDGE_DONE ] || fail "knowledge_state is KNOWLEDGE_DONE but no knowledge-scope changes were found — record 'not_applicable' instead if no writes were needed"
  fi
  echo "knowledge scope verified: $id"
}
# Knowledge files are written after CODE_DONE, after the SECRETS gate: DONE and delivery-check scan them.
scan_knowledge_secrets() {
  sk_paths=$(knowledge_owned_paths "$1" | while IFS= read -r p; do [ -f "$root/$p" ] && printf '%s\n' "$p"; done)
  [ -n "$sk_paths" ] || return 0
  [ -f "$scripts/secret-scan.sh" ] || fail "secret scanner missing: .agents/scripts/secret-scan.sh"
  sk_rc=0
  # shellcheck disable=SC2086 # one argument per path (paths contain no whitespace by contract)
  sk_out=$(cd "$root" && sh "$scripts/secret-scan.sh" $sk_paths 2>&1) || sk_rc=$?
  case "$sk_rc" in
    0) return 0 ;;
    1) printf '%s\n' "$sk_out" | sed 's/^/  /' >&2; fail "secret scan of the knowledge-scope files written after CODE_DONE found secrets: remove them" ;;
    *) fail "secret scan of the knowledge-scope files failed (exit $sk_rc): $(printf '%s' "$sk_out" | head -3 | tr '\n' ' ')" ;;
  esac
}

# Run artifact registry (D10): the only files a run directory may hold. Unknown files are rejected.
known_control_artifact() {
  id=$1 path=$2
  case "$path" in .agents/runs/"$id"/*) ;; *)
    rundir=$(run_dir "$id")
    if [ "$(section_value "$rundir" completion_report published)" = true ] || ls "$rundir"/gates/*-REOPEN.yaml >/dev/null 2>&1; then
      source_path=$(section_value "$rundir" task_source path)
      [ -n "$source_path" ] && [ "$path" = "$source_path" ] && return 0
    fi
    return 1 ;;
  esac
  kc_rel=${path#.agents/runs/"$id"/}
  case "$kc_rel" in
    TASK.md|PLAN.md|RUN.yaml|COMPLETION_REPORT.md|LEDGER.log|VERIFY.md|.lock/pid) return 0 ;;
    amendments/*|dispatch/*|worker-evidence/*|decisions/*|gates/*|results/*|reports/*|questions/*|approvals/*|waivers/*|security/*) return 0 ;;
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
  [ -z "$bad" ] || { echo "unexpected run artifact:" >&2; printf '%s' "$bad" >&2; return 1; }
}

# --- Classification check (A31): the class is the lead's claim, the diff is the fact. -----------
# TRIVIAL covers text and configuration changes. A TRIVIAL run whose diff changes an executable code file
# (config review.executable_code, default below) must be reclassified before IMPLEMENTED and CODE_DONE.
executable_code_default='*.go *.py *.pyw *.js *.mjs *.cjs *.jsx *.ts *.mts *.cts *.tsx *.java *.kt *.kts *.scala *.groovy *.rs *.c *.cc *.cpp *.cxx *.h *.hh *.hpp *.cs *.fs *.vb *.rb *.php *.swift *.m *.mm *.dart *.lua *.pl *.pm *.r *.jl *.ex *.exs *.erl *.hs *.ml *.clj *.sh *.bash *.zsh *.fish *.ps1 *.bat *.cmd *.sql *.vue *.svelte *.gradle'
verify_classification() { # ID
  vc_id=$1
  gates_enforced "$vc_id" && pipeline_class_valid "$(pipeline_class "$vc_id")" || return 0
  [ "$(pipeline_class "$vc_id")" = TRIVIAL ] || return 0
  vc_globs=$(cfg review.executable_code "$executable_code_default")
  vc_hits=''
  for vc_p in $(task_changed_paths "$vc_id"); do
    ! path_matches "$vc_p" "$vc_globs" || vc_hits="$vc_hits $vc_p"
  done
  [ -z "$vc_hits" ] || fail "classification blocked: run $vc_id is TRIVIAL but its diff changes executable code:${vc_hits}. TRIVIAL covers text and configuration only. Reclassify: write the evidence and QA plan the new class requires, 'agent.sh classify $vc_id STANDARD' (or higher), then amend and 'agent.sh refreeze $vc_id <AMENDMENT>'."
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
db_file_meta() { stat -c '%s %Y' "$1" 2>/dev/null || stat -f '%z %m' "$1" 2>/dev/null || echo unknown; }
db_snapshot() { # "path|size mtime" per database file inside the project, sorted
  ds_globs=$(db_config paths)
  set -f; set --
  for ds_g in $ds_globs; do
    case "$ds_g" in */*) set -- "$@" -o -path "$root/${ds_g#\*\*/}" ;; *) set -- "$@" -o -name "$ds_g" ;; esac
  done
  set +f
  [ $# -gt 0 ] || return 0
  shift
  find "$root" \( -name .git -o -name node_modules -o -name .agents \) -prune -o -type f \( "$@" \) -print 2>/dev/null | sort |
    while IFS= read -r ds_f; do
      [ -n "$ds_f" ] || continue
      printf '%s|%s\n' "${ds_f#"$root"/}" "$(db_file_meta "$ds_f")"
    done
}
db_baseline_file() { printf '%s/.agents/local/db/%s.snapshot\n' "$root" "$1"; }
db_guard_baseline() { # ID
  dg_f=$(db_baseline_file "$1"); mkdir -p "$(dirname "$dg_f")" 2>/dev/null || return 0
  db_snapshot > "$dg_f.tmp" 2>/dev/null && mv "$dg_f.tmp" "$dg_f"
}
db_guard_check() { # ID: fails when a database file changed, appeared or vanished since the run started
  dg_f=$(db_baseline_file "$1")
  [ -f "$dg_f" ] || return 0   # a run started before the guard has no baseline
  dg_now=$(db_snapshot); dg_then=$(cat "$dg_f")
  [ "$dg_now" != "$dg_then" ] || return 0
  dg_diff=$(printf '%s\n%s\n' "$dg_then" "$dg_now" | sort | uniq -u | cut -d '|' -f1 | sort -u | tr '\n' ' ')
  fail "database guard: a database file changed during run $1 (${dg_diff% }). No agent touches a database that is not a test suite's own throwaway database, and no destructive step runs before the user's approval in any environment. Restore the file(s), then record the incident with 'agent.sh ledger-note $1 <TEXT>'; the run cannot continue until the baseline matches"
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
verify_qa_plan_bound() { # ID
  vq_id=$1; vq_d=$(run_dir "$vq_id")
  [ "$(pipeline_needs "$vq_id" qa)" = yes ] || return 0
  [ -f "$vq_d/QA_PLAN.md" ] && [ -f "$vq_d/PLAN.md" ] || return 0
  vq_cited=$(sed -n 's/^Plan sha256: \([0-9a-f]\{64\}\)[[:space:]]*$/\1/p' "$vq_d/QA_PLAN.md" | head -n 1)
  [ -n "$vq_cited" ] || fail "QA_PLAN.md must cite the plan it is derived from: a line 'Plan sha256: <64 hex>' (the sha256 of the final PLAN.md; 'node <qa-plan skill>/scripts/validate-qa.mjs hash PLAN.md'). Write the QA plan after PLAN.md is final"
  [ "$vq_cited" = "$(hash_file "$vq_d/PLAN.md")" ] || fail "QA_PLAN.md was derived from a different PLAN.md (it cites $(printf '%.12s' "$vq_cited")..., PLAN.md is $(printf '%.12s' "$(hash_file "$vq_d/PLAN.md")")...): re-derive the QA plan from the current plan (dispatch qa) before freeze; a plan or contract change changes the scenarios"
  vq_pacs=$( { awk '/^[[:space:]]*criteria:[[:space:]]*\[/ { l = $0; while (match(l, /AC-[0-9]+/)) { print substr(l, RSTART, RLENGTH); l = substr(l, RSTART + RLENGTH) } }' "$vq_d/PLAN.md"
    awk '/^## / { i = ($0 ~ /^## Behavior[[:space:]]*$/); next } i && /^[-*][[:space:]]+AC-[0-9]+:/ { l = $0; match(l, /AC-[0-9]+/); print substr(l, RSTART, RLENGTH) }' "$vq_d/PLAN.md"; } | sort -u)
  vq_qacs=$(awk '/^- QA-[0-9]+ \(AC-/ { l = $0; sub(/^- QA-[0-9]+ \(/, "", l); sub(/\).*/, "", l); n = split(l, a, /,[[:space:]]*/); for (i = 1; i <= n; i++) print a[i] }' "$vq_d/QA_PLAN.md" | sort -u)
  vq_acc=$(awk '
      /^## Adversarial scenarios[[:space:]]*$/ { skip = 1; next } /^## / { skip = 0 }
      !skip && /^- QA-[0-9]+ \(AC-/ { l = $0; sub(/^- QA-[0-9]+ \(/, "", l); sub(/\).*/, "", l); n = split(l, a, /,[[:space:]]*/); for (i = 1; i <= n; i++) print a[i] }' "$vq_d/QA_PLAN.md" | sort -u)
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
}

# --- The tests review proves the plan's tests observe their criteria (A59) -------------------------
# A REVIEW_TESTS submission (reviewer, focus tests) needs reviews/test-trust/tests/findings.json that passes the
# test-trust validator against the frozen PLAN.md: every criterion of PLAN `## Tests` has a claim mutant its named
# test killed by an assertion. Checked only where the skill and node are installed (a real install has both).
verify_tests_findings() { # ID
  vt_s=$root/.agents/skills/test-trust/scripts/validate-findings.mjs
  [ -f "$vt_s" ] && command -v node >/dev/null 2>&1 || return 0
  vt_d=$(run_dir "$1")
  vt_f=$vt_d/reviews/test-trust/tests/findings.json
  [ -f "$vt_f" ] || { echo "the tests review needs reviews/test-trust/tests/findings.json (test-trust diff mode, scope.diff.claims for every criterion of PLAN ## Tests); the report alone is not enough"; return 1; }
  vt_p=''; [ ! -f "$vt_d/PLAN.md" ] || vt_p="--plan $vt_d/PLAN.md"
  # shellcheck disable=SC2086
  vt_out=$(node "$vt_s" "$vt_f" $vt_p 2>&1) || { printf '%s\n' "$vt_out" | tr '\n' ' '; return 1; }
}

# --- design-sync is not skipped silently (A65) --------------------------------------------------------
# A VERIFY submission of a run whose plan changes what a configured design document describes (a UI section, a
# Data section with content, Contracts other than none, where that document exists) needs design/SYNC.md, or a
# VERIFY.md line `design-sync: SKIPPED (<reason>)`.
verify_design_sync() { # ID
  vs_d=$(run_dir "$1")
  [ "$(pipeline_class "$1")" != TRIVIAL ] || return 0
  [ -f "$vs_d/PLAN.md" ] || return 0
  [ -f "$vs_d/design/SYNC.md" ] && return 0
  [ ! -f "$vs_d/VERIFY.md" ] || ! grep -q 'design-sync: SKIPPED (' "$vs_d/VERIFY.md" || return 0
  vs_need=no
  for vs_k in data_model api architecture; do
    vs_p=$(cfg "design_docs.$vs_k" ""); [ -n "$vs_p" ] && [ -f "$root/$vs_p" ] || continue
    case "$vs_k" in
      data_model) [ "$(awk '/^## Data[[:space:]]*$/ { i = 1; next } /^## / { i = 0 } i && NF { n++ } END { print n + 0 }' "$vs_d/PLAN.md")" -gt 1 ] && vs_need=yes ;;
      api) [ -n "$(awk '/^## Contracts[[:space:]]*$/ { i = 1; next } /^## / { i = 0 } i && NF && tolower($0) !~ /^none/ { print; exit }' "$vs_d/PLAN.md")" ] && vs_need=yes ;;
    esac
  done
  [ "$vs_need" = no ] || { echo "the plan changes what a design document describes: write design/SYNC.md (design-sync) or record 'design-sync: SKIPPED (<reason>)' in VERIFY.md"; return 1; }
}

# --- Scratch worktrees are removed before CODE_DONE (A53, C-18) -----------------------------------
# Evidence worktrees live under $TMPDIR (or /tmp); a specialist that created one removes it. A scratch worktree
# still registered when the run reaches CODE_DONE blocks it, with the paths and the way to remove them.
verify_no_scratch_worktrees() {
  vw_t=${TMPDIR:-/tmp}; vw_t=${vw_t%/}; vw_t=${vw_t#/private}
  vw_extra=''
  vw_list=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  for vw_p in $vw_list; do
    vw_n=${vw_p#/private}
    [ "$vw_n" != "${root#/private}" ] || continue
    case "$vw_n" in
      "$vw_t"/*|/tmp/*|/var/folders/*) vw_extra="$vw_extra $vw_p" ;;
    esac
  done
  [ -z "$vw_extra" ] || fail "CODE_DONE blocked: scratch git worktrees created during the run are still registered:$vw_extra. Remove each ('git worktree remove --force <path>'; the lead may run it) and run it again"
}

# --- Defect tasks carry a debug-proof result (A35). ---------------------------------------------
# A STANDARD-or-higher task whose title or Goal names a defect (config review.defect_words) must have a
# `reports/NNN-debug.md` (reproduction, root cause, regression test) before IMPLEMENTED.
defect_words_default='bug defect regression broken wrong incorrect crash loses losing fails failing error fix fixes fixed hides hidden disappear disappears disappeared unreachable'
verify_debug_result() { # ID
  vd_id=$1; vd_d=$(run_dir "$vd_id")
  gates_enforced "$vd_id" && pipeline_class_valid "$(pipeline_class "$vd_id")" || return 0
  [ "$(pipeline_class "$vd_id")" != TRIVIAL ] || return 0
  [ -f "$vd_d/TASK.md" ] || return 0
  # The title and Goal are scanned for the configured defect words. `## Suggested class` is the task author's
  # own statement of the kind of work: only an explicit bug/defect/regression there counts (its prose may use
  # a defect word for something else: "its own step drops nothing").
  vd_text=$( { sed -n '1p' "$vd_d/TASK.md"; awk '/^## Goal[[:space:]]*$/ { g=1; next } /^## / { g=0 } g' "$vd_d/TASK.md"; } | tr '[:upper:]' '[:lower:]')
  vd_hit=''
  for vd_w in $(cfg review.defect_words "$defect_words_default"); do
    # shellcheck disable=SC2018 # ASCII a-z is intended: non-ASCII letters must stay word separators
    case " $(printf '%s' "$vd_text" | tr -c 'a-z' ' ') " in *" $vd_w "*) vd_hit=$vd_w; break ;; esac
  done
  if [ -z "$vd_hit" ]; then
    # shellcheck disable=SC2018 # ASCII a-z is intended (see above)
    vd_cls=$(awk '/^## Suggested class[[:space:]]*$/ { g=1; next } /^## / { g=0 } g' "$vd_d/TASK.md" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z' ' ')
    for vd_w in bug defect regression; do case " $vd_cls " in *" $vd_w "*) vd_hit=$vd_w; break ;; esac; done
  fi
  if [ -z "$vd_hit" ]; then
    # The user's own words (`>` blockquote lines, A33): the defect words of the config and Turkish stems (A67).
    vd_q=$(grep -E '^[[:space:]]*>' "$vd_d/TASK.md" 2>/dev/null | tr '[:upper:]' '[:lower:]')
    # shellcheck disable=SC2018 # ASCII a-z is intended (see above)
    vd_qw=" $(printf '%s' "$vd_q" | tr -c 'a-z' ' ') "
    for vd_w in $(cfg review.defect_words "$defect_words_default"); do case "$vd_qw" in *" $vd_w "*) vd_hit=quote; break ;; esac; done
    if [ -z "$vd_hit" ] && printf '%s\n' "$vd_q" | grep -Eq 'hata|bozuk|kayb|kayıp|kaybol|görünm|çalışm|yanlış'; then vd_hit=quote; fi
  fi
  [ -n "$vd_hit" ] || return 0
  ls "$vd_d"/reports/[0-9][0-9][0-9]-debug.md >/dev/null 2>&1 && return 0
  fail "IMPLEMENTED blocked: the task describes a defect ('$vd_hit' in its title or goal) but there is no debug-proof result: the implementer writes reports/NNN-debug.md (reproduction, root cause, regression test) and submits it"
}

# --- Handoff ladder: PLANNED -> IMPLEMENTING -> IMPLEMENTED -> CODE_DONE -> DONE ------------
record_handoff() {
  id=$1 phase=$2; require_run "$id"; dir=$(run_dir "$id")
  enforce_task_branch "$id"; require_open_run "$id"
  case "$phase" in IMPLEMENTING|IMPLEMENTED|CODE_DONE|DONE) ;; *) fail "invalid handoff phase";; esac
  allow_knowledge=0; [ "$phase" = DONE ] && allow_knowledge=1
  verify_freshness "$id"; verify_scope "$id" "$allow_knowledge"
  verify_seal "$id"
  patch=$(task_patch_fingerprint "$id")
  current=$(section_value "$dir" handoff state)
  hd_detail='' hd_approvals=''
  case "$phase" in
    IMPLEMENTING)
      case "$current" in
        PLANNED) if gates_enforced "$id"; then hd_approvals=$(implement_approvals "$id"); fi ;;
        IMPLEMENTING) ;;
        IMPLEMENTED) gates_enforced "$id" || fail "illegal handoff transition: $current -> $phase"
          [ "$execution_role" = lead ] || fail "only the lead may reopen implementation after a gate finding (diagnosis comes first)"
          reopen_for_fix "$id"; hd_detail="fix_round=$(fix_rounds_used "$id")" ;;
        *) fail "illegal handoff transition: $current -> $phase";;
      esac ;;
    IMPLEMENTED)
      case "$current" in IMPLEMENTING|IMPLEMENTED) ;; *) fail "illegal handoff transition: $current -> $phase" ;; esac
      verify_classification "$id"
      db_guard_check "$id"
      verify_debug_result "$id"
      verify_worker_evidence "$id"
      verify_mutation_ownership "$id" 1
      verify_fix_bound "$id"
      set_run_value "$id" handoff implemented_patch_sha256 "$patch"
      set_run_value "$id" handoff code_done_patch_sha256 PENDING ;;
    CODE_DONE)
      case "$current" in IMPLEMENTED|CODE_DONE) ;; *) fail "illegal handoff transition: $current -> $phase";; esac
      [ "$(section_value "$dir" handoff implemented_patch_sha256)" = "$patch" ] || fail "CODE_DONE blocked: the application tree changed since IMPLEMENTED"
      verify_classification "$id"
      db_guard_check "$id"
      verify_no_scratch_worktrees
      [ "$(section_value "$dir" execution awaiting_input)" != true ] || fail "CODE_DONE blocked: questions are pending ('agent.sh questions $id')"
      if gates_enforced "$id"; then
        verify_mutation_ownership "$id"
        verify_required_gates "$id" strict "CODE_DONE blocked"
      fi
      set_run_value "$id" handoff code_done_patch_sha256 "$patch" ;;
    DONE)
      case "$current" in CODE_DONE|DONE) ;; *) fail "illegal handoff transition: $current -> $phase";; esac
      [ "$(section_value "$dir" handoff code_done_patch_sha256)" = "$patch" ] || fail "DONE blocked: CODE_DONE stale or missing"
      db_guard_check "$id"
      verify_run_language "$id"
      verify_knowledge_scope "$id"
      scan_knowledge_secrets "$id"
      verify_lifecycle_gates "$id"
      if section_key_present "$dir" completion_report required; then
        ks=$(section_value "$dir" execution knowledge_state)
        case "$ks" in KNOWLEDGE_DONE|not_applicable) ;; *) fail "DONE blocked: knowledge transaction not recorded complete (see 'agent.sh knowledge-done')" ;; esac
        verify_completion_report "$id"
      fi ;;
  esac
  set_run_value "$id" handoff state "$phase"
  for hd_a in $hd_approvals; do consume_approval "$id" "$hd_a"; done
  if [ "$phase" = CODE_DONE ]; then set_run_value "$id" execution state CODE_DONE; fi
  if gates_enforced "$id"; then
    ledger_append "$id" "handoff:$phase" "$current" "$phase" "$hd_detail"
    case "$phase" in IMPLEMENTED|CODE_DONE) tier_record "$id" >/dev/null ;; esac
  fi
  [ "$phase" != DONE ] || [ "$current" = DONE ] || metrics_run "$id" "done"
  echo "handoff recorded: $id $phase${hd_detail:+ ($hd_detail)}"
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
delivery_check() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  [ "$(run_state "$dir")" = CODE_DONE ] || fail "delivery blocked: CODE_DONE required"
  branch=$(git -C "$root" branch --show-current); [ -n "$branch" ] || fail "delivery blocked: detached HEAD"
  enforce_task_branch "$id"
  verify_freshness "$id"
  verify_scope "$id" 1
  verify_knowledge_scope "$id"
  scan_knowledge_secrets "$id"
  verify_handoff "$id" 1
  patch=$(task_patch_fingerprint "$id"); [ "$(section_value "$dir" handoff implemented_patch_sha256)" = "$patch" ] || fail "delivery blocked: implementation stale or missing"
  [ "$(section_value "$dir" handoff code_done_patch_sha256)" = "$patch" ] || fail "delivery blocked: CODE_DONE handoff stale or missing"
  printf 'delivery_branch=%s\ndelivery_ready=true\n' "$branch"
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
evidence_field() { awk -v k="$2" 'index($0, k ":") == 1 { v = substr($0, length(k) + 2); sub(/^ */, "", v); gsub(/"/, "", v); print v; exit }' "$1"; }
evidence_targets() { sed -n 's/^target: *//p' "$1" | head -1 | tr ',' '\n'; }
evidence_covers_path() { evidence_targets "$1" | grep -Fxq -- "$2"; }
record_worker_evidence() {
  id=$1 phase=$2 result=$3; require_run "$id"; dir=$(run_dir "$id"); require_open_run "$id"
  topology=$(resolve_topology "$dir")
  expected_role=$(expected_implementation_owner "$topology")
  [ "$execution_role" = "$expected_role" ] || fail "command requires AGENT_ROLE=$expected_role for this run's execution topology ($topology)"
  case "$phase" in RED|GREEN|REFACTOR|FIX) ;; *) fail "invalid worker-evidence phase: $phase" ;; esac
  case "$result" in pass|fail) ;; *) fail "invalid worker-evidence result: $result (want pass|fail)" ;; esac
  [ "$(section_value "$dir" handoff state)" = IMPLEMENTING ] || fail "worker evidence may only be recorded while handoff state is IMPLEMENTING"
  verify_freeze "$id"; enforce_task_branch "$id"; verify_seal "$id"
  scratch=$(mktemp "${TMPDIR:-/tmp}/agent-worker-evidence.XXXXXX"); cat > "$scratch"
  command_text=$(sed -n 's/^command: *//p' "$scratch" | head -1)
  target_text=$(sed -n 's/^target: *//p' "$scratch" | head -1)
  expected_failure=$(sed -n 's/^expected_failure: *//p' "$scratch" | head -1)
  rm -f "$scratch"
  [ -n "$command_text" ] || fail "worker evidence requires a non-empty command"
  [ -n "$target_text" ] || fail "worker evidence requires a non-empty target (comma-separated scope paths)"
  mappings=$(scope_mappings "$dir/PLAN.md") || fail "invalid scope mapping"
  for we_p in $(printf '%s' "$target_text" | tr ',' ' '); do authorized_path "$mappings" "$we_p" || fail "worker evidence rejected: target outside frozen scope: $we_p"; done
  if [ "$phase" = RED ]; then
    [ "$result" = fail ] || fail "RED evidence must record result: fail"
    reject_generic_justification "$expected_failure" || fail "RED evidence requires a specific, non-generic expected_failure (>=20 chars, not a stock phrase)"
  else
    [ "$result" = pass ] || fail "$phase evidence must record result: pass"
  fi
  evdir=$(worker_evidence_dir "$id")
  mkdir -p "$evdir" 2>/dev/null || fail "worker evidence directory could not be created (sandbox denied write?): $evdir"
  seq=$(next_evidence_seq "$evdir" "$phase"); out="$evdir/$phase-$seq.yaml"
  {
    printf 'task_id: "%s"\nphase: "%s"\nresult: "%s"\nrole: "%s"\ntopology: "%s"\n' "$id" "$phase" "$result" "$execution_role" "$topology"
    printf 'command: %s\ntarget: %s\n' "$command_text" "$target_text"
    if [ "$phase" = RED ]; then printf 'expected_failure: %s\n' "$expected_failure"; fi
    printf 'base_sha: "%s"\n' "$(git -C "$root" rev-parse HEAD)"
    printf 'task_sha256: "%s"\nevidence_sha256: "%s"\nplan_sha256: "%s"\n' "$(section_value "$dir" freeze task_sha256)" "$(section_value "$dir" freeze evidence_sha256)" "$(section_value "$dir" freeze plan_sha256)"
    if [ -n "${CODEX_SESSION_ID:-}" ]; then printf 'codex_session_id: "%s"\n' "$CODEX_SESSION_ID"; fi
    printf 'timestamp: "%s"\n' "$(now_iso)"
  } > "$out" 2>/dev/null || { rm -f "$out" 2>/dev/null || true; fail "failed to write worker evidence file (sandbox denied write?): $out"; }
  [ -s "$out" ] || { rm -f "$out"; fail "worker evidence file was not actually written (empty or missing after redirect): $out"; }
  grep -q '^task_id: ' "$out" || { rm -f "$out"; fail "worker evidence file is malformed (missing task_id): $out"; }
  echo "worker evidence recorded: $id $phase-$seq ($result)"
}
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
validate_tdd_exemptions() {
  mappings=$(scope_mappings "$1/PLAN.md") || fail "invalid scope mapping"
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
field_from() { sed -n "s/^$2: *//p" "$1" | head -1; }

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
gate_names() {
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
next_gate_seq() {
  n=0
  for f in $(gate_names_all "$1"); do s=$(printf '%s' "$f" | cut -c1-3 | sed 's/^0*//'); if [ "${s:-0}" -gt "$n" ]; then n=$s; fi; done
  printf '%d\n' $((n + 1))
}
last_reopen_seq() {
  n=0
  for f in $(gate_names "$1"); do case "$f" in *-REOPEN.yaml) n=$(gate_field "$(gates_dir "$1")/$f" seq) ;; esac; done
  printf '%s\n' "$n"
}
patch_manifest() { task_owned_paths "$1" | while IFS= read -r p; do if [ -n "$p" ]; then printf '%s|%s\n' "$p" "$(fingerprint_path "$p")"; fi; done; }
gate_bound_to_contract() {
  g_bd=$(run_dir "$1")
  for g_bk in task evidence plan qa_plan; do [ "$(gate_field "$2" "${g_bk}_sha256")" = "$(section_value "$g_bd" freeze "${g_bk}_sha256")" ] || return 1; done
}
# Structural validity: task, frozen contract, policy and pipeline, manifest, author role and the bound artifact.
valid_gate_file() {
  g_id=$1 g_f=$2 g_d=$(run_dir "$1")
  [ "$(gate_field "$g_f" task_id)" = "$g_id" ] || return 1
  gate_bound_to_contract "$g_id" "$g_f" || return 1
  [ "$(gate_field "$g_f" policy_sha256)" = "$(section_value "$g_d" freeze policy_sha256)" ] || return 1
  [ "$(gate_field "$g_f" pipeline)" = "$(section_value "$g_d" freeze pipeline)" ] || return 1
  g_m=${g_f%.yaml}.manifest; [ -f "$g_m" ] || return 1
  [ "$(gate_field "$g_f" manifest_sha256)" = "$(hash_file "$g_m")" ] || return 1
  [ "$(gate_field "$g_f" role)" = "$(gate_owner "$(gate_field "$g_f" gate)")" ] || return 1
  g_art=$(gate_field "$g_f" artifact)
  if [ -n "$g_art" ]; then [ -f "$g_d/$g_art" ] && [ "$(gate_field "$g_f" artifact_sha256)" = "$(hash_file "$g_d/$g_art")" ] || return 1; fi
  return 0
}
finding_ids() { sed -n 's/^finding: \([^|]*\)|.*/\1/p' "$1"; }
# A waiver counts only when `waive` wrote it (ledger-bound) for exactly this gate record (name and sha256)
# and finding; SECRETS and SECURITY findings are never waived, whatever the waiver files say.
finding_waived() { # ID GATE-RECORD-FILE FINDING-ID
  fw_d=$(run_dir "$1"); fw_g=$(basename "$2")
  case "$(gate_field "$2" gate)" in SECRETS|SECURITY) return 1 ;; esac
  fw_all=$(ls -1 "$fw_d/waivers" 2>/dev/null | grep -E '^[0-9]{3}-.*\.yaml$' || true); [ -n "$fw_all" ] || return 1
  fw_rs=$(hash_file "$2")
  # shellcheck disable=SC2086
  for fw_n in $(bound_names "$fw_d" waivers 'waive$' $fw_all); do
    fw_f=$fw_d/waivers/$fw_n
    [ "$(gate_field "$fw_f" gate_record)" = "$fw_g" ] && [ "$(gate_field "$fw_f" gate_record_sha256)" = "$fw_rs" ] && [ "$(gate_field "$fw_f" finding)" = "$3" ] && return 0
  done
  return 1
}
fail_fully_waived() { # ID GATE-RECORD-FILE
  fwf_any=no
  for fwf_x in $(blocking_finding_ids "$2"); do fwf_any=yes; finding_waived "$1" "$2" "$fwf_x" || return 1; done
  [ "$fwf_any" = yes ]
}
blocking_finding_ids() { sed -n 's/^finding: \([^|]*\)|\([a-z]*\)|.*/\1 \2/p' "$1" | awk '$2 != "info" { print $1 }'; }
# gate_status ID GATE [strict|patch] [NOW]: pass | pass_low | waived | fail | stale | missing.
# strict binds the content fingerprint (any byte); patch binds the task-owned patch (after CODE_DONE,
# when knowledge and report bookkeeping legitimately change the tree).
# A gate is the worst status over its own focus and every risk focus it carries for the run (A78), so a gate
# is never satisfied while a required focus result is missing, stale, failing or UNSUPPORTED.
gate_status() {
  gs_id=$1 gs_gate=$2 gs_mode=${3:-strict} gs_now=${4:-}
  if [ "$gs_mode" = strict ]; then [ -n "$gs_now" ] || gs_now=$(content_fingerprint)
  else [ -n "$gs_now" ] || gs_now=$(task_patch_fingerprint "$gs_id"); fi
  gs_worst=pass
  for gs_fc in - $(risk_gate_focuses "$gs_id" "$gs_gate"); do
    gs_s=$(gate_focus_status "$gs_id" "$gs_gate" "$gs_fc" "$gs_mode" "$gs_now")
    if [ "$(status_rank "$gs_s")" -gt "$(status_rank "$gs_worst")" ]; then gs_worst=$gs_s; fi
  done
  printf '%s\n' "$gs_worst"
}
status_rank() { case "$1" in pass) echo 0 ;; waived) echo 1 ;; pass_low) echo 2 ;; missing) echo 3 ;; stale) echo 4 ;; *) echo 5 ;; esac; }
# gate_focus_status ID GATE FOCUS MODE NOW: the latest record of that gate and focus ('-' = the gate's own focus).
gate_focus_status() {
  gfs_id=$1 gfs_gate=$2; gfs_key=fingerprint; [ "$4" = strict ] || gfs_key=patch_sha256
  gfs_last=$(gate_latest_file "$gfs_id" "$gfs_gate" "$3")
  [ -n "$gfs_last" ] || { echo missing; return 0; }
  if [ "$(gate_field "$gfs_last" "$gfs_key")" != "$5" ] || ! valid_gate_file "$gfs_id" "$gfs_last"; then echo stale; return 0; fi
  case "$(gate_field "$gfs_last" result)" in
    pass) echo pass ;; pass_low) echo pass_low ;;
    fail) if fail_fully_waived "$gfs_id" "$gfs_last"; then echo waived; else echo fail; fi ;;
    *) echo stale ;;
  esac
}
gate_satisfied() { case "$1" in pass|waived) return 0 ;; *) return 1 ;; esac; }
verify_required_gates() { # ID strict|patch MESSAGE
  vrg_now=''; [ "$2" != strict ] || vrg_now=$(content_fingerprint); risk_prime "$1"
  for vrg_g in $(required_gates "$1"); do
    vrg_s=$(gate_status "$1" "$vrg_g" "$2" "$vrg_now")
    gate_satisfied "$vrg_s" || fail "$3: required gate $vrg_g of $1 is $vrg_s for the current content (see 'agent.sh pipeline $1')"
  done
}
# Fix rounds (D15): one round per distinct content that collected an unwaived blocking FAIL
# under the current frozen contract since the last reopen.
fix_rounds_used() {
  fr_reopen=$(last_reopen_seq "$1")
  for fr_n in $(gate_names "$1"); do
    fr_f=$(gates_dir "$1")/$fr_n
    [ "$(gate_field "$fr_f" result)" = fail ] || continue
    [ "$(gate_field "$fr_f" seq)" -gt "$fr_reopen" ] || continue
    gate_bound_to_contract "$1" "$fr_f" || continue
    fail_fully_waived "$1" "$fr_f" && continue
    gate_field "$fr_f" fingerprint
  done | sort -u | wc -l | tr -d ' '
}
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
# A fix stays inside the union fix_scope of every failing record on the failing content.
verify_fix_bound() {
  g_id=$1; gates_enforced "$g_id" || return 0
  g_f=$(latest_finding_file "$g_id"); [ -n "$g_f" ] || return 0
  g_patch=$(task_patch_fingerprint "$g_id")
  [ "$g_patch" != "$(gate_field "$g_f" patch_sha256)" ] || fail "no application/test change since the finding in ${g_f##*/}: a fix must change the tree before it can be re-reviewed"
  g_scope=$(gate_field "$g_f" fix_scope)
  if [ "$(gate_field "$g_f" result)" = fail ]; then
    g_fp=$(gate_field "$g_f" fingerprint)
    for g_n in $(gate_names "$g_id"); do
      g_o=$(gates_dir "$g_id")/$g_n
      [ "$(gate_field "$g_o" result)" = fail ] && [ "$(gate_field "$g_o" fingerprint)" = "$g_fp" ] && g_scope="$g_scope,$(gate_field "$g_o" fix_scope)"
    done
  fi
  [ "$(scope_entry_paths "$g_scope" | tr -d '\n')" != '*' ] || return 0
  g_delta=$( { cat "${g_f%.yaml}.manifest"; patch_manifest "$g_id"; } | sed '/^$/d' | sort | uniq -u | cut -d '|' -f1 | sort -u )
  g_bad=''
  for g_p in $g_delta; do
    scope_entry_paths "$g_scope" | grep -Fxq -- "$g_p" && continue
    # A fix needs its regression test (tdd): a test path of the frozen scope is always inside the fix.
    if printf '%s\n' "$(section_value "$(run_dir "$g_id")" freeze scope_paths)" | tr ',' '\n' | grep -Fxq -- "$g_p" \
       && path_matches "$g_p" '**/test/** **/tests/** **/__tests__/** **/spec/** *_test.* *.test.* *.spec.* test_*.* *Test.* *Tests.*'; then continue; fi
    g_bad="$g_bad $g_p"
  done
  [ -z "$g_bad" ] || fail "fix changed paths outside the finding's fix_scope (${g_f##*/}):$g_bad"
}
reopen_for_fix() {
  g_id=$1; g_any=no
  for g_g in $(required_gates "$g_id"); do [ "$(gate_status "$g_id" "$g_g")" != fail ] || g_any=yes; done
  [ "$g_any" = yes ] || fail "no open gate finding on the current content: nothing to fix, and a run does not return to IMPLEMENTING without one"
  g_used=$(fix_rounds_used "$g_id"); g_max=$(max_fix_rounds)
  [ "$g_used" -le "$g_max" ] || fail "fix rounds exhausted ($g_used failing rounds, max_fix_rounds $g_max): end the run with 'agent.sh terminate $g_id FAILED' (a refreeze with a new budget needs the user's 'budget' approval)"
  set_run_value "$g_id" handoff implemented_patch_sha256 PENDING
  set_run_value "$g_id" handoff code_done_patch_sha256 PENDING
}
# K-6: a refreeze that changes PLAN.md of a destructive plan while the run is IMPLEMENTING or IMPLEMENTED sends
# the run back to PLANNED, so the one gate (PLANNED -> IMPLEMENTING, implement_approvals) asks again for the
# destructive (and single_step) approval bound to the new hash. Nothing else changes: the fix budget and the
# worker evidence follow the existing refreeze rules (evidence bound to the old plan hash no longer counts).
refreeze_lifecycle() {
  g_id=$1 g_amend=$2 g_oldplan=${3:-}; g_d=$(run_dir "$g_id"); g_hs=$(section_value "$g_d" handoff state); g_to=$g_hs
  case "$g_hs" in
    IMPLEMENTED)
      set_run_value "$g_id" handoff state IMPLEMENTING
      set_run_value "$g_id" handoff implemented_patch_sha256 PENDING
      set_run_value "$g_id" handoff code_done_patch_sha256 PENDING
      g_to=IMPLEMENTING ;;
  esac
  case "$g_to" in
    IMPLEMENTING)
      if [ "$(plan_destructive "$g_d/PLAN.md")" = yes ] && [ "$g_oldplan" != "$(section_value "$g_d" freeze plan_sha256)" ]; then
        set_run_value "$g_id" handoff state PLANNED
        set_run_value "$g_id" handoff implemented_patch_sha256 PENDING
        set_run_value "$g_id" handoff code_done_patch_sha256 PENDING
        g_to=PLANNED
      fi ;;
  esac
  ledger_append "$g_id" refreeze "$g_hs" "$g_to" "amendment $g_amend"
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
    case "$(canon_role "$(evidence_field "$g_ev/$g_w" role)")" in implementer|designer) ;; *) fail "worker window ${g_w%.yaml} was not attested for the implementer or designer" ;; esac
    [ "$(evidence_field "$g_ev/$g_w" before_sha256)" = "$g_prev_after" ] || fail "unattributed application/test mutation before ${g_w%.yaml}: the tree changed between worker windows outside the implementer"
    g_prev_after=$(evidence_field "$g_ev/$g_w" after_sha256)
  done
  g_tree=$(task_patch_fingerprint "$g_id")
  [ "$g_tree" = "$g_prev_after" ] || fail "application/test tree ($g_tree) is not the last implementer-attested tree ($g_prev_after): a mutation was made outside the implementer under orchestrated topology; undo it and route the change through the implementer (dispatch.sh)"
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

# --- Gate recording (shared by record, gate and secret-scan) ------------------------------
gate_preconditions() { # ID GATE
  gp_id=$1 gp_gate=$2; gp_d=$(run_dir "$1")
  gates_enforced "$gp_id" || fail "run $gp_id has no lifecycle_gates policy: gates are not recorded for it"
  require_open_run "$gp_id"
  gp_req=$(required_gates "$gp_id")
  printf '%s\n' "$gp_req" | grep -Fxq "$gp_gate" || fail "$gp_gate is not a required gate of $gp_id (required: $(printf '%s' "$gp_req" | tr '\n' ' '))"
  enforce_task_branch "$gp_id"; verify_freshness "$gp_id" >/dev/null; verify_seal "$gp_id"
  [ "$(section_value "$gp_d" handoff state)" = IMPLEMENTED ] || fail "$gp_gate gate may only be recorded while handoff state is IMPLEMENTED"
  verify_scope "$gp_id" 0 >/dev/null
  [ "$(section_value "$gp_d" handoff implemented_patch_sha256)" = "$(task_patch_fingerprint "$gp_id")" ] || fail "$gp_gate gate blocked: the application tree changed since IMPLEMENTED"
  verify_mutation_ownership "$gp_id"
}
# write_gate ID GATE RESULT ROLE CONFIDENCE FOCUS ARTIFACT FINDINGS-FILE RESULT-FILE FINGERPRINT
# FINDINGS-FILE holds rows "id|severity|path:line|finding|evidence".
write_gate() {
  wg_id=$1 wg_gate=$2 wg_res=$3 wg_role=$4 wg_conf=$5 wg_focus=$6 wg_art=$7 wg_findings=$8 wg_rfile=$9; shift 9; wg_fp=$1
  wg_d=$(run_dir "$wg_id"); wg_gd=$(gates_dir "$wg_id"); mkdir -p "$wg_gd" || fail "cannot create $wg_gd"
  wg_seq=$(next_gate_seq "$wg_id"); [ "$wg_seq" -le 999 ] || fail "gate record limit reached"
  wg_name=$(printf '%03d-%s' "$wg_seq" "$wg_gate")
  wg_scope=''
  if [ "$wg_res" = fail ]; then
    wg_scope=$(awk -F'|' '$2 != "info" { p = $3; gsub(/^[[:space:]]+|[[:space:]]+$/, "", p); if (p == "" || p == "-") p = "*"; else { sub(/:.*$/, "", p); gsub(/^[[:space:]]+|[[:space:]]+$/, "", p); if (p == "") next }; print p }' "$wg_findings" | sort -u | tr '\n' ',' | sed 's/,$//')
  fi
  patch_manifest "$wg_id" > "$wg_gd/$wg_name.manifest" || fail "could not write gate manifest"
  {
    printf 'task_id: "%s"\nseq: %s\ngate: "%s"\nresult: "%s"\nrole: "%s"\nconfidence: "%s"\nfocus: "%s"\n' "$wg_id" "$wg_seq" "$wg_gate" "$wg_res" "$wg_role" "$wg_conf" "$wg_focus"
    printf 'topology: "%s"\ntier: "%s"\n' "$(resolve_topology "$wg_d")" "$(tier_effective "$wg_id")"
    printf 'fingerprint: "%s"\npatch_sha256: "%s"\nmanifest_sha256: "%s"\n' "$wg_fp" "$(task_patch_fingerprint "$wg_id")" "$(hash_file "$wg_gd/$wg_name.manifest")"
    if [ -n "$wg_art" ]; then printf 'artifact: "%s"\nartifact_sha256: "%s"\n' "$wg_art" "$(hash_file "$wg_d/$wg_art")"; fi
    printf 'task_sha256: "%s"\nevidence_sha256: "%s"\nplan_sha256: "%s"\nqa_plan_sha256: "%s"\n' "$(section_value "$wg_d" freeze task_sha256)" "$(section_value "$wg_d" freeze evidence_sha256)" "$(section_value "$wg_d" freeze plan_sha256)" "$(section_value "$wg_d" freeze qa_plan_sha256)"
    printf 'policy_sha256: "%s"\npipeline: "%s"\n' "$(section_value "$wg_d" freeze policy_sha256)" "$(section_value "$wg_d" freeze pipeline)"
    [ -z "$wg_rfile" ] || printf 'result_file: "%s"\nresult_sha256: "%s"\n' "$wg_rfile" "$(hash_file "$wg_d/$wg_rfile")"
    [ "$wg_res" != fail ] || printf 'fix_scope: %s\n' "$wg_scope"
    [ ! -s "$wg_findings" ] || sed 's/^/finding: /' "$wg_findings"
    printf 'timestamp: "%s"\nepoch: %s\n' "$(now_iso)" "$(now_epoch)"
  } > "$wg_gd/$wg_name.yaml" || fail "could not write gate record"
  [ -s "$wg_gd/$wg_name.yaml" ] || { rm -f "$wg_gd/$wg_name.yaml" "$wg_gd/$wg_name.manifest"; fail "gate record was not written"; }
  ledger_append "$wg_id" "gate:$wg_gate:$wg_res" IMPLEMENTED IMPLEMENTED "$(ledger_token "gates/$wg_name.yaml" "$wg_id") by $wg_role"
  echo "gate recorded: $wg_id $wg_name ($wg_res)"
}

# --- Result protocol (D12): `record` is the only way a verdict enters a run. -----------
# Parses "KEY=value" lines of the leading header block; exit 1 on a malformed header.
parse_header() {
  awk '
    BEGIN { started = 0; done = 0 }
    !started && /^[[:space:]]*$/ { next }
    { started = 1 }
    done { next }
    /^[A-Z_]+:/ {
      k = $0; sub(/:.*/, "", k); v = $0; sub(/^[A-Z_]+:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v)
      if (k !~ /^(ROLE|TASK|FOCUS|RESULT|CONFIDENCE|FINGERPRINT|ARTIFACT)$/) { bad = 1; exit }
      if (k in seen) { bad = 1; exit }
      seen[k] = 1; print k "=" v; next
    }
    { done = 1 }
    END { exit bad }' "$1"
}
hdr() { sed -n "s/^$1=//p" "$2" | head -1; }
# Findings table rows (header and separator rows skipped) as "id|severity|path:line|finding|evidence".
parse_findings() {
  awk -F'|' '
    function t(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    /^\|/ {
      if ($0 ~ /^\|[-:| ]+\|?[[:space:]]*$/) next
      id = t($2); if (id == "id" || id == "") next
      low = tolower(id); if (low == "(none)" || low == "none" || low == "-" || low == "n/a") { print "NO_FINDINGS_PLACEHOLDER"; next }
      if (NF < 7) { print "MALFORMED"; next }
      print id "|" t($3) "|" t($4) "|" t($5) "|" t($6)
    }' "$1"
}
results_dir() { printf '%s/results\n' "$(run_dir "$1")"; }
next_num() { # DIR -> next NNN over files whose name starts with three digits
  nn_max=0
  for nn_f in "$1"/[0-9][0-9][0-9]*; do
    [ -e "$nn_f" ] || continue
    nn_v=$(basename "$nn_f" | cut -c1-3 | sed 's/^0*//'); nn_v=${nn_v:-0}
    [ "$nn_v" -le "$nn_max" ] || nn_max=$nn_v
  done
  printf '%03d\n' $((nn_max + 1))
}
record_result() {
  rr_id=$1 rr_src=${2:-}; require_run "$rr_id"
  rr_tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-record.XXXXXX")
  if [ -n "$rr_src" ]; then [ -f "$rr_src" ] || { rm -rf "$rr_tmp"; fail "result file not found: $rr_src"; }; cat "$rr_src" > "$rr_tmp/raw"; else cat > "$rr_tmp/raw"; fi
  # Plain statements on purpose: inside an `if` or `||`, `set -e` would not stop the nested checks.
  record_tmp=$rr_tmp
  record_validate "$rr_id" "$rr_tmp"
  record_apply "$rr_id" "$rr_tmp"
}
record_reject() { echo "record rejected: $*" >&2; return 1; }
# Where each role (and reviewer focus) reports, so one focus can never stand in for another. A token ending
# in / is a run-relative directory prefix, any other token an exact run-relative file.
artifact_paths() { # ROLE KIND FOCUS
  case "$1:$2:$3" in
    reviewer:*:plan) echo reviews/proof-review/plan/ ;; reviewer:*:rules) echo reviews/proof-review/rules/ ;;
    reviewer:*:rules+tests) echo reviews/proof-review/small/ ;; reviewer:*:tests) echo reviews/test-trust/tests/ ;;
    reviewer:*:data) echo reviews/data-design/ ;;
    reviewer:*:contract|reviewer:*:concurrency|reviewer:*:performance|reviewer:*:config|reviewer:*:migration) risk_focus_report "$3" ;;
    reviewer:*) echo reviews/proof-review/ ;;
    security_reviewer:*) echo security/ ;;
    qa:gate:visual) echo reviews/visual-proof/ ;; qa:gate:*) echo QA_REPORT.md ;; qa:*) echo 'QA_PLAN.md reports/ reviews/test-trust/qa/' ;;
    verifier:*) echo 'VERIFY.md design/SYNC.md' ;;
    implementer:*) echo 'reports/ worker-evidence/' ;;
    task_author:*) echo 'TASK.md design/INTENT.md reports/' ;;
    explorer:*) echo reports/ ;;
    architect:*|data_architect:*|designer:*) echo 'design/ reports/' ;;
    *) echo 'reports/ TASK.md PLAN.md EVIDENCE.md' ;;
  esac
}
artifact_allowed() { # ROLE KIND FOCUS PATH
  case "$4" in reports/snapshots/*) return 0 ;; esac   # immutable copies made by `submit` (A43)
  for aa_t in $(artifact_paths "$1" "$2" "$3"); do
    case "$aa_t" in */) case "$4" in "$aa_t"*) return 0 ;; esac ;; *) [ "$4" != "$aa_t" ] || return 0 ;; esac
  done
  return 1
}
record_validate() {
  rv_id=$1 rv_t=$2; rv_d=$(run_dir "$1")
  risk_prime "$rv_id"
  parse_header "$rv_t/raw" > "$rv_t/hdr" || { record_reject "malformed header (expected ROLE/TASK/[FOCUS]/RESULT/CONFIDENCE/FINGERPRINT/ARTIFACT lines first)"; return 1; }
  for rv_k in ROLE TASK RESULT CONFIDENCE FINGERPRINT ARTIFACT; do [ -n "$(hdr "$rv_k" "$rv_t/hdr")" ] || { record_reject "malformed header: missing $rv_k"; return 1; }; done
  rv_role=$(canon_role "$(hdr ROLE "$rv_t/hdr")"); rv_res=$(hdr RESULT "$rv_t/hdr"); rv_focus=$(hdr FOCUS "$rv_t/hdr"); rv_conf=$(hdr CONFIDENCE "$rv_t/hdr")
  valid_role "$rv_role" || { record_reject "unknown ROLE: $rv_role"; return 1; }
  [ "$rv_role" = "$execution_role" ] || { record_reject "ROLE $rv_role does not match AGENT_ROLE $execution_role"; return 1; }
  [ "$(hdr TASK "$rv_t/hdr")" = "$rv_id" ] || { record_reject "TASK $(hdr TASK "$rv_t/hdr") does not match $rv_id"; return 1; }
  case "$rv_conf" in high|medium|low) ;; *) record_reject "invalid CONFIDENCE: $rv_conf"; return 1 ;; esac
  # The RESULT value set decides gate result versus task result, validated against the role.
  rv_kind=''
  # A78: FOCUS names the gate's own focus or a risk focus of this role; UNSUPPORTED is a risk-focus gate result.
  if [ -n "$rv_focus" ] && [ "$rv_role" != reviewer ]; then
    [ "$(risk_focus_role "$rv_focus" 2>/dev/null)" = "$rv_role" ] || { record_reject "FOCUS $rv_focus is not a focus of role $rv_role"; return 1; }
  fi
  case "$rv_res" in
    UNSUPPORTED) if is_gate_role "$rv_role" && risk_focus_role "$rv_focus" >/dev/null 2>&1; then rv_kind=gate; else record_reject "UNSUPPORTED is a result of a risk focus only (contract, concurrency, performance, config, migration, visual)"; return 1; fi
      [ "$rv_focus" != dependencies ] || { record_reject "the dependencies focus always has a tool-free check (the manifest diff against PLAN ## Dependencies); UNSUPPORTED is not available"; return 1; }
      grep -q '^UNSUPPORTED_REASON:[[:space:]]*[^[:space:]]' "$rv_t/raw" || { record_reject "UNSUPPORTED needs an UNSUPPORTED_REASON line (the tool or skill that is missing)"; return 1; } ;;
    PASS|FAIL) is_gate_role "$rv_role" && rv_kind=gate ;;
    BLOCKED) if is_gate_role "$rv_role" && [ "$rv_role" != qa ]; then rv_kind=gate; else rv_kind=task; fi ;;
    DONE|NEEDS_INPUT) case "$rv_role" in reviewer|security_reviewer|verifier) ;; *) rv_kind=task ;; esac ;;
  esac
  # A92: a task result (DONE, NEEDS_INPUT, BLOCKED) has no focus: a risk FOCUS must not open a second C-14 round.
  if [ "$rv_kind" = task ]; then rv_focus=''; fi
  if [ "$rv_role" = lead ] && [ "$rv_kind" != task ]; then record_reject "the lead can never record a $rv_res verdict"; return 1; fi
  [ -n "$rv_kind" ] || { record_reject "RESULT $rv_res is not valid for role $rv_role"; return 1; }
  rv_gate=''
  if [ "$rv_kind" = gate ]; then
    if [ "$rv_role" = reviewer ]; then case "$rv_focus" in plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration) ;; *) record_reject "reviewer results need FOCUS plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration"; return 1 ;; esac; fi
    rv_gate=$(gate_of "$rv_role" "$rv_focus" "$rv_id")
    if risk_focus_role "$rv_focus" >/dev/null 2>&1; then
      risk_gate_focuses "$rv_id" "$rv_gate" | grep -Fxq -- "$rv_focus" || { record_reject "focus $rv_focus is not required on $rv_gate of $rv_id: no risk signal triggers it (see 'agent.sh pipeline $rv_id')"; return 1; }
    fi
  fi
  rv_fp=$(hdr FINGERPRINT "$rv_t/hdr"); rv_now=$(content_fingerprint)
  [ "$rv_fp" = "$rv_now" ] || { record_reject "stale: FINGERPRINT $rv_fp is not the current content fingerprint $rv_now"; return 1; }
  rv_art=$(hdr ARTIFACT "$rv_t/hdr"); rv_ap=${rv_art% *}; rv_as=${rv_art##* }
  [ "$rv_ap" != "$rv_art" ] || { record_reject "ARTIFACT needs '<run-relative path> <sha256>'"; return 1; }
  case "$rv_ap" in
    /*) rv_candidate=$rv_ap ;;
    .agents/runs/"$rv_id"/*) rv_candidate=$root/$rv_ap ;;
    ''|*..*) record_reject "ARTIFACT path must be run-relative: $rv_ap"; return 1 ;;
    *) rv_candidate=$rv_d/$rv_ap ;;
  esac
  rv_real=$(realpath "$rv_candidate" 2>/dev/null) || { record_reject "ARTIFACT not found in the run: $rv_ap"; return 1; }
  rv_run=$(realpath "$rv_d")
  case "$rv_real" in "$rv_run"/*) rv_ap=${rv_real#"$rv_run"/} ;; *) record_reject "ARTIFACT path must be inside the run: $rv_ap"; return 1 ;; esac
  [ -f "$rv_d/$rv_ap" ] && [ ! -L "$rv_d/$rv_ap" ] || { record_reject "ARTIFACT not found in the run: $rv_ap"; return 1; }
  known_control_artifact "$rv_id" ".agents/runs/$rv_id/$rv_ap" || { record_reject "ARTIFACT is not a registered run artifact: $rv_ap"; return 1; }
  artifact_allowed "$rv_role" "$rv_kind" "$rv_focus" "$rv_ap" || { record_reject "ARTIFACT $rv_ap is outside the paths $rv_role${rv_focus:+ (FOCUS $rv_focus)} reports in: $(artifact_paths "$rv_role" "$rv_kind" "$rv_focus")"; return 1; }
  [ "$(hash_file "$rv_d/$rv_ap")" = "$rv_as" ] || { record_reject "ARTIFACT sha256 mismatch for $rv_ap"; return 1; }
  # One round (C-14), keyed by role (+focus) per run, deliberately not per instance: a later instance of the role (a second explorer, a redispatched architect) decides or returns BLOCKED.
  # Exemption (A75): intent-grill's interview is multi-round; its rounds neither count nor are limited (and are not capped:
  # shortcut: unlimited rounds, the user's replies are the bound). Only the task author, and its artifact is design/INTENT.md
  # or the immutable snapshot `submit` made of it (reports/snapshots/<sha12>-task_author-design_INTENT.md), whose `## Status` is in-progress; other design/ roles never.
  # Residual: the task author writes that file and its status itself, so this is a trust convention checked by shape, not proof of an interview.
  rv_grill=no
  if [ "$rv_role" = task_author ]; then
    case "$rv_ap" in design/INTENT.md|reports/snapshots/*-task_author-design_INTENT.md)
      # the file itself must be an interview in progress (the snapshot is a copy of it): first line under `## Status` is in-progress
      [ "$(awk '/^## Status[[:space:]]*$/ { s=1; next } s && NF { gsub(/[[:space:]]/, ""); print; exit }' "$rv_d/$rv_ap")" = in-progress ] && rv_grill=yes ;;
    esac
  fi
  if [ "$rv_res" = NEEDS_INPUT ] && [ "$rv_grill" != yes ]; then
    for rv_qf in "$rv_d"/questions/[0-9][0-9][0-9].md; do
      [ -f "$rv_qf" ] || continue
      [ "$(gate_field "$rv_qf" from)" = "$rv_role" ] && [ "$(gate_field "$rv_qf" focus)" = "$rv_focus" ] || continue
      [ "$(gate_field "$rv_qf" grill)" != yes ] || continue
      record_reject "the $rv_role role already asked its questions in this run (questions/${rv_qf##*/}); a later instance of the role decides with its recommended option and says so, or returns BLOCKED with the reason"; return 1
    done
  fi
  parse_findings "$rv_t/raw" > "$rv_t/findings"
  ! grep -qx MALFORMED "$rv_t/findings" || { record_reject "malformed findings row (want | id | severity | path:line | finding | evidence |)"; return 1; }
  ! grep -qx NO_FINDINGS_PLACEHOLDER "$rv_t/findings" || { record_reject "no findings: omit rows, keep only the table header"; return 1; }
  rv_prefix=$rv_role; [ -z "$rv_gate" ] || rv_prefix=$rv_gate
  rv_badrow=$(awk -F'|' -v p="$rv_prefix" '{ if ($1 !~ ("^" p "-[0-9]+$")) { print "id " $1 " (want " p "-<n>)"; exit } if ($2 !~ /^(blocking|info)$/) { print "severity " $2; exit } }' "$rv_t/findings")
  [ -z "$rv_badrow" ] || { record_reject "invalid finding $rv_badrow"; return 1; }
  [ "$(cut -d'|' -f1 "$rv_t/findings" | sort | uniq -d)" = '' ] || { record_reject "duplicate finding ids"; return 1; }
  rv_blocking=$(awk -F'|' '$2 != "info"' "$rv_t/findings" | wc -l | tr -d ' ')
  if [ "$rv_res" = FAIL ] && [ "$rv_blocking" = 0 ]; then record_reject "FAIL needs at least one blocking finding"; return 1; fi
  if [ "$rv_res" = PASS ] && [ "$rv_blocking" != 0 ]; then record_reject "PASS cannot carry blocking findings"; return 1; fi
  if [ "$rv_res" = UNSUPPORTED ] && [ "$rv_blocking" != 0 ]; then record_reject "UNSUPPORTED cannot carry blocking findings (a check that ran is PASS or FAIL)"; return 1; fi
  # A78: the script's own findings. UNSUPPORTED becomes one blocking row (never a PASS; the user may waive it);
  # a diff signal of this focus without its PLAN.md flag becomes one blocking row per path. Either makes it FAIL.
  rv_added=0
  if [ "$rv_kind" = gate ] && [ "$rv_res" != BLOCKED ] && risk_focus_role "$rv_focus" >/dev/null 2>&1; then
    rv_next=$(awk -F'|' '{ n = $1; sub(/.*-/, "", n); if (n + 0 > m) m = n + 0 } END { print m + 1 }' "$rv_t/findings")
    if [ "$rv_res" = UNSUPPORTED ]; then
      printf '%s-%s|blocking|-|UNSUPPORTED %s: %s|%s\n' "$rv_gate" "$rv_next" "$rv_focus" "$(sed -n 's/^UNSUPPORTED_REASON:[[:space:]]*//p' "$rv_t/raw" | head -1 | tr '|' '/')" "$rv_ap" >> "$rv_t/findings"
      rv_next=$((rv_next + 1)); rv_added=$((rv_added + 1))
    fi
    for rv_m in $(risk_missing_flags "$rv_id" "$rv_focus" | awk -F'|' '$2 == "diff" { print $1 "|" $3 "|" $4 }'); do
      rv_mn=${rv_m%%|*} rv_mfl=${rv_m##*|}; rv_mp=${rv_m#*|}; rv_mp=${rv_mp%|*}
      printf '%s-%s|blocking|%s|risk signal %s without PLAN.md flag %s: the change touches it but the plan does not declare it (A78)|agent.sh pipeline %s: %s matches risk.%s and PLAN.md has no %s yes\n' \
        "$rv_gate" "$rv_next" "$rv_mp" "$rv_mn" "$rv_mfl" "$rv_id" "$rv_mp" "$rv_mn" "$rv_mfl" >> "$rv_t/findings"
      rv_next=$((rv_next + 1)); rv_added=$((rv_added + 1))
    done
    if [ "$rv_added" -gt 0 ]; then rv_res=FAIL; fi
  fi
  if [ "$rv_res" = BLOCKED ] && ! grep -q '^BLOCKED_REASON:[[:space:]]*[^[:space:]]' "$rv_t/raw"; then record_reject "BLOCKED needs a BLOCKED_REASON line"; return 1; fi
  if [ "$rv_res" = NEEDS_INPUT ]; then
    awk '/^QUESTIONS:[[:space:]]*$/ { q=1; next } q && /^BLOCKED_REASON:/ { exit } q { print }' "$rv_t/raw" > "$rv_t/questions"
    grep -q '[^[:space:]]' "$rv_t/questions" || { record_reject "NEEDS_INPUT needs a QUESTIONS: block"; return 1; }
  fi
  if [ "$rv_kind" = gate ] && [ "$rv_res" != BLOCKED ]; then gate_preconditions "$rv_id" "$rv_gate"; fi
  printf 'role=%s\nresult=%s\nkind=%s\ngate=%s\nfocus=%s\nconfidence=%s\nartifact=%s\nfingerprint=%s\ngrill=%s\n' "$rv_role" "$rv_res" "$rv_kind" "$rv_gate" "$rv_focus" "$rv_conf" "$rv_ap" "$rv_fp" "$rv_grill" > "$rv_t/meta"
  printf 'added=%s\n' "$rv_added" >> "$rv_t/meta"
}
record_apply() {
  ra_id=$1 ra_t=$2; ra_d=$(run_dir "$1"); m() { sed -n "s/^$1=//p" "$ra_t/meta"; }
  ra_role=$(m role) ra_res=$(m result) ra_kind=$(m kind) ra_gate=$(m gate) ra_focus=$(m focus) ra_conf=$(m confidence)
  ra_rd=$(results_dir "$ra_id"); mkdir -p "$ra_rd"; ra_n=$(next_num "$ra_rd")
  # The raw final message, verbatim; skills own reports/NNN-<role>.md, so record never writes that name.
  ra_raw=results/$ra_n-$ra_role.result.md
  cp "$ra_t/raw" "$ra_d/$ra_raw"
  ra_sha=$(hash_file "$ra_d/$ra_raw")
  if [ "$ra_kind" = gate ] && [ "$ra_res" != BLOCKED ]; then
    ra_gres=fail; [ "$ra_res" != PASS ] || { if [ "$ra_conf" = low ]; then ra_gres=pass_low; else ra_gres=pass; fi; }
    write_gate "$ra_id" "$ra_gate" "$ra_gres" "$ra_role" "$ra_conf" "$ra_focus" "$(m artifact)" "$ra_t/findings" "$ra_raw" "$(m fingerprint)"
  fi
  if [ "$ra_res" = NEEDS_INPUT ]; then
    mkdir -p "$ra_d/questions"; ra_q=$(next_num "$ra_d/questions")
    { printf 'from: %s\nfocus: %s\ngrill: %s\nresult: %s\nasked_at: %s\n---\n' "$ra_role" "$ra_focus" "$(m grill)" "$ra_raw" "$(now_epoch)"; cat "$ra_t/questions"; } > "$ra_d/questions/$ra_q.md"
    if section_key_present "$ra_d" execution awaiting_input; then set_run_value "$ra_id" execution awaiting_input true; fi
  fi
  if gates_enforced "$ra_id"; then ledger_append "$ra_id" "record:$ra_role:$ra_res" - - "$ra_raw sha256=$ra_sha${ra_gate:+ gate=$ra_gate}"; fi
  metrics_step "$ra_id" "$ra_role" "$ra_focus" "$(printf '%s' "$ra_res" | tr "[:upper:]" "[:lower:]")"
  [ "$(m added)" = 0 ] || echo "risk: $(m added) script finding(s) added to $ra_gate focus $ra_focus (UNSUPPORTED or a risk signal without its PLAN.md flag, A78); the result is FAIL"
  echo "result recorded: $ra_id $ra_raw ($ra_role $ra_res)"
}
# --- Language check (A33): run artifacts are English. -----------------------------------------
# Heuristic: three or more letters outside ASCII and the common typographic symbols (UTF-8 lead bytes of
# Latin letters C3 C4 C5, Greek CE CF, Cyrillic D0-D4, CJK E3-E9) in one file are non-English text; one or
# two (a name such as "José") are tolerated. Lines inside a `>` blockquote or a fenced code block are
# exempt: the user's own words, quoted.
# language_scan FILE... -> prints "file:line" (where the third such letter appears) per offending file; exit 1.
language_scan() {
  ls_rc=0
  for ls_f in "$@"; do
    [ -f "$ls_f" ] || continue
    ls_hit=$(LC_ALL=C awk '
      /^[[:space:]]*```/ { fence = !fence; next }
      fence || /^[[:space:]]*>/ { next }
      { c = gsub(/\303[\200-\226\230-\266\270-\277]|[\304\305\316\317\320-\324]|[\343-\351][\200-\277]/, "&")
        if (c > 0) { total += c; if (total >= 3 && !at) at = NR } }
      END { if (at) print at }' "$ls_f")
    if [ -n "$ls_hit" ]; then printf '%s:%s\n' "${ls_f#"$root"/}" "$ls_hit"; ls_rc=1; fi
  done
  return "$ls_rc"
}
language_fail_text() { printf "language: run artifacts are English, but %s holds non-English text (put the user's own words in a > blockquote, write everything else in English)" "$1"; }
# verify_run_language ID: every run artifact a person or role wrote; raw runtime logs are exempt.
verify_run_language() {
  vrl_d=$(run_dir "$1"); vrl_files=$(find "$vrl_d" -type f \( -name '*.md' -o -name '*.yaml' -o -name '*.json' \) ! -path "$vrl_d/dispatch/*" ! -path "$vrl_d/scratch/*" ! -path "$vrl_d/gates/*" ! -name 'dispatch-*' ! -name 'LEDGER.log' | sort)
  # shellcheck disable=SC2086
  vrl_hits=$(language_scan $vrl_files) || fail "$(language_fail_text "$(printf '%s' "$vrl_hits" | tr '\n' ' ')")"
}

# --- Submission: how a specialist's result enters a run (D12) ----------------------------------
# `submit` takes facts (result, confidence, findings, artifact) and builds the protocol header itself: the
# role, task, focus, content fingerprint and the artifact's run-relative path and sha256 are never typed by a
# model. The assembled message goes through `record`, so every validation rule stays in one place; a rejection
# is returned to the specialist immediately (exit 1). The outcome is also written to
# .agents/local/submissions/<AGENT>.status so a runtime hook or dispatch.sh reads the record instead of
# parsing a final message.
submission_dir() { printf '%s/local/submissions\n' "$agents"; }
# default_artifact ROLE RESULT FOCUS: where the role's report lives, when there is exactly one such place.
default_artifact() {
  if [ -n "${3:-}" ] && risk_focus_role "$3" >/dev/null; then printf '%sREPORT.md\n' "$(risk_focus_report "$3")"; return 0; fi
  case "$1:$2" in
    qa:DONE) echo QA_PLAN.md ;;
    reviewer:*|security_reviewer:*|qa:*|verifier:*) if gate_of "$1" "$3" >/dev/null 2>&1; then gate_default_artifact "$(gate_of "$1" "$3")"; fi ;;
  esac
}
# normalize_artifact ID PATH -> run-relative path of an existing regular file inside the run; any of the
# absolute, project-relative (.agents/runs/<ID>/...), ./-prefixed or run-relative spellings is accepted.
normalize_artifact() {
  na_id=$1 na_p=$2; na_d=$(run_dir "$na_id")
  case "$na_p" in
    "$na_d"/*) na_p=${na_p#"$na_d"/} ;;
    .agents/runs/"$na_id"/*) na_p=${na_p#.agents/runs/"$na_id"/} ;;
    ./.agents/runs/"$na_id"/*) na_p=${na_p#./.agents/runs/"$na_id"/} ;;
    ./*) na_p=${na_p#./} ;;
  esac
  case "$na_p" in ''|/*|*..*) return 1 ;; esac
  [ -f "$na_d/$na_p" ] && [ ! -L "$na_d/$na_p" ] || return 2
  printf '%s\n' "$na_p"
}
# focus_from_artifact PATH -> reviewer focus whose report directory holds PATH
focus_from_artifact() {
  case "$1" in
    reviews/proof-review/plan/*) echo plan ;; reviews/proof-review/rules/*) echo rules ;; reviews/proof-review/small/*) echo rules+tests ;;
    reviews/test-trust/tests/*) echo tests ;; reviews/data-design/*) echo data ;;
    reviews/proof-review/config/*) echo config ;; reviews/contract-proof/*) echo contract ;; reviews/concurrency-proof/*) echo concurrency ;;
    reviews/performance-proof/*) echo performance ;; reviews/data-migration/*) echo migration ;;
  esac
}
submit_status() { # TOKEN STATUS ID ROLE RESULT GATE RAW ERROR
  [ -n "$1" ] || return 0
  mkdir -p "$(submission_dir)" 2>/dev/null || return 0
  printf 'status=%s\ntask=%s\nrole=%s\nresult=%s\ngate=%s\nraw=%s\nepoch=%s\nerror=%s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$(now_epoch)" "$(one_line "$8")" \
    > "$(submission_dir)/$1.status.tmp" && mv "$(submission_dir)/$1.status.tmp" "$(submission_dir)/$1.status"
}
submit_fail() { echo "submit rejected: $*" >&2; submit_status "$sb_agent" rejected "$sb_id" "$execution_role" "${sb_res:-}" '' '' "$*"; exit 1; }
submit_result() {
  sb_id=$1; shift
  [ "$execution_role" != lead ] || fail "the lead never submits a specialist result"
  require_run "$sb_id"
  sb_res='' sb_conf='' sb_focus=${PROOFLINE_FOCUS:-} sb_art='' sb_findings='' sb_reason='' sb_questions='' sb_report='' sb_agent=${PROOFLINE_AGENT:-}
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || fail "usage: agent.sh submit <ID> [--result R] --confidence C [--focus F] [--artifact P] [--findings FILE|-] [--reason T] [--questions FILE] [--agent TOKEN]"
    case "$1" in
      --result) sb_res=$2 ;; --confidence) sb_conf=$2 ;; --focus) sb_focus=$2 ;; --artifact) sb_art=$2 ;;
      --findings) sb_findings=$2 ;; --report) sb_report=$2 ;; --reason) sb_reason=$2 ;; --questions) sb_questions=$2 ;; --agent) sb_agent=$2 ;;
      *) fail "submit: unknown option $1" ;;
    esac
    shift 2
  done
  case "$sb_agent" in *[!A-Za-z0-9_.-]*) fail "submit: invalid --agent token" ;; esac
  sb_tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-submit.XXXXXX"); record_tmp=$sb_tmp
  sb_d=$(run_dir "$sb_id")
  case "$sb_conf" in high|medium|low) ;; *) submit_fail "--confidence must be high, medium or low" ;; esac
  sb_gaterole=no; is_gate_role "$execution_role" && sb_gaterole=yes
  # Findings: "severity|path:line|finding|evidence" (an optional leading id column and a markdown table
  # border are tolerated); ids are assigned here.
  : > "$sb_tmp/rows"
  if [ -n "$sb_findings" ]; then
    if [ "$sb_findings" = - ]; then cat > "$sb_tmp/findings.in"
    else [ -f "$sb_findings" ] || submit_fail "findings file not found: $sb_findings"; cat "$sb_findings" > "$sb_tmp/findings.in"; fi
    awk -F'|' '
      function t(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
      /^[[:space:]]*(#|$)/ { next }
      { line = $0; sub(/^[[:space:]]*\|/, "", line); sub(/\|[[:space:]]*$/, "", line); n = split(line, f, "|")
        if (line ~ /^[-:| ]+$/) next
        i = 1; if (tolower(t(f[1])) == "id" || tolower(t(f[1])) == "severity") next
        if (t(f[1]) !~ /^(blocking|info)$/ && n >= 5) i = 2
        sev = t(f[i]); loc = t(f[i + 1]); fnd = t(f[i + 2]); ev = ""
        for (j = i + 3; j <= n; j++) ev = ev (ev == "" ? "" : " / ") t(f[j])
        if (sev !~ /^(blocking|info)$/ || loc == "" || fnd == "" || ev == "") { print "BAD " NR ": want severity|path:line|finding|evidence with severity blocking or info"; bad = 1; next }
        c++; printf "%s|%s|%s|%s\n", sev, loc, fnd, ev }
      END { exit bad }' "$sb_tmp/findings.in" > "$sb_tmp/rows" || submit_fail "$(grep '^BAD' "$sb_tmp/rows" | head -1)"
  fi
  sb_blocking=$(awk -F'|' '$1 == "blocking"' "$sb_tmp/rows" | wc -l | tr -d ' ')
  # A gate result follows from the findings (the skill's rule), never from a free choice.
  sb_derive=$sb_gaterole
  if [ "$execution_role" = qa ]; then case "$sb_res" in DONE|NEEDS_INPUT) sb_derive=no ;; esac; fi
  if [ "$sb_derive" = yes ]; then
    case "$sb_res" in
      '') if [ "$sb_blocking" -gt 0 ]; then sb_res=FAIL; else sb_res=PASS; fi ;;
      PASS) [ "$sb_blocking" = 0 ] || submit_fail "--result PASS contradicts $sb_blocking blocking finding(s); the result of a gate follows from the findings" ;;
      FAIL) [ "$sb_blocking" -gt 0 ] || submit_fail "--result FAIL needs at least one blocking finding" ;;
      BLOCKED) ;;
      # A78: a risk focus whose tool or skill is missing; recorded as a blocking UNSUPPORTED finding, never a PASS.
      UNSUPPORTED) [ "$sb_blocking" = 0 ] || submit_fail "--result UNSUPPORTED cannot carry blocking findings (a check that ran is PASS or FAIL)"
        [ -n "$sb_reason" ] || submit_fail "--result UNSUPPORTED needs --reason naming the missing tool or skill" ;;
      *) submit_fail "--result $sb_res is not valid for role $execution_role (gate roles: PASS FAIL BLOCKED UNSUPPORTED, or omit it)" ;;
    esac
  fi
  case "$sb_res" in PASS|FAIL|BLOCKED|UNSUPPORTED|DONE|NEEDS_INPUT) ;; *) submit_fail "--result is required (DONE, BLOCKED or NEEDS_INPUT for role $execution_role)" ;; esac
  if [ "$execution_role" = reviewer ]; then
    [ -n "$sb_focus" ] || { [ -z "$sb_art" ] || sb_focus=$(focus_from_artifact "$(normalize_artifact "$sb_id" "$sb_art" 2>/dev/null || true)"); }
    case "$sb_focus" in plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration) ;; *) submit_fail "reviewer submissions need --focus plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration" ;; esac
  elif [ -n "$sb_focus" ] && [ "$(risk_focus_role "$sb_focus" 2>/dev/null)" = "$execution_role" ] && [ "$sb_res" != DONE ] && [ "$sb_res" != NEEDS_INPUT ]; then :
  else sb_focus=''
  fi
  sb_gate=''; sb_gate=$(gate_of "$execution_role" "$sb_focus" "$sb_id" 2>/dev/null || true)
  # Artifact: normalised and hashed here. --report FILE|-: the script writes the artifact from that text, so a
  # specialist never needs the Write tool (a subagent runtime may refuse report files) or a scratch file.
  [ -n "$sb_art" ] || sb_art=$(default_artifact "$execution_role" "$sb_res" "$sb_focus")
  if [ -n "$sb_report" ]; then
    [ -n "$sb_art" ] || submit_fail "--report needs --artifact: the run-relative path to write"
    sb_rp=${sb_art#.agents/runs/"$sb_id"/}; sb_rp=${sb_rp#./}
    case "$sb_rp" in ''|/*|*..*) submit_fail "--artifact must be a run-relative path: $sb_art" ;; esac
    sb_rk=task; if [ "$sb_gaterole" = yes ] && [ "$sb_res" != DONE ] && [ "$sb_res" != NEEDS_INPUT ]; then sb_rk=gate; fi
    artifact_allowed "$execution_role" "$sb_rk" "$sb_focus" "$sb_rp" || submit_fail "artifact $sb_rp is outside the paths $execution_role${sb_focus:+ (FOCUS $sb_focus)} reports in: $(artifact_paths "$execution_role" "$sb_rk" "$sb_focus")"
    if [ "$sb_report" = - ]; then cat > "$sb_tmp/report.in"
    else [ -f "$sb_report" ] || submit_fail "report file not found: $sb_report"; cat "$sb_report" > "$sb_tmp/report.in"; fi
    [ -s "$sb_tmp/report.in" ] || submit_fail "the report is empty"
    mkdir -p "$(dirname "$sb_d/$sb_rp")" && cp "$sb_tmp/report.in" "$sb_d/$sb_rp" || submit_fail "could not write $sb_rp"
    sb_art=$sb_rp
  fi
  if [ -z "$sb_art" ]; then submit_fail "--artifact is required: the run-relative path of your report (allowed: $(artifact_paths "$execution_role" task "$sb_focus"))"; fi
  sb_nrc=0; sb_norm=$(normalize_artifact "$sb_id" "$sb_art") || sb_nrc=$?
  if [ "$sb_nrc" = 2 ] && [ "$sb_res" = BLOCKED ]; then
    # BLOCKED needs a report to point at; the reason is the honest content when none was written.
    sb_norm=${sb_art#.agents/runs/"$sb_id"/}
    case "$sb_norm" in ''|/*|*..*) submit_fail "--artifact must be a run-relative path: $sb_art" ;; esac
    mkdir -p "$(dirname "$sb_d/$sb_norm")" && printf '# BLOCKED\n\n%s\n' "${sb_reason:-no reason given}" > "$sb_d/$sb_norm"
  elif [ "$sb_nrc" = 1 ]; then submit_fail "--artifact must be a path inside the run directory: $sb_art"
  elif [ "$sb_nrc" = 2 ]; then submit_fail "artifact not found in the run: $sb_art (write the report there first; expected location for your role: $(artifact_paths "$execution_role" "$([ "$sb_gaterole" = yes ] && echo gate || echo task)" "$sb_focus"))"
  fi
  if [ -n "$sb_questions" ]; then
    if [ "$sb_questions" = - ]; then cat > "$sb_tmp/questions.in"
    else [ -f "$sb_questions" ] || submit_fail "questions file not found: $sb_questions"; cat "$sb_questions" > "$sb_tmp/questions.in"; fi
    sb_questions=$sb_tmp/questions.in
  fi
  if [ "$execution_role" = verifier ] && [ "$sb_res" != BLOCKED ] && [ "$sb_res" != NEEDS_INPUT ]; then
    sb_ds=$(verify_design_sync "$sb_id") || submit_fail "$sb_ds"
  fi
  if [ "$execution_role" = reviewer ] && [ "$sb_focus" = tests ] && [ "$sb_res" != BLOCKED ] && [ "$sb_res" != NEEDS_INPUT ]; then
    sb_vt=$(verify_tests_findings "$sb_id") || submit_fail "findings.json of the tests review is not valid: $sb_vt"
  fi
  # Run artifacts are English (A33): the report, the findings and the questions are scanned before recording.
  sb_lang_files="$sb_d/$sb_norm $sb_tmp/rows"; [ -z "$sb_questions" ] || sb_lang_files="$sb_lang_files $sb_questions"
  # shellcheck disable=SC2086
  sb_hits=$(language_scan $sb_lang_files) || submit_fail "$(language_fail_text "$(printf '%s' "$sb_hits" | tr '\n' ' ' | sed "s#$sb_tmp/rows#your findings#")")"
  # A43: the result cites an immutable copy of the artifact (reports/snapshots/<sha12>-<role>-<path>), never the
  # live path. A later round that writes the same report path (REPORT.md, VERIFY.md, QA_REPORT.md) then cannot
  # make an earlier result's ARTIFACT sha256 stale. The original path is checked against the role's paths here.
  sb_kind=task; if [ "$sb_gaterole" = yes ] && [ "$sb_res" != DONE ] && [ "$sb_res" != NEEDS_INPUT ]; then sb_kind=gate; fi
  artifact_allowed "$execution_role" "$sb_kind" "$sb_focus" "$sb_norm" || submit_fail "artifact $sb_norm is outside the paths $execution_role${sb_focus:+ (FOCUS $sb_focus)} reports in: $(artifact_paths "$execution_role" "$sb_kind" "$sb_focus")"
  case "$sb_norm" in reports/snapshots/*) ;; *)
    sb_h=$(hash_file "$sb_d/$sb_norm")
    sb_sn=reports/snapshots/$(printf '%.12s' "$sb_h")-$execution_role-$(printf '%s' "$sb_norm" | tr '/' '_')
    mkdir -p "$sb_d/reports/snapshots" && cp "$sb_d/$sb_norm" "$sb_d/$sb_sn" || submit_fail "could not snapshot $sb_norm"
    sb_norm=$sb_sn ;;
  esac
  {
    printf 'ROLE: %s\nTASK: %s\n' "$execution_role" "$sb_id"
    [ -z "$sb_focus" ] || printf 'FOCUS: %s\n' "$sb_focus"
    printf 'RESULT: %s\nCONFIDENCE: %s\nFINGERPRINT: %s\nARTIFACT: %s %s\n\n' "$sb_res" "$sb_conf" "$(content_fingerprint)" "$sb_norm" "$(hash_file "$sb_d/$sb_norm")"
    printf '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n'
    sb_prefix=$execution_role; [ -z "$sb_gate" ] || sb_prefix=$sb_gate
    awk -F'|' -v p="$sb_prefix" '{ printf "| %s-%d | %s | %s | %s | %s |\n", p, NR, $1, $2, $3, $4 }' "$sb_tmp/rows"
    if [ "$sb_res" = BLOCKED ]; then printf '\nBLOCKED_REASON: %s\n' "$(one_line "${sb_reason:-see $sb_norm}")"; fi
    if [ "$sb_res" = UNSUPPORTED ]; then printf '\nUNSUPPORTED_REASON: %s\n' "$(one_line "$sb_reason")"; fi
    if [ "$sb_res" = NEEDS_INPUT ]; then
      printf '\nQUESTIONS:\n'
      if [ -n "$sb_questions" ]; then cat "$sb_tmp/questions.in"
      else printf '%s\n' "${sb_reason:-}"; fi
    fi
  } > "$sb_tmp/raw"
  sb_rc=0; AGENT_ROLE=$execution_role sh "$scripts/agent.sh" record "$sb_id" --file "$sb_tmp/raw" > "$sb_tmp/out" 2> "$sb_tmp/err" || sb_rc=$?
  if [ "$sb_rc" -ne 0 ]; then
    sb_msg=$(sed 's/^record rejected: //' "$sb_tmp/err" "$sb_tmp/out" | tr '\n' ' ')
    submit_fail "$sb_msg"
  fi
  sb_raw=$(sed -n 's/^result recorded: [^ ]* \([^ ]*\) .*/\1/p' "$sb_tmp/out" | head -1)
  # record may turn the result into FAIL (A78 script findings); the recorded result is the one reported.
  sb_final=$(sed -n 's/^result recorded: .* ([^ ]* \([A-Z_]*\))$/\1/p' "$sb_tmp/out" | head -1); sb_res=${sb_final:-$sb_res}
  sed -n 's/^risk: /risk: /p' "$sb_tmp/out"
  submit_status "$sb_agent" ok "$sb_id" "$execution_role" "$sb_res" "$sb_gate" "$sb_raw" ''
  printf 'submitted: %s %s %s%s (%s)\n' "$sb_id" "$execution_role" "$sb_res" "${sb_gate:+ gate=$sb_gate}" "${sb_raw:-no raw}"
}
# Compatibility: `gate <ID> <GATE> pass|fail [ARTIFACT]` with the same rules as record (summary/findings on stdin).
record_gate() {
  g_id=$1 g_gate=$2 g_result=$3 g_art=${4:-}; require_run "$g_id"; g_d=$(run_dir "$g_id")
  valid_gate_name "$g_gate" && [ "$g_gate" != SECRETS ] || fail "invalid gate: $g_gate (SECRETS is recorded by 'agent.sh secret-scan')"
  case "$g_result" in pass|fail) ;; *) fail "invalid gate result: $g_result (want pass|fail)" ;; esac
  [ "$execution_role" != lead ] || fail "the lead can never record a gate verdict"
  [ "$execution_role" = "$(gate_owner "$g_gate")" ] || fail "role $execution_role may not record a $g_gate gate"
  gate_preconditions "$g_id" "$g_gate"
  [ -n "$g_art" ] || g_art=$(gate_default_artifact "$g_gate")
  case "$g_art" in /*|*..*) fail "artifact path must be run-relative: $g_art" ;; esac
  artifact_allowed "$execution_role" gate "$(gate_focus "$g_gate")" "$g_art" || fail "artifact $g_art is outside the paths of $g_gate: $(artifact_paths "$execution_role" gate "$(gate_focus "$g_gate")")"
  [ -s "$g_d/$g_art" ] || fail "$g_gate gate requires the role's report $g_art in the run directory"
  [ "$(grep -c '^Verdict:' "$g_d/$g_art")" = 1 ] || fail "$g_art must contain exactly one 'Verdict:' line"
  g_verdict=$(sed -n 's/^Verdict: *//p' "$g_d/$g_art" | tr -d ' ')
  case "$g_result:$g_verdict" in pass:PASS|fail:FAIL) ;; *) fail "$g_art says 'Verdict: ${g_verdict:-<missing>}' but the gate result is '$g_result'" ;; esac
  g_scratch=$(mktemp "${TMPDIR:-/tmp}/agent-gate.XXXXXX"); cat > "$g_scratch"
  g_summary=$(field_from "$g_scratch" summary); g_findings=$(field_from "$g_scratch" findings); g_fscope=$(field_from "$g_scratch" fix_scope)
  rm -f "$g_scratch"
  reject_generic_justification "$g_summary" || fail "$g_gate gate requires a specific summary (>=20 chars, not a stock phrase)"
  g_rows=$(mktemp "${TMPDIR:-/tmp}/agent-gate-rows.XXXXXX")
  if [ "$g_result" = fail ]; then
    reject_generic_justification "$g_findings" || { rm -f "$g_rows"; fail "a failing gate requires specific findings (>=20 chars)"; }
    [ -n "$(scope_entry_paths "$g_fscope")" ] || { rm -f "$g_rows"; fail "a failing gate requires fix_scope with at least one path (comma-separated paths the fix may touch)"; }
    g_i=0; for g_p in $(printf '%s' "$g_fscope" | tr ',' ' '); do g_i=$((g_i + 1)); printf '%s-%s|blocking|%s|%s|%s\n' "$g_gate" "$g_i" "$g_p" "$(one_line "$g_findings")" "$g_art" >> "$g_rows"; done
  fi
  write_gate "$g_id" "$g_gate" "$g_result" "$execution_role" high "$(gate_focus "$g_gate")" "$g_art" "$g_rows" '' "$(content_fingerprint)"
  rm -f "$g_rows"
}
# SECRETS (D14): a script gate, never a role and never waivable.
secret_scan() {
  ss_id=$1; require_run "$ss_id"; require_lead
  gate_preconditions "$ss_id" SECRETS
  [ -f "$scripts/secret-scan.sh" ] || fail "secret scanner missing: .agents/scripts/secret-scan.sh"
  ss_tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-secrets.XXXXXX"); ss_rc=0
  ss_paths=$(task_changed_paths "$ss_id" | while IFS= read -r p; do [ -f "$root/$p" ] && printf '%s\n' "$p"; done)
  if [ -n "$ss_paths" ]; then
    # shellcheck disable=SC2086 # one argument per changed path (paths contain no whitespace by contract)
    (cd "$root" && sh "$scripts/secret-scan.sh" $ss_paths) > "$ss_tmp/out" 2> "$ss_tmp/err" || ss_rc=$?
  fi
  case "$ss_rc" in
    0) : > "$ss_tmp/rows"; ss_res=pass ;;
    1) awk -F: 'NF >= 3 { n++; printf "SECRETS-%d|blocking|%s:%s|secret pattern %s|secret-scan.sh\n", n, $1, $2, $3 }' "$ss_tmp/out" > "$ss_tmp/rows"; ss_res=fail
       [ -s "$ss_tmp/rows" ] || printf 'SECRETS-1|blocking|-|secret scanner reported findings without locations|secret-scan.sh\n' > "$ss_tmp/rows" ;;
    *) ss_err=$(head -3 "$ss_tmp/err" | tr '\n' ' '); rm -rf "$ss_tmp"; fail "secret scan error (exit $ss_rc): $ss_err — nothing recorded (BLOCKED)" ;;
  esac
  write_gate "$ss_id" SECRETS "$ss_res" secret-scan high '' '' "$ss_tmp/rows" '' "$(content_fingerprint)"
  [ "$ss_res" = pass ] || sed 's/^/  /' "$ss_tmp/rows"
  rm -rf "$ss_tmp"
}

# --- Approvals (D3/D16): single-use, from a TTY or a runtime prompt capture ----------------
# Prompt capture: .agents/local/prompts/<session>.json, one JSON object written by a runtime hook:
#   {"session":"<id>","time":<epoch seconds>,"sha256":"<sha256 of text>","text":"<the user's prompt>"}
valid_approval_kind() {
  case "$1" in
    plan|destructive|single_step|scope|budget|commit|push) return 0 ;;
    waive:*) case "${1#waive:}" in ''|*[!A-Za-z0-9_.+-]*) return 1 ;; esac; return 0 ;;
    *) return 1 ;;
  esac
}
kind_slug() { printf '%s\n' "$1" | tr ':' '-'; }
approvals_dir() { if [ "$1" = - ]; then printf '%s/.agents/local/approvals\n' "$root"; else printf '%s/approvals\n' "$(run_dir "$1")"; fi; }
# approval_target ID KIND: a run, or `-` (no active run; commit and push approvals only, kept in .agents/local/).
approval_target() {
  valid_approval_kind "$2" || fail "invalid approval kind: $2 (want plan|destructive|single_step|scope|budget|commit|push|waive:<FINDING-ID>)"
  if [ "$1" = - ]; then case "$2" in commit|push) return 0 ;; *) fail "approval kind $2 needs a run" ;; esac; fi
  require_run "$1"; require_open_run "$1"
}
ledger_if() { if [ "$1" != - ] && gates_enforced "$1"; then ledger_append "$@"; fi; }
# commit/push bind the content fingerprint, plan-like kinds the PLAN.md hash, waive:<F> the failing gate
# record (name and sha256) and the finding id, so a later round's same-numbered finding never reuses it.
approval_bound() { # ID KIND
  case "$2" in
    commit|push) content_fingerprint ;;
    plan|destructive|single_step|scope|budget) hash_file "$(run_dir "$1")/PLAN.md" ;;
    waive:*) ab_f=$(waive_target "$1" "${2#waive:}") || return 1; printf '%s@%s#%s\n' "$(basename "$ab_f")" "$(hash_file "$ab_f")" "${2#waive:}" ;;
  esac
}
kind_words() {
  case "$1" in
    destructive) echo 'destructive migration delete drop' ;;
    single_step) echo 'single step single-step one step tek adım tek adim' ;;
    budget) echo 'budget round rounds' ;;
    waive:*) printf '%s\n' "${1#waive:}" | tr '[:upper:]' '[:lower:]' ;;
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
  while [ "$sf_d" != "$root" ]; do
    case "$sf_d" in "$root"/*) ;; *) return 1 ;; esac
    [ ! -L "$sf_d" ] || return 1
    sf_d=$(dirname "$sf_d")
  done
}
latest_capture() { # -> the capture file with the greatest time, or exit 1; any unsafe capture file fails
  lc_best='' lc_t=-1
  for lc_f in "$root"/.agents/local/prompts/*.json; do
    [ -e "$lc_f" ] || [ -L "$lc_f" ] || continue
    safe_state_file "$lc_f" || { fail "prompt capture ${lc_f#"$root"/} is not a regular single-link file on a symlink-free path; refusing every capture"; return 1; }
    lc_v=$(capture_field "$lc_f" time 2>/dev/null) || continue
    case "$lc_v" in ''|*[!0-9]*) continue ;; esac
    [ "$lc_v" -le "$lc_t" ] || { lc_t=$lc_v; lc_best=$lc_f; }
  done
  [ -n "$lc_best" ] || return 1
  printf '%s\n' "$lc_best"
}
# text_has_approval TEXTFILE KIND: an approval phrase from config plus a kind-specific word.
text_has_approval() {
  tha_low=$(tr '[:upper:]' '[:lower:]' < "$1" | tr -s '[:space:]' ' ')
  tha_ph=$(cfg approval.phrases 'approve, approved, onaylıyorum, onayliyorum, go ahead, commit it, push it')
  printf '%s\n' "$tha_ph" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | { while IFS= read -r p; do [ -n "$p" ] || continue; case "$tha_low" in *"$p"*) echo y; break ;; esac; done; } | grep -q y || return 1
  for tha_w in $(kind_words "$2"); do case "$tha_low" in *"$tha_w"*) return 0 ;; esac; done
  return 1
}
latest_request() { # ID KIND -> request file
  ls -1 "$(approvals_dir "$1")" 2>/dev/null | grep -E "^[0-9]{3}-request-$(kind_slug "$2")\.yaml\$" | sort | tail -1 | sed "s#^#$(approvals_dir "$1")/#" | grep . || return 1
}
# approve_pending [ID]: run by the runtime's prompt hook right after it stored the user's prompt capture
# (A41). Every open approval request of the run (and of the no-run scope: commit, push) that this prompt
# satisfies becomes an approval. The lead never runs `approve` itself: the runtime hook denies it. Each
# kind is attempted in its own process, so a refusal ("no approval phrase") changes nothing.
approve_pending() {
  ap_run=${1:-}
  for ap_t in $ap_run -; do
    [ -n "$ap_t" ] || continue
    [ "$ap_t" = - ] || [ -d "$(run_dir "$ap_t")" ] || continue
    ap_dir=$(approvals_dir "$ap_t"); [ -d "$ap_dir" ] || continue
    for ap_rf in "$ap_dir"/[0-9][0-9][0-9]-request-*.yaml; do
      [ -f "$ap_rf" ] || continue
      ap_k=$(gate_field "$ap_rf" kind)
      valid_approval_kind "$ap_k" || continue
      printf '%s %s\n' "$ap_t" "$ap_k"
    done
  done | sort -u | while read -r ap_t ap_k; do
    sh "$scripts/agent.sh" approve "$ap_t" "$ap_k" 2>/dev/null || :
  done
}
request_approval() {
  rq_id=$1 rq_kind=$2; require_lead; approval_target "$rq_id" "$rq_kind"
  rq_ad=$(approvals_dir "$rq_id"); mkdir -p "$rq_ad"; rq_n=$(next_num "$rq_ad")
  rq_bound=$(approval_bound "$rq_id" "$rq_kind")
  printf 'kind: "%s"\nbound: "%s"\nrequested_at: %s\n' "$rq_kind" "$rq_bound" "$(now_epoch)" > "$rq_ad/$rq_n-request-$(kind_slug "$rq_kind").yaml"
  ledger_if "$rq_id" approval-request - - "$rq_kind bound=$rq_bound"
  rq_steps=''
  if [ "$rq_kind" = destructive ]; then
    rq_steps=$(awk -F'|' 'function t(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
      /^## / { i = ($0 ~ /^## Data[[:space:]]*$/); next }
      i && /^\|/ && NF >= 7 && tolower(t($6)) == "yes" { printf "   destructive step %s (%s): %s on %s; rollback: %s\n", t($2), t($3), t($4), t($5), t($8) }' "$(run_dir "$rq_id")/PLAN.md")
  fi
  rq_rows=''
  if [ "$rq_kind" = destructive ]; then
    # A62: the plan's `## Data` carries a `rows:` line (the data at risk, from seed files and fixtures; no agent
    # opens a database): the user's question says how much data the step destroys.
    rq_rows=$(awk '/^## / { i = ($0 ~ /^## Data[[:space:]]*$/); next } i && /^[[:space:]]*rows:[[:space:]]*[^[:space:]]/ { sub(/^[[:space:]]*/, ""); print "   data at risk: " substr($0, 6); exit }' "$(run_dir "$rq_id")/PLAN.md")
  fi
  printf 'QUESTIONS:\n1. Approve %s for %s?\n' "$rq_kind" "$rq_id"
  [ -z "$rq_steps" ] || printf '%s\n' "$rq_steps"
  [ -z "$rq_rows" ] || printf '%s\n' "$rq_rows"
  printf '   options: approve | reject\n   recommended: none (the user decides)\n   why: %s\n' "$(approval_why "$rq_kind" "$rq_bound")"
}
approval_why() {
  case "$1" in
    plan) echo 'supervised autonomy: the plan freezes only after user approval' ;;
    destructive) echo 'the plan declares a destructive data change' ;;
    single_step) echo 'the destructive change has no expand/contract steps: it would run as one step, with no point to stop between reading and dropping' ;;
    scope) echo 'the amendment adds scope paths, or the task fixes a pre-existing defect nobody asked about' ;;
    budget) echo 'the fix rounds are exhausted: a refreeze would start a fresh fix budget' ;;
    commit|push) echo "delivery of content $2 needs explicit approval" ;;
    *) echo 'a FAIL finding is waived only on explicit user instruction' ;;
  esac
}
approve() {
  ap_id=$1 ap_kind=$2; require_lead; approval_target "$ap_id" "$ap_kind"
  ap_req=$(latest_request "$ap_id" "$ap_kind") || fail "no approval request for $ap_kind: run 'agent.sh request-approval $ap_id $ap_kind' and relay it to the user first"
  safe_state_file "$ap_req" || fail "approval request $(basename "$ap_req") is not a regular single-link file on a symlink-free path"
  ap_reqn=$(basename "$ap_req" | cut -c1-3); ap_slug=$(kind_slug "$ap_kind"); ap_ad=$(approvals_dir "$ap_id")
  for ap_f in "$ap_ad"/[0-9][0-9][0-9]-"$ap_slug".yaml; do
    [ -e "$ap_f" ] || continue
    [ "$(basename "$ap_f" | cut -c1-3 | sed "s/^0*//")" -lt "$(printf "%s" "$ap_reqn" | sed "s/^0*//")" ] || fail "request $(basename "$ap_req") is already approved; request again for a new approval"
  done
  ap_bound=$(approval_bound "$ap_id" "$ap_kind") || return 1
  [ "$ap_bound" = "$(gate_field "$ap_req" bound)" ] || fail "the content changed since the approval request; request again"
  ap_txt=$(mktemp "${TMPDIR:-/tmp}/proofline-approve.XXXXXX")
  if [ -t 0 ] && [ -t 1 ]; then
    printf 'Approve %s for %s? Type an approval phrase (for example "approve %s"): ' "$ap_kind" "$ap_id" "$(kind_words "$ap_kind" | cut -d' ' -f1)" >&2
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
  text_has_approval "$ap_txt" "$ap_kind" || { rm -f "$ap_txt"; fail "approval refused: the user's words contain no approval phrase for $ap_kind (approval.phrases plus '$(kind_words "$ap_kind")')"; }
  rm -f "$ap_txt"
  if [ "$ap_src" = prompt_capture ] && grep -l "^capture_sha256: \"$ap_csha\"" "$ap_ad"/[0-9][0-9][0-9]-"$ap_slug".yaml >/dev/null 2>&1; then fail "approval refused: this user prompt already granted a $ap_kind approval (single-use)"; fi
  ap_n=$(next_num "$ap_ad")
  printf 'kind: "%s"\nbound: "%s"\nsource: "%s"\nsession: "%s"\ncapture_sha256: "%s"\ncapture_time: %s\nrequest: "%s"\nanswered_by: "user"\napproved_at: %s\nconsumed: "false"\n' \
    "$ap_kind" "$ap_bound" "$ap_src" "$ap_session" "$ap_csha" "$ap_time" "$(basename "$ap_req")" "$(now_epoch)" > "$ap_ad/$ap_n-$ap_slug.yaml"
  ap_tok=''; [ "$ap_id" = - ] || ap_tok="$(ledger_token "approvals/$ap_n-$ap_slug.yaml" "$ap_id") "
  ledger_if "$ap_id" approval - - "${ap_tok}$ap_kind source=$ap_src answered_by=user bound=$ap_bound"
  echo "approval recorded: $ap_id $ap_kind ($ap_src)"
}
# Inside a ledgered run only approvals that `approve` wrote (ledger-bound, unchanged since) count.
find_approval() { # ID KIND BOUND -> newest unconsumed approval file with that binding
  fa_all=$(ls -1 "$(approvals_dir "$1")" 2>/dev/null | grep -E "^[0-9]{3}-$(kind_slug "$2")\.yaml\$" | sort -r || true)
  # shellcheck disable=SC2086
  if [ -n "$fa_all" ] && [ "$1" != - ] && gates_enforced "$1"; then fa_all=$(bound_names "$(run_dir "$1")" approvals 'approval$' $fa_all | sort -r); fi
  for fa_x in $fa_all; do
    fa_x=$(approvals_dir "$1")/$fa_x
    safe_state_file "$fa_x" || continue
    [ "$(gate_field "$fa_x" consumed)" = false ] && [ "$(gate_field "$fa_x" bound)" = "$3" ] && { printf '%s\n' "$fa_x"; return 0; }
  done
  return 1
}
consume_approval() { # ID FILE
  awk '/^consumed:/ { print "consumed: \"true\""; next } { print }' "$2" > "$2.tmp" && printf 'consumed_at: %s\n' "$(now_epoch)" >> "$2.tmp" && mv "$2.tmp" "$2"
  ledger_if "$1" approval-consumed - - "$(basename "$2") $(gate_field "$2" kind)"
}
approval_consume() { # ID KIND [FINGERPRINT] — for the git hooks; exit 0 iff a valid approval was consumed
  acn_id=$1 acn_kind=$2 acn_fp=${3:-}; require_lead; approval_target "$acn_id" "$acn_kind"
  if [ -n "$acn_fp" ]; then acn_b=$acn_fp; else acn_b=$(approval_bound "$acn_id" "$acn_kind"); fi
  acn_f=$(find_approval "$acn_id" "$acn_kind" "$acn_b") || fail "no unconsumed $acn_kind approval bound to $acn_b for $acn_id"
  consume_approval "$acn_id" "$acn_f"
  echo "approval consumed: $acn_id $acn_kind $(basename "$acn_f")"
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
  wt_now=${3:-$(content_fingerprint)} wt_rec=''
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
waive() {
  wv_id=$1 wv_fid=$2; shift 2; wv_reason=''
  while [ $# -gt 0 ]; do case "$1" in --reason) wv_reason=${2:-}; shift 2 || shift ;; *) fail "unknown waive argument: $1" ;; esac; done
  require_run "$wv_id"; require_lead; require_open_run "$wv_id"; wv_d=$(run_dir "$wv_id")
  reject_generic_justification "$wv_reason" || fail "waive requires a specific --reason (>=20 chars)"
  wv_now=$(content_fingerprint); wv_rec=$(waive_target "$wv_id" "$wv_fid" "$wv_now") || return 1
  wv_gate=$(gate_field "$wv_rec" gate); wv_rsha=$(hash_file "$wv_rec")
  wv_app=$(find_approval "$wv_id" "waive:$wv_fid" "$(basename "$wv_rec")@$wv_rsha#$wv_fid") || fail "waiving $wv_fid needs the user's approval naming it: 'agent.sh request-approval $wv_id waive:$wv_fid', relay, then 'agent.sh approve $wv_id waive:$wv_fid'"
  mkdir -p "$wv_d/waivers"; wv_n=$(next_num "$wv_d/waivers"); wv_out=$wv_d/waivers/$wv_n-$wv_fid.yaml
  wv_follow=none
  if [ "$(cfg review.waiver_followup none)" = task ]; then
    wv_fu=$wv_d/waivers/$wv_n-$wv_fid.followup.md
    { printf '# Follow-up: waived finding %s of %s\n\n## Goal\n\nResolve the waived finding.\n\n## Context\n\n' "$wv_fid" "$wv_id"
      grep "^finding: $wv_fid|" "$wv_rec" | sed 's/^finding: //'; printf '\nWaiver reason: %s\n' "$wv_reason"; } > "$wv_fu"
    wv_ad=$agents/task-integrations/$(cfg tasks.adapter markdown).sh
    if [ -f "$wv_ad" ]; then wv_follow=$(sh "$wv_ad" followup "$wv_id" "$wv_fu") || fail "follow-up task creation failed via $wv_ad"; else wv_follow=pending; fi
  fi
  printf 'finding: "%s"\ngate: "%s"\ngate_record: "%s"\ngate_record_sha256: "%s"\nfingerprint: "%s"\nreason: %s\napproval: "%s"\nanswered_by: "user"\nfollowup: "%s"\ntimestamp: "%s"\n' \
    "$wv_fid" "$wv_gate" "$(basename "$wv_rec")" "$wv_rsha" "$wv_now" "$(one_line "$wv_reason")" "$(basename "$wv_app")" "$wv_follow" "$(now_iso)" > "$wv_out"
  consume_approval "$wv_id" "$wv_app"
  if gates_enforced "$wv_id"; then ledger_append "$wv_id" waive - - "$(ledger_token "waivers/$wv_n-$wv_fid.yaml" "$wv_id") $wv_fid gate=$wv_gate reason=$wv_reason"; fi
  echo "waiver recorded: $wv_id $wv_fid ($wv_gate)"
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
# ask ID [--file F]: the lead's own D13 question block (plan choice, scope change, a dispatch failover under
# `failover: ask`), from the file or stdin; stored like a specialist's NEEDS_INPUT so `questions`, `answer` and
# `next` treat both alike. A leading `QUESTIONS:` line is dropped; at least one numbered question is required.
ask_question() {
  aq_id=$1 aq_src=${2:-}; require_run "$aq_id"; require_lead; require_open_run "$aq_id"; aq_d=$(run_dir "$aq_id")
  aq_t=$(mktemp "${TMPDIR:-/tmp}/proofline-ask.XXXXXX")
  if [ -n "$aq_src" ]; then [ -f "$aq_src" ] || { rm -f "$aq_t"; fail "question file not found: $aq_src"; }; sed '/^QUESTIONS:[[:space:]]*$/d' "$aq_src" > "$aq_t"
  else sed '/^QUESTIONS:[[:space:]]*$/d' > "$aq_t"; fi
  grep -Eq '^[0-9]+\. [^[:space:]]' "$aq_t" || { rm -f "$aq_t"; fail "ask needs numbered questions ('1. <question>', then options, recommended, why)"; }
  mkdir -p "$aq_d/questions"; aq_n=$(next_num "$aq_d/questions")
  { printf 'from: %s\nasked_at: %s\n---\n' "$execution_role" "$(now_epoch)"; cat "$aq_t"; } > "$aq_d/questions/$aq_n.md"; rm -f "$aq_t"
  if section_key_present "$aq_d" execution awaiting_input; then set_run_value "$aq_id" execution awaiting_input true; fi
  if gates_enforced "$aq_id"; then ledger_append "$aq_id" ask - - "$(ledger_token "questions/$aq_n.md" "$aq_id")"; fi
  echo "question recorded: $aq_id $aq_n (relay it verbatim with 'agent.sh questions $aq_id')"
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
answer() {
  an_id=$1 an_n=$2; require_run "$an_id"; require_lead; an_d=$(run_dir "$an_id")
  case "$an_n" in ''|*[!0-9]*) fail "question number must be numeric" ;; esac
  an_q=$an_d/questions/$(printf '%03d' "$(printf '%s' "$an_n" | sed 's/^0*//; s/^$/0/')").md
  [ -f "$an_q" ] || fail "no question $an_n for $an_id"
  [ ! -e "${an_q%.md}.answer.md" ] || fail "question $an_n is already answered"
  an_t=$(mktemp "${TMPDIR:-/tmp}/proofline-answer.XXXXXX"); cat > "$an_t"
  grep -q '[^[:space:]]' "$an_t" || { rm -f "$an_t"; fail "empty answer"; }
  # answered_by user only when the newest prompt capture is not older than the question (epoch seconds), its sha256 matches its
  # text, and the trimmed answer (at least 3 characters) is contained in it.
  # A79: a question bound to an assumption: acceptance is stricter than a substring (assumption_prompt_accepts).
  an_tok=$(sed -n 's/^[[:space:]]*ASSUMPTION: \([^[:space:]]*\)[[:space:]]*$/\1/p' "$an_q" | head -1); an_acc=no
  an_by=lead an_asked=$(gate_field "$an_q" asked_at); case "$an_asked" in ''|*[!0-9]*) an_asked='' ;; esac
  an_norm=$(tr -s '[:space:]' ' ' < "$an_t" | sed 's/^ //; s/ $//')
  if [ -n "$an_asked" ] && [ "${#an_norm}" -ge 3 ] && an_cap=$(latest_capture); then
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
  fi
  { printf 'answered_by: %s\ntime: %s\n---\n' "$an_by" "$(now_iso)"; cat "$an_t"; } > "${an_q%.md}.answer.md"; rm -f "$an_t"
  an_left=no; for an_f in "$an_d"/questions/[0-9][0-9][0-9].md; do [ -e "$an_f" ] && [ ! -e "${an_f%.md}.answer.md" ] && an_left=yes; done
  if [ "$an_left" = no ] && section_key_present "$an_d" execution awaiting_input; then set_run_value "$an_id" execution awaiting_input false; fi
  # A79: a question bound to an assumption (`ASSUMPTION: <id>@<hash>`): the answer row names it; acceptance is
  # derived from the answer file (answered_by user, starting "accept <id>") by verify-assumptions.
  an_as=$(sed -n 's/^[[:space:]]*ASSUMPTION: \([^[:space:]]*\)[[:space:]]*$/ assumption=\1/p' "$an_q" | head -1)
  if gates_enforced "$an_id"; then ledger_append "$an_id" answer - - "$(basename "$an_q") answered_by=$an_by$an_as"; fi
  echo "answer recorded: $an_id $(basename "$an_q" .md) answered_by=$an_by"
  if [ -n "$an_as" ] && [ "$an_by" != user ]; then echo "note:${an_as}: not an acceptance the user's own prompt carries (answered_by=$an_by; the prompt must start with 'accept <id>' and hold no negation or condition), so the assumption stays unaccepted"; fi
}

# --- Execution policy (D5): decide persists and ledgers one resolved decision ---------------
# The configured runtime of a role: exec-policy.sh owns the role -> runtime-group table (one source of truth).
role_runtime() { sh "$scripts/exec-policy.sh" runtime "$1" 2>/dev/null || echo -; }
decision_files() { ls -1 "$(run_dir "$1")/decisions" 2>/dev/null | grep -E '^[0-9]{3}-.*\.decision$' | sort || true; }
latest_decision() { # ID ROLE [FOCUS]
  ld_tag=$2; [ -z "${3:-}" ] || ld_tag="$2-$(printf '%s' "$3" | tr '+' '-')"
  ld_hit=''; for ld_f in $(decision_files "$1"); do case "$ld_f" in [0-9][0-9][0-9]-"$ld_tag".decision) ld_hit=$(run_dir "$1")/decisions/$ld_f ;; esac; done
  printf '%s\n' "$ld_hit"
}
decide() {
  dc_id=$1 dc_role=$(canon_role "$2"); shift 2; require_run "$dc_id"; require_lead; require_open_run "$dc_id"
  valid_role "$dc_role" || fail "invalid role: $dc_role"
  dc_class=$(pipeline_class "$dc_id"); pipeline_class_valid "$dc_class" || fail "run $dc_id is not classified: the execution policy is derived from its class"
  dc_focus='' dc_over=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --focus) dc_focus=${2:?--focus needs a value}; shift 2 ;;
      --model|--effort|--context-bytes|--runtime) [ $# -ge 2 ] || fail "$1 needs a value"; dc_over="$dc_over $1 $2"; shift 2 ;;
      *) fail "unknown decide argument: $1" ;;
    esac
  done
  dc_tier=$(tier_effective "$dc_id"); dc_sig=''
  [ "$dc_class" != CRITICAL ] || dc_sig="$dc_sig critical_class"
  dc_stats=$(diff_stats "$dc_id"); if [ "${dc_stats% *}" -gt 15 ] || [ "${dc_stats#* }" -gt 400 ]; then dc_sig="$dc_sig large_diff"; fi
  [ "$(fix_rounds_used "$dc_id")" -lt 2 ] || dc_sig="$dc_sig fix_round_2"
  if dc_gate=$(gate_of "$dc_role" "$dc_focus" "$dc_id" 2>/dev/null); then
    dc_lf=$(gate_latest_file "$dc_id" "$dc_gate" "${dc_focus:--}")
    if [ -n "$dc_lf" ]; then
      case "$(gate_field "$dc_lf" result)" in fail) dc_sig="$dc_sig recent_fail_same_focus" ;; pass_low) dc_sig="$dc_sig low_confidence_pass" ;; esac
    fi
  fi
  [ -f "$scripts/exec-policy.sh" ] || fail "execution policy resolver missing: .agents/scripts/exec-policy.sh"
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
  dc_dir=$(run_dir "$dc_id")/decisions; mkdir -p "$dc_dir"
  dc_tag=$dc_role; [ -z "$dc_focus" ] || dc_tag="$dc_role-$(printf '%s' "$dc_focus" | tr '+' '-')"
  dc_out=$dc_dir/$(next_num "$dc_dir")-$dc_tag.decision; dc_rc=0
  sh "$scripts/exec-policy.sh" "$@" > "$dc_out.tmp" || dc_rc=$?
  if [ "$dc_rc" != 0 ]; then rm -f "$dc_out.tmp"; [ "$dc_rc" != 1 ] || dc_rc=4; echo "decision refused by exec-policy.sh (exit $dc_rc)" >&2; return "$dc_rc"; fi
  printf 'role=%s\nfocus=%s\nclass=%s\ntier=%s\nprofile=%s\nsignals=%s\ndecided_at=%s\n' "$dc_role" "$dc_focus" "$dc_class" "$dc_tier" "$dc_prof" "$(printf '%s' "$dc_sig" | sed 's/^ //' | tr ' ' ',')" "$(now_epoch)" >> "$dc_out.tmp"
  mv "$dc_out.tmp" "$dc_out"
  if gates_enforced "$dc_id"; then ledger_append "$dc_id" decide - - "$(basename "$dc_out") runtime=$(sed -n 's/^runtime=//p' "$dc_out" | head -1) model=$(sed -n 's/^model=//p' "$dc_out" | head -1) effort=$(sed -n 's/^effort=//p' "$dc_out" | head -1) signals=${dc_sig# }"; fi
  cat "$dc_out"; echo "decision_file=${dc_out#"$root"/}"
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

# --- Metrics (D5, A80): .agents/local/metrics/, best effort, `metrics: off` disables ALL of it ---
# history.tsv: one flat line per step. records.jsonl: versioned records (schema in docs/concepts/metrics.md).
metrics_line() { # TASK ROLE RUNTIME MODEL DURATION OUTCOME
  [ "$(cfg metrics on)" != off ] || return 0
  ml_f=$root/.agents/local/metrics/history.tsv
  mkdir -p "$(dirname "$ml_f")" 2>/dev/null || return 0
  [ -s "$ml_f" ] || printf 'time\ttask\trole\truntime\tmodel\tduration_s\toutcome\n' > "$ml_f" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(now_iso)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$ml_f" 2>/dev/null || true
}
metrics_step() { # ID ROLE FOCUS OUTCOME
  ms_f=$(latest_decision "$1" "$2" "$3"); ms_rt=$(role_runtime "$2") ms_model=- ms_dur=-
  if [ -n "$ms_f" ]; then
    ms_rt=$(sed -n 's/^runtime=//p' "$ms_f" | head -1); ms_model=$(sed -n 's/^model=//p' "$ms_f" | head -1)
    ms_at=$(sed -n 's/^decided_at=//p' "$ms_f" | head -1); [ -z "$ms_at" ] || ms_dur=$(( $(now_epoch) - ms_at ))
  fi
  metrics_line "$1" "$2" "${ms_rt:--}" "${ms_model:--}" "$ms_dur" "$4"
  ms_g=$(gate_of "$2" "$3" "$1" 2>/dev/null || true)
  metrics_json step "$1" "$2" "$3" "$ms_g" "${ms_rt:--}" "${ms_model:--}" "$ms_dur" - - - - - - - "$4"
}
metrics_run() { # ID OUTCOME
  mr_first=$(head -1 "$(ledger_file "$1")" 2>/dev/null | sed -n 's/.* epoch=\([0-9]*\) .*/\1/p'); mr_dur=-
  [ -z "$mr_first" ] || mr_dur=$(( $(now_epoch) - mr_first ))
  metrics_line "$1" lead "$(cfg runtime.lead claude)" - "$mr_dur" "$2"
  mr_del=$(decision_files "$1" | grep -c . || true); mr_fr=$(fix_rounds_used "$1" 2>/dev/null || echo -)
  metrics_json run "$1" lead - - "$(cfg runtime.lead claude)" - "$mr_dur" - - - - - "$mr_del" "$mr_fr" "$2"
}
# metrics_json KIND TASK ROLE FOCUS GATE RUNTIME MODEL DURATION TOKENS_IN TOKENS_OUT TOKENS_TOTAL TURNS RETRIES
#   DELEGATIONS FIX_ROUNDS RESULT -> .agents/local/metrics/records.jsonl (A80). One JSON object per line, written
#   by the control plane from its own state and the runtime's structured output; no model-written text is copied in.
#   Empty or "-" is null; a number field that is not digits is null; strings are cut to [A-Za-z0-9._+:-], so a
#   record can never carry free text (and so never a secret). `metrics: off` writes nothing.
metrics_json() {
  [ "$(cfg metrics on)" != off ] || return 0
  mj_f=$root/.agents/local/metrics/records.jsonl
  mkdir -p "$(dirname "$mj_f")" 2>/dev/null || return 0
  mj_s() { mj_v=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._+:-'); case "$mj_v" in ''|-) printf null ;; *) printf '"%s"' "$mj_v" ;; esac; }
  mj_n() { case "$1" in ''|*[!0-9]*) printf null ;; *) printf '%s' "$1" ;; esac; }
  printf '{"schema":"proofline.metrics/1","kind":%s,"time":"%s","task":%s,"role":%s,"focus":%s,"gate":%s,"runtime":%s,"model":%s,"duration_s":%s,"tokens_in":%s,"tokens_out":%s,"tokens_total":%s,"turns":%s,"retries":%s,"delegations":%s,"fix_rounds":%s,"result":%s}\n' \
    "$(mj_s "$1")" "$(now_iso)" "$(mj_s "$2")" "$(mj_s "$3")" "$(mj_s "$4")" "$(mj_s "$5")" "$(mj_s "$6")" "$(mj_s "$7")" \
    "$(mj_n "$8")" "$(mj_n "$9")" "$(mj_n "${10}")" "$(mj_n "${11}")" "$(mj_n "${12}")" "$(mj_n "${13}")" "$(mj_n "${14}")" "$(mj_n "${15}")" "$(mj_s "${16}")" >> "$mj_f" 2>/dev/null || true
}
# metrics-dispatch (called by dispatch.sh, lead only): one record per specialist dispatch.
metrics_dispatch() { # ID ROLE FOCUS RUNTIME MODEL DURATION TIN TOUT TTOTAL TURNS RETRIES RESULT
  require_run "$1"
  metrics_json dispatch "$1" "$2" "$3" "$(gate_of "$2" "$3" "$1" 2>/dev/null || true)" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" - - "${12}"
}

# --- next (deterministic next step; an interrupted step restarts from its beginning) -------
next_step() {
  ns_id=$1; require_run "$ns_id"; ns_d=$(run_dir "$ns_id"); risk_prime "$ns_id"
  ns_st=$(run_state "$ns_d"); ns_hs=$(section_value "$ns_d" handoff state)
  printf 'task=%s\nstate=%s\nhandoff=%s\n' "$ns_id" "$ns_st" "$ns_hs"
  o() { printf 'next=%s\n' "$*"; }
  r() { printf 'reason=%s\n' "$*"; }
  case "$ns_st" in FAILED|BLOCKED) o "report the evidence, then: agent.sh cleanup $ns_id"; r "run is terminal ($ns_st)"; return 0 ;; esac
  if [ "$(section_value "$ns_d" execution awaiting_input)" = true ]; then o "agent.sh questions $ns_id"; o "relay verbatim; then: agent.sh answer $ns_id <N> < answer"; r "a question is pending (a specialist's NEEDS_INPUT or the lead's ask)"; return 0; fi
  ns_class=$(pipeline_class "$ns_id")
  pipeline_class_valid "$ns_class" || { o "agent.sh classify $ns_id <TRIVIAL|STANDARD|COMPLEX|CRITICAL> [review]"; r "run is not classified"; return 0; }
  if section_key_present "$ns_d" repository task_branch; then
    case "$(section_value "$ns_d" repository task_branch)" in ''|PENDING) o "agent.sh branch $ns_id"; r "task branch not established"; return 0 ;; esac
  fi
  [ "$(baseline_status "$ns_d")" = captured ] || { o "agent.sh baseline $ns_id"; r "baseline not captured"; return 0; }
  if ! freeze_hash_present "$ns_d"; then
    if [ "$(pipeline_needs "$ns_id" evidence)" = yes ] && [ ! -f "$ns_d/EVIDENCE.md" ]; then o "dispatch.sh $ns_id explorer (one per bounded assignment, at most $(pipeline_value "$ns_class" max_explorers)); then consolidate EVIDENCE.md"; r "EVIDENCE.md missing"; return 0; fi
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
    for ns_k in plan scope; do
      if [ "$ns_k" = plan ] && [ "$(run_autonomy "$ns_id")" != supervised ]; then continue; fi
      if [ "$ns_k" = scope ] && [ -z "$(task_defect_fixes "$ns_d/TASK.md")" ]; then continue; fi
      if ! find_approval "$ns_id" "$ns_k" "$ns_ph" >/dev/null; then
        ns_rq=$(latest_request "$ns_id" "$ns_k" 2>/dev/null || true)
        if [ -n "$ns_rq" ] && [ "$(gate_field "$ns_rq" bound)" = "$ns_ph" ]; then o "wait for the user's answer (the runtime records it from their reply; the lead never runs approve), then: agent.sh next $ns_id"
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
          if [ -n "$ns_rq" ] && [ "$(gate_field "$ns_rq" bound)" = "$ns_ph" ]; then o "wait for the user's answer (the runtime records it from their reply; the lead never runs approve), then: agent.sh next $ns_id"
          else o "agent.sh request-approval $ns_id $ns_k (relay verbatim)"; fi
          r "$ns_k approval required before IMPLEMENT"; ns_ask=1; break
        done
      fi
      [ -n "$ns_ask" ] || { o "agent.sh handoff $ns_id IMPLEMENTING"; r "plan frozen"; } ;;
    IMPLEMENTING) o "dispatch.sh $ns_id implementer"; o "agent.sh handoff $ns_id IMPLEMENTED"; r "implementation in progress" ;;
    IMPLEMENTED)
      ns_fp=$(content_fingerprint); ns_fail='' ns_todo=''
      for ns_g in $(required_gates "$ns_id"); do
        ns_s=$(gate_status "$ns_id" "$ns_g" strict "$ns_fp")
        case "$ns_s" in pass|waived) ;; fail) ns_fail="$ns_fail $ns_g" ;; *) ns_todo="$ns_todo $ns_g:$ns_s" ;; esac
      done
      if [ -n "$ns_fail" ]; then
        ns_used=$(fix_rounds_used "$ns_id")
        # A78: script findings are not fixed by the implementer: a missing flag is a plan amendment, UNSUPPORTED the user's call.
        ns_scr=0 ns_oth=0
        for ns_g in $ns_fail; do
          for ns_fc in - $(risk_gate_focuses "$ns_id" "$ns_g"); do
            ns_lf=$(gate_latest_file "$ns_id" "$ns_g" "$ns_fc"); [ -n "$ns_lf" ] || continue
            # A92: count script findings (UNSUPPORTED, missing flag) against the rows an implementer can fix.
            ns_a=$(grep -c '^finding: [^|]*|blocking|' "$ns_lf" || true)
            ns_b=$(grep -Ec '^finding: [^|]*\|blocking\|[^|]*\|(UNSUPPORTED |risk signal )' "$ns_lf" || true)
            ns_scr=$((ns_scr + ns_b)); ns_oth=$((ns_oth + ns_a - ns_b))
            case "$(gate_field "$ns_lf" result | tr '[:upper:]' '[:lower:]')" in fail) [ "$ns_a" -gt 0 ] || ns_oth=$((ns_oth + 1)) ;; esac
            # shellcheck disable=SC2013 # finding ids contain no whitespace
            for ns_fid in $(sed -n 's/^finding: \([^|]*\)|blocking|[^|]*|UNSUPPORTED .*/\1/p' "$ns_lf"); do
              finding_waived "$ns_id" "$ns_lf" "$ns_fid" || o "agent.sh request-approval $ns_id waive:$ns_fid (UNSUPPORTED $ns_fc: never a PASS; the user decides whether to accept the gap, listed in the completion report)"
            done
            # shellcheck disable=SC2013 # finding ids contain no whitespace
            for ns_fid in $(sed -n 's/^finding: \([^|]*\)|blocking|[^|]*|risk signal .*/\1/p' "$ns_lf"); do
              finding_waived "$ns_id" "$ns_lf" "$ns_fid" || o "amend PLAN.md to declare the flag of $ns_fid (dispatch the design role), then agent.sh refreeze $ns_id <amendment>; or the user waives $ns_fid"
            done
          done
        done
        if [ "$ns_scr" -gt 0 ] && [ "$ns_oth" -eq 0 ]; then o "the implementer cannot clear these: only UNSUPPORTED or missing-flag findings fail (waive them, or amend PLAN.md and refreeze)"
        elif [ "$ns_used" -le "$(max_fix_rounds)" ]; then o "agent.sh handoff $ns_id IMPLEMENTING (fix round $ns_used; findings of:$ns_fail)"; o "dispatch.sh $ns_id implementer (with the findings)"
        else o "agent.sh terminate $ns_id FAILED (reason and evidence on stdin)"; fi
        r "failing gates:$ns_fail"
      elif [ -n "$ns_todo" ]; then
        for ns_x in $ns_todo; do
          ns_g=${ns_x%%:*}
          case "$ns_g" in SECRETS) o "agent.sh secret-scan $ns_id" ;; *)
            for ns_fc in - $(risk_gate_focuses "$ns_id" "$ns_g"); do
              gate_satisfied "$(gate_focus_status "$ns_id" "$ns_g" "$ns_fc" strict "$ns_fp")" && continue
              if [ "$ns_fc" = - ]; then case "$ns_g" in REVIEW_*) o "dispatch.sh $ns_id reviewer --focus $(gate_focus "$ns_g")" ;; *) o "dispatch.sh $ns_id $(gate_owner "$ns_g")" ;; esac
              else o "dispatch.sh $ns_id $(gate_owner "$ns_g") --focus $ns_fc"; fi
            done ;;
          esac
        done
        r "gates not passing:$ns_todo"
      else o "agent.sh handoff $ns_id CODE_DONE"; r "every required gate passes"; fi ;;
    CODE_DONE)
      case "$(section_value "$ns_d" execution knowledge_state)" in
        KNOWLEDGE_DONE|not_applicable)
          if [ "$(section_value "$ns_d" completion_report published)" != true ]; then o "write COMPLETION_REPORT.md; agent.sh publish-completion-report $ns_id"; r "completion report not published"
          else o "agent.sh handoff $ns_id DONE"; r "report published"; fi ;;
        *) o "agent.sh knowledge-done $ns_id [not_applicable]"; r "knowledge transaction not recorded" ;;
      esac ;;
    DONE) o "agent.sh request-approval $ns_id commit (delivery needs the user's approval)"; o "agent.sh cleanup $ns_id (after delivery)"; r "run DONE" ;;
  esac
}
next_without_run() {
  nr_id=$(active_run)
  if [ -n "$nr_id" ]; then next_step "$nr_id"; return; fi
  printf 'task=none\nnext=agent.sh start <ID> [--title "<title>"] [--task-file <path>]\nreason=obtain a canonical task from task-author or an adapter import, then start it\n'
}

# --- Reopen a completed run (the only sanctioned way) ---------------------------------------
amend_run() {
  g_id=$1; require_run "$g_id"; g_d=$(run_dir "$g_id"); require_lead
  gates_enforced "$g_id" || fail "amend requires the lifecycle_gates policy: run $g_id has none, so it cannot be reopened; open a new task"
  require_open_run "$g_id"
  [ "$(run_state "$g_d")" = CODE_DONE ] || fail "amend reopens a CODE_DONE/DONE run only (execution.state is '$(run_state "$g_d")'); before CODE_DONE, findings go through the gates and the fix loop"
  enforce_task_branch "$g_id"; verify_seal "$g_id"; verify_freshness "$g_id" >/dev/null; verify_handoff "$g_id" 1 >/dev/null
  g_scratch=$(mktemp "${TMPDIR:-/tmp}/agent-amend.XXXXXX"); cat > "$g_scratch"
  g_reason=$(field_from "$g_scratch" reason); g_fscope=$(field_from "$g_scratch" fix_scope); g_finstr=$(field_from "$g_scratch" fix_instruction); g_auth=$(field_from "$g_scratch" authorized_by); g_pchange=$(field_from "$g_scratch" plan_change)
  rm -f "$g_scratch"
  reject_generic_justification "$g_reason" || fail "amend requires a specific reason (>=20 chars)"
  reject_generic_justification "$g_finstr" || fail "amend requires a specific fix_instruction (>=20 chars)"
  [ "${#g_auth}" -ge 3 ] || fail "amend requires authorized_by (who authorized reopening a completed run)"
  [ -n "$g_fscope" ] || fail "amend requires fix_scope (comma-separated paths the fix may touch)"
  if [ "$g_pchange" != yes ]; then
    g_maps=$(scope_mappings "$g_d/PLAN.md") || fail "invalid scope mapping"
    for g_p in $(scope_entry_paths "$g_fscope"); do authorized_path "$g_maps" "$g_p" || fail "fix_scope names a path outside the frozen scope: $g_p (add 'plan_change: yes' and follow with an amendment + refreeze if the plan itself must change)"; done
  fi
  g_fscope=$(scope_entry_paths "$g_fscope" | paste -sd, -)
  [ -n "$g_fscope" ] || fail "fix_scope has no path (an entry must start with a repo path: path, path:line or path:symbol)"
  g_patch=$(task_patch_fingerprint "$g_id"); g_seq=$(next_gate_seq "$g_id"); g_name=$(printf '%03d-REOPEN' "$g_seq"); g_gd=$(gates_dir "$g_id"); mkdir -p "$g_gd"
  patch_manifest "$g_id" > "$g_gd/$g_name.manifest" || fail "could not write reopen manifest"
  if [ -f "$g_d/COMPLETION_REPORT.md" ]; then cp "$g_d/COMPLETION_REPORT.md" "$g_gd/$g_name.completion-report.md"; fi
  g_prev_hs=$(section_value "$g_d" handoff state)
  {
    printf 'task_id: "%s"\nseq: %s\ngate: "REOPEN"\nresult: "reopen"\nrole: "%s"\n' "$g_id" "$g_seq" "$execution_role"
    printf 'fingerprint: "%s"\npatch_sha256: "%s"\nmanifest_sha256: "%s"\n' "$(content_fingerprint)" "$g_patch" "$(hash_file "$g_gd/$g_name.manifest")"
    printf 'task_sha256: "%s"\nevidence_sha256: "%s"\nplan_sha256: "%s"\nqa_plan_sha256: "%s"\n' "$(section_value "$g_d" freeze task_sha256)" "$(section_value "$g_d" freeze evidence_sha256)" "$(section_value "$g_d" freeze plan_sha256)" "$(section_value "$g_d" freeze qa_plan_sha256)"
    printf 'reason: %s\nauthorized_by: %s\nfix_scope: %s\nfix_instruction: %s\nplan_change: %s\n' "$(one_line "$g_reason")" "$(one_line "$g_auth")" "$g_fscope" "$(one_line "$g_finstr")" "${g_pchange:-no}"
    printf 'previous_execution_state: "%s"\nprevious_handoff_state: "%s"\nprevious_knowledge_state: "%s"\n' "$(run_state "$g_d")" "$g_prev_hs" "$(section_value "$g_d" execution knowledge_state)"
    printf 'previous_implemented_patch_sha256: "%s"\nprevious_code_done_patch_sha256: "%s"\n' "$(section_value "$g_d" handoff implemented_patch_sha256)" "$(section_value "$g_d" handoff code_done_patch_sha256)"
    printf 'previous_completion_published: "%s"\nprevious_completion_receipt: "%s"\n' "$(section_value "$g_d" completion_report published)" "$(section_value "$g_d" completion_report receipt)"
    printf 'timestamp: "%s"\n' "$(now_iso)"
  } > "$g_gd/$g_name.yaml" || fail "could not write reopen record"
  set_run_value "$g_id" execution state AMENDING
  if section_key_present "$g_d" execution knowledge_state; then set_run_value "$g_id" execution knowledge_state not_started; fi
  set_run_value "$g_id" handoff state IMPLEMENTING
  set_run_value "$g_id" handoff implemented_patch_sha256 PENDING
  set_run_value "$g_id" handoff code_done_patch_sha256 PENDING
  if section_key_present "$g_d" completion_report published; then set_run_value "$g_id" completion_report published false; set_run_value "$g_id" completion_report receipt PENDING; fi
  ledger_append "$g_id" REOPEN "$g_prev_hs" IMPLEMENTING "$(ledger_token "gates/$g_name.yaml" "$g_id") authorized_by=$g_auth: $g_reason"
  echo "run reopened: $g_id ($g_name); handoff IMPLEMENTING, execution AMENDING — implement the bounded fix, then every required gate runs again"
}

# --- Completion report (task-system agnostic; adapters in .agents/task-integrations/) ------
required_report_headings() {
  dir=$1 id=$(basename "$1")
  printf '## Implementation Summary\n## Verification\n## Assumptions\n## Known Limitations / Follow-up\n'
  rh_g=$(required_gates "$id")
  if printf '%s\n' "$rh_g" | grep -Eq '^(REVIEW_|SECURITY)'; then printf '## Review Result\n'; fi
  if printf '%s\n' "$rh_g" | grep -Fxq QA; then printf '## QA Result\n'; fi
  if [ -d "$dir/worker-evidence" ]; then printf '## TDD Evidence\n'; fi
  if ls "$dir"/reports/[0-9][0-9][0-9]-debug.md >/dev/null 2>&1; then printf '## Root cause\n'; fi
  if [ -n "$(ls -A "$dir/amendments" 2>/dev/null)" ]; then printf '## Amendments\n'; fi
  if ls "$dir"/gates/*-REOPEN.yaml >/dev/null 2>&1; then printf '## Reopen History\n'; fi
  if ls "$dir"/waivers/*.yaml >/dev/null 2>&1; then printf '## Waivers\n'; fi
  if [ -n "$(decision_files "$id")" ]; then printf '## Execution\n'; fi
  if [ -n "$(risk_unsupported "$id")" ]; then printf '## Unsupported Checks\n'; fi
  return 0
}
validate_completion_report_structure() {
  id=$1 dir=$(run_dir "$1"); report="$dir/COMPLETION_REPORT.md"
  [ -f "$report" ] || fail "completion report missing: $report"
  size=$(wc -c < "$report" | tr -d ' '); [ "$size" -ge 200 ] || fail "completion report is too short to be meaningful"
  for vc_h in $(required_report_headings "$dir" | sed 's/^## //; s/ /_/g'); do
    vc_h=$(printf '## %s' "$vc_h" | tr '_' ' ')
    grep -Fq "$vc_h" "$report" || fail "completion report missing required section: $vc_h"
  done
  # A79: every assumption that is not verified is listed in `## Assumptions` (an accepted-by-user one with the
  # answer file that accepted it); a run with none writes "none".
  vc_sec=$(awk '/^## Assumptions[ \t]*$/ { i = 1; next } /^## / { i = 0 } i' "$report")
  printf '%s\n' "$vc_sec" | grep -q '[^[:space:]]' || fail "completion report: the '## Assumptions' section is empty (list every unverified and accepted-by-user assumption, or write none)"
  vc_miss=$(assumption_states "$id" | awk -F'\t' '$3 != "verified" { print $1 "\t" $3 "\t" $4 }' | while IFS="$(printf '\t')" read -r vc_a vc_s vc_ref; do
    printf '%s\n' "$vc_sec" | grep -Eq "(^|[^A-Za-z0-9-])$vc_a([^0-9]|\$)" || { echo "$vc_a"; continue; }
    # the line naming the id states its status (unverified | accepted-by-user): "AS-1 verified" does not pass
    printf '%s\n' "$vc_sec" | grep -E "(^|[^A-Za-z0-9-])$vc_a([^0-9]|\$)" | grep -Eq "(^|[^A-Za-z-])$vc_s([^A-Za-z-]|\$)" || { echo "$vc_a($vc_s)"; continue; }
    [ "$vc_s" != accepted-by-user ] || printf '%s\n' "$vc_sec" | grep -Fq "$(basename "$vc_ref")" || echo "$vc_a(answer $vc_ref)"
  done | tr '\n' ' ')
  [ -z "$vc_miss" ] || fail "completion report: '## Assumptions' does not list: $vc_miss (every unverified assumption by id with its status word, unverified or accepted-by-user; an accepted one with its answer file)"
  # A78: every UNSUPPORTED check is named (GATE:focus) in the report; it was never a PASS.
  vc_usec=$(awk '/^## Unsupported Checks[ \t]*$/ { i = 1; next } /^## / { i = 0 } i' "$report")
  for vc_u in $(risk_unsupported "$id" | cut -d'|' -f1 | sort -u); do
    printf '%s\n' "$vc_usec" | grep -Fq "$vc_u" || fail "completion report must name the UNSUPPORTED check $vc_u under '## Unsupported Checks'"
  done
}
adapter_script() { path="$agents/task-integrations/$1.sh"; [ -f "$path" ] || fail "unknown task-integration adapter: $1"; printf '%s\n' "$path"; }
publish_completion_report() {
  id=$1 adapter=${2:-$(cfg tasks.adapter markdown)}; require_run "$id"; dir=$(run_dir "$id"); require_lead
  [ "$(run_state "$dir")" = CODE_DONE ] || fail "completion report may only be published after CODE_DONE"
  verify_seal "$id"
  validate_completion_report_structure "$id"
  script=$(adapter_script "$adapter")
  contract_backup=''
  if local_task_source_run "$id"; then
    verify_freshness "$id" >/dev/null
    contract_backup=$(mktemp "${TMPDIR:-/tmp}/agent-task-source.XXXXXX"); cp -p "$(local_task_source "$dir")" "$contract_backup"
  fi
  if ! receipt=$(sh "$script" publish "$id" "$dir/COMPLETION_REPORT.md"); then
    [ -z "$contract_backup" ] || { cp -p "$contract_backup" "$(local_task_source "$dir")"; rm -f "$contract_backup"; }
    fail "completion report publish failed via adapter: $adapter"
  fi
  [ -n "$receipt" ] || { [ -z "$contract_backup" ] || { cp -p "$contract_backup" "$(local_task_source "$dir")"; rm -f "$contract_backup"; }; fail "adapter $adapter returned an empty receipt"; }
  if [ -n "$contract_backup" ]; then
    # A separate process on purpose: inside an `if` condition `set -e` is off and inner failures would be lost.
    if ! sh "$scripts/agent.sh" freshness "$id" >/dev/null 2>&1; then
      cp -p "$contract_backup" "$(local_task_source "$dir")"; rm -f "$contract_backup"
      fail "adapter $adapter changed the frozen task contract outside the completion-report block; the task source was restored and nothing was recorded"
    fi
    rm -f "$contract_backup"
  fi
  set_run_value "$id" completion_report adapter "$adapter"
  set_run_value "$id" completion_report published true
  set_run_value "$id" completion_report receipt "$receipt"
  if gates_enforced "$id"; then ledger_append "$id" publish-completion-report CODE_DONE CODE_DONE "$adapter $receipt"; fi
  echo "completion report published: $id via $adapter -> $receipt"
}
verify_completion_report() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  [ "$(section_value "$dir" completion_report published)" = true ] || fail "completion report not published: $id"
  adapter=$(section_value "$dir" completion_report adapter); receipt=$(section_value "$dir" completion_report receipt)
  [ -n "$adapter" ] && [ -n "$receipt" ] || fail "completion report adapter/receipt missing: $id"
  script=$(adapter_script "$adapter")
  sh "$script" verify "$id" "$receipt" || fail "completion report publication could not be verified: $id"
  echo "completion report publication verified: $id"
}
knowledge_done() {
  id=$1 state=${2:-KNOWLEDGE_DONE}; require_run "$id"; dir=$(run_dir "$id"); require_lead; require_open_run "$id"
  case "$state" in KNOWLEDGE_DONE|not_applicable) ;; *) fail "invalid knowledge state: $state" ;; esac
  [ "$(run_state "$dir")" = CODE_DONE ] || fail "knowledge-done requires CODE_DONE first"
  section_key_present "$dir" execution knowledge_state || fail "run schema has no execution.knowledge_state field to set"
  verify_seal "$id"
  ! local_task_source_run "$id" || verify_freshness "$id" >/dev/null
  set_run_value "$id" execution knowledge_state "$state"
  if gates_enforced "$id"; then ledger_append "$id" knowledge-done "$(section_value "$dir" handoff state)" "$state" ""; fi
  echo "knowledge state recorded: $id $state"
}

# --- Terminal outcomes and cleanup -----------------------------------------------------------
terminate_run() {
  id=$1 outcome=$2; require_run "$id"; dir=$(run_dir "$id"); require_lead
  case "$outcome" in FAILED|BLOCKED) ;; *) fail "invalid outcome: $outcome (want FAILED|BLOCKED)" ;; esac
  gates_enforced "$id" || fail "terminate requires the lifecycle_gates policy"
  require_open_run "$id"
  [ "$(run_state "$dir")" != CODE_DONE ] || fail "a CODE_DONE run is complete, not terminated"
  enforce_task_branch "$id"; verify_seal "$id"
  scratch=$(mktemp "${TMPDIR:-/tmp}/agent-terminate.XXXXXX"); cat > "$scratch"
  reason=$(field_from "$scratch" reason); evidence=$(field_from "$scratch" evidence); rm -f "$scratch"
  reject_generic_justification "$reason" || fail "terminate requires a specific reason (>=20 chars)"
  reject_generic_justification "$evidence" || fail "terminate requires the evidence behind it (>=20 chars: the failing gate records, the failing command and its output)"
  if [ "$outcome" = FAILED ]; then
    used=$(fix_rounds_used "$id"); max=$(max_fix_rounds)
    [ "$used" -gt "$max" ] || fail "FAILED requires the fix rounds to be exhausted ($used failing rounds, max_fix_rounds $max); use BLOCKED for an environment/tooling/external blocker"
  fi
  prev=$(run_state "$dir")
  set_run_value "$id" execution state "$outcome"
  ledger_append "$id" terminate "$prev" "$outcome" "reason: $reason; evidence: $evidence"
  metrics_run "$id" "$(printf '%s' "$outcome" | tr "[:upper:]" "[:lower:]")"
  echo "run terminated: $id $outcome"
}
cleanup_run() {
  id=$1; require_run "$id"; dir=$(run_dir "$id"); require_lead
  [ ! -L "$dir" ] && [ "$(dirname "$dir")" = "$root/.agents/runs" ] || fail "refusing to remove $dir: not a plain run directory"
  case "$(run_state "$dir")" in
    FAILED|BLOCKED)
      verify_seal "$id"; tail -n 1 "$(ledger_file "$id")" | grep -Fq "event=terminate " || fail "cleanup of a $(run_state "$dir") run requires its ledgered terminate transition: $id" ;;
    *)
      [ "$(section_value "$dir" handoff state)" = DONE ] || fail "cleanup requires handoff DONE (or a FAILED/BLOCKED run): $id"
      cu_base=$(repository_base_sha "$dir")
      if [ "$cu_base" != "$(git -C "$root" rev-parse HEAD)" ]; then
        # Delivered: the commit moved HEAD past base_sha. base_sha must be an ancestor of HEAD; task paths are
        # measured from base_sha, so the task-owned patch must still equal the CODE_DONE patch and every gate must
        # hold; and every task-owned path must be committed exactly (HEAD = working tree there). Knowledge-scope
        # files are checked by the knowledge scope, committed or not.
        git -C "$root" merge-base --is-ancestor "$cu_base" HEAD || fail "cleanup blocked: HEAD does not descend from the run's base_sha $cu_base"
        ctp_base=$cu_base
        verify_freshness "$id" >/dev/null; verify_handoff "$id" 1 >/dev/null; verify_knowledge_scope "$id" >/dev/null
        cu_owned=$(task_owned_paths "$id")
        if [ -n "$cu_owned" ]; then
          # shellcheck disable=SC2086 # one argument per path (paths contain no whitespace by contract)
          cu_dirty=$(git -C "$root" status --porcelain --untracked-files=all -- $cu_owned)
          [ -z "$cu_dirty" ] || fail "cleanup blocked: task-owned changes are not committed exactly: $(printf '%s' "$cu_dirty" | tr '\n' ' ')"
        fi
      else
        verify_freshness "$id" >/dev/null; verify_handoff "$id" 1 >/dev/null
      fi
      if section_key_present "$dir" completion_report required; then verify_completion_report "$id" >/dev/null; fi ;;
  esac
  marker=$(active_run_file)
  if [ -f "$marker" ] && [ "$(sed '/^[[:space:]]*$/d' "$marker")" = "$id" ]; then : > "$marker"; fi
  rm -rf "$dir"
  echo "run cleaned up: $id (runtime artifacts removed; ACTIVE_RUN cleared)"
}

# --- Branch: <git.branch_prefix><TASK-ID>-<slug> from the canonical branch's exact tip --------
derive_task_slug() {
  dir=$1; id=$(basename "$1"); type=$(section_value "$1" task_source type)
  case "$type" in
    local_markdown) base=$(basename "$(section_value "$dir" task_source path)" .md); case "$base" in "$id"-*) slug=${base#"$id"-} ;; *) slug=$base ;; esac ;;
    none) slug=run ;;
    *) slug=$(sed -n '1s/^# Task: *[^ ]* *[-—]* *//p' "$dir/TASK.md" 2>/dev/null); [ -n "$slug" ] || slug=run ;;
  esac
  slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48 | sed 's/-$//')
  [ -n "$slug" ] || fail "derived task slug is empty for $id"
  printf '%s\n' "$slug"
}
branch_setup() {
  id=$1; require_run "$id"; dir=$(run_dir "$id")
  [ "$(run_state "$dir")" != CODE_DONE ] || fail "cannot modify task branch on CODE_DONE run: $id"
  canonical=$(cfg canonical_branch); [ -n "$canonical" ] || fail "canonical_branch not configured"
  current=$(git -C "$root" branch --show-current) || true
  [ -n "$current" ] || fail "task branch setup requires a checked-out branch, not detached HEAD"
  existing=$(section_value "$dir" repository task_branch)
  case "$existing" in
    ''|PENDING)
      [ "$current" = "$canonical" ] || fail "task branch setup must start from canonical branch ($canonical); currently on: $current"
      bstatus=$(baseline_status "$dir"); case "$bstatus" in ''|pending) ;; *) fail "task branch setup must occur before baseline: $id";; esac
      canonical_sha=$(git -C "$root" rev-parse "refs/heads/$canonical") || fail "canonical branch not found locally: $canonical"
      task_branch="$(cfg git.branch_prefix proofline/)$id-$(derive_task_slug "$dir")"
      if git -C "$root" show-ref --verify --quiet "refs/heads/$task_branch"; then
        [ "$(git -C "$root" rev-parse "refs/heads/$task_branch")" = "$canonical_sha" ] || fail "existing branch $task_branch is not compatible with canonical base $canonical_sha; will not reuse or overwrite"
      else
        git -C "$root" branch "$task_branch" "$canonical_sha" || fail "failed to create task branch: $task_branch"
      fi
      git -C "$root" checkout -q "$task_branch" || fail "failed to switch to task branch: $task_branch"
      set_run_value "$id" repository canonical_branch "$canonical"
      set_run_value "$id" repository task_branch "$task_branch"
      echo "task branch established: $id $task_branch" ;;
    *)
      git -C "$root" show-ref --verify --quiet "refs/heads/$existing" || fail "recorded task branch missing: $existing; will not regenerate, recover manually"
      if [ "$current" != "$existing" ]; then
        [ "$current" = "$canonical" ] || fail "cannot resume $id: on unexpected branch $current (expected $canonical or $existing)"
        git -C "$root" checkout -q "$existing" || fail "failed to switch to recorded task branch: $existing"
      fi
      echo "task branch resumed: $id $existing" ;;
  esac
}

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
  printf 'TASK: %s %s\n' "$sm_id" "$(sed -n '1s/^#[[:space:]]*//p' "$sm_d/TASK.md" 2>/dev/null | tr -d '\000-\037\177')"
  printf 'CLASS/TOPOLOGY: %s / %s\n' "$(ua "$(pipeline_class "$sm_id" | grep -v PENDING || true)")" "$(ua "$(resolve_topology "$sm_d" 2>/dev/null || true)")"
  if pipeline_declared "$sm_id" && pipeline_class_valid "$(pipeline_class "$sm_id")"; then
    sm_fp=$(content_fingerprint)
    printf 'TIER: %s\n' "$(tier_effective "$sm_id")"
    for sm_g in $(required_gates "$sm_id"); do printf '%s: %s\n' "$sm_g" "$(gate_status "$sm_id" "$sm_g" strict "$sm_fp")"; done
    printf 'FIX ROUNDS: %s of %s\n' "$(fix_rounds_used "$sm_id")" "$(max_fix_rounds)"
  fi
  printf 'DELIVERY: completion report published %s\n' "$(ua "$(section_value "$sm_d" completion_report published)")"
}

run_suites() { # every sibling *-test.sh
  for rs_t in "$scripts"/*-test.sh; do [ -f "$rs_t" ] || continue; echo "== ${rs_t##*/}"; sh "$rs_t"; done
}

# --- CLI ---------------------------------------------------------------------------------------
valid_role "$execution_role" || fail "invalid execution role: ${AGENT_ROLE:-}"
command=${1:-}
read_only_commands='role status open-runs effective pipeline tier next questions fingerprint config-get config-check verify-freeze verify-scope verify-knowledge-scope verify-handoff verify-worker-evidence verify-gates verify-seal verify-completion-report freshness validate patch-fingerprint summary help verify-qa-plan report-tokens verify-assumptions'
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
if [ "$command" = approve-pending ]; then lock_command=no; fi
if [ "$command" = submit ]; then lock_command=no; trap '[ -z "$record_tmp" ] || rm -rf "$record_tmp"' 0; fi
if [ "$lock_command" = yes ]; then
  mkdir -p "$agents/local"
  trap 'release_locks' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  acquire_lock "$agents/local/.lock"
  if [ "$command" != start ] && [ -n "${2:-}" ] && valid_task_id "$2" && [ -d "$(run_dir "$2")" ]; then
    acquire_lock "$(run_dir "$2")/.lock"
  fi
fi
usage() {
  cat >&2 <<'USAGE'
usage: agent.sh <command> [args]   (AGENT_ROLE selects the role; default lead)
  role | status | effective [ID] | fingerprint [ID] | config-get <dotted.key> | config-check [FILE]
  start <ID> [--title TITLE] [--task-file PATH]
  classify <ID> <TRIVIAL|STANDARD|COMPLEX|CRITICAL> [review] | pipeline <ID> | tier <ID> | next [ID] | summary [ID]
  branch <ID> | baseline <ID> | freeze <ID> | refreeze <ID> <AMENDMENT-FILE>
  handoff <ID> <IMPLEMENTING|IMPLEMENTED|CODE_DONE|DONE> | worker-evidence <ID> <RED|GREEN|REFACTOR|FIX> <pass|fail>
  window-open <ID> [ROLE] | window-close <ID> <BEFORE> [EXIT-STATUS] [ROLE]   (ROLE implementer|designer)
  open-runs
  submit <ID> [--result R] --confidence C [--focus F] [--artifact P] [--findings FILE|-] [--report FILE|-] [--reason T] [--questions F] [--agent TOKEN]
  record <ID> [--file F] | gate <ID> <GATE> <pass|fail> [ARTIFACT] | secret-scan <ID>
  decide <ID> <ROLE> [--focus F] [--runtime RT] [--model M] [--effort E] [--context-bytes N] | ledger-note <ID> <TEXT>
  metrics-dispatch <ID> <ROLE> <FOCUS> <RUNTIME> <MODEL> <DURATION_S> <TOKENS_IN> <TOKENS_OUT> <TOKENS_TOTAL> <TURNS> <RETRIES> <RESULT>   (dispatch.sh only; empty = null)
  request-approval <ID> <KIND> | approve <ID> <KIND> | approval-consume <ID> <KIND> [FINGERPRINT]
  waive <ID> <FINDING-ID> --reason TEXT | ask <ID> [--file F] | questions <ID> | answer <ID> <N> (answer on stdin)
  terminate <ID> <FAILED|BLOCKED> | amend <ID> | knowledge-done <ID> [not_applicable]
  publish-completion-report <ID> [ADAPTER] | verify-completion-report <ID> | delivery-check <ID> | cleanup <ID>
  task-source-status <ID> | task-source-relocate <ID> <NEW-PATH>
  verify-freeze|verify-scope|verify-knowledge-scope|verify-handoff|verify-worker-evidence|verify-gates|verify-seal|freshness|validate|patch-fingerprint <ID>
  verify-assumptions <ID>   (read-only: the assumption register; lists every unverified or accepted-by-user assumption)
  test
USAGE
}
case "$command" in
  role) printf 'role=%s\n' "$execution_role" ;;
  status) id=$(active_run); echo "active_task=${id:-none}"; effective "$id" ;;
  open-runs) open_runs ;;
  effective) effective "${2:-}" ;;
  fingerprint) [ -z "${2:-}" ] || require_run "$2"; content_fingerprint ;;
  config-get) config_get "${2:?usage: agent.sh config-get <dotted.key>}" || fail "config key not found: $2" ;;
  config-check) config_check "${2:-}" ;;
  baseline) require_lead; baseline "${2:?usage: agent.sh baseline <ID>}" ;;
  branch) require_lead; branch_setup "${2:?usage: agent.sh branch <ID>}" ;;
  start) shift; start_run "$@" ;;
  classify) require_lead; classify "${2:?usage: agent.sh classify <ID> <CLASS> [review]}" "${3:?usage: agent.sh classify <ID> <CLASS> [review]}" "${4:-}" ;;
  pipeline) pipeline_show "${2:?usage: agent.sh pipeline <ID>}" ;;
  tier) require_run "${2:?usage: agent.sh tier <ID>}"; pipeline_class_valid "$(pipeline_class "$2")" || fail "run $2 is not classified yet"; tier_record "$2" ;;
  next) if [ -n "${2:-}" ]; then next_step "$2"; else next_without_run; fi ;;
  summary) summary_run "${2:-}" ;;
  report-tokens) report_tokens "${2:?usage: agent.sh report-tokens <ID>}" ;;
  decide) require_lead; dcid=${2:?usage: agent.sh decide <ID> <ROLE> [--focus F] [overrides]}; dcr=${3:?usage: agent.sh decide <ID> <ROLE> ...}; shift 3; decide "$dcid" "$dcr" "$@" ;;
  freeze) require_lead; freeze "${2:?usage: agent.sh freeze <ID>}" ;;
  refreeze) require_lead; freeze "${2:?usage: agent.sh refreeze <ID> <AMENDMENT>}" refreeze "${3:?usage: agent.sh refreeze <ID> <AMENDMENT>}" ;;
  verify-freeze) verify_freeze "${2:?usage: agent.sh verify-freeze <ID>}" ;;
  verify-scope) verify_scope "${2:?usage: agent.sh verify-scope <ID>}" ;;
  verify-knowledge-scope) verify_knowledge_scope "${2:?usage: agent.sh verify-knowledge-scope <ID>}" ;;
  freshness) verify_freshness "${2:?usage: agent.sh freshness <ID>}" ;;
  handoff) [ "$execution_role" = lead ] || [ "${3:-}" = IMPLEMENTING ] || fail "handoff phase denied for $execution_role"; record_handoff "${2:?usage: agent.sh handoff <ID> <PHASE>}" "${3:?usage: agent.sh handoff <ID> <PHASE>}" ;;
  verify-handoff) verify_handoff "${2:?usage: agent.sh verify-handoff <ID>}" ;;
  delivery-check) require_lead; delivery_check "${2:?usage: agent.sh delivery-check <ID>}" ;;
  worker-evidence) record_worker_evidence "${2:?usage: agent.sh worker-evidence <ID> <RED|GREEN|REFACTOR|FIX> <pass|fail>}" "${3:?usage: agent.sh worker-evidence <ID> <PHASE> <RESULT>}" "${4:?usage: agent.sh worker-evidence <ID> <PHASE> <RESULT>}" ;;
  verify-assumptions) verify_assumptions "${2:?usage: agent.sh verify-assumptions <ID>}" ;;
  verify-qa-plan) require_run "${2:?usage: agent.sh verify-qa-plan <ID>}"; verify_qa_plan_bound "$2"; echo "QA plan bound to PLAN.md: $2" ;;
  verify-worker-evidence) verify_worker_evidence "${2:?usage: agent.sh verify-worker-evidence <ID>}" ;;
  submit) sid=${2:?usage: agent.sh submit <ID> --confidence C [options]}; shift 2; submit_result "$sid" "$@" ;;
  record) rid=${2:?usage: agent.sh record <ID> [--file F]}; rfile=''; if [ "${3:-}" = --file ]; then rfile=${4:?usage: agent.sh record <ID> --file F}; fi; record_result "$rid" "$rfile" ;;
  gate) record_gate "${2:?usage: agent.sh gate <ID> <GATE> <pass|fail> [ARTIFACT]}" "${3:?usage: agent.sh gate <ID> <GATE> <pass|fail>}" "${4:?usage: agent.sh gate <ID> <GATE> <pass|fail>}" "${5:-}" ;;
  secret-scan) secret_scan "${2:?usage: agent.sh secret-scan <ID>}" ;;
  request-approval) request_approval "${2:?usage: agent.sh request-approval <ID> <KIND>}" "${3:?usage: agent.sh request-approval <ID> <KIND>}" ;;
  approve) approve "${2:?usage: agent.sh approve <ID> <KIND>}" "${3:?usage: agent.sh approve <ID> <KIND>}" ;;
  approve-pending) require_lead; approve_pending "${2:-}" ;;
  approval-consume) approval_consume "${2:?usage: agent.sh approval-consume <ID> <KIND> [FINGERPRINT]}" "${3:?usage: agent.sh approval-consume <ID> <KIND> [FINGERPRINT]}" "${4:-}" ;;
  waive) wid=${2:?usage: agent.sh waive <ID> <FINDING-ID> --reason TEXT}; wfid=${3:?usage: agent.sh waive <ID> <FINDING-ID> --reason TEXT}; shift 3; waive "$wid" "$wfid" "$@" ;;
  questions) require_run "${2:?usage: agent.sh questions <ID>}"; questions_show "$2" ;;
  metrics-dispatch) require_lead; [ $# -ge 13 ] || fail "usage: agent.sh metrics-dispatch <ID> <ROLE> <FOCUS> <RUNTIME> <MODEL> <DURATION_S> <TOKENS_IN> <TOKENS_OUT> <TOKENS_TOTAL> <TURNS> <RETRIES> <RESULT> (empty = null)"; shift; metrics_dispatch "$@" ;;
  ledger-note) ledger_note "${2:?usage: agent.sh ledger-note <ID> <TEXT>}" "${3:?usage: agent.sh ledger-note <ID> <TEXT>}" ;;
  ask) require_lead; aid=${2:?usage: agent.sh ask <ID> [--file F]}; afile=''; if [ "${3:-}" = --file ]; then afile=${4:?usage: agent.sh ask <ID> --file F}; fi; ask_question "$aid" "$afile" ;;
  answer) answer "${2:?usage: agent.sh answer <ID> <N>}" "${3:?usage: agent.sh answer <ID> <N>}" ;;
  terminate) require_lead; terminate_run "${2:?usage: agent.sh terminate <ID> <FAILED|BLOCKED>}" "${3:?usage: agent.sh terminate <ID> <FAILED|BLOCKED>}" ;;
  cleanup) require_lead; cleanup_run "${2:?usage: agent.sh cleanup <ID>}" ;;
  amend) require_lead; amend_run "${2:?usage: agent.sh amend <ID>}" ;;
  patch-fingerprint) require_run "${2:?usage: agent.sh patch-fingerprint <ID>}"; task_patch_fingerprint "$2" ;;
  window-open) require_lead; window_open "${2:?usage: agent.sh window-open <ID> [implementer|designer]}" "${3:-}" ;;
  window-close) require_lead; window_close "${2:?usage: agent.sh window-close <ID> <BEFORE> [EXIT-STATUS] [implementer|designer]}" "${3:-}" "${4:-0}" "${5:-}" ;;
  verify-gates) verify_lifecycle_gates "${2:?usage: agent.sh verify-gates <ID>}"; echo "lifecycle gates verified: $2" ;;
  verify-seal) verify_seal "${2:?usage: agent.sh verify-seal <ID>}"; echo "lifecycle seal verified: $2" ;;
  task-source-status) task_source_status "${2:?usage: agent.sh task-source-status <ID>}" ;;
  task-source-relocate) task_source_relocate "${2:?usage: agent.sh task-source-relocate <ID> <NEW-PATH>}" "${3:?usage: agent.sh task-source-relocate <ID> <NEW-PATH>}" ;;
  knowledge-done) knowledge_done "${2:?usage: agent.sh knowledge-done <ID> [not_applicable]}" "${3:-KNOWLEDGE_DONE}" ;;
  publish-completion-report) publish_completion_report "${2:?usage: agent.sh publish-completion-report <ID> [ADAPTER]}" "${3:-}" ;;
  verify-completion-report) verify_completion_report "${2:?usage: agent.sh verify-completion-report <ID>}" ;;
  validate) validate_run "${2:?usage: agent.sh validate <ID>}" ;;
  db-config) db_config "${2:-all}" ;;
  db-check) require_run "${2:?usage: agent.sh db-check <ID>}"; db_guard_check "$2"; echo "database guard: unchanged ($2)" ;;
  test) require_lead; run_suites ;;
  help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
