// @ts-check
// Fixture runs for the equivalence tests of the run commands: built with the fixture verbs (tests/lib/recipe.mjs), the Node core is installed
// beside the fixture's agent.sh. The same states as library.test.mjs (copied so that file stays the library package's own).
import { tempDir } from '../lib/tempdir.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { scriptsDir } from './helpers.mjs';
import { buildRecipe } from '../lib/recipe.mjs';

export const ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};
/** @type {string[]} */ const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** Build a fixture run with the self-test helpers, then put the Node core beside its agent.sh. @param {string} snippet */
export function build(snippet) {
  const out = tempDir('pl-libeq-');
  made.push(out);
  buildRecipe(snippet, out, { errexit: false });   // the Node core is installed beside agent.sh by the harness
  spawnSync('git', ['-C', out, 'config', 'gc.auto', '0']);
  return out;
}

/** @param {string} fx @param {string[]} args @param {'node' | 'sh'} engine @param {Record<string, string>} [env] */
export function exec(fx, args, engine, env = {}) {
  const r = spawnSync('sh', [path.join(fx, '.agents/scripts/agent.sh'), ...args], { cwd: fx, env: { ...ENV, ...env }, encoding: 'latin1', input: '' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

export const GATES_PARTIAL = `scaffold orchestrated no COMPLEX
worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null`;

export const STATES = /** @type {Record<string, string>} */ ({
  planning: 'scaffold orchestrated no COMPLEX',
  implemented: GATES_PARTIAL,
  'gates partly passed': `${GATES_PARTIAL}\nn=0; for g in $(required); do case "$g" in SECRETS|VERIFY) continue ;; esac; n=$((n+1)); [ "$n" -le 2 ] || break; gpass "$g"; done`,
  'a failing gate': `${GATES_PARTIAL}\ngfail REVIEW_SMALL impl.txt 2>/dev/null || gfail REVIEW_RULES impl.txt 2>/dev/null || true`,
  'all gates pass': `${GATES_PARTIAL}\npass_all`,
  'code done': 'scaffold orchestrated no COMPLEX; to_code_done orchestrated',
  'pass then edited (stale)': `${GATES_PARTIAL}\npass_all; printf 'more\\n' >> impl.txt`,
  'standalone standard': 'scaffold standalone no STANDARD; solo RED fail impl_test.txt "test: lookup"; solo GREEN pass impl.txt "impl: lookup"; A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null',
  trivial: 'scaffold standalone no TRIVIAL',
  'risky path in the diff (tier full, signals)': `SC_SCOPE_NAMED=db/migrations/001.sql SC_PLAN_EXTRA='${'\n## Data\ndestructive: no\n'}' scaffold orchestrated no COMPLEX; mkdir -p db/migrations src; printf 'create table t;\\n' > db/migrations/001.sql; printf 'x\\n' > src/page.html`,
  'risk flags in the plan': `SC_PLAN_EXTRA='${'\n## Risk\ncontract_change: yes\nconcurrency: no\n\n## UI\nscreen\n'}' scaffold orchestrated no COMPLEX`,
  'untracked and changed files': `scaffold orchestrated no COMPLEX; mkdir -p src docs; i=0; while [ "$i" -lt 8 ]; do printf 'line %s\\n' "$i" > "src/f$i.txt"; i=$((i+1)); done; printf 'doc\\n' > docs/a.md; printf 'changed\\n' >> impl.txt; printf '# P\\n\\n<!-- proofline:begin -->\\nb\\n<!-- proofline:end -->\\n' > AGENTS.md`,
});

