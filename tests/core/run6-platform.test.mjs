// @ts-check
// Stage 6 (A215): the hosting platform (detection, config, local origins, the failed-log readers), pr-state and batch-ci, in Node. They replace
// scripts/platform.sh and its part of platform-test.sh (detection, A186 config, round 6 local origins, the ci-failed readers) and the `ci` part of batch.sh.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync as wf } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ciFailed, detectPlatform, linkText, platformEnv, resolveTool, runTool, warnText } from '../../control-plane/agents/scripts/core/platform.mjs';
import { A, DONE, accepted, fakeGh, fakeTool, g, gOk, readFileSync, refused, run, toolRoot } from './run6-lib.mjs';
import { project } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';

/** A context as far as the platform module reads one. @param {string} cwd @param {Record<string, string>} [env] */
function ctxOf(cwd, env = {}) {
  const e = { PATH: '/usr/bin:/bin', ...env };
  return /** @type {any} */ ({ env: e, cwd, root: cwd, childEnv: () => ({ ...e, LC_ALL: 'C' }), sharedMain: () => cwd });
}
const stubs = mkdtempSync(path.join(tmpdir(), 'pf-stubs-'));
for (const t of ['glab', 'az']) { wf(path.join(stubs, t), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(stubs, t), 0o755); }
const empty = mkdtempSync(path.join(tmpdir(), 'pf-empty-'));
const det = (/** @type {string} */ url, /** @type {Record<string, string>} */ env = { PATH: `${stubs}:/usr/bin:/bin` }) => detectPlatform(ctxOf(empty, env), { url, dir: empty });

test('GitHub, GitLab, Azure DevOps, Bitbucket and other remotes are recognized; a missing tool or Bitbucket means the manual rule', () => {
  for (const [url, want] of /** @type {Array<[string, string]>} */ ([
    ['git@github.com:acme/app.git', 'github'], ['https://github.com/acme/app', 'github'], ['https://gitlab.com/acme/sub/app.git', 'gitlab'],
    ['git@gitlab.example.org:acme/app.git', 'other'], ['https://acme@dev.azure.com/acme/Proj/_git/app', 'azure'], ['git@ssh.dev.azure.com:v3/acme/Proj/app', 'azure'],
    ['https://acme.visualstudio.com/DefaultCollection/Proj/_git/app', 'azure'], ['git@bitbucket.org:acme/app.git', 'bitbucket'],
    ['ssh://git@git.example.com:2222/acme/app.git', 'other'], ['/srv/git/app.git', 'other'],
    ['https://github.com.evil.example/a/b', 'other'], ['https://gitlab.example.evil.com/a/b', 'other'], ['https://evilgitlab.com/a/b', 'other'],
    ['https://bitbucket.org.evil.example/a/b', 'other'], ['https://notdev.azure.com/a/b/_git/c', 'other'], ['https://gitlab.company.com/a/b', 'other'], ['https://www.github.com/a/b', 'github'],
  ])) assert.equal(det(url).platform, want, url);
  assert.equal(det('https://gitlab.com/acme/app.git').cli, 'glab');
  assert.equal(det('https://dev.azure.com/acme/Proj/_git/app').cli, 'az');
  assert.equal(det('https://bitbucket.org/acme/app').cli, 'none');
  assert.equal(det('https://bitbucket.org/acme/app').merge, 'manual');
  assert.equal(det('https://gitlab.com/acme/app').merge, 'cli');
  assert.equal(det('https://dev.azure.com/acme/Proj/_git/app').owner, 'acme');
  assert.equal(det('https://gitlab.com/acme/app', { PATH: empty }).cli, 'none', 'glab missing must give cli none');
  assert.equal(det('https://gitlab.com/acme/app', { PATH: empty }).merge, 'manual', 'a missing tool must give the manual rule');
  assert.ok(linkText(det('https://dev.azure.com/acme/Proj/_git/app'), 'feat/x', 'main').includes('pullrequestcreate?sourceRef=feat/x&targetRef=main'));
  assert.equal(det('https://github.com/acme/app', { PATH: '/usr/bin:/bin', PROOFLINE_PLATFORM: 'azure' }).source, 'env');
  assert.equal(det('https://gitlab.company.com/a/b', { PATH: '/usr/bin:/bin', PROOFLINE_PLATFORM: 'gitlab' }).platform, 'gitlab', 'PROOFLINE_PLATFORM names a self-hosted host');
});

test('git.platform and git.platform_host: whole-host equality, look-alikes stay other, config beats env beats auto, warn and the host variable', () => {
  const p = mkdtempSync(path.join(tmpdir(), 'pf-proj-'));
  gOk(p, 'init', '-q', '-b', 'main');
  mkdirSync(`${p}/.agents`);
  const cfg = (/** @type {string} */ platform, host = '') => wf(`${p}/.agents/config.yaml`, `git:\n  protected_branches: main\n  platform: ${platform}\n${host ? `  platform_host: ${host}\n` : ''}`);
  const d = (/** @type {string} */ url, env = {}) => detectPlatform(ctxOf(p, { PATH: '/usr/bin:/bin', ...env }), { url, dir: p });
  cfg('gitlab', 'gitlab.company.com');
  assert.equal(d('https://gitlab.company.com/a/b').platform, 'gitlab');
  assert.equal(d('https://gitlab.company.com/a/b').source, 'config');
  assert.equal(d('git@GitLab.Company.com:a/b.git').platform, 'gitlab', 'the host match is case-insensitive');
  for (const u of ['https://gitlab.company.com.evil.example/a/b', 'https://evil-gitlab.company.com/a/b', 'https://gitlab.company.com.attacker.example/a/b', 'https://notgitlab.company.com/a/b']) {
    assert.equal(d(u).platform, 'other', u);
    assert.equal(d(u).source, 'auto', u);
  }
  assert.equal(d('https://gitlab.company.com/a/b', { PROOFLINE_PLATFORM: 'azure' }).platform, 'gitlab', 'config must beat env');
  assert.equal(d('https://elsewhere.example/a/b', { PROOFLINE_PLATFORM: 'azure' }).source, 'env', 'env applies when the configured host differs');
  assert.deepEqual(platformEnv(d('https://gitlab.company.com/a/b')), { GITLAB_HOST: 'gitlab.company.com' });
  cfg('github', 'github.company.com');
  assert.equal(d('https://github.company.com/a/b').platform, 'github');
  assert.equal(d('https://github.com.evil.example/a/b').platform, 'other');
  rmConfig(p);
  assert.equal(d('https://github.com/a/b', { PROOFLINE_PLATFORM: 'azure' }).source, 'env', 'env must beat auto');
  assert.equal(d('https://github.com/a/b').source, 'auto');
  cfg('gitlab');
  assert.equal(d('https://git.example.com/a/b').platform, 'gitlab', 'git.platform without a host applies to any origin');
  // a look-alike origin without platform_host: warned about and no host variable
  const la = d('https://gitlab.com.evil.example/a/b');
  assert.match(warnText(la), /^warning: git\.platform is gitlab without git\.platform_host/);
  assert.deepEqual(platformEnv(la), {});
  assert.equal(warnText(d('https://gitlab.com/a/b')), '', 'gitlab.com is a known gitlab host');
  cfg('github');
  assert.deepEqual(platformEnv(d('https://github.com.evil.example/a/b')), {});
  assert.notEqual(warnText(d('https://github.com.evil.example/a/b')), '');
  cfg('gitlab', 'gitlab.company.com');
  assert.equal(warnText(d('https://gitlab.company.com.evil.example/a/b')), '');
  // round 6: what is a local origin
  for (const u of ['./x', '../x', '/abs', 'file:///abs']) assert.equal(d(u).local, true, `${u} must be a local origin`);
  for (const u of ['.evil.example:org/repo', 'file://host/path', 'file://evil.example/a/b']) assert.equal(d(u).local, false, `${u} must NOT be a local origin`);
});

/** @param {string} p */
function rmConfig(p) { wf(`${p}/.agents/config.yaml`, ''); }

test('ci-failed reads the failed job log of GitHub and GitLab and the build errors of Azure DevOps; an unreadable log says so; Bitbucket has no reader', () => {
  const cx = mkdtempSync(path.join(toolRoot, 'cx-'));
  const put = (/** @type {string} */ name, /** @type {string} */ body) => { wf(`${cx}/${name}`, `#!/bin/sh\n${body}`); chmodSync(`${cx}/${name}`, 0o755); return `${cx}/${name}`; };
  const glab = put('glab', `case "$1 $2" in
  "mr view") echo '{"head_pipeline":{"id":55,"status":"failed"}}' ;;
  "api projects/:id/pipelines/55/jobs?scope[]=failed&per_page=20") echo '[{"id":901,"name":"unit","status":"failed","allow_failure":false}]' ;;
  "ci trace") [ -f "${cx}/trace.none" ] || echo 'FAIL: TestLookup expected 1 got 2' ;;
esac
exit 0
`);
  const az = put('az', `case "$*" in
  *"pr policy list"*) echo '[{"status":"rejected","context":{"buildId":77},"configuration":{"settings":{"displayName":"CI build"}}}]' ;;
  *"devops invoke"*) [ -f "${cx}/tl.none" ] || echo '{"records":[{"name":"Run tests","result":"failed","issues":[{"type":"error","message":"npm test exited 1"}]}]}' ;;
esac
exit 0
`);
  const gh = put('gh', `case "$1 $2" in
  "run list") echo '[{"databaseId":5,"status":"completed","conclusion":"failure","name":"build"},{"databaseId":4,"status":"completed","conclusion":"success","name":"lint"}]' ;;
  "run view") echo 'log line one'; echo 'log line two' ;;
esac
exit 0
`);
  const sha = 'a'.repeat(40);
  const cif = (/** @type {string} */ tool, /** @type {string} */ url) => ciFailed(ctxOf(empty), detectPlatform(ctxOf(empty), { url, dir: empty }), '7', sha, tool);
  const gl = cif(glab, 'https://gitlab.com/acme/app.git');
  assert.equal(gl.split('\n')[0], 'RED\t901\tunit\tfailed\tread');
  assert.ok(gl.includes('TestLookup expected 1 got 2'));
  const azr = cif(az, 'https://acme@dev.azure.com/acme/Proj/_git/app');
  assert.equal(azr.split('\n')[0], 'RED\t77\tCI build\trejected\tread');
  assert.ok(azr.includes('Run tests: npm test exited 1'));
  const ghr = cif(gh, 'https://github.com/acme/app');
  assert.equal(ghr, 'RED\t5\tbuild\tfailure\tread\nLOG\nlog line one\nlog line two\n');
  wf(`${cx}/trace.none`, ''); wf(`${cx}/tl.none`, '');
  const gn = cif(glab, 'https://gitlab.com/acme/app.git');
  assert.equal(gn.split('\n')[0], 'RED\t901\tunit\tfailed\tnone');
  assert.ok(gn.includes('starts from the check name and status only'));
  const an = cif(az, 'https://acme@dev.azure.com/acme/Proj/_git/app');
  assert.equal(an.split('\n')[0], 'RED\t77\tCI build\trejected\tnone');
  assert.equal(cif(glab, 'https://bitbucket.org/acme/app.git'), '', 'bitbucket must have no reader');
  assert.equal(ciFailed(ctxOf(empty), det('https://gitlab.com/a/b'), '7', 'not-a-sha', glab), '', 'a head that is not a sha reads nothing');
});

test('a platform tool that resolves into the project, the working directory or a temporary folder is refused (A180); a symlink does not hide it', () => {
  const shadow = mkdtempSync(path.join(tmpdir(), 'pf-shadow-'));
  wf(`${shadow}/gh`, '#!/bin/sh\nexit 0\n'); chmodSync(`${shadow}/gh`, 0o755);
  const safe = fakeGh();
  const ok = resolveTool(ctxOf(empty, { PATH: `${safe.bin}:/usr/bin:/bin` }), 'gh');
  assert.ok('path' in ok, 'a gh outside every temporary folder is accepted');
  const bad = resolveTool(ctxOf(empty, { PATH: `${shadow}:/usr/bin:/bin` }), 'gh');
  assert.ok('unreadable' in bad && /may be shadowed/.test(bad.unreadable), 'a gh in a temporary folder is refused');
  const link = mkdtempSync(path.join(toolRoot, 'ln-'));
  symlinkSync(`${shadow}/gh`, `${link}/gh`);
  const viaLink = resolveTool(ctxOf(empty, { PATH: `${link}:/usr/bin:/bin` }), 'gh');
  assert.ok('unreadable' in viaLink, 'a symlink into a temporary folder is refused');
  // a relative PATH entry is looked up from the process's own working directory; where it holds no gh the next entry decides
  const rel = resolveTool(ctxOf(empty, { PATH: `.:${safe.bin}` }), 'gh');
  assert.ok('path' in rel && rel.path.endsWith('/bin/gh'), JSON.stringify(rel));
});

/** A fresh folder inside the checkout (never under a temporary folder), and whether the checkout itself is under one. */
const inCheckout = (/** @type {string} */ name) => { const d = path.join(toolRoot, `${name}-${process.pid}`); mkdirSync(d, { recursive: true }); return realpathSync(d); };
const checkoutInTemp = [tmpdir(), '/tmp', '/var/folders', '/private/tmp', '/private/var/folders'].some((t) => repo.startsWith(`${t}/`));

/** A directory with a gh in it. @param {string} dir */
function gh(dir) { mkdirSync(dir, { recursive: true }); wf(`${dir}/gh`, '#!/bin/sh\nexit 0\n'); chmodSync(`${dir}/gh`, 0o755); return dir; }

test('A180: a tool in the project, the working directory or a temporary folder is refused, also when the path is spelled in another case (case-insensitive file systems)', { skip: checkoutInTemp ? 'the checkout is under a temporary folder: the project and cwd cases cannot be told apart from the temp rule' : false }, () => {
  const proj = inCheckout('proj');
  const cwd = inCheckout('cwd');
  const other = inCheckout('other');
  const cases = /** @type {Array<[string, string, string, string]>} */ ([
    ['the project', gh(`${proj}/.agents/runs/T-1/scratch/bin`), proj, other],
    ['the working directory', gh(`${cwd}/bin`), other, cwd],
    ['a temporary folder', gh(mkdtempSync(path.join(tmpdir(), 'a180-tmp-'))), other, other],
  ]);
  for (const [what, bin, root, cwdDir] of cases) {
    const c = (/** @type {string} */ dirOnPath) => ctxOf(cwdDir, { PATH: `${dirOnPath}:/usr/bin:/bin`, TMPDIR: tmpdir() });
    const mk = (/** @type {string} */ p) => { const x = c(p); x.root = root; return x; };
    const canonical = resolveTool(mk(bin), 'gh');
    assert.ok('unreadable' in canonical && /may be shadowed/.test(canonical.unreadable), `${what}: ${JSON.stringify(canonical)}`);
    // the same folder spelled in upper case: refused where the file system treats both as one folder
    const upper = bin.toUpperCase();
    if (upper !== bin && existsSync(`${upper}/gh`)) {
      const r = resolveTool(mk(upper), 'gh');
      assert.ok('unreadable' in r && /may be shadowed/.test(r.unreadable), `${what}, upper case: ${JSON.stringify(r)}`);
      // and a mixed spelling of only the last folder
      const mixed = path.join(path.dirname(bin), path.basename(bin).toUpperCase());
      const m = resolveTool(mk(mixed), 'gh');
      assert.ok('unreadable' in m, `${what}, mixed case: ${JSON.stringify(m)}`);
    }
  }
  // a gh in a folder of its own is accepted
  const fine = gh(inCheckout('fine'));
  const ok = resolveTool({ ...ctxOf(other, { PATH: `${fine}:/usr/bin:/bin`, TMPDIR: tmpdir() }), root: proj }, 'gh');
  assert.ok('path' in ok, JSON.stringify(ok));
});

test('pr-state reads the state of a pull request through the platform tool; an unreadable one says so', () => {
  const gh = fakeGh();
  const d = project(DONE);
  gOk(d, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  gh.says('OPEN', 'a'.repeat(40));
  assert.equal(accepted(A(d, ['pr-state', '7'], { env: gh.env }), 'pr-state').out, 'OPEN\n');
  gh.says('MERGED', 'a'.repeat(40));
  assert.equal(accepted(A(d, ['pr-state', '7'], { env: gh.env }), 'pr-state again').out, 'MERGED\n');
  assert.equal(accepted(A(d, ['pr-state', '7']), 'pr-state without a tool').out, 'unreadable\n');
});

test('batch-ci: one check of the CI run of the merge commit: green is recorded, red and running and no run and unreadable have their own status', () => {
  const gh = fakeGh();
  const d = project(`${DONE}; mkdir -p .github/workflows; printf 'on: pull_request\\n' > .github/workflows/ci.yml`);
  gOk(d, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  const bd = `${d}/.agents/local/batch`;
  refused(A(d, ['batch-ci', 'LC'], { env: gh.env }), 'batch-ci of a task that is not merged', 'is not merged');
  wf(`${bd}/merged.tsv`, `LC\t7\t${Math.floor(Date.now() / 1000)}\n`);
  const sha = 'b'.repeat(40);
  wf(`${gh.state}/gh.merge`, JSON.stringify({ mergeCommit: { oid: sha } }));
  const runs = (/** @type {unknown[]} */ list) => wf(`${gh.state}/gh.runs`, JSON.stringify(list));
  const ci = () => A(d, ['batch-ci', 'LC'], { env: gh.env });
  runs([{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: '' }]);
  let r = ci(); assert.equal(r.status, 1); assert.match(r.out, /^ci: RED \(run of bbbbbbb\)/);
  runs([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: '' }]);
  r = ci(); assert.equal(r.status, 2); assert.match(r.out, /^ci: still running \(run of bbbbbbb\): ask again in a minute, give up after 30 minutes/);
  runs([]);
  r = ci(); assert.equal(r.status, 4); assert.match(r.out, /^ci: no run for bbbbbbb yet/);
  wf(`${gh.state}/gh.runs`, 'not json');
  r = ci(); assert.equal(r.status, 3); assert.match(r.out, /^ci: cannot be read/);
  assert.ok(!existsSync(`${bd}/ci.tsv`), 'a non-green result was recorded');
  runs([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]);
  r = ci(); assert.equal(r.status, 0); assert.match(r.out, /^ci: green \(run of bbbbbbb\)/);
  assert.match(readFileSync(`${bd}/ci.tsv`, 'utf8'), new RegExp(`^LC\\t${sha}\\t[0-9]+$`, 'm'));
  wf(`${gh.state}/gh.merge`, '');
  r = ci(); assert.equal(r.status, 3); assert.match(r.out, /cannot read the merge commit of PR 7/);
  // not GitHub: recorded as not checked here
  gOk(d, 'remote', 'set-url', 'origin', 'https://bitbucket.org/acme/app.git');
  r = ci(); assert.equal(r.status, 0); assert.match(r.out, /^ci: not checked here/);
});

test('SECURITY: a platform tool starts with an allowlisted environment: config, host, repository and the other proxy and certificate variables of the caller never reach it (A215, A220)', () => {
  const dump = path.join(toolRoot, `envdump-${process.pid}`);
  const bin = path.join(toolRoot, `envbin-${process.pid}`, 'bin');
  mkdirSync(bin, { recursive: true });
  wf(`${bin}/gh`, `#!/bin/sh\nenv > "${dump}"\nexit 0\n`);
  chmodSync(`${bin}/gh`, 0o755);
  const hostile = {
    GH_CONFIG_DIR: '/evil/cfg', XDG_CONFIG_HOME: '/evil/xdg', HOME: '/evil/home', GH_HOST: 'evil.example', GH_REPO: 'evil/repo', GH_ENTERPRISE_TOKEN_X: 'x',
    GLAB_CONFIG_DIR: '/evil/glab', AZURE_CONFIG_DIR: '/evil/az', ALL_PROXY: 'http://evil:1', REQUESTS_CA_BUNDLE: '/evil/ca', GIT_SSL_CAINFO: '/evil/ca',
    SSL_CERT_DIR: '/evil/cadir', CURL_CA_BUNDLE: '/evil/ca', NODE_OPTIONS: '--require /evil.js', GH_PROMPT_DISABLED: '0', GH_API_URL: 'http://evil', GH_TOKEN: 'tok123', LANG: 'C.UTF-8',
  };
  const ctx = ctxOf(empty, { PATH: `${bin}:/usr/bin:/bin`, ...hostile });
  const info = detectPlatform(ctx, { url: 'https://github.com/acme/app.git', dir: empty });
  const t = resolveTool(ctx, 'gh');
  assert.ok('path' in t);
  runTool(ctx, info, /** @type {any} */ (t).path, ['pr', 'view', '7']);
  const seen = new Map(readFileSync(dump, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  for (const k of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'GH_HOST', 'GH_REPO', 'GLAB_CONFIG_DIR', 'AZURE_CONFIG_DIR', 'ALL_PROXY', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'NODE_OPTIONS', 'GH_PROMPT_DISABLED', 'GH_API_URL', 'GH_ENTERPRISE_TOKEN_X']) assert.ok(!seen.has(k), `${k} must not reach the tool`);
  assert.equal(seen.get('HOME'), userInfo().homedir, 'HOME comes from the account database');
  assert.equal(seen.get('GH_TOKEN'), 'tok123', 'a credential variable that cannot redirect traffic is kept');
  assert.equal(seen.get('LANG'), 'C.UTF-8');
  assert.ok((seen.get('PATH') ?? '').startsWith(bin));
  // the private-host variable of A186 is still set from git.platform_host of the config (A220), not from the caller
  const cp = mkdtempSync(path.join(tmpdir(), 'pf-envproj-'));
  gOk(cp, 'init', '-q', '-b', 'main');
  mkdirSync(`${cp}/.agents`);
  wf(`${cp}/.agents/config.yaml`, 'git:\n  platform: github\n  platform_host: git.corp.example\n');
  const priv = detectPlatform(ctxOf(cp, { PATH: `${bin}:/usr/bin:/bin` }), { url: 'https://git.corp.example/acme/app.git', dir: cp });
  assert.equal(priv.source, 'config');
  runTool(ctx, priv, /** @type {any} */ (t).path, ['pr', 'view', '7']);
  const again = readFileSync(dump, 'utf8');
  assert.ok(/^GH_HOST=git\.corp\.example$/m.test(again), again);
});

void [fakeTool, g, run, refused];
