// @ts-check
// A255 (#181): the TOOL CALLS section of `proofline insights`, read from .agents/local/metrics/tools.jsonl: per role, per run and overall, unknown counts shown as unknown,
// unusable logs counted apart, byte-order output, and a file that is large, corrupt or hostile.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { insightsReport, insightsStream } from '../../control-plane/agents/scripts/core/insights.mjs';
import { MAX_LINES, toolsSummary } from '../../control-plane/agents/scripts/core/toolsinsights.mjs';
import { makeProject } from './helpers.mjs';

/** @param {Record<string, unknown>} o */
const rec = (o) => JSON.stringify({ schema: 'proofline.tools/1', kind: 'step', time: '2026-11-11T12:00:00Z', task: 'RUN-A', role: 'reviewer', focus: null, gate: 'REVIEW', runtime: 'claude', log: 'ok', calls: 0, result_bytes: 0, denied: 0, by_tool: {}, reason: null, ...o });
/** @param {string} root @param {string[] | string} lines */
function plant(root, lines) {
  const f = path.join(root, '.agents/local/metrics/tools.jsonl');
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, typeof lines === 'string' ? lines : `${lines.join('\n')}\n`);
  return f;
}
/** @param {string} root @param {string} [only] @param {boolean} [json] */
const report = (root, only = '', json = false) => insightsReport(insightsStream(root, only), { json, only, off: false });
const section = (/** @type {string} */ t) => { const i = t.indexOf('TOOL CALLS'); return t.slice(i, t.indexOf('RECURRING FAILURES')); };

const PLANTED = [
  rec({ task: 'RUN-B', role: 'qa', calls: 4, result_bytes: 1000, denied: 1, by_tool: { Bash: { calls: 3, bytes: 900 }, Read: { calls: 1, bytes: 100 } } }),
  rec({ task: 'RUN-A', role: 'reviewer', calls: 10, result_bytes: 5000, denied: 2, by_tool: { Read: { calls: 6, bytes: 4000 }, Bash: { calls: 4, bytes: 1000 } } }),
  rec({ task: 'RUN-A', role: 'reviewer', log: 'unreadable', calls: null, result_bytes: null, denied: null, by_tool: null, reason: 'no-rollout', runtime: 'codex' }),
  rec({ task: 'RUN-A', role: 'verifier', log: 'malformed', calls: null, result_bytes: null, denied: null, by_tool: null }),
  rec({ task: 'RUN-A', role: 'reviewer', calls: 2, result_bytes: 1, by_tool: { __proto__x: { calls: 2, bytes: 1 } } }),
  rec({ schema: 'proofline.tools/9', task: 'RUN-Z' }),
  '{this is not json',
  '',
];

describe('insights: TOOL CALLS', () => {
  test('per role, per run and overall: sums, per-job averages, "(k/n)" where a job had no readable log, n/a for unknown, apart counts for unusable logs', () => {
    const root = makeProject();
    plant(root, PLANTED);
    const t = section(report(root));
    for (const want of [
      /^ {2}ROLE +JOBS +CALLS\/JOB +BYTES\/JOB +CALLS +RESULT_BYTES +DENIED +TOP TOOLS$/m,
      /^ {2}qa +1 +4\.0 +1000 +4 +1000 +1 +Bash:3,Read:1$/m,
      /^ {2}reviewer +3 +6\.0 +2501 +12 \(2\/3\) +5001 \(2\/3\) +2 \(2\/3\) +Read:6,Bash:4,__proto__x:2$/m,
      /^ {2}verifier +1 +n\/a +n\/a +n\/a +n\/a +n\/a +-$/m,
      /^ {2}RUN-A +4 +6\.0 +2501 +12 \(2\/4\) +5001 \(2\/4\) +2 \(2\/4\) /m,
      /^ {2}RUN-B +1 +4\.0 +1000 +4 +1000 +1 +/m,
      /^ {2}total over 5 job\(s\), 3 with a readable log: calls 16 \(3\/5\), result bytes 6001 \(3\/5\), refused by a hook 3 \(3\/5\); 5\.3 calls and 2000 bytes per job$/m,
      /^ {2}top tools: Bash 7 calls 1900 bytes; Read 7 calls 4100 bytes; __proto__x 2 calls 1 bytes$/m,
      /^ {2}1 job\(s\) without a readable log \(counts unknown\); 1 job\(s\) with a malformed log; 1 record\(s\) with an unknown schema skipped; 1 corrupt line\(s\) ignored$/m,
    ]) assert.match(t, want);
    // role and run rows are in byte order
    assert.ok(t.indexOf('  qa ') < t.indexOf('  reviewer ') && t.indexOf('  reviewer ') < t.indexOf('  verifier '));
    assert.ok(t.indexOf('  RUN-A ') < t.indexOf('  RUN-B '));
  });
  test('the order of the records in the file does not change the report', () => {
    const a = makeProject(); const b = makeProject();
    plant(a, PLANTED); plant(b, [...PLANTED].reverse());
    assert.equal(report(a), report(b));
    assert.equal(report(a, '', true), report(b, '', true));
  });
  test('--json carries the same numbers; unknown counts are null, never zero; the file is valid JSON', () => {
    const root = makeProject();
    plant(root, PLANTED);
    const j = JSON.parse(report(root, '', true));
    const tl = j.tools;
    assert.deepEqual([tl.records, tl.skipped_unknown_schema, tl.corrupt_lines, tl.capped], [5, 1, 1, false]);
    assert.deepEqual([tl.totals.jobs, tl.totals.jobs_read, tl.totals.unreadable, tl.totals.malformed, tl.totals.calls, tl.totals.result_bytes, tl.totals.denied], [5, 3, 1, 1, 16, 6001, 3]);
    assert.deepEqual(tl.by_role.map((/** @type {any} */ r) => r.name), ['qa', 'reviewer', 'verifier']);
    const v = tl.by_role[2];
    assert.deepEqual([v.calls, v.calls_per_job, v.result_bytes, v.bytes_per_job, v.denied], [null, null, null, null, null]);
    assert.deepEqual(tl.by_role[1].top[0], { tool: 'Read', calls: 6, bytes: 4000 });
  });
  test('no file: the section says so and --json has tools: null; a file with no record for the --run filter says so', () => {
    const root = makeProject();
    assert.match(section(report(root)), /no tool records \(\.agents\/local\/metrics\/tools\.jsonl\)/);
    assert.equal(JSON.parse(report(root, '', true)).tools, null);
    plant(root, PLANTED);
    assert.match(section(report(root, 'NOPE')), /no tool records for this filter/);
    const one = section(report(root, 'RUN-B'));
    assert.ok(one.includes('RUN-B') && !one.includes('RUN-A') && !one.includes('reviewer'), one);
  });
  test('a tool named __proto__ and hostile identifiers do not pollute anything and are reduced', () => {
    const root = makeProject();
    plant(root, [
      '{"schema":"proofline.tools/1","task":"T\\"-1\\n","role":"a b/../c","log":"ok","calls":1,"result_bytes":2,"denied":0,"by_tool":{"__proto__":{"calls":1,"bytes":2},"constructor":{"calls":1,"bytes":1}}}',
      rec({ role: 'R'.repeat(5000) }),
    ]);
    const j = JSON.parse(report(root, '', true));
    assert.deepEqual(j.tools.by_role.map((/** @type {any} */ r) => r.name), ['R'.repeat(64), 'ab..c']);
    assert.deepEqual(j.tools.by_run.map((/** @type {any} */ r) => r.name), ['RUN-A', 'T-1']);
    assert.deepEqual(j.tools.top_tools.map((/** @type {any} */ x) => x.tool), ['__proto__', 'constructor']);
    assert.equal(/** @type {any} */ ({}).calls, undefined);
    assert.equal(/** @type {any} */ (Object.prototype).tool, undefined);
  });
  test('numbers that are not counts (negative, fractional, huge, string) make the job damaged (malformed), not zero or a sum; an unknown denied stays unknown, never 0', () => {
    const root = makeProject();
    plant(root, [rec({ calls: -1 }), rec({ calls: 1.5 }), rec({ calls: 2 ** 60 }), rec({ calls: '7' }), rec({ calls: 3, result_bytes: 4, by_tool: { A: { calls: -5, bytes: 1 }, B: { calls: 1, bytes: 1 } } })]);
    const tl = JSON.parse(report(root, '', true)).tools;
    assert.deepEqual([tl.totals.jobs, tl.totals.jobs_read, tl.totals.unreadable, tl.totals.malformed, tl.totals.calls], [5, 1, 0, 4, 3]);
    assert.deepEqual(tl.top_tools, [{ tool: 'B', calls: 1, bytes: 1 }]);
  });
  test('denied null, negative or missing on a readable job is unknown: n/a when no job knows it, "(k/n)" when some do, never 0', () => {
    const root = makeProject();
    plant(root, [rec({ calls: 1, denied: null }), rec({ calls: 1, denied: -1 })]);
    let tl = JSON.parse(report(root, '', true)).tools;
    assert.deepEqual([tl.totals.jobs_read, tl.totals.calls, tl.totals.denied, tl.totals.denied_jobs], [2, 2, null, 0]);
    assert.match(section(report(root)), /^ {2}reviewer +2 +1\.0 +0 +2 +0 +n\/a /m);
    plant(root, [rec({ calls: 1, denied: null }), rec({ calls: 1, denied: 2 }), rec({ calls: 1, denied: 1 })]);
    tl = JSON.parse(report(root, '', true)).tools;
    assert.deepEqual([tl.totals.denied, tl.totals.denied_jobs], [3, 2]);
    assert.match(section(report(root)), /refused by a hook 3 \(2\/3\)/);
  });
  test('at most 100 distinct tool names per row are kept, the rest is "other"; at most 50 per record are read', () => {
    const root = makeProject();
    /** @type {Record<string, { calls: number, bytes: number }>} */ const by = {};
    for (let i = 0; i < 50; i++) by[`t${String(i).padStart(3, '0')}`] = { calls: 1, bytes: 1 };
    const lines = [];
    for (let r = 0; r < 4; r++) { const b = {}; for (let i = 0; i < 50; i++) /** @type {any} */ (b)[`r${r}t${i}`] = { calls: 1, bytes: 1 }; lines.push(rec({ calls: 50, result_bytes: 50, by_tool: b })); }
    lines.push(rec({ by_tool: { ...by, extra: { calls: 1, bytes: 1 } } }));
    plant(root, lines);
    const s = toolsSummary(path.join(root, '.agents/local/metrics/tools.jsonl'), '');
    assert.equal(s.all.tools.size, 101);
    assert.ok(s.all.tools.has('other'));
    assert.ok(!s.all.tools.has('extra'));
  });
});

describe('toolsSummary: bounded reading', () => {
  const file = (/** @type {string} */ root) => path.join(root, '.agents/local/metrics/tools.jsonl');
  test('only the first MAX_LINES lines are read and the report says so', () => {
    const root = makeProject();
    plant(root, `${'{}\n'.repeat(MAX_LINES + 5)}${rec({ calls: 1 })}\n`);
    const s = toolsSummary(file(root), '');
    assert.equal(s.capped, true);
    assert.equal(s.skipped, MAX_LINES);
    assert.equal(s.records, 0);
    assert.match(section(report(root)), /no tool records/);
    plant(root, `${'{}\n'.repeat(MAX_LINES - 1)}${rec({ calls: 1 })}\n`);
    const ok = toolsSummary(file(root), '');
    assert.deepEqual([ok.capped, ok.records], [false, 1]);
  });
  test('a line over 64 KiB is corrupt and skipped (its memory is not kept); the lines after it count; a line across a read boundary is intact', () => {
    const root = makeProject();
    const pad = rec({ task: 'T', by_tool: {}, calls: 1, result_bytes: 1, role: 'x'.repeat(60) });
    const many = Array.from({ length: 2000 }, () => pad);           // well over one 64 KiB chunk
    plant(root, [rec({ calls: 1 }), `{"x":"${'a'.repeat(70000)}"}`, ...many, rec({ calls: 2 })]);
    const s = toolsSummary(file(root), '');
    assert.equal(s.corrupt, 1);
    assert.equal(s.records, 2002);
    assert.equal(s.all.calls, 1 + 2000 + 2);
  });
  test('an unfinished last line is ignored and is not corrupt; a complete last line without a newline counts; a corrupt line in the middle is counted and skipped', () => {
    const root = makeProject();
    plant(root, `${rec({ calls: 1 })}\n{bad\n${rec({ calls: 2 })}\n{"schema":"proofline.tools/1","task":"x","ro`);
    const s = toolsSummary(file(root), '');
    assert.deepEqual([s.records, s.corrupt, s.all.calls], [2, 1, 3]);
    plant(root, `${rec({ calls: 1 })}\n${rec({ calls: 5 })}`);
    assert.equal(toolsSummary(file(root), '').all.calls, 6);
  });
  test('a missing file is "not present", never an error', () => {
    const root = makeProject();
    assert.equal(toolsSummary(file(root), '').present, false);
  });
  test('a path that is not a regular file (a directory here; a FIFO is refused the same way, before open) is reported as unreadable and never opened', () => {
    const root = makeProject();
    mkdirSync(file(root), { recursive: true });
    const s = toolsSummary(file(root), '');
    assert.deepEqual([s.present, s.unreadableFile, s.records], [true, true, 0]);
    assert.match(section(report(root)), /not a regular file or could not be read; nothing was counted/);
    assert.equal(JSON.parse(report(root, '', true)).tools.file_unreadable, true);
  });
});
