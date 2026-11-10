// @ts-check
// debt-test.sh (A153, A162; 176-D3) as Node tests: the shortcut comment list, the one wiki page, who may run what, and the converted shortcuts of this
// repository. The command runs on the live Node core (core/debt.mjs, as in an installed project); `debt.sh` stays until 176-E. Every assertion kept.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, accepted, cleanEnv, newRepo, repo, scripts } from '../lib/harness.mjs';

const w = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };

test('debt: list, page, roles (A153)', () => {
  const d = newRepo();
  const D = (/** @type {string[]} */ args = [], /** @type {string | undefined} */ role = undefined) => A(d, ['debt', ...args], role ? { role } : {});
  // no shortcut yet: the zero case, with and without a wiki
  assert.equal(accepted(D(), 'list').out.replace(/\n+$/, ''), 'shortcut debt: none', `zero case printed: ${D().out}`);   // list: no shortcut comments prints none
  mkdirSync(path.join(d, 'src'), { recursive: true }); mkdirSync(path.join(d, 'docs/wiki/concepts'), { recursive: true });
  w(d, 'src/a.sh', '# shortcut: single process, split when load grows\nx=1\n');
  w(d, 'src/b.c', 'int a; // shortcut: linear scan; index it past 1k rows\n/* shortcut: no retry, add one when the API flakes */\n');
  w(d, 'src/q.sql', 'select 1; -- shortcut: full table read, add an index\n');
  w(d, 'src/p.html', '<!-- shortcut: inline style, move to the stylesheet -->\n');
  w(d, 'src/c.py', 'y = 2  # shortcut: no separator here\n');
  w(d, 'NOTES.md', '# shortcut: in markdown, ignored\n');
  w(d, '.agents/x/t.sh', '# shortcut: in the control plane, ignored\n');
  w(d, 'docs/wiki/concepts/other.txt', '# shortcut: in the wiki, ignored\n');
  const out = accepted(D(), 'list').out; const lines = out.split('\n');
  assert.equal(lines[0], 'shortcut debt: 6', `count wrong: ${out}`);
  for (const want of ['src/a.sh:1 | single process | split when load grows', 'src/b.c:1 | linear scan | index it past 1k rows', 'src/b.c:2 | no retry | add one when the API flakes',
    'src/q.sql:1 | full table read | add an index', 'src/p.html:1 | inline style | move to the stylesheet', 'src/c.py:1 | no separator here | (not stated)']) {
    assert.ok(lines.includes(want), `missing line: ${want} in: ${out}`);
  }
  assert.ok(!/NOTES\.md|\.agents|wiki/.test(out), `excluded path listed: ${out}`);   // md, .agents and wiki excluded
  // page: collected into the one wiki page; a removed shortcut drops off it
  const p = path.join(d, 'docs/wiki/concepts/shortcut-debt.md');
  accepted(D(['page']), 'page failed');
  let page = readFileSync(p, 'utf8');
  assert.ok(page.includes('`src/q.sql:1` | full table read | add an index') && page.includes('`src/a.sh:1`'), `page lacks rows: ${page}`);
  w(d, 'src/q.sql', 'select 1;\n'); D(['page']);
  page = readFileSync(p, 'utf8');
  assert.ok(!page.includes('q.sql'), 'a removed shortcut stayed on the page');
  assert.ok(page.includes('`src/a.sh:1`'), 'the other rows vanished');
  // every shortcut removed: the existing page says so instead of keeping stale rows
  for (const f of ['src/a.sh', 'src/b.c', 'src/p.html', 'src/c.py']) rmSync(path.join(d, f), { force: true });
  D(['page']);
  page = readFileSync(p, 'utf8');
  assert.ok(page.includes('No shortcut comments') && !/^\| `/m.test(page), `stale page: ${page}`);
  // no wiki: nothing written
  rmSync(path.join(d, 'docs/wiki'), { recursive: true, force: true }); w(d, 'src/z.sh', '# shortcut: x, y\n');
  assert.ok(D(['page']).out.includes('no wiki'), 'no-wiki message missing');
  assert.ok(!existsSync(path.join(d, 'docs/wiki')), 'page created a wiki');
  // roles: page is lead-only, list works for every role and without a run
  mkdirSync(path.join(d, 'docs/wiki'), { recursive: true });
  for (const r of ['implementer', 'reviewer', 'qa', 'verifier', 'explorer']) {
    accepted(D([], r), `list refused for ${r}`);
    assert.notEqual(D(['page'], r).status, 0, `page allowed for ${r}`);
  }
  assert.ok(!existsSync(p), 'a refused page wrote the page');
  const runs = path.join(d, '.agents/runs');
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], [], 'debt created a run');
  accepted(D(['page']), 'lead page failed'); assert.ok(existsSync(p), 'lead page failed');
});

// A162: the comments that used to carry a foreign label are listed as shortcut entries of this repository, and none is left
test('debt: the four converted shortcuts of this repository are listed with file:line and a condition; no foreign label remains (A162)', { skip: existsSync(path.join(repo, '.git')) ? false : 'not a git checkout' }, () => {
  const r = spawnSync('node', [path.join(scripts, 'proofline-core.mjs'), '--pl-argv0', path.join(scripts, 'agent.sh'), 'debt', 'list'], { cwd: repo, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `debt list failed in the repository: ${r.stderr}`);
  const out = r.stdout.split('\n');
  // asserted by file and shortcut text, not by line number: editing those files must not break this test
  for (const want of ['control-plane/agents/scripts/core/cfgcli.mjs|a new deep key under an existing 2-level key', 'skills/data-design/scripts/classify-migration.mjs|MySQL client "DELIMITER" blocks',
    'skills/data-design/scripts/classify-migration.mjs|strips // and /* */ and leading-# line comments', 'skills/test-trust/scripts/validate-findings.mjs|implements only the JSON Schema keywords']) {
    const [file, text] = want.split('|');
    const hit = out.filter((l) => l.includes(`${file}:`) && l.includes(text));
    assert.ok(hit.some((l) => /^[^ ]+:[0-9]+ \| /.test(l)), `debt does not list the converted shortcut: ${want}`);
    assert.ok(hit.some((l) => !l.endsWith('(not stated)')), `converted shortcut has no stated condition: ${want}`);
  }
  const tag = `pony${'tail'}`;   // spelled in two parts so this file is not a hit itself
  const g = spawnSync('git', ['-C', repo, 'grep', '-n', '-I', '-i', '-E', '-e', `(#|//|--|/\\*|;|\\*)[[:space:]]*${tag}:`, '--', '.', ':(exclude)*.md', ':(exclude)tests', ':(exclude).claude'], { env: cleanEnv(), encoding: 'utf8' });
  assert.notEqual(g.status, 0, `a ${tag} comment remains: ${g.stdout}`);
});
