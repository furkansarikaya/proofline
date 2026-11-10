// @ts-check
// task-adversarial-test.sh (A202, 176-D3) as Node tests: adversarial cases of the task model through the real agent.sh: relabelling the task type after the
// freeze, path tricks against the Forbidden scope, the scope bullet tokens, an unreadable type, and the run copy of TASK.md against the task file. Every
// assertion, attack input and message of the shell scenarios is kept; the control plane runs on the live Node path (A242). One test per shell scenario.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, accepted, expectFail, expectMsg, project, worker } from '../lib/harness.mjs';

const TASK = '.agents/runs/LC/TASK.md'; const PLAN = '.agents/runs/LC/PLAN.md';
const rd = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(path.join(d, f), 'utf8');
const wr = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => writeFileSync(path.join(d, f), t);
/** The task file with a front matter block inserted after its first line (the awk `NR == 2` of the shell suite). @param {string} orig @param {string[]} fm */
const withFm = (orig, fm) => { const l = orig.split('\n'); return [l[0], '---', ...fm, '---', ...l.slice(1)].join('\n'); };

// An agent that retypes a bug (in the run's TASK.md) after the freeze makes the run stale: the type is part of the hashed contract.
test('sc_type_relabel_after_freeze: retyping a bug after the freeze is refused (the type is inside the frozen contract)', () => {
  const d = project({ topology: 'orchestrated', cls: 'STANDARD', taskFm: 'type: bug' });
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  wr(d, TASK, rd(d, TASK).replace(/^type: bug$/m, 'type: chore'));
  assert.equal(accepted(A(d, ['task-type', TASK]), 'task-type').out.trim(), 'chore', 'the relabel did not take effect in the fixture');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a bug relabelled chore after the freeze reached IMPLEMENTED');
});

// Forbidden scope with path tricks: the plan path is compared after normalisation.
test('sc_forbidden_paths: Forbidden scope holds against ./, ../, a trailing slash, a leading slash and case', () => {
  const d = project({ topology: 'standalone', cls: 'TRIVIAL', autonomy: 'manual' });
  const taskOrig = rd(d, TASK); const planOrig = rd(d, PLAN);
  for (const forb of ['`./impl.txt`', '`impl.txt/`', '`sub/../impl.txt`', '`IMPL.TXT`', '`/impl.txt`', '`impl.txt `']) {
    wr(d, TASK, `${taskOrig}\n## Forbidden scope\n\n- ${forb}\n`);
    expectMsg(`Forbidden scope ${forb} was not applied to impl.txt`, 'Forbidden scope', A(d, ['freeze', 'LC']));
  }
  wr(d, TASK, `${taskOrig}\n## Forbidden scope\n\n- \`impl.txt\`\n`);
  for (const pp of ['./impl.txt', 'sub/../impl.txt', 'IMPL.txt']) {
    wr(d, PLAN, planOrig.replace('path: impl.txt', `path: ${pp}`));
    assert.notEqual(A(d, ['freeze', 'LC']).status, 0, `A202 GAP: the plan path ${pp} walked around the Forbidden scope entry impl.txt`);
  }
});

// Review B1: every token of a scope bullet counts, a token that is no path refuses the freeze, a heading with trailing text and any case is read.
test('sc_scope_tokens: all tokens of a scope bullet are read, a non-path token refuses the freeze', () => {
  const d = project({ topology: 'standalone', cls: 'TRIVIAL', autonomy: 'manual' });
  const orig = rd(d, TASK); const put = (/** @type {string} */ t) => wr(d, TASK, t);
  for (const forb of ['`other/x.js`, `impl.txt`', 'other/x.js, impl.txt', '`other/` and `impl.txt`', '`other/` `impl_test.txt`']) {
    put(`${orig}\n## Forbidden scope\n\n- ${forb}\n`);
    expectMsg(`Forbidden scope [${forb}] dropped its second entry`, "inside the task's Forbidden scope", A(d, ['freeze', 'LC']));
  }
  for (const head of ['## Forbidden scope (do not touch)', '## FORBIDDEN SCOPE', '### forbidden scope - legacy']) {
    put(`${orig}\n${head}\n\n- \`impl.txt\`\n`);
    expectMsg(`the heading [${head}] was not recognised`, "inside the task's Forbidden scope", A(d, ['freeze', 'LC']));
  }
  put(`${orig}\n## Forbidden scope\r\n\r\n- \`impl.txt\`\r\n`);
  expectMsg('a CRLF Forbidden scope was not applied', "inside the task's Forbidden scope", A(d, ['freeze', 'LC']));
  for (const sec of ['Forbidden scope', 'Allowed scope', 'Existing pattern references']) {
    for (const bad of ['- Do not modify the billing module', 'keep away from impl.txt please', '- `src/ and more`']) {
      put(`${orig}\n## ${sec}\n\n${bad}\n`);
      expectMsg(`[${sec}: ${bad}] was read as an entry`, 'is not a path or glob', A(d, ['freeze', 'LC']));
    }
  }
  put(`${orig}\n## Forbidden scope\n\n- \`src/{a,b}.js\`\n`);
  expectMsg('a brace group was read as one path', '"src/{a"', A(d, ['freeze', 'LC']));
  put(`${orig}\n## Forbidden scope\n\n- \`src/foo.js:\`\n- src/bar.js:\n`);
  const t = path.join(d, TASK);
  assert.equal(A(d, ['task-scope-entries', t, 'Forbidden scope']).out.replace(/\n/g, ' '), 'src/foo.js src/bar.js ', `a trailing colon was not stripped: ${A(d, ['task-scope-entries', t, 'Forbidden scope']).out}`);
  put(`${orig}\n## Forbidden scope\n\n- Do not modify the billing module\n`);
  assert.ok(A(d, ['freeze', 'LC']).text.includes('"Do"'), 'the refusal does not name the token Do');
  assert.equal(A(d, ['task-scope-entries', t, 'Forbidden scope']).out.replace(/\n$/, ''), '', 'a prose bullet produced entries');
});

// Review B2: an unreadable task type is refused (never read as a feature); CRLF front matter and a trailing comment are read.
test('sc_type_unreadable: an unreadable type is refused, CRLF and a trailing comment are read', () => {
  const d = project({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual' });
  const orig = rd(d, TASK); const t = path.join(d, TASK);
  const type = () => A(d, ['task-type', t]).out.replace(/\n$/, '');
  for (const ty of ['bugfix', 'hotfix', 'bug fix', 'Bug2']) {
    wr(d, TASK, withFm(orig, [`type: ${ty}`]));
    assert.equal(type(), 'invalid', `type: ${ty} was not invalid: ${type()}`);
    expectMsg(`classify accepted type: ${ty}`, 'cannot be read', A(d, ['classify', 'LC', 'TRIVIAL']));
    expectMsg(`freeze accepted type: ${ty}`, 'cannot be read', A(d, ['freeze', 'LC']));
  }
  wr(d, TASK, withFm(orig, ['type: bug', 'type: chore']));
  assert.equal(type(), 'invalid', 'a duplicate type: line was not invalid');
  expectMsg('classify accepted two type: lines', 'cannot be read', A(d, ['classify', 'LC', 'TRIVIAL']));
  wr(d, TASK, withFm(orig, ['type: bug # a note']));
  assert.equal(type(), 'bug', 'type: bug # note was not read as bug');
  expectMsg('TRIVIAL accepted for type: bug # note', 'typed bug', A(d, ['classify', 'LC', 'TRIVIAL']));
  wr(d, TASK, withFm(orig, ['type: bug']).replace(/\n/g, '\r\n'));
  assert.equal(type(), 'bug', `CRLF front matter was not read as bug: ${type()}`);
  expectMsg('TRIVIAL accepted for CRLF type: bug', 'typed bug', A(d, ['classify', 'LC', 'TRIVIAL']));
});

// Review B3: the run copy of TASK.md must say what the task file says about type and boundaries before the first freeze.
test('sc_run_copy_vs_source: the run copy is compared with the task file before the first freeze', () => {
  const d = project({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual' });
  const src = '# Task: LC — lookup\n\n---\ntype: bug\n---\n\n## Acceptance criteria\n\n- AC-1: lookup behavior\n\n## Forbidden scope\n\n- `other/x.js`\n';
  wr(d, 'tasks/LC.md', src);
  wr(d, TASK, src.replace(/^type: bug$/m, 'type: chore'));
  expectMsg('a retyped run copy froze', 'says type chore but the task file', A(d, ['freeze', 'LC']));
  wr(d, TASK, src.slice(0, src.indexOf('## Forbidden scope')));
  expectMsg('a run copy without the Forbidden scope froze', 'differs from the task file', A(d, ['freeze', 'LC']));
  wr(d, TASK, src.replace('other/x.js', 'other/y.js'));
  expectMsg('a run copy with another Forbidden entry froze', 'differs from the task file', A(d, ['freeze', 'LC']));
  wr(d, TASK, src);
  const fo = A(d, ['freeze', 'LC']).text;
  assert.ok(!fo.includes('differs from the task file'), `an identical run copy was refused as different: ${fo}`);
  assert.ok(!fo.includes('says type'), `an identical run copy was refused on its type: ${fo}`);
});
