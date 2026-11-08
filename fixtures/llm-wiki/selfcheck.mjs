// Proves the llm-wiki fixture built in <dir>: the valid wiki lints clean (and writes lint-report.md), and each
// planted defect is reported with the right severity. usage: node selfcheck.mjs <built-dir>
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const w0 = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const v = path.join(repoRoot, 'skills/llm-wiki/scripts/validate-wiki.mjs');
if (run('node', [v, path.join(w0, 'docs/wiki'), '--root', w0]).status !== 0) fail('the valid wiki was rejected');
if (!readFileSync(path.join(w0, 'docs/wiki/lint-report.md'), 'utf8').includes('Errors: 0')) fail('lint-report.md was not written');
const tmp = mkdtempSync(path.join(tmpdir(), 'llm-wiki-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
/** @param {string} label @param {number} code @param {string} message @param {(wiki: string) => void} edit */
function expect(label, code, message, edit) {
  const r = path.join(tmp, 'r'); rmSync(r, { recursive: true, force: true }); cpSync(w0, r, { recursive: true });
  edit(path.join(r, 'docs/wiki'));
  const x = run('node', [v, path.join(r, 'docs/wiki'), '--root', r]);
  if (x.status !== code) fail(`${label}: exit ${x.status}, wanted ${code}: ${x.text.trimEnd()}`);
  if (!x.text.includes(message)) fail(`${label}: expected '${message}' in: ${x.text.trimEnd()}`);
}
/** Rewrite a page: drop lines / replace the first matching line (`sed 's|^key: .*|...|'`). */
const edit = (/** @type {string} */ wiki, /** @type {string} */ rel, /** @type {(s: string) => string} */ fn) => { const p = path.join(wiki, rel); writeFileSync(p, fn(readFileSync(p, 'utf8'))); };
const lines = (/** @type {string} */ s, /** @type {(l: string) => string | null} */ fn) => s.split('\n').map(fn).filter((l) => l !== null).join('\n');
expect('missing source', 1, 'missing source metadata: docs/wiki/concepts/retry-policy.md', (wk) => edit(wk, 'concepts/retry-policy.md', (s) => lines(s, (l) => (l.startsWith('source: ') ? null : l))));
expect('dangling source', 1, 'nonexistent provenance source: docs/wiki/entities/job-queue.md', (wk) => edit(wk, 'entities/job-queue.md', (s) => lines(s, (l) => (l.startsWith('source: ') ? 'source: docs/design/GONE.md' : l))));
expect('invalid status', 1, 'invalid status done', (wk) => edit(wk, 'concepts/retry-policy.md', (s) => lines(s, (l) => l.replace(/^status: current/, 'status: done'))));
expect('contradicted', 1, 'contradicted page lacks contradicts', (wk) => edit(wk, 'decisions/use-backoff.md', (s) => lines(s, (l) => l.replace(/^status: accepted/, 'status: contradicted'))));
expect('duplicate title', 1, 'duplicate title: job-queue', (wk) => edit(wk, 'lessons/validate-before-enqueue.md', (s) => lines(s, (l) => l.replace(/^title: .*/, 'title: job-queue'))));
expect('broken wikilink', 1, 'broken wikilink: [[nope]]', (wk) => appendFileSync(path.join(wk, 'concepts/retry-policy.md'), 'See [[nope]].\n'));
expect('orphan', 0, 'possible orphan page: docs/wiki/lessons/loose.md', (wk) => writeFileSync(path.join(wk, 'lessons/loose.md'), lines(readFileSync(path.join(wk, 'lessons/validate-before-enqueue.md'), 'utf8'), (l) => l.replace(/^title: .*/, 'title: loose'))));
