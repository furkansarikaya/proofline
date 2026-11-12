// @ts-check
// Helpers of the stage 6 tests (delivery in Node, A215): a fake platform tool outside every temporary folder (the A180 rule refuses a tool that resolves into
// the project, the working directory or a temporary folder; no environment value lifts it), the delivery chain driven step by step, and a git helper.
import { tempDir } from '../lib/tempdir.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { cleanEnv } from '../hook/harness.mjs';
import { installGithooks } from '../lib/harness.mjs';
import { A, accepted, refused, say, verbs } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';
import { fakeExe } from '../lib/winfake.mjs';

/** A PATH value with the folder FIRST and the rest after it, in the host's separator (`:` is the separator of POSIX only; a drive letter holds one on Windows). @param {string} first @param {string | undefined} rest */
export function joinPath(first, rest) { return `${first}${path.delimiter}${rest ?? ''}`; }

/** The fake `gh` of a Windows host: the same answers as the shell script of fakeGh, from the files of the state folder (STATE is replaced by the folder). */
const GH_SCRIPT = `import { appendFileSync, readFileSync } from 'node:fs';
const state = __STATE__; const a = process.argv.slice(2);
appendFileSync(state + '/gh.calls', a.join(' ') + '\\n');
const out = (f) => { process.stdout.write(readFileSync(state + '/' + f)); };
const k = a[0] + ' ' + a[1];
if (k === 'run list') out('gh.runs'); else if (k === 'run view') out('gh.log'); else if (k === 'pr checks') out('gh.checks');
else if (k === 'pr view') out(a.join(' ').includes('mergeCommit') ? 'gh.merge' : 'ghstate'); else process.exitCode = 1;
`;

/** Where the fake platform tools live: inside the checkout, never under a temporary folder. */
export const toolRoot = path.join(repo, 'tests/core/.fake-tools', String(process.pid));
mkdirSync(toolRoot, { recursive: true });
after(() => { rmSync(toolRoot, { recursive: true, force: true }); });
let counter = 0;

/**
 * A directory with a fake `gh` that answers from files of a state directory: `run list` (gh.runs), `run view` (gh.log), `pr checks` (gh.checks), `pr view`
 * (ghstate), `pr view --json mergeCommit` (gh.merge). Any other call exits 1 and is logged to gh.calls.
 * @returns {{ bin: string, state: string, env: Record<string, string>, says: (state: string, head?: string) => void, calls: () => string }}
 */
export function fakeGh() {
  const id = `${process.pid}-${++counter}`;
  const bin = path.join(toolRoot, id, 'bin');
  const state = tempDir('gh-state-');
  mkdirSync(bin, { recursive: true });
  for (const f of ['gh.runs', 'gh.log', 'gh.checks', 'ghstate', 'gh.merge', 'gh.calls']) writeFileSync(path.join(state, f), '');
  if (process.platform === 'win32') {
    // a shell script is no program the Windows resolver runs (A252): a real gh.exe that starts this Node script (tests/lib/winfake.mjs)
    const script = path.join(bin, 'gh.mjs');
    writeFileSync(script, GH_SCRIPT.replace('__STATE__', JSON.stringify(state)));
    fakeExe(toolRoot, bin, 'gh', script);
  } else {
    writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${state}/gh.calls"\ncase "$1 $2" in\n  "run list") cat "${state}/gh.runs" ;;\n  "run view") cat "${state}/gh.log" ;;\n  "pr checks") cat "${state}/gh.checks" ;;\n  "pr view") case "$*" in *mergeCommit*) cat "${state}/gh.merge" ;; *) cat "${state}/ghstate" ;; esac ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(path.join(bin, 'gh'), 0o755);
  }
  after(() => { rmSync(state, { recursive: true, force: true }); });
  return {
    bin, state,
    env: { PATH: joinPath(bin, process.env.PATH) },
    /** The pull request as the platform shows it: STATE (OPEN/MERGED), draft false, HEAD BRANCH BASE OWNER default to this delivery's. @param {string} st @param {string} [head] */
    says(st, head = '') {
      const [h = '', br = 'proofline/LC-lookup', base = 'main', owner = 'acme'] = head.split(' ');
      writeFileSync(path.join(state, 'ghstate'), JSON.stringify({ state: st, isDraft: false, headRefOid: h, headRefName: br, baseRefName: base, headRepositoryOwner: { login: owner } }));
    },
    calls: () => readFileSync(path.join(state, 'gh.calls'), 'utf8'),
  };
}

/** A tool of the given name that does nothing, in a fresh fake bin. @param {string} name */
export function fakeTool(name) {
  const bin = path.join(toolRoot, `${process.pid}-${++counter}`, 'bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    const script = path.join(bin, `${name}.mjs`);
    writeFileSync(script, 'process.exit(0);\n');
    fakeExe(toolRoot, bin, name, script);
  } else {
    writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

/** A command in a directory with the fixture environment. @param {string} cwd @param {string} cmd @param {string[]} args @param {Record<string, string>} [env] */
export function run(cwd, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd, env: cleanEnv(env), encoding: 'utf8' });
  return { status: r.status, out: String(r.stdout), err: String(r.stderr), text: String(r.stdout) + String(r.stderr) };
}
/** git in a directory; the output without its trailing newline. @param {string} cwd @param {string[]} args */
export function g(cwd, ...args) { return run(cwd, 'git', args).out.replace(/\n+$/, ''); }
/** git that must succeed. @param {string} cwd @param {string[]} args */
export function gOk(cwd, ...args) { const r = run(cwd, 'git', args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.text}`); return r.out.replace(/\n+$/, ''); }

/** Recipes (shell text for the self-test library). */
export const CODE_DONE = 'SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated';
export const DONE = `${CODE_DONE}; finish_done`;
export const TASKS_IN_TASKS = "sed 's#^  dir: .agents/tasks#  dir: tasks#' .agents/config.yaml > .agents/cfg.tmp && cp .agents/cfg.tmp .agents/config.yaml && rm .agents/cfg.tmp";

/** The user's delivery reply, recorded as the runtime hook does. @param {string} d @param {string} [text] */
export function approveDelivery(d, text = 'approve delivery', at = d) {
  // the requests live in the worktree, the capture in the main tree: the capture must be newer than the requests
  say(d, text, at === d ? {} : { time: Math.floor(Date.now() / 1000) + 1 });
  return accepted(A(at, ['approve-pending', 'LC']), 'approve-pending');
}

/** origin (never fetched or pushed) and the shipped git hooks (the core's `cli pre-commit|pre-push`, one folder outside the project that serves the main tree and every run worktree) for the commit and push gates. @param {string} d */
export function hooks(d) {
  if (g(d, 'remote') === '') gOk(d, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const hd = installGithooks(d, `${d}-hooks`);
  gOk(d, 'config', 'core.hooksPath', hd);
}

/** What `git push` and the pre-push hook do for the delivery's branch (the push itself is simulated). @param {string} d */
export function pushed(d) {
  const br = g(d, 'branch', '--show-current');
  gOk(d, 'update-ref', `refs/remotes/origin/${br}`, 'HEAD');
  accepted(A(d, ['approval-consume', 'LC', 'push', '', `refs/heads/${br}`]), 'approval-consume push');
}

/** The commit step the lead runs: task-source-done, add, commit with the approved message. @param {string} d @param {string} [cwd] */
export function commitDelivery(d, cwd = d) {
  A(cwd, ['task-source-done', 'LC']);
  gOk(cwd, 'add', '-A');
  const r = run(cwd, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']);
  if (r.status !== 0) throw new Error(`the approved commit was blocked: ${r.text}`);
}

/** @type {string | undefined} */
let sansTools;
/**
 * A PATH with the folders of this process's PATH, minus the platform tools (gh, glab, az) that the host happens to have: one folder of links (inside the checkout)
 * to every other program of those folders. A test that needs "no platform tool" runs with this, so it does not depend on the machine (a CI runner has /usr/bin/gh
 * and /usr/bin/az). A tool the test puts in front of it is found first.
 * @returns {string}
 */
export function pathWithoutPlatformTools() {
  if (sansTools !== undefined) return sansTools;
  const d = path.join(toolRoot, `sans-${process.pid}`);
  mkdirSync(d, { recursive: true });
  const seen = new Set(['gh', 'glab', 'az']);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      try { symlinkSync(path.join(dir, n), path.join(d, n)); } catch { /* not linkable */ }
    }
  }
  sansTools = d;
  return d;
}

export { A, accepted, refused, say, verbs, existsSync, readdirSync, readFileSync, writeFileSync, path };
