#!/bin/sh
# Checks that every state built by setup.sh is real: `agent.sh next LK-7` prints the expected first step.
# Usage: sh selfcheck.sh <dir-built-by-setup.sh>   (all states, as tests/fixtures/check-fixtures.sh builds them)
set -eu
[ $# -eq 1 ] || { echo "usage: sh selfcheck.sh <dir>" >&2; exit 2; }
GIT_CONFIG_GLOBAL=/dev/null; GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
unset AGENT_ROLE 2>/dev/null || true
rc=0
want() { # STATE EXPECTED-FIRST-NEXT [PIPELINE-LINE]; a state that was not built is skipped (PROOFLINE_SLOW_TESTS unset)
  if [ ! -d "$1/$2" ]; then echo "SKIP $2 (not built)"; return 0; fi
  got=$(cd "$1/$2" && sh .agents/scripts/agent.sh next LK-7 | sed -n 's/^next=//p' | head -1)
  if [ "$got" != "$3" ]; then echo "FAIL $2: next is '$got', want '$3'"; rc=1; return 0; fi
  if [ -n "${4:-}" ] && ! (cd "$1/$2" && sh .agents/scripts/agent.sh pipeline LK-7 | grep -qx "$4"); then echo "FAIL $2: pipeline lacks $4"; rc=1; return 0; fi
  echo "PASS $2"
}
want "$1" review-rules-fail 'agent.sh handoff LK-7 IMPLEMENTING (fix round 1; findings of: REVIEW_RULES)' 'gate.REVIEW_RULES=fail'
want "$1" needs-input 'agent.sh questions LK-7'
want "$1" destructive-approval 'agent.sh request-approval LK-7 destructive (relay verbatim)'
want "$1" security-pass-low 'dispatch.sh LK-7 security_reviewer' 'gate.SECURITY=pass_low'
want "$1" fix-rounds-exhausted 'agent.sh terminate LK-7 FAILED (reason and evidence on stdin)' 'fix_round=3'
exit $rc
