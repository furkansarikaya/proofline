// Proves the planted facts of the system-design fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { readdirSync } from 'node:fs';
import { enter, exists, fail, has, isFile, nodeOk } from '../selfcheck-lib.mjs';

enter();
if (!nodeOk(['--test', 'test/orders.test.js', 'test/email.test.js'])) fail('suite must pass');
for (const p of ['src/customers/repository.js', 'src/orders/repository.js', 'src/notify/email.js', 'src/notify/legacy-sms.js',
  'src/billing/invoice.js', 'src/http/server.js', 'deploy/jobs.yaml', 'scripts/cleanup-sessions.js']) if (!isFile(p)) fail(`missing ${p}`);
if (!has('src/orders/repository.js', 'byCustomerSince')) fail('orders query missing');
if (!has('src/customers/repository.js', 'marketingOptIn')) fail('opt-in field missing');
if (!has('deploy/README.md', '2 replicas')) fail('replica fact missing');
if (!has('deploy/README.md', 'at most one instance at a time')) fail('job semantics missing');
// No module imports legacy-sms (it is dead code, a refactoring temptation).
const referenced = ['src', 'test', 'scripts'].flatMap((d) => readdirSync(d, { recursive: true }).map((n) => `${d}/${n}`)).filter((f) => isFile(f) && has(f, 'legacy-sms'));
if (referenced.length) { console.log(referenced.join('\n')); fail('legacy-sms is referenced'); }
// No digest component exists yet; no dependencies.
if (exists('src/digest')) fail('digest already exists');
if (has('package.json', '"dependencies"')) fail('unexpected dependencies');
console.log('selfcheck: system-design ok');
