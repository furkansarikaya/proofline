#!/bin/sh
# shellcheck disable=SC2086 # $base is split on purpose
# Tests for exec-policy.sh: pure resolver, no model call, no run state. Prints PASS/FAIL per case.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
ep="$here/exec-policy.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/exec-policy-test.XXXXXX") || { echo "TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }; trap 'rm -rf "$tmp"' EXIT
fails=0
# Fixture roles policy (the shipped roles.conf is generated; it is checked separately below).
# Claude rows use model names, codex rows tierN tokens: role balanced max economy (model:effort) floor
fixture_roles() {
  while read -r fr_r fr_b fr_m fr_e fr_f; do
    for fr_p in balanced:$fr_b max:$fr_m economy:$fr_e; do
      fr_pm=${fr_p#*:}; fr_mo=${fr_pm%%:*} fr_ef=${fr_pm#*:}
      case $fr_mo in haiku) fr_t=tier1 ;; sonnet) fr_t=tier2 ;; *) fr_t=tier3 ;; esac
      fr_ce=$fr_ef
      echo "$fr_r ${fr_p%%:*} claude $fr_mo $fr_ef $fr_f"; echo "$fr_r ${fr_p%%:*} codex $fr_t $fr_ce $fr_f"
    done
  done <<'X'
architect opus:high opus:xhigh sonnet:high 2
designer sonnet:medium opus:high sonnet:low 1
explorer sonnet:medium opus:medium haiku:low 1
implementer sonnet:high opus:high sonnet:medium 2
reviewer sonnet:high opus:max sonnet:medium 2
security_reviewer opus:high opus:xhigh opus:high 3
verifier sonnet:medium opus:high haiku:medium 1
X
}

{ awk '/^(execution_policy|capabilities|dispatch):/ { p = 1; print; next } /^[^ #]/ { p = 0 } p' "$here/../config.yaml"
  printf 'profile: balanced\nruntime:\n  lead: claude\n  worker: codex\n  reviewers: claude\n  roles:\n    verifier: codex\nbudgets:\n  max_escalations: 2\n'
} > "$tmp/config.yaml"
fixture_roles > "$tmp/fixture-roles.conf"
export EXEC_POLICY_CONFIG="$tmp/config.yaml" EXEC_POLICY_ROLES="$tmp/fixture-roles.conf"

# res ARGS... : stdout in $out, exit code in $rc, stderr in $err
# res [VAR=VALUE]... ARGS... (leading assignments apply to this call only)
res() {
  r_env=''; while [ $# -gt 0 ]; do case "$1" in [A-Z]*=*) r_env="$r_env $1"; shift ;; *) break ;; esac; done
  rc=0; out=$(env $r_env sh "$ep" resolve "$@" 2>"$tmp/err") || rc=$?; err=$(cat "$tmp/err")
}
f() { printf '%s\n' "$out" | sed -n "s/^$1=//p"; }
# check NAME EXPECTED-RC [key=value | reason~CODE | err~TEXT]...
check() {
  c_name=$1 c_rc=$2; shift 2; c_ok=yes
  [ "$rc" -eq "$c_rc" ] || { c_ok=no; echo "  $c_name: exit $rc, want $c_rc ($err)"; }
  for c in "$@"; do
    case "$c" in
      err~*) case "$err" in *"${c#err~}"*) ;; *) c_ok=no; echo "  $c_name: stderr lacks '${c#err~}': $err" ;; esac ;;
      *~*) k=${c%%~*}; case ",$(f "$k")," in *",${c#*~},"*) ;; *) c_ok=no; echo "  $c_name: $k lacks ${c#*~} (got '$(f "$k")')" ;; esac ;;
      *=*) k=${c%%=*}; [ "$(f "$k")" = "${c#*=}" ] || { c_ok=no; echo "  $c_name: $k='$(f "$k")', want '${c#*=}'" ; } ;;
    esac
  done
  if [ "$c_ok" = yes ]; then echo "PASS $c_name"; else echo "FAIL $c_name"; fails=$((fails + 1)); fi
}
base='--class STANDARD --tier full'

res --role reviewer $base
check "balanced reviewer uses sonnet on claude (runtime from group)" 0 runtime=claude runtime_reason=CONFIG_RUNTIME_GROUP model=sonnet effort=high capability_tier=2 escalated=no profile=balanced profile_reason=CONFIG_PROFILE
res --role architect $base
check "balanced architect uses the top tier" 0 runtime=codex model=gpt-6-astra
res --role architect $base --runtime claude
check "runtime override wins over config" 0 runtime=claude runtime_reason=OPERATOR_OVERRIDE model=opus
res --role verifier $base
check "per-role runtime from config" 0 runtime=codex runtime_reason=CONFIG_RUNTIME_ROLE model=gpt-6-sol
res --role implementer $base
check "codex worker reads the ladder from config" 0 runtime=codex model=gpt-6-sol capability_tier=2
res --role implementation_worker $base
check "source role alias resolves" 0 role=implementer

for p in balanced max economy; do
  for r in claude codex; do
    res --role security_reviewer $base --profile "$p" --runtime "$r"
    check "security_reviewer is tier 3 ($p/$r)" 0 capability_tier=3 tier_floor=3
  done
done
res --role reviewer $base --profile economy
check "economy reviewer is not opus" 0 model=sonnet
res --role explorer $base --profile economy --runtime claude
check "economy explorer uses haiku" 0 model=haiku capability_tier=1
res --role reviewer $base --profile max
check "max profile is opus-heavy" 0 model=opus effort=max
res --role reviewer $base --profile max --runtime codex
check "effort above the runtime scale is clamped" 0 model=gpt-6-astra effort=xhigh

res --role explorer --class CRITICAL --tier full --runtime claude
check "CRITICAL adds critical_class, raises effort floor and escalates" 0 signals~critical_class effort_reason~CLASS_FLOOR effort=high escalated=yes model=opus
res --role reviewer $base --signal low_confidence_pass
check "signal escalates one model step" 0 model=opus escalated=yes escalation_reason=ESCALATED_MODEL model_reason~ESCALATED
res --role reviewer $base --signal low_confidence_pass --signal large_diff
check "several signals still escalate one step" 0 model=opus
res --role security_reviewer $base --signal fix_round_2
check "escalation at the ladder top raises effort" 0 model=opus effort=xhigh escalation_reason=ESCALATED_EFFORT
res --role reviewer $base --signal recent_fail_same_focus --escalations-used 2
check "escalation bounded by budgets.max_escalations" 0 model=sonnet escalated=no escalation_reason=ESCALATION_BUDGET_EXHAUSTED
res --role implementer $base --runtime claude --signal ui_persuade
check "ui_persuade puts the implementer on the strongest model without an escalation" 0 model=opus model_reason~UI_PERSUADE_STRONGEST escalated=no signals=ui_persuade
res --role designer $base --runtime claude --signal ui_persuade
check "ui_persuade puts the designer on the strongest model" 0 model=opus model_reason~UI_PERSUADE_STRONGEST escalated=no
res --role designer $base --runtime claude
check "without the signal the designer keeps its profile model" 0 model=sonnet escalated=no
res --role reviewer $base --runtime claude --signal ui_persuade
check "ui_persuade changes no other role" 0 model=sonnet escalated=no
res --role implementer $base --runtime claude --signal ui_persuade --model sonnet
check "an explicit model override beats ui_persuade" 0 model=sonnet model_reason=OPERATOR_OVERRIDE
res --role reviewer $base --signal nonsense
check "unknown signal is a usage error" 2 err~unknown signal

res --role reviewer $base --model opus --effort low
check "valid override beats task policy" 0 model=opus model_reason=OPERATOR_OVERRIDE effort=low effort_reason=OPERATOR_OVERRIDE
res --role reviewer $base --model gpt-nope
check "unknown model override rejected" 3 err~UNKNOWN_MODEL
res --role reviewer $base --effort ultra
check "forbidden effort override rejected" 3 err~FORBIDDEN_EFFORT
res --role reviewer $base --runtime codex --effort max
check "effort the runtime lacks rejected" 3 err~UNKNOWN_EFFORT
res --role reviewer $base --profile cheap
check "invalid profile override rejected" 3 err~INVALID_PROFILE
res --role security_reviewer $base --model sonnet
check "override below the tier floor is unresolvable" 4 err~CAPABILITY_FLOOR_UNMET
res --role reviewer $base --model sonnet --signal fix_round_2
check "pinned model escalates effort instead" 0 model=sonnet effort=xhigh escalation_reason=ESCALATED_EFFORT

res --role reviewer --class STANDARD --tier small
check "small tier halves the class context" 0 context_bytes=24576 context_reason~TIER_SMALL
res --role reviewer $base --context-bytes 999999999
check "context override capped at the hard limit" 0 context_bytes=262144 context_reason~CAPPED_AT_HARD_LIMIT
res --role reviewer $base --context-bytes many
check "invalid context override rejected" 3 err~INVALID_OVERRIDE

sed 's/^      models: gpt-6-luna gpt-6-sol gpt-6-astra$/      models: gpt-6-luna gpt-6-sol/' "$tmp/config.yaml" > "$tmp/weak.yaml"
res EXEC_POLICY_CONFIG="$tmp/weak.yaml" --role security_reviewer $base --runtime codex
check "runtime without a tier-3 model cannot serve security_reviewer" 4 err~CAPABILITY_FLOOR_UNMET
res EXEC_POLICY_CONFIG="$tmp/weak.yaml" --role architect $base --runtime codex
check "role model above the runtime top is unresolvable" 4 err~NO_MODEL_AT_TIER
res --role reviewer $base --runtime nosuch
check "runtime without a ladder is unresolvable" 4 err~NO_LADDER
grep -v '^reviewer balanced codex' "$EXEC_POLICY_ROLES" > "$tmp/roles.conf"
res EXEC_POLICY_ROLES="$tmp/roles.conf" --role reviewer $base --runtime codex
check "missing runtime row is mapped by capability tier" 0 model=gpt-6-sol model_reason=ROLE_TIER_MAPPED
res --role wizard $base
check "unknown role is a usage error" 2 err~unknown role
res --role reviewer --class HUGE --tier full
check "unknown class is a usage error" 2 err~classes

res --role reviewer $base
o1=$out; res --role reviewer $base
if [ "$o1" = "$out" ]; then echo "PASS resolution is deterministic"; else echo "FAIL resolution is deterministic"; fails=$((fails + 1)); fi
x=$(printf '%s\n' "$out" | sh "$ep" explain)
case "$x" in *"model_reason: ROLE_PROFILE"*) echo "PASS explain maps reason codes" ;; *) echo "FAIL explain maps reason codes"; fails=$((fails + 1)) ;; esac
printf '{"models":[{"slug":"gpt-6-luna","supported_reasoning_levels":[{"effort":"low"}]}]}' > "$tmp/cache.json"
rc=0; x=$(CODEX_MODELS_CACHE="$tmp/cache.json" sh "$ep" check-capabilities) || rc=$?
if ! command -v jq >/dev/null 2>&1; then echo "PASS check-capabilities without jq (skipped)"
else case "$rc:$x" in 1:*"MISSING model in local Codex cache: gpt-6-sol"*) echo "PASS check-capabilities flags a ladder gap" ;; *) echo "FAIL check-capabilities flags a ladder gap"; fails=$((fails + 1)) ;; esac; fi

# the shipped (generated) roles.conf: every role, profile and runtime resolves; security stays tier 3
bad=''
for r in lead task_author explorer architect data_architect designer qa implementer reviewer security_reviewer verifier; do
  for pr in balanced max economy; do
    for rt in claude codex; do
      res EXEC_POLICY_ROLES="$here/../roles.conf" --role "$r" $base --profile "$pr" --runtime "$rt"
      [ "$rc" -eq 0 ] || bad="$bad $r/$pr/$rt"
      [ "$r" != security_reviewer ] || [ "$(f capability_tier)" = 3 ] || bad="$bad $r/$pr/$rt:tier"
      [ "$pr" != economy ] || [ "$r" = security_reviewer ] || [ "$(f model)" != opus ] || bad="$bad $r/economy:opus"
    done
  done
done
if [ -z "$bad" ]; then echo "PASS shipped roles.conf resolves for all roles, profiles and runtimes"; else echo "FAIL shipped roles.conf:$bad"; fails=$((fails + 1)); fi

# `runtime <role>` is the one role -> runtime table (agent.sh role_runtime calls it); it agrees with resolve.
want='lead:claude task_author:codex explorer:codex architect:codex data_architect:codex designer:codex implementer:codex qa:claude reviewer:claude security_reviewer:claude verifier:codex full_lifecycle:claude'
bad=''
for w in $want; do got=$(sh "$ep" runtime "${w%%:*}" 2>&1); [ "$got" = "${w#*:}" ] || bad="$bad ${w%%:*}=$got"; done
for r in explorer architect implementer reviewer security_reviewer verifier; do
  res --role "$r" $base; [ "$(f runtime)" = "$(sh "$ep" runtime "$r")" ] || bad="$bad $r:resolve=$(f runtime)"
done
if [ -z "$bad" ]; then echo "PASS runtime <role>: group mapping and per-role override, same as resolve"; else echo "FAIL runtime <role>:$bad"; fails=$((fails + 1)); fi

# A135: a lead runs on the base model (execution_policy.lead_base_model) or stronger; workers are not bound by it.
cl() { rc=0; out=$(sh "$ep" check-lead "$@" 2>&1) || rc=$?; }
cl_check() { if [ "$rc" -eq "$1" ] && case "$out" in *"$3"*) true ;; *) false ;; esac; then echo "PASS $2"; else echo "FAIL $2: exit $rc, want $1 ($out)"; fails=$((fails + 1)); fi; }
cl --runtime codex --model gpt-6-luna; cl_check 3 "lead + cheapest model is refused and names the base model" "gpt-6-sol"
cl --runtime codex --model gpt-6-sol; cl_check 0 "lead + base model is accepted" ""
cl --runtime codex --model gpt-6-astra; cl_check 0 "lead + stronger than base is accepted" ""
cl --runtime codex --model nope; cl_check 3 "lead + unknown model is refused" "UNKNOWN_MODEL"
cl --runtime codex; cl_check 3 "lead + unset model is refused (LEAD_MODEL_UNSET)" "LEAD_MODEL_UNSET"
[ "$(sh "$ep" lead-base codex)" = gpt-6-sol ] && echo "PASS lead-base prints the configured base" || { echo "FAIL lead-base"; fails=$((fails + 1)); }
# An installed config without the key still enforces: the base is derived from the ladder and the lead tier floor.
grep -v 'lead_base_model:\|^    codex: gpt-6-sol$' "$tmp/config.yaml" > "$tmp/nokey.yaml"
rc=0; out=$(EXEC_POLICY_CONFIG="$tmp/nokey.yaml" sh "$ep" check-lead --runtime codex --model gpt-6-luna 2>&1) || rc=$?; cl_check 3 "no lead_base_model key: the cheapest lead is still refused" "gpt-6-sol"
rc=0; out=$(EXEC_POLICY_CONFIG="$tmp/nokey.yaml" sh "$ep" check-lead --runtime codex --model gpt-6-sol 2>&1) || rc=$?; cl_check 0 "no lead_base_model key: the derived base is accepted" ""
cl --runtime claude --model haiku; cl_check 0 "no base model configured for claude: unchanged" ""
res EXEC_POLICY_ROLES="$here/../roles.conf" --role explorer $base --profile economy --runtime codex --model gpt-6-luna
check "worker + explicit cheapest model is accepted" 0 model=gpt-6-luna
res EXEC_POLICY_ROLES="$here/../roles.conf" --role lead $base --runtime codex --model gpt-6-luna
check "resolve refuses a lead on the cheapest model" 4 err~CAPABILITY_FLOOR_UNMET
for p in balanced max economy; do
  res EXEC_POLICY_ROLES="$here/../roles.conf" --role lead $base --profile "$p" --runtime codex
  want_tier=3; [ "$p" != economy ] || want_tier=2
  check "shipped lead row is the base model or stronger ($p)" 0 "capability_tier=$want_tier"
done

[ "$fails" -eq 0 ]
