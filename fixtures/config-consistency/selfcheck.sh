#!/bin/sh
# Proves the planted facts of the config-consistency fixture built in $1 against the skill's own scripts
# (skills/proof-review/scripts/check-config.mjs and validate-config.mjs). Offline; runs no project code.
set -eu
HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
SCRIPTS=$HERE/../../skills/proof-review/scripts
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
command -v node >/dev/null 2>&1 || { echo "selfcheck: SKIPPED: node not available"; exit 0; }

[ "$(git rev-parse --abbrev-ref HEAD)" = "feature/config-drift" ] || fail "HEAD is not feature/config-drift"
[ "$(git rev-list --count main..feature/config-drift)" -eq 1 ] || fail "config-drift must be one commit"
[ "$(git rev-list --count main..feature/config-clean)" -eq 1 ] || fail "config-clean must be one commit"
[ -z "$(git status --porcelain)" ] || fail "working tree not clean"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/config-consistency-selfcheck-XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
# summary <json> <class>: "<check>:<subject>" sorted, one line.
summary() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(d.items.filter((i) => i.class === process.argv[2]).map((i) => `${i.check}:${i.subject}`).sort().join(" "));' "$1" "$2"
}

# --- feature/config-drift ---------------------------------------------------------------------------
node "$SCRIPTS/check-config.mjs" --base main --plan .agents/runs/CC-1/PLAN-drift.md --out "$tmp/drift.json"
want="env_undocumented:MAIL_FROM env_undocumented:QUEUE_URL env_undocumented:SMTP_HOST flag_default_on:new_checkout flag_removed_referenced:old_search secret_plaintext:STAGING_KEY secret_plaintext:api_key secret_plaintext:password"
[ "$(summary "$tmp/drift.json" blocking)" = "$want" ] || fail "blocking set differs: $(summary "$tmp/drift.json" blocking)"
want="env_documented_unused:OLD_TIMEOUT flag_default_off:beta_banner flag_default_on_planned:dark_mode secret_allowlisted:token"
[ "$(summary "$tmp/drift.json" note)" = "$want" ] || fail "note set differs: $(summary "$tmp/drift.json" note)"
out=$(node "$SCRIPTS/validate-config.mjs" "$tmp/drift.json" --table) || fail "validator rejected the document"
echo "$out" | grep -qx 'RESULT: FAIL' || fail "expected RESULT: FAIL"
# the secret values are masked everywhere
if grep -q -e 'k3J9xQ2m' -e 'fakeT0ken' -e 'Qw8Er3Ty6Ui1' "$tmp/drift.json"; then fail "a secret value leaked into the document"; fi
# traps never reported: pre-existing PORT, ambient NODE_ENV, documented SMTP_PORT, README-only QUEUE_WORKERS, ${DB_PASSWORD}
for t in PORT NODE_ENV SMTP_PORT QUEUE_WORKERS DB_PASSWORD; do
  if grep -q "\"subject\": \"$t\"" "$tmp/drift.json"; then fail "trap reported: $t"; fi
done
# without a plan the unplanned flag is a note, not a finding
node "$SCRIPTS/check-config.mjs" --base main --out "$tmp/noplan.json"
case "$(summary "$tmp/noplan.json" blocking)" in *flag_default_on*) fail "flag default is blocking without a plan" ;; esac
# a value copied into the document is rejected
node -e '
  const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  d.items[0].detail = "token ghp_" + "a".repeat(36); fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$tmp/drift.json" "$tmp/leak.json"
if node "$SCRIPTS/validate-config.mjs" "$tmp/leak.json" >/dev/null 2>&1; then fail "a leaked secret was accepted"; fi

# --- feature/config-clean ---------------------------------------------------------------------------
git checkout -q feature/config-clean
node "$SCRIPTS/check-config.mjs" --base main --plan .agents/runs/CC-1/PLAN-clean.md --out "$tmp/clean.json"
[ -z "$(summary "$tmp/clean.json" blocking)" ] || fail "config-clean has blocking items: $(summary "$tmp/clean.json" blocking)"
node "$SCRIPTS/validate-config.mjs" "$tmp/clean.json" | grep -qx 'RESULT: PASS' || fail "expected RESULT: PASS on config-clean"
git checkout -q feature/config-drift
echo "selfcheck: config-consistency facts ok"
