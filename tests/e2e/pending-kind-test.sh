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
