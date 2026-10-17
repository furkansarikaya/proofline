#!/bin/sh
# Proves the planted facts of the docs-writer fixture built in $1, with the skill's own scripts.
set -eu
cd "$1"
skill=$(cd "$(dirname "$0")/../../skills/docs-writer" && pwd)
fail() { echo "selfcheck: $*" >&2; exit 1; }

out=$(node "$skill/scripts/check-docs.mjs" docs/guide.md) && fail "check-docs found nothing"
for want in 'docs/guide.md:9: flag not found: --verbose' 'docs/guide.md:9: config key not found: server.timeout' \
  'docs/guide.md:9: path not found: docs/old-guide.md' 'docs/guide.md:10: command not found: ./bin/acme deploy' \
  'docs/guide.md:10: link not found: setup.md' '5 finding(s)'; do
  printf '%s\n' "$out" | grep -qF "$want" || fail "missing evidence finding: $want"
done

out=$(node "$skill/scripts/check-writing.mjs" docs/style.md) || fail "relaxed writing check must exit 0"
for want in 'style.md:3: warning: instruction-length' 'style.md:5: warning: explanatory-length' 'style.md:7: warning: paragraph-length' '3 finding(s)'; do
  printf '%s\n' "$out" | grep -qF "$want" || fail "missing writing finding: $want"
done
node "$skill/scripts/check-writing.mjs" --strictness strict docs/style.md >/dev/null && fail "strict writing check must exit 1"
echo "docs-writer fixture ok"
