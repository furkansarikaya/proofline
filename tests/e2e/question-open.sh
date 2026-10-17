#!/bin/sh
# question-open.sh LAST_MESSAGE_FILE [TASK_ID]: reads the output of `agent.sh next <ID>` on stdin; exits 0 when a
# question is open, 1 otherwise. Open = the run names a pending question, or the lead's last message asks one (it
# holds a question mark) while the run has no step of its own to take: no task yet (the intent-grill question is chat
# only) or `next` names no `agent.sh` step (A131). A lead whose message holds a question mark but whose run names a
# concrete step (e.g. `agent.sh verify-assumptions`) has explained, not asked: the answered questions are done and a
# reply changes nothing. The harness sends the scripted question reply only then (A120).
last=${1:-/dev/null}; id=${2:-none}
state=$(cat)
printf '%s\n' "$state" | grep -q 'a question is pending' && exit 0
case $id in ''|none) ;; *) printf '%s\n' "$state" | grep -q '^next=agent\.sh ' && exit 1 ;; esac
grep -q '[?？]' "$last" 2>/dev/null
