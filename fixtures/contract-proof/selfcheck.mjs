// Proves the contract-proof scripts on the fixture built in <dir> give the answers in EXPECTED.json:
// the whole diff FAILs with exactly the planted uncovered breaks (validated against PLAN.md and a re-run
// of the differ), the covered/doc-only/GraphQL subset PASSes, and the unparseable file alone is UNSUPPORTED.
// usage: node selfcheck.mjs <built-dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const HERE = import.meta.dirname;
const SK = path.join(repoRoot, 'skills/contract-proof/scripts');
const EM = path.join(repoRoot, 'skills/evidence-map/scripts');
const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'contract-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const t = (/** @type {string} */ n) => path.join(tmp, n);
const node = (/** @type {string[]} */ args) => run('node', args);
/** compare.mjs prints its own `compare <name>: ok` line, as it did under the shell selfcheck. */
const compare = (/** @type {string[]} */ args) => run('node', [path.join(HERE, 'compare.mjs'), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

let r = node([path.join(EM, 'impact.mjs'), '--repo', dir, ...['customerEmail', 'createdAt', 'currency', 'quantity', 'LOST', 'sku', 'customerId', 'zip', 'B'].flatMap((s) => ['--symbol', s]), '--out', t('impact.json')]);
if (r.status !== 0) fail('impact.mjs failed');
if (node([path.join(EM, 'validate-impact.mjs'), t('impact.json'), '--repo', dir]).status !== 0) fail('impact report does not validate');

// whole diff
const plan = path.join(dir, 'PLAN.md');
if (node([path.join(SK, 'diff-contract.mjs'), '--repo', dir, '--base', 'HEAD~1', '--plan', plan, '--impact', t('impact.json'), '--out', t('all.json')]).status !== 0) fail('diff-contract.mjs failed');
r = node([path.join(SK, 'validate-contract.mjs'), t('all.json'), '--table', '--plan', plan, '--repo', dir, '--base', 'HEAD~1']);
if (r.status !== 0) fail('contract.json does not validate');
writeFileSync(t('all.out'), r.out);
if (compare(['all', t('all.json'), t('all.out'), path.join(HERE, 'EXPECTED.json')]).status !== 0) fail('whole diff differs from EXPECTED.json');

// covered break, documentation-only and GraphQL files only. --path is additive to discovery (A94), so a
// subset is the whole report filtered to the named files.
/** @param {string} inFile @param {string} outFile @param {...string} keep */
function subset(inFile, outFile, ...keep) {
  const d = JSON.parse(readFileSync(inFile, 'utf8'));
  d.files = d.files.filter((/** @type {{ path: string }} */ f) => keep.includes(f.path));
  writeFileSync(outFile, `${JSON.stringify(d, null, 2)}\n`);
}
/** One filtered report: validate it against PLAN.md, compare it with EXPECTED.json; returns the validator's stdout. @param {string} name @param {string[]} files */
function part(name, files) {
  try { subset(t('all.json'), t(`${name}.json`), ...files); } catch { fail(`subset failed (${name})`); }
  const v = node([path.join(SK, 'validate-contract.mjs'), t(`${name}.json`), '--table', '--plan', plan]);
  if (v.status !== 0) fail(`${name} report does not validate`);
  writeFileSync(t(`${name}.out`), v.out);
  if (compare([name, t(`${name}.json`), t(`${name}.out`), path.join(HERE, 'EXPECTED.json')]).status !== 0) fail(`${name} run differs from EXPECTED.json`);
  return v.out;
}
part('covered', ['schemas/shipment.schema.json', 'events/asyncapi.yaml', 'graphql/schema.graphql']);
// the unparseable file alone
if (!part('legacy', ['api/legacy.yaml']).split('\n').some((l) => l.startsWith('REASON: api/legacy.yaml (yaml): cannot parse: anchor'))) fail('UNSUPPORTED reason does not name the anchor');
console.log('selfcheck: contract-proof ok');
