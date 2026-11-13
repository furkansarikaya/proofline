// @ts-check
// What the dispatcher hands to a runtime stays BYTE-IDENTICAL to the shell dispatcher of 0.0.57 (A199, A203 item 1, A226): the argument list of codex, of claude -p
// (the --agents JSON included) and of a command template, the prompt on stdin, the variables of the runtime and the Codex permission profile. tests/core/golden/dispatch/
// cases.json was recorded from the OLD dispatch.sh with tests/core/golden/dispatch-record.mjs; nothing compares with a shell at test time.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, cpSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { posix, skipOnWin32 } from '../lib/winpath.mjs';
/** A test that starts a shell-script fake runtime (or fake worker) from a temp folder: skipped on Windows, where only a real .exe outside temp folders runs, by design (A252, A262). Tests that only read text or run `dispatch.sh codex-profile` stay on. */
const fakeTest = skipOnWin32(test, 'starts a shell-script fake runtime from a temp folder; on Windows only a real .exe outside temp folders runs, by design (A252, A262)');
import { fixture } from './dispatch-lib.mjs';
import { fakeRuntime } from './golden/dispatch-fakes.mjs';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { startDispatch } from '../../control-plane/agents/scripts/core/dispatcher.mjs';

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, 'golden/dispatch/cases.json'), 'utf8'));

/** @param {ReturnType<typeof fixture>} fx the fixture with the golden fake runtimes in place */
function withGoldenFakes(fx) {
  for (const n of /** @type {const} */ (['codex', 'claude', 'cli'])) { writeFileSync(path.join(fx.bin, `fake-${n}`), fakeRuntime(n)); chmodSync(path.join(fx.bin, `fake-${n}`), 0o755); }
}

/** @param {ReturnType<typeof fixture>} fx @param {string} s */
function norm(fx, s) {
  const tmp = path.dirname(fx.dir);
  let t = s.replace(/[^\s'"]*\/dispatch\.[A-Za-z0-9]+\//g, '<WORK>/');
  for (const root of [...new Set([fx.dir, realpathSync(fx.dir), posix(fx.dir), posix(realpathSync(fx.dir)), realpathSync.native(fx.dir), posix(realpathSync.native(fx.dir))])].sort((x, y) => y.length - x.length)) t = t.split(root).join('<ROOT>');
  for (const d of [...new Set([tmp, realpathSync(tmp), posix(tmp), posix(realpathSync(tmp)), realpathSync.native(tmp), posix(realpathSync.native(tmp))])].sort((x, y) => y.length - x.length)) t = t.split(d).join('<TMP>');
  return t;
}

/**
 * Run a recorded case and compare.
 * @param {ReturnType<typeof fixture>} fx @param {string} name @param {string[]} args @param {'codex' | 'claude' | 'cli'} runtime @param {Record<string, string>} [env]
 */
async function check(fx, name, args, runtime, env = {}) {
  fx.reset();
  const want = golden[name];
  assert.ok(want, `no recorded case ${name}`);
  const home = path.dirname(fx.dir);
  const r = await fx.dispatch(args.map((a) => (a === '<ASSIGNMENT>' ? path.join(home, 'assignment.txt') : a === '<UTF8>' ? path.join(home, 'utf8.txt') : a)), { HOME: home, ...env });
  assert.equal(r.code, want.status, `${name}: exit status\n${r.err}`);
  assert.equal(norm(fx, r.out), want.stdout, `${name}: stdout`);
  const rd = (/** @type {string} */ f) => { try { return readFileSync(path.join(fx.loc, f)); } catch { return null; } };
  const argv = rd(`${runtime}.argv`);
  assert.deepEqual(argv === null ? null : norm(fx, argv.toString('utf8')).split('\n').slice(0, -1), want.argv, `${name}: the arguments of the runtime`);
  const stdin = rd(`${runtime}.stdin`);
  assert.equal(stdin === null ? null : Buffer.from(norm(fx, stdin.toString('latin1')), 'latin1').toString('base64'), want.stdinBase64, `${name}: the prompt on stdin`);
  const envv = rd(`${runtime}.env`);
  assert.equal(envv === null ? null : norm(fx, envv.toString('utf8')).replace(/\n$/, ''), want.env, `${name}: the variables of the runtime`);
  return r;
}

describe('the dispatcher hands the runtime exactly what the shell dispatcher handed it', () => {
  const fx = fixture();
  withGoldenFakes(fx);
  const home = path.dirname(fx.dir);
  writeFileSync(path.join(home, 'assignment.txt'), 'Assignment line one.\nLine two with | pipes and "quotes".\n');
  writeFileSync(path.join(home, 'utf8.txt'), 'Çalışma ortamı: ğüşiöç İ — ✓ done\n');

  fakeTest('codex implementer: argument list, permission profile, prompt (window line, assignment) and variables', async () => {
    await check(fx, 'codex-implementer', ['LC', 'implementer', '--prompt-file', '<ASSIGNMENT>'], 'codex');
  });
  fakeTest('claude reviewer: --agents JSON from the role file with the default tools, the focus in the prompt and the variables', async () => {
    await check(fx, 'claude-reviewer-focus', ['LC', 'reviewer', '--focus', 'rules'], 'claude');
  });
  fakeTest('claude reviewer with a tools.conf row: Agent and Task are removed from the list', async () => {
    writeFileSync(path.join(fx.dir, '.agents/tools.conf'), 'reviewer Read,Grep,Agent,Task(x),Bash\n');
    try { await check(fx, 'claude-tools-conf', ['LC', 'reviewer', '--focus', 'rules'], 'claude'); } finally { rmSync(path.join(fx.dir, '.agents/tools.conf')); }
  });
  fakeTest('claude with a generated .claude agent: --agent only, no --agents JSON', async () => {
    mkdirSync(path.join(fx.dir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(fx.dir, '.claude/agents/proofline-security-reviewer.md'), '---\nname: proofline-security-reviewer\ntools: Read, Grep, Glob, Bash\n---\nbody\n');
    try { await check(fx, 'claude-generated-agent', ['LC', 'security_reviewer'], 'claude'); } finally { rmSync(path.join(fx.dir, '.claude/agents'), { recursive: true }); }
  });
  fakeTest('claude with dispatch.claude_permission_mode acceptEdits', async () => {
    fx.setConfig({ extra: { claude_permission_mode: 'acceptEdits' } });
    try { await check(fx, 'claude-accept-edits', ['LC', 'reviewer', '--focus', 'rules'], 'claude'); } finally { fx.setConfig(); }
  });
  fakeTest('explorer prompts (claude and codex with an assignment) name the token-derived scratch report', async () => {
    await check(fx, 'explorer-claude', ['LC', 'explorer', '--runtime', 'claude'], 'claude');
    await check(fx, 'explorer-codex-assignment', ['LC', 'explorer', '--runtime', 'codex', '--prompt-file', '<ASSIGNMENT>'], 'codex');
  });
  fakeTest('a command-template runtime: sh -c with every placeholder quoted, the prompt file it was given', async () => {
    await check(fx, 'template-mycli', ['LC', 'reviewer', '--runtime', 'mycli'], 'cli');
  });
  fakeTest('a designer during IMPLEMENTING is bracketed like the implementer (the window line is in its prompt)', async () => {
    await check(fx, 'designer-implementing', ['LC', 'designer', '--runtime', 'claude'], 'claude');
  });
  fakeTest('a rerun for no submission carries the retry note; the second attempt is token d002', async () => {
    await check(fx, 'retry-note', ['LC', 'reviewer', '--runtime', 'codex'], 'codex', { FAKE_LATE: '1' });
  });
  fakeTest('a resume note is put in the prompt and is spent when the step submits', async () => {
    fx.reset();
    mkdirSync(path.join(fx.dir, '.agents/runs/LC/dispatch'), { recursive: true });
    const note = path.join(fx.dir, '.agents/runs/LC/dispatch/RESUME-implementer.md');
    writeFileSync(note, golden['resume-note'].resumeBody);
    const want = golden['resume-note'];
    const r = await fx.dispatch(['LC', 'implementer'], { HOME: home });
    assert.equal(r.code, 0, r.err);
    assert.equal(Buffer.from(norm(fx, readFileSync(path.join(fx.loc, 'codex.stdin'), 'latin1')), 'latin1').toString('base64'), want.stdinBase64);
    assert.deepEqual(norm(fx, readFileSync(path.join(fx.loc, 'codex.argv'), 'utf8')).split('\n').slice(0, -1), want.argv);
    assert.equal(existsSync(note), false, 'the spent note is removed');
  });
  fakeTest('non-ASCII bytes of an assignment reach the runtime unchanged', async () => {
    await check(fx, 'utf8-assignment', ['LC', 'reviewer', '--runtime', 'codex', '--prompt-file', '<UTF8>'], 'codex');
  });
  fakeTest('the --agents JSON escapes a tab, quotes, a backslash and a carriage return; no trailing newline', async () => {
    const f = path.join(fx.dir, '.agents/roles/reviewer.md');
    const keep = readFileSync(f);
    writeFileSync(f, 'You are the reviewer.\tTab, "quotes", back\\slash, CR\r\nline two\n\nlast line without newline');
    try { await check(fx, 'json-escapes', ['LC', 'reviewer', '--focus', 'rules'], 'claude'); } finally { writeFileSync(f, keep); }
  });
  fakeTest('HOME of a Codex worker (PROOFLINE_CODEX_HOME_DIR) and of a Claude worker started from an isolated-HOME lead (PROOFLINE_REAL_HOME)', async () => {
    const isolated = path.join(home, 'isolated-home');
    await check(fx, 'isolated-homes', ['LC', 'implementer'], 'codex', { PROOFLINE_CODEX_HOME_DIR: isolated });
    await check(fx, 'isolated-homes-claude', ['LC', 'reviewer', '--focus', 'rules'], 'claude', { HOME: isolated, PROOFLINE_REAL_HOME: path.join(home, 'real-home') });
  });
});

describe('the Codex permission profile (dispatch codex-profile ID)', () => {
  /** Write the record that `worktree-add` keeps (A263): the real path of the git folder of the worktree ID, as git reports it. @param {ReturnType<typeof fixture>} fx @param {string} id */
  function recordEntry(fx, id) {
    const wt = path.join(fx.loc, 'worktrees', id);
    const gd = realpathSync(path.resolve(wt, spawnSync('git', ['-C', wt, 'rev-parse', '--git-dir'], { env: fx.env, encoding: 'utf8' }).stdout.trim()));
    mkdirSync(path.join(fx.loc, 'wt-entries'), { recursive: true });
    writeFileSync(path.join(fx.loc, 'wt-entries', `${id}.entry`), `${posix(gd)}\n`);
  }
  /** @param {string} cwd @param {string} script @param {ReturnType<typeof fixture>} fx */
  const profile = (cwd, script, fx) => norm(fx, spawnSync('sh', [posix(script), 'codex-profile', 'LC'], { cwd, env: fx.env, encoding: 'utf8' }).stdout).split('\n').slice(0, -1);
  test('a run in the main tree: .agents read-only, the run folder, locks and submissions writable, nothing of .git', () => {
    const fx = fixture();
    assert.deepEqual(profile(fx.dir, path.join(fx.dir, '.agents/scripts/dispatch.sh'), fx), golden._profiles.main);
  });
  test('a run in a worktree: the main tree locks folder, the worktree\'s own git folder and the common objects folder, and nothing else', () => {
    const fx = fixture();
    const g = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', fx.dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { env: fx.env, encoding: 'utf8' });
    g('commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(path.join(fx.loc, 'worktrees'), { recursive: true });
    g('worktree', 'add', '-q', '--detach', path.join(fx.loc, 'worktrees/LC'), 'HEAD');
    recordEntry(fx, 'LC');
    const wt = realpathSync(path.join(fx.loc, 'worktrees/LC'));
    mkdirSync(path.join(wt, '.agents/runs/LC'), { recursive: true });
    cpSync(path.join(fx.dir, '.agents/scripts'), path.join(wt, '.agents/scripts'), { recursive: true });
    // the recording was made with the main tree under its real path: the worktree profile names it
    assert.deepEqual(profile(wt, path.join(wt, '.agents/scripts/dispatch.sh'), fx), golden._profiles.worktree);
  });
  /** A project with a run worktree LC and a second one T2, the control plane copied into LC; `tamper(wt, t2)` runs before the dispatch. */
  function twoWorktrees(/** @type {(wt: string, t2: string) => void} */ tamper) {
    const fx = fixture();
    const g = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', fx.dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { env: fx.env, encoding: 'utf8' });
    g('commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(path.join(fx.loc, 'worktrees'), { recursive: true });
    g('worktree', 'add', '-q', '--detach', path.join(fx.loc, 'worktrees/LC'), 'HEAD');
    g('worktree', 'add', '-q', '--detach', path.join(fx.loc, 'worktrees/T2'), 'HEAD');
    recordEntry(fx, 'LC'); recordEntry(fx, 'T2');
    recordEntry(fx, 'LC'); recordEntry(fx, 'T2');
    const wt = realpathSync(path.join(fx.loc, 'worktrees/LC')); const t2 = realpathSync(path.join(fx.loc, 'worktrees/T2'));
    // entry by entry, `local` left out: Node 22.13 refuses to copy a folder into one of its own subfolders (the worktrees live under .agents/local)
    for (const n of readdirSync(path.join(fx.dir, '.agents'))) if (n !== 'local') cpSync(path.join(fx.dir, '.agents', n), path.join(wt, '.agents', n), { recursive: true });
    tamper(wt, t2);
    return { fx, wt };
  }
  /** The worker rewrites the `.git` file of LC to name the git folder of T2. */
  const tamperGitFile = (/** @type {string} */ wt, /** @type {string} */ t2) => {
    const text = readFileSync(path.join(t2, '.git'), 'utf8');
    rmSync(path.join(wt, '.git'), { force: true });   // Windows: git marks the file hidden, and a hidden file cannot be opened for writing (EPERM); it is replaced
    writeFileSync(path.join(wt, '.git'), text);
  };
  test('a worktree whose .git file names another run\'s git folder: the codex-profile verb stops with the status 2 and prints no profile', () => {
    const { fx, wt } = twoWorktrees(tamperGitFile);
    const r = spawnSync('sh', [posix(path.join(wt, '.agents/scripts/dispatch.sh')), 'codex-profile', 'LC'], { cwd: wt, env: fx.env, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Codex profile is not built/);
  });
  test('A263 round 3: a worktree whose .git is a symlink to another run\'s .git file (its own entry rewritten) is refused by the verb, status 2, no profile; without a record too', { skip: process.platform === 'win32' ? 'symbolic links need a privilege on Windows; the lstat rule runs in codexprofile.test.mjs' : false }, () => {
    const { fx, wt } = twoWorktrees((w, t2) => {
      rmSync(path.join(w, '.git'), { force: true });
      symlinkSync(path.join(t2, '.git'), path.join(w, '.git'));
    });
    const run = () => spawnSync('sh', [posix(path.join(wt, '.agents/scripts/dispatch.sh')), 'codex-profile', 'LC'], { cwd: wt, env: fx.env, encoding: 'utf8' });
    const r = run();
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /is a link/);
  });
  test('A263 round 3: a worktree made by hand (no record of the core) is refused by the verb: status 2, no profile', () => {
    const { fx, wt } = twoWorktrees(() => {});
    rmSync(path.join(fx.loc, 'wt-entries', 'LC.entry'));
    const r = spawnSync('sh', [posix(path.join(wt, '.agents/scripts/dispatch.sh')), 'codex-profile', 'LC'], { cwd: wt, env: fx.env, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /no record/);
  });
  test('the same refusal during a dispatch of a Codex role: the result is BLOCKED (exit 6) with the reason, and no runtime is started', async () => {
    const { fx, wt } = twoWorktrees(tamperGitFile);
    /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
    const io = { env: fx.env, cwd: wt, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: path.join(wt, '.agents/scripts/proofline-core.mjs') };
    const code = await startDispatch(io, ['LC', 'implementer', '--runtime', 'codex'], { run, graceMs: 300, minTimeoutSeconds: 1 }).done;
    const text = Buffer.concat(out).toString('latin1') + Buffer.concat(err).toString('latin1');
    assert.equal(code, 6, text);
    assert.match(text, /RESULT: BLOCKED[\s\S]*Codex profile is not built/);
    assert.equal(existsSync(path.join(fx.loc, 'codex.argv')), false, 'the runtime was started');
  });
});
