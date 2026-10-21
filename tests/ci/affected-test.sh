#!/bin/sh
# Tests tests/affected.sh selection (A164): unmapped changes never skip, mapped changes select only their suites.
set -u
here=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
fail=0
list() { sh "$here/affected.sh" --list "$@"; }
total=$(list --all | wc -l | tr -d ' ')
# a mapped script selects only its suite
got=$(list control-plane/agents/scripts/batch.sh)
[ "$got" = control-plane/agents/scripts/batch-test.sh ] || { echo "FAIL mapped change: got '$got'"; fail=1; }
# a change not in the mapping selects every unit
got=$(list some/unmapped/file.txt | wc -l | tr -d ' ')
{ [ "$got" = "$total" ] && [ "$total" -gt 1 ]; } || { echo "FAIL unmapped change selected $got of $total"; fail=1; }
# a shared file selects every unit
got=$(list tests/selftest.sh | wc -l | tr -d ' ')
[ "$got" = "$total" ] || { echo "FAIL shared file selected $got of $total"; fail=1; }
# --all selects everything even with a mapped file
got=$(list --all control-plane/agents/scripts/batch.sh | wc -l | tr -d ' ')
[ "$got" = "$total" ] || { echo "FAIL --all selected $got of $total"; fail=1; }
# documentation only selects just the front matter test
got=$(list README.md)
[ "$got" = tests/skills/frontmatter.test.mjs ] || { echo "FAIL docs-only: got '$got'"; fail=1; }
[ "$fail" -eq 0 ] && echo "affected-test: all passed"
exit "$fail"
