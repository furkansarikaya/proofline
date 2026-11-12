// @ts-check
// `proofline init` (A233, the former bin/lib/install.sh and the init scenarios of tests/cli/cli-test.sh: sc_init, sc_init_idempotent, sc_init_merge, sc_init_dry_errors,
// sc_init_global_hookspath, sc_init_role, sc_discovery). Absolute expectations on the files init writes, the merge of what the project already has, the dry run, the
// errors and the role overrides; the runtimes are fake binaries on the PATH and HOME and the global git config are private to the sandbox.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { INIT_FLAGS, VERSION, cfgv, sandbox, sig } from './frontend-lib.mjs';
import { repo } from './helpers.mjs';
import { launch } from '../lib/winpath.mjs';

const sb = sandbox();
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const json = (/** @type {string} */ f) => JSON.parse(read(f));
const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const git = (/** @type {string} */ d, /** @type {string[]} */ ...a) => spawnSync('git', ['-C', d, ...a], { env: sb.env, encoding: 'utf8' });
const lines = (/** @type {string} */ f) => read(f).split('\n');
/** Every `.proofline-new` below DIR. @param {string} dir @returns {string[]} */
function strays(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    if (e.isDirectory()) out.push(...strays(path.join(dir, e.name)));
    else if (e.name.endsWith('.proofline-new')) out.push(e.name);
  }
  return out;
}
/** @param {string} d */
const withPackage = (d) => { writeFileSync(`${d}/package.json`, '{"scripts":{"build":"tsc","test":"jest","lint":"eslint ."}}\n'); return d; };

const base = withPackage(sb.mkrepo('base'));
const first = sb.pl(base, ['init', ...INIT_FLAGS]);
const globalSha = sha(`${sb.T}/home/.gitconfig-global`);

test('init --yes with flags exits 0, discovers the build command from package.json and stamps the config', () => {
  assert.equal(first.status, 0, first.text);
  assert.ok(first.out.includes("build='npm run build'"), first.out);
  assert.equal(cfgv(base, 'runtime.worker'), 'codex');
  assert.equal(cfgv(base, 'runtime.lead'), 'claude');
  assert.equal(cfgv(base, 'profile'), 'economy');
  assert.equal(cfgv(base, 'git.protected_branches'), 'release');
  assert.equal(cfgv(base, 'git.forbidden_identities'), '*@forbidden-zz.test *@other-zz.test');
  assert.equal(cfgv(base, 'commands.test'), 'npm test');
  assert.equal(cfgv(base, 'commands.lint'), 'npm run lint');
  assert.equal(cfgv(base, 'canonical_branch'), 'main');
  assert.equal(cfgv(base, 'proofline_version'), VERSION);
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'config-check'], { cwd: base, env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the scripts and git hooks are executable, and the control plane, roles, agents, hooks and instruction files are all there', () => {
  for (const f of ['.agents/scripts/agent.sh', '.agents/scripts/dispatch.sh', '.agents/githooks/pre-commit', '.agents/githooks/pre-push']) assert.ok(process.platform === 'win32' || statSync(`${base}/${f}`).mode & 0o100, `${f} is not executable`);
  for (const f of ['.agents/WORKFLOW.md', '.agents/GATES.md', '.agents/templates/RUN.yaml', '.agents/modes/deterministic.yaml', '.agents/hooks/proofline-hook.mjs', '.agents/hooks/events/pretool.mjs', '.agents/hooks/lib/yield.mjs',
    '.agents/roles.conf', '.agents/roles/lead.md', '.claude/agents/proofline-reviewer.md', '.codex/agents/proofline-reviewer.toml', 'AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.codex/hooks.json', '.agents/.proofline-manifest']) {
    assert.ok(existsSync(`${base}/${f}`), `missing after init: ${f}`);
  }
  assert.deepEqual(strays(base), [], 'no stray .proofline-new after a clean init');
});

test('every skill (including proofline) is installed in .agents/skills and the entry skill for Claude in .claude/skills/proofline', () => {
  const skills = readdirSync(`${repo}/skills`).filter((s) => existsSync(`${repo}/skills/${s}/SKILL.md`));
  assert.ok(skills.length >= 18, String(skills.length));
  for (const s of skills) assert.ok(existsSync(`${base}/.agents/skills/${s}/SKILL.md`), s);
  assert.ok(existsSync(`${base}/.claude/skills/proofline/SKILL.md`));
});

test('the roles are rendered for the chosen profile (equal to generate.mjs --profile economy)', () => {
  const gen = `${sb.T}/gen-economy`;
  const r = spawnSync(process.execPath, [`${repo}/adapters/generate.mjs`, '--profile', 'economy', '--out', gen], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const [a, b] of [[`${gen}/.claude/agents`, `${base}/.claude/agents`], [`${gen}/.codex/agents`, `${base}/.codex/agents`]]) {
    assert.equal(sig(a), sig(b), a);
  }
  assert.equal(read(`${gen}/.agents/roles.conf`), read(`${base}/.agents/roles.conf`));
});

test('the Claude settings and the Codex hooks wire all seven events to the Node hook', () => {
  const bad = [];
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
    for (const f of ['.claude/settings.json', '.codex/hooks.json']) {
      const cmds = (json(`${base}/${f}`).hooks[ev] ?? []).flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
      if (!cmds.some((/** @type {string} */ c) => c.includes('proofline-hook.mjs'))) bad.push(`${f}:${ev}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('AGENTS.md and CLAUDE.md carry the marked block; .gitignore ignores .agents/local/ and .agents/runs/ and gets no .claude line (A117)', () => {
  assert.ok(lines(`${base}/AGENTS.md`).includes('<!-- proofline:begin -->') && lines(`${base}/AGENTS.md`).includes('<!-- proofline:end -->'));
  assert.ok(lines(`${base}/CLAUDE.md`).includes('<!-- proofline:begin -->'));
  const gi = lines(`${base}/.gitignore`);
  assert.ok(gi.includes('.agents/local/') && gi.includes('.agents/runs/'));
  assert.ok(!gi.some((l) => /^\/?\.claude(\/|$)/.test(l)));
});

test('the installed AGENTS.md block: a conditional .out-of-scope line, no unconditional read, within the context budget; no .out-of-scope folder or entry of proofline\'s own', () => {
  const text = read(`${base}/AGENTS.md`);
  const blk = text.slice(text.indexOf('<!-- proofline:begin -->'), text.indexOf('<!-- proofline:end -->') + '<!-- proofline:end -->'.length);
  const flat = blk.replace(/\s+/g, ' ');
  assert.ok(flat.includes('If the project has `.out-of-scope/`, read its README before proposing a feature'));
  assert.ok(flat.includes('if not, do nothing (no folder, no question)'));
  assert.ok(flat.includes('a Rejected match is not built and the user is told; Deferred is never a side effect'));
  assert.ok(!flat.includes('read `.out-of-scope/README.md`'));
  const max = Number(read(`${repo}/tests/context/budget.tsv`).split('\n').map((l) => l.split('\t')).find((r) => r[0] === 'agents_md')?.[1]);
  assert.ok(Buffer.byteLength(`${blk}\n`) <= max, `${Buffer.byteLength(`${blk}\n`)} > ${max}`);
  const own = readdirSync(`${repo}/.out-of-scope`).filter((n) => n.endsWith('.md') && n !== 'README.md');
  assert.ok(own.length > 0);
  assert.ok(!existsSync(`${base}/.out-of-scope`));
  const found = [];
  /** @param {string} d */
  const rec = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; if (own.includes(e.name)) found.push(e.name); if (e.isDirectory()) rec(path.join(d, e.name)); } };
  rec(base);
  assert.deepEqual(found, []);
});

test('core.hooksPath is set locally and the global git configuration is untouched', () => {
  assert.equal(git(base, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '.agents/githooks');
  assert.equal(sha(`${sb.T}/home/.gitconfig-global`), globalSha);
});

test('the manifest lists every installed file with its sha256 and the version, and its paths outside .agents/ are the installed control paths', () => {
  const rows = lines(`${base}/.agents/.proofline-manifest`).filter((l) => l !== '' && !l.startsWith('#')).map((l) => /** @type {[string, string]} */ (l.split(/  (.*)/s).slice(0, 2)));
  assert.ok(rows.length > 100, String(rows.length));
  assert.deepEqual(rows.filter(([h, p]) => sha(`${base}/${p}`) !== h), []);
  assert.ok(read(`${base}/.agents/.proofline-manifest`).split('\n').includes(`# version: ${VERSION}`));
  const outside = rows.map((r) => r[1]).filter((p) => !p.startsWith('.agents/'));
  assert.ok(outside.length >= 20, String(outside.length));
  assert.deepEqual(outside.filter((p) => !/^(\.claude\/agents\/proofline-.*\.md|\.codex\/agents\/proofline-.*\.toml|\.claude\/skills\/proofline\/SKILL\.md)$/.test(p)), []);
  // the manifest is in byte order of the paths, not in the order of a locale
  const paths = rows.map((r) => r[1]);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test('a second init changes no file and says "no changes"; .gitignore still has no .claude line', () => {
  const d = sb.copy('idem');
  const before = sig(d);
  const r = sb.pl(d, ['init', ...INIT_FLAGS]);
  assert.equal(r.status, 0, r.text);
  assert.equal(sig(d), before);
  assert.ok(r.out.includes('no changes'), r.out);
  assert.ok(!lines(`${d}/.gitignore`).some((l) => /^\/?\.claude(\/|$)/.test(l)));
});

test('init merges, never overwrites: AGENTS.md, CLAUDE.md, .gitignore, settings.json, hooks.json and .codex/config.toml keep what the user had', () => {
  const pre = sb.mkrepo('pre');
  writeFileSync(`${pre}/AGENTS.md`, '# My agents\nkeep me\n');
  writeFileSync(`${pre}/CLAUDE.md`, 'my claude notes');
  writeFileSync(`${pre}/.gitignore`, 'node_modules\n');
  mkdirSync(`${pre}/.claude`); mkdirSync(`${pre}/.codex`);
  writeFileSync(`${pre}/.claude/settings.json`, '{"permissions":{"allow":["Bash(ls)"]},"model":"opus","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}\n');
  writeFileSync(`${pre}/.codex/hooks.json`, '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo codex-mine"}]}]},"extra":1}\n');
  writeFileSync(`${pre}/.codex/config.toml`, 'model = "user-model"\n[sandbox_workspace_write]\ncustom = "mine"\nnetwork_access = false\n');
  const r = sb.pl(pre, ['init', '--yes', '--runtimes', 'claude,codex']);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(lines(`${pre}/AGENTS.md`).slice(0, 2), ['# My agents', 'keep me']);
  assert.ok(lines(`${pre}/AGENTS.md`).includes('<!-- proofline:begin -->'));
  assert.equal(lines(`${pre}/CLAUDE.md`)[0], 'my claude notes');
  assert.ok(lines(`${pre}/CLAUDE.md`).includes('<!-- proofline:end -->'));
  const gi = lines(`${pre}/.gitignore`);
  assert.ok(gi.includes('node_modules') && gi.includes('.agents/runs/') && gi.includes('.agents/local/'));
  assert.ok(!gi.some((l) => /^\/?\.claude(\/|$)/.test(l)));
  const s = json(`${pre}/.claude/settings.json`);
  assert.equal(s.permissions.allow[0], 'Bash(ls)');
  assert.equal(s.model, 'opus');
  const pt = s.hooks.PreToolUse.flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
  assert.ok(pt.includes('echo mine'));
  assert.equal(pt.filter((/** @type {string} */ c) => c.includes('proofline-hook.mjs')).length, 1);
  const h = json(`${pre}/.codex/hooks.json`);
  assert.equal(h.extra, 1);
  assert.ok(h.hooks.SessionStart.flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ x) => x.command)).includes('echo codex-mine'));
  assert.ok(h.hooks.SubagentStop.length >= 1);
  const toml = lines(`${pre}/.codex/config.toml`);
  assert.ok(toml.includes('network_access = true') && toml.includes('custom = "mine"') && toml.includes('model = "user-model"') && !toml.includes('network_access = false'));
  assert.ok(read(`${pre}/.agents/.proofline-manifest`).includes('# toml-.codex/config.toml:'));
  const s1 = sig(pre);
  const r2 = sb.pl(pre, ['init', '--yes', '--runtimes', 'claude,codex']);
  assert.equal(sig(pre), s1, `no duplicated hooks or blocks\n${r2.text}`);
  writeFileSync(`${pre}/.claude/settings.json`, '{ not json');
  const r3 = sb.pl(pre, ['init', '--yes', '--runtimes', 'claude,codex']);
  assert.equal(read(`${pre}/.claude/settings.json`), '{ not json');
  assert.ok(r3.out.includes('not merged'), r3.text);
});

test('a codex-only init creates no .claude/ and no CLAUDE.md and enables workspace-write network; a claude-only init writes no codex config', () => {
  const cx = sb.mkrepo('codexonly');
  assert.equal(sb.pl(cx, ['init', '--yes', '--runtimes', 'codex']).status, 0);
  assert.ok(!existsSync(`${cx}/.claude`) && !existsSync(`${cx}/CLAUDE.md`) && existsSync(`${cx}/.codex/hooks.json`));
  assert.ok(lines(`${cx}/.codex/config.toml`).includes('network_access = true'));
  const cl = sb.mkrepo('claudeonly');
  assert.equal(sb.pl(cl, ['init', '--yes', '--runtimes', 'claude']).status, 0);
  assert.ok(!existsSync(`${cl}/.codex/config.toml`));
});

test('--dry-run writes nothing (no files, no git config) and prints the plan', () => {
  const dry = sb.mkrepo('dry');
  const before = sig(dry);
  const r = sb.pl(dry, ['init', '--yes', '--dry-run', '--runtimes', 'claude']);
  assert.equal(r.status, 0, r.text);
  assert.equal(sig(dry), before);
  assert.ok(!existsSync(`${dry}/.agents`));
  assert.equal(git(dry, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '');
  assert.ok(r.out.includes('dry run'), r.out);
  assert.ok(r.out.includes('.agents/scripts'), r.out);
});

test('init fails outside a git repository, with an unknown profile, and with a lead runtime that is not in --runtimes', () => {
  const nogit = path.join(sb.T, 'nogit'); mkdirSync(nogit);
  const r = sb.pl(nogit, ['init', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /is not a git repository; run git init first/);
  assert.notEqual(sb.pl(sb.mkrepo('badprof'), ['init', '--yes', '--runtimes', 'claude', '--profile', 'turbo']).status, 0);
  const l = sb.pl(sb.mkrepo('badlead'), ['init', '--yes', '--runtimes', 'claude', '--lead', 'codex']);
  assert.notEqual(l.status, 0);
  assert.match(l.err, /runtime codex is used by the config but not in --runtimes \(claude\)/);
  assert.match(sb.pl(sb.mkrepo('badarg'), ['init', '--frobnicate']).err, /init: unknown argument: --frobnicate \(see: proofline help\)/);
  assert.match(sb.pl(sb.mkrepo('badval'), ['init', '--profile']).err, /--profile needs a value/);
  assert.match(sb.pl(sb.mkrepo('badrt'), ['init', '--yes', '--runtimes', 'gemini']).err, /unknown runtime: gemini \(claude or codex\)/);
});

test('a global core.hooksPath is warned about by init, never modified and not overridden (A238; the doctor line is tested in doctor-faults)', () => {
  const cfg = `${sb.T}/home/.gitconfig-hp`;
  writeFileSync(cfg, `${read(`${sb.T}/home/.gitconfig-global`)}[core]\n\thooksPath = /nonexistent/global-hooks\n`);
  const before = sha(cfg);
  const d = sb.mkrepo('ghp');
  const r = sb.pl(d, ['init', '--yes', '--runtimes', 'claude'], { GIT_CONFIG_GLOBAL: cfg });
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('global/system git core.hooksPath'), r.out);
  assert.equal(git(d, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '', 'A238: a global value of the user is not overridden by a local one');
  assert.equal(sha(cfg), before);
});

test('a local core.hooksPath of the user is kept and warned about', () => {
  const d = sb.mkrepo('lhp');
  git(d, 'config', '--local', 'core.hooksPath', '.husky');
  const r = sb.pl(d, ['init', '--yes', '--runtimes', 'claude']);
  assert.equal(r.status, 0, r.text);
  assert.equal(git(d, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '.husky');
  assert.ok(r.out.includes("core.hooksPath is '.husky' (local git config"), r.out);
  assert.ok(r.out.includes('NOT overwritten') && r.out.includes('git config --local core.hooksPath .agents/githooks'), r.out);
});

test('--verify-commands drops a discovered command whose trial failed and leaves commands.test empty', () => {
  const vr = sb.mkrepo('verify');
  writeFileSync(`${vr}/package.json`, '{"scripts":{"test":"x"}}');
  const stub = path.join(sb.T, 'stub'); mkdirSync(stub, { recursive: true });
  writeFileSync(`${stub}/npm`, '#!/bin/sh\nexit 1\n'); chmodSync(`${stub}/npm`, 0o755);
  const r = sb.pl(vr, ['init', '--yes', '--runtimes', 'claude', '--verify-commands'], { PATH: `${stub}:${sb.env.PATH}` });
  assert.ok(r.out.includes('trial failed'), r.text);
  assert.equal(cfgv(vr, 'commands.test'), '');
});

test('init says empty commands are proposed, not waited for, and names proofline doctor --commands', () => {
  const r = sb.pl(sb.mkrepo('nocmds'), ['init', '--yes', '--runtimes', 'claude']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /commands\.build, commands\.test, commands\.lint still empty: .* proofline doctor --commands finds the commands/);
  assert.match(r.out, /next: proofline doctor {4}\(verifies hooks, runtimes and every enforced rule\)/);
});

test('init --role: accepted, written, resolved by exec-policy, repeatable (the last value wins) and added to an older config', () => {
  const rl = sb.mkrepo('role1');
  assert.equal(sb.pl(rl, ['init', '--yes', '--runtimes', 'claude,codex', '--role', 'implementer=codex']).status, 0);
  assert.equal(cfgv(rl, 'runtime.roles.implementer'), 'codex');
  const pol = (/** @type {string} */ role) => spawnSync('node', ['.agents/scripts/proofline-core.mjs', 'cli', 'exec-policy', 'runtime', role], { cwd: rl, env: sb.env, encoding: 'utf8' }).stdout.trim();
  assert.equal(pol('implementer'), 'codex');
  assert.equal(pol('reviewer'), 'claude');
  assert.ok(!sb.pl(rl, ['doctor']).out.includes('FAIL config'));
  const rl2 = sb.mkrepo('role2');
  assert.equal(sb.pl(rl2, ['init', '--yes', '--runtimes', 'claude,codex', '--role', 'implementer=codex', '--role', 'qa=claude', '--role', 'implementer=claude']).status, 0);
  assert.equal(cfgv(rl2, 'runtime.roles.qa'), 'claude');
  assert.equal(cfgv(rl2, 'runtime.roles.implementer'), 'claude');
  assert.equal(lines(`${rl2}/.agents/config.yaml`).filter((l) => l.startsWith('    implementer:')).length, 1);
  const rl3 = sb.mkrepo('role3');
  sb.pl(rl3, ['init', '--yes', '--runtimes', 'claude,codex']);
  writeFileSync(`${rl3}/.agents/config.yaml`, lines(`${rl3}/.agents/config.yaml`).filter((l) => !l.startsWith('  roles:')).join('\n'));
  assert.equal(sb.pl(rl3, ['init', '--yes', '--runtimes', 'claude,codex', '--role', 'qa=codex']).status, 0);
  assert.equal(cfgv(rl3, 'runtime.roles.qa'), 'codex');
});

test('init --role on a config with roles: {} makes a proper parent line; an inline roles map is refused with a clear message', () => {
  const rl4 = sb.mkrepo('role4');
  sb.pl(rl4, ['init', '--yes', '--runtimes', 'claude,codex']);
  const cfg = `${rl4}/.agents/config.yaml`;
  writeFileSync(cfg, read(cfg).replace(/^ {2}roles:.*/m, '  roles: {}'));
  assert.equal(sb.pl(rl4, ['init', '--yes', '--runtimes', 'claude,codex', '--role', 'qa=codex']).status, 0);
  assert.equal(cfgv(rl4, 'runtime.roles.qa'), 'codex');
  assert.ok(!read(cfg).includes('roles: {}'));
  writeFileSync(cfg, read(cfg).replace(/^ {2}roles:.*/m, '  roles: {qa: claude}'));
  const r = sb.pl(rl4, ['init', '--yes', '--runtimes', 'claude,codex', '--role', 'qa=codex']);
  assert.notEqual(r.status, 0);
  assert.ok(r.err.includes('has an inline value'), r.err);
});

test('init --role rejects an empty value, an unknown role or runtime, a value without = and a runtime outside --runtimes, each with its message, and writes nothing', () => {
  assert.notEqual(sb.pl(sb.mkrepo('rolebad0'), ['init', '--yes', '--role', '']).status, 0);
  const cases = /** @type {Array<[string, string[], RegExp]>} */ ([
    ['nonesuch=codex', ['--runtimes', 'claude,codex'], /unknown role in --role: nonesuch/],
    ['implementer=gemini', ['--runtimes', 'claude,codex'], /unknown runtime in --role: gemini/],
    ['implementer', ['--runtimes', 'claude,codex'], /invalid --role value: implementer/],
    ['implementer=', ['--runtimes', 'claude,codex'], /invalid --role value: implementer=/],
    ['=codex', ['--runtimes', 'claude,codex'], /invalid --role value: =codex/],
    ['../x=codex', ['--runtimes', 'claude,codex'], /unknown role in --role: \.\.\/x/],
    ['implementer=codex', ['--runtimes', 'claude'], /not in --runtimes/],
  ]);
  let i = 0;
  for (const [role, extra, msg] of cases) {
    const d = sb.mkrepo(`rolebad${++i}`);
    const r = sb.pl(d, ['init', '--yes', ...extra, '--role', role]);
    assert.notEqual(r.status, 0, role);
    assert.match(r.err, msg, role);
    assert.ok(!existsSync(`${d}/.agents`), `nothing is written after the rejected --role ${role}`);
  }
});

test('the PROOFLINE_* environment variables are the defaults of the flags, and a flag wins over them', () => {
  const d = sb.mkrepo('envdef');
  const r = sb.pl(d, ['init', '--yes', '--lead', 'codex'], { PROOFLINE_RUNTIMES: 'claude,codex', PROOFLINE_PROFILE: 'max', PROOFLINE_LEAD: 'claude', PROOFLINE_PUSH_APPROVAL: 'false', PROOFLINE_PROTECTED_BRANCHES: 'main release' });
  assert.equal(r.status, 0, r.text);
  assert.equal(cfgv(d, 'runtime.lead'), 'codex');
  assert.equal(cfgv(d, 'profile'), 'max');
  assert.equal(cfgv(d, 'git.push_requires_approval'), 'false');
  assert.equal(cfgv(d, 'git.protected_branches'), 'main release');
});

test('an existing config keeps its values on init: only a flag given explicitly changes a key', () => {
  const d = sb.copy('keepcfg');
  const cfg = `${d}/.agents/config.yaml`;
  writeFileSync(cfg, read(cfg).replace(/^profile: .*/m, 'profile: max').replace(/^ {2}push_requires_approval: .*/m, '  push_requires_approval: false'));
  const r = sb.pl(d, ['init', '--yes', '--runtimes', 'claude,codex', '--task-adapter', 'github']);
  assert.equal(r.status, 0, r.text);
  assert.equal(cfgv(d, 'profile'), 'max');
  assert.equal(cfgv(d, 'git.push_requires_approval'), 'false');
  assert.equal(cfgv(d, 'tasks.adapter'), 'github');
});

test('init asks the questions on the terminal when PROOFLINE_PROMPT=1 and takes the answers from standard input; an empty answer is the default', () => {
  const d = sb.mkrepo('ask');
  const l = launch(path.join(repo, 'bin', 'proofline'), ['init']);
  const r = spawnSync(l.program, l.args, { cwd: d, env: { ...sb.env, PROOFLINE_PROMPT: '1' }, input: 'claude\n\n\n\nmax\n\n\n\n\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /Runtimes to set up \(claude, codex\) \[claude codex\]: /);
  assert.match(r.stderr, /Lead runtime \[claude\]: /);
  assert.equal(cfgv(d, 'profile'), 'max');
  assert.equal(cfgv(d, 'runtime.lead'), 'claude');
  assert.ok(!existsSync(`${d}/.codex`), 'the answer claude is the only runtime');
});
