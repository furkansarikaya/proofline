// @ts-check
// The path list that makes the Windows hook leg run on a pull request (A295): a table of changed-file lists, and the classify step's windows_hook output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES, PREFIXES, matchesWindowsHook, windowsHook } from './windows-hook-paths.mjs';
import { main } from './ci-steps.mjs';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tempDir } from '../lib/tempdir.mjs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');

/** The repository files a hook test reaches through relative imports, transitively through files under tests/. @returns {Set<string>} */
function reachedFromHookTests() {
  /** @type {Set<string>} */ const seen = new Set();
  const queue = readdirSync(path.join(repo, 'tests/hook')).filter((n) => n.endsWith('.mjs')).map((n) => `tests/hook/${n}`);
  while (queue.length > 0) {
    const f = /** @type {string} */ (queue.pop());
    if (seen.has(f)) continue;
    seen.add(f);
    if (!f.startsWith('tests/')) continue;   // sources are checked against the list, their own imports are not followed
    const text = readFileSync(path.join(repo, f), 'utf8');
    const specs = [/\bfrom\s*['"](\.[^'"]+)['"]/g, /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, /\bimport\s+['"](\.[^'"]+)['"]/g, /\bexport\s+\*\s+from\s*['"](\.[^'"]+)['"]/g];
    for (const re of specs) for (const m of text.matchAll(re)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      const r = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, `${base}/index.mjs`, `${base}/index.js`].find((c) => { try { return statSync(path.join(repo, c)).isFile(); } catch { return false; } });
      if (r) queue.push(r);
    }
  }
  return seen;
}

test('every file the hook tests import (transitively under tests/) is covered by the list', () => {
  const missing = [...reachedFromHookTests()].filter((f) => !matchesWindowsHook(f));
  assert.deepEqual(missing, [], `add to tests/ci/windows-hook-paths.mjs: ${missing.join(', ')}`);
  assert.ok(reachedFromHookTests().size > 20, 'the scan found the hook tests and their imports');
});

test('every listed exact file exists', () => {
  for (const f of FILES) assert.ok(existsSync(path.join(repo, f)), f);
  for (const p of PREFIXES) assert.ok(existsSync(path.join(repo, p.replace(/-$/, '').replace(/\/$/, ''))) || readdirSync(path.join(repo, path.dirname(p))).some((n) => `${path.dirname(p)}/${n}`.startsWith(p)), p);
});

/** @type {[string, string[], boolean][]} */
const TABLE = [
  ['a hook file', ['adapters/claude/hooks/guards/bash.mjs'], true],
  ['the hook entry point', ['adapters/claude/hooks/proofline-hook.mjs'], true],
  ['the Codex hook wiring', ['adapters/codex/hooks.json'], true],
  ['a core path module', ['control-plane/agents/scripts/core/paths.mjs'], true],
  ['the shell glob module', ['control-plane/agents/scripts/core/shellglob.mjs'], true],
  ['the process module', ['control-plane/agents/scripts/core/proc.mjs'], true],
  ['a hook test', ['tests/hook/win-drive-guards.test.mjs'], true],
  ['the Windows path test', ['tests/ci/windows-paths.test.mjs'], true],
  ['the Windows probe', ['tests/ci/windows-probe.mjs'], true],
  ['the workflow file', ['.github/workflows/ci.yml'], true],
  ['a documentation-only change', ['README.md', 'docs/concepts/workflow.md', 'CONTRIBUTING.md'], false],
  ['an unrelated skill', ['skills/proofline/SKILL.md'], false],
  ['an unrelated core module', ['control-plane/agents/scripts/core/ledger.mjs'], false],
  ['an unrelated CI file', ['tests/ci/classify.mjs'], false],
  ['the other workflow files', ['.github/workflows/release.yml'], false],
  ['a lookalike of a prefix', ['adapters/claude/hooks-old/x.mjs', 'tests/hooks/x.mjs', 'adapters/codex/agents/x.md'], false],
  ['a lookalike of a file', ['control-plane/agents/scripts/core/paths.mjs.bak', 'control-plane/agents/scripts/core/pathsx.mjs'], false],
  ['a deleted hook test (a deletion is listed by name)', ['tests/hook/old.test.mjs'], true],
  ['a rename out of the list (both names are listed)', ['tests/hook/a.test.mjs', 'tests/core/a.test.mjs'], true],
  ['a rename into the list', ['skills/x.md', 'adapters/claude/hooks/lib/x.mjs'], true],
  ['an empty list', [], false],
  ['empty entries only', ['', ''], false],
  ['one match in a long list', [...Array.from({ length: 5000 }, (_, i) => `docs/page-${i}.md`), 'adapters/claude/hooks/lib/text.mjs', ...Array.from({ length: 5000 }, (_, i) => `skills/s${i}/SKILL.md`)], true],
  ['a long list without a match', Array.from({ length: 10000 }, (_, i) => `skills/s${i}/SKILL.md`), false],
];

for (const [name, files, want] of TABLE) test(`windowsHook: ${name} is ${want}`, () => assert.equal(windowsHook(files), want));

test('the list has no duplicates, no leading slash, and every prefix ends in / or -', () => {
  assert.equal(new Set([...FILES, ...PREFIXES]).size, FILES.length + PREFIXES.length);
  for (const e of [...FILES, ...PREFIXES]) assert.ok(!e.startsWith('/') && !e.includes('\\'), e);
  for (const p of PREFIXES) assert.match(p, /[/-]$/);
  for (const f of FILES) assert.ok(matchesWindowsHook(f), f);
});

/** @param {string[]} argv @param {Parameters<typeof main>[1]} io */
function steps(argv, io) { let out = ''; const status = main(argv, { write: (s) => { out += s; }, ...io }); return { status, out }; }

test('classify prints windows_hook beside code: true for a matching pull request, false for another, false for a push or a schedule', () => {
  const pr = ['classify', '--event', 'pull_request', '--base', 'b', '--head', 'h'];
  assert.deepEqual(steps(pr, { env: {}, changed: () => ['adapters/claude/hooks/guards/kill.mjs'] }), { status: 0, out: 'code=true\nwindows_hook=true\n' });
  assert.deepEqual(steps(pr, { env: {}, changed: () => ['skills/x/SKILL.md'] }), { status: 0, out: 'code=true\nwindows_hook=false\n' });
  assert.deepEqual(steps(pr, { env: {}, changed: () => ['README.md'] }), { status: 0, out: 'code=false\nwindows_hook=false\n' });
  assert.deepEqual(steps(pr, { env: {}, changed: () => [] }), { status: 0, out: 'code=true\nwindows_hook=false\n' });
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.deepEqual(steps(['classify', '--event', event], { env: {}, changed: () => { throw new Error('not asked'); } }), { status: 0, out: 'code=true\nwindows_hook=false\n' }, event);
  }
});

test('classify for a push: BASE_SHA empty, GITHUB_EVENT_NAME=push reads no diff and writes both outputs to GITHUB_OUTPUT', () => {
  const f = path.join(tempDir('wh-'), 'out'); writeFileSync(f, '');
  assert.equal(main(['classify'], { env: { GITHUB_EVENT_NAME: 'push', BASE_SHA: '', GITHUB_OUTPUT: f }, write: () => {}, changed: () => { throw new Error('not asked'); } }), 0);
  assert.equal(readFileSync(f, 'utf8'), 'code=true\nwindows_hook=false\n');
});
