// @ts-check
// The pure text rules of the dispatcher (A226): what a log says about a failure, the token totals, the result of claude's JSON, the --agents JSON, a template.
// The cases are those of the old dispatch-test.sh and of the review rounds that shaped the rules (A124, A127, A200, A203).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, describe } from 'node:test';
import { cksum } from '../../control-plane/agents/scripts/core/dispatcher.mjs';
import * as dt from '../../control-plane/agents/scripts/core/dispatchtext.mjs';

describe('a runtime failure (D7) is told from a task failure by the tail of the log', () => {
  test('limits, quotas, rate limits, 429 and overload are a limit; a login or authorization problem is auth; a lost API is network', () => {
    for (const t of ["ERROR: You've hit your usage limit. Try again later.", 'Claude AI usage limit reached|1760000000', 'rate_limit_error', 'Rate-limit hit', 'quota exceeded', 'too many requests', 'HTTP 429', 'limit reached', 'API overloaded']) assert.equal(dt.runtimeFailureReason(`${t}\n`), 'limit', t);
    for (const t of ['Not logged in', 'Unauthorized', 'authentication failed', 'invalid api key', 'please run codex login', 'HTTP 401']) assert.equal(dt.runtimeFailureReason(`${t}\n`), 'auth', t);
    for (const t of ['error sending request for url', 'workspace routing discovery failed', 'Reconnecting... 5/5']) assert.equal(dt.runtimeFailureReason(`${t}\n`), 'runtime_unavailable:network', t);
    for (const t of ['error: tests failed in src/x', 'build 1429 files', 'port 14290 open', 'status 4010']) assert.equal(dt.runtimeFailureReason(`${t}\n`), 'none', t);
  });
  test('only the last 60 lines count, and the network class wins over the limit class', () => {
    const old = `usage limit\n${'line\n'.repeat(60)}`;
    assert.equal(dt.runtimeFailureReason(old), 'none');
    assert.equal(dt.runtimeFailureReason('usage limit\nerror sending request\n'), 'runtime_unavailable:network');
  });
  test('a dropped connection or a TLS failure is transient (A200); a sandbox that blocks the network is not', () => {
    for (const t of ['error: SSL_ERROR_SYSCALL: connection reset by peer', 'TLS handshake failed', 'ECONNRESET', 'socket hang up', 'stream disconnected before completion', 'broken pipe', 'temporary failure in name resolution', 'Reconnecting... 2/5', 'error sending request: SSL handshake failed']) assert.equal(dt.transientNetwork(`${t}\n`), true, t);
    for (const t of ['workspace routing discovery failed: error sending request', 'error: tests failed', 'class SSLContext added', 'whistle']) assert.equal(dt.transientNetwork(`${t}\n`), false, t);
  });
  test('the Codex sandbox refusal of a git worktree write is recognised (A203), a refusal of something else is not', () => {
    assert.equal(dt.worktreeSandboxRefusal('fatal: cannot create worktree: Operation not permitted\n'), true);
    assert.equal(dt.worktreeSandboxRefusal('.git/worktrees/x: read-only file system\n'), true);
    assert.equal(dt.worktreeSandboxRefusal('write denied: src/a.js\n'), false);
  });
  test('tailLines is tail -n', () => {
    assert.deepEqual(dt.tailLines('a\nb\nc\n', 2), ['b', 'c']);
    assert.deepEqual(dt.tailLines('a\nb', 5), ['a', 'b']);
    assert.deepEqual(dt.tailLines('', 5), []);
  });
});

describe('the token totals a runtime reports (A80, A200)', () => {
  test('codex: the number after the "tokens used" trailer, in the local format, read from the last three non-empty lines before the final message', () => {
    assert.equal(dt.codexTotal('free text\n', 'tokens used\n12,345\n'), '12345');
    assert.equal(dt.codexTotal('agent says: tokens used 5\n', 'tokens used\n12,345\n'), '12345');
    assert.equal(dt.codexTotal('Built 83 pages.\nAll tests pass.\n', 'hook: Stop Completed\ntokens used\n285.242\nBuilt 83 pages.\nAll tests pass.\n'), '285242');
    assert.equal(dt.codexTotal('Line one.\n\nLine three.\nLine four.', 'hook: Stop Completed\ntokens used\n96.739\nLine one.\n\nLine three.\nLine four.\n'), '96739');
    assert.equal(dt.codexTotal('', 'ERROR: usage limit\ntokens used\n52.623\n'), '52623');
    assert.equal(dt.codexTotal('tokens used 5 \n', 'tokens used 7\n'), '7', 'the same line on one row');
  });
  test('a "tokens used" line earlier in the log (model text) with no trailer stays null', () => {
    assert.equal(dt.codexTotal('x\n', 'tokens used 999\nmore\nmore\nmore\nlast line\n'), '');
    assert.equal(dt.codexTotal('', 'nothing\n'), '');
  });
  test('claude: the last usage object of the last line that has one, first 400 characters; its numbers; the first num_turns of the log', () => {
    const log = '{"type":"result","num_turns":4,"result":"claims \\"input_tokens\\": 999999 and num_turns 77","usage":{"input_tokens":120,"cache_creation_input_tokens":7,"cache_read_input_tokens":50,"output_tokens":30,"iterations":[{"input_tokens":2,"output_tokens":7}]},"modelUsage":{"m":{"inputTokens":1}}}\n';
    const u = dt.claudeUsage(log);
    assert.equal(dt.usageNumber(u, 'input_tokens'), '120');
    assert.equal(dt.usageNumber(u, 'cache_creation_input_tokens'), '7');
    assert.equal(dt.usageNumber(u, 'output_tokens'), '30');
    assert.equal(dt.numFirst(log, 'num_turns'), '4');
    assert.equal(dt.numFirst('nothing', 'num_turns'), '');
    assert.equal(dt.addN('12', ''), '12'); assert.equal(dt.addN('3', '4'), '7'); assert.equal(dt.addN('', '4'), '4'); assert.equal(dt.addN('abc', '4'), '4');
  });
  test('claude: the result string is unescaped (\\n, \\t, \\", a \\uXXXX escape kept as written); an error result is an error', () => {
    assert.equal(dt.claudeResult('{"type":"result","is_error":false,"result":"said \\"hi\\" \\\\ ok\\nline\\ttab \\u00e7","session_id":"x"}\n'), 'said "hi" \\ ok\nline\ttab \\u00e7\n');
    assert.equal(dt.claudeResult('{"no":"result"}'), null);
    assert.equal(dt.claudeIsError('{"is_error": true,"result":"x"}'), true);
    assert.equal(dt.claudeIsError('{"is_error":false}'), false);
  });
});

describe('the --agents JSON and the command template', () => {
  test('jsonStr: backslash, quote, tab and CR escaped, lines joined by \\n, the final newline is not a line; other control characters are escaped as well', () => {
    assert.equal(dt.jsonStr('a\n'), '"a"');
    assert.equal(dt.jsonStr('a\nb'), '"a\\nb"');
    assert.equal(dt.jsonStr('a\n\nb\n'), '"a\\n\\nb"');
    assert.equal(dt.jsonStr('t\t"q" \\ r\r\n'), '"t\\t\\"q\\" \\\\ r\\r"');
    assert.equal(dt.jsonStr(''), '""');
    assert.equal(dt.jsonStr('a\u001bb\fc'), '"a\\u001bb\\u000cc"');
    for (const t of ['x\n', 'a\u001b\fb\t"\\\r\nc\n\n']) assert.doesNotThrow(() => JSON.parse(dt.jsonStr(t)));
  });
  test('spawnTool: Agent and Task, with or without a pattern, anywhere in a list', () => {
    for (const t of ['Agent', 'Task', 'Task(x)', 'Agent(explorer)', 'Read, Task, Bash', 'Read,Agent']) assert.equal(dt.spawnTool(t), true, t);
    for (const t of ['Read, Grep', 'TaskList', 'AgentX', 'Bash(git status)']) assert.equal(dt.spawnTool(t), false, t);
  });
  test('toolsRow and agentsJson: the row of the role, minus Agent/Task; no row or an empty one is the default list', () => {
    assert.equal(dt.toolsRow('reviewer Read,Grep,Agent\nqa Read\n', 'reviewer'), ' Read,Grep,Agent');
    assert.equal(dt.toolsRow('reviewer\n', 'reviewer'), '');
    assert.equal(dt.toolsRow('x Read\n', 'reviewer'), '');
    assert.equal(dt.agentsJson('proofline-reviewer', 'Body\n', 'reviewer', ' Read,Grep,Agent,Task(x),Bash'), '{"proofline-reviewer":{"description":"proofline reviewer","prompt":"Body","tools":["Read","Grep","Bash"]}}');
    assert.equal(dt.agentsJson('n', 'B', 'qa', ''), '{"n":{"description":"proofline qa","prompt":"B","tools":["Read","Grep","Glob","Bash","Write","Edit"]}}');
    assert.equal(dt.agentsJson('n', 'B', 'qa', ' , '), '{"n":{"description":"proofline qa","prompt":"B","tools":["Read","Grep","Glob","Bash","Write","Edit"]}}');
  });
  test('shellQuote and subst: a value is one shell word, the inserted text is not scanned again', () => {
    assert.equal(dt.shellQuote("it's"), "'it'\\''s'");
    const r = spawnSync('sh', ['-c', `printf '%s' ${dt.shellQuote("a b'c$d")}`], { encoding: 'utf8' });
    assert.equal(r.stdout, "a b'c$d");
    assert.equal(dt.subst('run {model} {model} {x}', 'model', 'm'), 'run m m {x}');
    assert.equal(dt.subst('{a}{b}', 'a', '{b}'), '{b}{b}');
  });
  test('validToken: letters, digits and . _ + : -, never a leading dash, never empty', () => {
    for (const t of ['T-1', 'gpt-6-sol', 'a.b_c+d:e', 'high']) assert.equal(dt.validToken(t), true, t);
    for (const t of ['', '-x', 'a b', 'a;b', 'a$b', "a'b", 'ç']) assert.equal(dt.validToken(t), false, t);
  });
});

describe('cksum (the explorer\'s own resume note is named by the cksum of its assignment)', () => {
  test('equals the system cksum on a corpus of byte strings', () => {
    for (const text of ['', 'a', 'assignment one\n', 'x'.repeat(1000), 'Çalışma\n', Buffer.from([0, 1, 2, 255, 254]).toString('latin1')]) {
      const sys = spawnSync('cksum', [], { input: Buffer.from(text, 'latin1') }).stdout.toString().split(' ')[0];
      assert.equal(cksum(Buffer.from(text, 'latin1')), sys, JSON.stringify(text.slice(0, 20)));
    }
  });
});
