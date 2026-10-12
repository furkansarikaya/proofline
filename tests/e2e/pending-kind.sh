#!/bin/sh
# pending-kind.sh: reads the output of `agent.sh next <ID>` on stdin and prints the approval kind the run waits
# for (plan, destructive, single_step, scope, budget, commit, push, waive:<ID>), or nothing. POSIX awk only: BSD
# sed has no `\|` alternation (the first version of the harness silently never saw a plan approval on macOS).
awk '
/request-approval [^ ]+ (plan|destructive|single_step|scope|budget|commit|push|waive:[^ ]+)/ {
  for (i = 1; i <= NF; i++) if ($i == "request-approval") { print $(i + 2); exit }
}
/^reason=/ {
  r = $0; sub(/^reason=/, "", r); n = split(r, a, " ")
  if (n >= 2 && a[2] == "approval") { print a[1]; exit }
}'
