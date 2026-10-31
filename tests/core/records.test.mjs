// @ts-check
// records.mjs and scope.mjs against the shell functions of agent.sh (the shell is the specification).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { authorizedPath, fieldFrom, fieldOf, gateField, parseLedgerLine, parseManifest, parseTsv, planDestructive, planSectionPresent, runYaml, scopeMappings, scopePaths } from '../../control-plane/agents/scripts/core/records.mjs';
import { inKnowledgeScope, knowledgeScopeEntries, pathMatches, stripProoflineBlock, blockOnlyText, installedControlPath } from '../../control-plane/agents/scripts/core/scope.mjs';
import { extractFunctions, extractRange, agentSh } from './helpers.mjs';
import { makeFixture } from './fixture.mjs';

const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
/** @param {string} rel @param {string} text */
const put = (rel, text) => { mkdirSync(path.dirname(path.join(fx.root, rel)), { recursive: true }); writeFileSync(path.join(fx.root, rel), text, 'latin1'); };
/** @param {string} script @param {string[]} [args] */
const sh = (script, args = []) => spawnSync('sh', ['-c', script, 'x', ...args], { encoding: 'latin1', env: { ...process.env, LC_ALL: 'C' }, cwd: fx.root });

describe('RUN.yaml access equals section_value', () => {
  test('sections, comments, quotes, duplicates, odd lines', () => {
    const text = 'a:\n  k: "v" # c\n  k: other\n  n: 1\n    deep: x\nb:  \n  z: q # r\n---\n  lost: 1\nc:\n  y:\n  w: "a b"\n';
    put('.agents/runs/S1/RUN.yaml', text);
    const dir = `${fx.root}/.agents/runs/S1`;
    const ctx = fx.ctx();
    const fns = extractFunctions(['sv_reset', 'sv_load', 'section_value', 'section_key_present']);
    for (const [s, k] of [['a', 'k'], ['a', 'n'], ['a', 'deep'], ['b', 'z'], ['c', 'y'], ['c', 'w'], ['c', 'lost'], ['nope', 'x']]) {
      const r = sh(`sv_dir='' sv_cache=''\n${fns}\nsection_value "$1" "$2" "$3"; section_key_present "$1" "$2" "$3" && echo present`, [dir, s, k]);
      const v = runYaml(ctx, dir).value(s, k);
      const present = runYaml(ctx, dir).has(s, k);
      assert.equal(r.stdout, `${v}\n${present ? 'present\n' : ''}`.replace(/^\n(?!present)/, '').replace(/^\n$/, '') || r.stdout, `${s}.${k}`);
      assert.equal(r.stdout.split('\n')[0], v, `${s}.${k}`);
      assert.equal(r.stdout.includes('present'), present, `${s}.${k} present`);
    }
  });
});

describe('record fields', () => {
  test('evidence_field and field_from', () => {
    put('rec.yaml', 'result: "pass"\ngate:   QA\nfingerprint: a"b"c\nresult: second\nfield: x\n');
    const fns = extractFunctions(['evidence_field', 'field_from']);
    const ctx = fx.ctx();
    for (const k of ['result', 'gate', 'fingerprint', 'field', 'none', 'res']) {
      const e = sh(`${fns}\nevidence_field "$1" "$2"`, [`${fx.root}/rec.yaml`, k]).stdout.replace(/\n$/, '');
      assert.equal(gateField(ctx, `${fx.root}/rec.yaml`, k), e, `evidence_field ${k}`);
      const f = sh(`${fns}\nfield_from "$1" "$2"`, [`${fx.root}/rec.yaml`, k]).stdout.replace(/\n$/, '');
      assert.equal(fieldFrom(ctx, `${fx.root}/rec.yaml`, k), f, `field_from ${k}`);
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

describe('plan scope and sections equal the shell', () => {
  const plans = {
    good: 'x\nscope:\n  - path: src/a.js\n    criteria: [AC-1, AC-2]\n  - path: b|c\n    criteria: [AC-3]\n---\nmore\n',
    badNoCriteria: 'scope:\n  - path: a\n  - path: b\n    criteria: [AC-1]\n',
    badTrailing: 'scope:\n  - path: a\n    criteria: [AC-1]\n  - path: b\n',
    emptyCriteria: 'scope:\n  - path: a\n    criteria: []\n',
  };
  for (const [name, text] of Object.entries(plans)) {
    test(`scope_mappings ${name}`, () => {
      put(`plan-${name}.md`, text);
      const r = sh(`${extractFunctions(['scope_mappings'])}\nscope_mappings "$1"; echo "rc=$?"`, [`${fx.root}/plan-${name}.md`]).stdout;
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
    const fns = extractFunctions(['plan_section_present', 'plan_destructive']);
    for (const t of ['## Data\ndestructive: yes\n', '## Data\n\n  \ndestructive: no  \n', '## Data\nfoo\n', '## Data\n', '# x\n', '## Data \ndestructive: maybe\n', '## Database\ndestructive: yes\n']) {
      put('p.md', t);
      const r = sh(`${fns}\nplan_destructive "$1"; plan_section_present "$1" Data && echo sec`, [`${fx.root}/p.md`]).stdout;
      assert.equal(r, `${planDestructive(t)}\n${planSectionPresent(t, 'Data') ? 'sec\n' : ''}`, JSON.stringify(t));
    }
  });
});

describe('scope helpers equal the shell', () => {
  test('path_matches (g2re)', () => {
    const fns = `${extractRange("g2re_awk='", "    }'")}\n${extractFunctions(['path_matches'])}`;
    const pats = ['*.md', '**/test/**', 'src/*.js', 'a?c', 'docs/', '**', '*', 'x/**/y.ts', 'a.b', '(x)', '[a]*', 'src/**/', '.agents/**', '*.test.* *.spec.*'];
    const paths = ['a.md', 'x/a.md', 'src/a.js', 'src/b/a.js', 'abc', 'a/c', 'docs/', 'docs/a', 'x/y.ts', 'x/z/y.ts', 'a.b', 'axb', '(x)', 'a', '.agents/runs/x', 'a.test.js', 'src/', 'test/a', 'p/test/q/r'];
    for (const p of paths) for (const g of pats) {
      const s = sh(`${fns}\npath_matches "$1" "$2" && echo y || echo n`, [p, g]).stdout.trim();
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
    const fns = extractFunctions(['installed_control_path']);
    for (const p of probe) {
      const r = sh(`root="${fx.root}"\n${fns}\ninstalled_control_path "$1" && echo y || echo n`, [p]).stdout.trim();
      assert.equal(installedControlPath(ctx, p) ? 'y' : 'n', r, `installed_control_path ${p}`);
    }
  });
  test('strip_proofline_block and block_only', () => {
    const fns = extractFunctions(['strip_proofline_block', 'block_only_file']);
    const texts = ['a\n<!-- proofline:begin -->\nb\n<!-- proofline:end -->\nc\n', '<!-- proofline:begin -->\nb\n<!-- proofline:end -->', 'x', 'x\n<!-- proofline:begin -->\n', '<!-- proofline:begin -->\n<!-- proofline:end -->\n<!-- proofline:begin -->\nz\n<!-- proofline:end -->\n', '  \n<!-- proofline:begin -->\nb\n<!-- proofline:end -->\n \n', '<!-- proofline:end -->\n<!-- proofline:begin -->\nq\n'];
    for (const [i, t] of texts.entries()) {
      put(`b${i}.md`, t);
      const f = `${fx.root}/b${i}.md`;
      const out = sh(`${fns}\nstrip_proofline_block "$1" | od -An -c; block_only_file "$1" && echo only`, [f]).stdout;
      const mine = spawnSync('od', ['-An', '-c'], { input: Buffer.from(stripProoflineBlock(t), 'latin1'), encoding: 'latin1' }).stdout;
      assert.equal(out, mine + (blockOnlyText(t) ? 'only\n' : ''), JSON.stringify(t));
    }
  });
  test('agent.sh is the one under test', () => assert.ok(agentSh.includes('strip_proofline_block()')));
});
