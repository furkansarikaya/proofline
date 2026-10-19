#!/bin/sh
# shellcheck disable=SC2016 # literal command text
# Kill guard tests (A156): the PreToolUse hook denies pkill, killall and kill by pattern or mass kill, and allows
# kill of a PID the agent holds. The hook receives only the agent's own tool calls: a command the user types with `!`
# in the terminal never reaches PreToolUse, so none of this affects the user's own commands.
set -u
repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
hook=$repo/adapters/claude/hooks/proofline-hook.sh
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-kill.XXXXXX") || { echo "kill-guard: TMPDIR must be an existing directory" >&2; exit 2; }
trap 'rm -rf "$base"' EXIT
die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
command -v jq >/dev/null 2>&1 || { echo "kill-guard: jq is required"; exit 2; }
proj=$base/proj; mkdir -p "$proj"
git -C "$proj" init -q -b main 2>/dev/null || { git -C "$proj" init -q; git -C "$proj" checkout -q -b main; }
jstr() { printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) print "\\n"; print }'; }
pre() { printf '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$proj" "$(jstr "$1")" | sh "$hook" pretool claude; }
denies() { out=$(pre "$1"); printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "not denied: $1 -> $out"; printf '%s' "$out" | grep -Fq 'A156' || die "denial is not the kill guard: $1 -> $out"; }
allows() { out=$(pre "$1"); ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "denied: $1 -> $out"; }

denies 'pkill node'; denies 'killall node'; denies 'kill -1'; denies 'kill 0'; denies 'kill -9 -- -1'
denies 'kill $(pgrep node)'; denies 'pgrep node | xargs kill'; denies 'sudo killall node'; denies 'bash -c "pkill node"'
ok "pkill, killall, kill -1, kill 0, kill -9 -- -1, kill \$(pgrep), pgrep | xargs kill, sudo killall and bash -c pkill are denied"
allows 'kill 1234'; allows 'kill -TERM $PID'; allows 'kill -9 $!'; allows 'echo pkill'; allows 'grep pkill file'; allows 'npm run skill'
ok "kill <pid>, kill -TERM \$PID, kill -9 \$!, echo pkill, grep pkill file and npm run skill are allowed"
# installed project: the guard runs there too
mkdir -p "$proj/.agents/scripts"; : > "$proj/.agents/config.yaml"; printf 'echo main\n' > "$proj/.agents/scripts/agent.sh"
denies 'pkill node'; allows 'kill 1234'; ok "the guard also runs in an installed project"
echo "kill guard tests passed"
