// @ts-check
// A341: the Verification claims block of a completion report is made from the gate records, and the report text outside the generated parts may hold no word
// of a visual or browser check unless the ledger holds that check for the final tree. Pure functions first, then the real publish step on a UI run and on a
// run without the visual gate.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { A, accepted, expectMsg, writeReport } from '../lib/harness.mjs';
import { sha256 } from '../../control-plane/agents/scripts/core/hash.mjs';
import { CLAIM_VOCABULARY } from '../../control-plane/agents/scripts/core/claimwords.mjs';
import { auditClaims, checkClaimsBlock, CLAIMS_BEGIN, CLAIMS_END, duplicateBlocks } from '../../control-plane/agents/scripts/core/verifyclaims.mjs';
import { apparatus } from './verifyclaims-lib.mjs';

const REPORT = '.agents/runs/LC/COMPLETION_REPORT.md';
const rd = (/** @type {string} */ d) => readFileSync(path.join(d, REPORT), 'utf8');
const NO = { visualOk: false, visual: 'not run (gate QA:visual)' };
const YES = { visualOk: true, visual: 'ran on the final tree: pass' };
const none = { lookAt: /** @type {string[]} */ ([]), execution: /** @type {string[] | null} */ (null), generatedLines: /** @type {string[]} */ ([]), claims: /** @type {string[] | null} */ (null), factsHash: /** @type {string | null} */ (null) };
/** The words found in one or more lines. @param {...string} l */
const found = (...l) => [...auditClaims(l, NO).matchAll(/^line \d+: "(.*)"$/gm)].map((m) => m[1]);

describe('the vocabulary audit as pure functions', () => {
  test('every review sentence is refused, whatever its negations, code spans or fences; plain talk passes', () => {
    for (const s of ['The page was checked in a real browser.', 'Checked in Chrome, no test failed.', 'No doubt checked in a real browser.', 'Opened the page in Chromium and it never looked better.',
      'Not only do the unit tests pass, but I also checked it in a real browser.', 'Verified in a real browser without errors.', 'The page was checked in a real browser and never broke.',
      'The visual check did not run on the final tree.', 'No browser check was possible: the project has no UI.', 'Added a `browser` option to the parser.', 'Added a Playwright test for the form.',
      'Screenshots confirm the layout.', 'Ran the e2e suite and the end-to-end flow on a real device and the dev server.', 'I eyeballed it and looked at the page twice.', 'The template rendered fine.']) {
      assert.ok(found(s).length >= 1, s);
    }
    for (const s of ['The lookup returns the default for an empty key.', 'All gates passed.', 'The project test command passed.', 'The parser prints nothing for an empty key.']) {
      assert.deepEqual(found(s), [], s);
    }
  });

  test('a code span, a fenced block (backtick or tilde), a line wrap and a hyphen do not hide a word; the line number is the line of the word', () => {
    assert.deepEqual(found('ok', '`browser`'), ['browser']);
    assert.deepEqual(found('~~~', 'checked in a browser', '~~~'), ['browser']);
    assert.deepEqual(found('```', 'a Screenshot', '```'), ['screenshot']);
    assert.deepEqual(found('we looked at', 'the page'), ['looked at the page']);
    assert.deepEqual(found('the end-to', 'end test'), ['end-to end']);
    assert.match(auditClaims(['a', 'b', 'Chrome'], NO), /line 3: "chrome"/);
    assert.match(auditClaims(['Chrome'], NO), /Remove or rephrase the sentence without these words/);
  });

  test('exempt: the claims block equal to the generated one, the Facts block with the ledger hash, the exact Look at lines, the generated Execution section and the exact generated lines; nothing else', () => {
    const gen = ['## Execution', '', '| role | focus |', '|---|---|', '| qa | visual |'];
    const claimsBlock = [CLAIMS_BEGIN, 'a Chrome run', CLAIMS_END];
    const facts = ['<!-- proofline:facts:begin -->', 'screenshot', '<!-- proofline:facts:end -->'];
    const lines = ['# R', ...claimsBlock, ...facts, 'Look at: Open it in a browser', ...gen, '', '## Unsupported Checks', '- QA:visual: no tool here; not proven: the layout'];
    const g = { lookAt: ['Open it in a browser'], execution: gen, generatedLines: ['- QA:visual: no tool here; not proven: the layout'], claims: claimsBlock, factsHash: sha256(`${facts.join('\n')}\n`) };
    assert.equal(auditClaims(lines, NO, g), '');
    assert.match(auditClaims(lines, NO, { ...g, lookAt: ['Open it'] }), /line 8: "browser"/);
    assert.match(auditClaims(lines, NO, { ...g, execution: null }), /line 13: "visual"/);
    assert.match(auditClaims(lines, NO, { ...g, generatedLines: [] }), /line 16: "visual"/);
    assert.match(auditClaims(lines, NO, { ...g, claims: null }), /line 3: "chrome"/);
    assert.match(auditClaims(lines, NO, { ...g, factsHash: null }), /line 6: "screenshot"/);
    assert.match(auditClaims(lines, NO, { ...g, factsHash: sha256('other\n') }), /line 6: "screenshot"/);
    assert.equal(auditClaims(['Chrome'], YES, none), '');
  });

  test('a fake or edited marker block, a block with extra lines and a second copy are read like normal text', () => {
    const claimsBlock = [CLAIMS_BEGIN, 'a run', CLAIMS_END];
    const facts = ['<!-- proofline:facts:begin -->', 'x', '<!-- proofline:facts:end -->'];
    const g = { ...none, claims: claimsBlock, factsHash: sha256(`${facts.join('\n')}\n`) };
    assert.equal(auditClaims([...claimsBlock, ...facts], NO, g), '');
    assert.match(auditClaims([...claimsBlock, '<!-- proofline:facts:begin -->', 'checked in a real browser', '<!-- proofline:facts:end -->'], NO, g), /line 5: "browser"/);
    assert.match(auditClaims([CLAIMS_BEGIN, 'a run', 'checked in Chrome', CLAIMS_END], NO, g), /line 3: "chrome"/);
    assert.match(auditClaims([...claimsBlock, 'x', CLAIMS_BEGIN, 'Chrome ran it', CLAIMS_END], NO, g), /line 6: "chrome"/);
    assert.match(auditClaims([CLAIMS_BEGIN, 'Chrome ran it'], NO, g), /line 2: "chrome"/);
  });

  test('a second Execution section is read; so is a changed copy of the generated one; the gate token is no exemption on any line', () => {
    const gen = ['## Execution', '', '| qa | visual |'];
    const g = { ...none, execution: gen };
    assert.equal(auditClaims([...gen, '', '## Other', 'x'], NO, g), '');
    assert.match(auditClaims([...gen, '', '## Execution', '', 'the page was shown in Chrome'], NO, g), /line 7: "chrome"/);
    assert.match(auditClaims(['## Execution', '', '| qa | visual |', 'extra row'], NO, g), /line 3: "visual"/);
    assert.match(auditClaims(['QA:visual passed on the final tree after the fix round.'], NO), /"visual"/);
    assert.match(auditClaims(['- QA:visual: passed; not proven: nothing'], NO), /"visual"/);
  });

  test('encoded, split and look-alike words are read through: entity, emphasis, comment, link, tag, soft hyphen, zero-width joiner, Cyrillic and Greek letters, stems', () => {
    for (const w of ['&#98;rowser', '&#x62;rowser', 'br&amp;#111;wser', '**brow**ser', 'brow<!-- x -->ser', 'brow<!--\nx\n-->ser', '[brow](x)ser', '[brow][1]ser', '<b>brow</b>ser', 'brow\u00adser', 'brow\u200dser', 'brow\u2060ser', 'brow\ufeffser',
      'br\u043ewser', 'BR\u041ewser', '\u0412rowser', 'Chr\u039fme', 'ch\u0433ome'.replace('\u0433', '\u0433') && 'Chr\u043eme', '\u0432rowser', 'br\u03bfwser', 'Br\uff4fwser', '`brow`ser', '~~brow~~ser', '&#xff56;isual', '&#x1D42F;isual', '<Chrome 120, no errors>', '&ZeroWidthSpace;browser', 'vis\ufe0fual', 'render', 'rendering', 'renderer', 'visuals', 'visualisation', 'screenshotted', 'e2e', 'End-To-End', 'dev server']) {
      assert.ok(found(...w.replace(/\\n/g, '\n').split('\n')).length >= 1, JSON.stringify(w));
    }
    assert.deepEqual(found('we looked at', '> the page'), ['looked at the page']);
    assert.deepEqual(found('> > we opened', '> > the page'), ['opened the page']);
    assert.deepEqual(found('ordinary text about a lookup', 'with a second line'), []);
    assert.deepEqual(found('a <p> tag and a <br/> and <kbd>x</kbd> are not words'), []);
  });

  test('the vocabulary is English data: lower case, no duplicates; the report templates a lead may keep hold none of it', () => {
    assert.equal(new Set(CLAIM_VOCABULARY).size, CLAIM_VOCABULARY.length);
    for (const w of CLAIM_VOCABULARY) assert.match(w, /^[a-z0-9][a-z0-9 -]*\*?$/);
    for (const f of ['control-plane/agents/templates/COMPLETION_REPORT.md', 'skills/proofline-lead/assets/COMPLETION_REPORT.md']) {
      assert.equal(auditClaims(readFileSync(path.join(import.meta.dirname, '../..', f), 'utf8').split('\n'), NO), '', f);
    }
  });

  test('a repeated generated block is an error', () => {
    assert.equal(duplicateBlocks([CLAIMS_BEGIN, CLAIMS_END]), '');
    assert.match(duplicateBlocks([CLAIMS_BEGIN, CLAIMS_END, CLAIMS_BEGIN, CLAIMS_END]), /more than once/);
    assert.match(duplicateBlocks(['<!-- proofline:facts:begin -->', '<!-- proofline:facts:end -->', '<!-- proofline:facts:begin -->']), /more than once/);
  });

  test('a block without a hash, with a wrong hash or without a closing marker is refused; a text without a block is not', () => {
    assert.equal(checkClaimsBlock(['# R', 'text']), '');
    assert.match(checkClaimsBlock([CLAIMS_BEGIN, 'x', CLAIMS_END]), /changed by hand/);
    assert.match(checkClaimsBlock([CLAIMS_BEGIN, 'x', 'Claims-hash: 00', CLAIMS_END]), /changed by hand/);
    assert.match(checkClaimsBlock([CLAIMS_BEGIN, 'x']), /no closing marker/);
  });
});

describe('the publish step', () => {
  /** @type {ReturnType<typeof apparatus>} */ let ui;
  before(() => { ui = apparatus(); });

  test('visual pass on the final tree: the block says so, a report that claims a browser check publishes, and the final message line is printed', () => {
    const d = ui.visualFinal();
    writeReport(d, '', 'The page was checked in a real browser after the last change.');
    const r = accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a claim with a final-tree record was refused');
    assert.match(rd(d), /^- Visual\/browser check: ran on the final tree: pass \(visual\/browser check, gate QA:visual, record \d+\)$/m);
    assert.match(r.out, /Verification claims \(from the ledger\): \d+ of \d+ gates hold a record for the final tree; visual\/browser check: ran on the final tree: pass/);
    assert.equal(rd(d).split(CLAIMS_BEGIN).length - 1, 1, 'the block was written twice');
    // the task adapter's own write to the task file is not a change of the tree: a republish is the same bytes and the honest claim is accepted again
    // (the Facts block keeps its own statuses, which read the fingerprint with the task file in it: only the claims block and the text above it are compared)
    const upToFacts = (/** @type {string} */ t) => t.slice(0, t.indexOf('<!-- proofline:facts:begin -->'));
    const first = upToFacts(rd(d));
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a republish after the adapter wrote the task file was refused');
    assert.equal(upToFacts(rd(d)), first, 'a republish changed the report');
    assert.match(rd(d), /^- Visual\/browser check: ran on the final tree: pass/m);
  });

  test('visual pass on an earlier tree: the block says EARLIER tree; the claim without a disclaimer is refused before the task file changes, an honest sentence passes', () => {
    const d = ui.visualEarlier();
    const task = () => readFileSync(path.join(d, 'tasks/LC.md'), 'utf8');
    const before = task();
    writeReport(d, '', 'After the fix round the page was checked in a real browser.');
    const m = A(d, ['publish-completion-report', 'LC', 'markdown']);
    expectMsg('a browser claim on an earlier tree was published', 'words of a visual, browser or screenshot check outside the generated blocks', m);
    expectMsg('the message does not name the ledger fact', 'ran on an EARLIER tree', m);
    assert.equal(task(), before, 'the task file changed');
    const after = rd(d);
    assert.ok(!after.includes(CLAIMS_BEGIN) && after.includes('After the fix round the page was checked'), 'a refused publish changed the report');
    assert.equal(rd(d).length, after.length);
    expectMsg('a second refusal differs', 'line ', A(d, ['publish-completion-report', 'LC', 'markdown']));
    assert.equal(rd(d), after, 'a refused publish changed the report the second time');
    writeReport(d, '', 'The check ran on an earlier tree, before the last change.');
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'an honest sentence without the vocabulary was refused');
    assert.match(rd(d), /^- Visual\/browser check: ran on an EARLIER tree \(visual\/browser check, gate QA:visual, record \d+; /m);
    assert.match(rd(d), /not a check of the final tree/);
  });

  test('a run without the visual gate: no claim is made and a plain report is not refused; a browser claim is refused', () => {
    const d = ui.plain();
    writeReport(d, '', 'The page was checked in a real browser.');
    expectMsg('a browser claim without any visual gate was published', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['publish-completion-report', 'LC', 'markdown']));
    expectMsg('the message does not say the gate is absent', 'not part of this run', A(d, ['publish-completion-report', 'LC', 'markdown']));
    writeReport(d);
    const body = rd(d).split('\n'); body.pop();
    writeFileSync(path.join(d, REPORT), `${['# Completion Report: LC', '', '<!-- proofline:summary:begin -->', 'Changed: the lookup returns the default for an empty key', 'Verify: `sh test.sh`', '<!-- proofline:summary:end -->', ...body.slice(1)].join('\n')}\n`);
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a plain report with a Look at line about a browser was refused');
    assert.match(rd(d), /^Look at: Open the settings page in a browser and confirm the badge colour$/m);
    assert.match(rd(d), /^- Visual\/browser check: not part of this run \(no QA:visual gate\)/m);
    assert.doesNotMatch(rd(d), /ran on the final tree: pass \(visual/);
  });

  test('the generated Execution table is exempt even with a focus named by the vocabulary; a second Execution section written by the lead is read', () => {
    const d = ui.plain();
    mkdirSync(path.join(d, '.agents/runs/LC/decisions'), { recursive: true });
    writeFileSync(path.join(d, '.agents/runs/LC/decisions/001-qa.decision'), 'role=qa\nfocus=visual\nruntime=claude\nmodel=m1\neffort=low\nsignals=ui\nruntime_reason=\nescalated=no\nescalation_reason=\n');
    writeReport(d);
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a generated Execution table with a focus named visual was refused');
    assert.match(rd(d), /^\| qa \| visual \|/m);
    writeReport(d, '', '## Execution', '', 'The page was shown in Chrome.');
    expectMsg('a second Execution section was not read', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['publish-completion-report', 'LC', 'markdown']));
  });

  test('tamper: an edit of the generated block is refused with the hash message; a deleted block is written again', () => {
    const d = ui.visualEarlier();
    writeReport(d);
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish');
    writeFileSync(path.join(d, REPORT), rd(d).replace('ran on an EARLIER tree', 'ran on the final tree: pass'));
    expectMsg('a hand-edited block was published', 'was changed by hand', A(d, ['publish-completion-report', 'LC', 'markdown']));
    const lines = rd(d).split('\n');
    const b = lines.indexOf(CLAIMS_BEGIN); const e = lines.indexOf(CLAIMS_END);
    writeFileSync(path.join(d, REPORT), `${[...lines.slice(0, b), ...lines.slice(e + 1)].join('\n')}`);
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a report with the block deleted was refused');
    assert.match(rd(d), /ran on an EARLIER tree/);
  });

  test('next tells the lead to paste the line', () => {
    const d = ui.visualFinal();
    writeReport(d);
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish');
    assert.match(A(d, ['next', 'LC']).out, /paste the 'Final message line'/);
  });

  test('verify-completion-report recomputes the block: a text changed after publish is found, an untouched report verifies', () => {
    const d = ui.earlierPublished();
    accepted(A(d, ['verify-completion-report', 'LC']), 'an untouched report did not verify');
    const good = rd(d);
    // a changed text with the hash recomputed by the editor is not the block the records give
    const lines = good.split('\n'); const b = lines.indexOf(CLAIMS_BEGIN); const e = lines.indexOf(CLAIMS_END);
    const inner = lines.slice(b + 1, e - 1).map((l) => l.replace('ran on an EARLIER tree', 'ran on the final tree: pass'));
    const forged = [...lines.slice(0, b + 1), ...inner, `Claims-hash: ${sha256(`${inner.join('\n')}\n`)}`, ...lines.slice(e)].join('\n');
    writeFileSync(path.join(d, REPORT), forged);
    expectMsg('a forged block with a matching hash verified', 'differs from what the gate records give now', A(d, ['verify-completion-report', 'LC']));
    writeFileSync(path.join(d, REPORT), good.replace('ran on an EARLIER tree', 'ran on the final tree: pass'));
    expectMsg('an edited block verified', 'changed by hand', A(d, ['verify-completion-report', 'LC']));
    writeFileSync(path.join(d, REPORT), good.split('\n').filter((l, i) => i < b || i > e).join('\n'));
    expectMsg('a deleted block verified', 'block is missing', A(d, ['verify-completion-report', 'LC']));
    writeFileSync(path.join(d, REPORT), good);
    accepted(A(d, ['verify-completion-report', 'LC']), 'the restored report did not verify');
  });

  test('a file with the task file name elsewhere is a change of the tree: only the exact task path of the adapter is left out of the comparison', () => {
    const d = ui.visualFinal();
    writeFileSync(path.join(d, 'web/LC.md'), 'a different file with the name of the task file\n');
    writeReport(d, '', 'The page was checked in a real browser after the last change.');
    expectMsg('a file named like the task file hid a change of the tree', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['publish-completion-report', 'LC', 'markdown']));
  });

  test('a claim added after publish is found by verify-completion-report and by handoff DONE', () => {
    const d = ui.earlierPublished();
    accepted(A(d, ['verify-completion-report', 'LC']), 'an untouched report did not verify');
    const good = rd(d);
    writeFileSync(path.join(d, REPORT), good.replace('## Known Limitations / Follow-up', 'The page was checked in a real browser after the last change.\n\n## Known Limitations / Follow-up'));
    expectMsg('a claim added after publish verified', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['verify-completion-report', 'LC']));
    expectMsg('handoff DONE accepted a claim added after publish', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['handoff', 'LC', 'DONE']));
  });

  test('a fake Facts block or a second claims block added after publish, with a claim inside, is refused by verify, handoff DONE and the audit the delivery step uses', () => {
    const d = ui.earlierPublished();
    const good = rd(d);
    const fakeFacts = `${good}\n<!-- proofline:facts:begin -->\nThe page was checked in a real browser after the last change.\n<!-- proofline:facts:end -->\n`;
    writeFileSync(path.join(d, REPORT), fakeFacts);
    expectMsg('a second Facts block verified', 'appears more than once', A(d, ['verify-completion-report', 'LC']));
    expectMsg('a second Facts block passed DONE', 'appears more than once', A(d, ['handoff', 'LC', 'DONE']));
    const lines = good.split('\n'); const b = lines.indexOf(CLAIMS_BEGIN); const e = lines.indexOf(CLAIMS_END);
    writeFileSync(path.join(d, REPORT), `${good}\n${lines.slice(b, e + 1).join('\n').replace('## Verification claims', '## Verification claims\n\nThe page was checked in a real browser.')}\n`);
    expectMsg('a second claims block verified', 'appears more than once', A(d, ['verify-completion-report', 'LC']));
    // an edited Facts block (same markers, one claim line more) is not the block the ledger hashed
    writeFileSync(path.join(d, REPORT), good.replace('<!-- proofline:facts:end -->', 'The page was checked in a real browser.\n<!-- proofline:facts:end -->'));
    expectMsg('an edited Facts block verified', 'Facts block is missing or differs', A(d, ['verify-completion-report', 'LC']));
    writeFileSync(path.join(d, REPORT), good);
    accepted(A(d, ['verify-completion-report', 'LC']), 'the restored report did not verify');
  });

  test('a Look at line is exempt only while QA_REPORT.md is the file the QA gate record hashed', () => {
    const d = ui.plain();
    const summary = (/** @type {string} */ item) => {
      writeReport(d);
      const body = rd(d).split('\n'); body.pop();
      writeFileSync(path.join(d, REPORT), `${['# Completion Report: LC', '', '<!-- proofline:summary:begin -->', 'Changed: the lookup returns the default for an empty key', 'Verify: `sh test.sh`', '<!-- proofline:summary:end -->', ...body.slice(1)].join('\n')}\n`);
      void item;
    };
    summary('x');
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'the recorded Human checks were refused');
    const qa = path.join(d, '.agents/runs/LC/QA_REPORT.md');
    writeFileSync(qa, readFileSync(qa, 'utf8').replace('Open the settings page in a browser and confirm the badge colour', 'Open the other page in Chrome and confirm the badge colour'));
    summary('y');
    expectMsg('a Look at line from an edited QA report was exempt', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['publish-completion-report', 'LC', 'markdown']));
  });

  test('a run whose visual pass re-ran nothing: the exact A130 line publishes, a variant of it is read as text, a report without it keeps the A130 refusal', () => {
    const d = ui.notRerun();
    const put = (/** @type {string} */ line) => { writeReport(d, '', '- QA: QA-1 info row, the page files are unchanged.'); writeFileSync(path.join(d, REPORT), rd(d).replace('## QA Result\n', `## QA Result\n${line}\n`)); };
    writeReport(d, '', '- QA: QA-1 info row, the page files are unchanged.');
    expectMsg('a report without the not reproduced line was published', 'not reproduced (NOT_RERUN)', A(d, ['publish-completion-report', 'LC', 'markdown']));
    put('- QA:visual: not reproduced (NOT_RERUN) and the page was checked in Chrome');
    expectMsg('a variant of the NOT_RERUN line was exempt', 'words of a visual, browser or screenshot check outside the generated blocks', A(d, ['publish-completion-report', 'LC', 'markdown']));
    put('- QA:visual: not reproduced (NOT_RERUN)');
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'the exact NOT_RERUN line was refused');
    assert.match(rd(d), /^- QA:visual: not reproduced \(NOT_RERUN\)$/m);
  });

  test('a refusal after the checks (the plan changed since freeze) leaves the report byte-identical', () => {
    const d = ui.visualFinal();
    writeReport(d);
    const before = rd(d);
    writeFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), `${readFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), 'utf8')}\nA line added after the freeze.\n`);
    const m = A(d, ['publish-completion-report', 'LC', 'markdown']);
    assert.notEqual(m.status, 0, 'a publish after a plan change was accepted');
    assert.equal(rd(d), before, 'a refused publish changed the report');
  });

  test('the earlier-tree row quotes the fix rounds of the Facts block', () => {
    const d = ui.visualEarlier();
    writeReport(d);
    accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish');
    const facts = /- Fix rounds: (\d+) of \d+/.exec(rd(d))?.[1];
    assert.ok(facts !== undefined && Number(facts) > 0);
    assert.match(rd(d), new RegExp(`fix rounds used in the run: ${facts}, as in the Facts block`));
  });
});
