// @ts-check
// Fixtures for the equivalence rig: an installed control plane (no test stubs), a test-lib scaffold (frozen run), snapshots of a tree.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../..');
export const agentsSrc = join(repoRoot, 'control-plane/agents');
export const scriptsSrc = join(agentsSrc, 'scripts');
export const corePath = join(scriptsSrc, 'proofline-core.mjs');
/** True while the Node engine is not in this checkout: tests that need it skip with a message. */
export const coreAbsent = () => !existsSync(corePath);
export const SKIP_NO_CORE = 'skipped only while control-plane/agents/scripts/proofline-core.mjs is absent (it needs the Node engine)';

/** Deterministic environment of a fixture process: no global git config, no PROOFLINE_* from the caller, a fixed locale. */
export function baseEnv(/** @type {string} */ home, /** @type {Record<string,string>} */ extra = {}) {
  /** @type {Record<string,string>} */
  const e = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
    // `git commit` starts a detached `git maintenance run --auto` that can repack and delete loose objects while a test copies the tree (ENOENT on .git/objects)
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
  };
  return { ...e, ...extra };
}

export function run(/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {import('node:child_process').SpawnSyncOptions} */ opt = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opt });
  return { code: r.status, signal: r.signal, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/** Install the control plane as `proofline init` lays it out, without any test stub (the real secret-scan.sh and exec-policy.sh stay). */
export function installMinimal(/** @type {string} */ dir) {
  const a = join(dir, '.agents'); mkdirSync(join(a, 'scripts'), { recursive: true }); mkdirSync(join(a, 'local'), { recursive: true });
  for (const f of ['config.yaml', 'ecosystems.json', 'ecosystems.mjs', 'ecosystems.tsv', 'owns.conf', 'roles.conf', 'tools.conf']) if (existsSync(join(agentsSrc, f))) copyFileSync(join(agentsSrc, f), join(a, f));
  for (const d of ['modes', 'templates', 'task-integrations', 'githooks']) cpSync(join(agentsSrc, d), join(a, d), { recursive: true });
  for (const f of readdirSync(scriptsSrc)) {
    if (f.endsWith('-test.sh') || f === 'test-lib.sh') continue;
    cpSync(join(scriptsSrc, f), join(a, 'scripts', f), { recursive: true });
  }
  for (const f of readdirSync(join(a, 'scripts'))) if (f.endsWith('.sh')) chmodSync(join(a, 'scripts', f), 0o755);
  writeFileSync(join(dir, '.gitignore'), '.agents/runs/\n.agents/local/\n');
  const g = (/** @type {string[]} */ ...x) => run('git', x, { cwd: dir, env: baseEnv(dir) });
  g('init', '-q', '-b', 'main'); g('config', 'gc.auto', '0'); g('config', 'maintenance.auto', 'false'); g('add', '-A'); g('commit', '-qm', 'baseline');
}

/** @typedef {{ dir: string, builtAt: number }} Fixture */
/** @type {Fixture|null} */ let installed = null;
/** An installed fixture, built once per process; builtAt is the epoch second from which the case window starts. */
export function installedFixture() {
  if (installed) return installed;
  const dir = mkdtempSync(join(tmpdir(), 'eq-installed.'));
  const builtAt = Math.floor(Date.now() / 1000);
  installMinimal(dir);
  return (installed = { dir, builtAt });
}

/** @type {Map<string, Fixture>} */ const scaffolds = new Map();
/** A frozen lifecycle run built by test-lib.sh `scaffold` (fixture stubs included, as in the self-tests), copied out of its temp base. */
export function scaffoldFixture(topology = 'orchestrated', cls = 'COMPLEX', extra = '') {
  const key = `${topology}/${cls}/${extra}`; const hit = scaffolds.get(key); if (hit) return hit;
  const out = mkdtempSync(join(tmpdir(), 'eq-scaffold.')); const builtAt = Math.floor(Date.now() / 1000);
  const r = run('sh', ['-c', `. "$EQ_LIB"; ${extra}scaffold ${topology} no ${cls} autonomous && cp -R "$PWD/." "$EQ_OUT/"`, join(scriptsSrc, 'x.sh')], { env: { ...baseEnv(out), EQ_OUT: out, EQ_LIB: join(scriptsSrc, 'test-lib.sh') } });
  if (r.code !== 0) throw new Error(`scaffold failed (${r.code}): ${r.stderr}${r.stdout}`);
  // test-lib fixtures hold only agent.sh: without the core beside it agent.sh runs the shell, so the Node engine would not be under test
  addCore(out);
  run('git', ['config', 'gc.auto', '0'], { cwd: out, env: baseEnv(out) }); run('git', ['config', 'maintenance.auto', 'false'], { cwd: out, env: baseEnv(out) });
  const f = { dir: out, builtAt }; scaffolds.set(key, f); return f;
}

/** Put proofline-core.mjs and core/ next to the fixture's agent.sh (what the installer ships). A no-op while the core is absent. */
export function addCore(/** @type {string} */ dir) {
  if (coreAbsent()) return;
  cpSync(corePath, join(dir, '.agents/scripts/proofline-core.mjs'));
  cpSync(join(scriptsSrc, 'core'), join(dir, '.agents/scripts/core'), { recursive: true });
}

export function copyTree(/** @type {string} */ src, /** @type {string} */ dst) {
  rmSync(dst, { recursive: true, force: true }); mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

/** Every file under root except .git/, in byte order: path -> mode and bytes (a symlink holds its target). @returns {Map<string, import('./normalise.mjs').FileEntry>} */
export function snapshot(/** @type {string} */ root) {
  /** @type {Map<string, import('./normalise.mjs').FileEntry>} */ const m = new Map();
  const walk = (/** @type {string} */ rel) => {
    for (const n of readdirSync(join(root, rel)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const r = rel ? `${rel}/${n}` : n; if (r === '.git') continue;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) { walk(r); if (readdirSync(join(root, r)).length === 0) m.set(`${r}/`, { mode: st.mode & 0o7777, data: Buffer.alloc(0) }); }
      else if (st.isSymbolicLink()) m.set(r, { mode: 0o120000, data: Buffer.from(readlinkSync(join(root, r))) });
      else m.set(r, { mode: st.mode & 0o7777, data: readFileSync(join(root, r)) });
    }
  };
  walk(''); return m;
}

/** Tree id of HEAD, ref names and porcelain status (commit ids hold times and are not compared). */
export function gitState(/** @type {string} */ root) {
  if (!existsSync(join(root, '.git'))) return '';
  const g = (/** @type {string[]} */ ...a) => run('git', a, { cwd: root, env: baseEnv(root) }).stdout;
  return `tree=${g('rev-parse', 'HEAD^{tree}').trim()}\nrefs=${g('for-each-ref', '--format=%(refname)').split('\n').join(',')}\nstatus=${g('status', '--porcelain')}`;
}

/** A PATH in which `node` (and the names that start it) cannot be found: every PATH directory that holds node is replaced by a directory of symlinks to the rest. */
export function pathWithoutNode() {
  const shadow = mkdtempSync(join(tmpdir(), 'eq-nonode.')); const dirs = [];
  for (const [i, d] of (process.env.PATH ?? '').split(':').filter(Boolean).entries()) {
    if (!existsSync(join(d, 'node')) && !existsSync(join(d, 'nodejs'))) { dirs.push(d); continue; }
    const s = join(shadow, String(i)); mkdirSync(s);
    for (const n of readdirSync(d)) if (!['node', 'nodejs', 'npx', 'npm', 'corepack'].includes(n)) { try { symlinkSync(join(d, n), join(s, n)); } catch { /* a dangling name */ } }
    dirs.push(s);
  }
  return { path: dirs.join(':'), cleanup: () => rmSync(shadow, { recursive: true, force: true }) };
}
