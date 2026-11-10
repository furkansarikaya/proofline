// @ts-check
// Helpers of the Node tests that replace batch-test.sh (A225, #172): a project with task files, the control-plane scripts, a bare origin, a fake platform tool,
// fake sleep inhibitors, and the lead played by the test (fake_run, fake_deliver, drive). Every asserted action is a plain call of the real control plane
// (`sh .agents/scripts/agent.sh`, the Node core); the fixture STATE of a scaffolded run is built by the self-test library's own verbs (legacy-lib.mjs).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { cleanEnv } from '../hook/harness.mjs';
import { A, project, say, scripts, verbs } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';

export { A, say, verbs };

/** Shell text of the self-test library that the cover scenarios need before `scaffold` (the task files and the scripts go into the template baseline). */
export const PRELUDE = String.raw`
mktask() {
  mt_d=.agents/tasks; [ -z "\${4:-}" ] || mt_d=.agents/tasks/$4; mkdir -p "$mt_d"
  { printf '# Task: %s — title of %s\n' "$1" "$1"
    if [ -n "\${3:-}" ]; then printf '\n---\ndepends_on: %s\n\n---\n' "$3"; fi
    printf '\n## Goal\n\nIt works.\n\n## Context\n\nFixture.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n'
    if [ "$2" != none ]; then printf '\n## Suggested class\n\n%s\n' "$2"; fi; } > "$mt_d/$1.md"
}
install_scripts() {
  for is_s in "$tl_agents"/scripts/*.sh; do
    case "$(basename "$is_s")" in *-test.sh|agent.sh|exec-policy.sh|secret-scan.sh) continue ;; esac
    cp "$is_s" "$1/"
  done
  rm -f "$1/../task-integrations/markdown.sh"
}
tpl_tasks() {
  tl_ensure_template; tpl_p=$(mktemp -d "$base/tpl.XXXXXX"); cp -R "$tl_template/." "$tpl_p/"; tl_template=$tpl_p
  install_scripts "$tl_template/.agents/scripts"; ( cd "$tl_template" && mktask LC COMPLEX && mktask CR CRITICAL ); }
`.replace(/\\\$\{/g, '${');

/** A fresh project without task files. */
export function bnew() { return project('new_repo; rm -rf .agents/tasks'); }
/** A scaffolded run LC (COMPLEX, manual autonomy, unfrozen) with the task files and the scripts in the baseline. @param {string} [flags] shell prefix such as `SC_BRANCH=1` @param {string} [topo] */
export function coverProject(flags = '', topo = 'standalone no COMPLEX manual') {
  return project(`${PRELUDE}\ntpl_tasks; ${flags} scaffold ${topo}`);
}

export const sh = (/** @type {string} */ cwd, /** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}, input = '') => {
  const r = spawnSync(cmd, args, { cwd, env: cleanEnv(env), encoding: 'utf8', input });
  return { status: r.status, out: String(r.stdout), err: String(r.stderr), text: String(r.stdout) + String(r.stderr) };
};
/** git in a directory; the output without its trailing newline. */
export const g = (/** @type {string} */ cwd, /** @type {string[]} */ args) => sh(cwd, 'git', args).out.replace(/\n+$/, '');
export const gOk = (/** @type {string} */ cwd, /** @type {string[]} */ args) => { const r = sh(cwd, 'git', args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.text}`); return r.out.replace(/\n+$/, ''); };

export const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
export const readIf = (/** @type {string} */ f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
export const has = (/** @type {string} */ f) => existsSync(f);
export const lines = (/** @type {string} */ f) => readIf(f).split('\n').filter((l) => l !== '');
export const real = (/** @type {string} */ p) => spawnSync('sh', ['-c', 'cd "$1" && pwd -P', 'x', p], { encoding: 'utf8' }).stdout.trim();

const toolRoot = path.join(repo, 'tests/core/.fake-tools', `batch-${process.pid}`);
mkdirSync(toolRoot, { recursive: true });
after(() => { rmSync(toolRoot, { recursive: true, force: true }); });
let counter = 0;

/**
 * The fake tools of one test: gh (authenticated, main CI green; the merge commit's run answers from FAKE/ci/<sha>), caffeinate and systemd-inhibit (they record
 * their arguments), and the state folder FAKE (calls.log, behave/<ID>, prview). The platform tool lives inside the checkout, never under a temporary folder (A180).
 */
export function fakes() {
  const id = ++counter;
  const FAKE = mkdtempSync(path.join(tmpdir(), 'bt-fake-'));
  const ghbin = path.join(toolRoot, String(id), 'bin');
  mkdirSync(ghbin, { recursive: true });
  for (const d of ['bin', 'behave', 'ci']) mkdirSync(path.join(FAKE, d), { recursive: true });
  writeFileSync(path.join(FAKE, 'calls.log'), '');
  writeFileSync(path.join(ghbin, 'gh'), `#!/bin/sh
FAKE='${FAKE}'
sha=''; prev=''; for a in "$@"; do [ "$prev" != --commit ] || sha=$a; prev=$a; done
if [ -n "$sha" ] && [ -f "$FAKE/ci/$sha" ]; then cat "$FAKE/ci/$sha"; exit 0; fi
if [ -n "$sha" ] && [ -f "$FAKE/ci/$sha.none" ]; then echo '[]'; exit 0; fi
case "$*" in
  *"run list"*) echo '[{"status":"completed","conclusion":"success"}]' ;;
  *"pr view"*"state,isDraft"*) set -- $(cat "$FAKE/prview" 2>/dev/null || echo "OPEN false aaa b main o")
    printf '{"state":"%s","isDraft":%s,"headRefOid":"%s","headRefName":"%s","baseRefName":"%s","headRepositoryOwner":{"login":"%s"}}\\n' "$1" "$2" "$3" "$4" "$5" "$6" ;;
  *"pr view"*) echo '{"mergeCommit":{"oid":"0123456789abcdef0123456789abcdef01234567"}}' ;;
  *) : ;;
esac
exit 0
`);
  writeFileSync(path.join(FAKE, 'bin/caffeinate'), `#!/bin/sh
printf '%s\\n' "$*" >> "${FAKE}/caffeinate.argv"; echo $$ > "${FAKE}/caffeinate.pid"
w=''; while [ $# -gt 0 ]; do [ "$1" != -w ] || w=$2; shift; done
[ -n "$w" ] || exit 0
while kill -0 "$w" 2>/dev/null; do sleep 0.2; done
`);
  writeFileSync(path.join(FAKE, 'bin/systemd-inhibit'), `#!/bin/sh
printf '%s\\n' "$*" >> "${FAKE}/inhibit.argv"
while :; do case "\${1:-}" in --*) shift ;; *) break ;; esac; done
exec "$@"
`);
  for (const f of [path.join(ghbin, 'gh'), path.join(FAKE, 'bin/caffeinate'), path.join(FAKE, 'bin/systemd-inhibit')]) chmodSync(f, 0o755);
  after(() => { rmSync(FAKE, { recursive: true, force: true }); });
  const env = { PATH: `${ghbin}:${path.join(FAKE, 'bin')}:${process.env.PATH}`, PROOFLINE_TEST: '1' };
  return { FAKE, env, calls: () => readIf(path.join(FAKE, 'calls.log')).split('\n').filter((l) => l !== '').join(' ') };
}

/** One call of the control plane with the fake tools on PATH. @param {{ env: Record<string, string> }} F @param {string} dir @param {string[]} args @param {{ role?: string, env?: Record<string, string> }} [o] */
export function AB(F, dir, args, o = {}) { return A(dir, args, { role: o.role, env: { ...F.env, ...(o.env ?? {}) } }); }

/** A task file under .agents/tasks[/SUB]. @param {string} dir @param {string} id @param {string} cls CLASS or 'none' @param {string} [deps] @param {string} [sub] */
export function mktask(dir, id, cls, deps = '', sub = '') {
  const d = path.join(dir, '.agents/tasks', sub);
  mkdirSync(d, { recursive: true });
  let t = `# Task: ${id} — title of ${id}\n`;
  if (deps !== '') t += `\n---\ndepends_on: ${deps}\n\n---\n`;
  t += '\n## Goal\n\nIt works.\n\n## Context\n\nFixture.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n';
  if (cls !== 'none') t += `\n## Suggested class\n\n${cls}\n`;
  writeFileSync(path.join(d, `${id}.md`), t);
}
/** A task with front matter priority (and depends_on). */
export function mkprio(dir, id, prio, deps = '') {
  mktask(dir, id, 'STANDARD');
  const f = path.join(dir, `.agents/tasks/${id}.md`);
  const rows = read(f).split('\n');
  writeFileSync(f, [rows[0], '', '---', `priority: ${prio}`, ...(deps ? [`depends_on: ${deps}`] : []), '', '---', ...rows.slice(1)].join('\n'));
}

/** The control-plane scripts a fixture lacks, committed, a CI workflow and (by default) a local bare origin. @param {string} dir @param {{ remote?: boolean, F?: ReturnType<typeof fakes> }} [o] */
export function binstall(dir, o = {}) {
  const dst = path.join(dir, '.agents/scripts');
  for (const n of readdirSync(scripts)) {
    if (!n.endsWith('.sh') || n.endsWith('-test.sh') || ['agent.sh', 'exec-policy.sh', 'secret-scan.sh'].includes(n)) continue;
    copyFileSync(path.join(scripts, n), path.join(dst, n));
  }
  rmSync(path.join(dir, '.agents/task-integrations/markdown.sh'), { force: true });
  mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'name: ci\non: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n');
  gOk(dir, ['add', '-A']);
  gOk(dir, ['commit', '-qm', 'fixture', '--allow-empty']);
  if (o.remote !== false) {
    const origin = mkdtempSync(path.join(tmpdir(), 'bt-origin-'));
    gOk(dir, ['init', '-q', '--bare', origin]);
    gOk(dir, ['remote', 'add', 'origin', origin]);
    sh(dir, 'git', ['push', '-q', '-u', 'origin', 'main']);
    after(() => { rmSync(origin, { recursive: true, force: true }); });
  }
}

/** Replace the batch: block of the fixture config. @param {string} dir @param {number|string} cap @param {string[]} [extra] more keys */
export function cfgBatch(dir, cap, extra = []) {
  const f = path.join(dir, '.agents/config.yaml');
  const keep = [];
  let skip = false;
  for (const l of read(f).split('\n')) {
    if (l.startsWith('batch:')) { skip = true; continue; }
    if (skip && /^[^\s#]/.test(l)) skip = false;
    if (!skip) keep.push(l);
  }
  while (keep.length && keep[keep.length - 1] === '') keep.pop();
  writeFileSync(f, `${keep.join('\n')}\nbatch:\n  mutation_budget_cap: ${cap}\n  ci_wait_minutes: 1\n${extra.map((e) => `${e}\n`).join('')}`);
}

/** The user's "approve batch", as the prompt hook captured it (stamped after every record, a capture from the future is ignored), then approve-pending. @param {string} dir */
export function batchApprove(dir) {
  say(dir, 'approve batch');
  A(dir, ['approve-pending']);
}
/** The ids of order.tsv, space-joined. @param {string} dir */
export const orderIds = (dir) => lines(path.join(dir, '.agents/local/batch/order.tsv')).map((l) => l.split('\t')[0]).join(' ');
export const summaryOf = (/** @type {string} */ dir) => readIf(path.join(dir, '.agents/local/batch/SUMMARY.md'));
/** Files of DIR whose names match RE. */
export const nfiles = (/** @type {string} */ dir, /** @type {RegExp} */ re) => { try { return readdirSync(dir).filter((n) => re.test(n)).length; } catch { return 0; } };
export const wtp = (/** @type {string} */ dir, /** @type {string} */ id) => `${real(dir)}/.agents/local/worktrees/${id}`;

// ---- the lead, played by the test ---------------------------------------------------------------------------------------------------------------------
/** @param {ReturnType<typeof fakes>} F @param {string} id */
export const behOf = (F, id) => { const b = readIf(path.join(F.FAKE, 'behave', id)).split('\n')[0]; return b || 'merge'; };
/** @param {ReturnType<typeof fakes>} F @param {string} id @param {string} v */
export const behave = (F, id, v) => writeFileSync(path.join(F.FAKE, 'behave', id), `${v}\n`);
/** The handoff state in the run's own RUN.yaml. @param {string} dir @param {string} id @param {string} state */
export function setHandoff(dir, id, state) {
  const f = `${wtp(dir, id)}/.agents/runs/${id}/RUN.yaml`;
  let h = false;
  writeFileSync(f, read(f).split('\n').map((l) => {
    if (l.startsWith('handoff:')) { h = true; return l; }
    if (h && /^[^ ]/.test(l)) h = false;
    return h && l.startsWith('  state:') ? `  state: ${state}` : l;
  }).join('\n'));
}
/** The run waits for the user. @param {string} dir @param {string} id */
export function askQuestion(dir, id) {
  const d = `${wtp(dir, id)}/.agents/runs/${id}`;
  mkdirSync(`${d}/questions`, { recursive: true });
  writeFileSync(`${d}/RUN.yaml`, read(`${d}/RUN.yaml`).replace(/^ {2}awaiting_input: false/m, '  awaiting_input: true'));
  writeFileSync(`${d}/questions/001.md`, `from: lead\nasked_at: ${Math.floor(Date.now() / 1000)}\n---\n1. Which cache do we use for ${id}?\n   options: a | b\n`);
}
/** "NEXT: run ID": a worktree, the real `agent.sh start` in it, then what the run ends up as. */
export function fakeRun(F, dir, id) {
  appendFileSync(path.join(F.FAKE, 'calls.log'), `run ${id}\n`);
  const w = AB(F, dir, ['worktree-add', id]);
  if (w.status !== 0) throw new Error(`worktree-add ${id}: ${w.text}`);
  const wt = w.out.trim();
  const s = AB(F, wt, ['start', id, '--task-file', `.agents/tasks/${id}.md`]);
  if (s.status !== 0) throw new Error(`start ${id} failed in its worktree: ${s.text}`);
  const b = behOf(F, id);
  if (b === 'question') askQuestion(dir, id);
  else if (b === 'fail') { const f = `${wt}/.agents/runs/${id}/RUN.yaml`; writeFileSync(f, read(f).replace(/^ {2}state: PLANNING/m, '  state: FAILED')); }
  else setHandoff(dir, id, 'CODE_DONE');
}
export function fakeResume(F, dir, id) {
  appendFileSync(path.join(F.FAKE, 'calls.log'), `resume ${id}\n`);
  if (!['question', 'fail'].includes(behOf(F, id))) setHandoff(dir, id, 'CODE_DONE');
}
export function fakeDeliver(F, dir, id) {
  appendFileSync(path.join(F.FAKE, 'calls.log'), `deliver ${id}\n`);
  const wt = wtp(dir, id);
  if (behOf(F, id) === 'await') { mkdirSync(`${wt}/.agents/local/deliver/${id}`, { recursive: true }); writeFileSync(`${wt}/.agents/local/deliver/${id}/PR`, '77\n'); return; }
  rmSync(`${wt}/.agents/runs/${id}`, { recursive: true, force: true });
  const n = Number(id.replace(/[^0-9]/g, '') || 0);
  appendFileSync(`${dir}/.agents/local/batch/merged.tsv`, `${id}\t${100 + n}\t${Math.floor(Date.now() / 1000)}\n`);
  const r = AB(F, dir, ['worktree-remove', id]);
  if (r.status !== 0) throw new Error(`worktree-remove ${id}: ${r.text}`);
}
/** The text after "NEXT: " of the first line that has it. */
export const nextline = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir) => (AB(F, dir, ['batch-next']).out.split('\n').find((l) => l.startsWith('NEXT: ')) ?? '').slice(6);
/** Act on "NEXT:" until finished, or MAX actions (an interruption). */
export function drive(F, dir, max = 0) {
  let n = 0;
  for (;;) {
    const nl = nextline(F, dir);
    const [verb, id] = nl.split(' ');
    if (verb === 'finished') return;
    if (verb === 'run') fakeRun(F, dir, id);
    else if (verb === 'resume') fakeResume(F, dir, id);
    else if (verb === 'deliver') fakeDeliver(F, dir, id);
    else if (verb === 'ci') { const r = AB(F, dir, ['batch-ci', id]); if (r.status !== 0) throw new Error(`batch-ci ${id} failed: ${r.text}`); } else throw new Error(`unexpected NEXT: '${nl}'`);
    n++;
    if (n >= 60) throw new Error('drive does not end');
    if (max !== 0 && n >= max) return;
  }
}
/** Replace a file's content atomically. */
export const put = (/** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); };
export { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, path, tmpdir, scripts, repo };
