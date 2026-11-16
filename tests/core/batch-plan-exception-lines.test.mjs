// @ts-check
// B6 (A294 "not covered"): `batch-plan` no longer drops a malformed line of a task file's `## Test exceptions` silently. It stops, names the task id, the line number and the reason,
// shows the line escaped and cut, writes no summary and requests no approval. Invariant 3 side: an invalid line can never be listed, so it can never be approved; a batch without the
// section, and valid lines, behave as before. Real agent.sh, no waits, no clock reads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AB, appendFileSync, batchApprove, coverProject, fakes, has, mktask, path, readIf, summaryOf } from './batch-lib.mjs';
import { exceptionLineIssues, exceptionLines, parseException } from '../../control-plane/agents/scripts/core/testreview.mjs';

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const LINE = '- wait: `tests/sleepy.test.js` -- a real child process signal is awaited here, nothing fakes it';
const SECTION = (/** @type {string[]} */ ...ls) => `\n## Test exceptions\n\n${ls.join('\n')}\n`;
const bdir = (/** @type {string} */ d) => path.join(d, '.agents/local/batch');
/** A project with task LC, whose task file gets `declared` appended, and the batch-plan run on it. @param {string} declared */
function planned(declared) {
  const F = fakes();
  const dir = coverProject('', 'orchestrated no STANDARD manual');
  if (declared !== '') appendFileSync(path.join(dir, '.agents/tasks/LC.md'), declared);
  return { F, dir, run: AB(F, dir, ['batch-plan', 'all']) };
}
/** @param {ReturnType<typeof planned>} p */
function refusedWith(p, /** @type {RegExp} */ re, /** @type {string} */ what) {
  assert.notEqual(p.run.status, 0, `${what}: the plan must stop\n${p.run.text}`);
  assert.match(p.run.text, /task LC, line \d+ of its task file, ## Test exceptions/, what);
  assert.match(p.run.text, re, what);
  assert.equal(has(path.join(bdir(p.dir), 'SUMMARY.md')), false, `${what}: no summary was written`);
  assert.equal(has(path.join(bdir(p.dir), 'order.tsv')), false, `${what}: no order was written`);
  assert.equal(summaryOf(p.dir), '', what);
  assert.doesNotMatch(AB(p.F, p.dir, ['batch-next', '--tsv']).out, /^state\tapproved/m, `${what}: nothing is approved`);
}

const fill = (/** @type {number} */ n) => `- budget: "t${n}" -- the runner needs a real database here, nothing else measures it`;
/** @type {Array<[string, string, RegExp]>} */
const CASES = [
    ['grammar: no separator', SECTION('- wait: `tests/a.test.js` and then some words without any separator at all'), /line \d+ [^\n]*does not match the grammar/],
    ['grammar: unknown kind', SECTION('- sleep: `tests/a.test.js` -- a real child process signal is awaited here, nothing fakes it'), /does not match the grammar/],
    ['grammar: short reason', SECTION('- wait: `tests/a.test.js` -- too short'), /does not match the grammar/],
    ['grammar: prose line', SECTION(LINE, 'see the plan for details'), /does not match the grammar/],
    ['grammar: em dash separator (the batch reads bytes)', SECTION('- wait: `tests/a.test.js` — a real child process signal is awaited here, nothing fakes it'), /does not match the grammar/],
    ['over 1000 bytes', SECTION(`${LINE}${' x'.repeat(500)}`), /is \d+ bytes, over the 1000-byte limit/],
    ['over 50 lines', SECTION(...Array.from({ length: 51 }, (_, i) => fill(i))), /line 51 of the section, over the 50-line limit/],
    ['control character (bell)', SECTION(`${LINE}\u0007`), /invisible or control character/],
    ['control character (escape)', SECTION(`${LINE}\u001b[31m`), /invisible or control character/],
    ['control character (C1 next line)', SECTION(`${LINE}\u0085`), /invisible or control character/],
    ['carriage return inside a line', SECTION(`${LINE}\rhidden`), /invisible or control character/],
    ['duplicate', SECTION(LINE, LINE), /duplicates line \d+/],
];
// one test per group of reasons (each plan is a real agent.sh run): the grammar, the limits, the characters and the duplicate
for (const [name, from, to] of [['grammar', 0, 5], ['limits', 5, 7], ['characters and duplicate', 7, CASES.length]]) {
  test(`bl-1 (${name}): each invalid reason stops the plan with the task id, the line number of the task file and the reason; nothing is written, nothing is approved`, () => {
    for (const [what, section, re] of CASES.slice(Number(from), Number(to))) refusedWith(planned(section), re, what);
  });
}

test('bl-2: the line number is the line of the TASK FILE (blank lines and other sections counted); the first valid line is not blamed, the bad one is', () => {
  const p = planned(`\n## Test exceptions\n\n${LINE}\n\n- nonsense\n`);
  const text = readIf(path.join(p.dir, '.agents/tasks/LC.md')).split('\n');
  const want = text.findIndex((l) => l === '- nonsense') + 1;
  assert.ok(want > 5);
  refusedWith(p, new RegExp(`line ${want} of its task file`), 'bad line number');
  assert.doesNotMatch(p.run.text, new RegExp(`line ${text.indexOf(LINE) + 1} of its task file`));
});

test('bl-3: the offending text is shown escaped and cut (hostile text: escape sequences, zero-width, very long, fake rows); the raw bytes never reach the output', () => {
  const hostile = `- wait: \`tests/a.test.js\` \u001b[2J‮​ - not the separator ${'Z'.repeat(300)}`;
  const p = planned(SECTION(hostile));
  refusedWith(p, /\\u\{1b\}/, 'escape written out');
  assert.doesNotMatch(p.run.text, /[\u001b‮​]/, 'no raw control or format character in the output');
  assert.match(p.run.text, /\[cut at 80 of \d+ bytes\]/);
  assert.ok(!p.run.text.includes('Z'.repeat(81)), 'cut');
  // a fake summary row cannot be smuggled through the display: one line, escaped
  const fake = planned(SECTION(`- test exception LC ${sha(LINE)}`.slice(0, 20) + '\u000b: x'));
  refusedWith(fake, /\\u\{b\}/, 'vertical tab');
  assert.equal(fake.run.text.split('\n').filter((l) => l.startsWith('- test exception')).length, 0);
});

test('bl-4: every offending line is reported (not only the first), per task; a task that the batch leaves out does not block', () => {
  const F = fakes();
  const dir = coverProject('', 'orchestrated no STANDARD manual');
  mktask(dir, 'LD', 'STANDARD');
  appendFileSync(path.join(dir, '.agents/tasks/LC.md'), SECTION('- nope one', LINE));
  appendFileSync(path.join(dir, '.agents/tasks/LD.md'), SECTION('- nope two'));
  const r = AB(F, dir, ['batch-plan', 'all']);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /task LC, line \d+ [^\n]*nope one/);
  assert.match(r.text, /task LD, line \d+ [^\n]*nope two/);
  assert.equal(summaryOf(dir), '');
  // fixed: the batch is planned, and the valid line is listed with its hash
  const ok = planned(SECTION(LINE));
  assert.equal(ok.run.status, 0, ok.run.text);
  assert.ok(summaryOf(ok.dir).includes(`- test exception LC ${sha(LINE)}: `));
});

test('bl-5: valid lines (also non-ASCII text, a tab, format and no-break characters) and a missing or empty section behave as before', () => {
  const odd = `- budget: "slow one" -- the runner needs a real database here, nothing else measures it, şğ\t`;
  const withIt = planned(SECTION(LINE, odd));
  assert.equal(withIt.run.status, 0, withIt.run.text);
  assert.match(summaryOf(withIt.dir), /\\u\{a0\}/);
  const none = planned('');
  const empty = planned('\n## Test exceptions\n\n');
  assert.equal(none.run.status, 0); assert.equal(empty.run.status, 0, empty.run.text);
  // without a declared line there is no section and the summary is the one it always was (the nonce is the only difference)
  const norm = (/** @type {string} */ s) => s.replace(/^nonce: .*$/m, 'nonce: N');
  assert.ok(!summaryOf(none.dir).includes('Test exceptions declared'));
  assert.equal(norm(summaryOf(none.dir)), norm(summaryOf(empty.dir)));
});

test('bl-6 (Invariant 3): a malformed line cannot be smuggled into an approved batch by any route: not at the plan and not by editing the task file after the approval', () => {
  // route 1: the plan itself (bl-1). Route 2: a valid batch is planned and approved; a malformed line is then written into the task file and the batch is planned again
  const p = planned(SECTION(LINE));
  assert.equal(p.run.status, 0, p.run.text);
  batchApprove(p.dir);
  const before = summaryOf(p.dir);
  appendFileSync(path.join(p.dir, '.agents/tasks/LC.md'), '- wait: `tests/evil.test.js` and then evil words with no separator\n');
  const again = AB(p.F, p.dir, ['batch-plan', 'all']);
  assert.match(again.text, /is approved and not finished: continuing it, no new plan/, again.text);   // nothing is read again, nothing re-planned
  assert.equal(summaryOf(p.dir), before, 'the approved summary is untouched');
  assert.ok(!before.includes('evil'), 'the late line is in no listing');
  // a re-plan (--replace) reads the file and refuses it; the old approval is not consumed into a new listing
  const re = AB(p.F, p.dir, ['batch-plan', '--replace', 'all']);
  assert.notEqual(re.status, 0, re.text);
  assert.match(re.text, /task LC, line \d+ [^\n]*evil/);
  assert.equal(summaryOf(p.dir), before, 'a refused re-plan leaves the approved summary as it was');
  // the one parser: whatever the issue list calls invalid is exactly what the batch listing parser rejects or the byte rules refuse
  for (const l of ['- nonsense', LINE.replace(' -- ', ' â\u0080\u0094 ')]) {
    assert.equal(parseException(l), null);
    assert.equal(exceptionLineIssues(`## Test exceptions\n${l}\n`).length, 1);
  }
  assert.deepEqual(exceptionLineIssues(`## Test exceptions\n${LINE}\n`), []);
  assert.deepEqual(exceptionLines(`## Test exceptions\n${LINE}\n`), [LINE]);
});
