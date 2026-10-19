#!/bin/sh
# shellcheck disable=SC2016 # literal command text
# Kill guard tests (A156): the PreToolUse hook denies pkill, killall and kill by pattern or mass kill, and allows
# kill of a PID the agent holds. The hook receives only the agent's own tool calls: a command the user types with `!`
# in the terminal never reaches PreToolUse, so none of this affects the user's own commands.
# One selftest unit per scenario (LC_EXACT names one; see tests/selftest.sh).
set -u
repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
hook=$repo/adapters/claude/hooks/proofline-hook.sh
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-kill.XXXXXX") || { echo "kill-guard: TMPDIR must be an existing directory" >&2; exit 2; }
trap 'rm -rf "$base"' EXIT
die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok $*"; }
command -v jq >/dev/null 2>&1 || { echo "kill-guard: jq is required"; exit 2; }
proj=$base/proj; mkdir -p "$proj"
git -C "$proj" init -q -b main 2>/dev/null || { git -C "$proj" init -q; git -C "$proj" checkout -q -b main; }
jstr() { printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) print "\\n"; print }'; }
pre() { printf '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$proj" "$(jstr "$1")" | sh "$hook" pretool claude; }
denies() { out=$(pre "$1"); printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "not denied: $1 -> $out"; printf '%s' "$out" | grep -Fq 'A156' || die "denial is not the kill guard: $1 -> $out"; }
allows() { out=$(pre "$1"); ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "denied: $1 -> $out"; }

scenarios='denied allowed signal_zero quoted_text quoted_substitution installed'
for sc in $scenarios; do
  [ -z "${LC_EXACT:-}" ] || [ "$LC_EXACT" = "$sc" ] || continue
  case "$sc" in
  denied)
    denies 'pkill node'; denies 'killall node'; denies 'kill -1'; denies 'kill 0'; denies 'kill -9 -- -1'
    denies 'kill $(pgrep node)'; denies 'pgrep node | xargs kill'; denies 'sudo killall node'; denies 'bash -c "pkill node"'
    ok "pkill, killall, kill -1, kill 0, kill -9 -- -1, kill \$(pgrep), pgrep | xargs kill, sudo killall and bash -c pkill are denied" ;;
  allowed)
    allows 'kill 1234'; allows 'kill -TERM $PID'; allows 'kill -9 $!'; allows 'echo pkill'; allows 'grep pkill file'; allows 'npm run skill'
    ok "kill <pid>, kill -TERM \$PID, kill -9 \$!, echo pkill, grep pkill file and npm run skill are allowed" ;;
  signal_zero)   # kill -0 PID only tests that a process exists; kill 0 / -1 / -- 0 signal everything
    allows 'kill -0 1234'; allows 'kill -0 $!'; allows 'while kill -0 $PID 2>/dev/null; do sleep 1; done'
    allows 'kill -s 0 $PID'; allows 'kill -n 0 $PID'; allows 'sh -c "kill -0 $PID"'
    denies 'kill 0'; denies 'kill -1'; denies 'kill -TERM 0'; denies 'kill -- 0'; denies 'kill -9 -- -1'
    denies 'kill $(pgrep node)'; denies 'pgrep x | xargs -r kill'; denies 'pkill node'
    ok "kill -0 / -s 0 / -n 0 with a PID is allowed; kill 0, -1, -TERM 0, -- 0 and the pattern forms are denied" ;;
  quoted_text)   # kill text inside a commit message, a heredoc, a PR body or a help/lookup call is not a kill
    allows 'git commit -m "docs: kill $(pgrep node) is denied"'
    allows "$(printf 'git commit -F - <<EOF\ndocs: kill $(pgrep node) is denied\nEOF')"
    allows 'gh pr create --title t --body "text: kill $(pgrep x) and pkill x are denied"'
    allows 'command -v killall'; allows 'pkill --help'
    ok "kill text in a commit message, a heredoc and a PR body, command -v killall and pkill --help are allowed" ;;
  quoted_substitution)   # a double-quoted process-search substitution is still a kill by pattern
    denies 'kill -9 "$(lsof -ti :3000)"'; denies 'kill "$(pgrep x)"'; denies 'kill -TERM "$(pgrep x)"'
    denies 'kill -9 -- "$(pgrep x)"'; denies 'kill -s TERM "$(pgrep x)"'; allows 'kill "$(cat app.pid)"'
    ok "kill with a quoted \$(pgrep) or \$(lsof) substitution is denied, kill \"\$(cat app.pid)\" is allowed" ;;
  installed)   # the guard runs in an installed project too
    mkdir -p "$proj/.agents/scripts"; : > "$proj/.agents/config.yaml"; printf 'echo main\n' > "$proj/.agents/scripts/agent.sh"
    denies 'pkill node'; allows 'kill 1234'; ok "the guard also runs in an installed project" ;;
  esac
done
echo "kill guard tests passed"
