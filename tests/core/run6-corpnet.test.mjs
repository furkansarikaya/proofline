// @ts-check
// A220 (epic #165 follow-up after stages 4 and 6): a corporate network. The proxy variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, lowercase too) and the
// certificate variables (SSL_CERT_FILE, NODE_EXTRA_CA_CERTS) reach gh, glab, az and the merge-proof git, but only with a value of a narrow shape; the
// GitHub Enterprise host comes from git.platform_host of the config and never from the caller's GH_HOST, in check delivery, `merge` and the github adapter.
// The merge proof stays un-steerable (A136): nothing a model can name inline or export makes the tool talk to another server.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync as wf } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanCommand } from '../../adapters/claude/hooks/command-scan.mjs';
import { mergeGuard } from '../../adapters/claude/hooks/guards/merge.mjs';
import { Deny } from '../../adapters/claude/hooks/guards/kit.mjs';
import { caFileValue, cleanToolEnv, detectPlatform, noProxyValue, platformEnv, proxyValue, resolveTool, runTool } from '../../control-plane/agents/scripts/core/platform.mjs';
import { A, project, scripts } from './legacy-lib.mjs';
import { gOk, readFileSync, run, toolRoot } from './run6-lib.mjs';

/** A context as far as the platform module reads one. @param {string} cwd @param {Record<string, string>} [env] */
function ctxOf(cwd, env = {}) {
  const e = { PATH: '/usr/bin:/bin', ...env };
  return /** @type {any} */ ({ env: e, cwd, root: cwd, childEnv: () => ({ ...e, LC_ALL: 'C' }), sharedMain: () => cwd });
}
const work = mkdtempSync(path.join(tmpdir(), 'pf-corp-'));
const CA = '/etc/passwd'; // a regular file that exists on every system the tests run on and is outside every folder a model can write

test('a proxy value is a plain http(s) address: user, password, host or address, port; anything else is dropped, never repaired', () => {
  for (const ok of ['http://proxy.corp.example:3128', 'https://proxy.corp.example', 'http://user:p%40ss@proxy.corp.example:8080/', 'HTTP://10.0.0.1:80', 'http://[::1]:3128', 'http://user@proxy:1']) {
    assert.equal(proxyValue(ok), true, ok);
  }
  for (const bad of ['', 'proxy.corp.example:3128', 'socks5://proxy:1080', 'ftp://proxy', 'file:///etc/passwd', 'http://', 'http://proxy:99999x', 'http://proxy/path', 'http://proxy?x=1', 'http://proxy#f',
    'http://proxy.corp.example:3128 ', ' http://proxy', 'http://proxy\n', 'http://pro\txy', 'http://proxy\u0000', 'http://pro xy', 'http://a@b@proxy', 'http://us er@proxy', 'http://proxy:3128/;rm', 'http://$(id)', 'http://`id`',
    'http://proxy,http://other', 'http://-proxy-', 'http://proxy_name:1', `http://${'a'.repeat(2100)}`]) {
    assert.equal(proxyValue(bad), false, JSON.stringify(bad));
  }
});

test('a NO_PROXY value is a plain list of hosts, suffixes, addresses and ports', () => {
  for (const ok of ['localhost', 'localhost,127.0.0.1', 'localhost, .corp.example, *.corp.example', '10.0.0.0/8,[::1],host:8080', '*']) assert.equal(noProxyValue(ok), true, ok);
  for (const bad of ['', ',', 'a,,b', 'a,  b', 'a b', 'a\nb', 'a;b', '$(id)', 'a,b,', ' a', 'a\u0000', `h${',h'.repeat(3000)}`]) assert.equal(noProxyValue(bad), false, JSON.stringify(bad));
});

test('a certificate file is an absolute path of an existing regular file outside every folder a model can write', () => {
  const ctx = ctxOf(work);
  assert.equal(caFileValue(ctx, CA), true);
  const inTmp = path.join(work, 'ca.pem'); wf(inTmp, 'x');
  const link = path.join(work, 'ca-link.pem'); symlinkSync(CA, link);
  const linkToTmp = path.join(work, 'ca-link2.pem'); symlinkSync(inTmp, linkToTmp);
  for (const [bad, why] of /** @type {Array<[string, string]>} */ ([
    [inTmp, 'a file in a temporary folder'], [link, 'a link kept in a temporary folder'], [linkToTmp, 'a link that resolves into a temporary folder'], [work, 'a folder'], ['/etc', 'a folder outside'],
    ['etc/passwd', 'a relative path'], ['./passwd', 'a relative path'], ['', 'empty'], ['/nonexistent/ca.pem', 'a missing file'], [`${CA}\n`, 'a control character'], [`${CA}\u0000`, 'a NUL'],
    ['/dev/null', 'not a regular file'], [`/tmp/../${CA}`, 'a path through a temporary folder'],
  ])) assert.equal(caFileValue(ctx, bad), false, `${why}: ${JSON.stringify(bad)}`);
  // the working directory and the project are refused even when they are not temporary folders
  const other = { ...ctxOf('/etc'), root: '/etc' };
  assert.equal(caFileValue(other, CA), false, 'a file inside the project root');
  assert.equal(caFileValue({ ...ctxOf('/etc'), root: work }, CA), false, 'a file inside the working directory');
});

test('cleanToolEnv keeps a well-formed proxy and certificate variable (also for the merge-proof git) and drops a malformed one; the other variables stay dropped', () => {
  const good = {
    HTTPS_PROXY: 'http://proxy.corp.example:3128', https_proxy: 'http://u:p@proxy.corp.example:3128', HTTP_PROXY: 'http://proxy.corp.example:3128', http_proxy: 'http://proxy.corp.example:3128',
    NO_PROXY: 'localhost,.corp.example', no_proxy: 'localhost', SSL_CERT_FILE: CA, NODE_EXTRA_CA_CERTS: CA,
  };
  const ctx = ctxOf(work, { ...good, ALL_PROXY: 'http://other:1', SSL_CERT_DIR: '/etc', CURL_CA_BUNDLE: CA, REQUESTS_CA_BUNDLE: CA, GIT_SSL_CAINFO: CA, GIT_SSL_NO_VERIFY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0', GH_HOST: 'evil.example' });
  for (const opt of [{}, { remote: true }]) {
    const e = cleanToolEnv(ctx, opt);
    for (const [k, v] of Object.entries(good)) assert.equal(e[k], v, k);
    for (const k of ['ALL_PROXY', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO', 'GIT_SSL_NO_VERIFY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GH_HOST']) assert.ok(!(k in e), `${k} reached the tool`);
  }
  const badCtx = ctxOf(work, { HTTPS_PROXY: 'http://proxy:1/ x', https_proxy: 'socks5://p:1', HTTP_PROXY: 'proxy:3128', NO_PROXY: 'a b', SSL_CERT_FILE: path.join(work, 'ca.pem'), NODE_EXTRA_CA_CERTS: 'relative.pem' });
  const e = cleanToolEnv(badCtx);
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) assert.ok(!(k in e), `${k} was kept`);
  // a proxy without its certificate, and a certificate without a proxy, are both fine
  assert.deepEqual(Object.keys(cleanToolEnv(ctxOf(work, { HTTPS_PROXY: good.HTTPS_PROXY }))).filter((k) => /PROXY|CERT|CA_/.test(k)), ['HTTPS_PROXY']);
  assert.deepEqual(Object.keys(cleanToolEnv(ctxOf(work, { SSL_CERT_FILE: CA }))).filter((k) => /PROXY|CERT|CA_/.test(k)), ['SSL_CERT_FILE']);
});

test('gh, glab and az each start with the same coherent set: the proxy and certificate variables of a good shape, the host only from the config', () => {
  const seenBy = /** @type {Record<string, Map<string, string>>} */ ({});
  const bin = path.join(toolRoot, `corp-${process.pid}`, 'bin');
  mkdirSync(bin, { recursive: true });
  const proj = mkdtempSync(path.join(tmpdir(), 'pf-corp-proj-'));
  gOk(proj, 'init', '-q', '-b', 'main');
  mkdirSync(`${proj}/.agents`);
  const env = {
    HTTPS_PROXY: 'http://proxy.corp.example:3128', NO_PROXY: 'localhost', SSL_CERT_FILE: CA, NODE_EXTRA_CA_CERTS: CA, GH_HOST: 'evil.example', GITLAB_HOST: 'evil.example',
    ALL_PROXY: 'http://evil:1', PATH: `${bin}:/usr/bin:/bin`,
  };
  for (const [tool, platform, url, host] of [['gh', 'github', 'https://git.corp.example/a/b.git', 'GH_HOST'], ['glab', 'gitlab', 'https://git.corp.example/a/b.git', 'GITLAB_HOST'], ['az', 'azure', 'https://dev.azure.com/acme/Proj/_git/app', '']]) {
    const dump = path.join(toolRoot, `corp-${process.pid}`, `${tool}.env`);
    wf(`${bin}/${tool}`, `#!/bin/sh\nenv > "${dump}"\nexit 0\n`);
    chmodSync(`${bin}/${tool}`, 0o755);
    wf(`${proj}/.agents/config.yaml`, `git:\n  platform: ${platform}\n  platform_host: ${tool === 'az' ? 'dev.azure.com' : 'git.corp.example'}\n`);
    const ctx = ctxOf(proj, env);
    const info = detectPlatform(ctx, { url, dir: proj });
    const t = resolveTool(ctx, tool);
    assert.ok('path' in t, tool);
    runTool(ctx, info, /** @type {any} */ (t).path, ['version']);
    seenBy[tool] = new Map(readFileSync(dump, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const seen = seenBy[tool];
    assert.equal(seen.get('HTTPS_PROXY'), env.HTTPS_PROXY, `${tool}: proxy`);
    assert.equal(seen.get('NO_PROXY'), 'localhost', `${tool}: no_proxy`);
    assert.equal(seen.get('SSL_CERT_FILE'), CA, `${tool}: certificate`);
    assert.equal(seen.get('NODE_EXTRA_CA_CERTS'), CA, `${tool}: node certificate`);
    assert.ok(!seen.has('ALL_PROXY'), `${tool}: ALL_PROXY`);
    if (host !== '') assert.equal(seen.get(host), 'git.corp.example', `${tool}: ${host} comes from git.platform_host`);
    for (const h of ['GH_HOST', 'GITLAB_HOST']) assert.ok(seen.get(h) !== 'evil.example', `${tool}: the caller's ${h} reached the tool`);
  }
  assert.ok(!seenBy['az']?.has('GH_HOST') && !seenBy['az']?.has('GITLAB_HOST'));
});

test('the host variable comes only from git.platform_host: a platform named by the caller (PROOFLINE_PLATFORM) or a config without the host exports none', () => {
  const proj = mkdtempSync(path.join(tmpdir(), 'pf-corp-host-'));
  gOk(proj, 'init', '-q', '-b', 'main');
  mkdirSync(`${proj}/.agents`);
  const info = (/** @type {string} */ url, env = {}) => detectPlatform(ctxOf(proj, { GH_HOST: 'evil.example', ...env }), { url, dir: proj });
  assert.deepEqual(platformEnv(info('https://git.corp.example/a/b.git', { PROOFLINE_PLATFORM: 'github' })), {}, 'a platform from the environment gets no host variable');
  assert.equal(info('https://git.corp.example/a/b.git', { PROOFLINE_PLATFORM: 'github' }).source, 'env');
  assert.deepEqual(platformEnv(info('https://git.corp.example/a/b.git')), {});
  wf(`${proj}/.agents/config.yaml`, 'git:\n  platform: github\n');
  assert.deepEqual(platformEnv(info('https://git.corp.example/a/b.git')), {}, 'git.platform without platform_host is untrusted for a private host');
  wf(`${proj}/.agents/config.yaml`, 'git:\n  platform: github\n  platform_host: git.corp.example\n');
  assert.deepEqual(platformEnv(info('https://git.corp.example/a/b.git')), { GH_HOST: 'git.corp.example' });
  assert.deepEqual(platformEnv(info('https://git.other.example/a/b.git')), {}, 'an origin that is not the configured host');
});

/** A project with a GitHub Enterprise origin named in the config, and a gh that records its environment and answers `pr view`. */
function enterpriseProject(/** @type {string} */ tag) {
  const d = project('scaffold standalone yes; to_code_done standalone; rm -f .agents/task-integrations/markdown.sh; finish_done');
  const bin = path.join(toolRoot, `${tag}-${process.pid}`, 'bin');
  const dump = path.join(toolRoot, `${tag}-${process.pid}`, 'env.txt');
  mkdirSync(bin, { recursive: true });
  const sha = '1'.repeat(40);
  const view = JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, headRefOid: sha, statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  const state = JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: sha, headRefName: 'proofline/LC', baseRefName: 'main', headRepositoryOwner: { login: 'acme' } });
  wf(`${bin}/gh`, `#!/bin/sh\nenv >> "${dump}"\ncase "$*" in\n  *"pr merge"*) exit 0 ;;\n  *"pr checks"*) echo "no required checks reported on the 'main' branch" >&2; exit 1 ;;\n  *statusCheckRollup*) echo '${view}' ;;\n  *"--json headRefOid") echo '{"headRefOid":"${sha}"}' ;;\n  *"pr view"*) echo '${state}' ;;\n  --version) echo gh ;;\n  auth*) exit 0 ;;\n  issue*) echo '{"title":"t","url":"u","body":"","labels":[]}' ;;\nesac\nexit 0\n`);
  chmodSync(`${bin}/gh`, 0o755);
  run(d, 'git', ['remote', 'remove', 'origin']);
  run(d, 'git', ['remote', 'add', 'origin', 'https://git.corp.example/acme/app.git']);
  wf(`${d}/.agents/config.yaml`, readFileSync(`${d}/.agents/config.yaml`, 'utf8').replace(/^ {2}platform:.*$/m, '  platform: github').replace(/^ {2}platform_host:.*$/m, '  platform_host: git.corp.example'));
  const hostile = { GH_HOST: 'evil.example', GH_REPO: 'evil/repo', HTTPS_PROXY: 'http://proxy.corp.example:3128', SSL_CERT_FILE: CA, PROOFLINE_PLATFORM: 'gitlab' };
  const env = { PATH: `${bin}:${process.env.PATH}`, ...hostile };
  /** The environments gh saw, as one text. */
  const seen = () => { try { return readFileSync(dump, 'utf8'); } catch { return ''; } };
  return { d, env, seen };
}
const checkHost = (/** @type {string} */ seen, /** @type {string} */ what) => {
  assert.ok(seen.length > 0, `${what}: the fake gh was not run`);
  assert.match(seen, /^GH_HOST=git\.corp\.example$/m, what);
  assert.ok(!/evil/.test(seen), `${what}: ${seen}`);
  assert.match(seen, /^HTTPS_PROXY=http:\/\/proxy\.corp\.example:3128$/m, `${what}: proxy`);
  assert.match(seen, /^SSL_CERT_FILE=\/etc\/passwd$/m, `${what}: certificate`);
};

test('check delivery (pr-state), `merge` and the github adapter take GH_HOST from git.platform_host; the caller\'s GH_HOST never reaches gh', () => {
  // check delivery: the pull request state read before a delivery is closed
  const a = enterpriseProject('corp-pr');
  const env = { ...a.env }; delete (/** @type {any} */ (env)).PROOFLINE_PLATFORM; // config beats the environment anyway; this case keeps the config path pure
  const r = A(a.d, ['pr-state', '7'], { env });
  assert.equal(r.out, 'OPEN\n', r.text);
  checkHost(a.seen(), 'pr-state');
  // proofline merge
  const m = enterpriseProject('corp-merge');
  const mr = run(m.d, process.execPath, [`${scripts}/proofline-core.mjs`, 'cli', 'merge', '7'], m.env);
  assert.equal(mr.status, 0, mr.text);
  checkHost(m.seen(), 'merge');
  // the github task adapter
  const t = enterpriseProject('corp-adapter');
  run(t.d, process.execPath, [`${t.d}/.agents/scripts/proofline-core.mjs`, 'cli', 'task-adapter', 'github', 'status', 'GH-7', 'todo'], t.env);
  checkHost(t.seen(), 'github adapter');
});

test('SECURITY (A220): the hook denies a proxy or certificate variable named in the command that runs the merge proof, like PATH=; a plain command and an unrelated use pass; the other limits stay open', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-corp-hook-'));
  gOk(dir, 'init', '-q', '-b', 'feat/x');
  const verdict = async (/** @type {string} */ cmd) => {
    const ctx = /** @type {any} */ ({ ev: 'pretool', cwd: dir, root: dir, env: { ...process.env }, act: '', installed: false, agent: async () => ({ status: 0, stdout: '', stderr: '' }), agents: { proc: async () => null } });
    try { await mergeGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
  };
  for (const c of ['HTTPS_PROXY=http://127.0.0.1:9 proofline merge 7', 'SSL_CERT_FILE=/p/ca.pem HTTPS_PROXY=http://127.0.0.1:9 proofline merge 7', 'env NODE_EXTRA_CA_CERTS=/p/ca.pem proofline merge 7',
    'export SSL_CERT_FILE=/p/ca.pem; proofline merge 7', 'export https_proxy=http://127.0.0.1:9; proofline merge 7', 'no_proxy=x HTTP_PROXY=http://127.0.0.1:9 sh .agents/scripts/agent.sh deliver-merged T', 'env HTTPS_PROXY=http://127.0.0.1:9 gh pr view 7',
    'PATH=/tmp/fake:$PATH proofline merge 7', 'HTTPS_PROXY+=http://127.0.0.1:9 SSL_CERT_FILE+=/p/ca.pem proofline merge 7 -R o/r', 'PATH+=:/tmp/fake proofline merge 7']) {
    const r = await verdict(c);
    assert.ok(r !== null, `not denied: ${c}`);
    assert.ok(r.includes('proofline merge'), c);
  }
  for (const c of ['proofline merge 7', 'HTTPS_PROXY=http://proxy.corp:3128 curl -s https://example.com', 'export HTTPS_PROXY=http://proxy.corp:3128', 'SSL_CERT_FILE=/etc/ssl/ca.pem git fetch origin main', 'GH_HOST=evil.example ls', 'NO_PROXY=x npm run lint-merge', 'export no_proxy=localhost; git merge-base main HEAD', 'HTTPS_PROXY=http://p:1 git fetch origin; git log --grep=merge']) {
    assert.equal(await verdict(c), null, c);
  }
  // accepted limits (tripwires, not a boundary; .out-of-scope/small-rejected-ideas.md): a wrapper script, git config http.*, declare -x / typeset -x / readonly are not seen
  for (const c of ['sh ./wrapper.sh', 'git config http.proxy http://127.0.0.1:9', 'declare -x PATH=/p/fake:$PATH; proofline merge 7', 'declare -x SSL_CERT_FILE=/p/ca.pem; proofline merge 7', 'typeset -x HTTPS_PROXY=http://127.0.0.1:9; proofline merge 7', 'readonly SSL_CERT_FILE=/p/ca.pem; export SSL_CERT_FILE; proofline merge 7']) assert.equal(await verdict(c), null, c);
});

/** A project inside the checkout (so outside every temporary folder) with its own .git, the install folder elsewhere, and files of the project the model can write. */
function projectOutsideTmp(/** @type {string} */ tag) {
  const base = path.join(toolRoot, `${tag}-${process.pid}`);
  const proj = path.join(base, 'proj');
  mkdirSync(path.join(proj, '.git'), { recursive: true });
  mkdirSync(path.join(proj, 'docs'), { recursive: true });
  mkdirSync(path.join(proj, 'other'), { recursive: true });
  mkdirSync(path.join(proj, '.agents/local/scratch'), { recursive: true });
  mkdirSync(path.join(base, 'install'), { recursive: true });
  for (const f of ['other/ca.pem', '.agents/local/scratch/ca.pem', 'docs/ca.pem']) wf(path.join(proj, f), 'x');
  return { base, proj, install: path.join(base, 'install') };
}

test('SECURITY-1 (A220): with the control plane rooted in the install folder, a certificate the model wrote anywhere in the PROJECT (not only the working directory) is refused', () => {
  const { base, proj, install } = projectOutsideTmp('corp-ca');
  // proofline merge: root is the install folder, the working directory a subfolder of the project
  const ctx = { ...ctxOf(path.join(proj, 'docs')), root: install };
  for (const f of ['other/ca.pem', '.agents/local/scratch/ca.pem', 'docs/ca.pem']) assert.equal(caFileValue(ctx, path.join(proj, f)), false, f);
  // a linked worktree: the main checkout it points into is refused too
  const main = path.join(base, 'main');
  mkdirSync(path.join(main, '.git/worktrees/w'), { recursive: true });
  wf(path.join(main, 'ca.pem'), 'x');
  const wt = path.join(base, 'wt');
  mkdirSync(wt, { recursive: true });
  wf(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git/worktrees/w')}\n`);
  assert.equal(caFileValue({ ...ctxOf(wt), root: install }, path.join(main, 'ca.pem')), false, 'the main checkout of a worktree');
  // a .agents folder anywhere
  mkdirSync(path.join(base, 'elsewhere/.agents'), { recursive: true });
  wf(path.join(base, 'elsewhere/.agents/ca.pem'), 'x');
  const unrelated = { ...ctxOf('/etc'), root: '/etc' };
  assert.equal(caFileValue(unrelated, path.join(base, 'elsewhere/.agents/ca.pem')), false, '.agents');
  assert.equal(caFileValue({ ...ctxOf(install), root: install }, CA), true, 'a system file passes');
});

test('SECURITY-1 (A220): proofline merge started with a project certificate and a loopback proxy hands gh no certificate (the forged green pull request needs both)', () => {
  const { proj } = projectOutsideTmp('corp-merge-ca');
  run(proj, 'git', ['init', '-q', '-b', 'main']);
  run(proj, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  run(proj, 'git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const bin = path.join(path.dirname(proj), 'ghbin');
  const dump = path.join(path.dirname(proj), 'env.txt');
  mkdirSync(bin, { recursive: true });
  const sha = '1'.repeat(40);
  const view = JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, headRefOid: sha, statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  wf(path.join(bin, 'gh'), `#!/bin/sh\nenv >> "${dump}"\ncase "$*" in\n  *"pr merge"*) exit 0 ;;\n  *"pr checks"*) echo "no required checks reported on the 'main' branch" >&2; exit 1 ;;\n  *statusCheckRollup*) echo '${view}' ;;\n  *"--json headRefOid") echo '{"headRefOid":"${sha}"}' ;;\nesac\nexit 0\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const core = path.join(scripts, 'proofline-core.mjs');
  const go = (/** @type {string} */ ca) => {
    wf(dump, '');
    run(path.join(proj, 'docs'), process.execPath, [core, 'cli', 'merge', '7'], { PATH: `${bin}:${process.env.PATH}`, HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: ca });
    return readFileSync(dump, 'utf8');
  };
  for (const f of ['other/ca.pem', '.agents/local/scratch/ca.pem']) {
    const seen = go(path.join(proj, f));
    assert.ok(seen.length > 0, "gh was not run");
    assert.ok(!/^SSL_CERT_FILE=/m.test(seen), `${f}: the project certificate reached gh: ${seen}`);
    assert.match(seen, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:9$/m, 'the proxy shape is allowed on its own (it cannot forge a TLS answer without the certificate)');
  }
  assert.match(go(CA), /^SSL_CERT_FILE=\/etc\/passwd$/m, 'a system file still passes');
});

test('SECURITY-1 round 2 (A220): the certificate is judged from the FILE up to the filesystem root, whatever the working directory is: a repository, a nested one, a linked worktree or an .agents folder above it refuse it; a plain folder passes', (t) => {
  // outside every temporary folder and outside the checkout: a folder of the home directory (skipped when the home cannot be used)
  let base = '';
  try { base = mkdtempSync(path.join(homedir(), '.pf-corpnet-')); } catch { t.skip('the home directory is not writable'); return; }
  try {
    const neutral = ctxOf('/usr'); // proofline merge -R OWNER/REPO runs from any directory
    const plain = path.join(base, 'plain');
    mkdirSync(plain);
    wf(path.join(plain, 'ca.pem'), 'x');
    chmodSync(plain, 0o755); chmodSync(path.join(plain, 'ca.pem'), 0o644);
    // where the home directory is itself in a repository, holds an .agents folder or is group-writable, no file under it can pass: the positive checks are then skipped
    const usable = caFileValue(neutral, path.join(plain, 'ca.pem'));
    chmodSync(path.join(plain, 'ca.pem'), 0o600);
    if (usable) assert.equal(caFileValue(neutral, path.join(plain, 'ca.pem')), true, 'a private file in a plain folder outside any repository passes (0600)');
    // a project: a repository, a nested repository, a linked worktree, an .agents folder
    const proj = path.join(base, 'proj');
    mkdirSync(path.join(proj, 'sub'), { recursive: true });
    gOk(proj, 'init', '-q', '-b', 'main');
    gOk(proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    gOk(path.join(proj, 'sub'), 'init', '-q', '-b', 'main');
    gOk(proj, 'worktree', 'add', '-q', path.join(base, 'wt'), '-b', 'w');
    mkdirSync(path.join(proj, '.agents/local/scratch'), { recursive: true });
    const files = ['README.md', 'sub/ca.pem', '.agents/local/scratch/ca.pem'];
    for (const f of files) wf(path.join(proj, f), 'x');
    wf(path.join(base, 'wt/ca.pem'), 'x');
    for (const f of [...files.map((x) => path.join(proj, x)), path.join(base, 'wt/ca.pem')]) {
      assert.equal(caFileValue(neutral, f), false, `from /usr: ${f}`);
      assert.equal(caFileValue({ ...ctxOf('/'), root: '/usr/local' }, f), false, `from /: ${f}`);
      assert.equal(caFileValue({ ...ctxOf(path.join(base, 'plain')), root: path.join(base, 'plain') }, f), false, `from a plain folder: ${f}`);
    }
    // a link from a plain folder to a project file resolves into the project
    symlinkSync(path.join(proj, 'README.md'), path.join(plain, 'link.pem'));
    assert.equal(caFileValue(neutral, path.join(plain, 'link.pem')), false, 'a link into a project');
    // owner and mode: a group- or world-writable file or folder above it is refused
    const ok = path.join(plain, 'ca.pem');
    chmodSync(ok, 0o666);
    assert.equal(caFileValue(neutral, ok), false, 'a world-writable file');
    chmodSync(ok, 0o664);
    assert.equal(caFileValue(neutral, ok), false, 'a group-writable file');
    chmodSync(ok, 0o644);
    chmodSync(plain, 0o775);
    assert.equal(caFileValue(neutral, ok), false, 'a group-writable folder above it');
    chmodSync(plain, 0o755);
    if (usable) assert.equal(caFileValue(neutral, ok), true, 'a file of this user in a private folder passes again (0644)');
    // end to end: proofline merge from a neutral directory with a project certificate and a loopback proxy hands gh no certificate
    const bin = path.join(base, 'ghbin');
    const dump = path.join(base, 'env.txt');
    mkdirSync(bin);
    const sha = '1'.repeat(40);
    const view = JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, headRefOid: sha, statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    wf(path.join(bin, 'gh'), `#!/bin/sh\nenv >> "${dump}"\ncase "$*" in\n  *"pr merge"*) exit 0 ;;\n  *"pr checks"*) echo "no required checks reported on the 'main' branch" >&2; exit 1 ;;\n  *statusCheckRollup*) echo '${view}' ;;\n  *"--json headRefOid") echo '{"headRefOid":"${sha}"}' ;;\nesac\nexit 0\n`);
    chmodSync(path.join(bin, 'gh'), 0o755);
    wf(dump, '');
    const mr = run('/var', process.execPath, [path.join(scripts, 'proofline-core.mjs'), 'cli', 'merge', '7', '-R', 'acme/app'], { PATH: `${bin}:${process.env.PATH}`, HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: path.join(proj, 'README.md') });
    const seen = readFileSync(dump, 'utf8');
    assert.ok(seen.length > 0, `gh was not run: ${mr.status} ${mr.text} | ${mr.err}`);
    assert.ok(!/^SSL_CERT_FILE=/m.test(seen), `the project file reached gh: ${seen}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
