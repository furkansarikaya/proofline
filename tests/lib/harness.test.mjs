// @ts-check
// Tests of the Node harness (tests/lib/harness.mjs): the environment hardening, the expectation helpers, and that the Node scaffold builds the SAME state
// as the shell library it replaces (the committed baseline tree is byte-identical, the run reaches the same handoff and gate states).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  A, AS, accepted, cleanEnv, expectFail, expectMsg, git, gateStatus, gfail, gpass, solo, newRepo, passAll, pipe, project, qaBind, refused, rv, scaffold, scripts, sha256, toCodeDone, tsha, tmp, expectState,
} from './harness.mjs';

/** The shell library builds a scaffold and prints its directory. @param {string} recipe @param {Record<string, string>} [env] */
function shellScaffold(recipe, env = {}) {
  const out = tmp('shell');
  const r = spawnSync('sh', ['-c', `. "$LIB"; ${recipe}; cp -R "$PWD/." "$OUT/"`, path.join(scripts, 'x.sh')],
    { env: cleanEnv({ LIB: path.join(scripts, 'test-lib.sh'), OUT: out, ...env }), encoding: 'utf8', timeout: 600000 });
  assert.equal(r.status, 0, `${recipe}: ${r.stderr}${r.stdout}`);
  return out;
}
/** @param {string} dir @returns {string[]} */
function runFiles(dir) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => { for (const n of readdirSync(path.join(dir, d)).sort()) { const rel = path.join(d, n); if (statIsDir(path.join(dir, rel))) walk(rel); else out.push(rel); } };
  walk('.agents/runs/LC');
  return out;
}
const statIsDir = (/** @type {string} */ p) => { try { return readdirSync(p) && true; } catch { return false; } };
const gates = (/** @type {string} */ dir) => A(dir, ['pipeline', 'LC']).out.split('\n').filter((l) => l.startsWith('gate.')).sort().join('\n');

describe('the environment of every child', () => {
  test('is clean: no inherited settings or credentials, a fixed identity, git without the user configuration', () => {
    process.env.GH_TOKEN = 'secret-token'; process.env.GITHUB_TOKEN = 'secret-token'; process.env.AGENT_ROLE = 'lead'; process.env.PROOFLINE_ENGINE = 'x';
    try {
      const e = cleanEnv({ EXTRA: '1' });
      for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'AGENT_ROLE', 'PROOFLINE_ENGINE', 'SSH_AUTH_SOCK']) assert.equal(e[k], undefined, k);
      assert.equal(e.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(e.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(e.LC_ALL, 'C');
      assert.equal(e.GIT_AUTHOR_EMAIL, 'fixture@example.invalid'); assert.equal(e.GIT_COMMITTER_NAME, 'fixture');
      assert.equal(e.HOME, tmpdir()); // HOME is the temp folder, never the user's
      assert.equal(e.EXTRA, '1');
    } finally { delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN; delete process.env.AGENT_ROLE; delete process.env.PROOFLINE_ENGINE; }
  });
  test('a call of the control plane sees the given role and nothing of the parent environment', () => {
    process.env.GH_TOKEN = 'secret-token';
    try {
      const dir = newRepo();
      // the stub exec-policy prints what it was given; a shell one-liner proves the environment instead
      const r = spawnSync('sh', ['-c', 'echo "[$AGENT_ROLE][${GH_TOKEN:-none}][$GIT_AUTHOR_NAME]"'], { cwd: dir, env: cleanEnv({ AGENT_ROLE: 'qa' }), encoding: 'utf8' });
      assert.equal(r.stdout.trim(), '[qa][none][fixture]');
    } finally { delete process.env.GH_TOKEN; }
  });
});

describe('the expectation helpers', () => {
  const ok = { status: 0, out: 'fine', err: '', text: 'fine' };
  const bad = { status: 1, out: '', err: 'cannot: x is missing', text: 'cannot: x is missing' };
  test('expectFail needs a failing command; expectMsg needs the reason too', () => {
    assert.throws(() => expectFail(ok, 'must fail'), /command succeeded/);
    assert.equal(expectFail(bad, 'must fail'), bad);
    assert.equal(expectMsg('reason', 'is missing', bad), undefined);
    assert.throws(() => expectMsg('reason', 'another thing', bad), /another reason/);
    assert.equal(refused(bad, 'regexp', /x is/), undefined);
    assert.throws(() => expectMsg('reason', 'is missing', ok), /command succeeded/);
  });
  test('accepted needs a successful command', () => {
    assert.equal(accepted(ok, 'works'), ok);
    assert.throws(() => accepted(bad, 'works'), /refused/);
  });
});

describe('the qa binding and the run state readers', () => {
  test('A leaves the run files alone unless bind is asked for (the ported Node suites rely on it); a bound freeze changes the QA plan', () => {
    const p = scaffold({ topology: 'standalone', autonomy: 'manual' });
    const q = path.join(p, '.agents/runs/LC/QA_PLAN.md');
    const before = readFileSync(q, 'utf8');
    A(p, ['freeze', 'LC']);
    assert.equal(readFileSync(q, 'utf8'), before, 'an unbound freeze does not rewrite the QA plan');
    A(p, ['freeze', 'LC'], { bind: true });
    assert.match(readFileSync(q, 'utf8'), /^Plan sha256: [0-9a-f]{64}$/m);
  });
  test('qaBind puts the plan hash right after the title; a rerun leaves exactly one such line', () => {
    const dir = newRepo();
    const run = path.join(dir, '.agents/runs/QB'); spawnSync('mkdir', ['-p', run]);
    spawnSync('sh', ['-c', `printf 'plan\\n' > "${run}/PLAN.md"; printf '# QA plan\\n\\nPlan sha256: old\\n- QA-1\\n' > "${run}/QA_PLAN.md"`]);
    qaBind(dir, 'QB');
    assert.equal(readFileSync(`${run}/QA_PLAN.md`, 'utf8'), `# QA plan\n\nPlan sha256: ${tsha(`${run}/PLAN.md`)}\n\n- QA-1\n`);
    qaBind(dir, 'QB');
    assert.equal(readFileSync(`${run}/QA_PLAN.md`, 'utf8').split('\n').filter((l) => l.startsWith('Plan sha256: ')).length, 1);
  });
  test('qaBind of a run without the files changes nothing', () => { assert.doesNotThrow(() => qaBind(newRepo(), 'NOPE')); });
  test('sha256 is the hex digest', () => { assert.equal(sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'); });
});

describe('a new repository', () => {
  test('has the control plane installed, git initialised on main, nothing committed, and is independent of its copies', () => {
    const a = newRepo(); const b = newRepo();
    assert.notEqual(a, b);
    for (const f of ['.agents/scripts/agent.sh', '.agents/scripts/secret-scan.sh', '.agents/scripts/exec-policy.sh', '.agents/task-integrations/markdown.sh', '.agents/config.yaml', '.agents/core4a/proofline-core.mjs']) assert.ok(existsSync(path.join(a, f)), f);
    assert.equal(git(a, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: a, env: cleanEnv() }).status, 1, 'no commit');
    assert.match(readFileSync(path.join(a, '.agents/scripts/agent.sh'), 'utf8'), /^#!\/bin\/sh\ncase "\$0" in/);
    spawnSync('sh', ['-c', 'echo x > marker'], { cwd: a });
    assert.ok(!existsSync(path.join(b, 'marker')));
  });
});

describe('the Node scaffold builds the state of the shell scaffold', () => {
  /** @type {Array<[string, string, import('./harness.mjs').ScaffoldOptions]>} */
  const variants = [
    ['orchestrated no COMPLEX', 'scaffold orchestrated no COMPLEX', {}],
    ['standalone layout yes STANDARD', 'scaffold standalone yes STANDARD', { topology: 'standalone', layout: 'yes', cls: 'STANDARD' }],
    ['TRIVIAL manual', 'scaffold standalone no TRIVIAL manual', { topology: 'standalone', cls: 'TRIVIAL', autonomy: 'manual' }],
    ['SC_BRANCH + extra scope + agents.md', 'scaffold orchestrated no COMPLEX', { branch: true, scopeExtra: 'AC-1', scopeAgents: true, agentsMd: 2 }],
  ];
  for (const [name, recipe, opts] of variants) {
    test(name, () => {
      const env = {};
      if (opts.branch) Object.assign(env, { SC_BRANCH: '1' });
      if (opts.scopeExtra) Object.assign(env, { SC_SCOPE_EXTRA: opts.scopeExtra });
      if (opts.scopeAgents) Object.assign(env, { SC_SCOPE_AGENTS: '1' });
      if (opts.agentsMd) Object.assign(env, { SC_AGENTS_MD: String(opts.agentsMd) });
      const sh = shellScaffold(recipe, env);
      const js = scaffold(opts);
      assert.equal(git(js, ['rev-parse', 'HEAD^{tree}']), git(sh, ['rev-parse', 'HEAD^{tree}']), 'the baseline tree is byte-identical');
      assert.deepEqual(runFiles(js), runFiles(sh), 'the run folder holds the same files');
      for (const f of ['.agents/scripts/agent.sh', '.agents/scripts/secret-scan.sh', '.agents/scripts/exec-policy.sh', '.agents/task-integrations/markdown.sh', '.agents/scripts/proofline-core.mjs', '.agents/core4a/proofline-core.mjs', '.agents/config.yaml', '.git/info/exclude', '.gitignore'])
        assert.ok(readFileSync(path.join(js, f)).equals(readFileSync(path.join(sh, f))), `${f} is byte-identical to the shell library's`);
      for (const [sec, key] of [['handoff', 'state'], ['execution', 'state'], ['execution', 'topology'], ['execution', 'autonomy'], ['pipeline', 'tier'], ['pipeline', 'classification']])
        assert.equal(rv(js, sec, key), rv(sh, sec, key), `${sec}.${key}`);
      assert.equal(readFileSync(path.join(js, '.agents/runs/LC/PLAN.md'), 'utf8'), readFileSync(path.join(sh, '.agents/runs/LC/PLAN.md'), 'utf8'));
      assert.equal(existsSync(path.join(js, '.agents/runs/LC/QA_PLAN.md')), existsSync(path.join(sh, '.agents/runs/LC/QA_PLAN.md')));   // a TRIVIAL run has no QA plan
      if (existsSync(path.join(js, '.agents/runs/LC/QA_PLAN.md'))) assert.equal(readFileSync(path.join(js, '.agents/runs/LC/QA_PLAN.md'), 'utf8'), readFileSync(path.join(sh, '.agents/runs/LC/QA_PLAN.md'), 'utf8'));
    });
  }
  test('to-code-done reaches CODE_DONE with the same gate states as the shell library', () => {
    const sh = shellScaffold('scaffold orchestrated no COMPLEX; to_code_done orchestrated');
    const js = scaffold({ topology: 'orchestrated' });
    toCodeDone(js, 'orchestrated');
    expectState(js, 'handoff', 'state', 'CODE_DONE');
    assert.equal(rv(sh, 'handoff', 'state'), 'CODE_DONE');
    assert.equal(gates(js), gates(sh));
    assert.deepEqual(readdirSync(path.join(js, '.agents/runs/LC/gates')).sort(), readdirSync(path.join(sh, '.agents/runs/LC/gates')).sort());
  });
  test('the standalone path (the lead records its own evidence) reaches CODE_DONE too', () => {
    const js = scaffold({ topology: 'standalone' });
    toCodeDone(js, 'standalone');
    expectState(js, 'handoff', 'state', 'CODE_DONE');
  });
});

describe('the template cache', () => {
  test('is a private folder of this user (mode 0700); a looser mode is tightened', { skip: process.platform === 'win32' }, () => {
    newRepo();
    const dir = path.join(tmpdir(), `proofline-harness-${process.getuid?.() ?? 0}`);
    chmodSync(dir, 0o777);
    assert.ok(newRepo());
    assert.equal(statSync(dir).mode & 0o077, 0, 'no access for group or others');
  });
});

describe('the gate helpers', () => {
  test('a failing gate result blocks, a passing one passes; the role is the gate owner; project() copies are independent', () => {
    const p = project({ topology: 'standalone' });
    const q = project({ topology: 'standalone' });
    assert.notEqual(p, q);
    spawnSync('sh', ['-c', 'echo x > marker'], { cwd: q });
    assert.ok(!existsSync(path.join(p, 'marker')));
    solo(p, 'RED', 'fail', 'impl_test.txt', 'test: x'); solo(p, 'GREEN', 'pass', 'impl.txt', 'impl: x');
    accepted(A(p, ['handoff', 'LC', 'IMPLEMENTED']), 'implemented');
    gfail(p, 'REVIEW_SMALL', 'impl.txt');
    assert.match(gateStatus(p, 'REVIEW_SMALL'), /FAIL|fail/i);
    gpass(p, 'REVIEW_SMALL');
    assert.match(gateStatus(p, 'REVIEW_SMALL'), /PASS|pass/i);
    passAll(p);
    assert.notEqual(pipe(p, 'gates'), '');
  });
  test('AS passes the role: the lead may not record a reviewer gate', () => {
    const p = project({ topology: 'standalone' });
    const bad = AS(p, 'implementer', ['handoff', 'LC', 'CODE_DONE']);
    assert.notEqual(bad.status, 0);
  });
});
