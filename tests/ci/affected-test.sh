#!/bin/sh
# Tests tests/affected.sh selection (A164): unmapped changes never skip, mapped changes select only their suites.
set -u
here=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
fail=0
list() { sh "$here/affected.sh" --list "$@"; }
total=$(list --all | wc -l | tr -d ' ')
# a mapped script selects only its suite
got=$(list tests/ci/classify.sh)
[ "$got" = "tests/ci/affected-test.sh
tests/ci/classify-test.sh" ] || { echo "FAIL mapped change: got '$got'"; fail=1; }
# a change not in the mapping selects every unit
got=$(list some/unmapped/file.txt | wc -l | tr -d ' ')
{ [ "$got" = "$total" ] && [ "$total" -gt 1 ]; } || { echo "FAIL unmapped change selected $got of $total"; fail=1; }
# a shared file selects every unit
got=$(list tests/selftest.sh | wc -l | tr -d ' ')
[ "$got" = "$total" ] || { echo "FAIL shared file selected $got of $total"; fail=1; }
# --all selects everything even with a mapped file
got=$(list --all tests/ci/classify.sh | wc -l | tr -d ' ')
[ "$got" = "$total" ] || { echo "FAIL --all selected $got of $total"; fail=1; }
# --all includes the node test files outside tests/skills
list --all | grep -qx tests/benchmark/benchmark.test.mjs || { echo "FAIL --all misses benchmark.test.mjs"; fail=1; }
# a mapped unit that does not exist selects every unit (fail safe)
tmpmap=$(mktemp "${TMPDIR:-/tmp}/affected-map.XXXXXX") || exit 2
printf 'some/path.txt no-such-suite\n' > "$tmpmap"
got=$(AFFECTED_MAP=$tmpmap list some/path.txt | wc -l | tr -d ' ')
rm -f "$tmpmap"
[ "$got" = "$total" ] || { echo "FAIL unresolved unit selected $got of $total"; fail=1; }
# documentation only selects just the front matter test
got=$(list README.md)
[ "$got" = tests/skills/frontmatter.test.mjs ] || { echo "FAIL docs-only: got '$got'"; fail=1; }
[ "$fail" -eq 0 ] && echo "affected-test: all passed"
exit "$fail"
