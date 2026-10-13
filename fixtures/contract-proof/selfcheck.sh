#!/bin/sh
# Proves the contract-proof scripts on the fixture built in $1 give the answers in EXPECTED.json:
# the whole diff FAILs with exactly the planted uncovered breaks (validated against PLAN.md and a re-run
# of the differ), the covered/doc-only/GraphQL subset PASSes, and the unparseable file alone is UNSUPPORTED.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SK=$ROOT/skills/contract-proof/scripts
EM=$ROOT/skills/evidence-map/scripts
fail() { echo "selfcheck: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "selfcheck: node not found, skipped" >&2; exit 0; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/contract-selfcheck.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

node "$EM/impact.mjs" --repo "$1" --symbol customerEmail --symbol createdAt --symbol currency --symbol quantity --symbol LOST --symbol sku --symbol customerId --symbol zip --symbol B --out "$tmp/impact.json" || fail "impact.mjs failed"
node "$EM/validate-impact.mjs" "$tmp/impact.json" --repo "$1" >/dev/null || fail "impact report does not validate"

# whole diff
node "$SK/diff-contract.mjs" --repo "$1" --base HEAD~1 --plan "$1/PLAN.md" --impact "$tmp/impact.json" --out "$tmp/all.json" || fail "diff-contract.mjs failed"
node "$SK/validate-contract.mjs" "$tmp/all.json" --table --plan "$1/PLAN.md" --repo "$1" --base HEAD~1 > "$tmp/all.out" || fail "contract.json does not validate"
node "$HERE/compare.mjs" all "$tmp/all.json" "$tmp/all.out" "$HERE/EXPECTED.json" || fail "whole diff differs from EXPECTED.json"

# covered break, documentation-only and GraphQL files only. --path is additive to discovery (A94), so a
# subset is the whole report filtered to the named files.
subset() { # IN OUT PATH...
  si=$1 so=$2; shift 2
  node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const keep=process.argv.slice(3);d.files=d.files.filter((f)=>keep.includes(f.path));fs.writeFileSync(process.argv[2],JSON.stringify(d,null,2)+"\n");' "$si" "$so" "$@"
}
subset "$tmp/all.json" "$tmp/covered.json" schemas/shipment.schema.json events/asyncapi.yaml graphql/schema.graphql || fail "subset failed (covered)"
node "$SK/validate-contract.mjs" "$tmp/covered.json" --table --plan "$1/PLAN.md" > "$tmp/covered.out" || fail "covered report does not validate"
node "$HERE/compare.mjs" covered "$tmp/covered.json" "$tmp/covered.out" "$HERE/EXPECTED.json" || fail "covered run differs from EXPECTED.json"

# the unparseable file alone
subset "$tmp/all.json" "$tmp/legacy.json" api/legacy.yaml || fail "subset failed (legacy)"
node "$SK/validate-contract.mjs" "$tmp/legacy.json" --table --plan "$1/PLAN.md" > "$tmp/legacy.out" || fail "legacy report does not validate"
node "$HERE/compare.mjs" legacy "$tmp/legacy.json" "$tmp/legacy.out" "$HERE/EXPECTED.json" || fail "legacy run differs from EXPECTED.json"
grep -q '^REASON: api/legacy.yaml (yaml): cannot parse: anchor' "$tmp/legacy.out" || fail "UNSUPPORTED reason does not name the anchor"
echo "selfcheck: contract-proof ok"
