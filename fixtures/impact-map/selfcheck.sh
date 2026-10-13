#!/bin/sh
# Proves the impact report on the impact-map fixture built in $1 equals EXPECTED.json.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SK=$ROOT/skills/evidence-map/scripts
fail() { echo "selfcheck: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "selfcheck: node not found, skipped" >&2; exit 0; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/impact-selfcheck.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
node "$SK/impact.mjs" --repo "$1" --base HEAD~1 --out "$tmp/report.json" || fail "impact.mjs failed"
node "$SK/validate-impact.mjs" "$tmp/report.json" --repo "$1" || fail "report does not validate"
node "$HERE/compare.mjs" "$tmp/report.json" "$HERE/EXPECTED.json" || fail "report differs from EXPECTED.json"
echo "selfcheck: impact-map ok"
