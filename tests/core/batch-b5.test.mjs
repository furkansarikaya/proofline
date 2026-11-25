// @ts-check
// Batch planning that follows what the task files say (A355, issue 338 item B5; retro items R2-4, R2-22, R3-3, R3-5): (a) `depends_on` is read in every form a task file
// writes it, (b) two tasks share a path only through the files of their `## Expected scope` list (never an extension, an address or a document of the Context),
// (c) a parked task (question, BLOCKED run) stops only what depends on it or shares its files, and `NEXT: finished` comes only when nothing runnable is left,
// (d) a re-plan carries the user's own split and scope answers to the new batch when the task and its scope list are the same, and asks again when they are not.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { scopeEntriesOverlap } from '../../control-plane/agents/scripts/core/batch.mjs';
import { depsOf, scopeBinding } from '../../control-plane/agents/scripts/core/batchplan.mjs';
import { test } from 'node:test';
import {
  AB, batchApprove, behave, bnew, binstall, drive, fakes, lines, orderIds, put, readIf, summaryOf, writeFileSync,
} from './batch-lib.mjs';

const BP = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir, /** @type {string[]} */ args) => AB(F, dir, ['batch-plan', ...args]);
const bdir = (/** @type {string} */ dir) => `${dir}/.agents/local/batch`;
const nxt = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir) => AB(F, dir, ['batch-next', '--tsv']).out.replace(/\t/g, ' ');
const sha = (/** @type {string} */ t) => createHash('sha256').update(Buffer.from(t, 'latin1')).digest('hex');

/**
 * A task file. @param {string} dir @param {string} id
 * @param {{ front?: string[], context?: string, scope?: string[], heading?: string, cls?: string, file?: string }} [o] front: the lines between the `---` of the front matter
 */
function task(dir, id, o = {}) {
  const front = o.front ?? [];
  let t = `# Task: ${id} — title of ${id}\n`;
  if (front.length > 0) t += `\n---\n${front.join('\n')}\n\n---\n`;
  t += `\n## Goal\n\nIt works.\n\n## Context\n\n${o.context ?? 'Fixture.'}\n`;
  if (o.scope !== undefined) t += `\n## ${o.heading ?? 'Expected scope'}\n\n${o.scope.map((s) => `- \`${s}\`\n`).join('')}`;
  t += `\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\n${o.cls ?? 'COMPLEX'}\n`;
  put(`${dir}/.agents/tasks/${o.file ?? id}.md`, t);
}
const planned = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir, /** @type {string[]} */ ids) => {
  binstall(dir, { remote: false });
  const r = BP(F, dir, ids);
  assert.equal(r.status, 0, r.text);
  return r;
};

test('B5 (a): depends_on is read as a list line, a block list, with a comment, quoted and by file name; the order and the summary carry it', () => {
  const F = fakes(); const dir = bnew();
  task(dir, 'T-1'); task(dir, 'T-2', { file: 'T-2-converter' });
  task(dir, 'T-3', { front: ['depends_on: [T-1, "T-2"]   # the converter first'] });
  task(dir, 'T-4', { front: ['depends_on:', '  - T-3', '  - T-2'] });
  task(dir, 'T-5', { front: ['depends_on: T-4 (renders what T-3 hands over)'] });
  task(dir, 'T-6', { front: ['depends_on: T-2-converter'] });
  planned(F, dir, ['T-6', 'T-5', 'T-4', 'T-3', 'T-2', 'T-1']);
  const dep = Object.fromEntries(lines(`${bdir(dir)}/order.tsv`).map((l) => { const f = l.split('\t'); return [f[0], f[2]]; }));
  assert.equal(dep['T-3'], 'T-1,T-2', 'inline list with quotes and a comment');
  assert.equal(dep['T-4'], 'T-3,T-2', 'block list');
  assert.equal(dep['T-5'], 'T-4', 'text in parentheses is not a dependency');
  assert.equal(dep['T-6'], 'T-2', 'a dependency named by its file name is the task ID');
  const ord = orderIds(dir).split(' ');
  for (const [a, b] of [['T-1', 'T-3'], ['T-2', 'T-3'], ['T-3', 'T-4'], ['T-4', 'T-5'], ['T-2', 'T-6']]) assert.ok(ord.indexOf(a) < ord.indexOf(b), `${a} must come before ${b}: ${ord.join(' ')}`);
  assert.match(summaryOf(dir), /\| T-4 \| title of T-4 \| COMPLEX \| T-3,T-2 \|/, 'the depends_on column of the summary is empty');
});

test('B5 (b): paths.tsv holds the code files of the Expected scope only; an extension, an address or a document of the Context shares nothing', () => {
  const F = fakes(); const dir = bnew();
  const ctx = 'Runs `.mjs` files under `/` and `/tr/`, reads `/docs/adr/0002-x.md`, `docs/design/DESIGN-marketing.md` and `scripts/lib/pin-facts.mjs` (read only).';
  task(dir, 'T-1', { context: ctx, scope: ['src/lib/a.ts', 'docs/notes.md'] });
  task(dir, 'T-2', { context: ctx, scope: ['src/pages/b.ts', 'docs/notes.md'] });
  task(dir, 'T-3', { context: ctx, scope: ['src/lib/'] });
  task(dir, 'T-4', { context: ctx });
  planned(F, dir, ['T-1', 'T-2', 'T-3', 'T-4']);
  assert.deepEqual(lines(`${bdir(dir)}/paths.tsv`), ['T-1\tsrc/lib/a.ts', 'T-2\tsrc/pages/b.ts', 'T-3\tsrc/lib/'], 'only code files of the scope lists, documents and Context tokens left out');
  batchApprove(dir);
  const t = nxt(F, dir);
  assert.match(t, /^T-2 open/m, 'T-2 shares only Context tokens and a document with T-1');
  assert.match(t, /^T-4 open/m, 'a task without a scope list shares nothing');
  assert.match(t, /^T-3 waiting shares src\/lib\/a\.ts with T-1|^T-3 waiting shares src\/lib\/ with T-1/m, 'a folder entry covers a file of an earlier task');
});

test('B5 (c): a parked task (a BLOCKED run) stops its dependants only; independent tasks run and NEXT is finished only when none is left', () => {
  const F = fakes(); const dir = bnew();
  const ctx = 'Reads `/docs/adr/0002-x.md` and `scripts/lib/pin-facts.mjs`.';
  task(dir, 'T-1', { context: ctx, scope: ['src/one.ts'] });
  task(dir, 'T-2', { context: ctx, scope: ['src/two.ts'] });
  task(dir, 'T-3', { context: ctx, scope: ['src/three.ts'], front: ['depends_on: T-1'] });
  planned(F, dir, ['T-1', 'T-2', 'T-3']); batchApprove(dir);
  behave(F, 'T-1', 'blocked');
  drive(F, dir);
  assert.equal(F.calls(), 'run T-1 run T-2 deliver T-2', 'the independent task ran past the park and the dependant did not start');
  const t = nxt(F, dir);
  for (const w of ['T-1 parked BLOCKED', 'T-2 merged', 'T-3 skipped depends on T-1 (parked)']) assert.ok(t.split('\n').some((l) => l.startsWith(w)), `no '${w}' in ${t}`);
  assert.ok(t.startsWith('state finished-parked'), t);
  assert.match(AB(F, dir, ['batch-next']).out, /^NEXT: finished/m);
});

// ---- (d) -------------------------------------------------------------------------------------------------------------------------------------

const wide = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `src/m${i + 1}.js`);
/** The user's captured message (as the prompt hook leaves it), newer than the summary. @param {string} dir @param {string} name @param {string} text */
function userSays(dir, name, text) {
  const at = Math.floor(statSync(`${bdir(dir)}/SUMMARY.md`).mtimeMs / 1000) + 10;
  put(`${dir}/.agents/local/prompts/history/${at}-${name}.txt`, text);
  return `${at}-${name}.txt`;
}

/** W-1 (wide, with a scope list) and W-2 planned; the user answered Q1 "do not split" in a captured message. @param {string} [reply] */
function answered(reply = 'Q1: do not split\n') {
  const F = fakes(); const dir = bnew();
  task(dir, 'W-1', { scope: wide(18), context: 'First text.' });
  task(dir, 'W-2', { scope: ['src/p.js'] });
  planned(F, dir, ['W-1', 'W-2']);
  assert.match(summaryOf(dir), /\[W-1, split\]/);
  batchApprove(dir);
  const msg = userSays(dir, 'aaaa0001', reply);
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  return { F, dir, msg, oldId: sha(summaryOf(dir)).slice(0, 12) };
}
const carriedRow = (/** @type {string} */ dir) => lines(`${bdir(dir)}/answers.tsv`).map((l) => l.split('\t')).find((f) => f[1] === 'W-1' && f[3] === 'split');

test('B5 (d): a re-plan carries the user\'s split answer when the task file and its scope list are the same, with its origin', () => {
  const { F, dir, msg, oldId } = answered();
  // another task is edited and planned again: a new plan hash, a new batch id
  task(dir, 'W-2', { scope: ['src/p.js', 'src/q.js'], context: 'Second text.' });
  const r = BP(F, dir, ['--replace', 'W-1', 'W-2']);
  assert.equal(r.status, 0, r.text);
  const newSum = summaryOf(dir);
  assert.notEqual(sha(newSum).slice(0, 12), oldId, 'the plan did not change');
  const row = carriedRow(dir);
  assert.ok(row, 'the answer was not carried to the new batch');
  assert.notEqual(row[0], oldId, 'the carried row is bound to the new batch id');
  assert.equal(row[4], 'b'); assert.equal(row[6], msg, 'the carried answer keeps the user\'s original message');
  assert.equal(row[7], `carried:${oldId}`); assert.equal(row[8], 'answered_by=user');
  assert.match(AB(F, dir, ['batch-answers', 'W-1']).out, /Q1 W-1 split: option b/);
  assert.match(newSum, new RegExp(`\\[W-1, split\\][^\\n]*\\n(?:    [^\\n]*\\n)*    answered by you earlier \\(option b, carried from batch ${oldId}`), 'the summary does not say the answer was carried');
  assert.match(readIf(`${bdir(dir)}/history/${oldId}/scopes.tsv`), /^W-1\t/m, 'the scope bindings of the old batch are archived');
});

/** One project that is planned again and again: W-1 (wide, with a scope list) and W-2; `say` records the user's answer to Q1 on the batch in force, `replan` plans anew. */
function session() {
  const F = fakes(); const dir = bnew();
  task(dir, 'W-1', { scope: wide(18), context: 'First text.' });
  task(dir, 'W-2', { scope: ['src/p.js'] });
  planned(F, dir, ['W-1', 'W-2']);
  let n = 0;
  return {
    F, dir,
    say: (/** @type {string} */ reply = 'Q1: do not split\n') => { const msg = userSays(dir, `m${++n}`, reply); assert.equal(AB(F, dir, ['batch-answer']).status, 0); return msg; },
    replan: () => { const r = BP(F, dir, ['--replace', 'W-1', 'W-2']); assert.equal(r.status, 0, r.text); },
    asksAgain: () => assert.ok(!carriedRow(dir) && /\[W-1, split\]/.test(summaryOf(dir)) && !summaryOf(dir).includes('answered by you earlier')),
  };
}

test('B5 (d): the answer is not carried when the scope list changes or when the task body grows although the scope list stays; a status line or report block does not matter', () => {
  const s = session(); s.say();
  task(s.dir, 'W-1', { scope: [...wide(18), 'src/new.js'], context: 'First text.' });
  s.replan(); s.asksAgain(); s.say();
  // the Goal, Acceptance criteria, Risks or Context grow while the list stays
  task(s.dir, 'W-1', { scope: [...wide(18), 'src/new.js'], context: 'First text. It now also rewrites the whole renderer and adds a second converter.' });
  s.replan(); s.asksAgain(); s.say();
  // a report block that is never closed, or closed with another id, is part of the task: appended criteria change the task
  const f = `${s.dir}/.agents/tasks/W-1.md`;
  const base = readIf(f);
  writeFileSync(f, `${base}<!-- COMPLETION-REPORT:BEGIN:W-1 -->\n- AC-9: it also does more\n`);
  s.replan(); s.asksAgain(); s.say();
  writeFileSync(f, `${base}<!-- COMPLETION-REPORT:BEGIN:W-1 -->\n- AC-9: it also does more\n<!-- COMPLETION-REPORT:END:W-2 -->\n`);
  s.replan(); s.asksAgain(); s.say();
  writeFileSync(f, base);
  s.replan(); s.asksAgain(); s.say();
  // a Status line and a closed completion report block are not part of the task: the answer is carried
  writeFileSync(f, base.replace('— title of W-1\n', '— title of W-1\n**Status:** in progress\n') + '<!-- COMPLETION-REPORT:BEGIN:W-1 -->\nreport\n<!-- COMPLETION-REPORT:END:W-1 -->\n');
  s.replan();
  assert.ok(carriedRow(s.dir), 'a status line or a closed report block stopped the carry');
});

test('B5 (d): the original message is read again at carry time: it must still answer THAT question, and not be older than the summary that asked', () => {
  const s = session();
  // the recorded message file now says something that answers no question
  let msg = s.say();
  writeFileSync(`${s.dir}/.agents/local/prompts/history/${msg}`, 'thanks, looks fine\n');
  s.replan(); s.asksAgain();
  // the message now gives another option to the question
  msg = s.say();
  writeFileSync(`${s.dir}/.agents/local/prompts/history/${msg}`, 'Q1 a\n');
  s.replan(); s.asksAgain();
  // a row that names a message older than the summary
  msg = s.say();
  put(`${s.dir}/.agents/local/prompts/history/5-old00001.txt`, 'Q1: do not split\n');
  const f = `${bdir(s.dir)}/answers.tsv`;
  writeFileSync(f, readIf(f).replace(msg, '5-old00001.txt'));
  s.replan(); s.asksAgain();
});

test('B5 (1, 2): the binding leaves out the first Status line and a report block with its matching END only; the scope list is still required', () => {
  const t = (/** @type {string} */ extra, /** @type {string} */ status = '') => `# Task: W-1 — x\n${status}\n## Goal\n\nIt works.\n\n## Expected scope\n\n- \`src/a.ts\`\n\n## Acceptance criteria\n\n- AC-1: it works\n${extra}`;
  const base = scopeBinding(t(''));
  assert.match(base, /^[0-9a-f]{64}\t[0-9a-f]{64}$/);
  assert.equal(scopeBinding(t('', '**Status:** done\n')), base, 'the header Status line');
  assert.equal(scopeBinding(t('<!-- COMPLETION-REPORT:BEGIN:W-1 -->\nr\n<!-- COMPLETION-REPORT:END:W-1 -->\n')), base, 'a closed report block');
  assert.notEqual(scopeBinding(t('<!-- COMPLETION-REPORT:BEGIN:W-1 -->\n- AC-2: new\n')), base, 'an unterminated block');
  assert.notEqual(scopeBinding(t('<!-- COMPLETION-REPORT:BEGIN:W-1 -->\n- AC-2: new\n<!-- COMPLETION-REPORT:END:W-2 -->\n')), base, 'a mismatched END id');
  assert.notEqual(scopeBinding(t('<!-- COMPLETION-REPORT:END:W-1 -->\n<!-- COMPLETION-REPORT:BEGIN:W-1 -->\n- AC-2: new\n')), base, 'an END before the BEGIN');
  assert.notEqual(scopeBinding(t('**Status:** the second one counts\n', '**Status:** done\n')), scopeBinding(t('', '**Status:** done\n')), 'only the first Status line is left out');
  assert.equal(scopeBinding('# Task: W-1 — x\n\n## Goal\n\nIt works.\n'), '', 'no scope list, no binding');
});

test('B5 (3): scope entries overlap when a glob and another entry may name one file: the literal directory before the first wildcard decides', () => {
  const yes = [['src/**/*.ts', 'src/lib'], ['src/a*', '*.ts'], ['src/*/x.ts', 'src/lib/*.ts'], ['src/lib/', 'src/lib/a.ts'], ['src/a.ts', 'src/a.ts'], ['src/**', 'src/deep/er/f.go'], ['src/lib/a.js', 'src/lib/*.ts'], ['src/{a,b}/*.ts', 'src/a/x.ts'], ['Src/a.ts', 'src/a.ts'], ['SRC/**/*.TS', 'src/lib/a.ts']];
  const no = [['src/a.ts', 'src/b.ts'], ['docs/**/*.md', 'src/lib'], ['src/*.ts', 'test/*.ts'], ['src/lib/', 'src/libx/a.ts'], ['src/{a,b}/*.ts', 'test/a.ts']];
  for (const [a, b] of yes) { assert.equal(scopeEntriesOverlap(a, b), true, `${a} and ${b} may name one file`); assert.equal(scopeEntriesOverlap(b, a), true, `${b} and ${a}`); }
  for (const [a, b] of no) { assert.equal(scopeEntriesOverlap(a, b), false, `${a} and ${b} cannot name one file`); assert.equal(scopeEntriesOverlap(b, a), false, `${b} and ${a}`); }
  const F = fakes(); const dir = bnew();
  task(dir, 'G-1', { scope: ['src/**/*.ts'] }); task(dir, 'G-2', { scope: ['src/lib/'] }); task(dir, 'G-3', { scope: ['docs/**/*.md', 'ops/run.sh'] });
  planned(F, dir, ['G-1', 'G-2', 'G-3']); batchApprove(dir);
  const t = nxt(F, dir);
  assert.match(t, /^G-2 waiting shares src\/\*\*\/\*\.ts with G-1/m); assert.match(t, /^G-3 open/m);
});

test('B5 (4, 5): a flow list continued on the next line is read to its ], an open one ends at the next key, a whole-value parenthesis is a list, ids named A and N are kept, none and n/a mean none', () => {
  const deps = (/** @type {string[]} */ ...front) => depsOf(`# Task: X — x\n\n---\n${front.join('\n')}\n\n---\n\n## Goal\n\nx\n`);
  assert.equal(deps('depends_on: [T-1,', '  T-2]'), 'T-1,T-2');
  assert.equal(deps('depends_on: [T-1,', ' T-2', 'priority: high'), 'T-1,T-2', 'an open list ends at the next key');
  assert.equal(deps('depends_on: [T-1,', ' T-2'), 'T-1,T-2', 'an open list ends at the closing ---');
  assert.equal(deps('depends_on: [T-1,', 'priority: high', 'owner: T-9'), 'T-1', 'what follows the next key is not a dependency');
  assert.equal(deps('depends_on: (T-1)'), 'T-1');
  assert.equal(deps('depends_on: [A, N]'), 'A,N');
  assert.equal(deps('depends_on: none'), ''); assert.equal(deps('depends_on: n/a'), ''); assert.equal(deps('depends_on: null'), ''); assert.equal(deps('depends_on: [ ]'), '');
  assert.equal(deps('depends_on: T-1 (the converter), N # why', 'priority: high'), 'T-1,N');
  assert.equal(deps('depends_on:', '  - T-1', '  - T-2', 'priority: high'), 'T-1,T-2');
});

test('B5 (d): nothing is carried without the user\'s recorded message, for another task, for another kind or when the task has no scope list', () => {
  const F = fakes(); const dir = bnew();
  task(dir, 'W-1', { scope: wide(18) });
  task(dir, 'W-2', { context: `Names ${wide(18).map((p) => `\`${p}\``).join(' ')}.` });
  task(dir, 'W-3', { scope: wide(18) });
  planned(F, dir, ['W-1', 'W-2', 'W-3']); batchApprove(dir);
  assert.match(summaryOf(dir), /\[W-2, split\]/);
  userSays(dir, 'bbbb0001', 'Q1 b\nQ2 b\nQ3 b\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  assert.equal(lines(`${bdir(dir)}/answers.tsv`).length, 3);
  // a forged row whose message is not in the recorded history of the user's prompts is dropped at carry time
  const f = `${bdir(dir)}/answers.tsv`;
  const rows = lines(f).map((l) => l.split('\t'));
  rows[0][6] = '1-forged.txt';
  writeFileSync(f, `${rows.map((x) => x.join('\t')).join('\n')}\n`);
  assert.equal(BP(F, dir, ['--replace', 'W-1', 'W-2', 'W-3']).status, 0);
  const kept = lines(f).map((l) => l.split('\t'));
  assert.ok(kept.some((x) => x[1] === 'W-3' && x[7]?.startsWith('carried:')), 'the control: an answer with its recorded message and an unchanged scope list is carried');
  assert.ok(!kept.some((x) => x[1] === 'W-1'), 'an answer whose message is not the user\'s recorded one was carried');
  assert.ok(!kept.some((x) => x[1] === 'W-2'), 'an answer of a task without a scope list was carried');
});
