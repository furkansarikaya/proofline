// @ts-check
// lifecycle-test.sh scenarios scenario_fingerprint_excludes_agents .. scenario_completion_response (lines 1071-1460) as Node tests (176-D2, slice 3). Every
// assertion, attack input and message of the shell scenario is kept. The control plane under test is the real one; the fixture is the harness's.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, expectState, git, must, passAll, refused, rv, say, scaffold, solo, tmp, toCodeDone } from '../lib/harness.mjs';
import { BLK, codeDoneRun, ST, anyStale, ap, baseMoves, cpCommit, fp, gateLines, lsDir, nonGate, rd, reopenFailedRun, ro, roApprove, swapLine, upgradeFiles, installCore, wr } from './lifecycle-s3-lib.mjs';

const RUN = '.agents/runs/LC';
const reopenRequests = (/** @type {string} */ d, /** @type {string} */ pat) => lsDir(d, `${RUN}/approvals`).filter((n) => n.includes(pat)).length;
const BLOCK_CASES = [`# Rules\n\n${BLK}`, `${BLK}\nmore text\n`, `${BLK}${BLK}`, '<!-- proofline:begin -->\nblock v1\n', 'just text\n'];

test('scenario_fingerprint_excludes_agents: .agents/ changes are not content, product changes are', () => {
  const d = codeDoneRun();
  const fp0 = fp(d);
  ap(d, '.agents/config.yaml', '# changed control plane\n'); wr(d, '.agents/scripts/new-helper.sh', 'x\n');
  assert.equal(fp(d), fp0, 'a change under .agents/ altered the content fingerprint');
  assert.equal(anyStale(d), false, 'a change under .agents/ made a gate stale');
  ap(d, 'impl.txt', 'more\n');
  assert.notEqual(fp(d), fp0, 'a product change did not alter the content fingerprint');
});

test('scenario_fingerprint_knowledge_extensions: knowledge-scope documents are excluded by extension, executables there still count, one batched git rm', () => {
  const d = codeDoneRun();
  const fp0 = fp(d);
  wr(d, 'docs/design/a.md', '# notes\n'); wr(d, 'docs/design/b.json', '{}\n');
  assert.equal(fp(d), fp0, 'documentation under docs/design/ altered the gate fingerprint');
  wr(d, 'docs/design/evil.sh', 'echo pwned\n');
  assert.notEqual(fp(d), fp0, 'an executable under docs/design/ is invisible to the gate fingerprint');
  // many documents cost one batched git call, not one per file
  const fp1 = fp(d);
  for (let i = 0; i < 500; i++) wr(d, `docs/design/bulk/d${i}.md`, `doc ${i}\n`);
  // deterministic: count the `git rm` calls the fingerprint makes through a shim on PATH (a call per file would be 500)
  const b = tmp('shim'); const log = path.join(b, 'rm.log'); writeFileSync(log, '');
  const real = process.env.PATH ?? '';
  writeFileSync(path.join(b, 'git'), `#!/bin/sh\ncase " $* " in *" rm "*) echo x >> "${log}" ;; esac\nexec "$(PATH="${real}" command -v git)" "$@"\n`); chmodSync(path.join(b, 'git'), 0o755);
  const fp2 = fp(d, { PATH: `${b}:${real}` });
  assert.equal(fp2, fp1, '500 documents altered the gate fingerprint');
  const n = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(n <= 5, `the gate fingerprint made ${n} git rm calls for 500 documents`);
});

test('scenario_fingerprint_scoped_agents_path: a plan-scoped .agents/ path is content and stales the gates, an unscoped one is not', () => {
  const d = codeDoneRun({ scopeAgents: true });
  const fp0 = fp(d);
  assert.equal(anyStale(d), false, 'gates stale before any change');
  ap(d, '.agents/impl.txt', 'edit\n');
  assert.notEqual(fp(d), fp0, 'an edit of a plan-scoped .agents/ file did not change the fingerprint');
  assert.ok(anyStale(d), `gates did not read stale after a plan-scoped .agents/ edit: ${gateLines(d).join('\n')}`);
  ap(d, '.agents/config.yaml', 'edit\n');
  const fp1 = fp(d); ap(d, '.agents/config.yaml', 'more\n');
  assert.equal(fp(d), fp1, 'an unscoped .agents/ file counts as content again');
});

test('scenario_reopen_approval_kinds: reopen approval is for the own id only, FAILED or BLOCKED runs only', () => {
  const d = reopenFailedRun();
  refused(A(d, ['request-approval', 'LC', 'reopen:OTHER']), 'a reopen approval for another run', 'names another run');
  assert.equal(A(d, ['request-approval', 'LC', 'reopen:LC']).status, 0, 'the reopen approval was refused for a FAILED run');
  say(d, 'I approve the reopen of OTHER');
  assert.notEqual(A(d, ['approve', 'LC', 'reopen:OTHER']).status, 0, 'an approval for another run id');
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen refused: ${r.text}`);
  refused(A(d, ['request-approval', 'LC', 'reopen:LC']), 'a reopen approval on a run that is no longer terminal', 'FAILED or BLOCKED run');
});

test('scenario_reopen_after_upgrade: installed files and the proofline block are control plane, reopen after an upgrade works', () => {
  const d = reopenFailedRun({ agentsMd: 1 }); const fp0 = fp(d);
  upgradeFiles(d); swapLine(d, 'AGENTS.md', 'block v1', 'block v2');
  assert.equal(fp(d), fp0, 'installed files or the proofline block changed the content fingerprint');
  assert.equal(anyStale(d), false, 'an upgrade made a gate stale');
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen after an upgrade refused: ${r.text}`);
});

test('scenario_upgrade_product_edits: an AGENTS.md edit outside the proofline block is a product change', () => {
  const d = reopenFailedRun({ agentsMd: 1 }); const fp0 = fp(d);
  swapLine(d, 'AGENTS.md', 'keep it small', 'keep it tiny');
  assert.notEqual(fp(d), fp0, 'an edit outside the proofline block did not change the fingerprint');
  roApprove(d);
  refused(ro(d, ['reopen', 'LC']), 'AGENTS.md edit outside the block', 'outside the frozen scope');
});

test('scenario_upgrade_named_path: a plan-scope-named installed file stays tracked, an unnamed one does not', () => {
  const d = codeDoneRun({ scopeNamed: '.claude/skills/proofline/named.md' });
  wr(d, '.agents/.proofline-manifest', '# version: 0.0.17\n0000  .claude/skills/proofline/named.md\n'); installCore(d);
  const fp0 = fp(d); wr(d, '.claude/skills/proofline/named.md', 'edit\n');
  assert.notEqual(fp(d), fp0, 'a plan-scope-named installed file left the fingerprint');
  assert.ok(anyStale(d), 'gates not stale after a plan-scope-named installed file changed');
  ap(d, '.agents/.proofline-manifest', '0000  .claude/skills/proofline/other.md\n');
  wr(d, '.claude/skills/proofline/other.md', 'other\n'); const fp1 = fp(d); ap(d, '.claude/skills/proofline/other.md', 'more\n');
  assert.equal(fp(d), fp1, 'an unnamed installed file counts as content');
});

test('scenario_upgrade_named_pattern_path: a plan-scope-named proofline-*.md stays tracked, an unnamed one does not', () => {
  const d = codeDoneRun({ scopeNamed: '.claude/agents/proofline-named.md' });
  const fp0 = fp(d); ap(d, '.claude/agents/proofline-named.md', 'edit\n');
  assert.notEqual(fp(d), fp0, 'a plan-scope-named proofline-*.md file left the fingerprint');
  assert.ok(anyStale(d), 'gates not stale after a plan-scope-named proofline-*.md edit');
  const fp1 = fp(d); wr(d, '.claude/agents/proofline-other.md', 'other\n');
  assert.equal(fp(d), fp1, 'an unnamed proofline-*.md file counts as content');
});

test('scenario_upgrade_keeps_tier: an upgrade keeps the tier and the required gates, a product change still raises the tier', () => {
  const d = scaffold({ topology: 'orchestrated', agentsMd: 1 }); const pl0 = nonGate(d);
  upgradeFiles(d); swapLine(d, 'AGENTS.md', 'block v1', 'block v2');
  assert.equal(nonGate(d), pl0, 'an upgrade changed the pipeline (tier or required gates)');
  toCodeDone(d, 'orchestrated');
  for (const f of ['a', 'b', 'c']) wr(d, `prod-${f}.js`, 'x\n');
  assert.notEqual(nonGate(d), pl0, 'a product change no longer raises the tier');
});

test('scenario_reopen_one_question: one joint question, one reply records both approvals, then reopen applies budget and reopen', () => {
  const d = reopenFailedRun({ planExtra: '\n## Tests\n\n- AC-1: `impl.txt` "one"\n- AC-2: `impl_test.txt` "two"' });
  swapLine(d, '.agents/config.yaml', rd(d, '.agents/config.yaml').split('\n').find((l) => /^ {2}mutation_budget: /.test(l)) ?? '', '  mutation_budget: 1');
  let r = ro(d, ['reopen', 'LC']);
  assert.notEqual(r.status, 0, 'reopen ran without any answer');
  assert.ok(r.text.includes('Raise the budget to 2 and reopen the run LC?'), `no joint question: ${r.text}`);
  assert.equal(r.text.split('\n').filter((l) => l.includes('REOPEN SUMMARY')).length, 1, `more than one summary: ${r.text}`);
  assert.equal(reopenRequests(d, '-request-'), 2, 'expected exactly the two joint requests');
  assert.notEqual(ro(d, ['reopen', 'LC']).status, 0, 'second run without an answer applied');
  assert.equal(reopenRequests(d, '-request-'), 2, 'a repeated reopen wrote more requests');
  assert.notEqual(A(d, ['approve', 'LC', 'reopen:LC']).status, 0, 'a model approved the joint question');
  say(d, 'approve mutation budget');
  assert.notEqual(A(d, ['approve', 'LC', 'mutation_budget']).status, 0, 'budget words alone approved the joint budget request');
  assert.notEqual(A(d, ['approve', 'LC', 'reopen:LC']).status, 0, 'budget words alone approved the joint reopen request');
  for (const f of lsDir(d, `${RUN}/approvals`)) assert.ok(f.includes('-request-'), `a budget-only reply approved something: ${f}`);
  say(d, 'I approve the reopen of LC');
  assert.equal(A(d, ['approve', 'LC', 'mutation_budget']).status, 0, 'the one reply did not approve the budget');
  assert.equal(A(d, ['approve', 'LC', 'reopen:LC']).status, 0, 'the one reply did not approve the reopen');
  r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen refused after the joint reply: ${r.text}`);
  assert.equal(rd(d, `${RUN}/mutation_budget`).replace(/\n+$/, ''), '2', 'the budget was not raised');
  expectState(d, 'execution', 'state', 'PLANNING');
});

test('scenario_base_moved_control_only: a control-plane-only commit keeps the plan fresh, one base-moved ledger line, reopen succeeds', () => {
  const d = reopenFailedRun({ agentsMd: 1 }); const b0 = rv(d, 'repository', 'base_sha');
  cpCommit(d); assert.notEqual(git(d, ['rev-parse', 'HEAD']), b0, 'no commit was made');
  const out = A(d, ['freshness', 'LC']); assert.equal(out.status, 0, `a control-plane-only commit staled the plan: ${out.text}`);
  assert.ok(out.text.includes('base_sha moved'), `no base-moved line: ${out.text}`);
  assert.equal(baseMoves(d), 1, `expected one base-moved ledger line, got ${baseMoves(d)}`);
  A(d, ['freshness', 'LC']); ro(d, ['reopen', 'LC']);
  assert.equal(baseMoves(d), 1, `the base-moved line was duplicated: ${baseMoves(d)}`);
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen after a control-plane commit refused: ${r.text}`);
});

test('scenario_base_moved_stale: a product file, an AGENTS.md edit outside the block and a foreign base still stale the plan', () => {
  const d = reopenFailedRun({ agentsMd: 1 }); const b0 = git(d, ['rev-parse', 'HEAD']);
  cpCommit(d); wr(d, 'prod.txt', 'x\n'); git(d, ['add', 'prod.txt']); git(d, ['commit', '-q', '-m', 'product']);
  refused(A(d, ['freshness', 'LC']), 'control-plane files plus one product file', ST);
  git(d, ['reset', '-q', '--hard', b0]);
  swapLine(d, 'AGENTS.md', 'keep it small', 'keep it tiny'); git(d, ['commit', '-q', '-a', '-m', 'rules']);
  refused(A(d, ['freshness', 'LC']), 'AGENTS.md edit outside the block', ST);
  git(d, ['reset', '-q', '--hard', b0]);
  git(d, ['checkout', '-q', '--orphan', 'other']); git(d, ['commit', '-q', '-m', 'other']);
  refused(A(d, ['freshness', 'LC']), 'base not an ancestor of HEAD', ST);
});

test('scenario_base_moved_agents_files: .agents manifest and scripts in the base range keep the plan fresh, .agents/runs still stales it', () => {
  const d = reopenFailedRun({ agentsMd: 1 }); const b0 = git(d, ['rev-parse', 'HEAD']);
  ap(d, '.agents/scripts/exec-policy.sh', '# upgraded\n'); cpCommit(d); git(d, ['add', '-f', '.agents/.proofline-manifest', '.agents/scripts/exec-policy.sh']); git(d, ['commit', '-q', '-m', 'chore: .agents upgrade']);
  const out = A(d, ['freshness', 'LC']); assert.equal(out.status, 0, `a tracked .agents manifest and script staled the plan: ${out.text}`);
  A(d, ['freshness', 'LC']); assert.equal(baseMoves(d), 1, `expected one base-moved line, got ${baseMoves(d)}`);
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen after an .agents upgrade commit refused: ${r.text}`);
  git(d, ['reset', '-q', '--hard', b0]); wr(d, '.agents/runs/LC/extra.txt', 'x\n'); git(d, ['add', '-f', '.agents/runs/LC/extra.txt']); git(d, ['commit', '-q', '-m', 'run evidence']);
  refused(A(d, ['freshness', 'LC']), 'a commit touching .agents/runs', ST);
});

test('scenario_base_moved_agents_named: a plan-scope-named .agents file in a commit stales the plan', () => {
  const d = codeDoneRun({ scopeAgents: true });
  ap(d, '.agents/impl.txt', 'edit\n'); git(d, ['add', '-f', '.agents/impl.txt']); git(d, ['commit', '-q', '-m', 'named']);
  refused(A(d, ['freshness', 'LC']), 'plan-scope-named .agents file', 'stale plan: repository.base_sha changed');
});

test('scenario_base_moved_named_path: a plan-scope-named installed path in a commit stales the plan', () => {
  const d = codeDoneRun({ scopeNamed: '.claude/agents/proofline-named.md' });
  ap(d, '.claude/agents/proofline-named.md', 'edit\n'); git(d, ['add', '-A', '.claude']); git(d, ['commit', '-q', '-m', 'named']);
  refused(A(d, ['freshness', 'LC']), 'plan-scope-named installed path', 'stale plan: repository.base_sha changed');
});

test('scenario_second_reopen: a new request per reopen, no stuck approval, a pending request reused', () => {
  const d = reopenFailedRun();
  roApprove(d); assert.equal(ro(d, ['reopen', 'LC']).status, 0, 'first reopen refused');
  const n1 = reopenRequests(d, '-request-reopen');
  assert.equal(A(d, ['terminate', 'LC', 'BLOCKED'], { input: 'reason: the second attempt failed the same gate again\nevidence: gates/*-VERIFY.yaml fail on the new content\n' }).status, 0, 'second terminate refused');
  const out = ro(d, ['reopen', 'LC']);
  assert.notEqual(out.status, 0, 'second reopen ran without a new answer');
  assert.ok(!out.text.includes('already approved'), `second reopen stuck on the used approval: ${out.text}`);
  assert.equal(reopenRequests(d, '-request-reopen'), n1 + 1, `no new request number: ${out.text}`);
  ro(d, ['reopen', 'LC']);
  assert.equal(reopenRequests(d, '-request-reopen'), n1 + 1, 'a pending request was not reused');
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `second reopen refused after its approval: ${r.text}`);
});

test('scenario_second_marker_pair: an edit in the second marker pair is a product change, the first pair stays control plane', () => {
  const d = reopenFailedRun({ agentsMd: 2 }); const fp0 = fp(d);
  swapLine(d, 'AGENTS.md', 'block v1', 'block v2');
  assert.equal(fp(d), fp0, 'an edit in the first pair changed the fingerprint');
  swapLine(d, 'AGENTS.md', 'second pair', 'second edit');
  assert.notEqual(fp(d), fp0, 'an edit inside the second pair did not change the fingerprint');
  roApprove(d);
  refused(ro(d, ['reopen', 'LC']), 'edit inside the second pair', 'outside the frozen scope');
});

for (const f of ['AGENTS.md', 'CLAUDE.md']) {
  test(`scenario_base_moved_new_block_file ${f}: a new block-only file keeps the plan fresh; text around it, a second pair, a lone marker, no markers and a symlink stale it`, () => {
    const d = reopenFailedRun(); const b0 = git(d, ['rev-parse', 'HEAD']);
    for (const c of BLOCK_CASES) {
      wr(d, f, c); git(d, ['add', f]); git(d, ['commit', '-q', '-m', 'new']);
      refused(A(d, ['freshness', 'LC']), `new ${f}: ${c}`, ST);
      // A161 (#131): the message names the file and says what to do
      refused(A(d, ['freshness', 'LC']), `new ${f} names the file: ${c}`, `Changed outside the control plane: ${f}`);
      refused(A(d, ['freshness', 'LC']), `new ${f} says what to do: ${c}`, 'Amend and refreeze the plan to include them, or revert them');
      git(d, ['reset', '-q', '--hard', b0]);
    }
    wr(d, 'README.md', ''); symlinkSync('README.md', path.join(d, f)); git(d, ['add', 'README.md', f]); git(d, ['commit', '-q', '-m', 'new']);   // a symlink is a product change (A161, #131)
    refused(A(d, ['freshness', 'LC']), `new symlink ${f} names the file`, `Changed outside the control plane: ${f}`);
    git(d, ['reset', '-q', '--hard', b0]); git(d, ['clean', '-qfd']);
    wr(d, f, `\n\n${BLK}\n\n`); git(d, ['add', f]); git(d, ['commit', '-q', '-m', 'new']);   // whitespace around the block is accepted
    const out = A(d, ['freshness', 'LC']); assert.equal(out.status, 0, `a new block-only ${f} with surrounding whitespace staled the plan: ${out.text}`);
    assert.ok(out.text.includes('base_sha moved'), `no base-moved line for ${f}: ${out.text}`);
  });
}

test('scenario_base_moved_updates_base: an accepted move writes the new HEAD to base_sha, the ledger keeps the old one, product changes are still seen, reopen works', () => {
  const d = reopenFailedRun({ agentsMd: 1 }); const b0 = rv(d, 'repository', 'base_sha');
  cpCommit(d); const h1 = git(d, ['rev-parse', 'HEAD']);
  assert.equal(A(d, ['freshness', 'LC']).status, 0, 'a control-plane-only commit staled the plan');
  assert.equal(rv(d, 'repository', 'base_sha'), h1, `base_sha is not the new HEAD: ${rv(d, 'repository', 'base_sha')}`);
  assert.ok(rd(d, `${RUN}/LEDGER.log`).split('\n').some((l) => l.includes('base-moved') && l.includes(b0)), `the ledger line does not hold the old base ${b0}`);
  A(d, ['freshness', 'LC']); assert.equal(baseMoves(d), 1, `a second freshness added a ledger line: ${baseMoves(d)}`);
  assert.equal(rv(d, 'repository', 'base_sha'), h1, 'base_sha changed on the second freshness');
  wr(d, 'far.txt', 'x\n');   // a product file after the move is still seen, the diff starts at the new base
  roApprove(d); refused(ro(d, ['reopen', 'LC']), 'product file after the move', 'outside the frozen scope');
  git(d, ['add', 'far.txt']); git(d, ['commit', '-q', '-m', 'product']);
  refused(A(d, ['freshness', 'LC']), 'committed product file after the move', ST);
  git(d, ['reset', '-q', '--hard', h1]);
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen after the base update refused: ${r.text}`);
});

for (const f of ['AGENTS.md', 'CLAUDE.md']) {
  test(`scenario_fingerprint_new_block_file ${f}: a new block-only file is control plane, extra text in it is content`, () => {
    const d = reopenFailedRun(); const fp0 = fp(d);
    upgradeFiles(d); wr(d, f, BLK);
    git(d, ['add', '.claude', '.codex', f]); git(d, ['commit', '-q', '-m', 'chore: upgrade']);
    assert.equal(fp(d), fp0, `a new block-only ${f} changed the content fingerprint`);
    ap(d, f, 'a project rule\n');
    assert.notEqual(fp(d), fp0, `text outside the block of a new ${f} did not change the fingerprint`);
  });
}

test('scenario_uncommitted_block_file: an uncommitted block-only AGENTS.md/CLAUDE.md is control plane; extra text, a second pair, a lone marker, no markers and a symlink are product changes with the hint', () => {
  const d = reopenFailedRun(); const hint = 'holds text besides the proofline block';
  for (const c of BLOCK_CASES) {
    wr(d, 'AGENTS.md', c); wr(d, 'CLAUDE.md', c);
    const out = A(d, ['verify-scope', 'LC']);
    assert.notEqual(out.status, 0, `an uncommitted AGENTS.md/CLAUDE.md with ${JSON.stringify(c)} passed verify-scope: ${out.text}`);
    assert.ok(out.text.includes(hint), `no hint for ${JSON.stringify(c)}: ${out.text}`);
    assert.ok(out.text.split('\n').includes('AGENTS.md'), `AGENTS.md not listed for ${JSON.stringify(c)}: ${out.text}`);
  }
  rmSync(path.join(d, 'AGENTS.md'), { force: true }); rmSync(path.join(d, 'CLAUDE.md'), { force: true });
  symlinkSync('no-such-target', path.join(d, 'CLAUDE.md'));   // an untracked symlink fails verify-scope and says what to do (A161, #131)
  let out = A(d, ['verify-scope', 'LC']);
  assert.notEqual(out.status, 0, `an untracked symlinked CLAUDE.md passed verify-scope: ${out.text}`);
  assert.ok(out.text.includes('replace the symlink with a regular file holding only the proofline block'), `no symlink hint: ${out.text}`);
  rmSync(path.join(d, 'CLAUDE.md'), { force: true });
  wr(d, 'AGENTS.md', `\n\n${BLK}\n\n`); wr(d, 'CLAUDE.md', BLK);   // whitespace around the block is accepted
  out = A(d, ['verify-scope', 'LC']);
  assert.equal(out.status, 0, `uncommitted block-only AGENTS.md and CLAUDE.md failed verify-scope: ${out.text}`);
  assert.ok(out.text.includes('installed proofline files changed'), `not listed as installed files: ${out.text}`);
  const lines = out.text.split('\n');
  assert.ok(lines.includes('  AGENTS.md') && lines.includes('  CLAUDE.md'), `AGENTS.md/CLAUDE.md not listed: ${out.text}`);
  roApprove(d);
  const r = ro(d, ['reopen', 'LC']); assert.equal(r.status, 0, `reopen with uncommitted block-only files refused: ${r.text}`);
});

test('scenario_task_boundaries: Forbidden scope is refused at freeze without a waiver path, Allowed scope and pattern references are checked, a plan inside them freezes', () => {
  const d = scaffold({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'manual' });
  const t = path.join(d, RUN, 'TASK.md'); const orig = readFileSync(t, 'utf8'); const before = rd(d, `${RUN}/RUN.yaml`);
  const freeze = () => A(d, ['freeze', 'LC'], { bind: true });
  const task = (/** @type {string} */ extra) => writeFileSync(t, orig + extra);
  ap(d, `${RUN}/TASK.md`, '\n## Forbidden scope\n\n<!-- a comment with - `ignored.txt` in it -->\n- `impl.txt` (the user keeps this file out)\n');
  refused(freeze(), 'a plan path in Forbidden scope froze', 'Forbidden scope');
  assert.equal(before, rd(d, `${RUN}/RUN.yaml`), 'a refused freeze changed RUN.yaml');
  ap(d, `${RUN}/TASK.md`, '\n## Completion response\n\nTried to waive it.\n');   // no agent text or waiver lifts it: a waiver needs a gate finding and the user's approval
  refused(freeze(), 'the Forbidden scope was lifted by editing around it', 'Forbidden scope');
  task('\n## Forbidden scope\n\n- `imp*`\n');
  refused(freeze(), 'a glob in Forbidden scope froze', 'Forbidden scope');
  task('\n## Allowed scope\n\n- `src/`\n');
  refused(freeze(), 'a plan path outside the Allowed scope froze', "outside the task's Allowed scope");
  task('\n## Allowed scope\n\n- `impl.txt`\n');
  refused(freeze(), 'impl_test.txt is outside an Allowed scope of impl.txt', "outside the task's Allowed scope: impl_test.txt");
  task('\n## Existing pattern references\n\n- `no/such/file.go`\n');
  refused(freeze(), 'a pattern reference that does not exist froze', 'does not exist');
  task('\n## Existing pattern references\n\n- `tasks/LC.md`\n');
  refused(freeze(), 'a plan that never names the pattern reference froze', "does not mention the task's Existing pattern reference tasks/LC.md");
  ap(d, `${RUN}/PLAN.md`, '\nFollows tasks/LC.md in structure.\n');
  task('\n## Allowed scope\n\n- `impl*`\n- `docs/`\n\n## Forbidden scope\n\n- `vendor/`\n\n## Existing pattern references\n\n- `tasks/LC.md`\n');
  const r = freeze(); assert.equal(r.status, 0, `a plan inside its Allowed scope, outside Forbidden scope and naming its pattern reference was refused: ${r.text}`);
});

test('scenario_completion_response: the report needs its Requested Response section', () => {
  const d = scaffold({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', taskExtra: '\n## Completion response\n\nThree bullets: what changed, how it was verified, what is left.' });
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  const r = '.agents/runs/LC/COMPLETION_REPORT.md';
  wr(d, r, ['# Completion Report: LC', '', '## Implementation Summary', 'impl.txt and impl_test.txt changed under the TRIVIAL pipeline.', '', '## TDD Evidence', 'RED then GREEN recorded by the lead.', '', '## Verification',
    'The VERIFY gate passed on the final tree.', '', '## Assumptions', 'none', '', '## Review Result', 'REVIEW_SMALL passed.', '', '## Known Limitations / Follow-up', 'None.'].join('\n') + '\n');
  refused(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a report without the requested response was published', 'Requested Response');
  ap(d, r, '\n## Requested Response\n\n- changed: lookup default\n- verified: VERIFY gate\n- left: nothing\n');
  const p = A(d, ['publish-completion-report', 'LC', 'markdown']); assert.equal(p.status, 0, `a report with the requested response was refused: ${p.text}`);
});
