// @ts-check
// B10 (A302): the PreToolUse command of the project and Codex wiring keeps the exit status of the hook. The old Codex string `node HOOK || test ! -f CONFIG || { ...; exit 2; }` turned EVERY
// non-zero exit of node into exit 0 (allow) in a project without `.agents/config.yaml`: a Node abort (Windows 0xC0000409), a signal (SEGV), a crash, and the hook's own deny (exit 2).
// The rule, run here through `sh -c` against a fake `node` first on PATH (a shell script that exits with a chosen status), in a git repository with and without `.agents/config.yaml`:
//   node ran, status 0                 -> exit 0 (allow)
//   node ran, status 2                 -> exit 2 (the hook's own deny), with or without config.yaml, and the hook's own stderr text is left alone
//   node ran, any other non-zero       -> exit 2 (fail closed), with or without config.yaml, with a message that says so
//   node absent / not executable, or the hook file missing -> exit 2 when config.yaml exists, exit 0 when it does not (an unrelated project is not locked out)
// The plugin form (`hooks.json` of the Claude plugin) was already strict (any non-zero is exit 2, node absent too) and is pinned unchanged.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { tempDir } from '../lib/tempdir.mjs';
import { baseEnv, pathWithoutNode, repoRoot, run } from '../core/lib/fixture.mjs';

const base = tempDir('pretool-exit.');
const noNode = pathWithoutNode();
after(() => { noNode.cleanup(); });

/** @param {string} rel */
const pretoolOf = (rel) => {
  const j = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
  return /** @type {string} */ (j.hooks.PreToolUse[0].hooks[0].command);
};
const CODEX = pretoolOf('adapters/codex/hooks.json');
const PROJECT = pretoolOf('adapters/claude/settings.fragment.json');
const PLUGIN = pretoolOf('adapters/claude/hooks/hooks.json');

// The exact strings (a change is a decision: the same strings are pinned in tests/ci/hook-templates.txt).
const START = 'if command -v node >/dev/null 2>&1 && test -f "ROOT/.agents/hooks/proofline-hook.mjs"; then node "ROOT/.agents/hooks/proofline-hook.mjs" pretool RT; rc=$?; test $rc -eq 0 && exit 0; test $rc -eq 2 || echo "proofline: the hook ended with status $rc; failing closed" >&2; exit 2; fi; test ! -f "ROOT/.agents/config.yaml" || { echo "proofline: the hook did not start (node 22.13 or newer must be on PATH, and .agents/hooks/proofline-hook.mjs must exist); failing closed" >&2; exit 2; }';
const CODEX_EXACT = `R=$(git rev-parse --show-toplevel 2>/dev/null); ${START.replaceAll('ROOT', '$R').replace('RT', 'codex')}`;
const PROJECT_EXACT = START.replaceAll('ROOT', '$CLAUDE_PROJECT_DIR').replace('RT', 'claude');
const PLUGIN_EXACT = 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/proofline-hook.mjs" pretool claude || { echo "proofline: the hook did not start (node 22.13 or newer must be on PATH); failing closed" >&2; exit 2; }';
// The Codex string before A302: the failing case, kept to show what the matrix below catches.
const CODEX_OLD = 'node "$(git rev-parse --show-toplevel)/.agents/hooks/proofline-hook.mjs" pretool codex || test ! -f "$(git rev-parse --show-toplevel)/.agents/config.yaml" || { echo "proofline: the hook did not start (node 22.13 or newer must be on PATH); failing closed" >&2; exit 2; }';

test('the exact PreToolUse command strings of the three wiring files', () => {
  assert.equal(CODEX, CODEX_EXACT);
  assert.equal(PROJECT, PROJECT_EXACT);
  assert.equal(PLUGIN, PLUGIN_EXACT);
});

/** A git repository with the hook file in place and `.agents/config.yaml` or not (and the hook file or not). @param {{ config: boolean, hook?: boolean }} o */
function repo(o) {
  const dir = tempDir('pretool-repo.');
  const g = run('git', ['init', '-q', dir], { env: baseEnv(base) });
  assert.equal(g.code, 0, g.stderr);
  mkdirSync(join(dir, '.agents/hooks'), { recursive: true });
  if (o.hook !== false) writeFileSync(join(dir, '.agents/hooks/proofline-hook.mjs'), '// the fake node never reads it\n');
  if (o.config) writeFileSync(join(dir, '.agents/config.yaml'), 'proofline_version: 0\n');
  return dir;
}
const WITH = repo({ config: true });
const WITHOUT = repo({ config: false });
const NOHOOK_WITH = repo({ config: true, hook: false });
const NOHOOK_WITHOUT = repo({ config: false, hook: false });

/** A directory holding a fake `node` that exits with STATUS (or is not executable, or kills itself with a signal). @param {number | 'noexec' | 'segv'} how */
function fakeNode(how) {
  const bin = tempDir('fakenode.');
  const f = join(bin, 'node');
  const body = how === 'segv' ? 'kill -SEGV $$' : `exit ${how === 'noexec' ? 0 : how}`;
  writeFileSync(f, `#!/bin/sh\ncat > "$0.stdin"\necho HOOKOUT\necho HOOKERR >&2\n${body}\n`);
  chmodSync(f, how === 'noexec' ? 0o644 : 0o755);
  return bin;
}
/** @param {string} command @param {string} dir @param {string | null} bin the fake node folder, or null for no node at all */
function sh(command, dir, bin) {
  const PATH = bin === null ? noNode.path : [bin, noNode.path].join(delimiter);
  return run('sh', ['-c', command], { cwd: dir, env: baseEnv(base, { PATH, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: repoRoot }), input: '{"x":1}' });
}

/** @type {(number | 'segv')[]} */
const STATUSES = [0, 1, 2, 126, 127, 134, 139, 255, 'segv'];
for (const [form, command] of /** @type {const} */ ([['codex', CODEX], ['project', PROJECT], ['plugin', PLUGIN]])) {
  test(`${form}: node ran -> its status decides: 0 allows, 2 is the hook's deny, anything else fails closed, with and without config.yaml`, () => {
    for (const st of STATUSES) {
      const bin = fakeNode(st);
      for (const [dir, label] of [[WITH, 'config'], [WITHOUT, 'no config']]) {
        const r = sh(command, dir, bin);
        const where = `${form} node exit ${st}, ${label}: ${r.stdout}${r.stderr}`;
        assert.equal(r.code, st === 0 ? 0 : 2, where);
        assert.match(r.stdout, /HOOKOUT/, `${where}: the hook's stdout reaches the runtime`);
        assert.match(r.stderr, /HOOKERR/, `${where}: and its stderr`);
        if (st !== 0 && st !== 2) assert.match(r.stderr, /failing closed/, where);
        if (st === 2 && form !== 'plugin') assert.doesNotMatch(r.stderr, /failing closed/, `${where}: the hook's own deny is passed through unchanged`);
        assert.equal(readFileSync(join(bin, 'node.stdin'), 'utf8'), '{"x":1}', 'the event reaches the hook on stdin');
      }
    }
  });
}

test('the key regression: no config.yaml and the hook itself denies (exit 2) -> exit 2; the old Codex string swallowed it', () => {
  const bin = fakeNode(2);
  assert.equal(sh(CODEX, WITHOUT, bin).code, 2);
  assert.equal(sh(PROJECT, WITHOUT, bin).code, 2);
  // the failing case, for the record: the old string allowed it (and every abort and signal) -- this assertion documents the hole and is the mutation proof for the new strings above
  for (const st of [1, 2, 134, 139, 255]) assert.equal(sh(CODEX_OLD, WITHOUT, fakeNode(st)).code, 0, `old string, no config, node exit ${st}: allowed (the hole)`);
});

for (const [form, command] of /** @type {const} */ ([['codex', CODEX], ['project', PROJECT]])) {
  test(`${form}: node absent or not executable, or the hook file missing -> exit 2 with config.yaml, exit 0 without (an unrelated project is not locked out)`, () => {
    const cases = /** @type {[string, string | null][]} */ ([['absent', null], ['not executable', fakeNode('noexec')]]);
    for (const [label, bin] of cases) {
      const closed = sh(command, WITH, bin);
      assert.equal(closed.code, 2, `${label}, config: ${closed.stderr}`);
      assert.match(closed.stderr, /failing closed/);
      const open = sh(command, WITHOUT, bin);
      assert.equal(open.code, 0, `${label}, no config: ${open.stderr}`);
    }
    const ok = fakeNode(0);
    const missing = sh(command, NOHOOK_WITH, ok);
    assert.equal(missing.code, 2, `hook file missing, config: ${missing.stderr}`);
    assert.match(missing.stderr, /failing closed/);
    assert.equal(sh(command, NOHOOK_WITHOUT, ok).code, 0, 'hook file missing, no config');
  });
}

test('plugin form: node absent or not executable is exit 2 whatever config.yaml says', () => {
  for (const bin of [null, fakeNode('noexec')]) for (const dir of [WITH, WITHOUT]) assert.equal(sh(PLUGIN, dir, bin).code, 2);
});
