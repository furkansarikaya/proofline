// Proves the planted facts of the qa-plan fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { enter, fail, nodeOk, run } from '../selfcheck-lib.mjs';

enter();
if (!nodeOk(['--test', 'test/cart.test.js', 'test/shipping.test.js'])) fail('happy-path suite must pass');
const facts = `
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
`;
if (run(process.execPath, ['--input-type=module', '-e', facts]).status !== 0) fail('planted behaviour differs');
console.log('selfcheck: qa-plan ok');
