// Proves the explain-html fixture page passes the skill's own validator, and that an external reference does not.
// usage: node selfcheck.mjs <built-dir>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const checker = path.join(repoRoot, 'skills/explain-html/scripts/check-html.mjs');
if (!run('node', [checker, 'page.html'], { cwd: dir }).out.split('\n').includes('0 finding(s)')) fail('good page must pass');
writeFileSync(path.join(dir, 'bad.html'), readFileSync(path.join(dir, 'page.html'), 'utf8').replace(/<\/head>/g, '<link rel="stylesheet" href="https://cdn.example/x.css"></head>'));
if (run('node', [checker, 'bad.html'], { cwd: dir }).status === 0) fail('external reference must fail');
console.log('explain-html fixture ok');
