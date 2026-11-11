// @ts-check
// Package TOOLS (stage 2): the string rules of the leaf commands against the real shell `case`, and the list of the commands the Node core owns.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOLS_HANDLERS } from '../../control-plane/agents/scripts/core/commands/tools.mjs';
import { caseMatch, expandWords } from '../../control-plane/agents/scripts/core/shellglob.mjs';
import { shellListed } from './helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('package TOOLS: the string rules', () => {
  test('caseMatch equals the shell case on a pattern x string corpus', () => {
    const pats = ['*', '?', 'a*', '*a', 'a*b', '*.js', 'src/*', '[ab]', '[!ab]', '[a-c]x', 'a[', ']', 'a[]b]', '[]]', '[!]]', '*a*b*', '**', 'a?c', '', '.*', '*/x'];
    const strs = ['', 'a', 'b', 'ab', 'abc', 'x.js', 'src/', 'src/a/b', 'cx', 'a[', 'a]', 'a]b', ']', '.a', 'a/x', 'ab/x', '/x'];
    const lines = [];
    for (const p of pats) for (const s of strs) lines.push(`${p}\t${s}`);
    const script = 'while IFS="	" read -r p s; do case "$s" in $p) echo 1 ;; *) echo 0 ;; esac; done';
    const r = spawnSync('sh', ['-c', script], { input: `${lines.join('\n')}\n`, encoding: 'latin1' });
    const got = r.stdout.trim().split('\n');
    let bridged = 0;
    lines.forEach((l, i) => {
      const [p, s] = l.split('\t');
      let m;
      try { m = caseMatch(p, s ?? ''); } catch (e) { assert.equal(/** @type {Error} */ (e).name, 'ProoflineError'); bridged++; return; }
      assert.equal(m ? '1' : '0', got[i], `${JSON.stringify(p)} ${JSON.stringify(s)}`);
    });
    assert.ok(bridged > 0 && bridged < lines.length / 4, `bridged ${bridged}`);
  });

  test('expandWords expands only in the working folder and leaves unmatched words', () => {
    const d = tempDir('pl-tools-glob-');
    try {
      writeFileSync(path.join(d, 'b.md'), ''); writeFileSync(path.join(d, 'a.md'), ''); writeFileSync(path.join(d, '.h.md'), '');
      assert.deepEqual(expandWords('docs/ *.md *.zz x', d), ['docs/', 'a.md', 'b.md', '*.zz', 'x']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('the handlers of this package are exactly the commands the preamble delegates', () => {
    const agentSh = readFileSync(path.join(repo, 'control-plane/agents/scripts/agent.sh'), 'latin1');
    const shell = shellListed(agentSh);
    for (const c of Object.keys(TOOLS_HANDLERS)) assert.ok(!shell.includes(c), c);
  });
});
