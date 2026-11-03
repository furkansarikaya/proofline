// @ts-check
// Stage 6B (A216): the built-in adapters wired into the control plane. publish-completion-report and verify-completion-report run the markdown adapter in
// process, the status block is placed in the task file, a user-written task-integrations/<name>.sh still runs as a child (and wins over a built-in of the
// same name), an unknown adapter is refused, and `cli task-adapter` / `cli slug` serve the skills and the shell code that is left.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, project, refused, scripts } from './legacy-lib.mjs';
import { run, toolRoot } from './run6-lib.mjs';

const read = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(`${d}/${f}`, 'utf8');
void scripts;
const cli = (/** @type {string} */ d, /** @type {string[]} */ args) => run(d, 'node', [`${d}/.agents/scripts/proofline-core.mjs`, 'cli', ...args]);
const RECIPE = 'scaffold standalone yes; to_code_done standalone; rm -f .agents/task-integrations/markdown.sh; finish_done';

test('the built-in markdown adapter publishes and verifies the completion report through agent.sh; the contract hash is unaffected', () => {
  const d = project(RECIPE);
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /^ {2}published: "?true"?$/m);
  assert.ok(read(d, 'tasks/in-progress/LC.md').includes('<!-- COMPLETION-REPORT:BEGIN:LC -->'), 'no report block in the task source');
  accepted(A(d, ['verify-completion-report', 'LC']), 'verify-completion-report');
  accepted(A(d, ['freshness', 'LC']), 'freshness after the real adapter published');
  // tampering with the published block is found
  writeFileSync(`${d}/tasks/in-progress/LC.md`, read(d, 'tasks/in-progress/LC.md').replace('<!-- COMPLETION-REPORT:END:LC -->', 'x\n<!-- COMPLETION-REPORT:END:LC -->'));
  refused(A(d, ['verify-completion-report', 'LC']), 'a tampered report block', 'could not be verified');
});

test('the status block is placed in the task file by the built-in adapter, once, in place', () => {
  const d = project(RECIPE);
  accepted(A(d, ['status-block', 'LC', 'update']), 'status-block');
  accepted(A(d, ['status-block', 'LC', 'update']), 'status-block again');
  const t = read(d, 'tasks/in-progress/LC.md');
  assert.equal((t.match(/PROOFLINE-STATUS:BEGIN:LC/g) ?? []).length, 1);
  assert.match(t, /^- run: LC$/m);
  accepted(A(d, ['freshness', 'LC']), 'a status block must not change the contract hash');
});

test('a user-written task-integrations/<name>.sh runs as a child and wins over a built-in of the same name; an unknown adapter is refused', () => {
  const d = project(RECIPE);
  writeFileSync(`${d}/.agents/task-integrations/custom.sh`, '#!/bin/sh\ncase "$1" in publish) echo "custom#abc" ;; verify) exit 0 ;; esac\n');
  chmodSync(`${d}/.agents/task-integrations/custom.sh`, 0o755);
  const r = accepted(A(d, ['publish-completion-report', 'LC', 'custom']), 'a project adapter script');
  assert.match(r.out, /via custom -> custom#abc/);
  accepted(A(d, ['verify-completion-report', 'LC']), 'verify through the script');
  refused(A(d, ['publish-completion-report', 'LC', 'nonesuch']), 'an unknown adapter', 'unknown task-integration adapter: nonesuch');
  refused(A(d, ['publish-completion-report', 'LC', '../evil']), 'an adapter name with a slash', 'unknown task-integration adapter');
  // a script named like a built-in wins (the stub of the fixtures relies on it)
  writeFileSync(`${d}/.agents/task-integrations/markdown.sh`, '#!/bin/sh\ncase "$1" in status) echo "stub-wins" ;; esac\n');
  assert.equal(cli(d, ['task-adapter', 'markdown', 'status', 'LC', 'done']).out, 'stub-wins\n');
  rmSync(`${d}/.agents/task-integrations/markdown.sh`);
  assert.notEqual(cli(d, ['task-adapter', 'markdown', 'bogus']).status, 0);
  assert.equal(cli(d, ['task-adapter', 'markdown', 'bogus']).status, 2);
  assert.equal(cli(d, ['task-adapter', 'nonesuch', 'status', 'x', 'done']).status, 1);
});

test('cli slug prints the slug of a title (nothing for a title without a letter or digit); cli task-adapter imports a task file', () => {
  const d = project('scaffold standalone yes');
  assert.equal(cli(d, ['slug', 'Çalışma ışığı']).out, 'calisma-isigi\n');
  assert.equal(cli(d, ['slug', '--- !!!']).out, '');
});

test('the github adapter starts gh with the allowlisted environment: GH_HOST comes from the origin host (GitHub Enterprise), the caller\'s GH_HOST, GH_REPO and config directory never reach it (A215/A216)', () => {
  const d = project(RECIPE);
  const bin = `${toolRoot}/ghenv-${process.pid}/bin`;
  mkdirSync(bin, { recursive: true });
  const dump = `${toolRoot}/ghenv-${process.pid}/env.txt`;
  writeFileSync(`${bin}/gh`, `#!/bin/sh\nenv >> "${dump}"\ncase "$1" in --version) echo gh;; auth) exit 0;; issue) echo '{"title":"t","url":"u","body":"","labels":[]}';; esac\nexit 0\n`);
  chmodSync(`${bin}/gh`, 0o755);
  run(d, 'git', ['remote', 'remove', 'origin']);
  run(d, 'git', ['remote', 'add', 'origin', 'https://git.corp.example/acme/app.git']);
  writeFileSync(`${d}/.agents/config.yaml`, read(d, '.agents/config.yaml').replace(/^ {2}platform:.*$/m, '  platform: github').replace(/^ {2}platform_host:.*$/m, '  platform_host: git.corp.example'));
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_HOST: 'evil.example', GH_REPO: 'evil/repo', GH_CONFIG_DIR: '/evil/cfg' };
  run(d, 'node', [`${d}/.agents/scripts/proofline-core.mjs`, 'cli', 'task-adapter', 'github', 'status', 'GH-7', 'todo'], env);
  const seen = existsSync(dump) ? readFileSync(dump, 'utf8') : '';
  assert.ok(seen.length > 0, 'the fake gh was not run');
  assert.match(seen, /^GH_HOST=git\.corp\.example$/m);
  assert.ok(!/evil/.test(seen), seen);
});
