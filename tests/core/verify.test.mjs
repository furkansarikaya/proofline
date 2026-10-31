// @ts-check
// Package C2 (stage 2): the verify-* family, freshness, validate and the checks give the same stdout, stderr and exit status through the Node
// core and through the shell code (PROOFLINE_ENGINE=sh), on fixture runs built with the self-test helpers. The shell is the specification.
// Each state builds its own tree (tests run in parallel). The slow states (moved base, many files) are in verify-slow.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { scriptsDir } from './helpers.mjs';

const ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};
/** @type {string[]} */ const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** @param {string} snippet */
export function build(snippet) {
  const out = mkdtempSync(path.join(tmpdir(), 'pl-vfeq-'));
  made.push(out);
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${snippet}\ncp -R "$PWD/." "$EQ_OUT/"`, path.join(scriptsDir, 'x.sh')],
    { env: { ...ENV, EQ_LIB: path.join(scriptsDir, 'test-lib.sh'), EQ_OUT: out }, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error(`fixture failed: ${snippet}\n${r.stderr}${r.stdout}`);
  cpSync(path.join(scriptsDir, 'proofline-core.mjs'), path.join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scriptsDir, 'core'), path.join(out, '.agents/scripts/core'), { recursive: true });
  spawnSync('git', ['-C', out, 'config', 'gc.auto', '0']);
  appendFileSync(path.join(out, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n');
  return out;
}

/** @param {string} fx @param {string[]} args @param {'node' | 'sh'} engine @param {Record<string, string>} [env] */
export function exec(fx, args, engine, env = {}) {
  const r = spawnSync('sh', [path.join(fx, '.agents/scripts/agent.sh'), ...args], { cwd: fx, env: { ...ENV, ...(engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), ...env }, encoding: 'latin1', input: '' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

export const SHAPES = [['verify-freeze'], ['verify-scope'], ['verify-knowledge-scope'], ['freshness'], ['verify-handoff'], ['verify-qa-plan'], ['verify-worker-evidence'], ['validate'], ['design-rationales'],
  ['verify-freeze', 'NOPE'], ['verify-scope', 'NOPE'], ['freshness', 'NOPE'], ['validate', 'NOPE'], ['verify-qa-plan', 'NOPE'], ['design-rationales', 'NOPE'], ['design-rationales', '-'], ['design-rationales', '-', '--json'],
  ['ci-check'], ['ci-task-command'], ['commands-check'], ['scale-check'], ['batch-check']];
export const STATE_COMMANDS = [['verify-freeze', 'LC'], ['verify-scope', 'LC'], ['verify-knowledge-scope', 'LC'], ['freshness', 'LC'], ['verify-handoff', 'LC'], ['verify-qa-plan', 'LC'],
  ['verify-worker-evidence', 'LC'], ['validate', 'LC'], ['design-rationales', 'LC'], ['design-rationales', 'LC', '--json']];
let shapesDone = false;

/** @param {string} fx @param {string} label @param {string[][]} [extra] */
export function allSame(fx, label, extra = []) {
  const list = shapesDone ? [...STATE_COMMANDS, ...extra] : [...SHAPES, ...STATE_COMMANDS, ...extra];
  shapesDone = true;
  for (const c of list) {
    const a = exec(fx, c, 'node'); const b = exec(fx, c, 'sh');
    assert.deepEqual(a, b, `${label}: agent.sh ${c.join(' ')}`);
  }
}

const GATES_PARTIAL = `scaffold orchestrated no COMPLEX
worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null`;

const STATES = /** @type {Record<string, string>} */ ({
  planning: 'scaffold orchestrated no COMPLEX',
  implemented: GATES_PARTIAL,
  'all gates pass': `${GATES_PARTIAL}\npass_all`,
  'code done': 'scaffold orchestrated no COMPLEX; to_code_done orchestrated',
  'pass then edited (stale)': `${GATES_PARTIAL}\npass_all; printf 'more\\n' >> impl.txt`,
  'standalone standard': 'scaffold standalone no STANDARD; solo RED fail impl_test.txt "test: lookup"; solo GREEN pass impl.txt "impl: lookup"; A handoff LC IMPLEMENTED >/dev/null',
  trivial: 'scaffold standalone no TRIVIAL',
  'untracked, control plane and installed files': `scaffold orchestrated no COMPLEX; mkdir -p src docs .agents/extra; printf 'x\\n' > src/new.txt; printf 'd\\n' > docs/a.md; printf 'c\\n' > .agents/extra/f; printf '# P\\n\\n<!-- proofline:begin -->\\nb\\n<!-- proofline:end -->\\n' > AGENTS.md`,
});

describe('verify family equals the shell', () => {
  for (const [name, snippet] of Object.entries(STATES)) {
    test(name, () => { const fx = build(snippet); allSame(fx, name); });
  }

  test('a stray run artifact, a symlink in the run folder and an edited plan', () => {
    const fx = build(GATES_PARTIAL);
    writeFileSync(path.join(fx, '.agents/runs/LC/stray.txt'), 'x\n');
    allSame(fx, 'stray file');
    rmSync(path.join(fx, '.agents/runs/LC/stray.txt'));
    mkdirSync(path.join(fx, '.agents/runs/LC/scratch'), { recursive: true });
    spawnSync('ln', ['-s', '/etc/hosts', path.join(fx, '.agents/runs/LC/scratch/l')]);
    allSame(fx, 'symlink');
    rmSync(path.join(fx, '.agents/runs/LC/scratch'), { recursive: true });
    appendFileSync(path.join(fx, '.agents/runs/LC/PLAN.md'), 'edit\n');
    allSame(fx, 'edited plan');
  });
});
