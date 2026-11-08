// @ts-check
// Tests tests/ci/bump-version.mjs (A168): a bump rewrites only version sites, never history comments; --check; bad input.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const T = mkdtempSync(path.join(tmpdir(), 'bump-test-'));
after(() => rmSync(T, { recursive: true, force: true }));
const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: T, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const bump = (/** @type {string[]} */ args, env = {}) => spawnSync(process.execPath, ['tests/ci/bump-version.mjs', ...args], { cwd: T, encoding: 'utf8', env: { ...process.env, ...env } });
/** @type {string} */ let cur;

before(() => {
  // a temp copy of the tracked files (and the new ones), committed so git diff names what the script touched
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'latin1', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  execFileSync('tar', ['-cf', path.join(T, '.copy.tar'), '-T', '-'], { cwd: repo, input: files.join('\n') });
  execFileSync('tar', ['-xf', '.copy.tar'], { cwd: T }); rmSync(path.join(T, '.copy.tar'));
  // the repository has no Unreleased entry right after a release: give the copy one
  const cl = readFileSync(path.join(T, 'CHANGELOG.md'), 'utf8').split('\n');
  const rest = cl.findIndex((l, i) => i > 1 && l.startsWith('## ') && l !== '## Unreleased');
  writeFileSync(path.join(T, 'CHANGELOG.md'), `# Changelog\n\n## Unreleased\n\n- test entry\n\n${cl.slice(rest).join('\n')}`);
  git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
  cur = /^ {2}"version": "([0-9.]+)",$/m.exec(readFileSync(path.join(T, '.claude-plugin/plugin.json'), 'utf8'))?.[1] ?? '';
});

describe('bump-version', () => {
  test('--check passes on the repository as it is, and prints the version', () => {
    const r = bump(['--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `bump-version: every version site is ${cur}\n`);
  });
  test('bad input exits non-zero and changes nothing: no version, 1.2, v1.2.3, the current version, two arguments', () => {
    for (const bad of [[], ['1.2'], ['v1.2.3'], [cur], ['1.2.3', '4.5.6'], ['1.2.3.4']]) assert.notEqual(bump(bad).status, 0, bad.join(' '));
    assert.equal(git(['status', '--porcelain']), '');
    assert.match(bump(['1.2']).stderr, /invalid version '1\.2'/);
    assert.match(bump([cur]).stderr, /equals the current version/);
  });
  test('a bump rewrites only the listed sites, never a history comment, and moves the CHANGELOG', () => {
    const r = bump(['9.8.7'], { BUMP_DATE: '2030-01-02' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `bump-version: ${cur} -> 9.8.7\n`);
    assert.match(readFileSync(path.join(T, 'skills/visual-proof/scripts/native.mjs'), 'utf8'), /native apps \(0\.0\.24\)/, 'a historical (0.0.24 stays');
    const changed = git(['diff', '--name-only']).split('\n').filter(Boolean).sort();
    assert.ok(!changed.some((f) => /visual-proof\/scripts|visual-proof-native/.test(f)), 'no visual-proof file changed');
    const listed = /^(control-plane\/agents\/scripts\/core\/proflinecli\.mjs|\.claude-plugin\/(plugin|marketplace)\.json|control-plane\/agents\/config\.yaml|playground\/package\.json|skills\/[a-z-]+\/SKILL\.md|skills\/exploit-proof\/scripts\/diff-manifests\.mjs|skills\/proof-review\/(scripts\/check-config\.mjs|references\/REPORTING\.md)|README\.md|adapters\/README\.md|fixtures\/(concurrency-proof\/selfcheck|insights\/setup)\.mjs|tests\/skills\/(concurrency-proof|proof-review|data-design|proofline-lead)\.test\.mjs|CHANGELOG\.md|docs\/reference\/skills\.md)$/;
    assert.deepEqual(changed.filter((f) => !listed.test(f)), [], 'only listed sites, the changelog or a generated file changed');
    // every changed line names the old or the new version (nothing else was rewritten)
    const stray = git(['diff', '-U0']).split('\n').filter((l) => /^[-+][^-+]/.test(l)).filter((l) => ![cur, '9.8.7', cur.replace(/\./g, '\\.'), '9\\.8\\.7', 'test entry', 'Unreleased'].some((k) => l.includes(k)));
    assert.deepEqual(stray, []);
    assert.match(readFileSync(path.join(T, 'CHANGELOG.md'), 'utf8'), /^## 9\.8\.7 — 2030-01-02$/m);
    assert.equal(bump(['--check']).status, 0, 'check passes after the bump');
  });
  test('the sites that spell the version as a regular-expression literal are bumped too', () => {
    assert.match(readFileSync(path.join(T, 'tests/skills/data-design.test.mjs'), 'utf8'), /version: "9\\\.8\\\.7"/);
    assert.match(readFileSync(path.join(T, 'tests/skills/proofline-lead.test.mjs'), 'utf8'), /\{2\}version: "9\\\.8\\\.7"/);
  });
  test('only the front matter of a SKILL.md is rewritten', () => {
    const f = path.join(T, 'skills/qa-plan/SKILL.md');
    const body = readFileSync(f, 'utf8');
    assert.match(body, /^ {2}version: "9\.8\.7"$/m);
    writeFileSync(f, `${body}\n  version: "9.8.7"\n`);   // a body line that looks like the site
    writeFileSync(path.join(T, 'CHANGELOG.md'), readFileSync(path.join(T, 'CHANGELOG.md'), 'utf8').replace('## 9.8.7', '## Unreleased\n\n- again\n\n## 9.8.7'));
    assert.equal(bump(['9.8.8']).status, 0);
    const after = readFileSync(f, 'utf8');
    assert.match(after, /^ {2}version: "9\.8\.8"$/m);
    assert.ok(after.trimEnd().endsWith('version: "9.8.7"'), 'the body line is untouched');
  });
  test('--check fails when a site disagrees, and names it', () => {
    const f = path.join(T, 'control-plane/agents/scripts/core/proflinecli.mjs');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^export const PROOFLINE_VERSION = .*/m, "export const PROOFLINE_VERSION = '0.0.1';"));
    const r = bump(['--check']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /^mismatch: control-plane\/agents\/scripts\/core\/proflinecli\.mjs/m);
    assert.match(r.stderr, /disagree with plugin\.json/);
  });
  test('a bump with no Unreleased entries, or with a site that is gone, refuses and changes nothing', () => {
    git(['checkout', '-q', '--', '.']);
    const f = path.join(T, 'README.md');
    const keep = readFileSync(f, 'utf8');
    writeFileSync(f, keep.replace(/^Version \*\*[0-9.]+\*\*: full scope/m, 'Version x: full scope'));
    const r = bump(['9.9.9']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /site not found in README\.md/);
    writeFileSync(f, keep);
    const ch = path.join(T, 'CHANGELOG.md');
    writeFileSync(ch, readFileSync(ch, 'utf8').replace(/^- test entry$/m, ''));
    assert.match(bump(['9.9.9']).stderr, /no Unreleased entries/);
  });
});
