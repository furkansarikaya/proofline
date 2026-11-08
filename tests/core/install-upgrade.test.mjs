// @ts-check
// `proofline upgrade` (A233, the former bin/lib/install.sh and the upgrade scenarios of tests/cli/cli-test.sh: sc_upgrade, sc_upgrade_logging, sc_upgrade_block) and
// what init and upgrade refuse to write: a symbolic link in the way, a path in the manifest that leaves the project. The "upstream" release is a copy of the checkout
// with edits (`upstream()`), whose own bin/proofline runs the upgrade.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cfgv, sandbox, sig, upstream } from './frontend-lib.mjs';

const sb = sandbox();
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const lines = (/** @type {string} */ f) => read(f).split('\n');
const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const bin = (/** @type {string} */ home) => path.join(home, 'bin', 'proofline');
const edit = (/** @type {string} */ f, /** @type {(t: string) => string} */ fn) => writeFileSync(f, fn(read(f)));
/** @param {string} dir @returns {string[]} */
function strays(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    if (e.isDirectory()) out.push(...strays(path.join(dir, e.name)));
    else if (e.name.endsWith('.proofline-new')) out.push(path.join(dir, e.name));
  }
  return out;
}
const home2 = upstream(sb.T, (h) => {
  appendFileSync(`${h}/control-plane/agents/GATES.md`, 'upstream change in GATES\n');
  appendFileSync(`${h}/control-plane/agents/WORKFLOW.md`, 'upstream change in WORKFLOW\n');
  writeFileSync(`${h}/control-plane/agents/NEWFILE.md`, 'new file\n');
  edit(`${h}/control-plane/agents/config.yaml`, (t) => t.replace(/^budgets:\n/m, 'budgets:\n  new_budget: 7\n'));
  appendFileSync(`${h}/control-plane/AGENTS.md`, 'upstream block change\n');
});
const upgrade = (/** @type {string} */ d, /** @type {string[]} */ args = [], /** @type {NodeJS.ProcessEnv} */ env = {}) => sb.pl(d, ['upgrade', ...args], env, bin(home2));
const check = (/** @type {string} */ d) => spawnSync('sh', ['.agents/scripts/agent.sh', 'config-check'], { cwd: d, env: sb.env, encoding: 'utf8' });

test('upgrade --dry-run writes nothing; upgrade updates an unmodified file, keeps a modified one with a conflict and a .proofline-new copy, installs a new file, merges config keys', () => {
  const up = sb.copy('up');
  appendFileSync(`${up}/.agents/WORKFLOW.md`, 'my own workflow note\n');
  edit(`${up}/.agents/config.yaml`, (t) => t.replace(/^ {2}max_fix_rounds:.*$/m, '  max_fix_rounds: 5'));
  const before = sig(up);
  const dry = upgrade(up, ['--dry-run']);
  assert.equal(dry.status, 0, dry.text);
  assert.equal(sig(up), before, 'upgrade --dry-run wrote files');
  assert.ok(dry.out.includes('proofline upgrade (dry run, nothing written):'));
  const r = upgrade(up);
  assert.equal(r.status, 0, r.text);
  assert.ok(read(`${up}/.agents/GATES.md`).includes('upstream change in GATES'));
  assert.ok(r.out.includes('updated   .agents/GATES.md'), r.out);
  assert.ok(read(`${up}/.agents/WORKFLOW.md`).includes('my own workflow note') && !read(`${up}/.agents/WORKFLOW.md`).includes('upstream change in WORKFLOW'));
  assert.ok(read(`${up}/.agents/WORKFLOW.md.proofline-new`).includes('upstream change in WORKFLOW'));
  assert.ok(r.out.includes('CONFLICT  .agents/WORKFLOW.md'), r.out);
  assert.ok(r.out.includes('conflicts: files you modified were kept. Compare each with its .proofline-new copy, merge by hand, then delete the copy.'));
  assert.ok(existsSync(`${up}/.agents/NEWFILE.md`));
  assert.equal(cfgv(up, 'budgets.new_budget'), '7');
  assert.equal(cfgv(up, 'review.max_fix_rounds'), '5');
  assert.equal(cfgv(up, 'runtime.worker'), 'codex');
  assert.equal(check(up).status, 0, 'the upgraded config still validates');
  // a user edit of a file upstream did not change is not a conflict, and it is kept
  appendFileSync(`${up}/.agents/ENGINEERING.md`, 'my edit of an unchanged-upstream file\n');
  const r2 = upgrade(up);
  assert.ok(!r2.out.includes('CONFLICT  .agents/ENGINEERING.md'), r2.out);
  assert.ok(read(`${up}/.agents/ENGINEERING.md`).includes('my edit of an unchanged-upstream file'));
});

test('upgrade without an install fails', () => {
  const r = sb.pl(sb.mkrepo('noinst'), ['upgrade']);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /proofline is not installed in .*; run: proofline init/);
});

test('a project from before risk.log_sensitive gets the keys on upgrade; a user who tuned the words keeps them (A162)', () => {
  const up4 = sb.copy('up4');
  const keep = [];
  let skip = false;
  for (const l of lines(`${up4}/.agents/config.yaml`)) {
    if (l === '  log_sensitive:') { skip = true; continue; }
    if (skip && /^ {4}(content|words|check):/.test(l)) continue;
    skip = false;
    keep.push(/^ {2}max_fix_rounds:/.test(l) ? '  max_fix_rounds: 6' : l);
  }
  writeFileSync(`${up4}/.agents/config.yaml`, keep.join('\n'));
  appendFileSync(`${up4}/.agents/WORKFLOW.md`, 'my note\n');
  assert.equal(cfgv(up4, 'risk.log_sensitive.words'), '');
  assert.equal(cfgv(up4, 'risk.log_sensitive.content'), '');
  const r = sb.pl(up4, ['upgrade']);
  assert.equal(r.status, 0, r.text);
  assert.equal(cfgv(up4, 'risk.log_sensitive.check'), 'logging');
  assert.match(cfgv(up4, 'risk.log_sensitive.words'), /\btckn\b/);
  assert.ok(cfgv(up4, 'risk.log_sensitive.content').includes('logger'));
  assert.equal(cfgv(up4, 'review.max_fix_rounds'), '6');
  assert.ok(read(`${up4}/.agents/WORKFLOW.md`).includes('my note'));
  assert.equal(check(up4).status, 0);
  const up5 = sb.copy('up5');
  edit(`${up5}/.agents/config.yaml`, (t) => t.replace(/^ {4}words: password passwd.*$/m, '    words: password voucher'));
  assert.equal(sb.pl(up5, ['upgrade']).status, 0);
  assert.equal(cfgv(up5, 'risk.log_sensitive.words'), 'password voucher');
  assert.equal(cfgv(up5, 'risk.log_sensitive.check'), 'logging');
  assert.equal(check(up5).status, 0);
});

test('the proofline block of AGENTS.md is hash-tracked: an unedited block updates without a conflict, an edit inside it is a conflict and is never overwritten (CLI-7)', () => {
  const up2 = sb.copy('up2');
  const r = upgrade(up2);
  assert.equal(r.status, 0, r.text);
  assert.ok(read(`${up2}/AGENTS.md`).includes('upstream block change'));
  assert.ok(!existsSync(`${up2}/AGENTS.md.proofline-new`));
  assert.ok(!r.out.includes('CONFLICT  AGENTS.md'), r.out);
  const up3 = sb.copy('up3');
  edit(`${up3}/AGENTS.md`, (t) => t.replace('<!-- proofline:end -->', 'my own rule inside the block\n<!-- proofline:end -->'));
  appendFileSync(`${up3}/AGENTS.md`, 'outside note\n');
  const before = read(`${up3}/AGENTS.md`);
  const r3 = upgrade(up3);
  assert.equal(r3.status, 0, r3.text);
  assert.ok(r3.out.includes('CONFLICT  AGENTS.md'), r3.out);
  assert.equal(read(`${up3}/AGENTS.md`), before);
  assert.ok(read(`${up3}/AGENTS.md.proofline-new`).includes('upstream block change'));
});

test('the AGENTS.md template carries no logging text; the user\'s Logging section and the edit above survive two upgrades, the block is updated, no .proofline-new (A162)', () => {
  const tpl = read(path.join(home2, 'control-plane', 'AGENTS.md'));
  assert.ok(!/logging/i.test(tpl));
  const up6 = sb.copy('up6');
  assert.ok(!/logging/i.test(read(`${up6}/AGENTS.md`)));
  writeFileSync(`${up6}/AGENTS.md`, `my edit above the block\n${read(`${up6}/AGENTS.md`)}\n## Logging\n- Log through internal/logx only.\n`);
  for (const n of [1, 2]) {
    const r = upgrade(up6);
    assert.equal(r.status, 0, `upgrade ${n}: ${r.text}`);
    assert.ok(!r.out.includes('CONFLICT'), `upgrade ${n}: ${r.out}`);
  }
  const t = lines(`${up6}/AGENTS.md`);
  assert.ok(t.includes('my edit above the block') && t.includes('## Logging') && t.includes('- Log through internal/logx only.') && read(`${up6}/AGENTS.md`).includes('upstream block change'));
  assert.deepEqual(strays(up6), []);
});

test('a file an older release installed and this one no longer ships is removed when unmodified and kept (reported as an orphan) when modified', () => {
  const d = sb.copy('orphans');
  const man = `${d}/.agents/.proofline-manifest`;
  writeFileSync(`${d}/.agents/OLD-GONE.md`, 'old\n');
  writeFileSync(`${d}/.agents/OLD-EDITED.md`, 'old, edited by the user\n');
  appendFileSync(man, `${createHash('sha256').update('old\n').digest('hex')}  .agents/OLD-GONE.md\n${createHash('sha256').update('old as installed\n').digest('hex')}  .agents/OLD-EDITED.md\n`);
  const r = sb.pl(d, ['upgrade']);
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('- removed   .agents/OLD-GONE.md'), r.out);
  assert.ok(!existsSync(`${d}/.agents/OLD-GONE.md`));
  assert.ok(r.out.includes('? .agents/OLD-EDITED.md (modified, no longer shipped; kept)'), r.out);
  assert.ok(existsSync(`${d}/.agents/OLD-EDITED.md`));
  assert.ok(read(man).includes('.agents/OLD-EDITED.md'), 'the kept file stays in the manifest');
});

test('the Node hook tree is written as a whole: an edited hook file is replaced and a file this release does not ship is dropped; the files are not in the manifest', () => {
  const d = sb.copy('hooktree');
  appendFileSync(`${d}/.agents/hooks/events/pretool.mjs`, '// edited\n');
  writeFileSync(`${d}/.agents/hooks/events/legacy-event.mjs`, 'export {};\n');
  const r = sb.pl(d, ['upgrade']);
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('~ updated   .agents/hooks/proofline-hook.mjs'), r.out);
  assert.ok(!read(`${d}/.agents/hooks/events/pretool.mjs`).includes('// edited'));
  assert.ok(!existsSync(`${d}/.agents/hooks/events/legacy-event.mjs`));
  assert.ok(!read(`${d}/.agents/.proofline-manifest`).includes('.agents/hooks/proofline-hook.mjs'));
  assert.ok(sb.pl(d, ['upgrade']).out.includes('no changes'));
});

test('without a manifest every differing file counts as modified by the user, with a warning', () => {
  const d = sb.copy('nomanifest');
  rmSync(`${d}/.agents/.proofline-manifest`);
  const r = upgrade(d);
  assert.equal(r.status, 0, r.text);
  assert.match(r.err, /no \.agents\/\.proofline-manifest: every differing file counts as modified by you/);
  assert.ok(r.out.includes('CONFLICT  .agents/GATES.md'), r.out);
});

test('upgrade offers (never does) the move of a root DESIGN.md, and rejects an unknown argument', () => {
  const d = sb.copy('design');
  writeFileSync(`${d}/DESIGN.md`, '# design\n');
  const r = sb.pl(d, ['upgrade']);
  assert.ok(r.out.includes('offer: DESIGN.md sits at the project root; the default location is now docs/design/DESIGN.md. Nothing was moved or rewritten.'), r.out);
  assert.ok(existsSync(`${d}/DESIGN.md`));
  const bad = sb.pl(d, ['upgrade', '--force']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /upgrade: unknown argument: --force/);
});

test('upgrade keeps the runtimes of the first install (the manifest header) and prints the from/to line', () => {
  const d = sb.copy('fromto');
  const r = upgrade(d);
  assert.match(r.out, /^proofline upgrade from [0-9.]+ to [0-9.]+ \(profile economy, runtimes: claude codex\)$/m);
});

// ---- what init and upgrade refuse to write ------------------------------------------------------------------------------------------------------------------

/** A project whose PATH is a symbolic link to a victim file outside it. @param {string} name @param {string} rel @returns {{ d: string, victim: string }} */
function linkedProject(name, rel) {
  const d = sb.mkrepo(name);
  const victim = path.join(sb.T, `victim-${name}`);
  writeFileSync(victim, 'precious\n');
  mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  symlinkSync(victim, path.join(d, rel));
  return { d, victim };
}

test('init does not write through a symbolic link: a link in place of an installed file, of the settings file, of AGENTS.md, of .gitignore and of the config leaves the target as it was', () => {
  for (const rel of ['.agents/scripts/agent.sh', '.claude/settings.json', 'AGENTS.md', '.gitignore', '.agents/config.yaml', '.agents/.proofline-manifest', 'CLAUDE.md', '.agents/WORKFLOW.md']) {
    const { d, victim } = linkedProject(`lk-${rel.replace(/[^A-Za-z]/g, '')}`, rel);
    const r = sb.pl(d, ['init', '--yes', '--runtimes', 'claude']);
    assert.equal(read(victim), 'precious\n', `${rel}: the target of the link was written\n${r.text}`);
    assert.ok(lstatSync(`${d}/${rel}`).isSymbolicLink(), `${rel}: the link was replaced`);
  }
});

test('init does not write below a linked folder: .agents, .claude and .agents/hooks as links to a folder outside the project get nothing', () => {
  for (const rel of ['.agents', '.claude', '.agents/hooks']) {
    const d = sb.mkrepo(`lkdir-${rel.replace(/[^a-z]/g, '')}`);
    const outside = path.join(sb.T, `outside-${rel.replace(/[^a-z]/g, '')}`);
    mkdirSync(outside, { recursive: true });
    if (rel.includes('/')) mkdirSync(path.join(d, path.dirname(rel)), { recursive: true });
    symlinkSync(outside, path.join(d, rel));
    sb.pl(d, ['init', '--yes', '--runtimes', 'claude']);
    assert.deepEqual(readdirSync(outside), [], `${rel}: files were written through the link`);
  }
});

test('a dangling symbolic link in place of a file is not followed either (the target is not created)', () => {
  const d = sb.mkrepo('dangling');
  const target = path.join(sb.T, 'does-not-exist-yet');
  mkdirSync(`${d}/.agents`);
  symlinkSync(target, `${d}/.agents/WORKFLOW.md`);
  const r = sb.pl(d, ['init', '--yes', '--runtimes', 'claude']);
  assert.ok(!existsSync(target), r.text);
  assert.match(r.out, /! WARN      \.agents\/WORKFLOW\.md is a symbolic link or sits under one; not written/, r.out);
});

test('upgrade does not write through a link either (a conflict copy, a block, the manifest)', () => {
  const up = sb.copy('uplink');
  const victim = path.join(sb.T, 'victim-up'); writeFileSync(victim, 'precious\n');
  rmSync(`${up}/.agents/GATES.md`); symlinkSync(victim, `${up}/.agents/GATES.md`);
  rmSync(`${up}/AGENTS.md`); symlinkSync(victim, `${up}/AGENTS.md`);
  const r = upgrade(up);
  assert.equal(read(victim), 'precious\n', r.text);
});

test('a manifest cannot make upgrade delete or touch a file outside the project: an absolute path, a ".." path and a path under a link are reported and left alone', () => {
  const d = sb.copy('hostile');
  const outside = path.join(sb.T, 'outside-file.txt');
  writeFileSync(outside, 'keep me\n');
  const linkTarget = path.join(sb.T, 'outside-dir'); mkdirSync(linkTarget);
  writeFileSync(`${linkTarget}/inner.txt`, 'keep me too\n');
  symlinkSync(linkTarget, `${d}/linked`);
  appendFileSync(`${d}/.agents/.proofline-manifest`, [
    `${sha(outside)}  ${outside}`,
    `${sha(outside)}  ../outside-file.txt`,
    `${sha(`${linkTarget}/inner.txt`)}  linked/inner.txt`,
    `${sha(outside)}  .agents/../../outside-file.txt`,
  ].join('\n') + '\n');
  const r = sb.pl(d, ['upgrade']);
  assert.equal(r.status, 0, r.text);
  assert.equal(read(outside), 'keep me\n');
  assert.equal(read(`${linkTarget}/inner.txt`), 'keep me too\n');
  assert.equal((r.out.match(/! WARN .*is not a plain path inside the project; not touched/g) ?? []).length, 4, r.out);
});
