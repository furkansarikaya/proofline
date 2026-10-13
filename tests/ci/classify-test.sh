#!/bin/sh
# Tests tests/ci/classify.sh: which pull requests may skip the heavy CI jobs (A76).
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
fail=0
# expect WANT PATH... : the classification of the listed paths
expect() {
  want=$1; shift
  got=$(printf '%s\n' "$@" | sh "$here/classify.sh")
  if [ "$got" = "code=$want" ]; then printf 'ok %s -> code=%s\n' "$*" "$want"; else printf 'FAIL %s: want code=%s, got %s\n' "$*" "$want" "$got"; fail=1; fi
}
expect false README.md
expect false CHANGELOG.md CONTRIBUTING.md docs/decisions.md docs/concepts/enforcement-layers.md
expect true skills/proof-review/SKILL.md
expect true roles/lead.md
expect true control-plane/agents/GATES.md
expect true adapters/claude/README.md
expect true docs/reference/skills.md
expect true docs/reference/generate-skills.sh
expect true docs/decisions.md tests/selftest.sh
expect true .github/workflows/ci.yml
expect true README.md fixtures/api-design/setup.sh
expect true tests/e2e/README.md
if [ "$(printf '' | sh "$here/classify.sh")" = code=true ]; then echo 'ok empty list -> code=true'; else echo 'FAIL empty list must be code=true'; fail=1; fi
exit "$fail"
