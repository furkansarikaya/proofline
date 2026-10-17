#!/bin/sh
# reply-decision.sh KIND [TEXT_FILE]: what the harness does at a stop (A128). Prints `plan` (answer the approval),
# `question` (the scripted question reply may be sent) or `stop` (never answer). KIND is the output of
# pending-kind.sh: only exactly `plan` is answered as an approval; any other kind (destructive, single_step, scope,
# budget, commit, push, waive:<ID>, or one this script does not know) stops. With no kind, the text on stdin (state,
# pending questions, the lead's last message) is searched line by line for a commit or push request; the accepted-answers
# line of an approval question (English `accepted answers:`, Turkish `kabul edilen onay`) lists "commit it, push it" and
# is skipped. A genuine commit request is also covered by the newest approvals file (kind commit / push).
kind=${1:-}
case $kind in
  plan) echo plan ;;
  '')
    if grep -Eiv 'accepted answers:|kabul edilen onay' | grep -Eiq 'approve (the )?(commit|push)|commit approval|push approval|commit it|push it'; then echo stop; else echo question; fi ;;
  *) echo stop ;;
esac
