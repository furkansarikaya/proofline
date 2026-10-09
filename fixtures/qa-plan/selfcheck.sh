#!/bin/sh
# Proves the planted facts of the qa-plan fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }

node --test test/cart.test.js test/shipping.test.js >/dev/null 2>&1 || fail "happy-path suite must pass"

node --input-type=module -e "
import { shippingCents } from './src/shipping.js';
const line = (qty, unitCents) => ({ sku: 'x', qty, unitCents });
const check = (cond, msg) => { if (!cond) { console.error(msg); process.exit(1); } };
// Planted bug 1: boundary is exclusive (AC-1 says 5000 or more is free).
check(shippingCents([line(1, 5000)]) === 499, 'boundary bug not present');
check(shippingCents([line(2, 2500)]) === 499, 'boundary bug (multi-line) not present');
// Planted bug 2: empty cart does not throw (AC-3).
let threw = false; try { shippingCents([]); } catch { threw = true; }
check(!threw && shippingCents([]) === 499, 'empty-cart bug not present');
// Decoys handled correctly.
check(shippingCents([line(1, 4999)]) === 499, 'just-below decoy wrong');
check(shippingCents([line(1, 5001)]) === 0, 'just-above decoy wrong');
check(shippingCents([line(3, 1667)]) === 0, 'integer-cents decoy wrong');
check(shippingCents([line(10, 10), line(1, 4901)]) === 0, 'many-lines decoy wrong');
let typeErr = false; try { shippingCents(null); } catch (e) { typeErr = e instanceof TypeError; }
check(typeErr, 'non-array decoy wrong');
" || fail "planted behaviour differs"
echo "selfcheck: qa-plan ok"
