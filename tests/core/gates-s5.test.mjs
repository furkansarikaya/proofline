// @ts-check
// Slice S5 of the retired gates-test.sh as native Node tests (176-D1, tests/legacy-port-map.tsv): the design-sync, validation (A162) and evidence-gap (A107)
// scenarios. A PASS is never silent (Core invariants 1 and 2): a fabricated report, a cited file altered after hashing, a command that no longer reproduces,
// an unplanned command and a missing validator run all end in a FAIL or a refusal. Every assertion, attack input and message of the shell scenarios is kept.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, accepted, cleanEnv, expectMsg, newRepo, repo, tsha } from '../lib/harness.mjs';
import { project } from '../lib/harness.mjs';
import { EV_INV, EV_VAL, RUN, amendPlan, evScaffold, evidenceGapFixture, get, grepTree, implemented, put, qaBind, vw, vwc } from './gates-s5-lib.mjs';

const P = /** @type {any} */ (await import('../../skills/plan-contract/scripts/validate-plan.mjs'));
const Q = /** @type {any} */ (await import('../../skills/qa-plan/scripts/validate-qa.mjs'));
/** @param {string} dir @param {string[]} args */
const node = (dir, args) => { const r = spawnSync('node', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8' }); return `${r.stdout}${r.stderr}`; };
/** submit as the verifier. @param {string} dir @param {string[]} rest */
const vsub = (dir, rest) => AS(dir, 'verifier', ['submit', 'LC', '--confidence', 'high', ...rest]);
/** a submit that must be accepted: its text. @param {string} dir @param {string[]} rest @param {string} what */
const vok = (dir, rest, what) => accepted(vsub(dir, rest), what).text;

test('sc_design_sync: a contract change needs design/SYNC.md or a design-sync SKIPPED line on the record', () => {
  const d = project({ topology: 'orchestrated', cls: 'STANDARD', planExtra: '\n## Contracts\n\n- `GET /api/books` gains `tags`\n\n## Validation\n\n- `GET /api/books`: accepts no body and an optional limit query; limits limit 1-100; rejected at the list handler (400)',
    qaExtra: '- QA-9 (AC-1) [invalid-input]: GET /api/books with limit 0\n  expected: 400' });
  implemented(d);
  put(d, 'docs/design/API.md', '# api\n'); appendFileSync(path.join(d, '.git/info/exclude'), 'docs/\n');
  put(d, `${RUN}/VERIFY.md`, '# VERIFY\n\nall criteria proven\n');
  expectMsg('a verification of a contract change without design/SYNC.md', 'design/SYNC.md', AS(d, 'verifier', ['submit', 'LC', '--confidence', 'high', '--agent', 'vs1']));
  put(d, `${RUN}/VERIFY.md`, '# VERIFY\n\nall criteria proven\ndesign-sync: SKIPPED (the document was read and needs no change)\n');
  const out = AS(d, 'verifier', ['submit', 'LC', '--confidence', 'high', '--agent', 'vs2']).text;
  assert.ok(!out.includes('design/SYNC.md'), `a recorded SKIPPED line was not accepted: ${out}`);
});

test('sc_validation_plan: an entry point in ## Contracts needs a complete ## Validation line at freeze; a removal, no entry point and code candidates never refuse', () => {
  const evC = '\n## Contracts\n\n- `POST /orders` creates an order';
  const evMsg = 'PLAN.md ## Contracts declares an entry point that takes external input, but ## Validation has no complete line for: POST /orders';
  const fz = (/** @type {string} */ d) => A(d, ['freeze', 'LC'], { bind: true });
  let d = evScaffold(evC, EV_INV);
  expectMsg('a new endpoint without a validation summary', evMsg, fz(d));
  assert.ok(/^validation\.entry_points=POST \/orders/m.test(A(d, ['pipeline', 'LC']).out), `pipeline lists no entry point: ${A(d, ['pipeline', 'LC']).out}`);
  d = evScaffold(`${evC}\n\n## Validation\n\n- \`POST /orders\`: accepts a JSON body; limits 1-50 items`, EV_INV);
  expectMsg('a validation line without rejected at', evMsg, fz(d));
  d = evScaffold(`${evC}\n\n## Validation\n\n${EV_VAL}`, EV_INV);
  accepted(fz(d), 'a plan with a complete validation line was refused');
  assert.ok(!/^validation.missing=/m.test(A(d, ['pipeline', 'LC']).out), 'pipeline reports missing validation for a complete plan');
  d = evScaffold('\n## Contracts\n\n- `POST /orders` is removed (the endpoint is gone)');
  accepted(fz(d), 'a bullet that removes the contract was treated as an entry point');
  d = evScaffold('');
  accepted(fz(d), 'an ordinary plan without entry points was refused');
  assert.ok(!/^validation\./m.test(A(d, ['pipeline', 'LC']).out), 'an ordinary plan prints validation rows');
  // code patterns are information only: a scope file that looks like a route never refuses the freeze
  d = evScaffold('');
  put(d, 'impl.txt', 'app.post("/orders", handler)\n');
  const out = accepted(fz(d), 'a code-pattern candidate refused the freeze').text;
  assert.ok(out.includes('information only'), `no information note for the candidate: ${out}`);
  assert.ok(/^validation.candidates=scope:impl.txt/m.test(A(d, ['pipeline', 'LC']).out), `pipeline lists no candidate: ${A(d, ['pipeline', 'LC']).out}`);
});

test('sc_validation_qa: a QA plan needs an [invalid-input] scenario naming each entry point; another entry point or category does not satisfy it', () => {
  const d = evScaffold(`\n## Contracts\n\n- \`POST /orders\` creates an order\n\n## Validation\n\n${EV_VAL}`);
  qaBind(d, 'LC');
  const evMsg = 'QA_PLAN.md has no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: POST /orders';
  expectMsg('verify-qa-plan without an invalid-input scenario', evMsg, A(d, ['verify-qa-plan', 'LC']));
  expectMsg('freeze without an invalid-input scenario', evMsg, A(d, ['freeze', 'LC'], { bind: true }));
  const keep = get(d, `${RUN}/QA_PLAN.md`);
  const withQa = (/** @type {string} */ add) => { put(d, `${RUN}/QA_PLAN.md`, keep + add); qaBind(d, 'LC'); };
  withQa('- QA-9 (AC-1) [invalid-input]: POST /refunds with 51 items\n  expected: 400\n');
  expectMsg('a scenario naming another entry point', evMsg, A(d, ['verify-qa-plan', 'LC']));
  withQa('- QA-9 (AC-1) [concurrency]: POST /orders twice\n  expected: one order\n');
  expectMsg('a scenario of another category', evMsg, A(d, ['verify-qa-plan', 'LC']));
  withQa('- QA-9 (AC-1) [invalid-input]: too many items\n  input: POST /orders with 51 items\n  expected: 400\n');
  accepted(A(d, ['verify-qa-plan', 'LC']), 'an input line naming the entry point was refused');
  withQa(`${EV_INV}\n`);
  accepted(A(d, ['verify-qa-plan', 'LC']), 'a title naming the entry point was refused');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze with plan line and scenario was refused');
});

test('sc_validation_refreeze: a refreeze enforces the validation line and the invalid-input scenario for a new entry point', () => {
  const evMsg = 'PLAN.md ## Contracts declares an entry point that takes external input, but ## Validation has no complete line for: POST /orders';
  let d = evScaffold('', EV_INV);
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze of a plan without entry points failed');
  amendPlan(d, '001', '\n## Contracts\n\n- `POST /orders` creates an order');
  expectMsg('a refreeze that adds an entry point without a validation line', evMsg, A(d, ['refreeze', 'LC', '001.md'], { bind: true }));
  appendFileSync(path.join(d, RUN, 'PLAN.md'), `\n## Validation\n\n${EV_VAL}\n`);
  accepted(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'a refreeze with a validation line and an invalid-input scenario was refused');
  // the QA plan of the refreeze needs the invalid-input scenario too
  d = evScaffold('', '');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze of a plan without entry points failed');
  amendPlan(d, '001', `\n## Contracts\n\n- \`POST /orders\` creates an order\n\n## Validation\n\n${EV_VAL}`);
  expectMsg('a refreeze without an invalid-input scenario', 'QA_PLAN.md has no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: POST /orders', A(d, ['refreeze', 'LC', '001.md'], { bind: true }));
});

test('sc_validation_node: the node validators agree with the control plane on the same plan and QA plan and share the default entry word list with the config', () => {
  const d = evScaffold('\n## Contracts\n\n- `POST /orders` creates an order', EV_INV);
  const vp0 = path.join(repo, 'skills/plan-contract/scripts/validate-plan.mjs'); const vq = path.join(repo, 'skills/qa-plan/scripts/validate-qa.mjs');
  qaBind(d, 'LC');
  let vp = node(d, [vp0, `${RUN}/PLAN.md`, `${RUN}/TASK.md`, '--class', 'STANDARD', '--repo', '.']);
  assert.ok(vp.includes('no complete line for the entry point(s) POST /orders'), `validate-plan.mjs disagrees with the control plane: ${vp}`);
  appendFileSync(path.join(d, RUN, 'PLAN.md'), `\n## Validation\n\n${EV_VAL}\n`);
  vp = node(d, [vp0, `${RUN}/PLAN.md`, `${RUN}/TASK.md`, '--class', 'STANDARD', '--repo', '.']);
  assert.ok(!vp.includes('no complete line'), `validate-plan.mjs refuses a complete line: ${vp}`);
  assert.ok(!/^validation.missing=/m.test(A(d, ['pipeline', 'LC']).out), 'the control plane refuses a complete line');
  const full = get(d, `${RUN}/QA_PLAN.md`);
  put(d, `${RUN}/QA_PLAN.md`, full.split('\n').filter((l) => !/invalid-input|^ {2}input: a body|^ {2}expected: 400/.test(l)).join('\n'));
  qaBind(d, 'LC');
  assert.ok(node(d, [vq, 'plan', `${RUN}/QA_PLAN.md`, '--plan', `${RUN}/PLAN.md`]).includes('invalid-input scenario for the entry point POST /orders'), 'validate-qa.mjs accepts a QA plan without the scenario');
  expectMsg('the control plane on the same QA plan', 'no invalid-input scenario for the entry point(s)', A(d, ['verify-qa-plan', 'LC']));
  // the default word list is one value in the config, validate-plan.mjs and validate-qa.mjs
  const cw = A(d, ['config-get', 'validation.entry_words']).out.replace(/\n+$/, '');
  assert.ok(cw !== '', 'config has no validation.entry_words');
  assert.equal(P.ENTRY_WORDS, cw, 'ENTRY_WORDS of validate-plan.mjs differs from config validation.entry_words');
  assert.equal(Q.ENTRY_WORDS, cw, 'ENTRY_WORDS of validate-qa.mjs differs from config validation.entry_words');
});

test('sc_validation_tiers: reviewed false positives are never mandatory, the two positives are, and the corpus agrees (core, validate-plan, validate-qa)', () => {
  const d = newRepo();
  const fp = ['`order.schema.json` 3 -> 4 - consumers: billing', '`PLAN.md` frontmatter gains `validation` - consumers: validate-plan.mjs', '`events.proto` field added - consumers: billing',
    'The consumer of this API is the CLI', 'The handler returns 404 for unknown ids', 'Form fields documented in docs/forms.md', 'The routes table in README updated',
    '`schema.graphql` Query.users gains limit', '`GET /api/books` response shape unchanged', 'Book response (`GET /api/books`) omits legacyNotes'];
  for (const b of fp) assert.notEqual(A(d, ['entry-tier', b]).out.replace(/\n+$/, ''), 'mandatory', `a false positive is mandatory: ${b}`);
  assert.equal(A(d, ['entry-tier', 'POST /orders no longer accepts qty above 100']).out.replace(/\n+$/, ''), 'mandatory', 'a changed input limit is not mandatory');
  assert.equal(A(d, ['entry-tier', 'DELETE /x is added: removes an item']).out.replace(/\n+$/, ''), 'mandatory', 'a new endpoint is not mandatory');
  // the labelled corpus (tests/fixtures/entry-points/corpus.tsv): the core and both validators give the label
  const names = /** @type {Record<string, string>} */ ({ mandatory: 'M', information: 'I', none: 'N', '': 'N' });
  const bad = []; let n = 0;
  for (const line of readFileSync(path.join(repo, 'tests/fixtures/entry-points/corpus.tsv'), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [label, body] = line.split('\t'); n++;
    const got = names[A(d, ['entry-tier', body]).out.trim()];
    const js = names[P.entryTier(body)]; const jq = names[Q.entryTier(body)];
    if (got !== js || got !== jq) bad.push(`DISAGREE core=${got} plan=${js} qa=${jq}: ${body}`);
    if (got !== label) bad.push(`LABEL ${label} got ${got}: ${body}`);
  }
  assert.ok(n > 0, 'the corpus is empty');
  assert.deepEqual(bad, [], 'entry-point corpus');
});

test('sc_validation_info_only: information-only bullets never refuse the freeze; a backslash entry name matches its QA scenario and is missed without one', () => {
  let d = evScaffold('\n## Contracts\n\n- `order.schema.json` 3 -> 4 - consumers: billing\n- The handler returns 404 for unknown ids\n- `GET /api/books` response shape unchanged', '');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'a plan with information-only bullets was refused');
  assert.ok(!/^validation.missing=/m.test(A(d, ['pipeline', 'LC']).out), 'information-only bullets are reported missing');
  assert.ok(/^validation.possible=/m.test(A(d, ['pipeline', 'LC']).out), `no validation.possible row for information-only bullets: ${A(d, ['pipeline', 'LC']).out}`);
  const plan = '\n## Contracts\n\n- `GET /u/\\d+` takes a query parameter\n\n## Validation\n\n- `GET /u/\\d+`: accepts a numeric id; limits 1-10 digits; rejected at the user handler (400)';
  d = evScaffold(plan, '- QA-9 (AC-1) [invalid-input]: GET /u/\\d+ with letters\n  input: an id of letters\n  expected: 400');
  assert.ok(A(d, ['pipeline', 'LC']).out.includes('validation.entry_points=GET /u/\\d+'), `a backslash entry name was mangled: ${A(d, ['pipeline', 'LC']).out}`);
  qaBind(d, 'LC');
  accepted(A(d, ['verify-qa-plan', 'LC']), 'a QA scenario naming a backslash entry point was refused');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze with a backslash entry point was refused');
  d = evScaffold(plan, '');
  qaBind(d, 'LC');
  expectMsg('a QA plan without a scenario for a backslash entry point', 'no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: GET /u/\\d+', A(d, ['verify-qa-plan', 'LC']));
});

test('sc_validation_config: config-check rejects an invalid validation regex and an unknown validation key', () => {
  const d = newRepo();
  accepted(A(d, ['config-check']), 'config-check of the shipped config');
  const cfg = get(d, '.agents/config.yaml'); const bad = path.join(d, 'bad.yaml');
  writeFileSync(bad, cfg.split('\n').map((l) => (/^ {2}entry_words: /.test(l) ? '  entry_words: "(["' : l)).join('\n'));
  expectMsg('config-check accepted an invalid entry_words regex', 'invalid regular expression for validation.entry_words', A(d, ['config-check', bad]));
  writeFileSync(bad, cfg.split('\n').map((l) => (/^ {2}code_patterns: /.test(l) ? '  code_patterns: "*("' : l)).join('\n'));
  expectMsg('config-check accepted an invalid code_patterns regex', 'invalid regular expression for validation.code_patterns', A(d, ['config-check', bad]));
  assert.ok(/^validation:/m.test(cfg), 'the config has no validation block');
  writeFileSync(bad, cfg.split('\n').flatMap((l) => (/^validation:/.test(l) ? [l, '  surprise: 1'] : [l])).join('\n'));
  expectMsg('config-check accepted an unknown validation key', 'unknown validation key: validation.surprise', A(d, ['config-check', bad]));
});

test('sc_evidence_gap_fabricated: a fabricated but internally consistent VERIFY.md is re-derived and rejected; a declared validator result is never trusted', () => {
  const d = evidenceGapFixture();
  // an honest, self-consistent report is accepted and recorded PASS (the command really prints that line)
  vw(d, 'PASS', 0, 'ok 3 tests', 'PASS');
  let out = vok(d, ['--findings', 'none', '--agent', 'eg0'], 'an honest report was refused');
  assert.ok(out.includes('submitted: LC verifier PASS'), `an honest report was not recorded PASS: ${out}`);
  // the declared validator result is never trusted: the validator recomputes it and a mismatch names both
  vw(d, 'PASS', 0, 'ok 3 tests', 'PASS');
  expectMsg('a declared validator FAIL over a recomputed PASS', 'declared FAIL, recomputed PASS', vsub(d, ['--validator-result', 'FAIL', '--findings', 'none', '--agent', 'eg2']));
  vw(d, 'FAIL', 1, 'ok 3 tests', 'FAIL');
  expectMsg('a declared validator PASS over a recomputed FAIL', 'declared PASS, recomputed FAIL', vsub(d, ['--validator-result', 'PASS', '--findings', 'none', '--agent', 'eg1']));
  expectMsg('a PASS with no blocking finding over a recomputed FAIL', 'declared PASS (no blocking finding), recomputed FAIL', vsub(d, ['--findings', 'none', '--agent', 'eg1b']));
  // a fabricated report: every row consistent, the validator says valid and PASS, but the command does not print the recorded line. The control plane re-runs it
  vw(d, 'PASS', 0, 'ok 412 tests, 0 failed', 'PASS');
  out = vok(d, ['--validator-result', 'PASS', '--findings', 'none', '--agent', 'eg3'], 'the fabricated report was refused instead of recorded FAIL');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `a fabricated but self-consistent report passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'does not reproduce'), 'no blocking finding names the reproduction mismatch');
});

test('sc_evidence_gap_files: a cited evidence file that is missing, altered after hashing or outside the role\'s folders refuses the submission', () => {
  const d = evidenceGapFixture();
  vw(d, 'PASS', 0, 'ok 3 tests', 'PASS');
  put(d, `${RUN}/reports/measure.txt`, 'measured: 4 files\n');
  const want = tsha(path.join(d, RUN, 'reports/measure.txt'));
  vok(d, ['--findings', 'none', '--evidence', `reports/measure.txt@${want}`, '--agent', 'ef0'], 'a cited, unchanged evidence file was refused');
  assert.ok(grepTree(d, `${RUN}/results`, new RegExp(`^EVIDENCE: reports/measure.txt ${want}`, 'm')), 'the cited evidence is not on the recorded result');
  // modified after it was hashed
  put(d, `${RUN}/reports/measure.txt`, 'measured: 40000 files\n');
  expectMsg('an evidence file modified after hashing', 'modified after it was hashed', vsub(d, ['--findings', 'none', '--evidence', `reports/measure.txt@${want}`, '--agent', 'ef1']));
  // cited inside a finding row's evidence column
  const rows = path.join(d, 'rows.eg'); writeFileSync(rows, `info|-|note|see reports/measure.txt@${want}\n`);
  expectMsg('a row citing a modified evidence file', 'modified after it was hashed', vsub(d, ['--findings', rows, '--agent', 'ef2']));
  // missing
  rmSync(path.join(d, RUN, 'reports/measure.txt'));
  expectMsg('a missing evidence file', 'cited evidence file not found', vsub(d, ['--findings', 'none', '--evidence', `reports/measure.txt@${want}`, '--agent', 'ef3']));
  expectMsg('a missing evidence file cited without a hash', 'not found', vsub(d, ['--findings', 'none', '--evidence', 'reports/nope.txt', '--agent', 'ef4']));
  // outside the folders the role reports in
  expectMsg('an evidence file outside the role\'s folders', 'outside the folders', vsub(d, ['--findings', 'none', '--evidence', `TASK.md@${tsha(path.join(d, RUN, 'TASK.md'))}`, '--agent', 'ef5']));
});

test('sc_evidence_gap_rerun: the verifier path re-runs a recorded reproduced command; a differing result is FAIL, an unplanned command is never run', () => {
  const d = evidenceGapFixture();
  // the report was true when written; the command now gives a different result than the one recorded
  vw(d, 'PASS', 0, 'ok 3 tests', 'PASS');
  put(d, '.agents/local/check.sh', 'echo ok 2 tests, 1 failed\nexit 1\n');
  let out = vok(d, ['--findings', 'none', '--agent', 'er1'], 'a non-reproducing report was refused instead of recorded FAIL');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `reproduced evidence that no longer reproduces passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 're-running `sh .agents/local/check.sh` gave exit=1, the report records exit=0'), 'no blocking finding names the mismatch');
  // a command that is neither configured nor planned is never executed: a report cannot make the control plane run it
  put(d, '.agents/local/other.sh', 'touch .agents/local/ran-unplanned\n');
  put(d, `${RUN}/VERIFY.md`, ['# Verification: LC', '', '## Commands', '', '- `sh .agents/local/other.sh` | exit=0', '  output: done', '', '## AC coverage', '', '| AC | test or command | status | evidence |', '|---|---|---|---|',
    '| AC-1 | impl_test.txt::lookup | PASS | `sh .agents/local/other.sh` exit=0 |', '', '## Scope', '', 'verify-scope: exit=0', '', '## Design sync', '', 'design-sync: SKIPPED (none)', '', '## Runtime', '', 'runtime: none (no runtime in this test)', '',
    '## Pre-existing failures', '', 'None', '', '## Failures', '', 'None', '', 'Verdict: PASS', ''].join('\n'));
  out = vok(d, ['--findings', 'none', '--agent', 'er2'], 'unplanned command report refused');
  assert.ok(!existsSync(path.join(d, '.agents/local/ran-unplanned')), 'the control plane executed a command that is neither configured nor in the plan');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `a PASS whose only command could not be re-run was accepted: ${out}`);
});

test('sc_evidence_gap_gates: a PASS is never silent: NOT_RERUN field, nothing re-runnable is FAIL, a missing validator run refuses a mapped focus', () => {
  const d = evidenceGapFixture();
  // R1-1: a PASS gate with nothing re-runnable is never silent: judgment-only gates record NOT_RERUN
  put(d, `${RUN}/reviews/proof-review/small/REPORT.md`, '# small review\n\nthe change was read.\n');
  const out1 = AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--findings', 'none', '--agent', 'g1']).text;
  const gdir = path.join(d, RUN, 'gates');
  const gf = path.join(gdir, readdirSync(gdir).filter((n) => n.endsWith('REVIEW_SMALL.yaml')).sort().at(-1) ?? 'none');
  const gtxt = readFileSync(gf, 'utf8');
  assert.ok(gtxt.includes('\nnot_rerun: "REVIEW_SMALL:rules+tests no reproduced evidence; this gate is not reproduced proof"') || gtxt.startsWith('not_rerun: "REVIEW_SMALL:rules+tests no reproduced evidence; this gate is not reproduced proof"'), `a PASS with nothing to re-run left no not_rerun field: ${out1}`);
  // A130: the marker is a gate field, never a findings row: a clean gate has no finding at all
  assert.ok(!/^finding:.*NOT_RERUN/m.test(gtxt), `a gate that re-ran nothing carries a NOT_RERUN findings row: ${gtxt}`);
  assert.ok(!grepTree(d, `${RUN}/results`, /^\| .*NOT_RERUN/m), 'the result file carries a NOT_RERUN findings row');
  const pl = A(d, ['pipeline', 'LC']).out;
  assert.ok(/^not_rerun.REVIEW_SMALL:rules\+tests=NOT_RERUN \(not reproduced proof\): no reproduced evidence/m.test(pl), `pipeline prints no not_rerun line: ${pl}`);
  // a verifier PASS whose only commands are neither configured nor planned: blocking, nothing executed
  put(d, '.agents/local/other.sh', 'touch .agents/local/ran-unplanned\n');
  vw(d, 'PASS', 0, 'ok 3 tests', 'PASS');
  put(d, `${RUN}/VERIFY.md`, get(d, `${RUN}/VERIFY.md`).split('`sh .agents/local/check.sh`').join('`sh .agents/local/other.sh`'));
  const out = vok(d, ['--findings', 'none', '--agent', 'g2'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `nothing re-runnable passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'could be re-run'), 'no blocking finding says nothing was re-runnable');
  assert.ok(!existsSync(path.join(d, '.agents/local/ran-unplanned')), 'an unplanned command was executed');
  // R1-2: an installed skill whose validator cannot run makes a PASS of that focus a refusal, declared or not
  cpSync(path.join(repo, 'skills/proof-review'), path.join(d, '.agents/skills/proof-review'), { recursive: true });
  put(d, `${RUN}/reviews/proof-review/rules/REPORT.md`, '# rules review\n\nthe change was read.\n');
  expectMsg('a PASS of a mapped focus without its findings.json', 'no validator run for', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules', '--confidence', 'high', '--findings', 'none', '--agent', 'g3']));
  expectMsg('the same PASS with a declared validator result', 'no validator run for', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules', '--confidence', 'high', '--validator-result', 'PASS', '--findings', 'none', '--agent', 'g4']));
});

test('sc_evidence_gap_output: a command row needs a real output line that equals a whole re-run output line', () => {
  const d = evidenceGapFixture();
  // R1-3: a command row without an output line compares nothing: FAIL, never a pass
  put(d, `${RUN}/VERIFY.md`, ['# Verification: LC', '', '## Commands', '', '- `sh .agents/local/check.sh` | exit=0', '', '## AC coverage', '', '| AC | test or command | status | evidence |', '|---|---|---|---|',
    '| AC-1 | impl_test.txt::lookup | PASS | `sh .agents/local/check.sh` exit=0 |', '', '## Scope', '', 'verify-scope: exit=0', '', '## Design sync', '', 'design-sync: SKIPPED (none)', '', '## Runtime', '', 'runtime: none (no runtime in this test)', '',
    '## Pre-existing failures', '', 'None', '', '## Failures', '', 'None', '', 'Verdict: PASS', ''].join('\n'));
  let out = vok(d, ['--findings', 'none', '--agent', 'o1'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `a command without an output line passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'printed output but the report records none'), 'no blocking finding names the missing output line');
  // a bare substring of the real output is not a match: the recorded line must equal a whole output line
  vw(d, 'PASS', 0, 'ok', 'PASS');
  out = vok(d, ['--findings', 'none', '--agent', 'o2'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `a bare substring of the output passed: ${out}`);
  // a changed output line with the same exit status is a mismatch (the re-run is not satisfied by exit alone)
  vw(d, 'PASS', 0, 'ok 4 tests', 'PASS');
  out = vok(d, ['--findings', 'none', '--agent', 'o3'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `an output mismatch with equal exit passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'no output line equal to the recorded "ok 4 tests"'), 'no blocking finding names the output mismatch');
});

test('sc_evidence_gap_ac: a command cited as AC proof that cannot be re-run is a blocking finding, even beside an honest allowed command', () => {
  // R1-4: every command an AC row cites is re-run; one honest allowed command beside a fabricated one is FAIL
  const d = evidenceGapFixture({ exempt: true });
  put(d, `${RUN}/VERIFY.md`, ['# Verification: LC', '', '## Commands', '', '- `sh .agents/local/check.sh` | exit=0', '  output: ok 3 tests', '- `npm run e2e -- --suite all` | exit=0', '  output: e2e: 40 passed', '', '## AC coverage', '', '| AC | test or command | status | evidence |', '|---|---|---|---|',
    '| AC-1 | command: `npm run e2e -- --suite all` | PASS | `npm run e2e -- --suite all` exit=0 e2e: 40 passed |', '', '## Scope', '', 'verify-scope: exit=0', '', '## Design sync', '', 'design-sync: SKIPPED (none)', '', '## Runtime', '', 'runtime: none (no runtime in this test)', '',
    '## Pre-existing failures', '', 'None', '', '## Failures', '', 'None', '', 'Verdict: PASS', ''].join('\n'));
  const out = vok(d, ['--findings', 'none', '--agent', 'a1'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `a fabricated AC command passed beside an honest one: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'AC proof cites `npm run e2e -- --suite all`'), 'no blocking finding names the AC command');
});

test('sc_evidence_gap_r2: silent commands are listable, timing lines are refused with what to record, a run without its frozen plan hash is refused by the freeze check', () => {
  const d = evidenceGapFixture();
  const CK = '- `sh .agents/local/check.sh` | exit=0';
  // a silent command is listable: `output: (no output)` matches an empty re-run, the exit status decides
  vwc(d, 'PASS', 'PASS', [CK, '  output: ok 3 tests', '- `sh .agents/local/quiet.sh` | exit=0', '  output: (no output)']);
  let out = vok(d, ['--findings', 'none', '--agent', 'r1'], 'refused');
  assert.ok(out.includes('submitted: LC verifier PASS'), `a silent planned command with (no output) was not accepted: ${out}`);
  vwc(d, 'PASS', 'PASS', [CK, '  output: ok 3 tests', '- `sh .agents/local/quiet.sh` | exit=0', '  output: all good']);
  out = vok(d, ['--findings', 'none', '--agent', 'r1b'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `an invented output line of a silent command passed: ${out}`);
  // a non-empty re-run with `(no output)` recorded is a mismatch
  vwc(d, 'PASS', 'PASS', [CK, '  output: (no output)']);
  out = vok(d, ['--findings', 'none', '--agent', 'r2'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `(no output) over a printing command passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'printed output but the report records none'), 'no finding names the unrecorded output');
  // a time or duration in the recorded line is refused with what to record
  vwc(d, 'PASS', 'PASS', [CK, '  output: Ran 3 tests in 0.002s']);
  out = vok(d, ['--findings', 'none', '--agent', 'r3'], 'refused');
  assert.ok(out.includes('submitted: LC verifier FAIL'), `a timing line passed: ${out}`);
  assert.ok(grepTree(d, `${RUN}/results`, 'record one stable summary line'), 'the refusal does not say what to record');
  // a plan hash that is not 64 hex denies every PLAN command: nothing planned can be re-run
  vwc(d, 'PASS', 'PASS', [CK, '  output: ok 3 tests']);
  put(d, `${RUN}/RUN.yaml`, get(d, `${RUN}/RUN.yaml`).split('\n').map((l) => l.replace(/^ {2}plan_sha256: .*/, '  plan_sha256: PENDING')).join('\n'));
  out = vsub(d, ['--findings', 'none', '--agent', 'r4']).text;
  assert.ok(out.includes('freeze mismatch'), `a run without its frozen plan hash was not refused: ${out}`);
});

test('sc_evidence_gap_files_gate: an unallowed command in a judgment gate is NOT_RERUN, every triple of an evidence file is re-run', () => {
  const d = evidenceGapFixture();
  put(d, `${RUN}/reviews/proof-review/small/REPORT.md`, '# small review\n\nthe change was read.\n');
  // a judgment gate citing a command that is not configured or planned: ignored, never blocking, recorded NOT_RERUN
  put(d, `${RUN}/reports/perf.txt`, 'command: dotnet run -c Release\nexit: 0\noutput: ok 3 tests\n');
  const rsub = (/** @type {string[]} */ rest) => AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--findings', 'none', ...rest]);
  let out = accepted(rsub(['--evidence', 'reports/perf.txt', '--agent', 'f1']), 'refused').text;
  assert.ok(out.includes('submitted: LC reviewer PASS'), `an unallowed command in a judgment gate blocked it: ${out}`);
  const gdir = path.join(d, RUN, 'gates');
  const gf = path.join(gdir, readdirSync(gdir).filter((n) => n.endsWith('REVIEW_SMALL.yaml')).sort().at(-1) ?? 'none');
  assert.ok(/^not_rerun: /m.test(readFileSync(gf, 'utf8')), 'no not_rerun field for the ignored command');
  // every triple of an evidence file is re-run: a bad first triple is not hidden by a good last one
  put(d, `${RUN}/reports/two.txt`, 'command: sh .agents/local/check.sh\nexit: 5\noutput: ok 3 tests\ncommand: sh .agents/local/check.sh\nexit: 0\noutput: ok 3 tests\n');
  out = accepted(rsub(['--evidence', 'reports/two.txt', '--agent', 'f2']), 'refused').text;
  assert.ok(out.includes('submitted: LC reviewer FAIL'), `a failing first triple was hidden by the last one: ${out}`);
});
