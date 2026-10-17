#!/bin/sh
# Self-test of tests/e2e/pending-kind.sh: the harness answers a plan approval and nothing else.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
k() { printf '%s\n' "$1" | sh "$here/pending-kind.sh"; }
check() { [ "$(k "$2")" = "$3" ] && echo "ok $1" || { echo "FAIL: $1 (got '$(k "$2")', want '$3')" >&2; exit 1; }; }
check "a requested plan approval" 'next=agent.sh request-approval LC plan (relay verbatim)
reason=plan approval required before freeze' plan
check "a plan approval waiting for the user's reply" "next=wait for the user's answer (the runtime records it from their reply; the lead never runs approve), then: agent.sh next LC
reason=plan approval required before freeze" plan
check "a destructive approval" 'next=agent.sh request-approval LC destructive (relay verbatim)
reason=destructive approval required before IMPLEMENT' destructive
check "a single-step approval" 'reason=single_step approval required before IMPLEMENT' single_step
check "a scope approval" 'next=agent.sh request-approval LC scope (relay verbatim)' scope
check "the delivery commit approval" "next=agent.sh request-approval LC commit (delivery needs the user's approval)
reason=run DONE" commit
check "a waiver approval" 'next=agent.sh request-approval LC waive:REVIEW_RULES-1 (relay verbatim)' waive:REVIEW_RULES-1
check "no approval pending" 'next=agent.sh freeze LC
reason=artifacts ready' ''
echo "pending-kind tests passed"
# A120: the scripted question reply is sent only while a question is open.
t=$(mktemp -d "${TMPDIR:-/tmp}/qopen.XXXXXX"); trap 'rm -rf "$t"' EXIT
qo() { printf '%s\n' "$2" | sh "$here/question-open.sh" "$t/last" ${4:-} && got=open || got=none; [ "$got" = "$3" ] && echo "ok $1" || { echo "FAIL: $1 (got $got, want $3)" >&2; exit 1; }; }
printf 'Which option do you prefer?\n' > "$t/last"; qo "the lead asks a question" 'next=agent.sh handoff LC IMPLEMENTING' open
printf 'Please run rm .agents/x and tell me when it is gone.\n' > "$t/last"; qo "the lead waits for a user action, no question" 'next=agent.sh handoff LC IMPLEMENTING' none
qo "a pending question named by next" 'next=agent.sh questions LC
reason=a question is pending (a specialist NEEDS_INPUT)' open
# A131: a question mark in an explanation is no open question while the run names a step of its own.
printf 'Why is AS-2 unsettled? A blanket reply cannot settle it. Reply accept AS-2.\n' > "$t/last"
qo "a question mark with a named run step is no open question" 'next=agent.sh verify-assumptions T-1' none T-1
qo "a question mark before any task is a question" '' open none
qo "a question mark with no agent.sh step is a question" 'reason=waiting' open T-1
qo "a pending question wins over a named step" 'next=agent.sh questions T-1
reason=a question is pending (a specialist NEEDS_INPUT)' open T-1
echo "question-open tests passed"
# A128: a refreeze asks a second plan approval while `next` prints the fix-round step (run B1-COMPLEX).
ak() { printf '%s\n' "$2" | sh "$here/pending-kind.sh" "$t/approvals"; }
acheck() { [ "$(ak "$1" "$2")" = "$3" ] && echo "ok $1" || { echo "FAIL: $1 (got '$(ak "$1" "$2")', want '$3')" >&2; exit 1; }; }
fix='next=agent.sh handoff T-1 IMPLEMENTING (fix round 2)
reason=failing gates: REVIEW_RULES REVIEW_TESTS'
mkdir "$t/approvals"; : > "$t/approvals/001-request-plan.yaml"; : > "$t/approvals/002-plan.yaml"
acheck "an answered plan approval is not pending" "$fix" ''
: > "$t/approvals/003-request-plan.yaml"
acheck "the second plan approval after an amendment" "$fix" plan
: > "$t/approvals/004-plan.yaml"; : > "$t/approvals/005-request-commit.yaml"
acheck "a commit request is never mistaken for a plan" "$fix" commit
acheck "next naming an approval wins" 'next=agent.sh request-approval T-1 scope (relay verbatim)' scope
# Every kind agent.sh can request, as the file slug it writes (kind_slug: ':' becomes '-'), maps back to its kind.
for pair in destructive:destructive single_step:single_step scope:scope budget:budget commit:commit push:push waive-F-1:waive:F-1; do
  rm -f "$t"/approvals/*; : > "$t/approvals/001-request-plan.yaml"; : > "$t/approvals/002-plan.yaml"
  : > "$t/approvals/003-request-${pair%%:*}.yaml"
  acheck "a pending ${pair%%:*} file is read as ${pair#*:}" "$fix" "${pair#*:}"
done
# What the harness does with each kind (reply-decision.sh): only exactly `plan` is answered as an approval.
dec() { printf '%s\n' "$3" | sh "$here/reply-decision.sh" "$2" > "$t/dec"; [ "$(cat "$t/dec")" = "$4" ] && echo "ok $1" || { echo "FAIL: $1 (got '$(cat "$t/dec")', want $4)" >&2; exit 1; }; }
dec "plan is answered" plan '' plan
for k in destructive single_step scope budget commit push waive:F-1 waive-F-1 unknown; do dec "$k is never answered" "$k" '' stop; done
dec "a question gets the scripted reply" '' 'Which option do you prefer?' question
acc='   accepted answers: approve, yes, commit it, push it (with the kind word)'
tr_acc='   kabul edilen onay sözcükleri: approve, evet, commit it, push it (tür sözcüğüyle birlikte)'
dec "the English accepted-answers line is no commit request" '' "$acc" question
dec "the Turkish accepted-answers line is no commit request" '' "$tr_acc" question
dec "a real sentence next to the list still counts" '' "$acc
Please commit it now." stop
echo "reply-decision tests passed"
echo "approvals-dir tests passed"
