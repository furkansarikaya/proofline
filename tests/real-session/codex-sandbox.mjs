// @ts-check
// Real Codex sandbox check (A199, A203), no model call: the permission profile that dispatch gives a Codex worker (`dispatch.sh codex-profile <ID>`) is
// applied with `codex sandbox -P`, and inside it a worker must be able to write product files and its own record paths and to run `agent.sh submit` and
// the evidence recorder, and must NOT be able to write .agents/local/windows, approvals, prompts or batch (nor the run's approvals). Run for a run in
// the main tree and for a run in a worktree. Needs the Codex CLI; without it the script says so and exits 0. Not part of CI (the profile itself is
// covered by tests/real-session/codex-sandbox.test.mjs).
//   node tests/real-session/codex-sandbox.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, base, cleanEnv, git, scripts, project } from '../lib/harness.mjs';

/** @param {string} bin @param {string} [pathEnv] */
export function onPath(bin, pathEnv = process.env.PATH ?? '') {
  return pathEnv.split(path.delimiter).some((d) => d !== '' && existsSync(path.join(d, bin)));
}

/** The shell's `die`. @param {string} msg @returns {never} */
function die(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

/** @param {string} dir @param {string[]} rel */
const mk = (dir, ...rel) => { for (const r of rel) mkdirSync(path.join(dir, r), { recursive: true }); };

/** The arguments of the worker profile, as `dispatch.sh codex-profile LC` prints them (one per line). @param {string} runRoot */
export function profileArgs(runRoot) {
  const r = spawnSync('sh', [path.join(runRoot, '.agents/scripts/dispatch.sh'), 'codex-profile', 'LC'], { cwd: runRoot, encoding: 'utf8', env: cleanEnv() });
  return r.stdout.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

const PROBE = `try() { ( : > "$1" ) 2>/dev/null && echo "WROTE $1" || echo "DENIED $1"; }
try impl.txt
try .agents/runs/LC/scratch/own.txt
try .agents/local/locks/own.lock-probe
try .agents/local/submissions/own.probe
try .agents/local/windows/forged
try .agents/local/approvals/forged
try .agents/local/prompts/forged
try .agents/local/batch/forged
try .agents/runs/LC/approvals/forged
try .agents/local/escalate
try .agents/roles.conf.probe
`;
const GIT_PROBE = `g() { n=$1; shift; o=$("$@" 2>&1) && echo "GITOK $n" || echo "GITFAIL $n: $(printf '%s' "$o" | head -c 300 | tr '\\n' ' ')"; }
cd=$(git rev-parse --git-common-dir)
echo changed >> impl.txt
g status git status --short
g diff git diff --stat
g add git add impl.txt
g commit git -c user.name=w -c user.email=w@example.invalid commit -q -m worker-probe
g wtadd git worktree add --detach "$TMPDIR/ev-probe" HEAD
g ref git update-ref refs/heads/forged HEAD
g other mkdir "$cd/worktrees/other-task"
`;

function main() {
  if (!onPath('codex')) { console.log('codex-sandbox: the Codex CLI is not installed; nothing checked'); return 0; }
  const b = base();
  const chome = path.join(b, 'chome'); mkdirSync(chome, { recursive: true });   // no user config, no login: the sandbox command needs neither
  const env = cleanEnv({ CODEX_HOME: chome });
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[k];

  /** Run `sh SCRIPT` (an absolute path) inside the Codex sandbox with the worker profile of the run LC, working directory DIR; the combined output. @param {string} dir @param {string} script @param {string} runRoot */
  const csb = (dir, script, runRoot) => {
    mk(b, 'sbtmp');
    const r = spawnSync('codex', ['sandbox', '-C', dir, '-P', 'proofline-worker', ...profileArgs(runRoot), '--', 'sh', script], { env: { ...env, TMPDIR: path.join(b, 'sbtmp') }, encoding: 'utf8', timeout: 300000 });
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  /** @param {string} out @param {string} p @param {'wrote' | 'denied'} want @param {string} what */
  const wantLine = (out, p, want, what) => {
    if (!out.split('\n').includes(`${want.toUpperCase()} ${p}`)) die(`A199 ${what}: expected ${want} for ${p}; got: ${out.slice(0, 600)}`);
  };

  for (const where of ['main', 'worktree']) {
    const main = project({ cls: 'STANDARD' });
    copyFileSync(path.join(scripts, 'dispatch.sh'), path.join(main, '.agents/scripts/dispatch.sh'));
    mk(main, '.agents/local/locks', '.agents/local/submissions', '.agents/local/windows', '.agents/local/approvals', '.agents/local/prompts', '.agents/local/batch', '.agents/runs/LC/approvals', '.agents/runs/LC/scratch');
    git(main, ['add', '-A']); git(main, ['commit', '-q', '-m', 'fixture']);
    let runRoot = main;
    if (where === 'worktree') {
      const rw = A(main, ['worktree-add', 'RW-1']);
      if (rw.status !== 0) die(`A199 worktree-add: ${rw.text}`);
      const wt = realpathSync(path.join(main, '.agents/local/worktrees/RW-1'));
      mk(wt, '.agents/runs', '.agents/local/locks', '.agents/local/submissions', '.agents/local/windows', '.agents/local/approvals', '.agents/local/prompts', '.agents/local/batch');
      cpSync(path.join(main, '.agents/runs/LC'), path.join(wt, '.agents/runs/LC'), { recursive: true });
      for (const e of ['scripts', 'hooks']) if (existsSync(path.join(main, '.agents', e))) { rmSync(path.join(wt, '.agents', e), { recursive: true, force: true }); cpSync(path.join(main, '.agents', e), path.join(wt, '.agents', e), { recursive: true }); }
      copyFileSync(path.join(main, '.agents/config.yaml'), path.join(wt, '.agents/config.yaml'));
      runRoot = wt;
    }
    writeFileSync(path.join(runRoot, 'impl.txt'), '');
    const probe = path.join(b, 'probe.sh'); writeFileSync(probe, PROBE);
    const out = csb(runRoot, probe, runRoot).out; writeFileSync(path.join(b, `probe-${where}.out`), out);
    for (const p of ['impl.txt', '.agents/runs/LC/scratch/own.txt', '.agents/local/locks/own.lock-probe', '.agents/local/submissions/own.probe']) wantLine(out, p, 'wrote', `(${where}) a worker's own path`);
    for (const p of ['.agents/local/windows/forged', '.agents/local/approvals/forged', '.agents/local/prompts/forged', '.agents/local/batch/forged', '.agents/runs/LC/approvals/forged', '.agents/local/escalate', '.agents/roles.conf.probe']) wantLine(out, p, 'denied', `(${where}) a path a worker must not write`);
    console.log(`ok: A199 (${where}) in a real Codex sandbox: product files and the worker's own record paths are writable; windows, approvals, prompts, batch, the run's approvals and the rest of .agents are not`);

    // git operations a worker does in its tree (A203). In a worktree: status, diff, add and commit work (own worktree folder plus the common objects/ folder) and
    // nothing else of the git dir is writable: not a branch ref, not another task's worktree folder, not a new worktree (an evidence worktree, D10). In the main
    // tree the whole .git stays read-only (the lead commits there): status and diff work, add and commit are refused.
    const gp = path.join(b, 'git.sh'); writeFileSync(gp, GIT_PROBE);
    const head = git(runRoot, ['rev-parse', 'HEAD']);
    const gout = csb(runRoot, gp, runRoot).out;
    writeFileSync(path.join(runRoot, 'impl.txt'), ''); git(runRoot, ['reset', '-q', '--hard', head]);
    /** @param {string} name @param {'ok' | 'fail'} want */
    const gexp = (name, want) => {
      const lines = gout.split('\n');
      if (want === 'ok') { if (!lines.includes(`GITOK ${name}`)) die(`A203 (${where}) git ${name} must work inside the Codex sandbox; got: ${lines.find((l) => l.startsWith(`GITFAIL ${name}`)) ?? ''}. A dispatched Codex worker that reports BLOCKED on this: run the role with --runtime claude`); }
      else if (!lines.some((l) => l.startsWith(`GITFAIL ${name}:`))) die(`A203 (${where}) git ${name} must be refused inside the Codex sandbox; got: ${lines.find((l) => l === `GITOK ${name}`) ?? ''}`);
    };
    gexp('status', 'ok'); gexp('diff', 'ok'); gexp('ref', 'fail'); gexp('other', 'fail'); gexp('wtadd', 'fail');
    if (where === 'worktree') { gexp('add', 'ok'); gexp('commit', 'ok'); } else { gexp('add', 'fail'); gexp('commit', 'fail'); }
    console.log(`ok: A203 (${where}) git: status and diff work; ${where === 'worktree' ? 'add and commit work (own worktree folder, common objects/)' : 'add and commit are refused (.git read-only)'}; branch refs, other worktree folders and new worktrees are refused`);

    // submit succeeds from inside the sandbox (an explorer report), taking the locks
    const art = '.agents/runs/LC/scratch/e9-report.md';
    writeFileSync(path.join(runRoot, art), '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| C1 | low | impl.txt:1 | x | y |\n');
    const sp = path.join(b, 'submit.sh'); writeFileSync(sp, `AGENT_ROLE=explorer sh .agents/scripts/agent.sh submit LC --agent e9 --result DONE --confidence high --report ${art}\n`);
    const sub = csb(runRoot, sp, runRoot);
    writeFileSync(path.join(b, `submit-${where}.out`), sub.out);
    if (sub.status !== 0) die(`A199 (${where}) submit failed inside the sandbox: ${sub.out.trim().split('\n').slice(-5).join('\n')}`);
    if (!/submitted|recorded|ok/i.test(sub.out)) die(`A199 (${where}) submit printed nothing recognisable: ${sub.out}`);
    const has = (/** @type {string} */ d) => existsSync(path.join(runRoot, d)) && readdirSync(path.join(runRoot, d)).length > 0;
    if (!has('.agents/runs/LC/results') && !has('.agents/runs/LC/reports')) die(`A199 (${where}) submit left no record`);
    console.log(`ok: A199 (${where}) agent.sh submit succeeds inside the real Codex sandbox`);

    // the evidence recorder (an implementer's RED record) works inside the sandbox too; the window is opened and closed by dispatch.sh, outside it
    const wo = A(runRoot, ['window-open', 'LC'], { role: '' });
    if (wo.status !== 0) die(`A199 (${where}) window-open: ${wo.text}`);
    const W = wo.out.replace(/\n+$/, '');
    const rp = path.join(b, 'rec.sh'); writeFileSync(rp, "printf 'command: go test ./...\\ntarget: impl.txt,impl_test.txt\\nexpected_failure: TestImpl fails: lookup is not implemented in impl.txt yet\\n' | AGENT_ROLE=implementer sh .agents/scripts/agent.sh worker-evidence LC RED fail\n");
    const rec = csb(runRoot, rp, runRoot);
    writeFileSync(path.join(b, `rec-${where}.out`), rec.out);
    if (rec.status !== 0) die(`A199 (${where}) the evidence recorder failed inside the sandbox: ${rec.out.trim().split('\n').slice(-5).join('\n')}`);
    const ev = path.join(runRoot, '.agents/runs/LC/worker-evidence');
    if (!existsSync(ev) || !readdirSync(ev).some((n) => /^RED-.*\.yaml$/.test(n))) die(`A199 (${where}) no RED record after the sandboxed recorder`);
    A(runRoot, ['window-close', 'LC', W, '0'], { role: '' });
    console.log(`ok: A199 (${where}) the evidence recorder writes a RED record inside the real Codex sandbox`);
  }
  console.log('codex-sandbox: passed');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main();
