#!/bin/sh
# Tests for friction.sh (A152, A153): the anonymous friction report from a run's records, the approval before a
# send (gh is never started: PROOFLINE_GH points at echo), and the read-only calibration suggestions.
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents and base come from test-lib.sh
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
new_repo
cp "$tl_agents/scripts/friction.sh" .agents/scripts/
fixd=$tl_agents/../../tests/fixtures/friction
mkdir -p .agents/runs/RUN-001 .agents/local/metrics
cp "$fixd/LEDGER.log" .agents/runs/RUN-001/; cp "$fixd/records.jsonl" .agents/local/metrics/
F() { sh ./.agents/scripts/agent.sh friction "$@"; }
r=.agents/local/friction/latest.md

# a run shaped like a real failed one: 6 questions + 1 approval request, 4 QA failures, 3 fix rounds
F report RUN-001 > /dev/null || die "report failed"
grep -q 'total times the user was asked: 7' "$r" && grep -q 'questions asked: 6 (answered by the user: ' "$r" || die "user interruptions wrong: $(cat "$r")"
grep -q 'gate QA failed 4 times' "$r" && grep -q 'steps that returned blocked: 12' "$r" || die "gates or blocked steps wrong: $(cat "$r")"
grep -q 'runtime failovers: 1' "$r" && grep -q 'fix rounds used: 3' "$r" && grep -q 'delegated steps: 39' "$r" || die "rounds or failovers wrong"
grep -q 'tokens total: 52623 (1 of 47 records)' "$r" || die "tokens wrong: $(grep tokens "$r")"
grep -q 'RUN-001' "$r" && die "the run id leaked into the report"
grep -q '[/@~\\]' "$r" && die "a path or address character is in the report"
ok "friction report: counts from the TASK-001-shaped records, no run id, no path"

rm -f "$r"
git config user.name blocked   # a word the report text contains
expect_msg "scrub refuses a report that mentions the repository user" "not written" F report RUN-001
[ ! -e "$r" ] || die "a report that failed the scrub was written"
git config --unset user.name
F report RUN-001 > /dev/null
ok "scrub: a report mentioning the repository user is not written"

# sending: nothing without the user's approval; the printed command; single use
exp='gh issue create --repo furkansarikaya/proofline --title "proofline friction report" --body-file .agents/local/friction/latest.md'
[ "$(F issue-cmd)" = "$exp" ] || die "issue-cmd printed: $(F issue-cmd)"
expect_msg "send without approval" "nothing sent" env PROOFLINE_GH=false sh ./.agents/scripts/agent.sh friction send
A request-approval - report > /dev/null; capture 'approve the report'; A approve - report > /dev/null
[ "$(env PROOFLINE_GH=echo sh ./.agents/scripts/agent.sh friction send | tail -1)" = "issue create --repo furkansarikaya/proofline --title proofline friction report --body-file .agents/local/friction/latest.md" ] || die "send ran another command"
expect_msg "approval is single use" "nothing sent" env PROOFLINE_GH=false sh ./.agents/scripts/agent.sh friction send
A request-approval - report > /dev/null; capture 'approve the report'; A approve - report > /dev/null
echo 'changed' >> "$r"
expect_msg "an edited report is not covered by the approval" "nothing sent" env PROOFLINE_GH=false sh ./.agents/scripts/agent.sh friction send
ok "send: approval first, bound to the report hash, single use; the printed command is the one that runs"

# calibration: suggestions only
{ printf '## Tests\n'; i=1; while [ "$i" -le 25 ]; do printf -- '- AC-%s: x\n' "$i"; i=$((i + 1)); done; } > .agents/runs/RUN-001/PLAN.md
cp .agents/config.yaml "$base/config.before"
c=$(sh ./.agents/scripts/agent.sh calibrate)
printf '%s' "$c" | grep -q 'suggest: test_trust.mutation_budget 25' || die "no budget suggestion: $c"
printf '%s' "$c" | grep -q 'suggest: dispatch.timeout_seconds 3600' || die "no timeout suggestion: $c"
cmp -s .agents/config.yaml "$base/config.before" || die "calibrate changed the config"
ok "calibrate: budget below the criteria count and a slow dispatch give suggestions; config untouched"
