// @ts-check
// T2 of the legacy-test port: run states restored from committed snapshots (recorded ONCE from the legacy shell fixtures, see
// tests/fixtures/port-t2/record.mjs) and the commands run in-process on the Node core. The expected outputs are golden files recorded once from the
// shell (tests/fixtures/port-t2/golden.json); nothing compares with the shell at test time.
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dataDir = path.join(repo, 'tests', 'fixtures', 'port-t2');
export const agentsSrc = path.join(repo, 'control-plane', 'agents');

export const GIT_ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};

/** @typedef {{ mode: number, text?: string, b64?: string, link?: string }} SnapFile */
/** @typedef {{ base: Record<string, SnapFile>, files: Record<string, SnapFile>, baseSha: string }} Snapshot */

/** @type {string[]} */ const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** @param {string} root @param {string[]} args */
export function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { env: GIT_ENV, encoding: 'latin1' });
  return r.stdout;
}

/** @param {string} p @param {SnapFile} f */
function put(p, f) {
  mkdirSync(path.dirname(p), { recursive: true });
  if (f.link !== undefined) { rmSync(p, { force: true }); symlinkSync(f.link, p); return; }
  writeFileSync(p, f.b64 !== undefined ? Buffer.from(f.b64, 'base64') : Buffer.from(f.text ?? '', 'latin1'));
  chmodSync(p, f.mode);
}

/** The project of a snapshot, rebuilt in a fresh folder: the shipped control plane in .agents, the base commit, then the working tree. @param {string} name */
export function restoreNew(name) {
  const snap = /** @type {Snapshot} */ (JSON.parse(gunzipSync(readFileSync(path.join(dataDir, `${name}.json.gz`))).toString('utf8')));
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `pl-t2-${name}-`)));
  cpSync(agentsSrc, path.join(root, '.agents'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', root], { env: GIT_ENV });
  git(root, ['config', 'gc.auto', '0']);
  writeFileSync(path.join(root, '.gitignore'), '.agents/runs/\n.agents/local/\n');
  for (const [rel, f] of Object.entries(snap.base)) put(path.join(root, rel), f);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'baseline']);
  const sha = git(root, ['rev-parse', 'HEAD']).trim();
  // the working tree: write every file of the snapshot, remove the base files it no longer has
  for (const rel of Object.keys(snap.base)) if (!(rel in snap.files)) rmSync(path.join(root, rel), { force: true });
  for (const [rel, f] of Object.entries(snap.files)) put(path.join(root, rel), f);
  // the run's recorded base commit is the one made here (the snapshot's own hash cannot be recreated)
  for (const r of ['LC']) {
    const y = path.join(root, '.agents/runs', r, 'RUN.yaml');
    if (existsSync(y) && snap.baseSha) writeFileSync(y, readFileSync(y, 'latin1').split(snap.baseSha).join(sha), 'latin1');
  }
  return root;
}

/** @type {Map<string, string>} */ const cache = new Map();
/** A fresh copy of a restored state (the restore is made once per file and copied: the copy is cheap). @param {string} name */
export function restore(name) {
  let master = cache.get(name);
  if (!master) { master = restoreNew(name); cache.set(name, master); made.push(master); }
  const copy = realpathSync(mkdtempSync(path.join(tmpdir(), `pl-t2c-${name}-`)));
  made.push(copy);
  cpSync(master, copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

/** Fixture operations shared by the recorder and the tests, so that both apply the same mutation. @param {string} root */
export function helpers(root) {
  return {
    root,
    /** @param {string} rel @param {string} text */
    write(rel, text) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); },
    /** @param {string} rel @param {string} text */
    append(rel, text) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), (existsSync(path.join(root, rel)) ? readFileSync(path.join(root, rel), 'latin1') : '') + text, 'latin1'); },
    /** @param {string} rel */
    rm(rel) { rmSync(path.join(root, rel), { recursive: true, force: true }); },
    /** @param {string} rel */
    read(rel) { return readFileSync(path.join(root, rel), 'latin1'); },
    /** @param {string[]} args */
    git(args) { return git(root, args); },
    /** @param {string} msg */
    commit(msg) { git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', msg]); return git(root, ['rev-parse', 'HEAD']).trim(); },
    /** @param {string} rel @param {string} from @param {string} to */
    sub(rel, from, to) { const p = path.join(root, rel); writeFileSync(p, readFileSync(p, 'latin1').split(from).join(to), 'latin1'); },
  };
}

/** Run a command on the Node core, in process. @param {string} root @param {string[]} args @param {{ env?: Record<string, string>, stdin?: string, scriptPath?: string }} [o] */
export function node(root, args, o = {}) {  // o.scriptPath: the script the command is started from (default: the project's agent.sh)
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const io = { env: { ...GIT_ENV, ...(o.env ?? {}) }, cwd: root, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: o.scriptPath ?? path.join(root, '.agents/scripts/agent.sh') };
  const code = run(args, io);
  return { out: norm(Buffer.concat(out).toString('latin1'), root), err: norm(Buffer.concat(err).toString('latin1'), root), code };
}

/** @param {string} s @param {string} root */
export function norm(s, root) { return s.split(root).join('<ROOT>'); }

/** The shell, for the recorder only (PROOFLINE_ENGINE=sh). @param {string} root @param {string[]} args @param {{ env?: Record<string, string> }} [o] */
export function shell(root, args, o = {}) {
  const r = spawnSync('sh', [path.join(root, '.agents/scripts/agent.sh'), ...args], { cwd: root, env: { ...GIT_ENV, PROOFLINE_ENGINE: 'sh', ...(o.env ?? {}) }, encoding: 'latin1', input: '' });
  return { out: norm(r.stdout, root), err: norm(r.stderr, root), code: r.status };
}

/** @returns {Record<string, Record<string, { out: string, err: string, code: number | null }>>} */
export function golden() { return JSON.parse(readFileSync(path.join(dataDir, 'golden.json'), 'utf8')); }

// ---- traces: the calls of a legacy scenario recorded once from the shell (tests/fixtures/port-t2/trace/*.json.gz) --------------------------------------

export const traceDir = path.join(dataDir, 'trace');
/** @typedef {{ blobs: Record<string, SnapFile>, states: Record<string, { base: Record<string, string>, files: Record<string, string>, baseSha: string, pack?: string, deleted?: string[], dirs?: string[], remotes?: Record<string, string>, late?: string[], exclude?: string[], branch?: string }>, calls: Array<{ state: string, args: string[], role: string, out: string, err: string, code: number | null }> }} Trace */

/** @param {string} name @returns {Trace} */
export function loadTrace(name) { return JSON.parse(gunzipSync(readFileSync(path.join(traceDir, `${name}.json.gz`))).toString('utf8')); }

/**
 * A replayer for one trace: the base commit is made once, every state is a copy of it with its working tree written over.
 * @param {Trace} tr
 */
export function replayer(tr) {
  /** @type {Map<string, { root: string, sha: string }>} */ const masters = new Map();
  /** The base commit of one recorded base (a scenario may commit and so move its base): made once. @param {string} key a state key */
  const masterFor = (key) => {
    const st = tr.states[key];
    const id0 = (/** @type {typeof st} */ x) => JSON.stringify([Object.entries(x.base).sort(), x.late ?? [], x.exclude ?? []]);
    // what the legacy fixture never had of the shipped control plane is absent from the base commit too when it is absent in every state that shares this base
    const lists = Object.values(tr.states).filter((x) => id0(x) === id0(st)).map((x) => x.deleted ?? []);
    const common = lists.length ? lists[0].filter((d) => lists.every((l) => l.includes(d))) : [];
    const id = JSON.stringify([id0(st), common]);
    let m = masters.get(id);
    if (!m) {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pl-t2t-')));
      made.push(root);
      cpSync(agentsSrc, path.join(root, '.agents'), { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main', root], { env: GIT_ENV });
      git(root, ['config', 'gc.auto', '0']);
      writeFileSync(path.join(root, '.gitignore'), '.agents/runs/\n.agents/local/\n');
      // what the legacy fixture never had of the shipped control plane is absent from the base commit too (deleted in every state of the trace)
      for (const rel of common) rmSync(path.join(root, rel), { recursive: true, force: true });
      // shipped files the fixture added after its commit are not in the base commit; the project's exclude lines are its own
      for (const rel of st.late ?? []) rmSync(path.join(root, rel), { force: true });
      if (st.exclude?.length) { mkdirSync(path.join(root, '.git/info'), { recursive: true }); appendFileSync(path.join(root, '.git/info/exclude'), st.exclude.join('\n') + '\n'); }
      for (const [rel, k] of Object.entries(st.base)) put(path.join(root, rel), tr.blobs[k]);
      git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'baseline']);
      m = { root, sha: git(root, ['rev-parse', 'HEAD']).trim() };
      masters.set(id, m);
    }
    return m;
  };
  return {
    /** @param {string} key a recorded state: the sha its base commit has in the restored project */
    shaOf(key) { return masterFor(key).sha; },
    /** @param {string} key the project of a recorded state, in a fresh folder */
    state(key) {
      const st = tr.states[key];
      const { root: master, sha } = masterFor(key);
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pl-t2s-')));
      made.push(root);
      cpSync(master, root, { recursive: true, verbatimSymlinks: true });
      // a tracked .agents file that the working tree does not keep is the shipped one there (it differs from the base commit); any other is removed
      for (const rel of Object.keys(st.base)) if (!(rel in st.files)) {
        const shipped = rel.startsWith('.agents/') ? path.join(agentsSrc, rel.slice(8)) : '';
        if (shipped && existsSync(shipped)) cpSync(shipped, path.join(root, rel)); else rmSync(path.join(root, rel), { force: true });
      }
      for (const rel of /** @type {string[]} */ (st.deleted ?? [])) rmSync(path.join(root, rel), { recursive: true, force: true });
      for (const [rel, k] of Object.entries(st.files)) put(path.join(root, rel), tr.blobs[k]);
      for (const rel of st.late ?? []) if (!existsSync(path.join(root, rel))) cpSync(path.join(agentsSrc, rel.slice(8)), path.join(root, rel));
      if (st.branch) git(root, ['checkout', '-q', '-b', st.branch]);
      for (const [rn, url] of Object.entries(/** @type {Record<string, string>} */ (st.remotes ?? {}))) spawnSync('git', ['-C', root, 'remote', 'add', rn, url], { env: GIT_ENV });
      for (const rel of /** @type {string[]} */ (st.dirs ?? [])) mkdirSync(path.join(root, rel), { recursive: true });
      if (st.baseSha && existsSync(path.join(root, '.agents/runs'))) {
        for (const r of readdirSync(path.join(root, '.agents/runs'))) {
          const y = path.join(root, '.agents/runs', r, 'RUN.yaml');
          if (existsSync(y)) writeFileSync(y, readFileSync(y, 'latin1').split(st.baseSha).join(sha), 'latin1');
        }
      }
      // a build record is filed under the commit it was made for
      const bdir = path.join(root, '.agents/local/builds');
      if (st.baseSha && existsSync(bdir)) for (const n of readdirSync(bdir)) if (n.startsWith(st.baseSha)) renameSync(path.join(bdir, n), path.join(bdir, sha + n.slice(st.baseSha.length)));
      if (st.pack) spawnSync('git', ['-C', root, 'index-pack', '--stdin', '-v'], { env: GIT_ENV, input: Buffer.from(/** @type {string} */ (tr.blobs[st.pack].b64), 'base64') });
      return root;
    },
  };
}

/** A build-only state (tests/fixtures/port-t2/trace/state__NAME.json.gz, recorded by record-state.mjs) restored in a fresh folder. @param {string} name */
export function stateOf(name) {
  const tr = loadTrace(`state__${name}`);
  const rp = replayer(tr);
  const key = Object.keys(tr.states)[0];
  return rp.state(key);
}

/** The traces of the T3 port (texts and navigation: next-user, batch, debt, window, digest, ci-fix limit, timeouts warn line, deliver ci-check): replayed by port-t3-replay.test.mjs. */
export const T3_TRACES = [
  'next-user-test__sc_every_state_finished', 'next-user-test__sc_every_state_codedone', 'next-user-test__sc_every_state_failed', 'next-user-test__sc_every_state_none',
  'next-user-test__sc_every_state_active', 'next-user-test__sc_every_state_question', 'next-user-test__sc_ci_rows', 'next-user-test__sc_batch_parked',
  'next-user-test__sc_expected_steps', 'next-user-test__sc_delivery_finished', 'next-user-test__sc_unknown_command', 'next-user-test__sc_batch_every_state',
  'batch-test__sc_park_skip_continue', 'batch-test__sc_worktree_cmds', 'lifecycle-test__scenario_window_open_no_plan', 'lifecycle-test__scenario_digest_resume',
  'cifix-test__sc_ci_fix_limit', 'timeouts-test__warn_line', 'deliver-test__scenario_ci_check', 'debt-test__whole',
];
