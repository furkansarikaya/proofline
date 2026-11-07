// @ts-check
// `proofline insights` (A89, A232; the former bin/lib/insights.sh and the insights scenario of tests/cli/cli-test.sh): the front end around the report of core/insights.mjs:
// argument checks, the `--run` scope, the JSON form, the calibration section, the read-only promise, and the context-size and rules tail of the plain report. The fixture is the
// shell fixture of fixtures/insights (planted records and runs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repo, scriptsDir } from './helpers.mjs';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
/** A listing of every file with its size and mtime: nothing may change. @param {string} root @returns {string} */
function sig(root) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => { for (const n of readdirSync(d).sort()) { if (n === '.git') continue; const p = path.join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${path.relative(root, p)} ${s.size} ${s.mtimeMs} ${readFileSync(p).length}`); } };
  walk(root);
  return out.join('\n');
}
const fixture = (/** @type {string} */ name) => { const d = `${sb.T}/${name}`; const r = spawnSync('sh', [path.join(repo, 'fixtures/insights/setup.sh'), d], { env: sb.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return d; };

test('the report on planted records: tokens are summed only where reported, a foreign schema is ignored, repeated findings and gates become patterns with a suggestion', () => {
  const ins = fixture('ins');
  const r = sb.pl(ins, ['insights']);
  assert.equal(r.status, 0, r.text);
  for (const want of [
    '6000 (2/3)',
    'RUN-C                  open               n/a     1 n/a              n/a              n/a',
    'tokens in 8000 (3/7), tokens out 1300 (3/7), tokens total 13300 (4/7)',
    'repeated-finding x3: REVIEW_RULES src/a.go: Error from Close is ignored',
    'gate-fail x3: REVIEW_RULES',
    'unsupported x2:',
    'approval x2: plan',
    'suggestion:',
  ]) assert.ok(r.out.includes(want), `missing ${want}\n${r.out}`);
  for (const nope of ['999999', 'Error from Open is ignored']) assert.ok(!r.out.includes(nope), `found ${nope}`);
  const sc = spawnSync('sh', [path.join(repo, 'fixtures/insights/selfcheck.sh'), ins], { env: sb.env, encoding: 'utf8' });
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);
  assert.match(r.out, /\ncontext loaded without being asked \(estimated tokens = bytes \/ 4\):\n {2}AGENTS\.md proofline block/);
});

test('--json is valid JSON with null tokens kept null; --run limits the report to one run; a missing run, a path-like id and an unknown argument fail', () => {
  const ins = fixture('ins-json');
  const j = JSON.parse(sb.pl(ins, ['insights', '--json']).out);
  assert.equal(j.schema, 'proofline.insights/1');
  assert.equal(j.runs.find((/** @type {any} */ x) => x.run === 'RUN-C').tokens_in, null);
  assert.deepEqual([j.totals.tokens_in, j.totals.tokens_in_reported, j.totals.tokens_total, j.totals.tokens_total_reported], [8000, 3, 13300, 4]);
  assert.deepEqual([j.metrics.duplicate_run_records, j.metrics.skipped_non_json], [1, 1]);
  assert.equal(j.patterns.filter((/** @type {any} */ p) => p.kind === 'repeated-finding').length, 1);
  const one = sb.pl(ins, ['insights', '--run', 'RUN-B']);
  assert.ok(one.out.includes('RUN-B') && !one.out.includes('RUN-A'), one.out);
  assert.ok(!one.out.includes('context loaded without being asked'), 'the context tail belongs to the plain report only');
  assert.equal(sb.pl(ins, ['insights', '--run=RUN-B']).status, 0);
  const none = sb.pl(ins, ['insights', '--run', 'NOPE-9']);
  assert.equal(none.status, 1);
  assert.match(none.err, /^proofline: no such run: NOPE-9 \(see: proofline queue\)$/m);
  assert.match(sb.pl(ins, ['insights', '--run', '../x']).err, /^proofline: invalid run id: \.\.\/x$/m);
  const unk = sb.pl(ins, ['insights', '--frobnicate']);
  assert.equal(unk.status, 1);
  assert.match(unk.err, /^usage: proofline insights \[--run <ID>\] \[--json\]\nproofline: unknown argument: --frobnicate$/m);
  const miss = sb.pl(ins, ['insights', '--run']);
  assert.equal(miss.status, 1);
  assert.match(miss.err, /proofline: --run needs a run id/);
  const help = sb.pl(ins, ['insights', '--help']);
  assert.equal(help.status, 0);
  assert.ok(help.out.startsWith('usage: proofline insights [--run <ID>] [--json]\n'));
  assert.equal(sb.pl(sb.mkrepo('bare-ins'), ['insights']).status, 1, 'outside an installed project');
  assert.match(sb.pl(sb.mkrepo('bare-ins2'), ['insights']).err, /^proofline: proofline is not installed in .* \(\.agents\/config\.yaml missing\); run: proofline init$/m);
});

test('calibration: estimated size against actual duration, tokens and paths gives a suggestion from planted records, and no file changes', () => {
  const cal = fixture('cal');
  const f = `${cal}/.agents/local/metrics/records.jsonl`;
  for (const [n, size, dur, tok, paths] of [[1, 'S', 1200, 3000, 2], [2, 'S', 1800, 5000, 4], [3, 'S', 2400, 9000, 3], [4, 'M', 600, 20000, 5], [5, 'M', 900, 30000, 6], [6, 'M', 1200, 40000, 7]]) {
    appendFileSync(f, `{"schema":"proofline.metrics/1","kind":"dispatch","time":"t","task":"CAL-${n}","role":"implementer","model":"m","duration_s":1,"tokens_total":${tok}}\n`);
    appendFileSync(f, `{"schema":"proofline.metrics/1","kind":"run","time":"t","task":"CAL-${n}","role":"lead","duration_s":${dur},"result":"done","size":"${size}","scope_paths":${paths}}\n`);
  }
  const before = sig(cal);
  const r = sb.pl(cal, ['insights']);
  assert.ok(r.out.includes('S tasks (3): median 30 min / 5000 tokens / 3 paths'), r.out);
  assert.ok(r.out.includes('S tasks took longer or touched more paths than M tasks; consider estimating tasks like the S ones one size up.'), r.out);
  const j = JSON.parse(sb.pl(cal, ['insights', '--json']).out);
  assert.deepEqual([j.calibration[0].size, j.calibration[0].median_min], ['S', 30]);
  assert.equal(sig(cal), before);
});

test('read-only: the report works on a checkout that cannot be written, and no rule, skill, config, ledger or metrics file changes', { skip: process.getuid?.() === 0 ? 'running as root: a read-only folder is still writable' : false }, () => {
  const ins = fixture('ins-ro');
  const before = sig(ins);
  const chmodAll = (/** @type {string} */ d, /** @type {number} */ mode) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) chmodAll(p, mode); } chmodSync(d, mode); };
  chmodAll(`${ins}/.agents`, 0o555);
  try {
    const r = sb.pl(ins, ['insights', '--json']);
    assert.equal(r.status, 0, r.text);
    assert.ok(JSON.parse(r.out).patterns);
  } finally { chmodAll(`${ins}/.agents`, 0o755); }
  assert.equal(sig(ins), before);
});

test('metrics off with no runs says so; the JSON of an empty project is valid and empty', () => {
  const d = sb.mkrepo('noruns');
  mkdirSync(`${d}/.agents/scripts`, { recursive: true });
  writeFileSync(`${d}/.agents/config.yaml`, 'metrics: off\n'); writeFileSync(`${d}/.agents/scripts/agent.sh`, '');
  cpSync(path.join(scriptsDir, 'proofline-core.mjs'), `${d}/.agents/scripts/proofline-core.mjs`); cpSync(path.join(scriptsDir, 'core'), `${d}/.agents/scripts/core`, { recursive: true });
  const r = sb.pl(d, ['insights']);
  assert.equal(r.status, 0, r.text);
  for (const want of ['no metrics recorded (metrics: off)', 'no runs and no metrics to report', 'none found']) assert.ok(r.out.includes(want), want);
  const j = JSON.parse(sb.pl(d, ['insights', '--json']).out);
  assert.deepEqual([j.metrics.off, j.runs, j.patterns], [true, [], []]);
  // the entry skill and the help text still list the command; the removed batch drivers say what to do instead
  const help = sb.pl(d, ['help']);
  assert.ok(help.out.includes('insights [--run ID] [--json]'));
  assert.match(help.out, /^\s*batch\s+<ID\.\.\.\|all>/m);
  assert.ok(!help.out.includes('batch run'));
  assert.ok(help.out.includes('batch status'));
  for (const sub of ['run', 'stop']) {
    const b = sb.pl(d, ['batch', sub]);
    assert.notEqual(b.status, 0);
    assert.ok(b.err.includes('runs in your agent session'), b.err);
    if (sub === 'stop') assert.ok(b.err.includes('continue an interrupted batch with /proofline batch'), b.err);
  }
});

test('a project with an agent.sh also prints the project rules line after the context size', () => {
  const d = sb.copy('ins-rules');
  const r = sb.pl(d, ['insights']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /\n {2}verifier \(blocks \+ agent file \+ first skill\) +[0-9]+ bytes +~ +[0-9]+ tokens\n\nproject rules: none\n/);
  assert.ok(r.out.trimEnd().endsWith('Next step: /proofline status'));
  void appendFileSync;
});
