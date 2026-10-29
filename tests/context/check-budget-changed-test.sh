#!/bin/sh
# Tests tests/context/check-budget-changed.sh: the pull request description rule for changes of the context budget.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
fail=0
run() { # WANT DESC BODY PATH...
  want=$1 desc=$2 body=$3; shift 3
  printf '%s\n' "$@" | env -u GITHUB_EVENT_NAME -u PR_BODY_FILE -u GITHUB_EVENT_PATH PR_BODY="$body" sh "$here/check-budget-changed.sh" >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then printf 'ok %s\n' "$desc"; else printf 'FAIL %s: want exit %s, got %s\n' "$desc" "$want" "$got"; fail=1; fi
}
run 0 'budget unchanged' '' README.md bin/lib/context-size.sh
run 1 'budget changed, empty description' '' tests/context/budget.tsv
run 1 'budget changed, a different reason line' 'Invariant-test-change: this is not the right line' tests/context/budget.tsv
run 0 'budget changed, reason given' 'Adds a section.

Context-budget-change: the entry skill gains the status block table' tests/context/budget.tsv
run 1 'reason too short' 'Context-budget-change: more' tests/context/budget.tsv
run 1 'the phrase inside a sentence is not the line' 'see Context-budget-change: the entry skill gains a table' tests/context/budget.tsv
run 0 'a sibling file is not the budget' '' tests/context/budget.tsv.bak tests/context/rule-map.tsv
if printf '%s\n' tests/context/budget.tsv | env -u PR_BODY -u PR_BODY_FILE GITHUB_EVENT_NAME=push sh "$here/check-budget-changed.sh" >/dev/null 2>&1; then echo 'ok a push is not checked'; else echo 'FAIL a push is not checked'; fail=1; fi
[ "$fail" = 0 ] && echo 'check-budget-changed-test: all passed'
exit "$fail"
