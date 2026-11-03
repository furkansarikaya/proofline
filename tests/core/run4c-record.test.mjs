// @ts-check
// Stage 4, package 4C: `record` and `submit` (the result protocol) as absolute Node tests (A214). They replace the behaviour of gates-test.sh sc_record,
// sc_submit, sc_report_stdin, sc_stdin_contract, sc_report_names, sc_scan_method, sc_classification_stable and the record refusals of the other suites
// (tests/legacy-port-map.tsv). The fixture state is built by the self-test library; every asserted action is a call of the real Node core.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, project, read, refused } from './legacy-lib.mjs';

/** A scratch folder outside every project: a file inside the project would change its content fingerprint. */
const scratch = mkdtempSync(`${tmpdir()}/run4c-`);
let seq = 0;
const out = (/** @type {string} */ name) => `${scratch}/${++seq}-${name}`;
const sha = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const REPORT = /** @type {Record<string, string>} */ ({
  REVIEW_SMALL: 'reviews/proof-review/small/REPORT.md',
  REVIEW_TESTS: 'reviews/test-trust/tests/REPORT.md', SECURITY: 'security/REPORT.md', QA: 'QA_REPORT.md', VERIFY: 'VERIFY.md',
});
const OWNER = /** @type {Record<string, string>} */ ({ REVIEW_SMALL: 'reviewer', REVIEW_TESTS: 'reviewer', SECURITY: 'security_reviewer', QA: 'qa', VERIFY: 'verifier' });
const FOCUS = /** @type {Record<string, string>} */ ({ REVIEW_SMALL: 'rules+tests', REVIEW_TESTS: 'tests' });
const SCAN = 'traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single';

/**
 * Write a result document for a gate and return its path. `rows` are "id|severity|path:line|finding|evidence".
 * @param {string} d @param {string} gate @param {string} res @param {{ conf?: string, rows?: string[], head?: Record<string, string | null>, extra?: string, art?: string, report?: string }} [o]
 */
function result(d, gate, res, o = {}) {
  const art = o.art ?? REPORT[gate];
  const dir = `${d}/.agents/runs/LC`;
  if (art.includes('/')) mkdirSync(`${dir}/${art.replace(/\/[^/]*$/, '')}`, { recursive: true });
  if (!art.includes('/') || !existsSync(`${dir}/${art}`) || o.report !== undefined) writeFileSync(`${dir}/${art}`, o.report ?? `# ${gate} report\n\nVerdict: ${res}\n\nJudged the whole current tree.\n`);
  const fp = A(d, ['fingerprint', 'LC']).out.trim();
  const head = { ROLE: OWNER[gate], TASK: 'LC', FOCUS: FOCUS[gate] ?? null, RESULT: res, CONFIDENCE: o.conf ?? 'high', FINGERPRINT: fp, ARTIFACT: `${art} ${sha(readFileSync(`${dir}/${art}`, 'utf8'))}`, ...(o.head ?? {}) };
  let t = '';
  for (const [k, v] of Object.entries(head)) if (v !== null) t += `${k}: ${v}\n`;
  t += '\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n';
  for (const r of o.rows ?? []) t += `| ${r.split('|').join(' | ')} |\n`;
  t += o.extra ?? '';
  const f = out('result.md');
  writeFileSync(f, t);
  return f;
}
const rec = (/** @type {string} */ d, /** @type {string} */ gate, /** @type {string} */ res, /** @type {Parameters<typeof result>[3]} */ o = {}, role = OWNER[gate]) =>
  A(d, ['record', 'LC', '--file', result(d, gate, res, o)], { role });
const NODE = 'scaffold orchestrated no COMPLEX';
const impl = () => project(`${NODE}; ${IMPLEMENTED}`);
const gates = (/** @type {string} */ d) => readdirSync(`${d}/.agents/runs/LC/gates`).filter((n) => n.endsWith('.yaml'));

test('record: a PASS writes the raw result, a gate record with the rule version and a ledger row; the output texts are the shell\'s', () => {
  const d = impl();
  const r = accepted(rec(d, 'REVIEW_SMALL', 'PASS'), 'record PASS');
  assert.match(r.out, /^gate recorded: LC 001-REVIEW_SMALL \(pass\)$/m);
  assert.match(r.out, /^result recorded: LC results\/001-reviewer\.result\.md \(reviewer PASS\)$/m);
  const g = read(d, '.agents/runs/LC/gates/001-REVIEW_SMALL.yaml');
  assert.match(g, /^result: "pass"$/m);
  assert.match(g, /^blocking_rule: "1"$/m);
  assert.match(g, /^result_file: "results\/001-reviewer\.result\.md"$/m);
  assert.match(g, /^focus: "rules\+tests"$/m);
  assert.ok(existsSync(`${d}/.agents/runs/LC/gates/001-REVIEW_SMALL.manifest`));
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /event=gate:REVIEW_SMALL:pass .* detail=gates\/001-REVIEW_SMALL\.yaml@[0-9a-f]{64} by reviewer\n[^]*event=record:reviewer:PASS .* detail=results\/001-reviewer\.result\.md sha256=[0-9a-f]{64} gate=REVIEW_SMALL\n$/);
});

test('record: a low-confidence PASS is pass_low; a FAIL records its fix scope; PASS with a blocking row and FAIL without one are refused', () => {
  const d = impl();
  accepted(rec(d, 'REVIEW_SMALL', 'PASS', { conf: 'low' }), 'low');
  assert.match(read(d, '.agents/runs/LC/gates/001-REVIEW_SMALL.yaml'), /^result: "pass_low"$/m);
  const row = `REVIEW_SMALL-1|blocking|impl.txt:3|lookup returns the wrong value for an empty key|${SCAN}`;
  accepted(rec(d, 'REVIEW_SMALL', 'FAIL', { rows: [row] }), 'FAIL');
  const g = read(d, '.agents/runs/LC/gates/002-REVIEW_SMALL.yaml');
  assert.match(g, /^result: "fail"$/m);
  assert.match(g, /^fix_scope: impl\.txt$/m);
  assert.ok(g.includes(`finding: ${row}`));
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { rows: [row] }), 'PASS with a blocking row', 'record rejected: PASS cannot carry blocking findings');
  refused(rec(d, 'REVIEW_SMALL', 'FAIL'), 'FAIL without a blocking row', 'record rejected: FAIL needs at least one blocking finding');
  assert.deepEqual(gates(d), ['001-REVIEW_SMALL.yaml', '002-REVIEW_SMALL.yaml'], 'a refused record wrote a gate');
});

test('record: header refusals (malformed, missing key, repeated key, unknown role, role mismatch, wrong task, bad confidence, lead verdict)', () => {
  const d = impl();
  const f = (/** @type {string} */ name, /** @type {Record<string, string | null>} */ head) => A(d, ['record', 'LC', '--file', result(d, 'REVIEW_SMALL', 'PASS', { head })], { role: name });
  refused(f('reviewer', { ROLE: null }), 'missing ROLE', 'record rejected: malformed header: missing ROLE');
  refused(f('reviewer', { CONFIDENCE: null }), 'missing CONFIDENCE', 'record rejected: malformed header: missing CONFIDENCE');
  refused(f('qa', {}), 'a role that does not match AGENT_ROLE', 'record rejected: ROLE reviewer does not match AGENT_ROLE qa');
  refused(f('reviewer', { ROLE: 'wizard' }), 'an unknown role', 'record rejected: unknown ROLE: wizard');
  refused(f('reviewer', { TASK: 'OTHER' }), 'another task', 'record rejected: TASK OTHER does not match LC');
  refused(f('reviewer', { CONFIDENCE: 'certain' }), 'a bad confidence', 'record rejected: invalid CONFIDENCE: certain');
  const dup = result(d, 'REVIEW_SMALL', 'PASS');
  writeFileSync(dup, `ROLE: reviewer\n${readFileSync(dup, 'utf8')}`);
  refused(A(d, ['record', 'LC', '--file', dup], { role: 'reviewer' }), 'a repeated header key', 'record rejected: malformed header');
  const junk = out('junk.md');
  writeFileSync(junk, 'nothing like a header\n');
  refused(A(d, ['record', 'LC', '--file', junk], { role: 'reviewer' }), 'no header', 'record rejected: malformed header');
  refused(A(d, ['record', 'LC', '--file', out('missing.md')], { role: 'reviewer' }), 'a missing file', 'result file not found');
  // the lead never records a verdict, whatever the document says
  refused(A(d, ['record', 'LC', '--file', result(d, 'REVIEW_SMALL', 'PASS', { head: { ROLE: 'lead', FOCUS: null } })], { role: 'lead' }), 'lead PASS', 'record rejected: the lead can never record a PASS verdict');
  assert.deepEqual(existsSync(`${d}/.agents/runs/LC/gates`) ? gates(d) : [], [], 'a refused record wrote a gate');
});

test('record: the result is read from stdin when there is no --file', () => {
  const d = impl();
  const text = readFileSync(result(d, 'REVIEW_SMALL', 'PASS'), 'utf8');
  const r = accepted(A(d, ['record', 'LC'], { role: 'reviewer', input: text }), 'record from stdin');
  assert.match(r.out, /result recorded: LC results\/001-reviewer\.result\.md \(reviewer PASS\)/);
});

test('record: a stale FINGERPRINT, an ARTIFACT hash mismatch, an artifact outside the run, an unregistered path and a path outside the role\'s folders are refused', () => {
  const d = impl();
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { FINGERPRINT: 'f'.repeat(40) } }), 'stale fingerprint', /record rejected: stale: FINGERPRINT f{40} is not the current content fingerprint [0-9a-f]{40}/);
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { ARTIFACT: `${REPORT.REVIEW_SMALL} ${'0'.repeat(64)}` } }), 'hash mismatch', `record rejected: ARTIFACT sha256 mismatch for ${REPORT.REVIEW_SMALL}`);
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { ARTIFACT: REPORT.REVIEW_SMALL } }), 'no hash', "record rejected: ARTIFACT needs '<run-relative path> <sha256>'");
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { ARTIFACT: `../../../README ${'0'.repeat(64)}` } }), 'dot dot', 'record rejected: ARTIFACT path must be run-relative');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { ARTIFACT: `reviews/missing.md ${'0'.repeat(64)}` } }), 'missing', 'record rejected: ARTIFACT not found in the run: reviews/missing.md');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { ARTIFACT: `/etc/hosts ${'0'.repeat(64)}` } }), 'absolute outside', 'record rejected: ARTIFACT path must be inside the run: /etc/hosts');
  const run = `${d}/.agents/runs/LC`;
  // outside the role's folders: a reviewer cannot report in the verifier's file
  writeFileSync(`${run}/VERIFY.md`, 'Verdict: PASS\n');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { art: 'VERIFY.md' }), 'the verifier file', 'record rejected: ARTIFACT VERIFY.md is outside the paths reviewer (FOCUS rules+tests) reports in: reviews/proof-review/small/');
  writeFileSync(`${run}/notes.txt`, 'x\n');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { art: 'notes.txt' }), 'an unregistered file', 'record rejected: ARTIFACT is not a registered run artifact: notes.txt');
});

test('record: finding rows (placeholder, malformed, wrong prefix, wrong severity, duplicate ids), an unknown gate focus and a missing BLOCKED reason are refused', () => {
  const d = impl();
  const ok = `REVIEW_SMALL-1|info|impl.txt:1|a note about the plan|traced: it holds`;
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { rows: ['none|-|-|-|-'] }), 'a no-findings placeholder', 'record rejected: no findings: omit rows, keep only the table header');
  refused(A(d, ['record', 'LC', '--file', result(d, 'REVIEW_SMALL', 'PASS', { extra: '| REVIEW_SMALL-1 | info | impl.txt:1 | missing last pipe | traced\n' })], { role: 'reviewer' }), 'a malformed row', 'record rejected: malformed findings row');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { rows: ['WRONG-1|info|impl.txt:1|a note about the plan|traced'] }), 'a wrong prefix', 'record rejected: invalid finding id WRONG-1 (want REVIEW_SMALL-<n>)');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { rows: ['REVIEW_SMALL-1|minor|impl.txt:1|a note about the plan|traced'] }), 'a wrong severity', 'record rejected: invalid finding severity minor');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { rows: [ok, ok.replace('REVIEW_SMALL-1', 'review_small-01')] }), 'duplicate ids by key', 'record rejected: duplicate finding ids');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { FOCUS: 'bogus' } }), 'an unknown reviewer focus', 'record rejected: reviewer results need FOCUS');
  refused(rec(d, 'REVIEW_SMALL', 'BLOCKED'), 'BLOCKED without a reason', 'record rejected: BLOCKED needs a BLOCKED_REASON line');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { head: { FOCUS: 'visual' } }), 'a focus of another role', 'record rejected: reviewer results need FOCUS');
  const sec = rec(d, 'SECURITY', 'PASS', { head: { FOCUS: 'contract' } });
  refused(sec, 'a risk focus of the reviewer on the security role', 'record rejected: FOCUS contract is not a focus of role security_reviewer');
});

test('record: a rules review FAIL states how it scanned and lists every instance (A171)', () => {
  const d = impl();
  const row = (/** @type {string} */ ev) => `REVIEW_SMALL-1|blocking|impl.txt:3|lookup returns the wrong value for an empty key|${ev}`;
  refused(rec(d, 'REVIEW_SMALL', 'FAIL', { rows: [row('traced: empty key')] }), 'no scan', 'record rejected: finding REVIEW_SMALL-1: evidence lacks scan');
  refused(rec(d, 'REVIEW_SMALL', 'FAIL', { rows: [row('scan: grep -n lookup impl.txt')] }), 'no instances', 'record rejected: finding REVIEW_SMALL-1: evidence lacks instances');
  refused(rec(d, 'REVIEW_SMALL', 'FAIL', { rows: [row('scan: grep -n lookup impl.txt; instances: other.txt:9')] }), 'instances without the row', 'record rejected: finding REVIEW_SMALL-1: instances do not include the row location impl.txt:3');
  accepted(rec(d, 'REVIEW_SMALL', 'FAIL', { rows: [row('scan: grep -n lookup impl.txt; instances: impl.txt:3, impl.txt:8')] }), 'complete scan');
});

test('record: the same observation keeps its classification across revisions (A171)', () => {
  const d = impl();
  const row = (/** @type {string} */ sev) => `REVIEW_SMALL-1|${sev}|impl.txt:1|lookup returns the wrong value for an empty key|${SCAN}`;
  accepted(rec(d, 'REVIEW_SMALL', 'FAIL', { rows: [row('blocking')] }), 'first');
  // change the tree (the fingerprint changes) and report the same observation as info
  writeFileSync(`${d}/unrelated.txt`, 'changed\n');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { rows: [row('info')] }), 'a downgrade', /record rejected: classification changed for the same observation: REVIEW_SMALL-1 \(impl\.txt:1\) is info, and was blocking in 001-REVIEW_SMALL\.yaml/);
});

test('record: evidence cited with EVIDENCE: must exist in the run with its hash (A107)', () => {
  const d = impl();
  const run = `${d}/.agents/runs/LC`;
  mkdirSync(`${run}/reports`, { recursive: true });
  writeFileSync(`${run}/reports/ev.txt`, 'proof\n');
  const good = `reports/ev.txt ${sha('proof\n')}`;
  accepted(rec(d, 'REVIEW_SMALL', 'PASS', { extra: `\nEVIDENCE: ${good}\n` }), 'good citation');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { extra: `\nEVIDENCE: reports/ev.txt ${'0'.repeat(64)}\n` }), 'a wrong hash', /record rejected: cited evidence file reports\/ev\.txt was modified after it was hashed: cited sha256 0{12}, the file is [0-9a-f]{12} \(A107\)/);
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { extra: `\nEVIDENCE: reports/none.txt ${'0'.repeat(64)}\n` }), 'a missing file', 'record rejected: cited evidence file not found in the run: reports/none.txt (A107)');
  refused(rec(d, 'REVIEW_SMALL', 'PASS', { extra: `\nEVIDENCE: ../x ${'0'.repeat(64)}\n` }), 'a dot dot path', 'record rejected: cited evidence path must be run-relative: ../x (A107)');
});

test('record: UNSUPPORTED is the result of a risk focus only, always needs the validator\'s saved output and a concrete reason (A98, A102)', () => {
  const d = impl();
  refused(rec(d, 'REVIEW_SMALL', 'UNSUPPORTED'), 'a plan review', 'record rejected: UNSUPPORTED is a result of a risk focus only');
  refused(rec(d, 'REVIEW_SMALL', 'UNSUPPORTED', { head: { FOCUS: 'concurrency' } }), 'concurrency', 'record rejected: the concurrency focus always has a tool-free check');
  refused(rec(d, 'REVIEW_SMALL', 'UNSUPPORTED', { head: { FOCUS: 'config' } }), 'config', 'record rejected: the config focus always has a tool-free check');
  refused(rec(d, 'SECURITY', 'UNSUPPORTED', { head: { FOCUS: 'dependencies' } }), 'dependencies', 'record rejected: the dependencies focus always has a tool-free check');
  refused(rec(d, 'SECURITY', 'UNSUPPORTED', { head: { FOCUS: 'logging' } }), 'logging', 'record rejected: the logging focus always has a tool-free check');
  refused(rec(d, 'REVIEW_SMALL', 'UNSUPPORTED', { head: { FOCUS: 'contract' } }), 'no evidence line', 'record rejected: UNSUPPORTED needs --evidence');
  refused(rec(d, 'REVIEW_SMALL', 'UNSUPPORTED', { head: { FOCUS: 'contract' }, extra: '\nUNSUPPORTED_EVIDENCE: reports/x.md aa\n' }), 'no reason line', 'record rejected: UNSUPPORTED needs an UNSUPPORTED_REASON line');
  refused(rec(d, 'REVIEW_SMALL', 'UNSUPPORTED', { head: { FOCUS: 'contract' }, extra: '\nUNSUPPORTED_REASON: n/a\nUNSUPPORTED_EVIDENCE: reports/x.md aa\n' }), 'a vague reason', 'record rejected: UNSUPPORTED_REASON is too vague');
});

test('record: NEEDS_INPUT stores the questions, and the same role cannot ask a second time in the run', () => {
  const d = impl();
  const doc = (/** @type {string} */ role, /** @type {string} */ q) => {
    const run = `${d}/.agents/runs/LC`;
    mkdirSync(`${run}/reports`, { recursive: true });
    writeFileSync(`${run}/reports/001-${role}.md`, `# ${role} report\nbody\n`);
    const fp = A(d, ['fingerprint', 'LC']).out.trim();
    const f = out('ni.md');
    writeFileSync(f, `ROLE: ${role}\nTASK: LC\nRESULT: NEEDS_INPUT\nCONFIDENCE: high\nFINGERPRINT: ${fp}\nARTIFACT: reports/001-${role}.md ${sha(`# ${role} report\nbody\n`)}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n\n${q}`);
    return f;
  };
  const r = A(d, ['record', 'LC', '--file', doc('architect', 'QUESTIONS:\n1. Which store should the lookup use?\n')], { role: 'architect' });
  accepted(r, 'NEEDS_INPUT');
  const q = read(d, '.agents/runs/LC/questions/001.md');
  assert.match(q, /^from: architect\nfocus: \ngrill: no\nresult: results\/001-architect\.result\.md\nasked_at: \d+\n---\n/);
  assert.ok(q.includes('1. Which store should the lookup use?'));
  refused(A(d, ['record', 'LC', '--file', doc('architect', 'QUESTIONS:\nanother\n')], { role: 'architect' }), 'a second ask', 'record rejected: the architect role already asked its questions in this run (questions/001.md)');
  refused(A(d, ['record', 'LC', '--file', doc('designer', 'no questions block\n')], { role: 'designer' }), 'no QUESTIONS block', 'record rejected: NEEDS_INPUT needs a QUESTIONS: block');
});

test('record: a gate cannot be recorded before IMPLEMENTED', () => {
  const d = project(NODE);
  refused(rec(d, 'REVIEW_SMALL', 'PASS'), 'before IMPLEMENTED', 'REVIEW_SMALL gate may only be recorded while handoff state is IMPLEMENTED');
});

test('submit: derives the result from the findings, writes the report from stdin, snapshots it and records in process', () => {
  const d = impl();
  const r = accepted(A(d, ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--artifact', REPORT.REVIEW_SMALL, '--findings', 'none', '--report', '-'], { role: 'reviewer', input: '# plan review\n\nVerdict: PASS\n' }), 'submit');
  assert.equal(r.out, 'submitted: LC reviewer PASS gate=REVIEW_SMALL (results/001-reviewer.result.md)\n');
  const snaps = readdirSync(`${d}/.agents/runs/LC/reports/snapshots`);
  assert.equal(snaps.length, 1);
  assert.match(snaps[0], /^[0-9a-f]{12}-reviewer-reviews_proof-review_small_REPORT\.md$/);
  assert.match(read(d, '.agents/runs/LC/results/001-reviewer.result.md'), /^ARTIFACT: reports\/snapshots\/[0-9a-f]{12}-reviewer-reviews_proof-review_small_REPORT\.md [0-9a-f]{64}$/m);
  const g = read(d, '.agents/runs/LC/gates/001-REVIEW_SMALL.yaml');
  assert.match(g, /^result: "pass"$/m);
  assert.match(g, /^not_rerun: "REVIEW_SMALL:rules\+tests no reproduced evidence; this gate is not reproduced proof"$/m);
});

test('submit: findings decide the gate; PASS with a blocking row, FAIL without one, an unknown option, the lead and a bad confidence are refused', () => {
  const d = impl();
  const base = ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--artifact', REPORT.REVIEW_SMALL, '--report', '-'];
  const rows = out('rows');
  writeFileSync(rows, `blocking|impl.txt:3|lookup returns the wrong value for an empty key|${SCAN}\n`);
  const f = accepted(A(d, [...base, '--findings', rows], { role: 'reviewer', input: '# rules review\n' }), 'derived FAIL');
  assert.match(f.out, /^submitted: LC reviewer FAIL gate=REVIEW_SMALL \(results\/001-reviewer\.result\.md\)$/m);
  assert.match(read(d, '.agents/runs/LC/results/001-reviewer.result.md'), /^\| REVIEW_SMALL-1 \| blocking \| impl\.txt:3 \| lookup returns the wrong value for an empty key \| traced: empty key -> nil; scan: grep -n lookup impl\.txt; instances: single \|$/m);
  refused(A(d, [...base, '--result', 'PASS', '--findings', rows], { role: 'reviewer', input: '# r\n' }), 'declared PASS', 'submit rejected: --result PASS contradicts 1 blocking finding(s); the result of a gate follows from the findings');
  refused(A(d, [...base, '--result', 'FAIL', '--findings', 'none'], { role: 'reviewer', input: '# r\n' }), 'declared FAIL', 'submit rejected: --result FAIL needs at least one blocking finding');
  refused(A(d, [...base, '--bogus', 'x'], { role: 'reviewer', input: '# r\n' }), 'unknown option', 'submit: unknown option --bogus');
  refused(A(d, ['submit', 'LC', '--confidence', 'high'], { role: 'lead' }), 'the lead', 'the lead never submits a specialist result');
  refused(A(d, [...base.slice(0, 3), 'sure', ...base.slice(4)], { role: 'reviewer', input: '# r\n' }), 'bad confidence', 'submit rejected: --confidence must be high, medium or low');
  refused(A(d, [...base, '--findings', out('nope')], { role: 'reviewer', input: '# r\n' }), 'missing findings file', 'submit rejected: findings file not found');
  writeFileSync(rows, 'blocking|impl.txt:3|only three columns\n');
  refused(A(d, [...base, '--findings', rows], { role: 'reviewer', input: '# r\n' }), 'a short row', 'submit rejected: BAD 1: want severity|path:line|finding|evidence');
  writeFileSync(rows, 'info|impl.txt:3|note|agent.sh pipeline LC\n');
  refused(A(d, [...base, '--findings', rows], { role: 'reviewer', input: '# r\n' }), 'reserved evidence', 'submit rejected: BAD 1: the evidence of a row may not start with agent.sh');
});

test('submit: one stdin stream only; the report and the findings may share it split by the marker line (A104)', () => {
  const d = impl();
  const base = ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--artifact', REPORT.REVIEW_SMALL];
  refused(A(d, [...base, '--report', '-', '--findings', '-', '--questions', '-'], { role: 'reviewer', input: 'x' }), 'three stdin sources', 'submit rejected: only one of --report/--findings/--questions may read stdin');
  refused(A(d, [...base, '--report', '-', '--findings', '-'], { role: 'reviewer', input: '# plan\nno marker\n' }), 'two without the marker', 'submit rejected: only one of --report/--findings may read stdin');
  const ok = accepted(A(d, [...base, '--report', '-', '--findings', '-'], { role: 'reviewer', input: '# plan review\n=== FINDINGS ===\ninfo|impl.txt:1|a plain note about the plan|traced: it holds\n' }), 'split document');
  assert.match(ok.out, /^submitted: LC reviewer PASS gate=REVIEW_SMALL/m);
  assert.match(read(d, '.agents/runs/LC/results/001-reviewer.result.md'), /^\| REVIEW_SMALL-1 \| info \| impl\.txt:1 \| a plain note about the plan \| traced: it holds \|$/m);
});

test('submit: an artifact outside the role\'s folders and a path outside the run are refused before anything is written', () => {
  const d = impl();
  const base = ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--findings', 'none', '--report', '-'];
  refused(A(d, [...base, '--artifact', 'VERIFY.md'], { role: 'reviewer', input: '# r\n' }), 'the verifier file', 'submit rejected: artifact VERIFY.md is outside the paths reviewer (FOCUS rules+tests) reports in: reviews/proof-review/small/');
  refused(A(d, [...base, '--artifact', '../x.md'], { role: 'reviewer', input: '# r\n' }), 'dot dot', 'submit rejected: --artifact must be a run-relative path: ../x.md');
  refused(A(d, ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--findings', 'none', '--artifact', REPORT.REVIEW_SMALL], { role: 'reviewer' }), 'a report that is not there', 'submit rejected: artifact not found in the run');
  refused(A(d, [...base, '--artifact', REPORT.REVIEW_SMALL], { role: 'reviewer', input: '' }), 'an empty report', 'submit rejected: the report is empty');
  assert.ok(!existsSync(`${d}/.agents/runs/LC/gates`) || gates(d).length === 0);
});

test('submit: an explorer\'s report name is allocated by the script and released again when the submit is refused (A113)', () => {
  const d = project(NODE);
  const sub = (/** @type {string[]} */ extra, /** @type {string} */ input) => A(d, ['submit', 'LC', '--confidence', 'high', '--result', 'DONE', '--findings', 'none', '--report', '-', ...extra], { role: 'explorer', input });
  const r = accepted(sub([], '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| C-1 | info | impl.txt:1 | claim | seen |\n'), 'first explorer');
  assert.match(r.out, /^submitted: LC explorer DONE \(results\/001-explorer\.result\.md\)$/m);
  assert.ok(existsSync(`${d}/.agents/runs/LC/reports/001-explorer.md`));
  const r2 = accepted(sub([], 'prose only, no table\n'), 'second explorer');
  assert.match(r2.err, /NOTE: the explorer report reports\/002-explorer\.md has no claims table/);
  assert.ok(existsSync(`${d}/.agents/runs/LC/reports/002-explorer.md`));
  refused(A(d, ['submit', 'LC', '--confidence', 'high', '--result', 'DONE', '--findings', 'none', '--artifact', 'reports/005-explorer.md'], { role: 'explorer' }), 'no report', 'submit rejected: an explorer hands its report over with --report');
  assert.ok(!existsSync(`${d}/.agents/runs/LC/reports/005-explorer.md`) && !existsSync(`${d}/.agents/runs/LC/reports/003-explorer.md`), 'a refused submit left a stub');
});

test('submit: a rejected submit writes a status file for its agent token', () => {
  const d = impl();
  const r = A(d, ['submit', 'LC', '--confidence', 'sure', '--agent', 'tok-1'], { role: 'reviewer' });
  refused(r, 'rejected', 'submit rejected: --confidence must be high, medium or low');
  assert.match(read(d, '.agents/local/submissions/tok-1.status'), /^status=rejected\ntask=LC\nrole=reviewer\nresult=\ngate=\nraw=\nepoch=\d+\nerror=--confidence must be high, medium or low\n$/);
  refused(A(d, ['submit', 'LC', '--confidence', 'high', '--agent', 'bad token'], { role: 'reviewer' }), 'a bad token', 'submit: invalid --agent token');
});

test('submit: run artifacts are English: a non-English report is refused (A33)', () => {
  const d = impl();
  const r = A(d, ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--artifact', REPORT.REVIEW_SMALL, '--findings', 'none', '--report', '-'], { role: 'reviewer', input: '# plan\n\nBu rapor tamamen Türkçe yazılmıştır çünkü şöyle böyle.\n' });
  refused(r, 'Turkish report', 'submit rejected: language: run artifacts are English');
});

test('submit: a declared validator result is never trusted and a missing validator for a mapped gate is an info row (A107)', () => {
  const d = impl();
  // no skill installed in the fixture: the gate result follows from the findings, the missing validator is reported as an info row
  const r = accepted(A(d, ['submit', 'LC', '--confidence', 'high', '--focus', 'rules+tests', '--artifact', REPORT.REVIEW_SMALL, '--findings', 'none', '--report', '-'], { role: 'reviewer', input: '# plan\n' }), 'no skill');
  assert.match(r.out, /submitted: LC reviewer PASS gate=REVIEW_SMALL/);
  assert.match(read(d, '.agents/runs/LC/results/001-reviewer.result.md'), /^\| REVIEW_SMALL-1 \| info \| reviews\/proof-review\/small\/REPORT\.md \| NOT_VALIDATED: REVIEW_SMALL:rules\+tests skill proof-review is not installed, so no validator ran; the result follows from the findings \| agent\.sh submit \(A107\) \|$/m);
});
