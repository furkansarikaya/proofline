// @ts-check
// `proofline doctor` (A232): the platform line and its source, the faults doctor must catch (git hooks, identity, hook wiring, manifest, runtimes, the Codex lead model),
// a global core.hooksPath, the proxy and certificate variables, leftover worktrees, the load line, and the helpers that decide those lines.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { foreignHooks, globalHookspathMessage, headJoined, hookHas, loadWarning } from '../../control-plane/agents/scripts/core/doctor.mjs';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const edit = (/** @type {string} */ file, /** @type {(t: string) => string} */ fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));
const git = (/** @type {string} */ d, /** @type {string[]} */ a) => spawnSync('git', ['-C', d, ...a], { env: sb.env, encoding: 'utf8' });

test('the platform line says where the platform came from: origin address, config (A186), and a git.platform without git.platform_host on a look-alike origin warns', () => {
  const dp = sb.copy('dp');
  git(dp, ['remote', 'add', 'origin', 'https://gitlab.company.com/acme/app.git']);
  assert.ok(sb.pl(dp, ['doctor']).out.includes('source auto: origin URL; a private host is named with git.platform'), 'an unknown private host is auto');
  edit(`${dp}/.agents/config.yaml`, (t) => t.replace(/^ {2}platform:.*$/m, '  platform: gitlab').replace(/^ {2}platform_host:.*$/m, '  platform_host: gitlab.company.com'));
  const cfg = sb.pl(dp, ['doctor']);
  assert.ok(cfg.out.includes('platform: gitlab (source config: git.platform)'), cfg.out);
  assert.match(cfg.out, /^WARN platform: gitlab \(source config: git\.platform\), but its tool \(glab\) is not installed; merge rule: manual\. proofline pushes the branch and prints the pull request address \(https:\/\/gitlab\.company\.com\/acme\/app\); YOU open and merge it$/m);
  edit(`${dp}/.agents/config.yaml`, (t) => t.replace(/^ {2}platform_host:.*$/m, '  platform_host:'));
  git(dp, ['remote', 'set-url', 'origin', 'https://gitlab.com.evil.example/acme/app.git']);
  const loose = sb.pl(dp, ['doctor']);
  assert.ok(loose.out.includes('WARN platform: git.platform is gitlab without git.platform_host'), loose.out);
  const cc = spawnSync('sh', [`${dp}/.agents/scripts/agent.sh`, 'config-check'], { cwd: dp, env: sb.env, encoding: 'utf8' });
  assert.ok((cc.stdout + cc.stderr).includes('git.platform is gitlab without git.platform_host'), 'config-check warns the same way');
  git(dp, ['remote', 'set-url', 'origin', 'https://gitlab.company.com/acme/app.git']);
  edit(`${dp}/.agents/config.yaml`, (t) => t.replace(/^ {2}platform_host:.*$/m, '  platform_host: other.company.com'));
  assert.ok(sb.pl(dp, ['doctor']).out.includes('source auto: origin URL; a private host is named with git.platform'), 'a configured host that is not the origin host is not applied');
});

test('a GitHub origin with gh on the PATH passes with the merge rule; a Bitbucket origin and an unrecognised host warn that the user merges', async () => {
  mkdirSync(`${sb.T}/ghbin`, { recursive: true }); writeFileSync(`${sb.T}/ghbin/gh`, '#!/bin/sh\nexit 0\n'); chmodSync(`${sb.T}/ghbin/gh`, 0o755);
  const mk = (/** @type {string} */ name, /** @type {string} */ url) => { const d = sb.copy(name); git(d, ['remote', 'add', 'origin', url]); return d; };
  const [gh, bb, other] = await Promise.all([
    sb.plAsync(mk('pgh', 'git@github.com:acme/app.git'), ['doctor'], { PATH: `${sb.T}/ghbin:${sb.env.PATH}` }),
    sb.plAsync(mk('pbb', 'https://bitbucket.org/acme/app.git'), ['doctor']),
    sb.plAsync(mk('pot', 'https://git.example.org/acme/app.git'), ['doctor']),
  ]);
  assert.match(gh.out, /^PASS platform: github \(source auto: origin URL\), tool gh installed; merge rule: proofline opens and merges the pull request, every check must be green, and a pull request without checks is merged only after build and test pass in a clean copy \(verified locally, no CI\)$/m);
  assert.match(bb.out, /^WARN platform: bitbucket \(source auto: origin URL\); merge rule: manual\. proofline has no adapter: it pushes the branch and prints the pull request address \(https:\/\/bitbucket\.org\/acme\/app\); YOU open and merge it$/m);
  assert.match(other.out, /^WARN platform: not recognized \(https:\/\/git\.example\.org\/acme\/app; source auto: origin URL; a private host is named with git\.platform and git\.platform_host in \.agents\/config\.yaml\); merge rule: manual\./m);
});

test('faults: an unset core.hooksPath, a forbidden identity, unwired Claude hooks, a modified installed file, an unrelated hooksPath, a used runtime that is not installed, and the project outside an install', async () => {
  const d2 = sb.copy('d2'); git(d2, ['config', '--local', '--unset', 'core.hooksPath']);
  const d2b = sb.copy('d2b'); git(d2b, ['config', '--local', 'core.hooksPath', '/elsewhere']);
  const d3 = sb.copy('d3'); git(d3, ['config', '--local', 'user.email', 'someone@forbidden-zz.test']);
  const d4 = sb.copy('d4'); rmSync(`${d4}/.claude/settings.json`);
  const d5 = sb.copy('d5'); writeFileSync(`${d5}/.agents/GATES.md`, `${readFileSync(`${d5}/.agents/GATES.md`, 'utf8')}tampered\n`);
  const d8 = sb.copy('d8'); edit(`${d8}/.agents/config.yaml`, (t) => t.replace(/^ {2}worker: claude/m, '  worker: codex'));
  const [r2, r2b, r3, r4, r5, r8] = await Promise.all([d2, d2b, d3, d4, d5, d8].map((d, i) => sb.plAsync(d, ['doctor'], i === 5 ? { PROOFLINE_CODEX_BIN: '/nonexistent/codex' } : {})));
  assert.ok(r2.out.includes('FAIL git hooks: core.hooksPath is not set; the commit and push locks are inactive. Fix: git config --local core.hooksPath .agents/githooks\n'), r2.out);
  assert.notEqual(r2.status, 0);
  assert.ok(r2b.out.includes("FAIL git hooks: core.hooksPath is '/elsewhere', not .agents/githooks; the proofline locks are inactive\n"), r2b.out);
  assert.ok(r3.out.includes('FAIL identity: the author and committer identity (repository-local config) matches git.forbidden_identities; the pre-commit hook will block commits. Set another identity: git config --local user.email ...\n'), r3.out);
  assert.ok(!r3.out.includes('forbidden-zz'), 'the pattern is never printed');
  assert.notEqual(r3.status, 0);
  assert.ok(r4.out.includes('FAIL claude hooks: .claude/settings.json lacks proofline hooks for: SessionStart UserPromptSubmit PreToolUse PostToolUse SubagentStart SubagentStop Stop (run: proofline init)\n'), r4.out);
  assert.notEqual(r4.status, 0);
  assert.ok(r5.out.includes('WARN manifest: 1 installed file(s) differ from the installed version (modified by you; upgrade keeps them)\n'), r5.out);
  assert.equal(r5.status, 0);
  assert.ok(r8.out.includes('WARN runtime codex: not installed, but config.yaml uses it (failover/dispatch to codex will be BLOCKED)\n'), r8.out);
  // outside an installed project
  const bare = sb.mkrepo('nodoc');
  const none = sb.pl(bare, ['doctor']);
  assert.equal(none.status, 1);
  assert.ok(none.out.includes('FAIL installed: .agents/config.yaml or .agents/scripts/agent.sh missing in '), none.out);
  assert.ok(none.out.includes('\ndoctor: 1 FAIL, 0 WARN\n'), none.out);
});

test('manifest: a missing non-critical file is a WARN with exit 0, a missing critical file or folder is a FAIL naming it', async () => {
  const d6 = sb.copy('d6'); rmSync(`${d6}/.agents/PROTOCOL.md`);
  const crit = ['.agents/scripts/dispatch.sh', '.agents/owns.conf', '.agents/tools.conf', '.agents/roles.conf', '.agents/githooks/pre-push', '.agents/skills/proofline-lead'];
  const runs = crit.map((c, i) => { const d = sb.copy(`d7-${i}`); rmSync(path.join(d, c), { recursive: true, force: true }); return sb.plAsync(d, ['doctor']); });
  const [a, ...rest] = await Promise.all([sb.plAsync(d6, ['doctor']), ...runs]);
  assert.equal(a.status, 0, a.text);
  assert.ok(a.out.includes('WARN manifest: 1 installed file(s) are missing (proofline upgrade restores them)\n'), a.out);
  rest.forEach((r, i) => {
    assert.notEqual(r.status, 0, crit[i]);
    assert.ok(r.out.includes(`FAIL manifest: required control-plane file missing: ${crit[i]}`) || (crit[i].endsWith('proofline-lead') && r.out.includes('FAIL manifest: required control-plane file missing: .agents/skills/proofline-lead/')), `${crit[i]}: ${r.out}`);
  });
});

test('a Codex lead resolves to the base model and passes; a config without lead_base_model also warns', async () => {
  const d9 = sb.copy('d9'); edit(`${d9}/.agents/config.yaml`, (t) => t.replace(/^ {2}lead: claude/m, '  lead: codex'));
  const ok = await sb.plAsync(d9, ['doctor']);
  assert.ok(ok.out.includes('PASS lead model: codex lead resolves to gpt-6-sol (base model or stronger)\n'), ok.out);
  edit(`${d9}/.agents/config.yaml`, (t) => t.split('\n').filter((l) => !/lead_base_model:|^ {4}codex: gpt-6-sol$/.test(l)).join('\n'));
  const out = sb.pl(d9, ['doctor']).out;
  assert.ok(out.includes('WARN lead model: .agents/config.yaml has no execution_policy.lead_base_model (the built-in base is used; run: proofline upgrade)\n'), out);
});

test('a global core.hooksPath is warned about by init and doctor and never modified', () => {
  const gh = `${sb.T}/home/.gitconfig-hp`;
  writeFileSync(gh, `${readFileSync(`${sb.T}/home/.gitconfig-global`, 'utf8')}[core]\n\thooksPath = /nonexistent/global-hooks\n`);
  const ghp = sb.mkrepo('ghp');
  const init = sb.pl(ghp, ['init', '--yes', '--runtimes', 'claude'], { GIT_CONFIG_GLOBAL: gh });
  assert.equal(init.status, 0, init.text);
  assert.ok(init.text.includes('global/system git core.hooksPath'), init.text);
  const before = readFileSync(gh, 'utf8');
  const doc = sb.pl(ghp, ['doctor'], { GIT_CONFIG_GLOBAL: gh });
  assert.ok(doc.out.includes(`WARN git hooks: ${globalHookspathMessage('/nonexistent/global-hooks')}\n`), doc.out);
  assert.equal(readFileSync(gh, 'utf8'), before);
  assert.equal(spawnSync('git', ['-C', ghp, 'config', '--local', '--get', 'core.hooksPath'], { env: sb.env, encoding: 'utf8' }).stdout, '.agents/githooks\n');
});

test('proxy and certificate variables that are not passed to the platform tools are listed by name and reason, never by value; nothing is listed when none was dropped', async () => {
  const d = sb.copy('dnet');
  const [quiet, loud] = await Promise.all([sb.plAsync(d, ['doctor']), sb.plAsync(d, ['doctor'], { ALL_PROXY: 'socks5://user:s3cr3t@proxy.example:1080', HTTPS_PROXY: 'http://user:topsecret@proxy.example:8080/path?x=1' })]);
  assert.ok(!quiet.out.includes('WARN network:'));
  const line = loud.out.split('\n').find((l) => l.startsWith('WARN network:')) ?? '';
  assert.ok(line.startsWith('WARN network: these proxy or certificate variables are set here but NOT passed to gh, glab, az and the merge-proof git (values are never shown): '), loud.out);
  assert.ok(line.includes('ALL_PROXY (never passed to the platform tools and the merge-proof git)'), line);
  assert.ok(line.includes('HTTPS_PROXY (not an http:// or https:// address of the allowed shape (host and optional port, no socks, path or query))'), line);
  assert.ok(line.endsWith('. Allowed, with a value that passes the check: HTTPS_PROXY, HTTP_PROXY, NO_PROXY, SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, GIT_SSL_CAINFO'), line);
  for (const secret of ['s3cr3t', 'topsecret', 'proxy.example']) assert.ok(!loud.out.includes(secret), `a value was printed: ${secret}`);
});

/** @param {string} id */
const leftover = (id) => {
  const d = sb.copy(`wt-${id}`);
  const wt = `${d}/.agents/local/worktrees/${id}`;
  git(d, ['worktree', 'add', '-q', '--detach', wt, 'main']);
  mkdirSync(`${wt}/.agents/runs/${id}`, { recursive: true });
  writeFileSync(`${wt}/.agents/runs/${id}/RUN.yaml`, 'execution:\n  state: DONE\nhandoff:\n  state: DONE\n');
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  writeFileSync(`${d}/.agents/local/batch/merged.tsv`, `${id}\t12\t1700000000\n`);
  return d;
};

test('a leftover worktree is one WARN with the removal command, counted in the summary, and doctor removes nothing', () => {
  const d = leftover('L-1');
  const r = sb.pl(d, ['doctor']);
  assert.ok(r.out.includes('WARN worktrees: the worktree of L-1 is a leftover: its run is DONE and its merge is recorded in the batch, but .agents/local/worktrees/L-1 is still present. To remove it (the run records are archived first), run: sh .agents/scripts/agent.sh worktree-remove L-1 --force\n'), r.out);
  assert.ok(r.out.includes('\ndoctor: 0 FAIL, 3 WARN\n'), r.out);
  assert.ok(existsSync(`${d}/.agents/local/worktrees/L-1/.agents/runs/L-1`));
  assert.ok(!sb.pl(sb.copy('wt-none'), ['doctor']).out.includes('WARN worktrees'));
});

test('a hostile worktree folder name is never proposed as a command', () => {
  const d = leftover('V-1');
  for (const bad of ['x;touch PWNED;#', 'L$(touch PWNED)']) {
    const w = `${d}/.agents/local/worktrees/${bad}`;
    if (git(d, ['worktree', 'add', '-q', '--detach', w, 'main']).status !== 0) continue;
    mkdirSync(`${w}/.agents/runs/${bad}`, { recursive: true });
    writeFileSync(`${w}/.agents/runs/${bad}/RUN.yaml`, 'execution:\n  state: DONE\nhandoff:\n  state: DONE\n');
    writeFileSync(`${d}/.agents/local/batch/merged.tsv`, `${readFileSync(`${d}/.agents/local/batch/merged.tsv`, 'utf8')}${bad}\t13\t1700000001\n`);
  }
  const r = sb.pl(d, ['doctor']);
  assert.equal(r.out.split('\n').filter((l) => l.startsWith('WARN worktrees')).length, 1, r.out);
  assert.ok(!r.out.includes('PWNED'));
});

test('the load line: above the core count it names the busiest executable; a fine or unreadable load prints nothing (hermetic readings)', () => {
  const ps = () => 'busyproc';
  assert.equal(loadWarning({ PROOFLINE_DOCTOR_LOAD: '120.5', PROOFLINE_DOCTOR_CORES: '8' }, ps), 'load: machine load 120.5 is above its 8 cores; the executable with the most processes: busyproc. Hooks and tests slow down until it settles');
  assert.equal(loadWarning({ PROOFLINE_DOCTOR_LOAD: '9,5', PROOFLINE_DOCTOR_CORES: '8' }, () => ''), 'load: machine load 9.5 is above its 8 cores. Hooks and tests slow down until it settles');
  assert.equal(loadWarning({ PROOFLINE_DOCTOR_LOAD: '2.0', PROOFLINE_DOCTOR_CORES: '8' }, ps), '');
  assert.equal(loadWarning({ PROOFLINE_DOCTOR_LOAD: '8', PROOFLINE_DOCTOR_CORES: '8' }, ps), '', 'equal is not above');
  for (const [l, c] of [['junk', '8'], ['5', 'x'], ['5', '0'], ['', '']]) assert.equal(loadWarning({ PROOFLINE_DOCTOR_LOAD: l, PROOFLINE_DOCTOR_CORES: c }, ps), '', `${l}/${c}`);
  const r = sb.pl(sb.copy('dload'), ['doctor'], { PROOFLINE_DOCTOR_LOAD: '120.5', PROOFLINE_DOCTOR_CORES: '8' });
  assert.match(r.out, /^WARN load: machine load 120\.5 is above its 8 cores(; the executable with the most processes: \S+)?\. Hooks and tests slow down until it settles$/m);
});

test('the helpers: hook wiring is read from JSON for each event, a foreign hook list ignores proofline\'s own, head-and-join keeps the trailing space of a longer output', () => {
  const f = `${sb.T}/hooks.json`;
  writeFileSync(f, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node /p/proofline-hook.mjs stop"}]}],"PreToolUse":[{"hooks":[{"command":"echo other"}]}],"SessionStart":[{"hooks":[{"command":"echo a"},{"command":null},{"command":"node proofline-hook.mjs x"}]}]}}');
  assert.equal(hookHas(f, 'Stop'), true);
  assert.equal(hookHas(f, 'PreToolUse'), false);
  assert.equal(hookHas(f, 'SubagentStop'), false);
  assert.equal(hookHas(`${sb.T}/missing.json`, 'Stop'), false);
  writeFileSync(f, '{ not json');
  assert.equal(hookHas(f, 'Stop'), false);
  writeFileSync(f, '{"hooks":{"SessionStart":[{"hooks":[{"command":"echo a"},{"command":null},{"command":"node proofline-hook.mjs x"}]}],"Stop":[{"hooks":[{"command":"echo s"}]}]}}');
  assert.deepEqual(foreignHooks(f), [['SessionStart', 'echo a'], ['SessionStart', '']]);
  writeFileSync(f, '{"hooks":{"SessionStart":[{"hooks":[{"command":"echo a"},{"command":5}]}]}}');
  assert.deepEqual(foreignHooks(f), [], 'a command that is not text makes the whole file count for nothing');
  assert.equal(headJoined('one\ntwo\n', 2), 'one two');
  assert.equal(headJoined('one\ntwo\nthree\n', 2), 'one two ');
  assert.equal(headJoined('', 2), '');
});
