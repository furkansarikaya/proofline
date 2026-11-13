// @ts-check
// The pure part of the golden port of the equivalence-rig cases (no node:test import: the one-time recorder uses it too) (tests/equivalence, to be deleted). A rig case is a fixture state plus a list of steps (a command call, a file
// write, a plain command). Each case was run ONCE on the shell (tests/fixtures/port-t3/record-rig.mjs) and what it did is stored in
// tests/fixtures/port-t3/<group>.json.gz: the outputs of every step and the delta it left on the project (changed or new files by path, removed paths,
// the change of the git state), all after the closed normalisation of the rig (port-t3-normalise.mjs). Here the Node core runs the same steps on the
// restored state and must leave exactly that. Nothing runs or compares with the shell at test time.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { fakeExe } from '../lib/winfake.mjs';
import { normaliseSide } from './port-t3-normalise.mjs';

/** Every file under root except .git/: path -> mode and bytes (a symlink holds its target; an empty directory is `<dir>/`). EXEC (win32 only): the paths a step wrote with an execute bit, which NTFS cannot keep (they read back as 0755). @param {string} root @param {Set<string>} [exec] @returns {Map<string, { mode: number, data: Buffer }>} */
export function snapTree(root, exec = new Set()) {
  // NTFS has no permission bits: Node reports 0666 for a file and 0777 for a folder. The recorded values are the POSIX ones (0644 / 0755), so on win32 a file is read with umask 022 applied and a folder as 0755; an execute bit cannot be represented (A262)
  const modeOf = (/** @type {number} */ m, /** @type {boolean} */ dir = false) => (process.platform === 'win32' ? (dir ? 0o755 : ((m & 0o7777) & ~0o022)) : m & 0o7777);
  /** @type {Map<string, { mode: number, data: Buffer }>} */ const m = new Map();
  const walk = (/** @type {string} */ rel) => {
    for (const n of readdirSync(path.join(root, rel)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const r = rel ? `${rel}/${n}` : n; if (r === '.git') continue;
      const st = lstatSync(path.join(root, r));
      if (st.isDirectory()) { walk(r); if (readdirSync(path.join(root, r)).length === 0) m.set(`${r}/`, { mode: modeOf(st.mode, true), data: Buffer.alloc(0) }); }
      else if (st.isSymbolicLink()) m.set(r, { mode: 0o120000, data: Buffer.from(readlinkSync(path.join(root, r))) });
      else m.set(r, { mode: modeOf(st.mode) | (process.platform === 'win32' && exec.has(r) ? 0o111 : 0), data: readFileSync(path.join(root, r)) });
    }
  };
  walk(''); return m;
}

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
};
/** The environment of a step: no global git config, no PROOFLINE_* from the caller, a fixed locale (what the rig gave each side). @param {string} home @param {Record<string, string>} extra */
export const stepEnv = (home, extra = {}) => ({ ...GIT_ENV, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), ...extra });

/** @param {string} root @param {string[]} a */
export const git = (root, ...a) => spawnSync('git', ['-C', root, ...a], { env: GIT_ENV, encoding: 'latin1' }).stdout ?? '';
/** The git state that a step can change: ref names, the porcelain status and the commits made since the start. @param {string} root @param {string} start */
export function gitInfo(root, start) {
  if (!existsSync(path.join(root, '.git'))) return { refs: '', status: [], ahead: 0 };
  return { refs: git(root, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).join(','), status: git(root, 'status', '--porcelain').split('\n').filter(Boolean).sort(), ahead: start ? Number(git(root, 'rev-list', '--count', `${start}..HEAD`).trim() || 0) : 0 };
}
/** @param {ReturnType<typeof gitInfo>} a @param {ReturnType<typeof gitInfo>} b */
export const gitChange = (a, b) => ({ refs: a.refs === b.refs ? '' : b.refs, added: b.status.filter((/** @type {string} */ x) => !a.status.includes(x)), removed: a.status.filter((/** @type {string} */ x) => !b.status.includes(x)), ahead: b.ahead });

/** The process ids a message names are those of the run (a dispatch marker names the test process): not reproducible. @param {string} t */
export const maskPids = (t) => t.replace(/\bpid([ =])(words )?\d+/g, 'pid$1$2<PID>').replace(/^started_epoch=\d+$/gm, 'started_epoch=<T>');

/**
 * What a case did, in the stored form: the normalised outputs and the delta of the project against its start.
 * @param {{ outputs: { code: number | null, stdout: string, stderr: string }[], files: Map<string, { mode: number, data: Buffer }>, initial: Map<string, { mode: number, data: Buffer }>, window: [number, number], tmpdir: string,
 *   root: string, baseSha: string, gitBefore: ReturnType<typeof gitInfo>, gitAfter: ReturnType<typeof gitInfo> }} r
 */
export function summarise(r) {
  /** @param {string} s */
  const mask = (s) => {
    let t = s.split(r.root).join('<ROOT>'); if (r.baseSha) t = t.split(r.baseSha).join('<BASE>');
    return maskPids(t);
  };
  /** @param {Map<string, { mode: number, data: Buffer }>} m */
  const masked = (m) => new Map([...m].map(([p, e]) => [p, { mode: e.mode, data: e.mode === 0o120000 ? e.data : Buffer.from(mask(e.data.toString('latin1')), 'latin1') }]));
  const outs = r.outputs.map((o) => ({ code: o.code, stdout: mask(o.stdout), stderr: mask(o.stderr) }));
  const after = normaliseSide({ outputs: outs, files: masked(r.files), window: r.window, tmpdir: r.tmpdir }, 'side');
  const before = normaliseSide({ outputs: [], files: masked(r.initial), window: r.window, tmpdir: r.tmpdir }, 'start');
  /** @type {Record<string, { mode: number, text: string }>} */ const changed = {};
  for (const [p, e] of after.files) { const b = before.files.get(p); if (!b || b.mode !== e.mode || !b.data.equals(e.data)) changed[p] = { mode: e.mode, text: e.data.toString('latin1') }; }
  const gone = [...before.files.keys()].filter((p) => !after.files.has(p)).sort();
  const sorted = Object.fromEntries(Object.entries(changed).sort(([a], [b]) => (a < b ? -1 : 1)));
  // a check that the start state already fails (a fixture whose approval capture is dated ahead of its approval) is the state's, not the case's
  const inherited = new Set(before.problems.map((x) => x.replace(/^start: /, '')));
  return { problems: after.problems.filter((x) => !inherited.has(x.replace(/^side: /, ''))), outputs: after.outputs, changed: sorted, gone, git: gitChange(r.gitBefore, r.gitAfter) };
}

/** @typedef {{ args?: string[], role?: string, env?: Record<string, string>, stdin?: string, cwd?: string, write?: { path: string, content: string, mode?: number }, exec?: string[] }} Step */

/** What a Windows run of the steps leaves behind: the paths written with an execute bit, and the folders of the real `.exe` twins (to remove). @typedef {{ exec: Set<string>, toolDirs: string[] }} Aux */

const STUB = /^#!\/bin\/sh\necho (?:"([^"$`\\]*)"|'([^']*)')\n$/;
let twins = 0;
/** @type {string | undefined} */ let toolRoot;
/** This process's own folder for the compiled launcher and the twins (git-ignored `tests/core/.fake-tools/rig-<pid>`, never shared with another test process); removed when the process ends. */
function rigToolRoot() {
  if (!toolRoot) {
    toolRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fake-tools', `rig-${process.pid}`);
    mkdirSync(toolRoot, { recursive: true });
    const dir = toolRoot;
    process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
  }
  return toolRoot;
}
/**
 * Windows (A267): a recorded step writes `stubbin/NAME`, a shell script that only echoes a line, and puts `stubbin` first on a recorded POSIX PATH. The Windows resolver runs only a real
 * `.exe` outside every temporary folder (A252, by design), and the POSIX PATH joined with `;` reaches no git at all. So the stub is still written (the recorded delta holds it), a real
 * `NAME.exe` that prints the same line is built in a git-ignored folder of the checkout, and the PATH of the step is that folder first, then the host's own PATH. Off Windows nothing happens.
 * @param {Aux} aux @param {{ path: string, content: string }} w @returns {string | null} the folder that now holds the twin
 */
function twinOf(aux, w) {
  const m = /^stubbin\/([a-z]+)$/.exec(w.path); const body = STUB.exec(w.content);
  if (!m || !body) throw new Error(`winfake: the stub ${w.path} is not a one-line echo script, add its twin by hand`);
  const dir = path.join(rigToolRoot(), `twin-${++twins}`);
  mkdirSync(dir, { recursive: true }); aux.toolDirs.push(dir);
  const script = path.join(dir, `${m[1]}.fake.mjs`);
  writeFileSync(script, `process.stdout.write(${JSON.stringify(`${body[1] ?? body[2]}\n`)});\n`);
  fakeExe(rigToolRoot(), dir, m[1], script);
  return dir;
}

/** Run the steps on the Node core (a command call), or as plain files and commands (a write, an exec), in the project root. AUX (Windows): see `Aux`. @param {string} root @param {string} home @param {string} tmp @param {Step[]} steps @param {Aux} [aux] */
export function runSteps(root, home, tmp, steps, aux = { exec: new Set(), toolDirs: [] }) {
  const win = process.platform === 'win32';
  /** @type {string[]} */ const twinDirs = [];
  /** @type {{ code: number | null, stdout: string, stderr: string }[]} */ const outputs = [];
  for (const step of steps) {
    let s = step;
    if (s.write) {
      const p = path.join(root, s.write.path); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s.write.content); if (s.write.mode !== undefined) chmodSync(p, s.write.mode);
      if (win && s.write.mode !== undefined && (s.write.mode & 0o111) !== 0) { aux.exec.add(s.write.path); twinDirs.push(/** @type {string} */ (twinOf(aux, s.write))); }
    }
    if (s.write && !s.args && !s.exec) continue; // a file write is a step of its own and answers nothing
    const env = stepEnv(home, { TMPDIR: tmp, ...(s.role ? { AGENT_ROLE: s.role } : {}), ...(s.env ?? {}) });
    if (win && s.env && s.env.PATH !== undefined) env.PATH = [...twinDirs, process.env.PATH ?? ''].join(path.delimiter);   // the recorded PATH is the recording host's POSIX one
    const cwd = path.join(root, s.cwd ?? '');
    // Windows: a shell's $PPID is an MSYS pid, not the Windows pid of the test process that the dispatch marker must name (process.kill(pid, 0) of the core reads a Windows pid)
    if (s.exec && win && s.exec[0] === 'sh' && s.exec[1] === '-c') s = { ...s, exec: ['sh', '-c', s.exec[2].split('$PPID').join(String(process.pid)), ...s.exec.slice(3)] };
    if (s.exec) { const r = spawnSync(s.exec[0], s.exec.slice(1), { cwd, env, input: s.stdin ?? '', encoding: 'latin1', timeout: 120000 }); outputs.push({ code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }); continue; }
    /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
    const io = { env, cwd, stdout: { write: (/** @type {Buffer} */ b) => out.push(Buffer.from(b)) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(Buffer.from(b)) }, scriptPath: path.join(root, '.agents/scripts/agent.sh'), stdinText: s.stdin ?? '', argv0: './.agents/scripts/agent.sh' };
    const code = run(s.args ?? [], io);
    outputs.push({ code, stdout: Buffer.concat(out).toString('latin1'), stderr: Buffer.concat(err).toString('latin1') });
  }
  return outputs;
}

