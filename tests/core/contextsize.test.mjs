// @ts-check
// Context budget (A202, A230; the former tests/context/context-budget-test.sh and bin/lib/context-size.sh): the text loaded into every session stays within
// tests/context/budget.tsv, and no rule left the AGENTS.md block without a new place (tests/context/rule-map.tsv). Growth is proven on scripted temp copies of the
// repository; nothing in the repository is edited. The SessionStart text is the template file adapters/claude/hooks/lib/session-head.txt: the measurement never reads
// the hook's source.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { checkBudget, contextRows, reportText, tsvText } from '../../control-plane/agents/scripts/core/contextsize.mjs';
import { repo } from './helpers.mjs';

const BUDGET = path.join(repo, 'tests/context/budget.tsv');
const T = mkdtempSync(path.join(tmpdir(), 'pl-ctx-'));
after(() => { rmSync(T, { recursive: true, force: true }); });
const core = path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs');
/** @param {string[]} args @param {Record<string, string>} [env] */
const cli = (args, env = {}) => spawnSync('node', [core, 'cli', 'context-size', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });

/** A scripted copy of the pieces the measurement reads. @param {string} dest */
function copy(dest) {
  mkdirSync(`${dest}/control-plane`, { recursive: true });
  mkdirSync(`${dest}/adapters/claude/hooks`, { recursive: true });
  for (const f of ['AGENTS.md', 'CLAUDE.md']) cpSync(`${repo}/control-plane/${f}`, `${dest}/control-plane/${f}`);
  cpSync(`${repo}/roles`, `${dest}/roles`, { recursive: true });
  cpSync(`${repo}/skills`, `${dest}/skills`, { recursive: true });
  cpSync(`${repo}/adapters/claude/agents`, `${dest}/adapters/claude/agents`, { recursive: true });
  cpSync(`${repo}/adapters/claude/hooks/lib`, `${dest}/adapters/claude/hooks/lib`, { recursive: true });
}
const big = (/** @type {number} */ n) => 'x'.repeat(n);
const checkOf = (/** @type {string} */ root, /** @type {string} */ budget = readFileSync(BUDGET, 'utf8')) => checkBudget(contextRows('repo', root, root), budget);

test('the repository is within its context budget', () => {
  assert.deepEqual(checkOf(repo), []);
  const r = cli(['repo', '.', 'check', 'tests/context/budget.tsv']);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('every moved rule is still at its new place', () => {
  const rows = readFileSync(path.join(repo, 'tests/context/rule-map.tsv'), 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split('\t'));
  assert.ok(rows.length >= 30, `the map has only ${rows.length} rows`);
  const norm = (/** @type {string} */ s) => s.replace(/\n/g, ' ').replace(/ +/g, ' ');
  /** @type {string[]} */ const missing = [];
  for (const [id, file, frag] of rows) {
    let hay;
    try { hay = norm(readFileSync(path.join(repo, file), 'utf8')); } catch { missing.push(`${id}(no file ${file})`); continue; }
    if (!hay.includes(norm(frag))) missing.push(id);
  }
  assert.deepEqual(missing, []);
});

test('the items are the ones the shell script measured, in its order, with tokens = bytes / 4 rounded up and the path of each file', () => {
  const rows = contextRows('repo', repo, repo);
  assert.deepEqual(rows.map((r) => r.name), ['agents_md', 'claude_md', 'session_start', 'entry_skill', 'role.lead.skill',
    ...['architect', 'data_architect', 'designer', 'explorer', 'implementer', 'qa', 'reviewer', 'security_reviewer', 'task_author', 'verifier'].flatMap((r) => [`role.${r}.agent`, `role.${r}.skill`])]);
  for (const r of rows) {
    assert.equal(r.tokens, Math.ceil(r.bytes / 4), r.name);
    assert.ok(r.bytes > 0 && r.path.startsWith(`${repo}/`), r.name);
  }
  assert.equal(rows[0].path, `${repo}/control-plane/AGENTS.md`);
  assert.equal(rows[2].path, `${repo}/adapters/claude/hooks/lib/session-head.txt`);
  assert.equal(tsvText(rows).split('\n')[1], `claude_md\t${rows[1].bytes}\t${rows[1].tokens}\t${repo}/control-plane/CLAUDE.md`);
});

test('a project counts the proofline block only, not the user text around it; tokens are bytes / 4, rounded up', () => {
  const P = path.join(T, 'proj');
  mkdirSync(P, { recursive: true });
  const block = readFileSync(path.join(repo, 'control-plane/AGENTS.md'), 'utf8');
  writeFileSync(path.join(P, 'AGENTS.md'), `user text before\n<!-- proofline:begin -->\n${block}<!-- proofline:end -->\n${big(9000)}\n`);
  const want = Buffer.byteLength(block) + 48;
  const row = contextRows('project', P, repo).find((r) => r.name === 'agents_md');
  assert.deepEqual([row?.bytes, row?.tokens], [want, Math.ceil(want / 4)]);
  const r = cli(['project', P, 'tsv'], { PL_HOME: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split('\n').includes(`agents_md\t${want}\t${Math.ceil(want / 4)}\t${P}/AGENTS.md`));
});

test('a project without its own roles, agents, skills and hook text falls back to the checkout in PL_HOME', () => {
  const P = path.join(T, 'bare');
  mkdirSync(P, { recursive: true });
  const rows = contextRows('project', P, repo).map((r) => r.name);
  assert.ok(rows.includes('session_start') && rows.includes('entry_skill') && rows.includes('role.lead.skill') && rows.includes('role.verifier.agent'), rows.join(' '));
  assert.ok(!rows.includes('agents_md'));
  const none = contextRows('project', P, P).map((r) => r.name);
  assert.deepEqual(none, []);
});

for (const [desc, item, file] of /** @type {Array<[string, string, string]>} */ ([
  ['a big text in the AGENTS.md proofline block', 'agents_md', 'control-plane/AGENTS.md'],
  ['a big text in the CLAUDE.md proofline block', 'claude_md', 'control-plane/CLAUDE.md'],
  ['a big text in the entry skill', 'entry_skill', 'skills/proofline/SKILL.md'],
  ['a big text in an agent file', 'role.implementer.agent', 'adapters/claude/agents/proofline-implementer.md'],
  ['a big text in the first skill of a role', 'role.explorer.skill', 'skills/evidence-map/SKILL.md'],
  ['a big SessionStart text', 'session_start', 'adapters/claude/hooks/lib/session-head.txt'],
])) {
  test(`${desc}: the budget check breaks`, () => {
    const C = path.join(T, `copy-${item}`);
    copy(C);
    appendFileSync(path.join(C, file), `\n${big(5000)}\n`);
    const bad = checkOf(C);
    assert.ok(bad.some((l) => l.startsWith(`FAIL ${item}: `) && l.includes('is above its budget of')), bad.join('\n'));
    const r = cli(['repo', C, 'check', BUDGET]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(`FAIL ${item}: `));
  });
}

test('an item without a budget line fails, and a budget line for an unmeasured item fails (a budget cannot be dodged by renaming an item)', () => {
  const C = path.join(T, 'copy-new');
  copy(C);
  const budget = readFileSync(BUDGET, 'utf8');
  assert.ok(checkOf(C, budget.split('\n').filter((l) => !l.startsWith('role.qa.agent')).join('\n')).some((l) => /^FAIL role\.qa\.agent: .*no budget line/.test(l)));
  assert.deepEqual(checkOf(C, `${budget}role.ghost.agent\t100\n`), ['FAIL role.ghost.agent: budget line but the item is not measured any more']);
});

test('the hook is measured through its template file, not through its source code', () => {
  const C = path.join(T, 'copy-hook');
  copy(C);
  const src = readFileSync(path.join(repo, 'adapters/claude/hooks/events/session.mjs'), 'utf8');
  assert.ok(!src.includes('const head = `'), 'the template literal is gone from the hook');
  const hook = path.join(C, 'adapters/claude/hooks/events');
  mkdirSync(hook, { recursive: true });
  writeFileSync(path.join(hook, 'session.mjs'), `${src}\n${big(4000)}`);   // growing the hook source changes nothing
  assert.equal(contextRows('repo', C, C).find((r) => r.name === 'session_start')?.bytes, 213);
  writeFileSync(path.join(C, 'adapters/claude/hooks/lib/session-head.txt'), `${big(600)}\n`);   // one trailing newline is not counted
  assert.equal(contextRows('repo', C, C).find((r) => r.name === 'session_start')?.bytes, 600);
});

test('the report names the lead and every role; the usage errors have status 2', () => {
  const rep = reportText(contextRows('repo', repo, repo));
  assert.match(rep, /^context loaded without being asked \(estimated tokens = bytes \/ 4\):\n/);
  assert.match(rep, /\n {2}lead session \(all of the above \+ lead skill\) +\d+ bytes +~ *\d+ tokens\n/);
  assert.match(rep, /\n {2}implementer \(blocks \+ agent file \+ first skill\) +\d+ bytes +~ *\d+ tokens\n/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['repo', '/no/such/dir']).status, 2);
  assert.equal(cli(['repo', '.', 'bogus']).status, 2);
  assert.equal(cli(['repo', '.', 'check', '/no/such/budget']).status, 2);
  assert.equal(cli(['repo', '.', 'report']).stdout, rep);
});
