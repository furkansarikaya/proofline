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
grep -q 'deprecated' DESIGN.md || fail "deprecation notes missing"
# The list page has loading/error/empty states but no filter yet.
grep -q "status === 'loading'" src/ui/pages/ProjectList.js || fail "loading state missing"
grep -q "status === 'error'" src/ui/pages/ProjectList.js || fail "error state missing"
grep -q 'EmptyState' src/ui/pages/ProjectList.js || fail "empty state missing"
grep -qi 'filter' src/ui/pages/ProjectList.js && fail "filter already exists"
grep -q 'Select' src/ui/pages/ProjectList.js && fail "page already uses Select"
echo "selfcheck: ui-design ok"
