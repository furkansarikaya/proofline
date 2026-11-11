// @ts-check
// tests/ci/shell-census.mjs on a throwaway repository with two commits: the numbers are those of the ref named, not of the working tree, and the output is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { census, main, table } from './shell-census.mjs';

/** @param {string} dir @param {string[]} a */
const git = (dir, a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
/** @param {string} dir @param {string} rel @param {string} text */
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'census-'));
  git(dir, ['init', '-q', '-b', 'main']);
  put(dir, 'a.sh', '#!/bin/sh\n# a comment\n\nawk \'{print}\' f\necho x | sed s/a/b/\n');
  put(dir, 'bin/tool', '#!/usr/bin/env bash\necho tool\n');
  put(dir, 'githooks/pre-commit', 'exit 0\n');
  put(dir, 'lib/p.awk', '{ print }\n{ print }\n');
  put(dir, 'lib/x.mjs', 'export default 1;\n');
  put(dir, 'README.md', '```sh\nawk x\n```\n');
  put(dir, '.github/workflows/ci.yml', 'name: t\njobs:\n  a:\n    steps:\n      - run: |\n          one\n          two\n      - run: node x.mjs\n');
  put(dir, 'adapters/claude/hooks/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node h.mjs' }] }] } }));
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'old']);
  git(dir, ['tag', 'old']);
  git(dir, ['rm', '-q', 'a.sh', 'lib/p.awk', 'bin/tool']);
  put(dir, 'control-plane/agents/scripts/agent.sh', '#!/bin/sh\nexec node x.mjs\n');
  put(dir, 'control-plane/core.mjs', 'a\nb\nc\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'new']);
  return dir;
}

test('the numbers of a ref are those of its commit, not of the working tree; a later commit changes them', () => {
  const d = fixture();
  try {
    put(d, 'untracked.sh', '#!/bin/sh\necho no\n');   // not in any commit: never counted
    const old = census(d, 'old');
    assert.deepEqual({ ...old, ref: '', commit: '' }, { ref: '', commit: '', shellFiles: 3, shellLines: 5 + 2 + 1, shellCodeLines: 3 + 2 + 1, awkFiles: 1, awkLines: 2, awkSedLines: 2, ciSteps: 2, ciMultiLineSteps: 1, hookStrings: 1, nodeFiles: 0, nodeLines: 0 });
    const now = census(d, 'HEAD');
    assert.equal(now.shellFiles, 2);   // githooks/pre-commit and the new agent.sh
    assert.equal(now.awkFiles, 0);
    assert.equal(now.awkSedLines, 0);
    assert.equal(now.nodeFiles, 1);
    assert.equal(now.nodeLines, 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the table is deterministic and has one column per ref; an unknown ref is an error', () => {
  const d = fixture();
  try {
    const rows = [census(d, 'old'), census(d, 'HEAD')];
    assert.equal(table(rows), table([census(d, 'old'), census(d, 'HEAD')]));
    const lines = table(rows).trim().split('\n');
    assert.equal(lines[0].split('|').length, 5);
    assert.match(lines[0], /\| old \(/);
    assert.throws(() => census(d, 'no-such-ref'));
    assert.equal(main(['--root', d, 'no-such-ref']), 1);
    assert.equal(main([]), 2);
    assert.equal(main(['--bogus']), 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
