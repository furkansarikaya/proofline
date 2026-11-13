// @ts-check
// Shared helpers of the CLI front-end tests (A232): a sandbox like the one tests/cli/cli-test.sh builds (private HOME and global git config, fake claude and codex on the
// PATH), an installed project made by the real `bin/proofline init`, and `proofline` runs against it. Every test file builds its own sandbox (files run in parallel).
import { tempDir } from '../lib/tempdir.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { Config } from '../../control-plane/agents/scripts/core/config.mjs';
import { repo } from './helpers.mjs';
import { launch } from '../lib/winpath.mjs';
import { fakeExe } from '../lib/winfake.mjs';

export const PL = path.join(repo, 'bin', 'proofline');
/** The version every site holds (.claude-plugin/plugin.json; tests/ci/bump-version.mjs --check keeps the sites equal). */
export const VERSION = /** @type {string} */ (JSON.parse(readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8')).version);
export const INIT_FLAGS = ['--yes', '--runtimes', 'claude,codex', '--lead', 'claude', '--worker', 'codex', '--reviewers', 'claude', '--profile', 'economy', '--task-adapter', 'markdown',
  '--protected-branches', 'release', '--push-approval', 'true', '--forbidden-identity', '*@forbidden-zz.test', '--forbidden-identity', '*@other-zz.test'];

let sandboxes = 0;
/**
 * A sandbox: a folder, the environment of every run, and the fake runtimes.
 * `exeTools` (Windows only, A266): the fake `claude` and `codex` are real `.exe` files in a folder of the checkout instead of shell scripts in the temporary folder. The Windows resolver
 * runs only a real program outside every temporary folder (A252, by design), so a shell-script fake is "not installed" there and a doctor line about the runtime or the toolchain could never
 * hold. The PATH is then joined with the host separator and has one key. Elsewhere, and without the option, nothing changes.
 * @param {{ exeTools?: boolean }} [opts]
 */
export function sandbox(opts = {}) {
  const T = tempDir('pl-front-');
  after(() => { rmSync(T, { recursive: true, force: true }); });
  const exeTools = process.platform === 'win32' && opts.exeTools === true;
  const toolRoot = path.join(repo, 'tests/core/.fake-tools', `front-${process.pid}-${++sandboxes}`);   // inside the checkout, git-ignored (tests/core/.gitignore), never under a temporary folder
  if (exeTools) { mkdirSync(toolRoot, { recursive: true }); after(() => { rmSync(toolRoot, { recursive: true, force: true }); }); }
  const fakebin = exeTools ? path.join(toolRoot, 'fakebin') : `${T}/fakebin`;
  mkdirSync(fakebin, { recursive: true }); mkdirSync(`${T}/home`);
  /** On Windows with `exeTools`: a real NAME.exe in DIR that runs the Node program SOURCE. @param {string} dir @param {string} name @param {string} source */
  const exeNode = (dir, name, source) => {
    mkdirSync(dir, { recursive: true });
    const script = path.join(dir, `${name}.fake.mjs`);
    writeFileSync(script, source);
    return fakeExe(toolRoot, dir, name, script);
  };
  const fake = (/** @type {string} */ name, /** @type {string} */ version) => {
    if (exeTools) { exeNode(fakebin, name, `if (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(`${version}\n`)});\n`); return; }
    writeFileSync(`${fakebin}/${name}`, `#!/bin/sh\ncase "\${1:-}" in --version) echo "${version}" ;; esac\nexit 0\n`); chmodSync(`${fakebin}/${name}`, 0o755);
  };
  fake('claude', '9.9.9 (Claude Code, fake)'); fake('codex', 'codex-cli 9.9.9 (fake)');
  writeFileSync(`${T}/home/.gitconfig-global`, '[user]\n\tname = Global User\n\temail = global@example.test\n');
  /** @type {NodeJS.ProcessEnv} */ const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'AGENT_ROLE', 'CLAUDE_PROJECT_DIR', 'PROOFLINE_PROMPT', 'PROOFLINE_RUNTIMES', 'PROOFLINE_LEAD', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
    'PROOFLINE_PLATFORM', 'PROOFLINE_CLAUDE_BIN', 'PROOFLINE_CODEX_BIN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy']) delete env[k];
  if (exeTools) delete env.Path;   // one PATH key: Windows spells the inherited one `Path`
  Object.assign(env, { PATH: `${fakebin}${path.delimiter}${process.env.PATH}`, HOME: `${T}/home`, GIT_CONFIG_GLOBAL: `${T}/home/.gitconfig-global`, GIT_CONFIG_NOSYSTEM: '1', PROOFLINE_NO_TTY: '1', PROOFLINE_DOCTOR_LOAD: '0', PROOFLINE_DOCTOR_CORES: '64' });
  let n = 0;
  /** A fresh repository with a repository-local identity and one commit. */
  const mkrepo = (/** @type {string} */ name = `r${++n}`) => {
    const d = `${T}/${name}`; mkdirSync(d, { recursive: true });
    const g = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', d, ...a], { env, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.name', 'Dev'); g('config', 'user.email', 'dev@example.test'); g('config', 'commit.gpgsign', 'false');
    writeFileSync(`${d}/README.md`, '# app\n'); g('add', 'README.md'); g('commit', '-q', '-m', 'init');
    return d;
  };
  /** `proofline ARGS` in DIR. */
  const pl = (/** @type {string} */ dir, /** @type {string[]} */ args, /** @type {NodeJS.ProcessEnv} */ extra = {}, /** @type {string} */ bin = PL) => {
    const l = launch(bin, args);   // Windows cannot start a `#!/usr/bin/env node` script by its path (A261)
    const r = spawnSync(l.program, l.args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', text: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
  };
  /** The same, asynchronous, so several runs overlap. */
  const plAsync = (/** @type {string} */ dir, /** @type {string[]} */ args, /** @type {NodeJS.ProcessEnv} */ extra = {}, /** @type {string} */ bin = PL) => new Promise((resolve) => {
    const l = launch(bin, args);
    const c = spawn(l.program, l.args, { cwd: dir, env: { ...env, ...extra } });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => resolve({ status, out, err, text: out + err }));
  });
  /** A folder with a fake `node` that answers `--version` with V and otherwise is the real node; a PATH value that holds it first. On Windows with `exeTools` the fake is a real node.exe-named program. @param {string} v */
  const fakeNodePath = (v) => {
    const f = exeTools ? path.join(toolRoot, `fakenode-${v}`) : `${T}/fakenode-${v}`;
    if (exeTools) exeNode(f, 'node', `import { spawnSync } from 'node:child_process';\nif (process.argv[2] === '--version') process.stdout.write('v${v}\\n');\nelse process.exitCode = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1;\n`);
    else { mkdirSync(f, { recursive: true }); writeFileSync(`${f}/node`, `#!/bin/sh\ncase "\${1:-}" in --version) echo v${v} ;; *) exec "${process.execPath}" "$@" ;; esac\n`); chmodSync(`${f}/node`, 0o755); }
    return `${f}${path.delimiter}${env.PATH}`;
  };
  let base = '';
  /** The initialised project every scenario starts from (built once per file); `copy(name)` is a private copy of it. */
  const copy = (/** @type {string} */ name) => {
    if (base === '') {
      base = mkrepo('base');
      writeFileSync(`${base}/package.json`, '{"scripts":{"build":"tsc","test":"jest","lint":"eslint ."}}\n');
      const r = pl(base, ['init', ...INIT_FLAGS]);
      if (r.status !== 0) throw new Error(`init failed: ${r.text}`);
    }
    const d = `${T}/${name}`; cpSync(base, d, { recursive: true, verbatimSymlinks: true });
    return d;
  };
  return { T, env, mkrepo, pl, plAsync, copy, fakeNodePath };
}

/** The lines of a doctor run that start with WARN, PASS or FAIL. @param {string} out */
export function verdicts(out) { return out.split('\n').filter((l) => /^(PASS|WARN|FAIL) /.test(l)); }

/** The value of a config key of a project (the one config reader of the core). @param {string} dir @param {string} key */
export const cfgv = (dir, key) => {
  const c = Config.load(path.join(dir, '.agents', 'config.yaml'));
  const v = c.get(key, '');
  return v !== '' || !key.startsWith('commands.') ? v : c.cmds(key).join('\n'); // a command list reads as its items, one per line (agent.sh config-get)
};

/** Every file of a folder (not .git) with the sha256 of its bytes, as one string: equal strings mean an untouched tree. @param {string} dir */
export function sig(dir) {
  /** @type {string[]} */ const rows = [];
  /** @param {string} d @param {string} pre */
  const rec = (d, pre) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (pre === '' && e.name === '.git') continue;
      if (e.isDirectory()) rec(path.join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile()) rows.push(`${pre}${e.name} ${createHash('sha256').update(readFileSync(path.join(d, e.name))).digest('hex')}`);
      else rows.push(`${pre}${e.name} (link)`);
    }
  };
  rec(dir, '');
  return rows.join('\n');
}

/** A copy of the checkout that differs from the real one, for `upgrade` (an "upstream" release): the folders the CLI reads, plus the edits FN makes. @param {string} T @param {(home: string) => void} [fn] */
export function upstream(T, fn) {
  const home = mkdtempSync(path.join(T, 'home2-'));
  for (const d of ['bin', 'control-plane', 'adapters', 'skills', 'roles', '.claude-plugin']) cpSync(path.join(repo, d), path.join(home, d), { recursive: true, verbatimSymlinks: true });
  if (fn) fn(home);
  return home;
}
