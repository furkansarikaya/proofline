// @ts-check
// T2 port of gates-test.sh (sc_tier, sc_tier_paths) and lifecycle-test.sh (scenario_uncommitted_block_file): the tier a run's changes put it in,
// the gate set of a CRITICAL run with a Data section, and the scope check of a block-only AGENTS.md/CLAUDE.md that is not committed yet.
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { helpers, node, restore } from './port-t2-lib.mjs';

/** @param {string} r @param {string} key */
const pipeVal = (r, key) => { const l = node(r, ['pipeline', 'LC']).out.split('\n').find((x) => x.startsWith(`${key}=`)); return l === undefined ? '' : l.slice(key.length + 1); };
/** @param {string} r */
const tier = (r) => pipeVal(r, 'tier');
/** the lead's `tier` command records the tier when it rose: RUN.yaml pipeline.tier @param {string} r @param {string} t */
function recordTier(r, t) {
  const y = path.join(r, '.agents/runs/LC/RUN.yaml');
  let inPipe = false;
  writeFileSync(y, readFileSync(y, 'latin1').split('\n').map((l) => { if (/^[a-z_]+:\s*$/.test(l)) inPipe = l === 'pipeline:'; return inPipe && /^ {2}tier:/.test(l) ? `  tier: "${t}"` : l; }).join('\n'), 'latin1');
}

describe('gates-test: tier', () => {
  test('sc_tier: docs, code-like markdown, risky path, size, never decreasing', () => {
    let r = restore('tier-standard'); let h = helpers(r);
    assert.equal(tier(r), 'docs');                                   // no change is not a bigger tier
    h.write('notes.md', 'notes\n'); h.write('docs/guide.txt', 'guide\n');
    assert.equal(tier(r), 'docs');                                   // plain documentation
    h.rm('notes.md'); h.rm('docs');
    h.write('skills/x/SKILL.md', 'a skill\n');
    assert.equal(tier(r), 'small');                                  // code-like markdown
    recordTier(r, 'small'); h.rm('skills');
    assert.equal(tier(r), 'small');                                  // the tier never decreases
    h.write('package.json', '{}\n');
    assert.equal(tier(r), 'full');                                   // a risky path
    recordTier(r, 'full'); h.rm('package.json');
    assert.equal(tier(r), 'full');
    // size limits on a fresh run: more than small_max_lines is full
    r = restore('tier-standard'); h = helpers(r);
    h.append('impl.txt', 'one\n'); assert.equal(tier(r), 'docs');    // a .txt change is docs
    h.write('app.go', 'package x\n'); assert.equal(tier(r), 'small'); // one small code file
    for (let i = 0; i < 31; i++) h.append('app.go', `line ${i}\n`);
    assert.equal(tier(r), 'full');                                   // more than small_max_lines
  });
  test('sc_tier (CRITICAL part): a CRITICAL run is full and a plan with ## Data adds REVIEW_DATA', () => {
    const r = restore('tier-critical-data');
    assert.equal(pipeVal(r, 'gates'), 'SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY');
    assert.equal(tier(r), 'full');
  });
  test('sc_tier_paths: docs only by extension, docs/ code is not docs, dependency manifests are full, the small limits count code files', () => {
    const r = restore('tier-standard'); const h = helpers(r);
    /** @param {string} p @param {string} want */
    const t = (p, want) => { h.write(p, 'x = 1\n'); const got = tier(r); h.rm(p); assert.equal(got, want, `tier of ${p}`); };
    t('docs/guide.adoc', 'docs'); t('notes.mdx', 'docs'); t('docs/api.rst', 'docs'); t('guide.txt', 'docs');
    t('docs/conf.py', 'small'); t('docs/build.sh', 'small'); t('docs/index.html', 'small');
    t('requirements.txt', 'full'); t('requirements-dev.txt', 'full'); t('CMakeLists.txt', 'full'); t('docs/requirements.txt', 'full');
    t('skills/x/SKILL.md', 'small'); t('AGENTS.md', 'small');
    for (let i = 0; i < 10; i++) { h.append('app.go', `line ${i}\n`); h.append('util.go', `line ${i}\n`); }
    assert.equal(tier(r), 'small');                                  // two code files, 20 lines
    h.write('extra.go', 'package x\n');
    assert.equal(tier(r), 'full');                                   // three code files (small_max_files)
    h.rm('extra.go'); for (let i = 0; i < 11; i++) h.append('util.go', `more ${i}\n`);
    assert.equal(tier(r), 'full');                                   // 31 changed lines (small_max_lines)
  });
});

describe('lifecycle-test: an uncommitted block-only AGENTS.md/CLAUDE.md', () => {
  test('scenario_uncommitted_block_file: block-only files are control plane for verify-scope; extra text, a second pair, a lone marker, no markers and a symlink are product changes with the hint', () => {
    const r = restore('failed-run'); const h = helpers(r);
    const blk = '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n';
    const vs = () => { const x = node(r, ['verify-scope', 'LC']); return { ...x, all: x.out + x.err }; };
    for (const c of [`# Rules\n\n${blk}`, `${blk}\nmore text\n`, `${blk}${blk}`, '<!-- proofline:begin -->\nblock v1\n', 'just text\n']) {
      h.write('AGENTS.md', c); h.write('CLAUDE.md', c);
      const x = vs();
      assert.notEqual(x.code, 0, `passed for ${JSON.stringify(c)}: ${x.all}`);
      assert.ok(x.all.includes('holds text besides the proofline block'), x.all);
      assert.ok(x.all.split('\n').includes('AGENTS.md'), x.all);
    }
    h.rm('AGENTS.md'); h.rm('CLAUDE.md');
    symlinkSync('no-such-target', path.join(r, 'CLAUDE.md'));
    let x = vs(); assert.notEqual(x.code, 0, x.all);
    assert.ok(x.all.includes('replace the symlink with a regular file holding only the proofline block'), x.all);
    h.rm('CLAUDE.md');
    h.write('AGENTS.md', `\n\n${blk}\n\n`); h.write('CLAUDE.md', blk);
    x = vs(); assert.equal(x.code, 0, x.all);
    assert.ok(x.all.includes('installed proofline files changed'), x.all);
    const lines = x.all.split('\n'); assert.ok(lines.includes('  AGENTS.md') && lines.includes('  CLAUDE.md'), x.all);
  });
});
