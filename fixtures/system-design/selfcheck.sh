#!/bin/sh
# Proves the planted facts of the system-design fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }

node --test test/orders.test.js test/email.test.js >/dev/null 2>&1 || fail "suite must pass"
for p in src/customers/repository.js src/orders/repository.js src/notify/email.js src/notify/legacy-sms.js \
         src/billing/invoice.js src/http/server.js deploy/jobs.yaml scripts/cleanup-sessions.js; do
  [ -f "$p" ] || fail "missing $p"
done
grep -q 'byCustomerSince' src/orders/repository.js || fail "orders query missing"
grep -q 'marketingOptIn' src/customers/repository.js || fail "opt-in field missing"
grep -q '2 replicas' deploy/README.md || fail "replica fact missing"
grep -q 'at most one instance at a time' deploy/README.md || fail "job semantics missing"
# No module imports legacy-sms (it is dead code, a refactoring temptation).
grep -rl 'legacy-sms' src test scripts && fail "legacy-sms is referenced"
# No digest component exists yet; no dependencies.
[ ! -e src/digest ] || fail "digest already exists"
grep -q '"dependencies"' package.json && fail "unexpected dependencies"
echo "selfcheck: system-design ok"
