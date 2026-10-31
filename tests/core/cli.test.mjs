// @ts-check
// CLI-only core subcommands (`proofline-core.mjs cli insights|queue`): the front ends of bin/proofline give the same stdout, stderr and exit
// status through the core and through the shell code (PROOFLINE_ENGINE=sh), on a fixture with metrics, ledgers, gate records and results.
// The set is closed: nothing else runs under `cli`, and no name is a command of agent.sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI_COMMANDS } from '../../control-plane/agents/scripts/core/commands/cli.mjs';
import { COMMAND_NAMES } from '../../control-plane/agents/scripts/core/commands/names.mjs';
import { awkStr } from '../../control-plane/agents/scripts/core/insights.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const proofline = path.join(repo, 'bin', 'proofline');
const fx = mkdtempSync(path.join(tmpdir(), 'pl-cli-'));
mkdirSync(path.join(fx, '.agents'), { recursive: true });
cpSync(path.join(repo, 'control-plane', 'agents'), path.join(fx, '.agents'), { recursive: true });
spawnSync('git', ['init', '-q', fx]);
const realConfig = readFileSync(path.join(fx, '.agents', 'config.yaml'), 'latin1');
after(() => rmSync(fx, { recursive: true, force: true }));
const w = (/** @type {string} */ rel, /** @type {string} */ text) => { mkdirSync(path.dirname(path.join(fx, rel)), { recursive: true }); writeFileSync(path.join(fx, rel), text, 'latin1'); };

/** @param {string[]} args @param {'node' | 'sh'} engine @param {Record<string, string>} [env] */
function exec(args, engine, env = {}) {
  const e = { ...process.env, ...env };
  delete e.PROOFLINE_ENGINE; delete e.PROOFLINE_ENGINE_SH; delete e.AGENT_ROLE;
  if (engine === 'sh') e.PROOFLINE_ENGINE = 'sh';
  const r = spawnSync('sh', [proofline, ...args], { cwd: fx, env: e, encoding: 'latin1' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}
/** @param {string[]} args @param {Record<string, string>} [env] */
function same(args, env = {}) {
  const a = exec(args, 'node', env); const b = exec(args, 'sh', env);
  assert.deepEqual(a, b, `proofline ${args.join(' ')}`);
  return a;
}

const rec = (/** @type {Record<string, string | number | null>} */ o) => JSON.stringify({ schema: 'proofline.metrics/1', time: '2026-10-31T10:00:00Z', ...o });
const METRICS = [
  rec({ kind: 'dispatch', task: 'R1', role: 'implementer', model: 'opus', duration_s: 120, tokens_in: 1000, tokens_out: 200, tokens_total: 1200, retries: 1 }),
  rec({ kind: 'dispatch', task: 'R1', role: 'reviewer', model: 'sonnet', duration_s: 60, tokens_in: null, tokens_out: null, tokens_total: null, retries: 0 }),
  rec({ kind: 'dispatch', task: 'R1', role: 'qa', model: 'sonnet', duration_s: 30, tokens_in: 500, tokens_out: 100, tokens_total: 600, retries: 0 }),
  rec({ kind: 'dispatch', task: 'R2', role: '', model: '', duration_s: 10, tokens_in: 5, tokens_out: 5, tokens_total: 10, retries: 2 }),
  rec({ kind: 'run', task: 'R1', result: 'DONE', duration_s: 900, delegations: 3, fix_rounds: 1, size: 'S', scope_paths: 2 }),
  rec({ kind: 'run', task: 'R1', result: 'FAILED', duration_s: 1, delegations: 0, fix_rounds: 0 }),
  rec({ kind: 'run', task: 'R2', result: 'DONE', duration_s: 1800, delegations: 4, fix_rounds: 2, size: 'S', scope_paths: 4 }),
  rec({ kind: 'run', task: 'R4', result: 'DONE', duration_s: 3000, delegations: 4, fix_rounds: 0, size: 'M', scope_paths: 3 }),
  rec({ kind: 'run', task: 'R5', result: 'DONE', duration_s: 700, delegations: 1, fix_rounds: 0, size: 'S', scope_paths: 1 }),
  rec({ kind: 'run', task: 'R6', result: 'DONE', duration_s: 4000, delegations: 1, fix_rounds: 0, size: 'M', scope_paths: 5 }),
  rec({ kind: 'run', task: 'R7', result: 'DONE', duration_s: 5000, delegations: 1, fix_rounds: 0, size: 'M', scope_paths: 7 }),
  rec({ kind: 'run', task: 'R8', result: 'DONE', duration_s: 4001, delegations: 1, fix_rounds: 0, size: 'L', scope_paths: 9 }),
  rec({ kind: 'run', task: 'R9', result: 'DONE', duration_s: 4002, delegations: 1, fix_rounds: 0, size: 'L', scope_paths: 9 }),
  rec({ kind: 'run', task: 'R10', result: 'DONE', duration_s: 4003, delegations: 1, fix_rounds: 0, size: 'L' }),
  JSON.stringify({ schema: 'other/1', kind: 'run', task: 'RX' }),
  'not json at all', '', '   ', '{"schema":"proofline.metrics/1","kind":"dispatch","task":"","role":"x"}',
  '{"schema":"proofline.metrics/1","kind":"dispatch","task":"R3","role":"a\\"b","model":"m\\\\x","duration_s":"7","tokens_in":3}',
].join('\n') + '\n';

function setup() {
  w('.agents/config.yaml', realConfig);
  w('.agents/local/metrics/records.jsonl', METRICS);
  const fail = (/** @type {string} */ g, /** @type {string} */ n) => `seq=1 prev=0 event=gate:${g}:fail detail=gates/${n}-${g}.yaml@abc123`;
  for (const [run, n] of [['R1', 2], ['R2', 2], ['R3', 1]]) {
    const ledger = [
      fail('QA', '001'), fail('SECURITY', '002'), `seq=2 prev=x event=gate:QA:pass detail=gates/003-QA.yaml@def`, `seq=3 event=record:review detail=results/review.result.md more`,
      'seq=4 event=approval-request detail=plan', 'seq=5 event=approval-request detail=plan', 'seq=6 event=approval detail=plan x', 'seq=7 event=approval-request detail=approvals/007.md scope', 'seq=8 event=approval-request detail=approvals/008.md scope',
      'a row without an event', 'seq=9 event=gate:VERIFY:fail detail=nothing',
    ];
    if (run === 'R3') ledger.length = 3;
    w(`.agents/runs/${run}/LEDGER.log`, `${ledger.join('\n')}\n`);
    const fin = (/** @type {string} */ id, /** @type {string} */ sev, /** @type {string} */ p, /** @type {string} */ t) => `finding: ${id}|${sev}|${p}|${t}`;
    w(`.agents/runs/${run}/gates/001-QA.yaml`, `result: fail\n${fin('F1', 'blocking', 'src/a.js:12', 'the  same   failure text')}\n${fin('F2', 'blocking', 'src/b.js', 'path is outside the plan scope')}\n${fin('F3', 'minor', 'x', 'minor one')}\nother: line\n`);
    w(`.agents/runs/${run}/gates/002-SECURITY.yaml`, `result: fail\n${fin('F4', 'blocking', 'src/c.js:3', 'Unauthorized path used')}\n${fin('F5', 'blocking', 'a', 'b')}\nfinding: short|blocking\n`);
    w(`.agents/runs/${run}/gates/009-QA.yaml`, `${fin('F9', 'blocking', 'src/a.js', 'unbound record')}\n`);
    w(`.agents/runs/${run}/results/review.result.md`, 'UNSUPPORTED: no browser   available\nok line\nUNSUPPORTED: x\n');
  }
  mkdirSync(path.join(fx, '.agents/runs/R11'), { recursive: true });
  w('.agents/tasks/todo/T-1-x.md', '# Task: T-1\n'); w('.agents/tasks/backlog/T-2-y.md', '# Task: T-2\n'); w('.agents/tasks/T-3.md', 'x\n'); w('.agents/tasks/note.txt', 'x\n');
  for (let i = 1; i <= 23; i++) w(`.agents/tasks/done/T-${String(100 + i)}.md`, i % 3 === 0 ? 'no heading\n' : i % 5 === 0 ? '#\n**Status:**\n' : `# Task: T-${i} title\n\n**Status:**   done  \n**Status:** later\n`);
}
setup();

describe('cli subcommands through the front ends', () => {
  test('insights: text, json, run filter, off, empty states', () => {
    for (const args of [['insights'], ['insights', '--json'], ['insights', '--run', 'R1'], ['insights', '--run=R2', '--json'], ['insights', '--run', 'R3'], ['insights', '--run', 'NOPE'], ['insights', '--run', 'R11'], ['insights', '--run', 'bad id'], ['insights', '--bogus'], ['insights', '--help'], ['insights', '--run']])
      same(args);
    const text = same(['insights']);
    assert.match(text.out, /RECURRING FAILURES/);
    assert.match(text.out, /gate-fail x/);
    w('.agents/config.yaml', `${realConfig}\nmetrics: off\n`);
    same(['insights']); same(['insights', '--json']);
    w('.agents/config.yaml', realConfig);
    w('.agents/local/metrics/records.jsonl', '');
    same(['insights']); same(['insights', '--json']);
    rmSync(path.join(fx, '.agents/local/metrics/records.jsonl'));
    same(['insights']); same(['insights', '--json']);
    w('.agents/local/metrics/records.jsonl', METRICS);
  });

  test('insights: calibration text and many sizes, unmet approvals across runs', () => {
    same(['insights']);
    const keep = readFileSync(path.join(fx, '.agents/local/metrics/records.jsonl'), 'latin1');
    w('.agents/local/metrics/records.jsonl', METRICS.split('\n').filter((l) => !l.includes('"M"') && !l.includes('R10')).join('\n'));
    same(['insights']); same(['insights', '--json']);
    w('.agents/local/metrics/records.jsonl', keep);
  });

  test('queue: tasks, done list, runs and the active run', () => {
    same(['queue']);
    w('.agents/config.yaml', `${realConfig}\ntasks:\n  dir: .agents/tasks\n`);
    same(['queue']);
    rmSync(path.join(fx, '.agents/tasks'), { recursive: true, force: true });
    same(['queue']);
    w('.agents/config.yaml', realConfig);
    setup();
  });

  test('the engine switch: sh:insights and PROOFLINE_ENGINE_SH keep the shell form', () => {
    const a = exec(['insights'], 'node', { PROOFLINE_ENGINE_SH: 'insights' });
    const b = exec(['insights'], 'sh');
    assert.deepEqual(a, b);
    w('.agents/local/engine', 'sh:queue,insights\n');
    assert.deepEqual(exec(['insights'], 'node'), b);
    rmSync(path.join(fx, '.agents/local/engine'));
  });
});

describe('the closed set of CLI-only subcommands', () => {
  const core = path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs');
  test('exactly insights and queue; none is an agent.sh command', () => {
    assert.deepEqual(Object.keys(CLI_COMMANDS).sort(), ['insights', 'queue']);
    for (const n of Object.keys(CLI_COMMANDS)) assert.ok(!COMMAND_NAMES.includes(n), n);
    assert.ok(!COMMAND_NAMES.includes('cli'));
    assert.throws(() => { CLI_COMMANDS.extra = () => 0; });
  });
  test('any other name, and agent.sh commands under cli, are refused with status 2 and no output', () => {
    for (const name of ['role', 'next', 'debt', 'status', '', 'INSIGHTS', 'constructor', '__proto__', 'toString']) {
      const r = spawnSync('node', [core, 'cli', name], { cwd: fx, encoding: 'latin1', env: { ...process.env, PROOFLINE_ENGINE: '' } });
      assert.equal(r.status, 2, name); assert.equal(r.stdout, ''); assert.match(r.stderr, /not a CLI subcommand/);
    }
    assert.equal(spawnSync('node', [core, 'cli', 'queue', 'extra'], { cwd: fx, encoding: 'latin1' }).status, 2);
    assert.equal(spawnSync('node', [core, 'cli', 'insights', '--run', 'a b'], { cwd: fx, encoding: 'latin1' }).status, 2);
  });
  test('they write nothing: the fixture tree is unchanged by insights and queue', () => {
    const snap = () => spawnSync('sh', ['-c', 'find . -type f -exec cksum {} + | sort'], { cwd: path.join(fx, '.agents'), encoding: 'latin1' }).stdout;
    const before = snap();
    for (const a of [['insights'], ['insights', '--json'], ['queue']]) spawnSync('node', [core, 'cli', ...a], { cwd: fx, encoding: 'latin1' });
    assert.equal(snap(), before);
  });
});

describe('awk number text', () => {
  test('integers plain, other numbers with %.6g', () => {
    for (const [x, s] of /** @type {Array<[number, string]>} */ ([[0, '0'], [15, '15'], [12.5, '12.5'], [3.3333333, '3.33333'], [1234567.5, '1.23457e+06'], [0.00001234, '1.234e-05'], [0.5, '0.5']])) assert.equal(awkStr(x), s, String(x));
  });
});
