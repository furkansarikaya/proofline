#!/bin/sh
# shellcheck disable=SC2086,SC2046 # space-separated config lists are split on purpose (noglob below)
# The single execution-policy resolver (D5). Pure function of its inputs: no clock, no randomness,
# no model call, no run state. `agent.sh decide` gathers the inputs from a run and ledgers the result.
#
#   exec-policy.sh resolve --role R --class C --tier T [--profile P] [--runtime RT] [--signal S]...
#       [--escalations-used N] [--model M] [--effort E] [--context-bytes N]
#   exec-policy.sh explain < decision          reason codes -> text
#   exec-policy.sh check-capabilities          codex ladder vs the local Codex model cache (needs jq)
#   exec-policy.sh runtime <role>              the configured runtime of a role (runtime.roles.<role> > runtime.<group>)
#
# Inputs: .agents/config.yaml (EXEC_POLICY_CONFIG), .agents/roles.conf (EXEC_POLICY_ROLES).
# Precedence, top wins:
#   1 hard limits: role tier floor, forbidden efforts, max_context_bytes, escalation budget
#   2 explicit operator override (--runtime/--profile/--model/--effort/--context-bytes)
#   3 task policy: roles.conf row for (role, profile, runtime), class floors, escalation signals
#   4 capability validation against the runtime's ladder and capabilities
# Output: key=value lines. Exit: 0 resolved | 2 usage or invalid config | 3 invalid override |
#   4 unresolvable (no ladder, no role policy, capability floor unmet).
set -euf

root=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
config=${EXEC_POLICY_CONFIG:-$root/.agents/config.yaml}
roles=${EXEC_POLICY_ROLES:-$root/.agents/roles.conf}

die() { echo "exec-policy: $*" >&2; exit 2; }
reject() { echo "exec-policy: REJECTED $1: $2" >&2; exit 3; }
hard() { echo "exec-policy: UNRESOLVABLE $1: $2" >&2; exit 4; }

# cfg_walk val|keys KEY... : scalar at a key path, or the child keys of a path, in file order.
cfg_walk() {
  mode=$1; shift
  awk -v mode="$mode" -v want="$*" '
    /^[[:space:]]*(#|$)/ { next }
    { ind = match($0, /[^ ]/) - 1; d = int(ind / 2); line = substr($0, ind + 1)
      if (index(line, ":") == 0) next
      key = line; sub(/:.*/, "", key); val = line; sub(/^[^:]*:[[:space:]]*/, "", val); sub(/[[:space:]]+#.*$/, "", val)
      if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
      for (i = d + 1; i < 32; i++) delete st[i]
      st[d] = key; p = st[0]; for (i = 1; i <= d; i++) p = p " " st[i]
      if (mode == "val" && p == want) { print val; exit }
      if (mode == "keys") { par = p; sub(/ [^ ]*$/, "", par); if (d > 0 && par == want) print key }
    }' "$config"
}
cfg() { cfg_walk val "$@"; }
kv() { for kv_t in $1; do case "$kv_t" in "$2="*) printf '%s\n' "${kv_t#*=}"; return 0 ;; esac; done; return 1; }
idx() { idx_i=1; idx_w=$1; shift; for idx_t in "$@"; do [ "$idx_t" = "$idx_w" ] && { echo "$idx_i"; return 0; }; idx_i=$((idx_i + 1)); done; return 1; }
nth() { nth_n=$1; shift; [ "$nth_n" -ge 1 ] && [ "$nth_n" -le $# ] || return 1; eval "printf '%s\n' \"\${$nth_n}\""; }
int() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }
count() { set -- $1; echo $#; }

canon_role() {
  case "$1" in
    full_lifecycle) echo lead ;; implementation_worker) echo implementer ;; independent_reviewer) echo reviewer ;;
    independent_qa) echo qa ;; independent_verifier) echo verifier ;; *) echo "$1" ;;
  esac
}
role_group() { # runtime.<group> key of a role (D6)
  case "$1" in lead) echo lead ;; reviewer|security_reviewer|qa|verifier) echo reviewers ;; *) echo worker ;; esac
}
# The configured runtime of a role (no override): runtime.roles.<role>, else runtime.<group>, else claude.
role_runtime() {
  rrt=$(cfg runtime roles "$1"); [ -n "$rrt" ] || rrt=$(cfg runtime "$(role_group "$1")"); [ -n "$rrt" ] || rrt=claude
  echo "$rrt"
}
# Capability tier of a runtime model: capabilities.<rt>.<m>, else its ladder position.
model_tier() {
  mt=$(cfg capabilities "$1" "$2")
  if [ -z "$mt" ]; then mt=$(idx "$2" $(cfg execution_policy providers "$1" models)) || return 1; fi
  int "$mt" || die "capabilities.$1.$2 must be an integer"
  echo "$mt"
}
# First ladder model whose tier is >= N (the cheapest model meeting N).
model_at_tier() {
  for ma_m in $ladder; do [ "$(model_tier "$rt" "$ma_m")" -ge "$1" ] && { echo "$ma_m"; return 0; }; done
  return 1
}

resolve() {
  role='' class='' tier='' profile='' rt='' signals='' used=0 o_model='' o_effort='' o_ctx=''
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "missing value for $1"
    case "$1" in
      --role) role=$(canon_role "$2") ;; --class) class=$2 ;; --tier) tier=$2 ;; --profile) profile=$2 ;;
      --runtime) rt=$2 ;; --signal) signals="$signals $2" ;; --escalations-used) used=$2 ;;
      --model) o_model=$2 ;; --effort) o_effort=$2 ;; --context-bytes) o_ctx=$2 ;;
      *) die "unknown option: $1" ;;
    esac
    shift 2
  done
  [ -f "$config" ] || die "config not found: $config"
  [ -f "$roles" ] || die "roles policy not found: $roles"
  case "$role" in lead|task_author|explorer|architect|data_architect|designer|qa|implementer|reviewer|security_reviewer|verifier) ;;
    *) die "unknown role: '$role'" ;; esac
  class_line=$(cfg execution_policy classes "$class"); [ -n "$class_line" ] || die "no execution_policy.classes entry for class '$class'"
  case "$tier" in docs|small|full) ;; *) die "--tier must be docs|small|full" ;; esac
  int "$used" || die "--escalations-used must be an integer"
  for s in $signals; do
    case "$s" in low_confidence_pass|recent_fail_same_focus|large_diff|critical_class|fix_round_2) ;;
      *) die "unknown signal: $s (want low_confidence_pass|recent_fail_same_focus|large_diff|critical_class|fix_round_2)" ;; esac
  done
  [ "$class" = CRITICAL ] && case " $signals " in *" critical_class "*) ;; *) signals="$signals critical_class" ;; esac

  # profile and runtime: operator override > config
  preason=OPERATOR_OVERRIDE
  [ -n "$profile" ] || { profile=$(cfg profile); preason=CONFIG_PROFILE; }
  [ -n "$profile" ] || { profile=balanced; preason=DEFAULT_PROFILE; }
  case "$profile" in max|balanced|economy) ;; *) [ "$preason" = OPERATOR_OVERRIDE ] && reject INVALID_PROFILE "$profile (want max|balanced|economy)"; die "invalid profile in config: $profile" ;; esac
  rreason=OPERATOR_OVERRIDE
  if [ -z "$rt" ]; then rt=$(cfg runtime roles "$role"); rreason=CONFIG_RUNTIME_ROLE; fi
  if [ -z "$rt" ]; then rt=$(cfg runtime "$(role_group "$role")"); rreason=CONFIG_RUNTIME_GROUP; fi   # = role_runtime
  [ -n "$rt" ] || { rt=claude; rreason=DEFAULT_RUNTIME; }
  ladder=$(cfg execution_policy providers "$rt" models)
  [ -n "$ladder" ] || hard NO_LADDER "runtime $rt has no execution_policy.providers.$rt.models"
  efforts=$(cfg execution_policy providers "$rt" efforts); [ -n "$efforts" ] || die "execution_policy.providers.$rt.efforts missing"
  forbidden=$(cfg execution_policy forbidden_efforts)
  max_ctx=$(cfg execution_policy max_context_bytes); int "$max_ctx" || die "execution_policy.max_context_bytes must be an integer"
  max_esc=$(cfg budgets max_escalations); [ -n "$max_esc" ] || max_esc=2; int "$max_esc" || die "budgets.max_escalations must be an integer"

  # task policy: the roles.conf row for this runtime, else the row of another runtime mapped by tier
  row=$(awk -v r="$role" -v p="$profile" -v t="$rt" '$1 !~ /^#/ && $1 == r && $2 == p && $3 == t { print; exit }' "$roles")
  mreason=ROLE_PROFILE
  if [ -z "$row" ]; then
    row=$(awk -v r="$role" -v p="$profile" '$1 !~ /^#/ && $1 == r && $2 == p { print; exit }' "$roles"); mreason=ROLE_TIER_MAPPED
  fi
  [ -n "$row" ] || hard NO_ROLE_POLICY "no roles.conf line for $role/$profile"
  set -- $row; [ $# -eq 6 ] || die "malformed roles.conf line: $row"
  row_rt=$3 row_model=$4 row_effort=$5 floor=$6
  int "$floor" || die "roles.conf tier_floor must be an integer: $row"
  case "$row_model" in
    tier[0-9]) want=${row_model#tier} ;;
    *) want=$(model_tier "$row_rt" "$row_model") || die "roles.conf model $row_model is not a $row_rt model" ;;
  esac
  # hard floor first: a runtime that cannot reach it never serves the role (D7)
  top=$(model_tier "$rt" "$(nth "$(count "$ladder")" $ladder)")
  [ "$top" -ge "$floor" ] || hard CAPABILITY_FLOOR_UNMET "$role needs capability tier $floor; runtime $rt reaches $top"
  if [ "$row_rt" = "$rt" ] && idx "$row_model" $ladder >/dev/null; then model=$row_model
  else model=$(model_at_tier "$want") || hard NO_MODEL_AT_TIER "runtime $rt has no model of tier >= $want"; fi
  if [ "$(model_tier "$rt" "$model")" -lt "$floor" ]; then model=$(model_at_tier "$floor"); mreason="$mreason,RAISED_TO_FLOOR"; fi

  # effort: role effort, raised to the class floor, normalized to the runtime's scale
  ereason=ROLE_PROFILE
  ei=$(idx "$row_effort" $efforts) || ei=$(count "$efforts")
  [ "$(nth "$ei" $efforts)" = "$row_effort" ] || ereason="$ereason,CLAMPED_TO_RUNTIME_MAX"
  cf=$(kv "$class_line" effort) && cfi=$(idx "$cf" $efforts) && [ "$cfi" -gt "$ei" ] && { ei=$cfi; ereason="$ereason,CLASS_FLOOR"; }

  # operator overrides (hard limits still apply)
  if [ -n "$o_model" ]; then
    idx "$o_model" $ladder >/dev/null || reject UNKNOWN_MODEL "$o_model is not in the $rt ladder ($ladder)"
    [ "$(model_tier "$rt" "$o_model")" -ge "$floor" ] || hard CAPABILITY_FLOOR_UNMET "$o_model is below the tier floor $floor of $role"
    model=$o_model; mreason=OPERATOR_OVERRIDE
  fi
  if [ -n "$o_effort" ]; then
    idx "$o_effort" $forbidden >/dev/null && reject FORBIDDEN_EFFORT "$o_effort is forbidden by execution_policy.forbidden_efforts"
    ei=$(idx "$o_effort" $efforts) || reject UNKNOWN_EFFORT "$o_effort (runtime $rt supports: $efforts)"
    ereason=OPERATOR_OVERRIDE
  fi

  # escalation: any signal raises one step (model first, effort when the model is pinned or at the top)
  escalated=no xreason=NO_SIGNAL
  if [ -n "${signals# }" ]; then
    if [ "$used" -ge "$max_esc" ]; then xreason=ESCALATION_BUDGET_EXHAUSTED
    else
      mi=$(idx "$model" $ladder)
      if [ -z "$o_model" ] && [ "$mi" -lt "$(count "$ladder")" ]; then
        model=$(nth $((mi + 1)) $ladder); mreason="$mreason,ESCALATED"; escalated=yes xreason=ESCALATED_MODEL
      elif [ -z "$o_effort" ] && [ "$ei" -lt "$(count "$efforts")" ]; then
        ei=$((ei + 1)); ereason="$ereason,ESCALATED"; escalated=yes xreason=ESCALATED_EFFORT
      else xreason=AT_CEILING; fi
    fi
  fi
  effort=$(nth "$ei" $efforts)

  # context budget: class budget, halved for docs/small tiers; override; hard cap
  ctx=$(kv "$class_line" context_bytes) || die "class $class has no context_bytes"; creason=CLASS_BUDGET
  case "$tier" in docs|small) ctx=$((ctx / 2)); creason="$creason,TIER_$(echo "$tier" | tr '[:lower:]' '[:upper:]')" ;; esac
  if [ -n "$o_ctx" ]; then
    { int "$o_ctx" && [ "$o_ctx" -gt 0 ]; } || reject INVALID_OVERRIDE "context-bytes must be a positive integer"
    ctx=$o_ctx; creason=OPERATOR_OVERRIDE
  fi
  [ "$ctx" -le "$max_ctx" ] || { ctx=$max_ctx; creason="$creason,CAPPED_AT_HARD_LIMIT"; }

  sig=''; for s in $signals; do sig="${sig:+$sig,}$s"; done
  cat <<EOF
policy_version=$(cfg execution_policy revision)
role=$role
class=$class
tier=$tier
profile=$profile
profile_reason=$preason
runtime=$rt
runtime_reason=$rreason
model=$model
model_reason=$mreason
effort=$effort
effort_reason=$ereason
context_bytes=$ctx
context_reason=$creason
capability_tier=$(model_tier "$rt" "$model")
tier_floor=$floor
signals=${sig:-none}
escalated=$escalated
escalation_reason=$xreason
EOF
}

explain() {
  while IFS='=' read -r k v; do
    case "$k" in *_reason) ;; *) continue ;; esac
    for c in $(printf '%s' "$v" | tr ',' ' '); do
      case "$c" in
        OPERATOR_OVERRIDE) t="explicit operator override" ;; CONFIG_PROFILE) t="profile from config" ;;
        DEFAULT_PROFILE) t="no profile configured: balanced" ;; CONFIG_RUNTIME_ROLE) t="runtime from config runtime.roles.<role>" ;;
        CONFIG_RUNTIME_GROUP) t="runtime from config runtime.lead|worker|reviewers" ;; DEFAULT_RUNTIME) t="no runtime configured: claude" ;;
        ROLE_PROFILE) t="the role's model/effort for this profile (roles.conf)" ;; ROLE_TIER_MAPPED) t="no roles.conf line for this runtime: another runtime's line mapped by capability tier" ;;
        RAISED_TO_FLOOR) t="raised to the role's capability tier floor" ;; CLASS_FLOOR) t="raised to the task class's effort floor" ;;
        CLAMPED_TO_RUNTIME_MAX) t="role effort not on this runtime's scale: its maximum used" ;; ESCALATED) t="one step up after an escalation signal" ;;
        ESCALATED_MODEL) t="escalation signal: next model in the ladder" ;; ESCALATED_EFFORT) t="escalation signal: model pinned or at the top, next effort" ;;
        ESCALATION_BUDGET_EXHAUSTED) t="escalation signal ignored: budgets.max_escalations used up" ;; AT_CEILING) t="escalation signal ignored: model and effort at their ceiling or pinned" ;;
        NO_SIGNAL) t="no escalation signal" ;; CLASS_BUDGET) t="context budget of the task class" ;;
        TIER_DOCS|TIER_SMALL) t="docs/small tier: half the class context budget" ;; CAPPED_AT_HARD_LIMIT) t="bounded by execution_policy.max_context_bytes" ;;
        *) t="(no text for $c)" ;;
      esac
      printf '%s: %s - %s\n' "$k" "$c" "$t"
    done
  done
}

check_capabilities() {
  [ -f "$config" ] || die "config not found: $config"
  cache=${CODEX_MODELS_CACHE:-$HOME/.codex/models_cache.json}
  [ -f "$cache" ] || { echo "no local Codex model cache at $cache; nothing to verify against"; return 0; }
  command -v jq >/dev/null 2>&1 || { echo "jq not installed; codex ladder not verified"; return 0; }
  bad=0
  for m in $(cfg execution_policy providers codex models); do
    have=$(jq -r --arg m "$m" '[.models[]? | select(.slug == $m) | .supported_reasoning_levels[]?.effort] | join(",")' "$cache")
    if [ -z "$have" ]; then echo "MISSING model in local Codex cache: $m"; bad=1; continue; fi
    for e in $(cfg execution_policy providers codex efforts); do
      case ",$have," in *",$e,"*) ;; *) echo "UNSUPPORTED effort $e for $m (cache: $have)"; bad=1 ;; esac
    done
  done
  [ "$bad" -eq 0 ] && echo "codex ladder consistent with $cache"
  return "$bad"
}

case "${1:-}" in
  resolve) shift; resolve "$@" ;;
  explain) explain ;;
  check-capabilities) check_capabilities ;;
  runtime) [ $# -eq 2 ] || die "usage: $0 runtime <role>"; role_runtime "$(canon_role "$2")" ;;
  *) die "usage: $0 resolve|explain|check-capabilities|runtime <role> (tests: exec-policy-test.sh)" ;;
esac
