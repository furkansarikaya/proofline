#!/bin/sh
# Proves the planted facts of the ui-design fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }

node --test test/components.test.js >/dev/null 2>&1 || fail "component test must pass"
for t in --color-text --color-text-muted --color-primary --color-danger --color-border --color-surface \
         --color-surface-muted --color-focus --color-brand-legacy --space-1 --space-2 --space-3 --space-4 \
         --radius-md --font-size-sm --font-size-md; do
  grep -q -- "^  $t: " src/ui/styles/tokens.css || fail "token $t not defined"
done
grep -q 'deprecated' docs/design/DESIGN.md || fail "deprecation notes missing"
# The list page has loading/error/empty states but no filter yet.
grep -q "status === 'loading'" src/ui/pages/ProjectList.js || fail "loading state missing"
grep -q "status === 'error'" src/ui/pages/ProjectList.js || fail "error state missing"
grep -q 'EmptyState' src/ui/pages/ProjectList.js || fail "empty state missing"
grep -qi 'filter' src/ui/pages/ProjectList.js && fail "filter already exists"
grep -q 'Select' src/ui/pages/ProjectList.js && fail "page already uses Select"

# A81 known-answer validator cases (cases/, never copied into the runner's repository): the good spec and the
# pre-A81 spec pass; each trap fails with exactly its planted errors and nothing else.
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
v=$here/../../skills/ui-design/scripts/validate-ui.mjs
c=$here/cases
out=$(mktemp)
trap 'rm -f "$out"' EXIT
# expect <case> <exit> [message ...]: exit code and, for exit 1, exactly these error lines (substrings).
expect() {
  name=$1 want=$2; shift 2
  set +e; node "$v" "$c/$name" --root . --task "$c/TASK.md" > "$out" 2>&1; got=$?; set -e
  [ "$got" = "$want" ] || fail "case $name: exit $got, expected $want: $(cat "$out")"
  [ "$want" = 0 ] && return 0
  [ "$(wc -l < "$out" | tr -d ' ')" = "$#" ] || fail "case $name: expected $# error(s), got: $(cat "$out")"
  for m in "$@"; do grep -qF -- "$m" "$out" || fail "case $name: missing \"$m\" in: $(cat "$out")"; done
}
expect good.json 0
expect legacy.json 1 'missing "creative_direction"' 'missing "ux_patterns"' 'missing "self_critique"' 'missing "criteria"'
node "$v" "$c/legacy.json" --root . > /dev/null || fail "case legacy.json: a pre-A81 spec without a class must stay valid"
expect trap-self-approval.json 1 '$.self_critique.hierarchy: self-approval claim'
expect trap-unknown-criterion.json 1 'AC-7 is not an acceptance criterion of the task'
expect trap-redesign-unapproved.json 1 'task_quote: not found in TASK.md' "user_approval: a redesign needs the user's approval"
[ "$(node "$v" "$c/good.json" --root . --task "$c/TASK.md" --list-visual-proof)" = '{"schema":"ui-design.visual-proof/1","required":["AC-1","AC-2"]}' ] \
  || fail "good.json: visual-proof list must be AC-1, AC-2"
echo "selfcheck: ui-design ok"
