// @ts-check
// Stage 4, package 4C: `publish-completion-report` and `verify-completion-report` as absolute Node tests (A214). They cover the behaviour of the shell
// scenarios in lifecycle-test.sh (task_contract_*, requested response, root cause), gates-test.sh (A130 finding ids, A143 numbers and the Facts block,
// A202 summary block, A203 Execution table) and risk-test.sh (UNSUPPORTED section), which keep running against the Node commands as black boxes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, project, read, refused, verbs } from './legacy-lib.mjs';

const RECIPE = 'scaffold standalone yes; to_code_done standalone; A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null';
const REPORT = '.agents/runs/LC/COMPLETION_REPORT.md';
const TASK = 'tasks/in-progress/LC.md';

/** A CODE_DONE run with its knowledge step recorded and the fixture's valid report written. @param {string} [extra] */
function ready(extra = '') {
  const d = project(RECIPE);
  accepted(verbs(d, `write_report ${extra}`), 'write_report');
  return d;
}
/** Replace the report by a transformation of its text. @param {string} d @param {(t: string) => string} f */
function edit(d, f) { writeFileSync(`${d}/${REPORT}`, f(readFileSync(`${d}/${REPORT}`, 'utf8'))); }
const publish = (/** @type {string} */ d, /** @type {string[]} */ more = [], o = {}) => A(d, ['publish-completion-report', 'LC', 'markdown', ...more], o);
const state = (/** @type {string} */ d, /** @type {string} */ k) => new RegExp(`^completion_report:\\n(?:  .*\\n)*?  ${k}: "?([^"\\n]*)"?$`, 'm').exec(read(d, '.agents/runs/LC/RUN.yaml'))?.[1] ?? '';

test('publish: a valid report is published (receipt, three RUN.yaml values, ledger row), the Facts block is appended once and replaced on a second publish', () => {
  const d = ready();
  const r = accepted(publish(d), 'publish');
  assert.match(r.out, /^completion report published: LC via markdown -> tasks\/in-progress\/LC\.md#[0-9a-f]{64}$/m);
  assert.equal(state(d, 'published'), 'true');
  assert.equal(state(d, 'adapter'), 'markdown');
  assert.match(state(d, 'receipt'), /^tasks\/in-progress\/LC\.md#[0-9a-f]{64}$/);
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /event=publish-completion-report role=lead from=CODE_DONE to=CODE_DONE .* detail=markdown tasks\/in-progress\/LC\.md#[0-9a-f]{64}\n/);
  const text = read(d, REPORT);
  assert.equal(text.split('<!-- proofline:facts:begin -->').length, 2, 'one Facts block');
  assert.match(text, /\n<!-- proofline:facts:begin -->\n## Facts\n\nGenerated from the run records by `agent\.sh report-facts LC`/);
  assert.match(text, /- Class: COMPLEX\n- Required gates: \d+\n/);
  assert.ok(text.endsWith('<!-- proofline:facts:end -->\n'));
  accepted(publish(d), 'a second publish');
  assert.equal(read(d, REPORT).split('<!-- proofline:facts:begin -->').length, 2, 'the Facts block is replaced, not repeated');
  const v = accepted(A(d, ['verify-completion-report', 'LC']), 'verify');
  assert.equal(v.out, 'completion report publication verified: LC\n');
  accepted(A(d, ['handoff', 'LC', 'DONE']), 'handoff DONE verifies the publication in process');
});

test('publish: only the lead, only CODE_DONE; a missing, short or section-less report is refused before anything is written', () => {
  const d = ready();
  refused(publish(d, [], { role: 'reviewer' }), 'a non-lead', 'command denied for reviewer');
  const bare = project(RECIPE);
  refused(publish(bare), 'no report', 'completion report missing:');
  writeFileSync(`${bare}/${REPORT}`, '# Completion Report: LC\n\nshort\n');
  refused(publish(bare), 'a short report', 'completion report is too short to be meaningful');
  for (const h of ['Implementation Summary', 'Verification', 'Assumptions', 'Known Limitations / Follow-up', 'Review Result', 'QA Result', 'TDD Evidence']) {
    const x = ready();
    edit(x, (t) => t.replace(`## ${h}`, '## Renamed'));
    refused(publish(x), `a report without ${h}`, `completion report missing required section: ## ${h}`);
    assert.equal(state(x, 'published'), 'false');
  }
  const early = project('scaffold standalone yes');
  refused(publish(early), 'a run that is not CODE_DONE', 'completion report may only be published after CODE_DONE');
  refused(A(d, ['publish-completion-report', 'NOPE']), 'an unknown run', 'NOPE');
  assert.equal(A(d, ['publish-completion-report']).status, 1, 'a missing id');
});

test('publish: the Assumptions section may not be empty, a Requested Response is needed when the task asks for one', () => {
  const d = ready();
  edit(d, (t) => t.replace('## Assumptions\nnone\n', '## Assumptions\n\n'));
  refused(publish(d), 'an empty Assumptions section', "the '## Assumptions' section is empty");
  const r = project(`SC_TASK_EXTRA='## Completion response

End with one sentence.'; ${RECIPE}`);
  accepted(verbs(r, 'write_report'), 'write_report');
  refused(publish(r), 'no Requested Response section', 'missing required section: ## Requested Response');
  writeFileSync(`${r}/${REPORT}`, `${readFileSync(`${r}/${REPORT}`, 'utf8')}\n## Requested Response\n\n\n`);
  refused(publish(r), 'an empty Requested Response', "the '## Requested Response' section is empty");
  writeFileSync(`${r}/${REPORT}`, `${readFileSync(`${r}/${REPORT}`, 'utf8')}Done in one sentence.\n`);
  accepted(publish(r), 'a report with the requested response');
});

test('claims: a number beside tests, gates, fix rounds or refreezes must be the recorded one (digits and number words), code fences and nouns are not counts', () => {
  const cases = [
    ['9 tests passed', '"9 tests" (recorded: worker-evidence run records: total 2, ended pass 1, ended fail 1; no record counts individual tests)'],
    ['tests: 40', '"40 tests"'],
    ['5 gates ran', '"5 gates" (recorded: required gates '],
    ['1 fix rounds', '"1 fix rounds" (recorded: used 0, maximum 2)'],
    ['fix rounds: 3', '"3 fix rounds"'],
    ['1 refreezes', '"1 refreezes" (recorded: refreezes 0)'],
    ['Five tests were added', '"5 tests"'],
    ['twelve gates', '"12 gates"'],
    ['1,000 tests', '"1000 tests"'],
  ];
  const d = ready();
  const base = readFileSync(`${d}/${REPORT}`, 'utf8');
  for (const [claim, want] of cases) {
    writeFileSync(`${d}/${REPORT}`, `${base}\n${claim}\n`);
    const r = publish(d);
    refused(r, claim, want);
    assert.match(r.err, /^line \d+: "/m);
    assert.match(r.err, /see 'agent\.sh report-facts LC'/);
  }
  writeFileSync(`${d}/${REPORT}`, `${base}\n\`\`\`\n9 tests\n77 gates\n\`\`\`\n2 tests\n0 tests failed\n2 test files\n3 tests the lookup\n`);
  accepted(publish(d), 'recorded numbers, fences, nouns and verbs');
});

test('summary block: it must open at the top, close, carry exactly one Verify line in backticks and stay within five lines', () => {
  const block = (/** @type {string[]} */ ...rows) => ['<!-- proofline:summary:begin -->', ...rows, '<!-- proofline:summary:end -->'].join('\n');
  const withBlock = (/** @type {string} */ d, /** @type {string} */ b, /** @type {number} */ at = 1) => edit(d, (t) => { const l = t.split('\n'); l.splice(at, 0, b); return l.join('\n'); });
  let d = ready();
  const noBlock = accepted(publish(d), 'no block is only a note');
  assert.match(noBlock.err, /note: COMPLETION_REPORT\.md has no summary block at the top/);
  d = ready(); withBlock(d, block('Changed the lookup.', 'Verify: `go test ./...`'), 12);
  refused(publish(d), 'a block far down', 'the summary block must open within the first lines of the report');
  d = ready(); withBlock(d, ['<!-- proofline:summary:begin -->', 'Changed the lookup.', 'Verify: `go test ./...`'].join('\n'));
  refused(publish(d), 'a block without its end', 'the summary block has no closing marker <!-- proofline:summary:end -->');
  d = ready(); withBlock(d, block('Changed the lookup.'));
  refused(publish(d), 'no Verify line', "the summary block needs exactly one line 'Verify:");
  d = ready(); withBlock(d, block('Changed the lookup.', 'Verify: nothing in backticks'));
  refused(publish(d), 'a Verify line without a command', "the summary block needs exactly one line 'Verify:");
  d = ready(); withBlock(d, block('Verify: `a`', 'Verify: `b`'));
  refused(publish(d), 'two Verify lines', "the summary block needs exactly one line 'Verify:");
  d = ready(); withBlock(d, block('one', 'two', 'three', 'four', 'five', 'Verify: `go test ./...`'));
  refused(publish(d), 'six lines', 'the summary block is 6 lines with the \'Look at:\' lines the script adds; at most five');
  d = ready(); withBlock(d, block('Changed the lookup.', 'Look at: a line the model typed', 'Verify: `go test ./...`'));
  accepted(publish(d), 'a valid block');
  const t = read(d, REPORT);
  assert.ok(t.includes('<!-- proofline:summary:begin -->\nChanged the lookup.\nVerify: `go test ./...`\n<!-- proofline:summary:end -->'), 'a typed Look at line is dropped');
  // the numbers inside the summary are claims too, but the evidence checks read the report without the block
  d = ready(); withBlock(d, block('Changed the lookup.', 'Verify: `go test ./...`'));
  accepted(publish(d), 'a block'); accepted(publish(d), 'republished');
  assert.equal(read(d, REPORT).split('<!-- proofline:summary:begin -->').length, 2);
  // the human checks of QA_REPORT.md are copied as Look at lines, once; retyping one is refused
  d = ready(); writeFileSync(`${d}/.agents/runs/LC/QA_REPORT.md`, '# QA\n\n## Human checks\n\n- Read the error text aloud\n- Check the footer link\n');
  withBlock(d, block('Please read the error text aloud.', 'Verify: `go test ./...`'));
  refused(publish(d), 'a retyped item', "repeats a QA_REPORT.md 'Human checks' item ('Read the error text aloud')");
  withBlock(d, block('Changed the lookup.', 'Verify: `go test ./...`'));
  edit(d, (x) => x.replace(/<!-- proofline:summary:begin -->\nPlease[^]*?<!-- proofline:summary:end -->\n/, ''));
  accepted(publish(d), 'the copied list');
  assert.ok(read(d, REPORT).includes('Changed the lookup.\nLook at: Read the error text aloud\nLook at: Check the footer link\nVerify: `go test ./...`\n<!-- proofline:summary:end -->'));
});

test('Execution: the table is generated from the decision records and replaces whatever the lead wrote, in place', () => {
  const d = ready();
  mkdirSync(`${d}/.agents/runs/LC/decisions`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/decisions/001-reviewer.decision`, 'role=reviewer\nfocus=rules\nruntime=codex\nmodel=m1\neffort=low\nsignals=\nruntime_reason=AUTOMATIC_FAILOVER\nescalated=yes\nescalation_reason=weak|model\nvia=agent-path\n');
  accepted(verbs(d, 'true'), 'fixture');
  edit(d, (t) => t.replace('Not applicable in fixtures.', 'a hand-written table'));
  accepted(publish(d), 'publish');
  const t = read(d, REPORT);
  assert.ok(!t.includes('a hand-written table'));
  assert.match(t, /## Execution\n\nGenerated from the decision records by `agent\.sh report-execution LC` when the report is published; never edited by hand\.\n\n\| role \| focus \| runtime \| model \| effort \| signals \| note \|\n\|---\|---\|---\|---\|---\|---\|---\|\n\| reviewer \| rules \| codex \| m1 \| low \| none \| failover \(automatic\) to codex; escalated \(weak\/model\); agent path \|\n\n## Known Limitations/);
  assert.equal(t.split('## Execution').length, 2);
});

test('adapter: a failed publish, an empty receipt, a receipt with a quote, a changed contract and an unknown adapter restore the task source and record nothing', () => {
  const d = ready();
  const before = readFileSync(`${d}/${TASK}`);
  const adapter = (/** @type {string} */ name, /** @type {string} */ body) => { writeFileSync(`${d}/.agents/task-integrations/${name}.sh`, `#!/bin/sh\n${body}\n`); };
  adapter('fails', 'case "$1" in publish) echo "- touched" >> "$(dirname "$0")/../../$(sed -n \'s/^  path: //p\' "$(dirname "$0")/../runs/$2/RUN.yaml" | head -1)"; echo boom >&2; exit 3 ;; esac');
  const r1 = A(d, ['publish-completion-report', 'LC', 'fails']);
  refused(r1, 'a failing adapter', 'completion report publish failed via adapter: fails');
  assert.ok(r1.err.includes('boom'), 'the adapter stderr is shown');
  assert.deepEqual(readFileSync(`${d}/${TASK}`), before, 'the task source is restored byte for byte');
  adapter('empty', 'case "$1" in publish) exit 0 ;; esac');
  refused(A(d, ['publish-completion-report', 'LC', 'empty']), 'an empty receipt', 'adapter empty returned an empty receipt');
  adapter('quote', 'case "$1" in publish) printf \'a"b#c\\n\' ;; esac');
  refused(A(d, ['publish-completion-report', 'LC', 'quote']), 'a receipt with a quote', 'returned a receipt with a control character, a quote or a backslash');
  adapter('multi', 'case "$1" in publish) printf \'x\\nexecution:\\n  state: DONE\\n\' ;; esac');
  refused(A(d, ['publish-completion-report', 'LC', 'multi']), 'a multi-line receipt', 'returned a receipt with a control character');
  adapter('evil', 'root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd); path=$(sed -n "s/^  path: //p" "$root/.agents/runs/$2/RUN.yaml" | head -1); case "$1" in publish) printf "%s\\n" "- a requirement the adapter added" >> "$root/$path"; printf "%s#feedface\\n" "$path" ;; esac');
  refused(A(d, ['publish-completion-report', 'LC', 'evil']), 'an adapter that changed the contract', 'outside the completion-report block');
  assert.deepEqual(readFileSync(`${d}/${TASK}`), before, 'the task source is restored byte for byte');
  for (const bad of ['nope', '../x', 'a/b', '.hidden']) refused(A(d, ['publish-completion-report', 'LC', bad]), `adapter ${bad}`, `unknown task-integration adapter: ${bad}`);
  assert.equal(state(d, 'published'), 'false');
  assert.equal(state(d, 'receipt'), 'PENDING');
  assert.ok(!/event=publish-completion-report/.test(read(d, '.agents/runs/LC/LEDGER.log')), 'nothing was recorded');
  accepted(publish(d), 'the markdown adapter still publishes');
});

test('verify-completion-report: needs a publication, the adapter and the receipt; a tampered block or a failing adapter is refused', () => {
  const d = ready();
  refused(A(d, ['verify-completion-report', 'LC']), 'not published', 'completion report not published: LC');
  accepted(publish(d), 'publish');
  accepted(A(d, ['verify-completion-report', 'LC']), 'verify');
  const src = readFileSync(`${d}/${TASK}`, 'utf8');
  writeFileSync(`${d}/${TASK}`, src.replace('Not applicable', 'Tampered'));
  const t = A(d, ['verify-completion-report', 'LC']);
  refused(t, 'a tampered block', 'completion report publication could not be verified: LC');
  writeFileSync(`${d}/${TASK}`, src);
  const ry = `${d}/.agents/runs/LC/RUN.yaml`;
  writeFileSync(ry, readFileSync(ry, 'utf8').replace(/  receipt: ".*"/, '  receipt: ""'));
  refused(A(d, ['verify-completion-report', 'LC']), 'an empty receipt', 'completion report adapter/receipt missing: LC');
  refused(A(d, ['verify-completion-report', 'NOPE']), 'an unknown run', 'NOPE');
});
