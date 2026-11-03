// @ts-check
// Helpers of the stage 6 tests (delivery in Node, A215): a fake platform tool outside every temporary folder (the A180 rule refuses a tool that resolves into
// the project, the working directory or a temporary folder; no environment value lifts it), the delivery chain driven step by step, and a git helper.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { cleanEnv } from '../hook/harness.mjs';
import { A, accepted, refused, say, verbs } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';

/** Where the fake platform tools live: inside the checkout, never under a temporary folder. */
const toolRoot = path.join(repo, 'tests/core/.fake-tools');
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
  const state = mkdtempSync(path.join(tmpdir(), 'gh-state-'));
  mkdirSync(bin, { recursive: true });
  for (const f of ['gh.runs', 'gh.log', 'gh.checks', 'ghstate', 'gh.merge', 'gh.calls']) writeFileSync(path.join(state, f), '');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${state}/gh.calls"\ncase "$1 $2" in\n  "run list") cat "${state}/gh.runs" ;;\n  "run view") cat "${state}/gh.log" ;;\n  "pr checks") cat "${state}/gh.checks" ;;\n  "pr view") case "$*" in *mergeCommit*) cat "${state}/gh.merge" ;; *) cat "${state}/ghstate" ;; esac ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  after(() => { rmSync(state, { recursive: true, force: true }); });
  return {
    bin, state,
    env: { PATH: `${bin}:${process.env.PATH}` },
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
  writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bin, name), 0o755);
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
export function approveDelivery(d, text = 'approve delivery') {
  say(d, text);
  return accepted(A(d, ['approve-pending', 'LC']), 'approve-pending');
}

/** origin (never fetched or pushed) and the legacy git hooks for the commit and push gates. @param {string} d */
export function hooks(d) {
  if (g(d, 'remote') === '') gOk(d, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const hd = `${d}-hooks`;
  mkdirSync(hd, { recursive: true });
  accepted({ ...run(d, 'node', [path.join(repo, 'tests/legacy-githooks/install.mjs'), hd]), out: '', err: '', text: '' }, 'hooks');
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

export { A, accepted, refused, say, verbs, existsSync, readdirSync, readFileSync, writeFileSync, path };
