#!/bin/sh
# pending-kind.sh [APPROVALS_DIR]: reads the output of `agent.sh next <ID>` on stdin and prints the approval kind the
# run waits for (plan, destructive, single_step, scope, budget, commit, push, waive:<ID>), or nothing. POSIX awk
# only: BSD sed has no `\|` alternation (the first version of the harness silently never saw a plan approval on macOS).
# A128: when `next` names no approval and APPROVALS_DIR is given, the newest file there, if it is
# `NNN-request-<kind>.yaml`, is a request nobody answered: a refreeze after an amendment asks for a plan approval
# again while `next` still prints the fix-round step.
kind=$(awk '
/request-approval [^ ]+ (plan|destructive|single_step|scope|budget|commit|push|waive:[^ ]+)/ {
  for (i = 1; i <= NF; i++) if ($i == "request-approval") { print $(i + 2); exit }
}
/^reason=/ {
  r = $0; sub(/^reason=/, "", r); n = split(r, a, " ")
  if (n >= 2 && a[2] == "approval") { print a[1]; exit }
}')
if [ -z "$kind" ] && [ -d "${1:-}" ]; then
  newest=$(ls "$1" 2>/dev/null | sort | tail -1)
  case $newest in
    [0-9]*-request-*.yaml) kind=${newest#*-request-}; kind=${kind%.yaml} ;;
  esac
fi
[ -z "$kind" ] || printf '%s\n' "$kind"
exit 0
