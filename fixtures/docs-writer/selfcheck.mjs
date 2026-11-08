// Proves the planted facts of the docs-writer fixture built in <dir>, with the skill's own scripts. usage: node selfcheck.mjs <built-dir>
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const skill = path.join(repoRoot, 'skills/docs-writer');
const check = (/** @type {string} */ script, /** @type {string[]} */ args) => run('node', [path.join(skill, 'scripts', script), ...args], { cwd: dir });

let r = check('check-docs.mjs', ['docs/guide.md']);
if (r.status === 0) fail('check-docs found nothing');
for (const want of ['docs/guide.md:9: flag not found: --verbose', 'docs/guide.md:9: config key not found: server.timeout',
  'docs/guide.md:9: path not found: docs/old-guide.md', 'docs/guide.md:10: command not found: ./bin/acme deploy',
  'docs/guide.md:10: link not found: setup.md', '5 finding(s)']) {
  if (!r.out.includes(want)) fail(`missing evidence finding: ${want}`);
}

r = check('check-writing.mjs', ['docs/style.md']);
if (r.status !== 0) fail('relaxed writing check must exit 0');
for (const want of ['style.md:3: warning: instruction-length', 'style.md:5: warning: explanatory-length', 'style.md:7: warning: paragraph-length', '3 finding(s)']) {
  if (!r.out.includes(want)) fail(`missing writing finding: ${want}`);
}
if (check('check-writing.mjs', ['--strictness', 'strict', 'docs/style.md']).status === 0) fail('strict writing check must exit 1');
console.log('docs-writer fixture ok');
