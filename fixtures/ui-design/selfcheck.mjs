// Proves the planted facts of the ui-design fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const cat = (/** @type {string} */ f) => readFileSync(path.join(dir, f), 'utf8');

if (run('node', ['--test', 'test/components.test.js'], { cwd: dir }).status !== 0) fail('component test must pass');
const tokens = cat('src/ui/styles/tokens.css').split('\n');
for (const t of ['--color-text', '--color-text-muted', '--color-primary', '--color-danger', '--color-border', '--color-surface', '--color-surface-muted', '--color-focus', '--color-brand-legacy',
  '--space-1', '--space-2', '--space-3', '--space-4', '--radius-md', '--font-size-sm', '--font-size-md'])
  if (!tokens.some((l) => l.startsWith(`  ${t}: `))) fail(`token ${t} not defined`);
if (!cat('docs/design/DESIGN.md').includes('deprecated')) fail('deprecation notes missing');
// The list page has loading/error/empty states but no filter yet.
const page = cat('src/ui/pages/ProjectList.js');
if (!page.includes("status === 'loading'")) fail('loading state missing');
if (!page.includes("status === 'error'")) fail('error state missing');
if (!page.includes('EmptyState')) fail('empty state missing');
if (/filter/i.test(page)) fail('filter already exists');
if (page.includes('Select')) fail('page already uses Select');

// A81 known-answer validator cases (cases/, never copied into the runner's repository): the good spec and the
// pre-A81 spec pass; each trap fails with exactly its planted errors and nothing else.
const v = path.join(repoRoot, 'skills/ui-design/scripts/validate-ui.mjs');
const c = path.join(import.meta.dirname, 'cases');
/** exit code and, for exit 1, exactly these error lines (substrings). @param {string} name @param {number} want @param {...string} msgs */
function expect(name, want, ...msgs) {
  const r = run('node', [v, path.join(c, name), '--root', '.', '--task', path.join(c, 'TASK.md')], { cwd: dir });
  if (r.status !== want) fail(`case ${name}: exit ${r.status}, expected ${want}: ${r.text.trimEnd()}`);
  if (want === 0) return;
  const n = (r.text.match(/\n/g) ?? []).length;
  if (n !== msgs.length) fail(`case ${name}: expected ${msgs.length} error(s), got: ${r.text.trimEnd()}`);
  for (const m of msgs) if (!r.text.includes(m)) fail(`case ${name}: missing "${m}" in: ${r.text.trimEnd()}`);
}
expect('good.json', 0);
expect('legacy.json', 1, 'missing "creative_direction"', 'missing "ux_patterns"', 'missing "self_critique"', 'missing "criteria"');
if (run('node', [v, path.join(c, 'legacy.json'), '--root', '.'], { cwd: dir }).status !== 0) fail('case legacy.json: a pre-A81 spec without a class must stay valid');
expect('trap-self-approval.json', 1, '$.self_critique.hierarchy: self-approval claim');
expect('trap-unknown-criterion.json', 1, 'AC-7 is not an acceptance criterion of the task');
expect('trap-redesign-unapproved.json', 1, 'task_quote: not found in TASK.md', "user_approval: a redesign needs the user's approval");
if (run('node', [v, path.join(c, 'good.json'), '--root', '.', '--task', path.join(c, 'TASK.md'), '--list-visual-proof'], { cwd: dir }).out.replace(/\n+$/, '') !== '{"schema":"ui-design.visual-proof/1","required":["AC-1","AC-2"]}') fail('good.json: visual-proof list must be AC-1, AC-2');
console.log('selfcheck: ui-design ok');
