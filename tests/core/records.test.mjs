// @ts-check
// records.mjs and scope.mjs against the answers of the shell functions of agent.sh (recorded from them in tests/golden/shell-equivalence.json, A244; the shell was the specification).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { authorizedPath, fieldFrom, fieldOf, gateField, parseLedgerLine, parseManifest, parseTsv, planDestructive, planSectionPresent, runYaml, scopeMappings, scopePaths } from '../../control-plane/agents/scripts/core/records.mjs';
import { inKnowledgeScope, knowledgeScopeEntries, pathMatches, stripProoflineBlock, blockOnlyText, installedControlPath } from '../../control-plane/agents/scripts/core/scope.mjs';
import { makeFixture } from './fixture.mjs';

const GOLD = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'shell-equivalence.json'), 'utf8'));
const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
/** @param {string} rel @param {string} text */
const put = (rel, text) => { mkdirSync(path.dirname(path.join(fx.root, rel)), { recursive: true }); writeFileSync(path.join(fx.root, rel), text, 'latin1'); };

describe('RUN.yaml access gives what section_value gave', () => {
  test('sections, comments, quotes, duplicates, odd lines', () => {
    const text = 'a:\n  k: "v" # c\n  k: other\n  n: 1\n    deep: x\nb:  \n  z: q # r\n---\n  lost: 1\nc:\n  y:\n  w: "a b"\n';
    put('.agents/runs/S1/RUN.yaml', text);
    const dir = `${fx.root}/.agents/runs/S1`;
    const ctx = fx.ctx();
    for (const [s, k] of [['a', 'k'], ['a', 'n'], ['a', 'deep'], ['b', 'z'], ['c', 'y'], ['c', 'w'], ['c', 'lost'], ['nope', 'x']]) {
      const want = GOLD.sectionValue[`${s}.${k}`];
      assert.notEqual(want, undefined, `${s}.${k} has no recorded answer`);
      const v = runYaml(ctx, dir).value(s, k);
      const present = runYaml(ctx, dir).has(s, k);
      assert.equal(`${v}\n${present ? 'present\n' : ''}`.replace(/^\n(?!present)/, '').replace(/^\n$/, '') || want, want, `${s}.${k}`);
      assert.equal(want.split('\n')[0], v, `${s}.${k}`);
      assert.equal(want.includes('present'), present, `${s}.${k} present`);
    }
  });
});

describe('record fields', () => {
  test('evidence_field and field_from (goldens recorded from the shell functions of agent.sh 0.0.47)', () => {
    put('rec.yaml', 'result: "pass"\ngate:   QA\nfingerprint: a"b"c\nresult: second\nfield: x\n');
    const ctx = fx.ctx();
    const golden = { result: ['pass', '"pass"'], gate: ['QA', 'QA'], fingerprint: ['abc', 'a"b"c'], field: ['x', 'x'], none: ['', ''], res: ['', ''] };
    for (const [k, [ev, ff]] of Object.entries(golden)) {
      assert.equal(gateField(ctx, `${fx.root}/rec.yaml`, k), ev, `evidence_field ${k}`);
      assert.equal(fieldFrom(ctx, `${fx.root}/rec.yaml`, k), ff, `field_from ${k}`);
    }
    assert.equal(fieldOf([], 'x'), '');
  });
  test('ledger line, manifest, tsv', () => {
    const l = parseLedgerLine('seq=3 prev=abc event=gate:QA role=lead from=- to=pass digest=dd ts=2026-01-01T00:00:00Z epoch=5 detail=a b  c');
    assert.deepEqual(l, { seq: 3, prev: 'abc', event: 'gate:QA', role: 'lead', from: '-', to: 'pass', digest: 'dd', ts: '2026-01-01T00:00:00Z', epoch: '5', detail: 'a b  c' });
    assert.equal(parseLedgerLine('garbage'), null);
    assert.deepEqual(parseManifest('a/b|h1\nc|h2|x\n\n'), [['a/b', 'h1'], ['c', 'h2|x']]);
    assert.deepEqual(parseTsv('a\tb\n\tc\n'), [['a', 'b'], ['', 'c']]);
  });
});

describe('plan scope and sections give what the shell gave', () => {
  const plans = {
    good: 'x\nscope:\n  - path: src/a.js\n    criteria: [AC-1, AC-2]\n  - path: b|c\n    criteria: [AC-3]\n---\nmore\n',
    badNoCriteria: 'scope:\n  - path: a\n  - path: b\n    criteria: [AC-1]\n',
    badTrailing: 'scope:\n  - path: a\n    criteria: [AC-1]\n  - path: b\n',
    emptyCriteria: 'scope:\n  - path: a\n    criteria: []\n',
  };
  for (const [name, text] of Object.entries(plans)) {
    test(`scope_mappings ${name}`, () => {
      const r = GOLD.scopeMappings[name];
      assert.notEqual(r, undefined, name);
      const m = scopeMappings(text);
      const expect = m.rows.map(([p, c]) => `${p}|${c}`).join('\n') + (m.rows.length ? '\n' : '') + `rc=${m.ok ? 0 : 1}\n`;
      assert.equal(r, expect);
    });
  }
  test('authorized_path, sections, destructive', () => {
    const m = scopeMappings(plans.good);
    assert.equal(authorizedPath(m.rows, 'src/a.js'), true);
    assert.equal(authorizedPath(m.rows, 'b'), true);
    assert.equal(authorizedPath(m.rows, 'src'), false);
    assert.deepEqual(scopePaths(m.rows), ['src/a.js', 'b']);
    for (const t of ['## Data\ndestructive: yes\n', '## Data\n\n  \ndestructive: no  \n', '## Data\nfoo\n', '## Data\n', '# x\n', '## Data \ndestructive: maybe\n', '## Database\ndestructive: yes\n']) {
      const r = GOLD.planDestructive[JSON.stringify(t)];
      assert.notEqual(r, undefined, JSON.stringify(t));
      assert.equal(r, `${planDestructive(t)}\n${planSectionPresent(t, 'Data') ? 'sec\n' : ''}`, JSON.stringify(t));
    }
  });
});

describe('scope helpers give what the shell gave', () => {
  test('path_matches (g2re)', () => {
    const pats = ['*.md', '**/test/**', 'src/*.js', 'a?c', 'docs/', '**', '*', 'x/**/y.ts', 'a.b', '(x)', '[a]*', 'src/**/', '.agents/**', '*.test.* *.spec.*'];
    const paths = ['a.md', 'x/a.md', 'src/a.js', 'src/b/a.js', 'abc', 'a/c', 'docs/', 'docs/a', 'x/y.ts', 'x/z/y.ts', 'a.b', 'axb', '(x)', 'a', '.agents/runs/x', 'a.test.js', 'src/', 'test/a', 'p/test/q/r'];
    for (const p of paths) for (const g of pats) {
      const s = GOLD.pathMatches[`${p}\t${g}`];
      assert.notEqual(s, undefined, `${p} ~ ${g}`);
      assert.equal(pathMatches(p, g) ? 'y' : 'n', s, `${p} ~ ${g}`);
    }
  });
  test('knowledge scope and installed control paths', () => {
    put('.agents/config.yaml', 'knowledge_scope_root: docs/a/ docs/b.md\ndesign_docs:\n  architecture: docs/arch.md\n  adr_dir: docs/decisions/\n  design:\n    shared: docs/shared.md\n    surfaces:\n      web:\n        doc: docs/web.md\n        paths: web/**\n');
    put('.agents/.proofline-manifest', '# x\nh1 docs/installed.md\nh2 .agents/inner\n');
    const ctx = fx.ctx();
    const probe = ['docs/a/x', 'docs/b.md', 'docs/b.mdx', 'docs/arch.md', 'docs/decisions/1.md', 'docs/shared.md', 'docs/web.md', 'src/x', 'docs/a', '.claude/agents/proofline-qa.md', 'docs/installed.md', '.agents/inner', '.codex/agents/proofline-x.toml', '.codex/agents/proofline-.md'];
    assert.ok(knowledgeScopeEntries(ctx).length > 0);
    for (const p of probe) {
      const r = fx.sh(['in-knowledge-scope', p]);
      assert.equal(inKnowledgeScope(ctx, p), r.code === 0, `in_knowledge_scope ${p}`);
    }
    for (const p of probe) {
      const r = GOLD.installedControlPath[p];
      assert.notEqual(r, undefined, p);
      assert.equal(installedControlPath(ctx, p) ? 'y' : 'n', r, `installed_control_path ${p}`);
    }
  });
  test('strip_proofline_block and block_only', () => {
    const texts = ['a\n<!-- proofline:begin -->\nb\n<!-- proofline:end -->\nc\n', '<!-- proofline:begin -->\nb\n<!-- proofline:end -->', 'x', 'x\n<!-- proofline:begin -->\n', '<!-- proofline:begin -->\n<!-- proofline:end -->\n<!-- proofline:begin -->\nz\n<!-- proofline:end -->\n', '  \n<!-- proofline:begin -->\nb\n<!-- proofline:end -->\n \n', '<!-- proofline:end -->\n<!-- proofline:begin -->\nq\n'];
    for (const [i, t] of texts.entries()) {
      const want = GOLD.stripBlock[i];
      assert.notEqual(want, undefined, `text ${i}`);
      assert.equal(stripProoflineBlock(t), want.out, JSON.stringify(t));
      assert.equal(blockOnlyText(t), want.only, JSON.stringify(t));
    }
  });
});
