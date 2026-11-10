// @ts-check
// Tests of the Node harness (tests/lib/harness.mjs): the environment hardening, the expectation helpers, and that the Node scaffold builds the SAME state
// (since A244 without the shell library it replaced: the scaffold's state is asserted directly, and the recipe form (tests/lib/recipe.mjs over tests/lib/verbs.mjs) builds the same state as the functions).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  A, AS, accepted, cleanEnv, expectFail, expectMsg, git, gateStatus, gfail, gpass, solo, newRepo, passAll, pipe, project, qaBind, refused, rv, scaffold, scripts, sha256, toCodeDone, tsha, tmp, expectState,
} from './harness.mjs';
import { buildRecipe, runIn } from './recipe.mjs';

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
    for (const f of ['.agents/scripts/agent.sh', '.agents/scripts/secret-scan.sh', '.agents/scripts/exec-policy.sh', '.agents/task-integrations/markdown.sh', '.agents/config.yaml', '.agents/scripts/proofline-core.mjs']) assert.ok(existsSync(path.join(a, f)), f);
    assert.equal(git(a, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: a, env: cleanEnv() }).status, 1, 'no commit');
    // a real install (A244): agent.sh as shipped, the core beside it (proofline-core.mjs and core/), so agent.sh hands every command to the core
    assert.ok(readFileSync(path.join(a, '.agents/scripts/agent.sh')).equals(readFileSync(path.join(scripts, 'agent.sh'))), 'agent.sh is the shipped file, without a prologue');
    assert.ok(existsSync(path.join(a, '.agents/scripts/core/dispatch.mjs')) || readdirSync(path.join(a, '.agents/scripts/core')).length > 50, 'core/ is installed');
    assert.match(git(a, ['status', '--short', '--ignored']), /proofline-core\.mjs/, 'the core is excluded from the history');
    spawnSync('sh', ['-c', 'echo x > marker'], { cwd: a });
    assert.ok(!existsSync(path.join(b, 'marker')));
  });
});

describe('the scaffold builds the documented state, and the recipe form builds the same one', () => {
  /** @type {Array<[string, string, import('./harness.mjs').ScaffoldOptions, Record<string, string>]>} */
  const variants = [
    ['orchestrated no COMPLEX', 'scaffold orchestrated no COMPLEX', {}, {}],
    ['standalone layout yes STANDARD', 'scaffold standalone yes STANDARD', { topology: 'standalone', layout: 'yes', cls: 'STANDARD' }, {}],
    ['TRIVIAL manual', 'scaffold standalone no TRIVIAL manual', { topology: 'standalone', cls: 'TRIVIAL', autonomy: 'manual' }, {}],
    ['SC_BRANCH + extra scope + agents.md', 'SC_BRANCH=1 SC_SCOPE_EXTRA=AC-1 SC_SCOPE_AGENTS=1 SC_AGENTS_MD=2 scaffold orchestrated no COMPLEX', { branch: true, scopeExtra: 'AC-1', scopeAgents: true, agentsMd: 2 }, {}],
  ];
  for (const [name, recipe, opts] of variants) {
    test(name, () => {
      const js = scaffold(opts);
      const out = tmp('recipe'); buildRecipe(recipe, out);
      const manual = opts.autonomy === 'manual';
      expectState(js, 'handoff', 'state', manual ? 'PLANNED' : 'IMPLEMENTING');
      expectState(js, 'execution', 'topology', opts.topology ?? 'orchestrated');
      assert.equal(rv(js, 'pipeline', 'classification'), opts.cls ?? 'COMPLEX');
      assert.equal(existsSync(path.join(js, '.agents/runs/LC/QA_PLAN.md')), opts.cls !== 'TRIVIAL', 'a TRIVIAL run has no QA plan');
      assert.equal(existsSync(path.join(js, 'tasks/in-progress/LC.md')), opts.layout === 'yes');
      assert.equal(opts.branch ? rv(js, 'repository', 'task_branch') !== 'PENDING' : true, true);
      assert.match(git(js, ['log', '--format=%s', '-1']), /^baseline$/);
      // the recipe form: the same run files, the same state, the same plan
      assert.deepEqual(runFiles(out), runFiles(js), 'the run folder holds the same files');
      for (const [sec, key] of [['handoff', 'state'], ['execution', 'state'], ['execution', 'topology'], ['execution', 'autonomy'], ['pipeline', 'tier'], ['pipeline', 'classification'], ['repository', 'task_branch'], ['repository', 'canonical_branch']])
        assert.equal(rv(out, sec, key), rv(js, sec, key), `${sec}.${key}`);
      assert.equal(readFileSync(path.join(out, '.agents/runs/LC/PLAN.md'), 'utf8'), readFileSync(path.join(js, '.agents/runs/LC/PLAN.md'), 'utf8'));
      assert.equal(git(out, ['rev-parse', 'HEAD^{tree}']), git(js, ['rev-parse', 'HEAD^{tree}']), 'the baseline tree is byte-identical');
    });
  }
  test('the scaffold of a plan with extra scope paths lists them in PLAN.md and creates the files', () => {
    const js = scaffold({ scopeExtra: 'AC-1', scopeOther: 'AC-1', scopeAgents: true });
    const plan = readFileSync(path.join(js, '.agents/runs/LC/PLAN.md'), 'utf8');
    for (const p of ['impl.txt', 'impl_test.txt', 'other.txt', 'far.txt', '.agents/impl.txt']) assert.ok(plan.includes(`  - path: ${p}\n`), p);
    for (const f of ['other.txt', 'far.txt', '.agents/impl.txt']) assert.ok(existsSync(path.join(js, f)), f);
  });
  test('the recipe form reaches CODE_DONE with the same gate states as the functions', () => {
    const out = tmp('recipe'); buildRecipe('scaffold orchestrated no COMPLEX; to_code_done orchestrated', out);
    const js = scaffold({ topology: 'orchestrated' });
    toCodeDone(js, 'orchestrated');
    expectState(js, 'handoff', 'state', 'CODE_DONE');
    expectState(out, 'handoff', 'state', 'CODE_DONE');
    assert.equal(gates(js), gates(out));
    assert.deepEqual(readdirSync(path.join(js, '.agents/runs/LC/gates')).sort(), readdirSync(path.join(out, '.agents/runs/LC/gates')).sort());
  });
  test('a recipe that fails fails the build with the control plane\'s message (set -e), and a verb works in a project', () => {
    assert.throws(() => buildRecipe('scaffold orchestrated; A handoff LC CODE_DONE', tmp('recipe')), /recipe failed/);
    const p = project({ topology: 'standalone' });
    const r = runIn(p, "solo RED fail impl_test.txt 'test: x'; solo GREEN pass impl.txt 'impl: x'; A handoff LC IMPLEMENTED; gpass REVIEW_SMALL; echo done");
    assert.equal(r.status, 0, r.text);
    assert.match(gateStatus(p, 'REVIEW_SMALL'), /pass/i);
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
