#!/bin/sh
# Tests tests/invariants/check-changed.sh: the pull request description rule for changes under tests/invariants/.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-invariants-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
fail=0
# run WANT DESC BODY PATH... : BODY goes in $PR_BODY; WANT is the exit status
run() {
  want=$1 desc=$2 body=$3; shift 3
  printf '%s\n' "$@" | env -u GITHUB_EVENT_NAME -u PR_BODY_FILE -u GITHUB_EVENT_PATH PR_BODY="$body" sh "$here/check-changed.sh" >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then printf 'ok %s\n' "$desc"; else printf 'FAIL %s: want exit %s, got %s\n' "$desc" "$want" "$got"; fail=1; fi
}
run 0 'no invariant file changed' '' README.md docs/a.md
run 1 'invariant test changed, empty description' '' tests/invariants/invariants-test.sh
run 1 'invariant test changed, description without the line' 'Fixes the lookup.' tests/invariants/invariants-test.sh
run 0 'invariant test changed, reason given' 'Fixes x.

Invariant-test-change: the fixture now installs the stub scanner' tests/invariants/invariants-test.sh README.md
run 0 'reason with CRLF line endings' "$(printf 'Intro\r\nInvariant-test-change: the fixture now installs the stub scanner\r')" tests/invariants/check-changed.sh
run 1 'line present but no reason' 'Invariant-test-change:' tests/invariants/invariants-test.sh
run 1 'line present, reason too short' 'Invariant-test-change: fix' tests/invariants/invariants-test.sh
run 1 'the phrase inside a sentence is not the line' 'see Invariant-test-change: the fixture now installs the stub' tests/invariants/invariants-test.sh
run 1 'indented line does not count' '  Invariant-test-change: the fixture now installs the stub' tests/invariants/invariants-test.sh
run 1 'a deleted invariant test is a change' '' tests/invariants/removed-test.sh
run 0 'a sibling path is not under tests/invariants/' '' tests/invariants-extra/x.sh tests/other/invariants/x.sh

# the event payload (CI), a body file, and runs that are not pull requests
printf '{"pull_request":{"body":"x\\n\\nInvariant-test-change: payload carries the reason"}}' > "$T/event-ok.json"
printf '{"pull_request":{"body":null}}' > "$T/event-empty.json"
ev() { # WANT DESC PAYLOAD
  printf 'tests/invariants/invariants-test.sh\n' | env -u PR_BODY -u PR_BODY_FILE GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$3" sh "$here/check-changed.sh" >/dev/null 2>&1; got=$?
  if [ "$got" = "$1" ]; then printf 'ok %s\n' "$2"; else printf 'FAIL %s: want exit %s, got %s\n' "$2" "$1" "$got"; fail=1; fi
}
ev 0 'event payload with the line' "$T/event-ok.json"
ev 1 'event payload with a null body' "$T/event-empty.json"
ev 1 'event payload missing' "$T/nope.json"
printf 'Invariant-test-change: the body file carries the reason\n' > "$T/body.txt"
printf 'tests/invariants/invariants-test.sh\n' | env -u PR_BODY -u GITHUB_EVENT_NAME PR_BODY_FILE="$T/body.txt" sh "$here/check-changed.sh" >/dev/null 2>&1 && echo 'ok PR_BODY_FILE with the line' || { echo 'FAIL PR_BODY_FILE with the line'; fail=1; }
printf 'tests/invariants/invariants-test.sh\n' | env -u PR_BODY -u PR_BODY_FILE GITHUB_EVENT_NAME=push sh "$here/check-changed.sh" >/dev/null 2>&1 && echo 'ok a push has no description to check' || { echo 'FAIL push'; fail=1; }
exit "$fail"
