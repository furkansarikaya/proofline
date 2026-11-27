// @ts-check
// Standing approvals of measured visual items and page kinds (A380, issue 338 C3, the parts A361.1 deferred). A failed measured item of the QA visual
// report that the user waived with `standing` is kept as ONE row per check, page kind (or page) and threshold, with the worst value approved. It is carried
// only for exactly that: the same check and threshold, a value no worse, a page the report declares of that kind AND whose path matches the glob the user
// was shown. The approval boundary is attempted from every side: kind spoofing, a kind the page no longer has, a worse value, another threshold, a row
// edited by hand, a message that does not say standing, a revoked row, raw markup, a finding that does not match the report, a non-visual gate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, cpSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { before, beforeEach, describe, test } from 'node:test';
import { gpass, resultFor, AS } from '../lib/harness.mjs';
import { A, accepted, refused, say } from './legacy-lib.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { PAGE_GLOB_WILDCARDS, findingStandingMeasured, measureFp, pageGlobMatch, pageGlobOk, pageKindPath, shortfall, standingMeasureKey } from '../../control-plane/agents/scripts/core/standingmeasure.mjs';
import { readStanding } from '../../control-plane/agents/scripts/core/standing.mjs';
import { memoryIo } from './helpers.mjs';
import { RUN, frozen, implement, rrun, wr } from './risk-s2-lib.mjs';

const STORE = '.agents/local/standing/STANDING.tsv';
const VISUAL_UI = '\n## UI\n\none status badge\nvisual_writes: DB_PATH=:memory:';
const LEGAL = [{ kind: 'legal', paths: ['legal/*.html'], text_only: true, reason: 'privacy and terms' }];
const EVID = 'measured; screenshots/S1-phone.png sha256:0123456789ab';
/** The validator's row text of a failed core measurement. @param {string} id @param {string} check @param {number} v @param {string} t @param {string} screen */
const row = (id, check, v, t, screen = 'S1') => `${id} ${check}: ${v} fails ${t} at ${screen}/default/phone`;

/**
 * A visual report of one screen with failed measured items. @param {{ path?: string, kinds?: any, items?: Array<{ id: string, check: string, value: number, threshold: string }> }} o
 */
function report(o = {}) {
  const items = o.items ?? [{ id: 'M-3', check: 'touch_target', value: 19, threshold: '>= 44' }, { id: 'M-4', check: 'touch_target', value: 21, threshold: '>= 44' }];
  return `${JSON.stringify({ schema: 'visual-proof/1', result: 'FAIL', screens: [{ id: 'S1', path: o.path ?? 'legal/privacy.html', states: ['default'] }],
    measured: items.map((x) => ({ ...x, screen: 'S1', state: 'default', viewport: 'phone', selector: 'a.small', status: 'fail' })), ...(o.kinds === null ? {} : { page_kinds: o.kinds ?? LEGAL }),
    design: { status: 'run', pages: [{ screen: 'S1', path: o.path ?? 'legal/privacy.html', static: true, status: 'measured' }], items: [{ id: 'D-1', check: 'design_raw_markup', screen: 'S1', viewport: 'wide', value: 1, threshold: '== 0', status: 'fail' },
      { id: 'D-2', check: 'design_empty_hero', screen: 'S1', viewport: 'wide', value: 2, threshold: '== 0', status: 'fail' }] } })}\n`;
}

/** A COMPLEX run with the visual focus whose QA visual record FAILS on the given rows (the visual report is written first). @param {string[]} rows @param {Parameters<typeof report>[0]} [o] */
function visualFail(rows, o = {}) {
  const d = rrun('COMPLEX', 'web/index.html', VISUAL_UI);
  frozen(d); implement(d, 'web/index.html', '<main></main>');
  accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
  for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'SECURITY', 'QA']) gpass(d, g);
  wr(d, `${RUN}/reviews/visual-proof/report.json`, report(o));
  accepted(AS(d, 'qa', ['record', 'LC', '--file', resultFor(d, 'QA', 'FAIL', rows, { focus: 'visual' })]), 'the QA visual FAIL');
  return d;
}
/** @param {string} d */
const store = (d) => (existsSync(path.join(d, STORE)) ? readFileSync(path.join(d, STORE), 'latin1').split('\n').filter((l) => l !== '') : []);
/** @param {string} d */
const ctxOf = (d) => { const { io } = memoryIo(d); return new Context(io, io.scriptPath); };
/** A hand-made QA record of one finding, the way the control plane reads it. @param {string} d @param {string} text @param {string} [gate] @param {string} [focus] */
function recFile(d, text, gate = 'QA', focus = 'visual') {
  const f = path.join(d, RUN, 'gates', '990-probe.yaml');
  writeFileSync(f, `gate: "${gate}"\nfocus: "${focus}"\nresult: "fail"\nfinding: QA-1|blocking|web/index.html:1|${text}|${EVID}\n`);
  return f;
}
/** Is the finding carried by what stands, with this report? @param {string} d @param {string} text @param {Parameters<typeof report>[0]} [o] @param {string} [gate] @param {string} [focus] */
function carried(d, text, o = {}, gate = 'QA', focus = 'visual') {
  wr(d, `${RUN}/reviews/visual-proof/report.json`, report(o));
  return findingStandingMeasured(ctxOf(d), 'LC', recFile(d, text, gate, focus), 'QA-1');
}
/** The user waives QA-1 (and its group) with the given words; returns the outputs. @param {string} d @param {string} words */
function waive(d, words = 'approve qa-1 standing') {
  const req = accepted(A(d, ['request-approval', 'LC', 'waive:QA-1']), 'request');
  say(d, words);
  accepted(A(d, ['approve', 'LC', 'waive:QA-1']), 'approve');
  const w = accepted(A(d, ['waive', 'LC', 'QA-1', '--group', '--reason', 'old small links on the legal pages, a follow-up redesigns them']), 'waive');
  return { req: req.out, waive: w.out };
}

const TWO = [`QA-1|blocking|web/index.html:1|${row('M-3', 'touch_target', 19, '>= 44')}|${EVID}`, `QA-2|blocking|web/index.html:1|${row('M-4', 'touch_target', 21, '>= 44')}|${EVID}`];

describe('a measured item the user waived with standing is kept once per page kind, at the worst value approved', () => {
  // one project for the suite (a run takes seconds to build): built and waived once in `before`; every test sets the report it needs, and a test
  // that changes the store puts the user's row back, so the order of the tests does not matter
  /** @type {string} */ let d = '';
  /** @type {{ req: string, waive: string }} */ let out = { req: '', waive: '' };
  /** @type {string} */ let genuine = '';
  before(() => { d = visualFail(TWO); out = waive(d); genuine = readFileSync(path.join(d, STORE), 'latin1'); });
  beforeEach(() => { if (d !== '') writeFileSync(path.join(d, STORE), genuine); });

  test('the request shows the kind, its paths and the value; the waiver writes ONE row for the kind with the worst value of the group', () => {
    const { req, waive: w } = out;
    assert.match(req, /measured item\(s\) of the visual report: to keep this waiver for this project, add the word standing: "approve QA-1 standing"/);
    assert.match(req, /touch_target >= 44 on pages of kind legal \(paths legal\/\*\.html\) at a value no worse than 19/);
    assert.match(req, /a worse value, another threshold, another check or a page outside those paths is asked again/);
    assert.match(w, /standing waiver recorded: touch_target >= 44 on pages of kind legal \(paths legal\/\*\.html\) at a value no worse than 19/);
    const rows = store(d);
    assert.equal(rows.length, 1, 'one row per kind, not one per finding or file');
    const f = rows[0].split('\t');
    assert.deepEqual([f[0], f[1], f[2], f[6], f[8], f[9]], ['measure', 'touch_target', 'kind:legal:legal/*.html', 'user', 'qa-1', '19']);
    assert.equal(f[3], measureFp('touch_target', 'kind:legal:legal/*.html', '>= 44', '19'));
    assert.match(accepted(A(d, ['standing', 'list']), 'list').out, /- measure touch_target on pages of kind legal \(paths legal\/\*\.html\) at a value no worse than 19, approved by you/);
  });

  test('carried: another page of the kind, the same value, a better value; another run of the project reads the same row', () => {
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), true, 'the same item');
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44'), { path: 'legal/terms.html' }), true, 'another page of the kind is not asked again');
    assert.equal(carried(d, row('M-3', 'touch_target', 30, '>= 44'), { items: [{ id: 'M-3', check: 'touch_target', value: 30, threshold: '>= 44' }] }), true, 'a better value');
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44'), { path: '/legal/terms.html' }), true, 'a leading slash is the same page path');
    const d2 = visualFail([`QA-1|blocking|web/index.html:1|${row('M-3', 'touch_target', 20, '>= 44')}|${EVID}`], { path: 'legal/imprint.html', items: [{ id: 'M-3', check: 'touch_target', value: 20, threshold: '>= 44' }] });
    assert.equal(A(d2, ['pipeline', 'LC']).out.match(/^gate\.QA=(.*)$/m)?.[1], 'fail', 'the control: the new run fails');
    mkdirSync(path.dirname(path.join(d2, STORE)), { recursive: true });
    copyFileSync(path.join(d, STORE), path.join(d2, STORE));
    cpSync(path.join(d, '.agents/local/prompts/history'), path.join(d2, '.agents/local/prompts/history'), { recursive: true });
    assert.equal(A(d2, ['pipeline', 'LC']).out.match(/^gate\.QA=(.*)$/m)?.[1], 'waived', 'a page of the same kind was asked again in another run');
  });

  test('kind spoofing: a page the approved glob does not match is asked, whatever kind the report now declares for it', () => {
    const t = row('M-3', 'touch_target', 19, '>= 44');
    assert.equal(carried(d, t, { path: 'index.html', kinds: [{ kind: 'legal', paths: ['*.html'], reason: 'r' }] }), false, 'a landing page declared legal by a wider glob');
    assert.equal(carried(d, t, { path: 'index.html', kinds: [{ kind: 'legal', paths: ['index.html'], reason: 'r' }] }), false, 'a page listed under the kind by name');
    assert.equal(carried(d, t, { path: 'legal/sub/x.html', kinds: [{ kind: 'legal', paths: ['legal/**'], reason: 'r' }] }), false, 'a deeper page the approved * does not cross into');
    assert.equal(carried(d, t, { path: 'legal/privacy.html', kinds: [{ kind: 'article', paths: ['legal/*.html'], reason: 'r' }] }), false, 'the page is now of another kind');
    assert.equal(carried(d, t, { path: 'legal/privacy.html', kinds: null }), false, 'the report declares no kind');
    assert.equal(carried(d, t, { path: 'legal/privacy.html', kinds: [...LEGAL, { kind: 'policy', paths: ['legal/privacy.html'], reason: 'r' }] }), false, 'two kinds match: no kind');
    assert.equal(carried(d, t, { path: 'legal/../index.html' }), false, 'a path with a .. segment has no kind');
    assert.equal(carried(d, t, { path: 'legal/privacy.html?x=1' }), false, 'a query string has no page path');
  });

  test('a worse value, another threshold, another check or a finding the report does not back is asked again', () => {
    const one = (/** @type {number} */ v, t = '>= 44', check = 'touch_target') => ({ items: [{ id: 'M-3', check, value: v, threshold: t }] });
    assert.equal(carried(d, row('M-3', 'touch_target', 18, '>= 44'), one(18)), false, 'a worse value');
    assert.equal(carried(d, row('M-3', 'touch_target', 18.5, '>= 44'), one(18.5)), false, 'a slightly worse value');
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 48'), one(19, '>= 48')), false, 'another threshold');
    assert.equal(carried(d, row('M-3', 'contrast', 19, '>= 44'), one(19, '>= 44', 'contrast')), false, 'another check');
    assert.equal(carried(d, row('M-3', 'touch_target', 30, '>= 44'), one(18)), false, 'the finding says 30, the report item says 18');
    assert.equal(carried(d, row('M-9', 'touch_target', 19, '>= 44')), false, 'no such report item');
    assert.equal(carried(d, `touch target of 19 px on the legal pages is below 44`), false, 'a free-form finding has no key');
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44'), {}, 'REVIEW_RULES', '-'), false, 'not a QA visual record');
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44'), {}, 'QA', '-'), false, 'a QA record without the visual focus');
    wr(d, `${RUN}/reviews/visual-proof/report.json`, '{ not json');
    assert.equal(findingStandingMeasured(ctxOf(d), 'LC', recFile(d, row('M-3', 'touch_target', 19, '>= 44')), 'QA-1'), false, 'an unreadable report');
  });

  test('the store is the user\'s: an edited value, kind, glob or fingerprint, a message without standing and a revoked row carry nothing', () => {
    const t = row('M-3', 'touch_target', 15, '>= 44');
    const r15 = { items: [{ id: 'M-3', check: 'touch_target', value: 15, threshold: '>= 44' }] };
    const orig = genuine;
    const edit = (/** @type {number} */ i, /** @type {string} */ v) => writeFileSync(path.join(d, STORE), `${orig.trimEnd().split('\t').map((x, j) => (j === i ? v : x)).join('\t')}\n`);
    edit(9, '10'); assert.equal(carried(d, t, r15), false, 'a lowered value (the fingerprint binds it)');
    edit(2, 'kind:legal:**'); assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44'), { path: 'index.html', kinds: [{ kind: 'legal', paths: ['*.html'], reason: 'r' }] }), false, 'a widened glob');
    edit(6, 'agent'); assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), false, 'a row not answered by the user');
    const plain = say(d, 'approve qa-1');
    edit(4, plain.id); assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), false, 'a message that does not say standing');
    const other = say(d, 'approve qa-7 standing');
    edit(4, other.id); assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), false, 'a real standing message that names another finding');
    writeFileSync(path.join(d, STORE), orig.replace(/\t19\n$/, '\n')); assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), false, 'a measure row without its value field');
    writeFileSync(path.join(d, STORE), orig);
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), true, 'the control: the genuine row');
    say(d, 'revoke touch_target');
    assert.match(accepted(A(d, ['standing', 'revoke', 'touch_target']), 'revoke').out, /revoked 1 standing approval/);
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44')), false, 'a revoked row still carried');
    assert.match(readFileSync(path.join(d, '.agents/local/standing/REVOKED.tsv'), 'latin1'), /^measure\ttouch_target\tkind:legal:legal\/\*\.html\t[0-9a-f]{64}\t[^\t]+\t[^\t]+\tuser\t[^\t]+\tqa-1\t19\t/);
  });
});

describe('what the user saw is what is kept (A380 review)', () => {
  /** request, then the report is rewritten, then the user's standing approval and the waiver. @param {string} d @param {Parameters<typeof report>[0]} after */
  function rewriteBetween(d, after) {
    const req = accepted(A(d, ['request-approval', 'LC', 'waive:QA-1']), 'request').out;
    wr(d, `${RUN}/reviews/visual-proof/report.json`, report(after));
    say(d, 'approve qa-1 standing');
    accepted(A(d, ['approve', 'LC', 'waive:QA-1']), 'approve');
    const w = accepted(A(d, ['waive', 'LC', 'QA-1', '--group', '--reason', 'old small links on the legal pages, a follow-up redesigns them']), 'waive').out;
    return { req, w };
  }

  test('page_kinds rewritten between the request and the waiver (the PoC): the waiver is for the run only and nothing is kept', () => {
    const d = visualFail(TWO);
    const { req, w } = rewriteBetween(d, { kinds: [{ kind: 'legal', paths: ['**'], reason: 'r' }] });
    assert.match(req, /on pages of kind legal \(paths legal\/\*\.html\)/, 'the request showed the narrow glob');
    assert.match(w, /standing waiver of measured item\(s\) NOT kept: the visual report .* is not what the request showed you/);
    assert.match(w, /group waiver recorded: LC QA-1/, 'the run\'s own waiver stands');
    assert.deepEqual(store(d).filter((l) => l.startsWith('measure\t')), [], 'a row was kept that the user never saw');
    assert.equal(carried(d, row('M-3', 'touch_target', 19, '>= 44'), { path: 'index.html', kinds: [{ kind: 'legal', paths: ['**'], reason: 'r' }] }), false);
  });

  test('a page path swapped between the request and the waiver (a page with no kind) keeps nothing; an unchanged report keeps the row shown', () => {
    const d = visualFail(TWO, { kinds: null });
    const { req, w } = rewriteBetween(d, { kinds: null, path: 'index.html' });
    assert.match(req, /on the page legal\/privacy\.html at a value no worse than 19/);
    assert.match(w, /NOT kept/);
    assert.deepEqual(store(d).filter((l) => l.startsWith('measure\t')), []);
    const e = visualFail(TWO, { kinds: null });
    const ok = rewriteBetween(e, { kinds: null });
    assert.match(ok.w, /standing waiver recorded: touch_target >= 44 on the page legal\/privacy\.html at a value no worse than 19/, 'the control: the same report keeps the row');
  });

  test('at carry time the report must still declare the kind with the exact approved glob; the root page has its own page row', () => {
    const d = visualFail(TWO);
    waive(d);
    const t = row('M-3', 'touch_target', 19, '>= 44');
    assert.equal(carried(d, t, { kinds: [{ kind: 'legal', paths: ['legal/**'], reason: 'r' }] }), false, 'the kind now declared by a wider glob that also matches the page');
    assert.equal(carried(d, t, { kinds: [{ kind: 'legal', paths: ['terms.html', 'legal/*.html'], reason: 'r' }] }), true, 'the approved glob among the kind\'s globs');
    assert.equal(pageKindPath('/'), '/');
    assert.equal(pageKindPath('./'), '/');
    assert.equal(pageKindPath(''), null);
    wr(d, `${RUN}/reviews/visual-proof/report.json`, report({ kinds: null, path: '/' }));
    assert.equal(standingMeasureKey(ctxOf(d), 'LC', recFile(d, t), 'QA-1')?.surface, 'page:/', 'the root page is the page /');
  });

  test('an image-ledger item is never kept (its value counts images, so a kept row would cover every later unlicensed image)', () => {
    const d = visualFail(TWO);
    const items = [{ id: 'M-3', check: 'touch_target', value: 19, threshold: '>= 44' }];
    const rep = JSON.parse(report({ items }));
    rep.design.items.push({ id: 'D-3', check: 'design_image_ledger', screen: 'S1', viewport: 'wide', value: 1, threshold: '== 0', status: 'fail' });
    wr(d, `${RUN}/reviews/visual-proof/report.json`, `${JSON.stringify(rep)}\n`);
    assert.equal(standingMeasureKey(ctxOf(d), 'LC', recFile(d, 'D-3 design_image_ledger: 1 fails == 0 at S1/wide: img x.jpg has no row'), 'QA-1'), null);
    assert.notEqual(standingMeasureKey(ctxOf(d), 'LC', recFile(d, 'D-2 design_empty_hero: 2 fails == 0 at S1/wide: x'), 'QA-1'), null, 'the control: another design item of the same report has a key');
  });

  test('the glob matcher is linear: a hostile glob and hostile paths give the right answers, and more than 16 wildcards is not a glob', () => {
    const hostile = '**a'.repeat(16);
    assert.equal(pageGlobOk(hostile), true);
    assert.equal(pageGlobMatch(hostile, `${'a'.repeat(399)}b`), false);
    assert.equal(pageGlobMatch(hostile, 'a'.repeat(400)), true);
    assert.equal(pageGlobMatch(hostile, 'a/'.repeat(16)), false, 'the last a is not followed by /');
    assert.equal(pageGlobMatch('*a'.repeat(16), `${'a'.repeat(15)}/a`), false, 'one * never crosses /');
    assert.equal(pageGlobOk('*a'.repeat(PAGE_GLOB_WILDCARDS + 1)), false);
    assert.equal(pageGlobOk('a?'.repeat(PAGE_GLOB_WILDCARDS + 1)), false);
    for (const [g, p, want] of [['legal/*.html', 'legal/a.html', true], ['legal/*.html', 'legal/s/a.html', false], ['legal/**', 'legal/s/a.html', true], ['**', '/', true], ['*', '/', false],
      ['a?c', 'abc', true], ['a?c', 'a/c', false], ['***', 'x/y', true], ['legal.html', 'legalxhtml', false], ['legal/**/x.html', 'legal/x.html', false], ['legal/**/x.html', 'legal/a/b/x.html', true], ['x', 'x/', false]])
      assert.equal(pageGlobMatch(String(g), String(p)), want, `${g} ${p}`);
  });
});

describe('what is never carried', () => {
  test('raw markup (A368) has no key; an item of a page with no kind is kept for that page only', () => {
    const d = visualFail([`QA-1|blocking|web/index.html:1|D-1 design_raw_markup: 1 fails == 0 at S1/wide: p: bold "**x**"|${EVID}`]);
    const ctx = ctxOf(d);
    assert.equal(standingMeasureKey(ctx, 'LC', recFile(d, 'D-1 design_raw_markup: 1 fails == 0 at S1/wide: p: bold "**x**"'), 'QA-1'), null, 'raw markup has a measure key');
    const { req } = waive(d);
    assert.doesNotMatch(req, /measured item/, 'raw markup was offered as standing');
    assert.equal(store(d).filter((l) => l.startsWith('measure\t')).length, 0, 'a raw-markup waiver was kept for the project');
    const hero = standingMeasureKey(ctxOf(d), 'LC', recFile(d, 'D-2 design_empty_hero: 2 fails == 0 at S1/wide: first viewport lacks: primary action, visual'), 'QA-1');
    assert.equal(hero?.surface, 'kind:legal:legal/*.html', 'the control: a design item of the same report has a key');
    wr(d, `${RUN}/reviews/visual-proof/report.json`, report({ kinds: null }));
    const k = standingMeasureKey(ctxOf(d), 'LC', recFile(d, row('M-3', 'touch_target', 19, '>= 44')), 'QA-1');
    assert.equal(k?.surface, 'page:legal/privacy.html', 'without a kind the row is bound to the page path');
  });

  test('without the word standing nothing is kept; a role cannot list or revoke', () => {
    const d = visualFail(TWO);
    waive(d, 'approve qa-1');
    assert.deepEqual(store(d), [], 'a plain approval was kept for the project');
    refused(AS(d, 'qa', ['standing', 'list']), 'qa lists', 'command denied for qa');
  });

  test('shortfall orders values by how far they miss the threshold', () => {
    assert.deepEqual([shortfall('>= 44', 19), shortfall('>= 44', 44), shortfall('<= 2', 5), shortfall('== 0', 3), shortfall('45-75', 40), shortfall('45-75', 80), shortfall('45-75', 60), shortfall('~ 3', 1)], [25, 0, 3, 3, 5, 5, 0, null]);
  });

  test('a measure row of the store needs its value, and a value is a plain number', () => {
    const d = visualFail(TWO);
    const m = say(d, 'approve qa-1 standing').id;
    const fp = measureFp('touch_target', 'kind:legal:legal/*.html', '>= 44', '19');
    mkdirSync(path.dirname(path.join(d, STORE)), { recursive: true });
    for (const v of ['', '1e3', '19px', '-', 'Infinity']) {
      writeFileSync(path.join(d, STORE), `measure\ttouch_target\tkind:legal:legal/*.html\t${fp}\t${m}\t2026-11-26T10:00:00Z\tuser\tLC x\tqa-1\t${v}\n`);
      assert.equal(readStanding(ctxOf(d)).length, 0, JSON.stringify(v));
    }
    writeFileSync(path.join(d, STORE), `measure\ttouch_target\tkind:legal:legal/*.html\t${fp}\t${m}\t2026-11-26T10:00:00Z\tuser\tLC x\tqa-1\t19\n`);
    assert.equal(readStanding(ctxOf(d)).length, 1, 'the control: a well-formed row verifies');
  });
});
