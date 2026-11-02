// @ts-check
// T2 port of lifecycle-test.sh (fingerprint, upgrade, block and base-moved scenarios) and gates-test.sh (legacy fingerprint, read-only object database):
// what is content and what is control plane for the gate fingerprint, and when a moved base keeps the plan fresh. States are snapshots recorded
// once from the legacy fixtures; the assertions are the ones the shell scenarios made. Nothing here runs or compares with the shell.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { helpers, node, restore } from './port-t2-lib.mjs';

/** @param {string} r */
const fp = (r) => { const x = node(r, ['fingerprint', 'LC']); assert.equal(x.code, 0, x.err); return x.out.trim(); };
/** @param {string} r */
const gates = (r) => node(r, ['pipeline', 'LC']).out.split('\n').filter((l) => l.startsWith('gate.'));
/** @param {string} r */
const stale = (r) => gates(r).some((l) => l.includes('=stale'));
/** @param {ReturnType<typeof helpers>} h */
function upgradeFiles(h) {
  h.write('.claude/agents/proofline-x.md', 'agent\n'); h.write('.codex/agents/proofline-x.toml', 'agent\n'); h.write('.claude/skills/proofline/SKILL.md', 'skill\n');
  h.write('.agents/.proofline-manifest', '# version: 0.0.17\n0000  .claude/skills/proofline/SKILL.md\n');
}
/** @param {ReturnType<typeof helpers>} h @param {string} from @param {string} to */
function lineSwap(h, from, to) { h.write('AGENTS.md', h.read('AGENTS.md').split('\n').map((l) => (l === from ? to : l)).join('\n')); }
/** commit an upgrade-style change: installed files, a manifest and the proofline block (cp_commit) @param {ReturnType<typeof helpers>} h */
function cpCommit(h) { upgradeFiles(h); lineSwap(h, 'block v1', 'block v2'); h.git(['add', '.claude', '.codex', 'AGENTS.md']); h.git(['commit', '-q', '-m', 'chore: upgrade']); }
const ST = 'stale plan: repository.base_sha changed';
/** @param {string} r @param {string} want */
function stalePlan(r, want = ST) { const x = node(r, ['freshness', 'LC']); assert.notEqual(x.code, 0, `freshness passed: ${x.out}${x.err}`); assert.ok((x.out + x.err).includes(want), `no "${want}" in: ${x.out}${x.err}`); return x.out + x.err; }
/** @param {string} r */
const baseMoves = (r) => (readFileSync(path.join(r, '.agents/runs/LC/LEDGER.log'), 'latin1').match(/base-moved/g) ?? []).length;
/** @param {string} r */
const baseSha = (r) => (/^ {2}base_sha: "?([0-9a-f]{40})/m.exec(readFileSync(path.join(r, '.agents/runs/LC/RUN.yaml'), 'latin1')) ?? [])[1];

describe('what is content for the gate fingerprint (lifecycle-test)', () => {
  test('scenario_fingerprint_excludes_agents: .agents/ changes are not content, product changes are, no gate goes stale', () => {
    const r = restore('codedone'); const h = helpers(r); const fp0 = fp(r);
    h.append('.agents/config.yaml', '# changed control plane\n'); h.write('.agents/scripts/new-helper.sh', 'x\n');
    assert.equal(fp(r), fp0); assert.equal(stale(r), false);
    h.append('impl.txt', 'more\n'); assert.notEqual(fp(r), fp0);
  });
  test('scenario_fingerprint_scoped_agents_path: a plan-scoped .agents/ path is content and stales the gates; an unscoped one is not', () => {
    const r = restore('codedone-agents'); const h = helpers(r); const fp0 = fp(r);
    assert.equal(stale(r), false);
    h.append('.agents/impl.txt', 'edit\n');
    assert.notEqual(fp(r), fp0); assert.equal(stale(r), true, gates(r).join('\n'));
    h.append('.agents/config.yaml', 'edit\n'); const fp1 = fp(r); h.append('.agents/config.yaml', 'more\n');
    assert.equal(fp(r), fp1);
  });
  test('scenario_fingerprint_knowledge_extensions: documents under the knowledge scope leave the gate fingerprint, an executable there counts; 500 documents cost a handful of git rm calls', () => {
    const r = restore('codedone'); const h = helpers(r); const fp0 = fp(r);
    h.write('docs/design/a.md', '# notes\n'); h.write('docs/design/b.json', '{}\n');
    assert.equal(fp(r), fp0);
    h.write('docs/design/evil.sh', 'echo pwned\n');
    assert.notEqual(fp(r), fp0);
    const fp1 = fp(r);
    for (let i = 0; i < 500; i++) h.write(`docs/design/bulk/d${i}.md`, `doc ${i}\n`);
    const shim = mkdtempSync(path.join(tmpdir(), 'pl-t2-shim-')); const log = path.join(shim, 'rm.log'); writeFileSync(log, '');
    const real = process.env.PATH ?? '';
    writeFileSync(path.join(shim, 'git'), `#!/bin/sh\ncase " $* " in *" rm "*) echo x >> "${log}" ;; esac\nexec "$(PATH="${real}" command -v git)" "$@"\n`); chmodSync(path.join(shim, 'git'), 0o755);
    const x = node(r, ['fingerprint', 'LC'], { env: { PATH: `${shim}:${real}` } });
    assert.equal(x.out.trim(), fp1);
    assert.ok(readFileSync(log, 'latin1').split('\n').filter(Boolean).length <= 5);
  });
  test('scenario_upgrade_named_path: a plan-scope-named installed file stays tracked, an unnamed manifest file does not', () => {
    const r = restore('codedone-named-skill'); const h = helpers(r);
    h.write('.agents/.proofline-manifest', '# version: 0.0.17\n0000  .claude/skills/proofline/named.md\n');
    const fp0 = fp(r); h.write('.claude/skills/proofline/named.md', 'edit\n');
    assert.notEqual(fp(r), fp0); assert.equal(stale(r), true);
    h.append('.agents/.proofline-manifest', '0000  .claude/skills/proofline/other.md\n');
    h.write('.claude/skills/proofline/other.md', 'other\n'); const fp1 = fp(r); h.append('.claude/skills/proofline/other.md', 'more\n');
    assert.equal(fp(r), fp1);
  });
  test('scenario_upgrade_named_pattern_path: a plan-scope-named proofline-*.md stays tracked, an unnamed one does not', () => {
    const r = restore('codedone-named-agent'); const h = helpers(r); const fp0 = fp(r);
    h.append('.claude/agents/proofline-named.md', 'edit\n');
    assert.notEqual(fp(r), fp0); assert.equal(stale(r), true);
    const fp1 = fp(r); h.write('.claude/agents/proofline-other.md', 'other\n');
    assert.equal(fp(r), fp1);
  });
  test('scenario_upgrade_keeps_tier: an upgrade changes neither the tier nor the required gates; a product change still raises the tier', () => {
    const r = restore('codedone-md'); const h = helpers(r);
    const pl = () => node(r, ['pipeline', 'LC']).out.split('\n').filter((l) => !l.startsWith('gate.')).join('\n');
    const pl0 = pl();
    upgradeFiles(h); lineSwap(h, 'block v1', 'block v2');
    assert.equal(pl(), pl0);
    for (const f of ['a', 'b', 'c']) h.write(`prod-${f}.js`, 'x\n');
    assert.notEqual(pl(), pl0);
  });
  test('scenario_second_marker_pair: only the first marker pair is the block; an edit in the second pair is a product change', () => {
    const r = restore('failed-run-md2'); const h = helpers(r); const fp0 = fp(r);
    lineSwap(h, 'block v1', 'block v2'); assert.equal(fp(r), fp0);
    lineSwap(h, 'second pair', 'second edit'); assert.notEqual(fp(r), fp0);
  });
  test('scenario_upgrade_product_edits: an AGENTS.md edit outside the proofline block is a product change', () => {
    const r = restore('failed-run-md'); const h = helpers(r); const fp0 = fp(r);
    lineSwap(h, 'keep it small', 'keep it tiny'); assert.notEqual(fp(r), fp0);
  });
  test('scenario_reopen_after_upgrade (fingerprint part): installed files and the proofline block are control plane, no gate goes stale', () => {
    const r = restore('failed-run-md'); const h = helpers(r); const fp0 = fp(r);
    upgradeFiles(h); lineSwap(h, 'block v1', 'block v2');
    assert.equal(fp(r), fp0); assert.equal(stale(r), false);
  });
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    test(`scenario_fingerprint_new_block_file ${f}: a new block-only file is control plane, extra text in it is content`, () => {
      const r = restore('failed-run'); const h = helpers(r); const fp0 = fp(r);
      upgradeFiles(h); h.write(f, '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n');
      h.git(['add', '.claude', '.codex', f]); h.git(['commit', '-q', '-m', 'chore: upgrade']);
      assert.equal(fp(r), fp0);
      h.append(f, 'a project rule\n'); assert.notEqual(fp(r), fp0);
    });
  }
});

describe('a moved base (lifecycle-test, cifix-test freshness)', () => {
  test('scenario_base_moved_control_only: a control-plane-only commit keeps the plan fresh, one base-moved ledger line, repeated checks add none', () => {
    const r = restore('failed-run-md'); const h = helpers(r); const b0 = baseSha(r);
    cpCommit(h); assert.notEqual(h.git(['rev-parse', 'HEAD']).trim(), b0);
    const x = node(r, ['freshness', 'LC']); assert.equal(x.code, 0, x.out + x.err); assert.ok((x.out + x.err).includes('base_sha moved'));
    assert.equal(baseMoves(r), 1);
    node(r, ['freshness', 'LC']); assert.equal(baseMoves(r), 1);
  });
  test('scenario_base_moved_stale: a product file, an AGENTS.md edit outside the block and a foreign base still stale the plan', () => {
    const r = restore('failed-run-md'); const h = helpers(r); const b0 = h.git(['rev-parse', 'HEAD']).trim();
    cpCommit(h); h.write('prod.txt', 'x\n'); h.git(['add', 'prod.txt']); h.git(['commit', '-q', '-m', 'product']);
    stalePlan(r);
    h.git(['reset', '-q', '--hard', b0]);
    lineSwap(h, 'keep it small', 'keep it tiny'); h.git(['commit', '-q', '-am', 'rules']);
    stalePlan(r);
    h.git(['reset', '-q', '--hard', b0]);
    h.git(['checkout', '-q', '--orphan', 'other']); h.git(['commit', '-q', '-m', 'other']);
    stalePlan(r);
  });
  test('scenario_base_moved_agents_files: .agents manifest and scripts keep the plan fresh, a commit under .agents/runs stales it', () => {
    const r = restore('failed-run-md'); const h = helpers(r); const b0 = h.git(['rev-parse', 'HEAD']).trim();
    h.append('.agents/scripts/exec-policy.sh', '# upgraded\n'); cpCommit(h);
    h.git(['add', '-f', '.agents/.proofline-manifest', '.agents/scripts/exec-policy.sh']); h.git(['commit', '-q', '-m', 'chore: .agents upgrade']);
    const x = node(r, ['freshness', 'LC']); assert.equal(x.code, 0, x.out + x.err);
    node(r, ['freshness', 'LC']); assert.equal(baseMoves(r), 1);
    h.git(['reset', '-q', '--hard', b0]); h.write('.agents/runs/LC/extra.txt', 'x\n'); h.git(['add', '-f', '.agents/runs/LC/extra.txt']); h.git(['commit', '-q', '-m', 'run evidence']);
    stalePlan(r);
  });
  test('scenario_base_moved_agents_named: a plan-scope-named .agents file in a commit stales the plan', () => {
    const r = restore('codedone-agents'); const h = helpers(r);
    h.append('.agents/impl.txt', 'edit\n'); h.git(['add', '-f', '.agents/impl.txt']); h.git(['commit', '-q', '-m', 'named']);
    stalePlan(r);
  });
  test('scenario_base_moved_named_path: a plan-scope-named installed path in a commit stales the plan', () => {
    const r = restore('codedone-named-agent'); const h = helpers(r);
    h.append('.claude/agents/proofline-named.md', 'edit\n'); h.git(['add', '-A', '.claude']); h.git(['commit', '-q', '-m', 'named']);
    stalePlan(r);
  });
  test('scenario_base_moved_updates_base: an accepted move writes the new HEAD to base_sha, the ledger keeps the old one, later product changes are still seen', () => {
    const r = restore('failed-run-md'); const h = helpers(r); const b0 = baseSha(r);
    cpCommit(h);
    const head1 = h.git(['rev-parse', 'HEAD']).trim();
    assert.equal(node(r, ['freshness', 'LC']).code, 0);
    assert.equal(baseSha(r), head1);
    assert.ok(readFileSync(path.join(r, '.agents/runs/LC/LEDGER.log'), 'latin1').split('\n').some((l) => l.includes('base-moved') && l.includes(b0)));
    node(r, ['freshness', 'LC']); assert.equal(baseMoves(r), 1); assert.equal(baseSha(r), head1);
    h.write('far.txt', 'x\n'); h.git(['add', 'far.txt']); h.git(['commit', '-q', '-m', 'product']);
    stalePlan(r);
  });
  test('scenario_base_moved_new_block_file: a new block-only file keeps the plan fresh (also with whitespace around it); text before or after, a second pair, a lone marker, no markers and a symlink stale it with the file named', () => {
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const r = restore('failed-run'); const h = helpers(r); const b0 = h.git(['rev-parse', 'HEAD']).trim();
      const blk = '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n';
      for (const c of [`# Rules\n\n${blk}`, `${blk}\nmore text\n`, `${blk}${blk}`, '<!-- proofline:begin -->\nblock v1\n', 'just text\n']) {
        h.write(f, c); h.git(['add', f]); h.git(['commit', '-q', '-m', 'new']);
        const m = stalePlan(r);
        assert.ok(m.includes(`Changed outside the control plane: ${f}`), m);
        assert.ok(m.includes('Amend and refreeze the plan to include them, or revert them'), m);
        h.git(['reset', '-q', '--hard', b0]);
      }
      h.write('README.md', ''); h.rm(f); symlinkSync('README.md', path.join(r, f)); h.git(['add', 'README.md', f]); h.git(['commit', '-q', '-m', 'new']);
      assert.ok(stalePlan(r).includes(`Changed outside the control plane: ${f}`));
      h.git(['reset', '-q', '--hard', b0]); h.git(['clean', '-qfd']);
      h.write(f, `\n\n${blk}\n\n`); h.git(['add', f]); h.git(['commit', '-q', '-m', 'new']);
      const x = node(r, ['freshness', 'LC']); assert.equal(x.code, 0, x.out + x.err); assert.ok((x.out + x.err).includes('base_sha moved'));
    }
  });
});

describe('gates-test: fingerprint', () => {
  test('sc_report_stdin (fingerprint parts): the tasks directory is outside the fingerprint; a read-only object database gives the same value', () => {
    const r = restore('codedone'); const h = helpers(r); const fp0 = fp(r);
    h.write('.agents/tasks/LC-task.md', 'changed bookkeeping\n'); assert.equal(fp(r), fp0);
    h.append('impl.txt', 'new content\n'); const fp2 = fp(r);
    assert.notEqual(fp2, fp0);
    const objs = path.join(r, '.git/objects');
    const chmodAll = (/** @type {number} */ mode) => { for (const d of readdirDeep(objs)) { try { chmodSync(d, mode); } catch { /* gone */ } } chmodSync(objs, mode); };
    try { chmodAll(0o555); assert.equal(fp(r), fp2); } finally { chmodAll(0o755); }
  });
  test('sc_legacy_fingerprint_new_rule: gates recorded on the current rule are stale after a product edit, with a block-only AGENTS.md present', () => {
    const r = restore('codedone'); const h = helpers(r);
    h.write('AGENTS.md', '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n');
    assert.equal(gates(r).filter((l) => !l.endsWith('=pass')).length, 0, gates(r).join('\n'));
    h.append('impl.txt', 'one more line\n');
    assert.ok(gates(r).some((l) => l.includes('=stale')));
    assert.equal(gates(r).some((l) => l.endsWith('=pass')), false);
  });
});

/** @param {string} dir @returns {string[]} */
function readdirDeep(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); out.push(p); if (e.isDirectory()) out.push(...readdirDeep(p)); }
  return out;
}
