// @ts-check
// Tests of tests/ci/ecosystem-branching.mjs: the repository passes, a planted `case` arm (and a comparison) naming an ecosystem id fails and is named,
// the file it needs missing or empty fails, and eco-ok exempts one line. The shell twin (rule 5, missing ecosystems.tsv) is tested in tests/shared/static-test.sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { branchesIn, check, ecosystemIds } from './ecosystem-branching.mjs';

const repo = resolve(import.meta.dirname, '../..');
const script = join(import.meta.dirname, 'ecosystem-branching.mjs');
/** @type {string[]} */ const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A scratch root with the real ecosystems.json and the given files. @param {Record<string,string>} files */
function scratch(files, withJson = true) {
  const root = mkdtempSync(join(tmpdir(), 'eco-branch-')); dirs.push(root);
  if (withJson) { mkdirSync(join(root, 'control-plane/agents'), { recursive: true }); cpSync(join(repo, 'control-plane/agents/ecosystems.json'), join(root, 'control-plane/agents/ecosystems.json')); }
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const CLEAN = "export function f(x) {\n  switch (x.kind) {\n    case 'lead': return 1;\n    default: return 0;\n  }\n}\n";

test('the repository passes, and the ids come from ecosystems.json', () => {
  assert.deepEqual(check(repo), []);
  assert.ok(ecosystemIds(repo).includes('cargo'));
  const r = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^PASS no ecosystem branching/);
});

test('a planted case arm naming an ecosystem id in a core module fails and names file and line', () => {
  for (const arm of ["case 'cargo':", 'case "npm":', 'case `go`:', "case 'jvm' :"]) {
    const root = scratch({ 'control-plane/agents/scripts/core/x.mjs': `${CLEAN}export function g(e) {\n  switch (e) {\n    ${arm} return 1;\n  }\n}\n` });
    const p = check(root);
    assert.equal(p.length, 1, arm); assert.match(p[0], /^control-plane\/agents\/scripts\/core\/x\.mjs:9:/);
    const r = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /^FAIL ecosystem branching/); assert.match(r.stderr, /x\.mjs:9/);
  }
});

test('the entry, the hook and the CLI .mjs are scanned too, and a comparison with an id fails', () => {
  for (const f of ['control-plane/agents/scripts/proofline-core.mjs', 'adapters/claude/hooks/hook.mjs', 'bin/proofline-cli.mjs', 'control-plane/agents/scripts/core/commands/y.mjs']) {
    assert.equal(check(scratch({ [f]: "export const a = (e) => e === 'dotnet';\n" })).length, 1, f);
    assert.equal(check(scratch({ [f]: "export const a = (e) => 'ruby' !== e;\n" })).length, 1, f);
    assert.equal(check(scratch({ [f]: CLEAN })).length, 0, f);
  }
});

test('words that merely contain an id, other case labels, tests and fixtures are not branching; eco-ok exempts the next line only', () => {
  assert.deepEqual(branchesIn("const m = 'run cargo build';\nconst p = 'npm-debug.log';\ncase 'goal':\nx === 'gopher';\n", ['cargo', 'npm', 'go']), []);
  assert.equal(branchesIn("// eco-ok: an interpreter name\ncase 'python':\ncase 'python':\n", ['python']).length, 1);
  assert.equal(check(scratch({ 'control-plane/agents/scripts/core/a.test.mjs': "case 'cargo':\n", 'bin/fixtures/b.mjs': "case 'cargo':\n" })).length, 0);
});

test('a missing, unparsable or empty ecosystems.json fails (a rule that can not run does not pass)', () => {
  const missing = scratch({ 'control-plane/agents/scripts/core/x.mjs': CLEAN }, false);
  assert.match(check(missing)[0], /ecosystems\.json is missing/);
  const r = spawnSync(process.execPath, [script, '--root', missing], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /ecosystems\.json is missing/);
  assert.match(check(scratch({ 'control-plane/agents/ecosystems.json': '{ not json' }, false))[0], /not valid JSON/);
  assert.match(check(scratch({ 'control-plane/agents/ecosystems.json': '{"ecosystems":[]}' }, false))[0], /lists no ecosystem id/);
  assert.match(check(scratch({ 'control-plane/agents/ecosystems.json': '{}' }, false))[0], /lists no ecosystem id/);
});
