// @ts-check
// The nine library commands against the shell, on fixture runs built with the self-test helpers (test-lib.sh): the same stdout, stderr
// and exit status through the Node core and through the shell code (PROOFLINE_ENGINE=sh), for every gate state, tier, risk signal and
// ledger fault below. The shell is the specification. Each state builds its own tree (tests run in parallel).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { repo, scriptsDir } from './helpers.mjs';

const ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};
/** @type {string[]} */ const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** Build a fixture run with the self-test helpers, then put the Node core beside its agent.sh. @param {string} snippet */
function build(snippet) {
  const out = mkdtempSync(path.join(tmpdir(), 'pl-libeq-'));
  made.push(out);
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${snippet}\ncp -R "$PWD/." "$EQ_OUT/"`, path.join(scriptsDir, 'x.sh')],
    { env: { ...ENV, EQ_LIB: path.join(scriptsDir, 'test-lib.sh'), EQ_OUT: out }, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error(`fixture failed: ${snippet}\n${r.stderr}${r.stdout}`);
  cpSync(path.join(scriptsDir, 'proofline-core.mjs'), path.join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scriptsDir, 'core'), path.join(out, '.agents/scripts/core'), { recursive: true });
  spawnSync('git', ['-C', out, 'config', 'gc.auto', '0']);
  return out;
}

/** @param {string} fx @param {string[]} args @param {'node' | 'sh'} engine @param {Record<string, string>} [env] */
function exec(fx, args, engine, env = {}) {
  const r = spawnSync('sh', [path.join(fx, '.agents/scripts/agent.sh'), ...args], { cwd: fx, env: { ...ENV, ...(engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), ...env }, encoding: 'latin1', input: '' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

const ALL = [['status'], ['open-runs'], ['effective'], ['effective', 'LC'], ['effective', 'NOPE'], ['fingerprint'], ['fingerprint', 'LC'], ['fingerprint', 'LC', 'full'], ['patch-fingerprint', 'LC'],
  ['verify-seal', 'LC'], ['verify-gates', 'LC'], ['pipeline', 'LC'], ['pipeline', 'NOPE'], ['patch-fingerprint', 'NOPE'], ['verify-seal', 'NOPE'], ['verify-gates', 'NOPE'], ['pipeline'], ['verify-seal'], ['verify-gates'], ['patch-fingerprint'],
  ['entry-tier', 'a POST /orders endpoint that accepts a body'], ['entry-tier', 'POST /x removed'], ['entry-tier', 'a candidate endpoint, unchanged'], ['entry-tier', 'plain text'], ['entry-tier', 'adds a --flag option'], ['entry-tier']];

// the commands whose output depends on the state, per state; the argument-shape and error cases run on the first state only
const COMMANDS = [['status'], ['effective', 'LC'], ['fingerprint', 'LC', 'full'], ['patch-fingerprint', 'LC'], ['verify-seal', 'LC'], ['verify-gates', 'LC'], ['pipeline', 'LC']];
let shapesDone = false;
let rolesDone = false;

/** @param {string} fx @param {string} label @param {string[][]} [extra] */
function allSame(fx, label, extra = []) {
  const list = shapesDone ? [...COMMANDS, ...extra] : [...ALL, ...extra];
  shapesDone = true;
  for (const c of list) {
    const a = exec(fx, c, 'node'); const b = exec(fx, c, 'sh');
    assert.deepEqual(a, b, `${label}: agent.sh ${c.join(' ')}`);
  }
  for (const c of rolesDone ? [] : [['status'], ['pipeline', 'LC'], ['verify-gates', 'LC'], ['fingerprint', 'LC']]) {
    rolesDone = true;
    for (const env of [{ AGENT_ROLE: 'reviewer' }, { AGENT_ROLE: 'bogus' }]) {
      assert.deepEqual(exec(fx, c, 'node', env), exec(fx, c, 'sh', env), `${label}: ${c.join(' ')} as ${env.AGENT_ROLE}`);
    }
  }
}

const GATES_PARTIAL = `scaffold orchestrated no COMPLEX
worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null`;

const STATES = /** @type {Record<string, string>} */ ({
  planning: 'scaffold orchestrated no COMPLEX',
  implemented: GATES_PARTIAL,
  'gates partly passed': `${GATES_PARTIAL}\nn=0; for g in $(required); do case "$g" in SECRETS|VERIFY) continue ;; esac; n=$((n+1)); [ "$n" -le 2 ] || break; gpass "$g"; done`,
  'a failing gate': `${GATES_PARTIAL}\ngfail REVIEW_SMALL impl.txt 2>/dev/null || gfail REVIEW_RULES impl.txt 2>/dev/null || true`,
  'all gates pass': `${GATES_PARTIAL}\npass_all`,
  'code done': 'scaffold orchestrated no COMPLEX; to_code_done orchestrated',
  'pass then edited (stale)': `${GATES_PARTIAL}\npass_all; printf 'more\\n' >> impl.txt`,
  'standalone standard': 'scaffold standalone no STANDARD; solo RED fail impl_test.txt "test: lookup"; solo GREEN pass impl.txt "impl: lookup"; A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null',
  trivial: 'scaffold standalone no TRIVIAL',
  'risky path in the diff (tier full, signals)': `SC_SCOPE_NAMED=db/migrations/001.sql SC_PLAN_EXTRA='${'\n## Data\ndestructive: no\n'}' scaffold orchestrated no COMPLEX; mkdir -p db/migrations src; printf 'create table t;\\n' > db/migrations/001.sql; printf 'x\\n' > src/page.html`,
  'risk flags in the plan': `SC_PLAN_EXTRA='${'\n## Risk\ncontract_change: yes\nconcurrency: no\n\n## UI\nscreen\n'}' scaffold orchestrated no COMPLEX`,
  'untracked and changed files': `scaffold orchestrated no COMPLEX; mkdir -p src docs; i=0; while [ "$i" -lt 8 ]; do printf 'line %s\\n' "$i" > "src/f$i.txt"; i=$((i+1)); done; printf 'doc\\n' > docs/a.md; printf 'changed\\n' >> impl.txt; printf '# P\\n\\n<!-- proofline:begin -->\\nb\\n<!-- proofline:end -->\\n' > AGENTS.md`,
});

describe('library commands equal the shell', () => {
  for (const [name, snippet] of Object.entries(STATES)) {
    test(name, () => { const fx = build(snippet); allSame(fx, name); });
  }

  test('ledger faults: a foreign line, an edited chain, an edited state, a missing ledger', () => {
    const fx = build(GATES_PARTIAL);
    allSame(fx, 'sealed');
    const ledger = path.join(fx, '.agents/runs/LC/LEDGER.log');
    const good = readFileSync(ledger, 'latin1');
    appendFileSync(ledger, 'seq=999 prev=bad event=x role=lead from=- to=- digest=d ts=t epoch=1 detail=\n');
    allSame(fx, 'foreign line');
    writeFileSync(ledger, good.replace('event=', 'event=x', 1), 'latin1'); allSame(fx, 'edited first line');
    writeFileSync(ledger, good, 'latin1');
    const runYaml = path.join(fx, '.agents/runs/LC/RUN.yaml');
    const y = readFileSync(runYaml, 'latin1');
    writeFileSync(runYaml, y.replace('state: "IMPLEMENTED"', 'state: "CODE_DONE"').replace('  state: IMPLEMENTED', '  state: CODE_DONE'), 'latin1'); allSame(fx, 'edited state');
    writeFileSync(runYaml, y, 'latin1');
    writeFileSync(ledger, good.split('\n').slice(0, 3).join('\n') + '\n', 'latin1'); allSame(fx, 'cut ledger');
    rmSync(ledger); allSame(fx, 'no ledger');
    writeFileSync(ledger, ''); allSame(fx, 'empty ledger');
  });

  test('tampered gate record, edited artifact and a hand-written record', () => {
    const fx = build(`${GATES_PARTIAL}\npass_all`);
    const g = path.join(fx, '.agents/runs/LC/gates');
    const names = spawnSync('ls', [g], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.endsWith('.yaml'));
    assert.ok(names.length > 2);
    const f = path.join(g, names[1]);
    const orig = readFileSync(f, 'latin1');
    writeFileSync(f, orig.replace('result: pass', 'result: fail'), 'latin1'); allSame(fx, 'edited record');
    writeFileSync(f, orig, 'latin1');
    writeFileSync(path.join(g, '099-QA.yaml'), orig, 'latin1'); writeFileSync(path.join(g, '099-QA.manifest'), '', 'latin1'); allSame(fx, 'hand-written record');
    rmSync(path.join(g, '099-QA.yaml')); rmSync(path.join(g, '099-QA.manifest'));
    writeFileSync(path.join(fx, '.agents/runs/LC/VERIFY.md'), 'edited\n'); allSame(fx, 'edited artifact');
  });
});

describe('the repository root', () => { test('is this worktree', () => assert.ok(repo.length > 0)); });
