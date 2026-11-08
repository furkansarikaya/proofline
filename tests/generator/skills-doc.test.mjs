// docs/reference/generate-skills.mjs (A234; it was generate-skills.sh): skills.md from the SKILL.md frontmatter of skills/*/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render, row } from '../../docs/reference/generate-skills.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const GEN = join(repo, 'docs/reference/generate-skills.mjs');
const T = mkdtempSync(join(tmpdir(), 'skills-doc-'));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
const run = (...a) => spawnSync(process.execPath, [GEN, ...a], { encoding: 'utf8' });
const skill = (root, name, front) => { mkdirSync(join(root, 'skills', name), { recursive: true }); writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\n${front}\n---\n# body\nname: not me\n`); };

test('the committed docs/reference/skills.md is what the generator renders (--check exits 0)', () => {
  const r = run('--check');
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'skills.md in sync\n');
  assert.equal(render(repo), readFileSync(join(repo, 'docs/reference/skills.md'), 'utf8'));
});

test('a row: name, description (quotes unescaped, pipes escaped) and metadata.version; only the frontmatter is read', () => {
  assert.equal(row('---\nname: a\ndescription: "Say \\"hi\\" | now \\\\ done"\nmetadata:\n  version: "1.2.3"\n---\nname: b\n'), '| `a` | Say "hi" \\| now \\ done | 1.2.3 |');
  assert.equal(row('---\nname: a\ndescription: plain text\n---\nname: b\ndescription: no\n'), '| `a` | plain text |  |');
  assert.equal(row('no frontmatter\nname: x\n'), '| `` |  |  |');
});

test('the order is that of the paths skills/<name>/SKILL.md, so proofline-lead comes before proofline; --check detects a stale file; a run writes the file', () => {
  const root = join(T, 'r1'); mkdirSync(join(root, 'docs/reference'), { recursive: true });
  skill(root, 'proofline', 'name: proofline\ndescription: entry');
  skill(root, 'proofline-lead', 'name: proofline-lead\ndescription: lead');
  skill(root, 'a-skill', 'name: a-skill\ndescription: first');
  mkdirSync(join(root, 'skills', 'no-skill-md'));
  const names = [...render(root).matchAll(/^\| `([^`]*)`/gm)].map((m) => m[1]);
  assert.deepEqual(names, ['a-skill', 'proofline-lead', 'proofline']);
  assert.equal(run('--root', root, '--check').status, 1);
  assert.match(run('--root', root, '--check').stderr, /^docs\/reference\/skills\.md is stale: run node docs\/reference\/generate-skills\.mjs\n$/);
  assert.equal(run('--root', root).status, 0);
  assert.equal(run('--root', root, '--check').status, 0);
  assert.ok(readFileSync(join(root, 'docs/reference/skills.md'), 'utf8').startsWith('<!-- Generated from skills/*/SKILL.md - do not edit. Run docs/reference/generate-skills.mjs. -->\n\n# Skills reference\n\n'));
  assert.equal(run('--bogus').status, 2);
});
