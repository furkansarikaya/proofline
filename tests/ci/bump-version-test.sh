#!/bin/sh
# Tests tests/ci/bump-version.sh (A168): a bump rewrites only version sites, never history comments; --check; bad input.
# shellcheck disable=SC2015
set -u
here=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
fail=0
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
ok() { printf 'ok %s\n' "$1"; }
no() { printf 'FAIL %s\n' "$1"; fail=1; }

# a temp copy of the tracked files, committed so git diff names what the script touched
(cd "$here" && git ls-files --cached --others --exclude-standard | tar -cf - -T -) | tar -xf - -C "$t"
cd "$t" || exit 1
# the repository has no Unreleased entry right after a release: give the copy one
printf '# Changelog\n\n## Unreleased\n\n- test entry\n\n' > "$t/cl"
sed '1,3d' CHANGELOG.md >> "$t/cl"
cat "$t/cl" > CHANGELOG.md
git init -q . && git add -A && git -c user.name=t -c user.email=t@t commit -q -m base
cur=$(sed -n 's/^  "version": "\([0-9.]*\)",$/\1/p' .claude-plugin/plugin.json | head -n 1)

sh tests/ci/bump-version.sh --check >/dev/null && ok "check passes on the repository as it is" || no "check fails on the repository as it is"
sh tests/ci/bump-version.sh 1.2 >/dev/null 2>&1 && no "bad version 1.2 accepted" || ok "bad version string exits non-zero"
sh tests/ci/bump-version.sh "$cur" >/dev/null 2>&1 && no "unchanged version accepted" || ok "same version exits non-zero"
[ -z "$(git status --porcelain)" ] && ok "rejected input changes nothing" || no "rejected input changed files"

BUMP_DATE=2030-01-02 sh tests/ci/bump-version.sh 9.8.7 >/dev/null 2>&1 && ok "bump to 9.8.7" || no "bump failed"
grep -q 'native apps (0.0.24)' skills/visual-proof/scripts/native.mjs && ok "historical (0.0.24 in native.mjs untouched" || no "historical mention rewritten"
git diff --name-only | sort > "$t/changed"
grep -q -E 'visual-proof/scripts|visual-proof-native' "$t/changed" && no "a visual-proof file changed" || ok "no visual-proof file changed"
# every changed file is a listed site, the changelog or a generated file
bad=$(grep -v -E '^(bin/proofline|\.claude-plugin/(plugin|marketplace)\.json|control-plane/agents/config\.yaml|playground/package\.json|skills/[a-z-]+/SKILL\.md|skills/exploit-proof/scripts/diff-manifests\.mjs|skills/proof-review/(scripts/check-config\.mjs|references/REPORTING\.md)|README\.md|adapters/README\.md|fixtures/(concurrency-proof/selfcheck|insights/setup)\.sh|tests/cli/cli-test\.sh|tests/skills/(concurrency-proof|proof-review|data-design|proofline-lead)\.test\.mjs|CHANGELOG\.md|docs/reference/skills\.md)$' "$t/changed" || true)
[ -z "$bad" ] && ok "only listed sites changed" || no "unlisted files changed: $bad"
# every changed line names the old or the new version (nothing else was rewritten)
stray=$(git diff -U0 | grep -E '^[-+][^-+]' | grep -v -F -e "$cur" -e '9.8.7' -e '9\.8\.7' -e "$(printf '%s' "$cur" | sed 's/\./\\\./g')" -e 'test entry' -e 'Unreleased' || true)
[ -z "$stray" ] && ok "every changed line names the old or new version" || no "stray changed lines: $stray"
grep -q '^## 9.8.7 — 2030-01-02$' CHANGELOG.md && ok "CHANGELOG heading added" || no "CHANGELOG heading missing"
sh tests/ci/bump-version.sh --check >/dev/null && ok "check passes after the bump" || no "check fails after the bump"
sed 's/^PROOFLINE_VERSION=.*/PROOFLINE_VERSION=0.0.1/' bin/proofline > "$t/pl"
cat "$t/pl" > bin/proofline
sh tests/ci/bump-version.sh --check >/dev/null 2>&1 && no "check missed a disagreeing site" || ok "check fails when a site disagrees"
exit "$fail"
