#!/bin/sh
# Proves the planted facts of the task-planning fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
v=$(CDPATH='' cd "$(dirname "$0")" && pwd)/../../skills/task-author/scripts/validate-task.mjs
for t in T-1 T-2; do
  node "$v" ".agents/tasks/$t.md" --tasks-dir .agents/tasks >/dev/null || fail "$t must validate"
  grep -q 'docs/adr/0001-use-postgres.md' ".agents/tasks/$t.md" || fail "$t must link the ADR"
done
[ -f docs/adr/0001-use-postgres.md ] || fail "linked ADR missing"
[ -f .agents/local/team.yaml ] || fail "team.yaml missing"
git check-ignore -q .agents/local/team.yaml || fail "team.yaml must be git-ignored"
git status --porcelain | grep -q 'team.yaml' && fail "team.yaml shows in git status"
git status --porcelain | grep -q '\.agents/local' && fail ".agents/local shows in git status"
echo "selfcheck: ok"
