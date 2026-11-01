// @ts-check
// Shared helpers of the Node hook tests: a throwaway installed-project fixture (the scaffold of the legacy self-tests, the core beside agent.sh),
// the two hooks run on the same recorded input, and a normalised view of what they left on disk.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repo = resolve(import.meta.dirname, '../..');
export const nodeHook = join(repo, 'adapters/claude/hooks/proofline-hook.mjs');
export const shellHook = join(repo, 'adapters/claude/hooks/proofline-hook.sh');
const scripts = join(repo, 'control-plane/agents/scripts');
export const haveJq = spawnSync('jq', ['--version']).status === 0;

/** The environment of every child: no inherited hook or engine settings, git without the user's configuration. */
export function cleanEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const e = {
    PATH: process.env.PATH, HOME: tmpdir(), LC_ALL: 'C', TMPDIR: process.env.TMPDIR ?? tmpdir(), PROOFLINE_NO_TTY: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...extra,
  };
  return e;
}

/**
 * A fixture template: the scaffold of the self-tests (orchestrated run LC, COMPLEX, committed), with the core next to agent.sh. The caller removes it.
 * @param {{ run?: boolean }} [opt] run: false removes ACTIVE_RUN (no active run)
 */
export function buildTemplate(opt = {}) {
  const out = mkdtempSync(join(tmpdir(), 'hook-fx-'));
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; scaffold orchestrated no COMPLEX; cp -R "$PWD/." "$EQ_OUT/"`, join(scripts, 'x.sh')],
    { env: cleanEnv({ EQ_LIB: join(scripts, 'test-lib.sh'), EQ_OUT: out }), encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}${r.stdout}`);
  cpSync(join(scripts, 'proofline-core.mjs'), join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(join(scripts, 'core'), join(out, '.agents/scripts/core'), { recursive: true });
  appendFileSync(join(out, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n.agents/local/\n');
  if (opt.run === false) rmSync(join(out, '.agents/local/ACTIVE_RUN'), { force: true });
  return out;
}

let counter = 0;
/** A copy of the template. @param {string} template @param {string} base */
export function copyProject(template, base) {
  const dir = join(base, `p${++counter}`);
  cpSync(template, dir, { recursive: true });
  return dir;
}

/**
 * Run a hook on an event. @param {'node' | 'sh'} kind @param {string} dir @param {string} ev @param {object | string} payload
 * @param {{ env?: Record<string, string>, runtime?: string }} [opt] @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function runHook(kind, dir, ev, payload, opt = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify({ cwd: dir, session_id: 's1', ...payload });
  const args = kind === 'node' ? [nodeHook, ev, opt.runtime ?? 'claude'] : [shellHook, ev, opt.runtime ?? 'claude'];
  return new Promise((resolveRun) => {
    const child = spawn(kind === 'node' ? process.execPath : 'sh', args, { cwd: dir, env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, ...opt.env }) });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

/** Everything under .agents/local and .agents/runs as {relative path: text}, times and process ids normalised. @param {string} dir */
export function snapshot(dir) {
  /** @type {Record<string, string>} */ const out = {};
  /** @param {string} d */
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const rel = p.slice(dir.length + 1);
      if (/\.agents\/local\/(hook-times|hooks-inflight|hooklock\/)/.test(rel) || rel.endsWith('/.git') || /\/worktrees\//.test(rel)) continue;
      const name = rel.replace(/\/prompts\/intake\/[0-9]+-[0-9]+\.json$/, '/prompts/intake/<ms>-<pid>.json').replace(/\/prompts\/history\/[0-9]+-/, '/prompts/history/<s>-');
      out[name] = norm(readFileSync(p, 'utf8'), dir);
    }
  };
  for (const sub of ['.agents/local', '.agents/runs']) if (existsSync(join(dir, sub))) walk(join(dir, sub));
  return out;
}

/** Times (epoch seconds and milliseconds), paths of the fixture and dates become placeholders. @param {string} text @param {string} dir */
export function norm(text, dir) {
  return text.split(dir).join('<P>').replace(/"time":[0-9]{10}/g, '"time":<T>').replace(/:[0-9]{10}:/g, ':<T>:').replace(/\b1[0-9]{9,12}\b/g, '<T>')
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/g, '<D>').replace(/\b(total_|max_)?ms=[0-9]*/g, 'ms=<N>').replace(/prev=[0-9a-f]{64}/g, 'prev=<H>').replace(/@[0-9a-f]{64}/g, '@<H>');
}

/** Run both hooks on copies of the template and return the two results and the two snapshots. @param {string} template @param {string} base @param {string} ev
 * @param {(dir: string) => object | string} payload @param {{ setup?: (dir: string) => void, env?: Record<string, string>, runtime?: string }} [opt] */
export async function pair(template, base, ev, payload, opt = {}) {
  const a = copyProject(template, base);
  const b = copyProject(template, base);
  if (opt.setup) { opt.setup(a); opt.setup(b); }
  const [ra, rb] = await Promise.all([runHook('sh', a, ev, payload(a), opt), runHook('node', b, ev, payload(b), opt)]);
  return { sh: { ...ra, stdout: norm(ra.stdout, a), files: snapshot(a) }, node: { ...rb, stdout: norm(rb.stdout, b), files: snapshot(b) } };
}

export { mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, existsSync, readFileSync, spawnSync };
