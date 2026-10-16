#!/bin/sh
# question-open.sh LAST_MESSAGE_FILE: reads the output of `agent.sh next <ID>` on stdin; exits 0 when a question
# is open (the run names a pending question, or the lead's last message asks one: it holds a question mark),
# 1 otherwise. The harness sends the scripted question reply only then (A120): a lead that stopped on a request
# only the user can fulfil (delete a file, run a command) gets no reply, because no reply changes that.
last=${1:-/dev/null}
state=$(cat)
printf '%s\n' "$state" | grep -q 'a question is pending' && exit 0
grep -q '[?？]' "$last" 2>/dev/null
