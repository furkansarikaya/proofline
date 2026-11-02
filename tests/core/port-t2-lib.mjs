// @ts-check
// T2 of the legacy-test port: run states restored from committed snapshots (recorded ONCE from the legacy shell fixtures, see
// tests/fixtures/port-t2/record.mjs) and the commands run in-process on the Node core. The expected outputs are golden files recorded once from the
// shell (tests/fixtures/port-t2/golden.json); nothing compares with the shell at test time.
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** @typedef {{ mode: number, text?: string, b64?: string }} SnapFile */
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
  for (const rel of Object.keys(snap.base)) if (!(rel in snap.files) && existsSync(path.join(root, rel))) rmSync(path.join(root, rel), { force: true });
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

/** Run a command on the Node core, in process. @param {string} root @param {string[]} args @param {{ env?: Record<string, string>, stdin?: string }} [o] */
export function node(root, args, o = {}) {
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const io = { env: { ...GIT_ENV, ...(o.env ?? {}) }, cwd: root, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: path.join(root, '.agents/scripts/agent.sh') };
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
