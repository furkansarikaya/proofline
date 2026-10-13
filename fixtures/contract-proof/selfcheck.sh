#!/bin/sh
# Proves the contract-proof scripts on the fixture built in $1 give the answers in EXPECTED.json:
# the whole diff FAILs with exactly the planted uncovered breaks, the covered/doc-only/GraphQL subset
# PASSes, and the unparseable file alone is UNSUPPORTED.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SK=$ROOT/skills/contract-proof/scripts
EM=$ROOT/skills/evidence-map/scripts
fail() { echo "selfcheck: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "selfcheck: node not found, skipped" >&2; exit 0; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/contract-selfcheck.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

node "$EM/impact.mjs" --repo "$1" --symbol customerEmail --symbol currency --symbol quantity --symbol LOST --out "$tmp/impact.json" || fail "impact.mjs failed"
node "$EM/validate-impact.mjs" "$tmp/impact.json" --repo "$1" >/dev/null || fail "impact report does not validate"

# whole diff
node "$SK/diff-contract.mjs" --repo "$1" --base HEAD~1 --plan "$1/PLAN.md" --impact "$tmp/impact.json" --out "$tmp/all.json" || fail "diff-contract.mjs failed"
node "$SK/validate-contract.mjs" "$tmp/all.json" --table > "$tmp/all.out" || fail "contract.json does not validate"
node "$HERE/compare.mjs" all "$tmp/all.json" "$tmp/all.out" "$HERE/EXPECTED.json" || fail "whole diff differs from EXPECTED.json"

# covered break, documentation-only and GraphQL files only
node "$SK/diff-contract.mjs" --repo "$1" --base HEAD~1 --plan "$1/PLAN.md" --impact "$tmp/impact.json" \
  --path schemas/shipment.schema.json --path events/asyncapi.yaml --path graphql/schema.graphql --out "$tmp/covered.json" || fail "diff-contract.mjs failed (covered)"
node "$SK/validate-contract.mjs" "$tmp/covered.json" --table > "$tmp/covered.out" || fail "covered report does not validate"
node "$HERE/compare.mjs" covered "$tmp/covered.json" "$tmp/covered.out" "$HERE/EXPECTED.json" || fail "covered run differs from EXPECTED.json"

# the unparseable file alone
node "$SK/diff-contract.mjs" --repo "$1" --base HEAD~1 --plan "$1/PLAN.md" --path api/legacy.yaml --out "$tmp/legacy.json" || fail "diff-contract.mjs failed (legacy)"
node "$SK/validate-contract.mjs" "$tmp/legacy.json" --table > "$tmp/legacy.out" || fail "legacy report does not validate"
node "$HERE/compare.mjs" legacy "$tmp/legacy.json" "$tmp/legacy.out" "$HERE/EXPECTED.json" || fail "legacy run differs from EXPECTED.json"
grep -q '^REASON: api/legacy.yaml (yaml): cannot parse: anchor' "$tmp/legacy.out" || fail "UNSUPPORTED reason does not name the anchor"
echo "selfcheck: contract-proof ok"
