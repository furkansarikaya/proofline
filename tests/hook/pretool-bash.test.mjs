// @ts-check
// PreToolUse for a shell command: the Node hook against the shell hook (the specification) on one corpus, per caller (the lead in a run, the lead
// without a run, an implementer subagent, a reviewer subagent, a headless specialist), the same stdout and exit status; plus the fail-closed cases
// of the Node router. The shell hook stays in the repository until stage 10.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, copyProject, haveJq, runHook, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join } from './harness.mjs';

const skip = haveJq ? false : 'jq is required for the shell hook';
let withRun = '';
let noRun = '';
let base = '';
before(() => { withRun = buildTemplate(); noRun = buildTemplate({ run: false }); base = mkdtempSync(join(tmpdir(), 'hook-pre-')); });
after(() => { rmSync(withRun, { recursive: true, force: true }); rmSync(noRun, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const CORPUS = [
  // the lead's ordinary commands
  'ls', 'git status --short', 'git log --oneline -3', 'sh .agents/scripts/agent.sh next', 'sh .agents/scripts/agent.sh status', 'AGENT_ROLE=lead sh .agents/scripts/agent.sh next',
  'ID=T-1; sh .agents/scripts/agent.sh next $ID', 'sh .agents/scripts/agent.sh $SUB', 'sh .agents/scripts/agent.sh approve T-1', 'sh .agents/scripts/agent.sh waive T-1', 'sh .agents/scripts/agent.sh record x',
  'sh .agents/scripts/agent.sh window-open LC implementer', 'sh .agents/scripts/agent.sh submit LC --agent a1', 'sh .agents/scripts/agent.sh publish-completion-report LC',
  'AGENT_ROLE=reviewer sh .agents/scripts/agent.sh next', 'AGENT_ROLE=implementer sh .agents/scripts/agent.sh worker-evidence status', 'AGENT_ROLE=implementer sh .agents/scripts/agent.sh submit LC --agent a1',
  'eval "$X"', 'bash -s', 'claude -p hi', 'codex exec x', 'ln -s a .agents/b', 'ln -s .agents/x y',
  // writes
  'echo x > src/a.txt', 'echo x > .agents/runs/LC/PLAN.md', 'echo x > .agents/runs/LC/RUN.yaml', 'echo x > .agents/runs/LC/scratch/a.txt', 'echo x > .agents/local/x', 'tee .agents/runs/LC/EVIDENCE.md < /dev/null',
  'cp a .claude/settings.json', 'echo x > $DIR/f', 'echo x > /tmp/zz', 'echo x > ../outside.txt', 'rm src/gone.txt', 'rm -f .agents/runs/LC/scratch/x', 'touch impl.txt', 'mv a b', 'sed -i s/a/b/ src/a.txt',
  'sed -i.bak s/a/b/ src/a.txt', 'perl -pi -e s/a/b/ src/a.txt', 'echo x > .git/config', 'git config core.hooksPath /dev/null', 'git commit --no-verify -m x', 'git -c core.hookspath=/dev/null commit -m x',
  'echo x > .agents/githooks/pre-commit', 'mktemp', 'mktemp -d scratch/XXXX', 'cat <<EOF > src/h.txt\nhello\nEOF',
  // tripwires
  'node .agents/scripts/proofline-core.mjs next', 'node -e "require(\'./.agents/scripts/proofline-core.mjs\')"', 'node $X/run.mjs', 'node ./x.mjs', 'node --test tests/*.test.mjs', 'node -c .agents/scripts/proofline-core.mjs',
  'xargs node', 'echo a.mjs | xargs node', 'find . -exec node {} \\;', 'cat x.mjs | node', 'node /dev/stdin < x', 'NODE_OPTIONS=--require=x node a.mjs', 'PROOFLINE_ENGINE=sh ls', 'export PROOFLINE_TESTX=1',
  'PROOFLINE_DISPATCH=1 ls', 'ls .agents/*', 'find .agents/local -name x', 'PROOFLINE_SELFTEST=1 ls', 'node a.mjs; node ${B}.mjs',
  // git, merge, kill, database, stash, tmp
  'git push origin main', 'git push origin feat/x', 'git merge feat/x', 'gh pr merge 7', 'proofline merge 7', 'pkill node', 'killall x', 'kill 123', 'kill -9 0', 'kill $(pgrep x)',
  'sqlite3 app.db .tables', 'sqlite3 :memory: "select 1"', 'cat data.sqlite', 'psql -c "drop table x"', 'git stash', 'git stash list', 'git -C $TMPDIR/wt stash', 'git reset --hard', 'git checkout -- src/a.txt',
  'git worktree add --detach $TMPDIR/wt HEAD', 'git -C $TMPDIR/wt reset --hard', 'cat /tmp/other', 'ls /tmp/claude-1/p/s/tasks/a.output', 'cat /tmp/claude-1/p/s/tasks/a.output', 'cp a /tmp/b',
  'npm test', 'RTK_DISABLED=1 npm test', 'git diff', 'find . -delete', 'xargs rm', 'ed x', 'patch -p1 < x.diff',
];

/** @param {'sh' | 'node'} kind @param {string} dir @param {string} command @param {object} who @param {Record<string, string>} env */
function pre(kind, dir, command, who, env) {
  return runHook(kind, dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }, { env });
}

/**
 * @param {string} name @param {string} template @param {object} who @param {Record<string, string>} [env]
 */
function scenario(name, template, who, env = {}) {
  test(`Bash corpus: ${name}`, { skip }, async () => {
    const a = copyProject(template, base);
    const b = copyProject(template, base);
    const norm = (/** @type {string} */ t, /** @type {string} */ d) => t.split(d).join('<P>');
    // the first call of a run writes its baseline: do it once, in order, before the parallel part
    await Promise.all([pre('sh', a, 'ls', who, env), pre('node', b, 'ls', who, env)]);
    const bad = [];
    for (let i = 0; i < CORPUS.length; i += 8) {
      const chunk = CORPUS.slice(i, i + 8);
      const res = await Promise.all(chunk.flatMap((c) => [pre('sh', a, c, who, env), pre('node', b, c, who, env)]));
      chunk.forEach((c, j) => {
        const s = /** @type {any} */ (res[2 * j]); const n = /** @type {any} */ (res[2 * j + 1]);
        if (norm(s.stdout, a) !== norm(n.stdout, b) || s.status !== n.status) bad.push({ c, sh: norm(s.stdout, a).slice(0, 300), node: norm(n.stdout, b).slice(0, 300), shStatus: s.status, nodeStatus: n.status, err: n.stderr.slice(0, 200) });
      });
    }
    assert.deepEqual(bad, []);
  });
}

scenario('the lead in a run', withRun, {});
scenario('the lead without a run', noRun, {});
scenario('an implementer subagent', withRun, { agent_type: 'proofline-implementer', agent_id: 'a1' });
scenario('a reviewer subagent (read role)', withRun, { agent_type: 'proofline-reviewer', agent_id: 'a2' });
scenario('a headless specialist (AGENT_ROLE in the environment)', withRun, {}, { AGENT_ROLE: 'qa' });

test('fail closed: unparsable input during a run denies, without a run it passes', { skip }, async () => {
  const d = copyProject(withRun, base);
  const r = await runHook('node', d, 'pretool', 'not json');
  assert.match(r.stdout, /"permissionDecision":"deny"/);
  assert.match(r.stdout, /hook input could not be parsed/);
  const e = copyProject(noRun, base);
  const q = await runHook('node', e, 'pretool', 'not json');
  assert.equal(q.stdout, '');
  assert.equal(q.status, 0);
});

test('fail closed: a malformed ACTIVE_RUN denies', { skip }, async () => {
  const d = copyProject(withRun, base);
  writeFileSync(join(d, '.agents/local/ACTIVE_RUN'), 'bad id!\n');
  const r = await pre('node', d, 'ls', {}, {});
  assert.match(r.stdout, /ACTIVE_RUN is malformed/);
});

test('fail closed: a broken core during a run denies a Bash call and says why', { skip }, async () => {
  const d = copyProject(withRun, base);
  writeFileSync(join(d, '.agents/scripts/proofline-core.mjs'), 'throw new Error("boom");\n');
  const r = await pre('node', d, 'git push origin main', {}, {});
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});

test('a project without proofline: only the merge and kill guards speak', { skip }, async () => {
  const d = mkdtempSync(join(base, 'plain-'));
  mkdirSync(join(d, '.git'));
  const r = await pre('node', d, 'ls', {}, {});
  assert.equal(r.stdout, '');
  const k = await pre('node', d, 'pkill node', {}, {});
  assert.match(k.stdout, /"permissionDecision":"deny"/);
});
