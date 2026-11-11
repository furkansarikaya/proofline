// @ts-check
// A255 (#181): the Codex reader of the per-step tool record. The logs are hand-made (event kinds and field names as the structure of a real rollout log shows them, no real session
// content). Time is fixed (mock Date) wherever the code looks for a day directory.
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { metricsStep } from '../../control-plane/agents/scripts/core/resultutil.mjs';
import { codexDayDirs, findCodexRollout, readCodexToolStats, toolsRecord } from '../../control-plane/agents/scripts/core/toolstats.mjs';
import { makeProject, memoryIo } from './helpers.mjs';

const SID = '01a18804-2a27-7012-97d9-5144592a8a61';
const NOON = Date.UTC(2026, 10, 11, 12, 0, 0) / 1000;      // 2026-11-11T12:00:00Z
const jsonl = (/** @type {unknown[]} */ e) => `${e.map((x) => JSON.stringify(x)).join('\n')}\n`;
const item = (/** @type {Record<string, unknown>} */ payload) => ({ timestamp: 't', ordinal: 1, type: 'response_item', payload });
const call = (/** @type {string} */ id, /** @type {string} */ name) => item({ type: 'custom_tool_call', id: 'x', status: 'completed', call_id: id, name, input: 'SECRET-INPUT' });
const out = (/** @type {string} */ id, /** @type {unknown} */ output) => item({ type: 'custom_tool_call_output', id: 'y', call_id: id, output });
const text = (/** @type {string} */ t) => [{ type: 'input_text', text: t }];
const meta = { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { id: SID } };
const BLOCKED = 'Error:\nCommand blocked by PreToolUse hook: proofline: a model command never starts Node';

/** @param {string} dir @param {unknown[]} e */
function writeLog(dir, e, name = 'rollout.jsonl') { const f = path.join(dir, name); writeFileSync(f, jsonl(e)); return f; }

afterEach(() => { mock.timers.reset(); });

describe('readCodexToolStats', () => {
  test('counts calls once per id, result bytes in UTF-8, refused calls, several event kinds; events that are not tool items are ignored', () => {
    const dir = makeProject();
    const f = writeLog(dir, [
      meta,
      { type: 'event_msg', payload: { type: 'task_started' } },
      item({ type: 'message', role: 'user', content: [] }),
      item({ type: 'reasoning', summary: [] }),
      call('c1', 'exec'),
      call('c1', 'exec'),                                    // the same id again: counted once
      { type: 'event_msg', payload: { type: 'item_completed', call_id: 'c1' } },
      out('c1', text('héllo')),                              // 6 bytes
      out('c1', text('second answer is ignored')),
      call('c2', 'wait'), out('c2', 'plain string'),         // 12 bytes
      item({ type: 'function_call', call_id: 'c3', name: 'shell', arguments: '{}' }), item({ type: 'function_call_output', call_id: 'c3', output: BLOCKED }),
      item({ type: 'local_shell_call', call_id: 'c4' }), item({ type: 'function_call_output', call_id: 'c4', output: [{ type: 'output_text', text: 'ab' }, { type: 'x' }] }),
      item({ type: 'tool_search_call', call_id: 'c5' }), item({ type: 'tool_search_output', call_id: 'c5', output: 'q' }),
      item({ type: 'web_search_call', id: 'w' }),            // no call id: not counted
      call('c6', 'exec'),                                    // no result yet (the submit itself): 0 bytes
    ]);
    const s = readCodexToolStats(f);
    assert.equal(s.log, 'ok'); assert.equal(s.reason, null);
    assert.equal(s.calls, 6);
    assert.equal(s.resultBytes, 6 + 12 + Buffer.byteLength(BLOCKED) + 2 + 1);
    assert.equal(s.denied, 1);
    assert.deepEqual(s.byTool, {
      exec: { calls: 2, bytes: 6 }, local_shell: { calls: 1, bytes: 2 }, shell: { calls: 1, bytes: Buffer.byteLength(BLOCKED) }, tool_search: { calls: 1, bytes: 1 }, wait: { calls: 1, bytes: 12 },
    });
  });
  test('a result that mentions the hook text only after 300 characters is not a refusal', () => {
    const dir = makeProject();
    const s = readCodexToolStats(writeLog(dir, [meta, call('a', 'exec'), out('a', text(`${'x'.repeat(300)}blocked by PreToolUse hook`))]));
    assert.equal(s.denied, 0);
  });
  test('a multi-byte character across a 64 KiB read boundary is counted once, in bytes', () => {
    const dir = makeProject();
    const big = 'é'.repeat(70000);
    const s = readCodexToolStats(writeLog(dir, [meta, call('a', 'exec'), out('a', text(big)), call('b', 'exec'), out('b', text('z'))]));
    assert.equal(s.resultBytes, 140000 + 1);
    assert.equal(s.calls, 2);
  });
  test('names are reduced and cut to 64 characters, __proto__ is an ordinary key, at most 40 names are kept', () => {
    const dir = makeProject();
    const e = [meta, call('a', '__proto__'), out('a', 'x'), call('b', 'we ird"\nname'), out('b', 'x'), call('l', 'N'.repeat(5000)), out('l', 'x'), call('a2', '__proto__'), call('b2', 'we ird"\nname'), call('l2', 'N'.repeat(5000))];
    for (let i = 0; i < 45; i++) e.push(call(`m${i}`, `t${i}`), out(`m${i}`, 'y'));
    const s = readCodexToolStats(writeLog(dir, e));
    const keys = Object.keys(s.byTool ?? {});
    assert.ok(keys.includes('__proto__') && keys.includes('weirdname'));
    assert.ok(keys.every((k) => k.length <= 64));
    assert.equal(keys.length, 41);
    assert.equal(Object.values(s.byTool ?? {}).reduce((a, x) => a + x.calls, 0), s.calls);
    assert.equal(s.calls, 51);
  });
  test('a malformed line in the middle makes the log malformed (null counts); an unfinished last line is ignored; a complete last line without a newline counts', () => {
    const dir = makeProject();
    const bad = path.join(dir, 'bad.jsonl');
    writeFileSync(bad, `${JSON.stringify(meta)}\n${JSON.stringify(call('a', 'exec'))}\n{not json}\n${JSON.stringify(out('a', 'x'))}\n`);
    assert.deepEqual({ ...readCodexToolStats(bad) }, { log: 'malformed', calls: null, resultBytes: null, denied: null, byTool: null, reason: 'bad-line' });
    const live = path.join(dir, 'live.jsonl');
    writeFileSync(live, `${JSON.stringify(meta)}\n${JSON.stringify(call('a', 'exec'))}\n${JSON.stringify(out('a', 'xyz'))}\n{"type":"response_item","payload":{"type":"custom_tool_c`);
    const l = readCodexToolStats(live);
    assert.deepEqual([l.log, l.calls, l.resultBytes], ['ok', 1, 3]);
    const nolf = path.join(dir, 'nolf.jsonl');
    writeFileSync(nolf, `${JSON.stringify(meta)}\n${JSON.stringify(call('a', 'exec'))}\n${JSON.stringify(out('a', 'xy'))}`);
    const n = readCodexToolStats(nolf);
    assert.deepEqual([n.log, n.calls, n.resultBytes], ['ok', 1, 2]);
    const broken = path.join(dir, 'broken-last.jsonl');
    writeFileSync(broken, `${JSON.stringify(meta)}\n${JSON.stringify(call('a', 'exec'))}\n{broken\n`);
    assert.deepEqual([readCodexToolStats(broken).log, readCodexToolStats(broken).calls], ['ok', 1]);
  });
  test('a log that is no rollout (no event has a string type, or it is empty) is malformed with a reason, never zero calls', () => {
    const dir = makeProject();
    const a = writeLog(dir, [{ hello: 1 }, [1, 2], 'str'], 'a.jsonl');
    assert.deepEqual([readCodexToolStats(a).log, readCodexToolStats(a).reason, readCodexToolStats(a).calls], ['malformed', 'no-events', null]);
    writeFileSync(path.join(dir, 'empty.jsonl'), '');
    assert.equal(readCodexToolStats(path.join(dir, 'empty.jsonl')).log, 'malformed');
  });
  test('a missing file, a directory, a log over 128 MiB and a line over 32 MiB are unreadable, each with its reason', () => {
    const dir = makeProject();
    assert.deepEqual([readCodexToolStats(path.join(dir, 'nope.jsonl')).log, readCodexToolStats(path.join(dir, 'nope.jsonl')).reason], ['unreadable', 'read-error']);
    assert.equal(readCodexToolStats(dir).reason, 'not-a-file');
    const big = path.join(dir, 'big.jsonl');
    const fd = openSync(big, 'w'); ftruncateSync(fd, 128 * 1024 * 1024 + 1); closeSync(fd);
    assert.deepEqual([readCodexToolStats(big).log, readCodexToolStats(big).reason, readCodexToolStats(big).calls], ['unreadable', 'too-large', null]);
    const wide = path.join(dir, 'wide.jsonl');
    writeFileSync(wide, `${JSON.stringify(meta)}\n"${'a'.repeat(33 * 1024 * 1024)}"\n`);
    assert.deepEqual([readCodexToolStats(wide).log, readCodexToolStats(wide).reason], ['unreadable', 'line-too-long']);
  });
});

describe('findCodexRollout', () => {
  /** @param {string} home @param {string} day @param {string} sid */
  function put(home, day, sid = SID) {
    const d = path.join(home, '.codex/sessions', day); mkdirSync(d, { recursive: true });
    const f = path.join(d, `rollout-2026-11-11T09-00-00-${sid}.jsonl`); writeFileSync(f, jsonl([meta])); return f;
  }
  test('the rollout is found by the session id: CODEX_THREAD_ID or CODEX_SESSION_ID, HOME/.codex or CODEX_HOME, today or up to 3 days back', () => {
    const home = makeProject();
    const f = put(home, '2026/11/11');
    assert.deepEqual(findCodexRollout({ CODEX_THREAD_ID: SID, HOME: home }, NOON), { file: f, reason: null });
    assert.equal(findCodexRollout({ CODEX_SESSION_ID: SID.toUpperCase(), HOME: home }, NOON).file, f);
    assert.equal(findCodexRollout({ CODEX_THREAD_ID: SID, CODEX_HOME: path.join(home, '.codex'), HOME: '/nonexistent' }, NOON).file, f);
    assert.equal(findCodexRollout({ CODEX_THREAD_ID: SID, HOME: home }, NOON + 3 * 86400).file, f);
    assert.deepEqual(findCodexRollout({ CODEX_THREAD_ID: SID, HOME: home }, NOON + 5 * 86400), { file: '', reason: 'no-rollout' });
  });
  test('no id, a malformed id, no home and a file of another session each give a reason and no path', () => {
    const home = makeProject();
    put(home, '2026/11/11');
    assert.equal(findCodexRollout({ HOME: home }, NOON).reason, 'no-session-id');
    for (const bad of ['../../etc/passwd', `${SID}/../x`, SID.slice(0, 35), `${SID}x`, '*']) assert.equal(findCodexRollout({ CODEX_THREAD_ID: bad, HOME: home }, NOON).reason, 'no-session-id', bad);
    assert.equal(findCodexRollout({ CODEX_THREAD_ID: SID }, NOON).reason, 'no-codex-home');
    assert.equal(findCodexRollout({ CODEX_THREAD_ID: SID, HOME: 'relative' }, NOON).reason, 'no-codex-home');
    assert.equal(findCodexRollout({ CODEX_THREAD_ID: '01a18804-2a27-7012-97d9-000000000000', HOME: home }, NOON).reason, 'no-rollout');
  });
  test('a symbolic link with the right name is not followed', () => {
    const home = makeProject();
    const d = path.join(home, '.codex/sessions/2026/11/11'); mkdirSync(d, { recursive: true });
    const target = path.join(home, 'elsewhere.jsonl'); writeFileSync(target, jsonl([meta]));
    symlinkSync(target, path.join(d, `rollout-2026-11-11T09-00-00-${SID}.jsonl`));
    assert.equal(findCodexRollout({ CODEX_THREAD_ID: SID, HOME: home }, NOON).reason, 'no-rollout');
  });
  test('the day directories follow the local day and the UTC day (rollover, DST, far-east and far-west zones)', () => {
    const tz = process.env.TZ;
    try {
      const at = Date.UTC(2026, 10, 11, 23, 30, 0) / 1000;      // 23:30Z on the 11th: already the 12th in Auckland, still the 11th in Los Angeles
      process.env.TZ = 'Pacific/Auckland';
      assert.deepEqual(codexDayDirs(at), ['2026/11/12', '2026/11/11', '2026/11/10', '2026/11/09', '2026/11/08']);   // the last one is the UTC day of the oldest local day
      process.env.TZ = 'America/Los_Angeles';
      assert.deepEqual(codexDayDirs(at).slice(0, 1), ['2026/11/11']);
      assert.equal(codexDayDirs(at).length, 4);
      process.env.TZ = 'UTC';
      assert.deepEqual(codexDayDirs(Date.UTC(2026, 2, 1, 0, 0, 0) / 1000), ['2026/03/01', '2026/02/28', '2026/02/27', '2026/02/26']);   // month rollover, 2026 is no leap year
      process.env.TZ = 'Europe/Berlin';                                                                                          // the DST change of 2026-10-25 (25 hours)
      assert.equal(codexDayDirs(Date.UTC(2026, 9, 26, 10, 0, 0) / 1000).includes('2026/10/25'), true);
    } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  });
});

describe('the Codex tools.jsonl record', () => {
  function ctxOf() {
    const root = makeProject();
    const { io } = memoryIo(root, { HOME: root });
    return { root, ctx: new Context(io, io.scriptPath ?? '') };
  }
  const lines = (/** @type {string} */ root) => readFileSync(path.join(root, '.agents/local/metrics/tools.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  test('toolsRecord reads the file with the Codex reader; an empty path is unreadable with the reason of the search, not no-log', () => {
    const { root, ctx } = ctxOf();
    const log = writeLog(root, [meta, call('a', 'exec'), out('a', 'hello'), call('b', 'exec'), out('b', BLOCKED)]);
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'codex', log });
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'codex', log: '', reason: 'no-rollout' });
    toolsRecord(ctx, { task: 'T-1', role: 'qa', focus: '', gate: 'QA', runtime: 'codex', log: '' });
    const [a, b, c] = lines(root);
    assert.deepEqual([a.log, a.calls, a.result_bytes, a.denied, a.reason, a.runtime], ['ok', 2, 5 + Buffer.byteLength(BLOCKED), 1, null, 'codex']);
    assert.deepEqual(a.by_tool, { exec: { calls: 2, bytes: 5 + Buffer.byteLength(BLOCKED) } });
    assert.deepEqual([b.log, b.calls, b.by_tool, b.reason], ['unreadable', null, null, 'no-rollout']);
    assert.equal(c.reason, 'no-rollout');
    assert.ok(!readFileSync(path.join(root, '.agents/local/metrics/tools.jsonl'), 'utf8').includes('SECRET'));
  });
  test('metricsStep (submit) of a Codex worker finds the rollout by CODEX_THREAD_ID and writes its counts; without the id it records why not', () => {
    mock.timers.enable({ apis: ['Date'], now: NOON * 1000 });
    const { root, ctx } = ctxOf();
    const d = path.join(root, '.codex/sessions/2026/11/11'); mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, `rollout-2026-11-11T09-00-00-${SID}.jsonl`), jsonl([meta, call('a', 'exec'), out('a', 'hello'), call('b', 'exec')]));
    ctx.env.PROOFLINE_DISPATCH_RUNTIME = 'codex';
    ctx.env.CODEX_THREAD_ID = SID;
    metricsStep(ctx, 'T-1', 'verifier', '', 'pass', 'tok');
    delete ctx.env.CODEX_THREAD_ID;
    metricsStep(ctx, 'T-1', 'verifier', '', 'pass', 'tok');
    const [a, b] = lines(root);
    assert.deepEqual([a.runtime, a.log, a.calls, a.result_bytes, a.reason], ['codex', 'ok', 2, 5, null]);
    assert.deepEqual([b.runtime, b.log, b.calls, b.reason], ['codex', 'unreadable', null, 'no-session-id']);
  });
});
