// @ts-check
// risk-test.sh scenarios sc_mapping .. sc_probe_drift (lines 1-514: helpers and the scenarios before sc_frozen) as Node tests (176-D2). Every assertion, attack
// input and message of the shell scenario is kept. The control plane under test is the real one; the fixture is the harness's; the capability-probe PATH is the
// one tests/core/risk-s1-lib.mjs builds (A102, A214). A scenario that needs "no browser" is skipped, with the stated reason, on a host that has one installed.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { flattenDefinition } from '../../control-plane/agents/scripts/core/ecodata.mjs';
import { A, AS, accepted, agentsSrc, commitAll, expectMsg, git, gpass, must, passAll, rv, scripts, writeReport } from '../lib/harness.mjs';
import { NO_BROWSER_SKIP, RUN, SKD, Z, approve, focusSt, frozen, gateSt, has, hasnt, implement, lastFile, lastGate, lines, node, probeBin, pv, rd, rebase, rrun, scratch, snap, ueMove, ueRun, ueSubmit, unsReport, unsRun, unsVisual, wr } from './risk-s1-lib.mjs';

const SOURCES_SKIP = SKD && existsSync(path.join(SKD, 'contract-proof/scripts/validate-contract.mjs')) ? false : 'node or skill sources absent';
const UI_PLAN = lines('', '## UI', '', 'one status badge', 'visual_writes: DB_PATH=:memory:');

test('sc_mapping: contract, migration, ui, dependency, config and content signals -> their gate focus; traps carry none', () => {
  const d = rrun('CRITICAL', '');
  for (const dir of ['api', 'db/migrations', 'web', 'docs', 'src', 'migrations']) mkdirSync(path.join(d, dir), { recursive: true });
  wr(d, 'api/openapi.yaml', 'openapi: 3.0.0\n');
  wr(d, 'db/migrations/001_init.sql', 'create table t (id int);\n');
  wr(d, 'web/index.html', '<main></main>\n');
  wr(d, 'package.json', '{}\n');
  wr(d, '.env.example', 'KEY=\n');
  wr(d, 'docs/migration-guide.md', '# How to migrate\n');                 // trap: a guide named like a migration
  wr(d, 'migrations/README.md', '# migrations\n');                        // trap: documentation inside migrations/
  wr(d, 'src/contract.js', 'export const contract = {};\n');              // trap: named like a contract, not one
  wr(d, 'src/user.schema.ts', 'export const s = {};\n');                  // trap: a schema in code, not a schema file
  let po = snap(d);
  has(po, 'signal.contract_file=source=diff:api/openapi.yaml(**/openapi*.yaml) check=REVIEW_RULES:contract flag=contract_change:no design_role=architect');
  has(po, 'signal.migration=source=diff:db/migrations/001_init.sql(**/migrations/**) check=REVIEW_DATA:migration flag=data_change:no design_role=data_architect');
  has(po, 'signal.ui_path=source=diff:web/index.html(*.html) check=QA:visual flag=ui:no design_role=designer');
  has(po, 'signal.dependency_manifest=source=diff:package.json(package.json) check=SECURITY:dependencies flag=- design_role=-');
  has(po, 'signal.config_env=source=diff:.env.example(.env.*) check=REVIEW_RULES:config flag=- design_role=-');
  hasnt(po, 'migration-guide'); hasnt(po, 'migrations/README.md'); hasnt(po, 'src/contract.js'); hasnt(po, 'user.schema.ts');
  has(po, 'missing_flag.contract_file=diff:api/openapi.yaml needs PLAN.md contract_change: yes');
  has(po, 'missing_flag.migration=diff:db/migrations/001_init.sql needs PLAN.md data_change: yes');
  has(po, 'missing_flag.ui_path=diff:web/index.html needs PLAN.md ui: yes');
  hasnt(po, 'missing_flag.dependency_manifest'); hasnt(po, 'missing_flag.config_env');
  assert.equal(pv(po, 'gates'), 'SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY', `a migration signal adds REVIEW_DATA: ${pv(po, 'gates')}`);
  for (const fx of ['REVIEW_RULES.config', 'REVIEW_RULES.contract', 'REVIEW_DATA.migration', 'SECURITY.dependencies', 'QA.visual']) has(po, `focus.${fx}=missing`);
  has(po, 'design_role.architect=contract_file'); has(po, 'design_role.data_architect=migration'); has(po, 'design_role.designer=ui_path');
  // content hints are off by default and fire on added text once the project configures them
  po = snap(d); hasnt(po, 'signal.concurrency_hint');
  const cfg = path.join(d, '.agents/config.yaml');
  const out = [];
  const src = readFileSync(cfg, 'utf8').split('\n');
  for (let i = 0; i < src.length; i++) {
    out.push(src[i]);
    if (/^ {2}concurrency_hint:/.test(src[i])) { out.push('    content: "go func|sync\\.Mutex"'); i++; } else if (/^ {2}performance_hint:/.test(src[i])) { out.push('    content: "for .* range"'); i++; }
  }
  writeFileSync(cfg, out.join('\n'));
  wr(d, 'src/worker.go', 'package x\nfunc f() { go func() {}() }\n');
  po = snap(d);
  has(po, 'signal.concurrency_hint=source=diff:src/worker.go(content /go func/sync\\.Mutex/) check=REVIEW_RULES:concurrency flag=concurrency:no design_role=architect');
  has(po, 'missing_flag.concurrency_hint=diff:src/worker.go');
  hasnt(po, 'signal.performance_hint');
  wr(d, 'src/loop.go', 'package x\nfunc g(a []int) { for _, v := range a { _ = v } }\n');
  po = snap(d); has(po, 'signal.performance_hint=source=diff:src/loop.go(content /for .* range/) check=REVIEW_RULES:performance');
});

test('sc_flags: ## Risk, ## UI and ## Data add their checks; invalid flag refused; REVIEW_SMALL carries rules focuses; no gate invented', () => {
  let d = rrun('CRITICAL', '', lines('', '## Risk', '', 'contract_change: yes', '- concurrency: yes', 'performance_critical: yes  # p95 of /search', '', '## UI', '', 'one status badge', '', '## Data', '', 'destructive: yes'));
  wr(d, 'app.py', 'x = 1\n');
  let po = snap(d);
  has(po, 'signal.contract_change=source=plan:PLAN.md(## Risk contract_change: yes) check=REVIEW_RULES:contract');
  has(po, 'signal.concurrency=source=plan:PLAN.md(## Risk concurrency: yes) check=REVIEW_RULES:concurrency');
  has(po, 'signal.performance_critical=source=plan:PLAN.md(## Risk performance_critical: yes) check=REVIEW_RULES:performance');
  has(po, 'signal.ui=source=plan:PLAN.md(## UI section) check=QA:visual');
  has(po, 'signal.destructive=source=plan:PLAN.md(## Data destructive: yes) check=REVIEW_DATA:migration');
  hasnt(po, 'missing_flag.');
  // a flag set with no matching path in the diff: the check is still required (the plan says it is needed)
  hasnt(po, 'signal.contract_file'); has(po, 'focus.REVIEW_RULES.contract=missing'); has(po, 'focus.QA.visual=missing');
  // A112: a COMPLEX plan with a ## UI section is refused at freeze without a visual_writes line, accepted with it
  d = rrun('COMPLEX', '', lines('', '## UI', '', 'one status badge'));
  approve(d, 'plan', 'approve the plan');
  expectMsg('a COMPLEX UI plan without visual_writes was frozen', "no 'visual_writes: <how the data the page writes is thrown away>' line", Z(d, ['freeze', 'LC']));
  d = rrun('COMPLEX', '', lines('', '## UI', '', 'one status badge', 'visual_writes: DB_PATH=:memory:, discarded on exit'));
  approve(d, 'plan', 'approve the plan');
  accepted(Z(d, ['freeze', 'LC']), 'COMPLEX UI plan with visual_writes does not freeze');
  // STANDARD has a QA gate too: the same refusal and the same acceptance
  d = rrun('STANDARD', '', lines('', '## UI', '', 'one status badge'));
  expectMsg('a STANDARD UI plan without visual_writes was frozen', "no 'visual_writes: <how the data the page writes is thrown away>' line", Z(d, ['freeze', 'LC']));
  d = rrun('STANDARD', '', lines('', '## UI', '', 'one status badge', '- visual_writes: DB_PATH=:memory:'));
  accepted(Z(d, ['freeze', 'LC']), 'STANDARD UI plan with visual_writes does not freeze');
  // an invalid ## Risk line is refused at freeze
  d = rrun('STANDARD', '', lines('', '## Risk', '', 'contract_change: maybe'));
  expectMsg('an invalid ## Risk line was frozen', "PLAN.md '## Risk' holds only flag lines", Z(d, ['freeze', 'LC']));
  // tier small: the contract focus is carried by REVIEW_SMALL
  d = rrun('STANDARD', 'api/openapi.yaml', lines('', '## Risk', '', 'contract_change: yes'));
  const cfg = path.join(d, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^ {2}small_max_files: 2/m, '  small_max_files: 4'));   // room for the run's own scope files
  commitAll(d, 'small tier room'); rebase(d);
  accepted(A(d, ['classify', 'LC', 'STANDARD', 'review']), 'classify'); accepted(Z(d, ['freeze', 'LC']), 'freeze'); accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'handoff');
  wr(d, 'api/openapi.yaml', 'openapi: 3.0.0\n');   // one exempt file: tier small
  po = snap(d); assert.equal(pv(po, 'tier'), 'small', `tier is ${pv(po, 'tier')}, want small`);
  has(po, 'check=REVIEW_SMALL:contract'); has(po, 'focus.REVIEW_SMALL.contract=missing');
  // A92 (F8): the metrics record of a contract focus at tier small names REVIEW_SMALL, not REVIEW_RULES
  implement(d, 'api/openapi.yaml', 'openapi: 3.0.0');
  wr(d, `${RUN}/reviews/contract-proof/REPORT.md`, '# contract\n\nNo breaking change found.\n');
  accepted(AS(d, 'reviewer', ['submit', 'LC', '--focus', 'contract', '--confidence', 'high', '--artifact', 'reviews/contract-proof/REPORT.md']), 'contract submit');
  const metrics = existsSync(path.join(d, '.agents/local/metrics/records.jsonl')) ? rd(d, '.agents/local/metrics/records.jsonl') : '';
  assert.ok(metrics.includes('"focus":"contract","gate":"REVIEW_SMALL"'), `metrics gate label at tier small: ${metrics}`);
  // TRIVIAL has no QA gate: a ui signal names no gate instead of inventing one
  // A96: a copy fix in a UI file of a TRIVIAL run: no designer, no ui flag, no missing flag, plan freezes as is
  d = rrun('TRIVIAL', ''); rmSync(path.join(d, RUN, 'EVIDENCE.md'), { force: true }); rmSync(path.join(d, RUN, 'QA_PLAN.md'), { force: true });
  wr(d, 'page.html', '<p></p>\n');
  writeFileSync(path.join(d, RUN, 'PLAN.md'), `${['---', 'scope:', '  - path: page.html', '    criteria: [AC-1]', '    tdd_exemption: "single-word copy fix in static markup; verified by an absence grep"', '---', '# Plan', '', '## Assumptions', 'none'].join('\n')}\n`);
  po = snap(d); has(po, 'signal.ui_path=source=diff:page.html(*.html),scope:page.html(*.html) check=- (class TRIVIAL: no design phase / no QA gate) flag=ui:no design_role=-');
  hasnt(po, 'missing_flag.'); hasnt(po, 'design_role.');
  const nx = A(d, ['next', 'LC']).out;
  assert.ok(!nx.includes('designer'), `TRIVIAL ui_path dispatches a designer: ${nx}`);
  accepted(Z(d, ['freeze', 'LC']), 'TRIVIAL plan touching an .html file does not freeze');
  assert.ok(!existsSync(path.join(d, RUN, 'design')), 'design folder exists for TRIVIAL');
});

test('sc_missing_flag: blocking finding at the focus, check still runs, gate needs every focus, declared flag passes', () => {
  let d = rrun('COMPLEX', 'api/openapi.yaml'); frozen(d); implement(d, 'api/openapi.yaml', 'openapi: 3.0.0');
  for (const g of pipeGates(d)) { if (g === 'SECRETS') must(d, ['secret-scan', 'LC']); else gpass(d, g); }   // every gate's own focus
  assert.equal(gateSt(d, 'REVIEW_RULES'), 'missing', `REVIEW_RULES passed without its contract focus: ${gateSt(d, 'REVIEW_RULES')}`);
  expectMsg('CODE_DONE without the contract focus', 'REVIEW_RULES', A(d, ['handoff', 'LC', 'CODE_DONE']));
  // the reviewer runs the contract check and finds nothing; the script adds the missing-flag finding
  mkdirSync(path.join(d, RUN, 'reviews/contract-proof'), { recursive: true });
  const sub = AS(d, 'reviewer', ['submit', 'LC', '--focus', 'contract', '--confidence', 'high', '--artifact', 'reviews/contract-proof/REPORT.md', '--report', '-'], { input: '# contract\n\nNo breaking change found.\n' });
  assert.equal(sub.status, 0, `submit failed: ${sub.text}`);
  assert.ok(sub.out.includes('risk: 1 script finding(s) added to REVIEW_RULES focus contract'), `no risk notice: ${sub.out}`);
  assert.ok(sub.out.includes('submitted: LC reviewer FAIL gate=REVIEW_RULES'), `submit did not report FAIL: ${sub.out}`);
  const rec = readFileSync(lastGate(d, 'REVIEW_RULES'), 'utf8');
  assert.ok(/^focus: "contract"/m.test(rec) && /^result: "fail"/m.test(rec), 'the contract record is not a fail');
  assert.match(rec, /finding: REVIEW_RULES-[0-9]+\|blocking\|api\/openapi.yaml\|risk signal contract_file without PLAN.md flag contract_change/, `missing-flag finding absent: ${rec.split('\n').filter((l) => l.includes('finding')).join('\n')}`);
  assert.match(rec, /^fix_scope: api\/openapi.yaml$/m, `fix scope: ${rec.split('\n').filter((l) => l.includes('fix_scope')).join('\n')}`);
  assert.ok(gateSt(d, 'REVIEW_RULES') === 'fail' && focusSt(d, 'REVIEW_RULES', 'contract') === 'fail', 'gate/focus not fail');
  assert.match(A(d, ['next', 'LC']).out, /amend PLAN.md to declare the flag of REVIEW_RULES-[0-9]+/, 'next does not name the plan amendment');
  // a contract focus that is not triggered is refused
  d = rrun('COMPLEX', 'src/a.js'); frozen(d); implement(d, 'src/a.js', 'export const a = 1;');
  wr(d, `${RUN}/reviews/contract-proof/REPORT.md`, '# c\n');
  expectMsg('an untriggered focus was recorded', 'focus contract is not required', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'contract', '--confidence', 'high', '--artifact', 'reviews/contract-proof/REPORT.md']));
  // declared: the same change passes once every focus passes
  d = rrun('COMPLEX', 'api/openapi.yaml', lines('', '## Risk', '', 'contract_change: yes')); frozen(d); implement(d, 'api/openapi.yaml', 'openapi: 3.0.0');
  passAll(d);
  assert.equal(gateSt(d, 'REVIEW_RULES'), 'pass', `declared contract change does not pass: ${gateSt(d, 'REVIEW_RULES')}`);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'handoff CODE_DONE');
});
/** `required`: the gates the pipeline names. @param {string} d */
function pipeGates(d) { return pv(snap(d), 'gates').split(/\s+/).filter(Boolean); }

test('sc_unsupported: UNSUPPORTED: unproven and reported (gate closes, never pass, report lists it with \'not proven:\')', { skip: NO_BROWSER_SKIP }, () => {
  const d = unsRun();
  // A98: a vague reason is a dodge, refused; a concrete one (tool, capability, path) is accepted
  expectMsg("a reason 'n/a'", 'UNSUPPORTED_REASON is too vague', unsVisual(d, 'n/a'));
  expectMsg('a reason without an anchor', 'UNSUPPORTED_REASON is too vague', unsVisual(d, 'n/a for this change, skipped'));
  const sub = unsVisual(d, 'visual-proof skill not installed; no headless browser in the project');
  assert.equal(sub.status, 0, `submit failed: ${sub.text}`);
  assert.ok(sub.out.includes('submitted: LC qa UNSUPPORTED gate=QA'), `UNSUPPORTED was not recorded as such: ${sub.out}`);
  assert.ok(sub.out.includes('QA focus visual is UNSUPPORTED (unproven, reported, A98)'), `no unsupported notice: ${sub.out}`);
  assert.equal(focusSt(d, 'QA', 'visual'), 'unsupported', `focus is not unsupported: ${focusSt(d, 'QA', 'visual')}`);
  assert.equal(gateSt(d, 'QA'), 'pass', `an unsupported-only focus holds the gate open: ${gateSt(d, 'QA')}`);
  const rec = readFileSync(lastGate(d, 'QA'), 'utf8');
  assert.ok(/^result: "unsupported"$/m.test(rec) && /^unsupported: "visual"$/m.test(rec), `the focus record is not unsupported: ${rec}`);
  assert.match(rec, /^finding: QA-1\|info\|-\|UNSUPPORTED visual: visual-proof skill not installed/m, `unsupported row: ${rec.split('\n').filter((l) => l.includes('finding')).join('\n')}`);
  assert.ok(!/^result: "pass"/m.test(rec), 'UNSUPPORTED recorded as pass');
  const po = snap(d);
  has(po, 'unsupported.QA:visual=UNSUPPORTED (unproven, reported): visual: visual-proof skill not installed');
  has(po, 'gate.QA.unsupported=visual (unproven, reported');
  const summary = A(d, ['summary', 'LC']).out;
  assert.ok(summary.split('\n').includes('QA: pass (unsupported: visual)'), `summary shows a bare pass: ${summary.split('\n').filter((l) => l.startsWith('QA')).join('\n')}`);
  expectMsg('UNSUPPORTED without a reason', 'needs --reason', AS(d, 'qa', ['submit', 'LC', '--focus', 'visual', '--result', 'UNSUPPORTED', '--confidence', 'high', '--artifact', 'reviews/visual-proof/REPORT.md']));
  expectMsg('UNSUPPORTED on a base focus', 'UNSUPPORTED is a result of a risk focus only', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules', '--result', 'UNSUPPORTED', '--reason', 'no tool', '--confidence', 'high']));
  const nx = A(d, ['next', 'LC']).out;
  assert.ok(nx.includes('next=UNSUPPORTED (unproven, reported) QA:visual: visual: visual-proof skill not installed'), `next does not name the unsupported focus: ${nx}`);
  assert.ok(nx.includes('next=agent.sh handoff LC CODE_DONE'), `next does not offer CODE_DONE: ${nx}`);
  assert.ok(!nx.includes('waive:'), `next asks for a waiver of a reported UNSUPPORTED: ${nx}`);
  assert.ok(nx.includes('next=surface these unsupported checks to the user in your reply'), `next does not ask to surface them: ${nx}`);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'handoff CODE_DONE'); accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done');
  assert.ok(A(d, ['next', 'LC']).out.includes('next=UNSUPPORTED (unproven, reported) QA:visual'), 'next before the report does not name the unsupported focus');
  const pub = () => A(d, ['publish-completion-report', 'LC', 'markdown']);
  writeReport(d);
  expectMsg('a report without the UNSUPPORTED section', '## Unsupported Checks', pub());
  writeReport(d, '', '## Unsupported Checks', 'Visual check skipped; not proven: layout at 320px.');
  expectMsg('a report that does not name the check', 'must name the UNSUPPORTED check QA:visual', pub());
  // A92: the name counts only inside the section it is required under
  writeReport(d, '', '## Review Result', 'QA:visual unsupported.', '', '## Unsupported Checks', 'Visual check skipped.');
  expectMsg('a check named outside the section', 'must name the UNSUPPORTED check QA:visual', pub());
  writeReport(d, '', '## Unsupported Checks', '- QA:visual: visual-proof skill not installed.');
  expectMsg("a check without its 'not proven' line", "must say 'not proven: <what>'", pub());
  writeReport(d, '', '## Unsupported Checks', '- QA:visual: visual-proof skill not installed; not proven: n/a');
  expectMsg("a 'not proven: n/a' line", "must say 'not proven: <what>' in at least three words", pub());
  writeReport(d, '', '## Unsupported Checks', '- QA:visual: visual-proof skill not installed; not proven: the badge renders without overflow at 320px.');
  accepted(pub(), 'a complete UNSUPPORTED report');
});

test('sc_unsupported_inconclusive: INCONCLUSIVE blocks until the user waives it; the report names it', () => {
  // INCONCLUSIVE stays blocking under the default: a measurement ran and was unreliable, the user decides
  const d = unsRun();
  const sub = unsVisual(d, 'visual INCONCLUSIVE: two identical captures differ by 4% of pixels');
  assert.equal(sub.status, 0, `submit failed: ${sub.text}`);
  assert.ok(sub.out.includes('submitted: LC qa FAIL gate=QA'), `INCONCLUSIVE was not a failing focus: ${sub.out}`);
  assert.ok(focusSt(d, 'QA', 'visual') === 'fail' && gateSt(d, 'QA') === 'fail', `INCONCLUSIVE did not block: ${focusSt(d, 'QA', 'visual')}`);
  has(snap(d), 'unsupported.QA:visual=UNSUPPORTED (blocking: a waiver or a measurement is needed): visual: visual INCONCLUSIVE:');
  const fid = /^finding: ([^|]*)\|blocking\|-\|UNSUPPORTED .*/m.exec(readFileSync(lastGate(d, 'QA'), 'utf8'))?.[1] ?? '';
  assert.notEqual(fid, '', 'no blocking UNSUPPORTED finding id');
  const nx = A(d, ['next', 'LC']).out;
  assert.ok(nx.includes(`request-approval LC waive:${fid} (blocking UNSUPPORTED visual`), `next does not offer the user's waiver: ${nx}`);
  // A92: only a script finding fails the gate: no implementer fix round is offered
  assert.ok(!nx.includes('handoff LC IMPLEMENTING'), 'next offers a fix round for an UNSUPPORTED-only failure');
  approve(d, `waive:${fid}`, `approved, ${fid}`);
  accepted(A(d, ['waive', 'LC', fid, '--reason', 'unstable rendering in this environment; the user accepts the visual gap']), 'waive');
  assert.equal(gateSt(d, 'QA'), 'waived', `waived INCONCLUSIVE gate: ${gateSt(d, 'QA')}`);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'handoff CODE_DONE'); accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done');
  writeReport(d, '', '## Waivers', 'The user waived the INCONCLUSIVE finding.', '', '## Unsupported Checks', 'Visual check skipped.');
  expectMsg('a waived INCONCLUSIVE not named', 'must name the UNSUPPORTED check QA:visual', A(d, ['publish-completion-report', 'LC', 'markdown']));
  writeReport(d, '', '## Waivers', 'The user waived the INCONCLUSIVE finding.', '', '## Unsupported Checks', '- QA:visual: visual INCONCLUSIVE, waived by the user; not proven: the badge layout.');
  accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish');
});

test("sc_unsupported_rows: another focus's INCONCLUSIVE prefix is refused; a defect row plus UNSUPPORTED fails and goes to a fix round", () => {
  // A102: an INCONCLUSIVE reason must carry the focus's own prefix; another focus's prefix is refused
  let d = unsRun();
  expectMsg("another focus's INCONCLUSIVE prefix", "must start 'visual INCONCLUSIVE:'", unsVisual(d, 'performance INCONCLUSIVE: noise 30% over the 10% threshold'));
  // FAIL + UNSUPPORTED: a defect in the part that could be checked is a FAIL (the contract-proof shape: defect rows
  // plus blocking UNSUPPORTED rows); it blocks, the implementer fixes the defect, the UNSUPPORTED row is listed
  d = unsRun(); unsReport(d);
  const rows = scratch('uns.rows', `${lines('blocking|web/index.html:1|the status badge has no text alternative|traced: <main> holds an img without alt', 'blocking|-|UNSUPPORTED visual: no headless browser for the overflow cells|no measurement')}\n`);
  expectMsg('UNSUPPORTED with a blocking row', 'UNSUPPORTED cannot carry blocking findings', AS(d, 'qa', ['submit', 'LC', '--focus', 'visual', '--result', 'UNSUPPORTED', '--reason', 'no browser', '--findings', rows, '--confidence', 'high', '--artifact', 'reviews/visual-proof/REPORT.md']));
  const sub = AS(d, 'qa', ['submit', 'LC', '--focus', 'visual', '--findings', rows, '--confidence', 'high', '--artifact', 'reviews/visual-proof/REPORT.md']);
  assert.equal(sub.status, 0, `submit failed: ${sub.text}`);
  assert.ok(sub.out.includes('submitted: LC qa FAIL gate=QA'), `FAIL+UNSUPPORTED did not fail: ${sub.out}`);
  assert.ok(focusSt(d, 'QA', 'visual') === 'fail' && gateSt(d, 'QA') === 'fail', 'FAIL+UNSUPPORTED did not block');
  has(snap(d), 'unsupported.QA:visual=UNSUPPORTED (blocking: a waiver or a measurement is needed): visual: no headless browser');
  const nx = A(d, ['next', 'LC']).out;
  assert.ok(nx.includes('handoff LC IMPLEMENTING (fix round'), `next does not send the defect to a fix round: ${nx}`);
});

test('sc_unsupported_block: UNSUPPORTED under risk.unsupported: block blocks; not available for dependencies', { skip: NO_BROWSER_SKIP }, () => {
  // risk.unsupported: block restores A78: the UNSUPPORTED row is blocking, the gate fails, only the user waives
  let d = unsRun((cfg) => cfg.replace(/^ {2}unsupported: report$/m, '  unsupported: block'));
  assert.ok(/^ {2}unsupported: block$/m.test(rd(d, '.agents/config.yaml')), 'the block edit did not apply');
  accepted(A(d, ['config-check']), 'config-check');
  const sub = unsVisual(d, 'visual-proof skill not installed');
  assert.equal(sub.status, 0, `submit failed: ${sub.text}`);
  assert.ok(sub.out.includes('submitted: LC qa FAIL gate=QA'), `block mode did not fail: ${sub.out}`);
  assert.equal(gateSt(d, 'QA'), 'fail', `block mode gate: ${gateSt(d, 'QA')}`);
  assert.ok(A(d, ['next', 'LC']).out.includes('request-approval LC waive:QA-1'), 'block mode: next does not offer the waiver');
  // the dependency audit always has a tool-free check
  d = rrun('COMPLEX', 'package.json'); frozen(d); implement(d, 'package.json', '{}');
  wr(d, `${RUN}/security/dependencies/REPORT.md`, '# deps\n');
  expectMsg('UNSUPPORTED dependency audit', 'UNSUPPORTED is not available', AS(d, 'security_reviewer', ['submit', 'LC', '--focus', 'dependencies', '--result', 'UNSUPPORTED', '--reason', 'no audit tool', '--confidence', 'high', '--artifact', 'security/dependencies/REPORT.md']));
});

// A102: UNSUPPORTED is backed by the skill validator's saved output (snapshotted, sha-bound) and cross-checked against the script's own risk signals; a reason
// alone, a fabricated file or an edited one is refused. The genuine evidence comes from running the skills' own validators on the fixture.
test("sc_unsupported_evidence: the validator's own output, snapshotted and sha-bound; no evidence, a made-up file, another base, an edited snapshot, an unlisted recognized contract or .sql migration are refused", { skip: SOURCES_SKIP }, () => {
  const contractPlan = lines('', '## Risk', '', 'contract_change: yes');
  // contract on a prose-only change: contract-proof itself says UNSUPPORTED (no contract file recognized)
  let d = ueRun('docs/API.md', '# API: GET /items returns a list.', contractPlan);
  const b = rv(d, 'repository', 'base_sha'); mkdirSync(path.join(d, RUN, 'scratch'), { recursive: true });
  wr(d, `${RUN}/reviews/contract-proof/REPORT.md`, '# contract\n\nNo machine-readable contract; docs/API.md is prose.\n');
  node(d, [`${SKD}/contract-proof/scripts/diff-contract.mjs`, '--repo', '.', '--base', b, '--out', `${RUN}/scratch/contract.json`]);
  wr(d, `${RUN}/reviews/contract-proof/validator.txt`, node(d, [`${SKD}/contract-proof/scripts/validate-contract.mjs`, `${RUN}/scratch/contract.json`, '--repo', '.', '--base', b]));
  const vt = rd(d, `${RUN}/reviews/contract-proof/validator.txt`);
  assert.ok(vt.split('\n').includes('RESULT: UNSUPPORTED') && vt.split('\n').includes(`BASE: ${b}`), `contract-proof output: ${vt}`);
  expectMsg('UNSUPPORTED without evidence', 'needs --evidence', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'contract', '--result', 'UNSUPPORTED', '--reason', 'no machine-readable contract; docs/API.md is prose', '--confidence', 'low', '--artifact', 'reviews/contract-proof/REPORT.md']));
  wr(d, `${RUN}/reviews/contract-proof/made-up.txt`, 'contract-proof could not run: no parser for prose\n');
  expectMsg("evidence without the validator's RESULT line", "does not hold the validator's 'RESULT: UNSUPPORTED' line", ueSubmit(d, 'contract', 'reviews/contract-proof/made-up.txt'));
  expectMsg('evidence outside the run', 'must be an existing file inside the run', ueSubmit(d, 'contract', '/etc/hosts'));
  wr(d, `${RUN}/reviews/contract-proof/other-base.txt`, vt.replace(/^BASE: .*/gm, 'BASE: 0000000000000000000000000000000000000000'));
  expectMsg('evidence produced against another base', "not the run's base", ueSubmit(d, 'contract', 'reviews/contract-proof/other-base.txt'));
  const sub = ueSubmit(d, 'contract', 'reviews/contract-proof/validator.txt');
  assert.equal(sub.status, 0, `genuine evidence refused: ${sub.text}`);
  assert.ok(sub.out.includes('submitted: LC reviewer UNSUPPORTED gate=REVIEW_'), `genuine evidence refused: ${sub.out}`);
  const g = /^submitted: .* gate=(REVIEW_[A-Z]*) .*/m.exec(sub.out)?.[1] ?? '';   // REVIEW_SMALL at tier small
  const rec = readFileSync(lastGate(d, g), 'utf8'); const ev = /^unsupported_evidence: "(.*)@[0-9a-f]{12}"$/m.exec(rec)?.[1] ?? '';
  assert.match(ev, /^reports\/snapshots\/.*-reviewer-reviews_contract-proof_validator\.txt$/, `gate record evidence: ${rec.split('\n').filter((l) => l.includes('unsupported_evidence')).join('\n')}`);
  assert.equal(focusSt(d, g, 'contract'), 'unsupported', `contract focus: ${focusSt(d, g, 'contract')}`);
  const po = snap(d); has(po, `unsupported.${g}:contract=UNSUPPORTED (unproven, reported)`); has(po, `(evidence: ${ev}@`);
  assert.ok(A(d, ['next', 'LC']).out.includes(`(evidence: ${ev}@`), `next does not name the evidence: ${A(d, ['next', 'LC']).out}`);
  // the snapshot is bound by its sha256: edited after submit, the record is stale and a re-cite is refused
  const raw = scratch('raw.ue', readFileSync(lastFile(d, `${RUN}/results`, '-reviewer.result.md'), 'utf8'));
  wr(d, `${RUN}/${ev}`, 'RESULT: UNSUPPORTED\n');
  assert.equal(focusSt(d, g, 'contract'), 'stale', `edited evidence still counts: ${focusSt(d, g, 'contract')}`);
  expectMsg('a record citing the edited evidence', 'UNSUPPORTED_EVIDENCE sha256 mismatch', AS(d, 'reviewer', ['record', 'LC', '--file', raw]));
  // a recognized OpenAPI file in the diff: the claim is refused unless the differ lists it
  d = ueRun('api/openapi.yaml', 'openapi: 3.0.0', contractPlan);
  wr(d, `${RUN}/reviews/contract-proof/REPORT.md`, '# contract\n');
  wr(d, `${RUN}/reviews/contract-proof/validator.txt`, 'RESULT: UNSUPPORTED\nCONFIDENCE: low\nREASON: no changed contract file was recognized\n');
  expectMsg('UNSUPPORTED over a recognized OpenAPI file', 'api/openapi.yaml is a contract file this run changed', ueSubmit(d, 'contract', 'reviews/contract-proof/validator.txt'));
  wr(d, `${RUN}/reviews/contract-proof/validator.txt`, 'RESULT: UNSUPPORTED\nFILE: compared api/openapi.yaml\n');
  expectMsg('UNSUPPORTED with every file compared', 'lists every contract file as compared', ueSubmit(d, 'contract', 'reviews/contract-proof/validator.txt'));
  // migration without a throwaway database: data-design's validator says UNSUPPORTED and lists the file
  d = ueRun('db/migrations/002_add.sql', 'alter table t add column x int;', lines('', '## Data', '', 'destructive: no'));
  wr(d, `${RUN}/reviews/data-migration/REPORT.md`, `${lines('# Migration validation: LC', '', 'status: UNSUPPORTED', '', '## Capability', 'throwaway_db: no', 'reason: no test helper creates a temporary database', 'down_migration: no', '',
    '## Migrations', '| file | applied | destructive | note |', '|---|---|---|---|', '| db/migrations/002_add.sql | no | no | additive |', '', '## Checks', '| id | class | result | evidence |', '|---|---|---|---|',
    '| schema_diff | judged | unsupported | no throwaway database |', '| rollback | judged | unsupported | no throwaway database |', '| data_preservation | judged | unsupported | no throwaway database |',
    '| lock_risk | judged | pass | add column without default |', '| long_running | judged | pass | no backfill |', '| patterns | traced | pass | scan: no hazard |', '| mixed_version | judged | pass | additive only |')}\n`);
  wr(d, `${RUN}/reviews/data-migration/validator.txt`, node(d, [`${SKD}/data-design/scripts/validate-migration.mjs`, `${RUN}/reviews/data-migration/REPORT.md`, '--repo', '.']));
  const mv = rd(d, `${RUN}/reviews/data-migration/validator.txt`);
  assert.ok(mv.split('\n').includes('RESULT: UNSUPPORTED') && mv.split('\n').includes('FILE: unsupported db/migrations/002_add.sql'), `validate-migration output: ${mv}`);
  wr(d, `${RUN}/reviews/data-migration/nofile.txt`, mv.split('\n').filter((l) => !l.startsWith('FILE: ')).join('\n'));
  expectMsg('a changed .sql migration missing from the evidence', 'the changed migration db/migrations/002_add.sql is not listed', ueSubmit(d, 'migration', 'reviews/data-migration/nofile.txt'));
  wr(d, `${RUN}/reviews/data-migration/norepo.txt`, `WARN no --repo: self-attested\n${mv}`);
  expectMsg('validate-migration output without --repo', 'without --repo', ueSubmit(d, 'migration', 'reviews/data-migration/norepo.txt'));
  const ms = ueSubmit(d, 'migration', 'reviews/data-migration/validator.txt');
  assert.ok(ms.status === 0 && ms.out.includes('submitted: LC reviewer UNSUPPORTED gate=REVIEW_DATA'), `genuine migration evidence refused: ${ms.text}`);
});

// A161 (#128): evidence a validator wrote against the base BEFORE an accepted control-plane-only move still counts; a chain of two moves too; an unrelated base never does.
// (The migration validator prints no BASE line, so only contract evidence is bound to one.)
test('sc_unsupported_evidence_base_move: a base before one or two accepted control-plane-only moves counts; an unrelated base is refused', { skip: SOURCES_SKIP }, () => {
  const d = ueRun('docs/API.md', '# API: GET /items returns a list.', lines('', '## Risk', '', 'contract_change: yes'));
  const b = rv(d, 'repository', 'base_sha'); mkdirSync(path.join(d, RUN, 'scratch'), { recursive: true });
  wr(d, `${RUN}/reviews/contract-proof/REPORT.md`, '# contract\n\nNo machine-readable contract; docs/API.md is prose.\n');
  node(d, [`${SKD}/contract-proof/scripts/diff-contract.mjs`, '--repo', '.', '--base', b, '--out', `${RUN}/scratch/contract.json`]);
  wr(d, `${RUN}/reviews/contract-proof/validator.txt`, node(d, [`${SKD}/contract-proof/scripts/validate-contract.mjs`, `${RUN}/scratch/contract.json`, '--repo', '.', '--base', b]));
  const vt = rd(d, `${RUN}/reviews/contract-proof/validator.txt`);
  assert.ok(vt.split('\n').includes(`BASE: ${b}`), `validator output: ${vt}`);
  wr(d, `${RUN}/reviews/contract-proof/other-base.txt`, vt.replace(/^BASE: .*/gm, 'BASE: 0000000000000000000000000000000000000000'));
  ueMove(d, 1);
  assert.notEqual(rv(d, 'repository', 'base_sha'), b, 'the accepted move did not update base_sha');
  let out = ueSubmit(d, 'contract', 'reviews/contract-proof/validator.txt');
  assert.equal(out.status, 0, `evidence naming the base before one accepted move refused: ${out.text}`);
  assert.ok(out.text.includes('submitted:'), `no submission: ${out.text}`);
  ueMove(d, 2);
  out = ueSubmit(d, 'contract', 'reviews/contract-proof/validator.txt');
  assert.equal(out.status, 0, `evidence naming the base before a chain of two moves refused: ${out.text}`);
  assert.ok(out.text.includes('submitted:'), `no submission after two moves: ${out.text}`);
  expectMsg('an unrelated base after moves', "not the run's base", ueSubmit(d, 'contract', 'reviews/contract-proof/other-base.txt'));
  // a base that was never the run's base, though a real commit of this repository, is refused as well
  const sd = git(d, ['commit-tree', git(d, ['write-tree']), '-p', b, '-m', 'side']);
  assert.match(sd, /^[0-9a-f]{40}$/, 'no side commit');
  wr(d, `${RUN}/reviews/contract-proof/other-real.txt`, vt.replace(/^BASE: .*/gm, `BASE: ${sd}`));
  expectMsg('a real commit that is not in the chain', "not the run's base", ueSubmit(d, 'contract', 'reviews/contract-proof/other-real.txt'));
  const fk = '1111111111111111111111111111111111111111';
  accepted(A(d, ['ledger-note', 'LC', `event=base-moved role=lead from=- to=- digest=x ts=x epoch=1 detail=base_sha moved (${fk} -> ${rv(d, 'repository', 'base_sha')})`]), 'ledger-note');
  wr(d, `${RUN}/reviews/contract-proof/forged.txt`, vt.replace(/^BASE: .*/gm, `BASE: ${fk}`));
  expectMsg('a base linked only by a forged ledger-note', "not the run's base", ueSubmit(d, 'contract', 'reviews/contract-proof/forged.txt'));
});

// A102: concurrency (and config) always have a tool-free check, so UNSUPPORTED is refused.
test('sc_unsupported_toolfree: refused for concurrency, which always has a tool-free check', () => {
  const d = rrun('COMPLEX', 'src/worker.go', lines('', '## Risk', '', 'concurrency: yes')); frozen(d); implement(d, 'src/worker.go', 'package x');
  wr(d, `${RUN}/reviews/concurrency-proof/REPORT.md`, '# c\n'); wr(d, `${RUN}/reviews/concurrency-proof/validator.txt`, 'RESULT: UNSUPPORTED\n');
  expectMsg('UNSUPPORTED concurrency', 'the concurrency focus always has a tool-free check', ueSubmit(d, 'concurrency', 'reviews/concurrency-proof/validator.txt'));
});

// A188: the project browser-test probe is data (browser_test of ecosystems.json), not a package.json branch: a custom ecosystem entry is honoured
test('sc_unsupported_browser_data: unsupported probes: browser_test is read from the ecosystem data; a custom entry is honoured, an uninstalled one is not', { skip: NO_BROWSER_SKIP }, () => {
  const d = unsRun();
  const r = 'no headless browser installed in the project';
  const excl = path.join(d, '.git/info/exclude');
  // the shipped npm entry still works through the same reader
  appendFileSync(excl, 'package.json\nnode_modules/\n');
  wr(d, 'package.json', '{"devDependencies":{"playwright":"1"}}\n'); mkdirSync(path.join(d, 'node_modules/playwright'), { recursive: true });
  expectMsg('npm browser_test entry: declared and installed', 'project browser-test dependency playwright (package.json, node_modules)', unsVisual(d, r));
  rmSync(path.join(d, 'package.json'), { force: true }); rmSync(path.join(d, 'node_modules'), { recursive: true, force: true });
  // a manifest the shipped data does not know: nothing is found until the data names it
  appendFileSync(excl, 'zig.json\nzigdeps/\npackage.json\nnode_modules/\n');   // ignored files are not task-introduced paths
  wr(d, 'zig.json', '{"deps":["zigdrive"]}\n'); mkdirSync(path.join(d, 'zigdeps/zigdrive'), { recursive: true });
  let out = unsVisual(d, r);
  assert.ok(out.status === 0 && out.out.includes('submitted: LC qa UNSUPPORTED'), `an unknown manifest was probed without data: ${out.text}`);
  const defn = JSON.parse(readFileSync(path.join(d, '.agents/ecosystems.json'), 'utf8'));
  defn.ecosystems.push({ id: 'zig', browser_test: { manifest: 'zig.json', deps_dir: 'zigdeps', names: ['zigdrive'] } });
  writeFileSync(path.join(d, '.agents/ecosystems.json'), JSON.stringify(defn, null, 2));
  expectMsg('a custom browser_test entry in the data', 'project browser-test dependency zigdrive (zig.json, zigdeps)', unsVisual(d, r));
  rmSync(path.join(d, 'zigdeps/zigdrive'), { recursive: true, force: true });
  out = unsVisual(d, r);
  assert.ok(out.status === 0 && out.out.includes('submitted: LC qa UNSUPPORTED'), `a declared but not installed dependency refused UNSUPPORTED: ${out.text}`);
});

// A102: capability probes refuse an UNSUPPORTED whose capability is present (a browser on PATH, a project benchmark script); an INCONCLUSIVE must keep its prefix
// and an UNSUPPORTED must not borrow one; only the submitting role's own files are evidence.
test("sc_unsupported_probes: a browser or a bench script refuses UNSUPPORTED; INCONCLUSIVE keeps its prefix both ways; another role's file is refused", { skip: NO_BROWSER_SKIP || (process.platform === 'win32' ? 'open Windows product defect (A263): probeVisual splits PATH on ":", which cuts the drive letter, and looks only for extension-less chrome names, so the planted browser is not seen' : false) }, () => {
  const d = unsRun();
  const chrome = path.join(probeBin, 'google-chrome');
  writeFileSync(chrome, '#!/bin/sh\n'); chmodSync(chrome, 0o755);
  try {
    expectMsg('visual UNSUPPORTED with a browser on PATH', 'capability present: browser', unsVisual(d, 'no headless browser installed in the project'));
    // a measured INCONCLUSIVE had the browser: the probe does not refuse it
    const inc = unsVisual(d, 'visual INCONCLUSIVE: two identical captures differ by 4% of pixels');
    assert.ok(inc.status === 0 && inc.out.includes('submitted: LC qa FAIL gate=QA'), `INCONCLUSIVE refused by the probe: ${inc.text}`);
  } finally { rmSync(chrome, { force: true }); }
  unsReport(d, 'INCONCLUSIVE');
  expectMsg('an INCONCLUSIVE downgraded to UNSUPPORTED', "must start 'visual INCONCLUSIVE:'", AS(d, 'qa', ['submit', 'LC', '--focus', 'visual', '--result', 'UNSUPPORTED', '--reason', 'no headless browser installed', '--confidence', 'high', '--artifact', 'reviews/visual-proof/REPORT.md', '--evidence', 'reviews/visual-proof/validator.txt']));
  unsReport(d);
  expectMsg('an UNSUPPORTED dressed as INCONCLUSIVE', 'records UNSUPPORTED', AS(d, 'qa', ['submit', 'LC', '--focus', 'visual', '--result', 'UNSUPPORTED', '--reason', 'visual INCONCLUSIVE: nothing measured', '--confidence', 'high', '--artifact', 'reviews/visual-proof/REPORT.md', '--evidence', 'reviews/visual-proof/validator.txt']));
  const ok = unsVisual(d, 'no headless browser installed in the project');
  assert.ok(ok.status === 0 && ok.out.includes('submitted: LC qa UNSUPPORTED gate=QA'), `visual UNSUPPORTED without a browser refused: ${ok.text}`);
  // performance: a project bench script is a benchmark command
  /** @param {string} pkg */
  const pfRun = (pkg) => {   // a frozen run flagged performance_critical whose base holds that package.json
    const p = rrun('COMPLEX', 'src/search.js', lines('', '## Risk', '', 'performance_critical: yes'));
    wr(p, 'package.json', `${pkg}\n`); git(p, ['add', 'package.json']); git(p, ['commit', '-q', '-m', 'project package.json']); rebase(p);
    frozen(p); implement(p, 'src/search.js', 'export const search = () => [];');
    wr(p, `${RUN}/reviews/performance-proof/REPORT.md`, '# perf\n');
    wr(p, `${RUN}/reviews/performance-proof/validator.txt`, 'valid: UNSUPPORTED\nresult: UNSUPPORTED\nreason: performance UNSUPPORTED: no benchmark command; never a PASS; add one\n');
    return p;
  };
  /** @param {string} p @param {string} reason @param {string} [evidence] */
  const pfSub = (p, reason, evidence = 'reviews/performance-proof/validator.txt') => AS(p, 'reviewer', ['submit', 'LC', '--focus', 'performance', '--result', 'UNSUPPORTED', '--reason', reason, '--confidence', 'low', '--artifact', 'reviews/performance-proof/REPORT.md', '--evidence', evidence]);
  let p = pfRun('{ "name": "x", "scripts": { "test": "node --test", "bench": "node bench.js" } }');
  expectMsg('performance UNSUPPORTED with a bench script', 'capability present: package.json script', pfSub(p, 'performance UNSUPPORTED: no benchmark command in the project'));
  wr(p, `${RUN}/reviews/performance-proof/validator.txt`, 'valid: INCONCLUSIVE\nresult: UNSUPPORTED\nreason: performance INCONCLUSIVE: M1 noise 30%; not a FAIL; re-run\n');
  expectMsg('a performance INCONCLUSIVE downgraded', "must start 'performance INCONCLUSIVE:'", pfSub(p, 'performance UNSUPPORTED: no benchmark command in the project'));
  p = pfRun('{ "name": "x", "scripts": { "test": "node --test" } }');
  // another role's file is not this role's evidence
  wr(p, `${RUN}/reports/snapshots/aaaaaaaaaaaa-qa-validator.txt`, rd(p, `${RUN}/reviews/performance-proof/validator.txt`));
  expectMsg("another role's snapshot as evidence", "must be the reviewer role's own file", pfSub(p, 'performance UNSUPPORTED: no benchmark command in the project', 'reports/snapshots/aaaaaaaaaaaa-qa-validator.txt'));
  const po = pfSub(p, 'performance UNSUPPORTED: no benchmark command in the project');
  assert.ok(po.status === 0 && po.out.includes('submitted: LC reviewer UNSUPPORTED gate='), `performance UNSUPPORTED without a benchmark refused: ${po.text}`);
});

// A173: the benchmark probe reads the ecosystem definition: BenchmarkDotNet is found in any project of any depth, in the 55th of 60 projects and in an fsproj (the old
// probe looked at the first 50 *.csproj only), so an UNSUPPORTED performance result is refused; 60 projects without it leave UNSUPPORTED allowed.
test('sc_probe_benchmark_dotnet: BenchmarkDotNet in project 55 of 60 and in an fsproj refuses UNSUPPORTED; 60 projects without it do not', () => {
  const BENCH = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="BenchmarkDotNet" Version="0.14.0" /></ItemGroup></Project>\n';
  /** @param {(d: string) => void} setup a frozen run flagged performance_critical whose base holds the project files that function writes */
  const bmRun = (setup) => {
    const d = rrun('COMPLEX', 'src/search.js', lines('', '## Risk', '', 'performance_critical: yes'));
    setup(d); commitAll(d, 'projects'); rebase(d);
    frozen(d); implement(d, 'src/search.js', 'export const search = () => [];');
    wr(d, `${RUN}/reviews/performance-proof/REPORT.md`, '# perf\n');
    wr(d, `${RUN}/reviews/performance-proof/validator.txt`, 'valid: UNSUPPORTED\nresult: UNSUPPORTED\nreason: performance UNSUPPORTED: no benchmark command; never a PASS; add one\n');
    return d;
  };
  const bmSub = (/** @type {string} */ d) => AS(d, 'reviewer', ['submit', 'LC', '--focus', 'performance', '--result', 'UNSUPPORTED', '--reason', 'performance UNSUPPORTED: no benchmark command in the project', '--confidence', 'low', '--artifact', 'reviews/performance-proof/REPORT.md', '--evidence', 'reviews/performance-proof/validator.txt']);
  /** 60 projects; `which` is the number of the one that references BenchmarkDotNet (0: none) @param {number} which */
  const bmSixty = (which) => (/** @type {string} */ d) => {
    for (let i = 1; i <= 60; i++) { const n = `P${String(i).padStart(2, '0')}`; wr(d, `src/${n}/${n}.csproj`, i === which ? BENCH : '<Project Sdk="Microsoft.NET.Sdk"></Project>\n'); }
  };
  let d = bmRun(bmSixty(55));
  expectMsg('performance UNSUPPORTED with BenchmarkDotNet in project 55 of 60', 'capability present: BenchmarkDotNet', bmSub(d));
  d = bmRun((x) => wr(x, 'tools/Bench/Bench.fsproj', BENCH));
  expectMsg('performance UNSUPPORTED with BenchmarkDotNet in an fsproj', 'capability present: BenchmarkDotNet', bmSub(d));
  d = bmRun(bmSixty(0));
  const out = bmSub(d);
  assert.ok(out.status === 0 && out.out.includes('submitted: LC reviewer UNSUPPORTED gate='), `performance UNSUPPORTED with 60 projects and no benchmark refused: ${out.text}`);
});

// Drift guard (A102): the visual probe's browser and tool lists equal visual-proof's measure.mjs.
test("sc_probe_drift: visual probe lists equal measure.mjs's", { skip: SKD && existsSync(path.join(SKD, 'visual-proof/scripts/measure.mjs')) ? false : 'skill source not present' }, () => {
  const m = readFileSync(path.join(SKD, 'visual-proof/scripts/measure.mjs'), 'utf8');
  const probes = readFileSync(path.join(scripts, 'core/probes.mjs'), 'utf8');
  const eco = flattenDefinition(JSON.parse(readFileSync(path.join(agentsSrc, 'ecosystems.json'), 'utf8')));
  const names = [];
  for (const re of [/^const BROWSER_NAMES = \[(.*)\];$/m, /^const PROJECT_TOOLS = \[(.*)\];$/m]) {
    const got = re.exec(m)?.[1];
    assert.ok(got !== undefined, `measure.mjs lacks ${re.source}`);   // strengthened: the shell loop was vacuous when a list moved
    names.push(...got.replace(/[",]/g, '').split(/\s+/).filter(Boolean));
  }
  assert.ok(names.length >= 9, 'no names read from measure.mjs');
  for (const n of names) {
    // a browser name is listed in the probe itself; a project test tool is DATA the probe reads (ecosystems.json browser_test.names, A185)
    assert.ok(probes.includes(n) || eco.some((r) => r[1] === 'browser_test.names' && r[2] === n), `core/probes.mjs and ecosystems.json browser_test.names lack ${n} from measure.mjs`);
  }
});
