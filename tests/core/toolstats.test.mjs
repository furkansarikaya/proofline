// @ts-check
// A235 (#181): the per-step tool record `.agents/local/metrics/tools.jsonl`, written by the control plane from the runtime's session log at `submit`.
// The reader is tested with absolute known answers on a synthetic log (the shapes were taken from real Claude Code transcripts); the writer with the
// `metrics: off`, null-visible and string-reduction rules of `records.jsonl` (A80).
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { metricsStep } from '../../control-plane/agents/scripts/core/resultutil.mjs';
import { readToolStats, toolsRecord } from '../../control-plane/agents/scripts/core/toolstats.mjs';
import { makeProject, memoryIo } from './helpers.mjs';

/** @param {unknown[]} entries */
const jsonl = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
const use = (/** @type {string} */ id, /** @type {string} */ name, input = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const res = (/** @type {string} */ id, /** @type {unknown} */ content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

/** @param {string} dir @param {unknown[]} entries */
function writeLog(dir, entries) { const f = path.join(dir, 'session.jsonl'); writeFileSync(f, jsonl(entries)); return f; }

const DENY = 'PreToolUse:Bash hook error: proofline: a model command never starts Node on the control plane';

describe('readToolStats', () => {
  test('counts calls and result bytes per tool; a duplicated entry (api-request-blob) counts once; a denied call is counted apart', () => {
    const dir = makeProject();
    const f = writeLog(dir, [
      { type: 'user', message: { role: 'user', content: 'go' } },
      use('t1', 'Bash', { command: 'ls' }),
      { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd x && ls' } }] } },
      res('t1', 'abcde'),
      use('t2', 'Read', { file_path: '/a' }),
      res('t2', [{ type: 'text', text: 'héllo' }, { type: 'image', source: {} }]),
      use('t3', 'Bash', { command: 'node core' }),
      res('t3', DENY),
      use('t4', 'Bash', { command: 'sleep' }),
    ]);
    const s = readToolStats(f);
    assert.equal(s.log, 'ok');
    assert.equal(s.calls, 4);
    assert.equal(s.resultBytes, 5 + 6 + Buffer.byteLength(DENY));
    assert.equal(s.denied, 1);
    assert.deepEqual(s.byTool, { Bash: { calls: 3, bytes: 5 + Buffer.byteLength(DENY) }, Read: { calls: 1, bytes: 6 } });
  });
  test('tool names are reduced to [A-Za-z0-9._+:-] and at most 40 distinct names are kept (the rest is "other")', () => {
    const dir = makeProject();
    const e = [use('a', 'we ird"name\n'), res('a', 'x'), use('a2', 'we ird"name\n'), res('a2', 'x')];
    for (let i = 0; i < 45; i++) e.push(use(`m${i}`, `mcp__s__t${i}`), res(`m${i}`, 'y'));
    const s = readToolStats(writeLog(dir, e));
    assert.ok('weirdname' in (s.byTool ?? {}));
    assert.equal(Object.keys(s.byTool ?? {}).length, 41);
    assert.equal(s.byTool?.other.calls, 6);
    assert.equal(s.calls, 47);
  });
  test('an unreadable log, a missing file and a malformed line give a visible failure, never zero', () => {
    const dir = makeProject();
    assert.deepEqual({ ...readToolStats(path.join(dir, 'nope.jsonl')) }, { log: 'unreadable', calls: null, resultBytes: null, denied: null, byTool: null, reason: 'read-error' });
    const f = path.join(dir, 'bad.jsonl');
    writeFileSync(f, `${JSON.stringify(use('a', 'Bash'))}\n{not json}\n${JSON.stringify(res('a', 'x'))}\n`);
    assert.equal(readToolStats(f).log, 'malformed');
    assert.equal(readToolStats(f).calls, null);
  });
  test('a half-written last line (the session is still running) is ignored, not an error', () => {
    const dir = makeProject();
    const f = path.join(dir, 'live.jsonl');
    writeFileSync(f, `${JSON.stringify(use('a', 'Bash'))}\n${JSON.stringify(res('a', 'xyz'))}\n{"type":"assistant","message":{"content":[{"type":"tool_u`);
    const s = readToolStats(f);
    assert.equal(s.log, 'ok'); assert.equal(s.calls, 1); assert.equal(s.resultBytes, 3);
  });
});

describe('tools.jsonl record', () => {
  /** @param {string} cfg */
  function ctxOf(cfg = 'canonical_branch: main\n') {
    const root = makeProject(cfg);
    const { io } = memoryIo(root);
    return { root, ctx: new Context(io, io.scriptPath ?? '') };
  }
  const fileOf = (/** @type {string} */ root) => path.join(root, '.agents/local/metrics/tools.jsonl');

  test('one line per call: schema, keys in a fixed order, no model text, strings reduced', () => {
    const { root, ctx } = ctxOf();
    const log = writeLog(root, [use('a', 'Bash', { command: 'SECRET-COMMAND-TEXT' }), res('a', 'SECRET-OUTPUT'), use('b', 'Read'), res('b', 'zz')]);
    toolsRecord(ctx, { task: 'T-1', role: 'reviewer', focus: 'rules+tests', gate: 'REVIEW_SMALL', runtime: 'claude', log });
    const text = readFileSync(fileOf(root), 'utf8');
    assert.ok(!text.includes('SECRET'));
    const o = JSON.parse(text);
    assert.deepEqual(Object.keys(o), ['schema', 'kind', 'time', 'task', 'role', 'focus', 'gate', 'runtime', 'log', 'calls', 'result_bytes', 'denied', 'by_tool', 'reason']);
    assert.equal(o.schema, 'proofline.tools/1'); assert.equal(o.kind, 'step');
    assert.match(o.time, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$/);
    assert.deepEqual([o.task, o.role, o.focus, o.gate, o.runtime, o.log, o.calls, o.result_bytes, o.denied], ['T-1', 'reviewer', 'rules+tests', 'REVIEW_SMALL', 'claude', 'ok', 2, 15, 0]);
    assert.deepEqual(o.by_tool, { Bash: { calls: 1, bytes: 13 }, Read: { calls: 1, bytes: 2 } });
    toolsRecord(ctx, { task: 'T"-1\n', role: 'a b', focus: '', gate: '', runtime: 'claude', log });
    const last = JSON.parse(readFileSync(fileOf(root), 'utf8').trim().split('\n').pop() ?? '');
    assert.equal(last.task, 'T-1'); assert.equal(last.role, 'ab'); assert.equal(last.focus, null); assert.equal(last.gate, null);
  });
  test('a runtime without a readable log writes a record whose counts are null and whose log field says why', () => {
    const { root, ctx } = ctxOf();
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'other', log: '' });
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'claude', log: path.join(root, 'missing.jsonl') });
    const [a, b] = readFileSync(fileOf(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([a.log, a.calls, a.result_bytes, a.denied, a.by_tool], ['no-log', null, null, null, null]);
    assert.deepEqual([b.log, b.calls, b.by_tool], ['unreadable', null, null]);
  });
  test('metrics: off writes nothing; records.jsonl keeps its format', () => {
    const { root, ctx } = ctxOf('canonical_branch: main\nmetrics: off\n');
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'claude', log: '' });
    assert.ok(!existsSync(fileOf(root)));
  });
  test('metricsStep (the step of submit) writes the tools record next to the step record, from line 1 of the .started file', () => {
    const { root, ctx } = ctxOf();
    mkdirSync(path.join(root, '.agents/local/submissions'), { recursive: true });
    const log = writeLog(root, [use('a', 'Bash'), res('a', 'hello'), { type: 'assistant', message: { id: 'msg_01', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 7 } } }]);
    writeFileSync(path.join(root, '.agents/local/submissions/tok.started'), `${log}\n${Math.floor(Date.now() / 1000)}\n`);
    ctx.env.PROOFLINE_DISPATCH_RUNTIME = 'claude';
    metricsStep(ctx, 'T-1', 'verifier', '', 'pass', 'tok');
    const t = JSON.parse(readFileSync(fileOf(root), 'utf8').trim());
    assert.deepEqual([t.task, t.role, t.gate, t.runtime, t.log, t.calls, t.result_bytes], ['T-1', 'verifier', 'VERIFY', 'claude', 'ok', 1, 5]);
    const step = JSON.parse(readFileSync(path.join(root, '.agents/local/metrics/records.jsonl'), 'utf8').trim());
    assert.equal(step.schema, 'proofline.metrics/1');
    assert.equal(Object.keys(step).length, 20);
  });
});

describe('fix round 1 (A235)', () => {
  test('T1: a tool named __proto__ is kept as a plain key, so by_tool sums to calls', () => {
    const dir = makeProject();
    const s = readToolStats(writeLog(dir, [use('a', '__proto__'), res('a', 'xy'), use('b', 'Bash'), res('b', 'z')]));
    assert.equal(s.calls, 2);
    assert.deepEqual(Object.keys(s.byTool ?? {}).sort(), ['Bash', '__proto__']);
    assert.equal(Object.values(s.byTool ?? {}).reduce((a, e) => a + e.calls, 0), s.calls);
  });
  test('T2: a 5 MB tool name and long identifiers are cut to 64 characters; a line stays under 5 KB', () => {
    const { root, ctx } = (() => { const r = makeProject(); const { io } = memoryIo(r); return { root: r, ctx: new Context(io, io.scriptPath ?? '') }; })();
    const log = writeLog(root, [use('a', 'N'.repeat(5 * 1024 * 1024)), res('a', 'x')]);
    const long = 'L'.repeat(5000);
    toolsRecord(ctx, { task: long, role: long, focus: long, gate: long, runtime: long, log });
    const line = readFileSync(path.join(root, '.agents/local/metrics/tools.jsonl'), 'utf8');
    assert.ok(line.length < 5000, `${line.length}`);
    const o = JSON.parse(line);
    assert.equal(o.task.length, 64);
    assert.equal(Object.keys(o.by_tool)[0].length, 64);
  });
  test('T3: a log over 128 MiB is unreadable (null counts), without being read', () => {
    const dir = makeProject();
    const f = path.join(dir, 'big.jsonl');
    const fd = openSync(f, 'w'); ftruncateSync(fd, 128 * 1024 * 1024 + 1); closeSync(fd);
    assert.deepEqual({ ...readToolStats(f) }, { log: 'unreadable', calls: null, resultBytes: null, denied: null, byTool: null, reason: 'too-large' });
  });
  test('T4: a non-string tool name does not throw; a reader that throws gives an unreadable record', () => {
    const { root, ctx } = (() => { const r = makeProject(); const { io } = memoryIo(r); return { root: r, ctx: new Context(io, io.scriptPath ?? '') }; })();
    const log = writeLog(root, [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: { toString: 1 }, input: {} }] } }, res('a', 'x')]);
    const s = readToolStats(log);
    assert.equal(s.log, 'ok'); assert.equal(s.calls, 1);
    assert.deepEqual(Object.keys(s.byTool ?? {}), ['?']);
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'claude', log: root });   // a directory: the read throws
    const o = JSON.parse(readFileSync(path.join(root, '.agents/local/metrics/tools.jsonl'), 'utf8').trim().split('\n').pop() ?? '');
    assert.equal(o.log, 'unreadable'); assert.equal(o.calls, null);
  });
});
