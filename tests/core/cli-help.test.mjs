// @ts-check
// `proofline help` against the other places that list the commands, the plugin files, and the terminal installer (A233; the former scenarios sc_help_lists, sc_plugin and
// sc_installer of tests/cli/cli-test.sh): the help text, the entry skill, the lead skill table, the README and the next-step table name the same commands.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { PL, VERSION, sandbox } from './frontend-lib.mjs';
import { repo } from './helpers.mjs';
import { USAGE_LINES } from '../../control-plane/agents/scripts/core/cliusage.mjs';

const sb = sandbox();
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const help = sb.pl(sb.mkrepo('help'), ['help']).out;

/** The first cell list of a markdown table row: `a`, `b` -> [a, b]; `a | b` inside a cell splits too. @param {string} row */
function cells(row) {
  const first = row.replace(/^\| /, '').replace(/` \| .*$/, '').replace(/\\\|/g, '|').replace(/^`/, '');
  return first.split('`, `').flatMap((c) => c.split(' | ')).sort();
}
const words = (/** @type {string} */ text) => [...new Set(text.split('\n').flatMap((l) => l.replace(/  .*/, '').split(/, | \| /)).map((x) => x.trim().split(' ')[0]).filter((x) => x !== ''))].sort();

test('help lists exactly the session commands of the entry skill, and the lead skill Commands table lists the same ones', () => {
  const skill = read(`${repo}/skills/proofline/SKILL.md`);
  const skList = cells(/** @type {string} */ (skill.split('\n').find((l) => l.startsWith('| `run <TASK>`')))).sort();
  const hpLines = [];
  let on = false;
  for (const l of help.split('\n')) {
    if (l.startsWith('agent session')) { on = true; continue; }
    if (on && /^ {2}[a-z]/.test(l)) hpLines.push(l);
    else if (/^ {2}(resume|deliver|debt)/.test(l)) hpLines.push(l);
  }
  const hpList = hpLines.map((l) => l.replace(/^ {2}/, '').replace(/ {2}.*/, '')).flatMap((l) => l.split(' | ')).sort();
  assert.ok(skList.length > 5 && hpList.length > 5);
  assert.deepEqual(hpList, skList);
  // the lead skill: first cells of its Commands table, minus the boot row, queue and clean, equal the entry list
  const lead = read(`${repo}/skills/proofline-lead/SKILL.md`);
  const sec = lead.slice(lead.indexOf('\n## Commands') + 1).split('\n## ')[0].split('\n').filter((l) => l.startsWith('| `'));
  const ld = sec.flatMap((l) => cells(l)).map((c) => c.replace('<TASK-ID>', '<TASK>').replace(/ <text>$/, '')).filter((c) => !['/proofline', 'queue', 'clean'].includes(c)).sort();
  const sk = skList.map((c) => c.replace(/ <text>$/, '')).filter((c) => !['queue', 'clean'].includes(c)).sort();
  assert.deepEqual(ld, sk);
});

test('the README command list names exactly the commands of proofline help, and the next-step table names the same ones (A153, A159)', () => {
  const readme = (/** @type {string} */ text) => {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith('## Commands'));
    const block = [];
    let fences = 0;
    for (const l of lines.slice(i + 1)) { if (l.startsWith('```')) { fences++; continue; } if (fences === 1) block.push(l); }
    return words(block.join('\n'));
  };
  const hpCmds = words(help.split('\n').filter((l) => /^ {2}[a-z]/.test(l)).map((l) => l.replace(/^ {2}/, '')).join('\n'));
  const rd = readme(read(`${repo}/README.md`));
  assert.ok(hpCmds.length > 10 && rd.length > 10);
  assert.deepEqual(rd, hpCmds);
  const nu = spawnSync('node', [`${repo}/control-plane/agents/scripts/proofline-core.mjs`, 'cli', 'next-line', '--commands'], { encoding: 'utf8' }).stdout.split('\n').filter((x) => x !== '');
  assert.deepEqual([...new Set(nu)].sort(), hpCmds);
  // negative: a command missing from the README block (or an invented one) makes the same comparison fail
  const text = read(`${repo}/README.md`);
  assert.notDeepEqual(readme(text.split('\n').filter((l) => !l.startsWith('debt  ')).join('\n')), hpCmds);
  assert.ok(!readme(text.split('\n').filter((l) => !l.startsWith('debt  ')).join('\n')).includes('debt'));
  assert.ok(readme(text.split('\n').flatMap((l) => (l.startsWith('debt  ') ? [l, 'frobnicate                            invented command'] : [l])).join('\n')).includes('frobnicate'));
});

test('help shows docs, explain, wiki and init --role; its text is the one module the CLI prints', () => {
  assert.ok(help.includes('wiki ingest|query|lint'));
  assert.ok(help.includes('--role ROLE=RUNTIME (repeatable)'));
  assert.equal(help, `${USAGE_LINES.join('\n')}\n`);
});

test('plugin.json and marketplace.json: name, license, author, repository, hooks, and exactly the generated Claude agents', () => {
  const pj = JSON.parse(read(`${repo}/.claude-plugin/plugin.json`));
  const mj = JSON.parse(read(`${repo}/.claude-plugin/marketplace.json`));
  assert.equal(pj.name, 'proofline');
  assert.equal(pj.license, 'MIT');
  assert.equal(pj.author.name, 'Furkan SARIKAYA');
  assert.equal(pj.repository, 'https://github.com/furkansarikaya/proofline');
  assert.equal(pj.hooks, './adapters/claude/hooks/hooks.json');
  assert.equal(pj.version, VERSION);
  assert.equal(mj.plugins[0].name, 'proofline');
  assert.equal(mj.plugins[0].source, '.');
  assert.deepEqual([...pj.agents].sort(), readdirSync(`${repo}/adapters/claude/agents`).map((n) => `./adapters/claude/agents/${n}`).sort());
});

test('the real claude validates the plugin, strictly (skipped where claude is not installed)', { skip: spawnSync('sh', ['-c', 'command -v claude'], { env: process.env }).status !== 0 && 'claude is not installed: not tested' }, () => {
  for (const extra of [[], ['--strict']]) {
    const r = spawnSync('claude', ['plugin', 'validate', '.', ...extra], { cwd: repo, env: process.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('the proofline skill carries the shared-rules block verbatim, routes $ARGUMENTS and documents the init requirement', () => {
  const r = spawnSync('sh', [`${repo}/tests/shared/check-shared.sh`, 'proofline'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const skill = read(`${repo}/skills/proofline/SKILL.md`);
  assert.ok(/^name: proofline$/m.test(skill) && skill.includes('ARGUMENTS') && skill.includes('proofline init'));
});

// ---- the terminal installer (adapters/codex/install.sh stays a shell program until 173-D) ------------------------------------------------------------------------------
const inst = `${repo}/adapters/codex/install.sh`;
const installer = (/** @type {string} */ home, /** @type {string[]} */ args, /** @type {NodeJS.ProcessEnv} */ env = {}, /** @type {string | undefined} */ input = '') =>
  spawnSync('sh', [inst, ...args], { env: { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', ...env }, input, encoding: 'utf8' });

test('install.sh without a terminal and without --yes installs nothing', () => {
  const h = path.join(sb.T, 'h2'); mkdirSync(h, { recursive: true });
  const r = installer(h, ['--dir', `${h}/bin`]);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(`${h}/bin/proofline`));
});

test('install.sh --yes links bin/proofline, the link runs (node resolves the symlink), the rc file gets the PATH line once, and a PATH that has the dir leaves the rc file alone', () => {
  const h = path.join(sb.T, 'h3'); mkdirSync(h, { recursive: true });
  writeFileSync(`${h}/.zshrc`, '');
  const r = installer(h, ['--dir', `${h}/bin`, '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(lstatSync(`${h}/bin/proofline`).isSymbolicLink());
  const v = spawnSync(`${h}/bin/proofline`, ['version'], { env: sb.env, encoding: 'utf8' });
  assert.equal(v.stdout, `proofline ${VERSION}\n`, v.stderr);
  assert.ok(r.stdout.includes('proofline init'));
  const count = () => read(`${h}/.zshrc`).split('\n').filter((l) => l.includes(`${h}/bin`)).length;
  assert.equal(count(), 1);
  installer(h, ['--dir', `${h}/bin`, '--yes']);
  assert.equal(count(), 1, 'a second run does not duplicate it');
  const h4 = path.join(sb.T, 'h4'); mkdirSync(`${h4}/bin`, { recursive: true });
  writeFileSync(`${h4}/.zshrc`, '');
  installer(h4, ['--dir', `${h4}/bin`, '--yes'], { PATH: `${h4}/bin:/usr/bin:/bin` });
  assert.equal(statSync(`${h4}/.zshrc`).size, 0, 'the rc file is left alone when the dir is already on PATH');
});

test('the launcher is a symlink-safe Node program: a link through two folders, a relative link and the file itself all run the checkout\'s CLI', () => {
  const dir = path.join(sb.T, 'links'); mkdirSync(`${dir}/a/b`, { recursive: true });
  spawnSync('ln', ['-s', PL, `${dir}/a/direct`]);
  spawnSync('ln', ['-s', '../direct', `${dir}/a/b/rel`]);
  for (const f of [PL, `${dir}/a/direct`, `${dir}/a/b/rel`]) {
    const r = spawnSync(f, ['version'], { cwd: dir, env: sb.env, encoding: 'utf8' });
    assert.equal(r.stdout, `proofline ${VERSION}\n`, `${f}: ${r.stderr}`);
  }
});
