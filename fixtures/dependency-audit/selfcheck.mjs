// Proves the planted facts of the dependency-audit fixture built in <dir> against the skill's own scripts
// (skills/exploit-proof/scripts/diff-manifests.mjs and validate-dependencies.mjs). Offline; runs no audit tool.
// usage: node selfcheck.mjs <built-dir>
import { devNull, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const SCRIPTS = path.join(repoRoot, 'skills/exploit-proof/scripts');
const root = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
process.chdir(root);
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
const git = (/** @type {string[]} */ ...a) => run('git', a, { cwd: root, env }).out.trim();

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'feature/dep-update') fail('HEAD is not feature/dep-update');
if (Number(git('rev-list', '--count', 'main..feature/dep-update')) !== 1) fail('dep-update must be one commit');
if (Number(git('rev-list', '--count', 'main..feature/dep-ok')) !== 1) fail('dep-ok must be one commit');
if (git('status', '--porcelain') !== '') fail('working tree not clean');

const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'dependency-audit-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const T = (/** @type {string} */ f) => path.join(tmp, f);
const load = (/** @type {string} */ f) => JSON.parse(readFileSync(T(f), 'utf8'));
const save = (/** @type {string} */ f, /** @type {any} */ d) => writeFileSync(T(f), JSON.stringify(d));
const script = (/** @type {string} */ name, /** @type {string[]} */ args) => run('node', [path.join(SCRIPTS, name), ...args], { cwd: root });
const validate = (/** @type {string[]} */ args) => script('validate-dependencies.mjs', args);
const lines = (/** @type {string} */ t) => t.split('\n');

/** What the agent adds: a detected audit tool that cannot run (no network) is recorded as tool_unavailable, never left silent. */
function recordAudit(/** @type {string} */ inF, /** @type {string} */ outF) {
  const d = load(inF);
  if (d.audit.status === 'not_run') d.audit = { status: 'tool_unavailable', command: d.audit_candidates[0].command, reason: 'selfcheck: no network' };
  save(outF, d);
}
/** The sorted list of blocking reasons:name, one line. */
const summary = (/** @type {string} */ f) => load(f).changes.filter((/** @type {any} */ c) => c.class === 'blocking').map((/** @type {any} */ c) => `${c.reasons.join('+')}:${c.name}`).sort().join(' ');
/** Run a diff-manifests step; its output passes through (the shell's did) and a non-zero exit stops the selfcheck as `set -e` did. */
function diff(/** @type {string[]} */ args) {
  const r = script('diff-manifests.mjs', args); process.stdout.write(r.out); process.stderr.write(r.err);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// --- feature/dep-update with the policy and the plan --------------------------------------------
diff(['--base', 'main', '--plan', '.agents/runs/DA-1/PLAN-fail.md', '--out', T('fail.raw.json')]);
recordAudit('fail.raw.json', 'fail.json');
const want = 'license_denied:copyleft-lib undeclared_dependency:evil-crate undeclared_dependency:evilcrate undeclared_dependency:evilnpm undeclared_dependency:evilpy undeclared_dependency:evilreq undeclared_dependency:markerpkg undeclared_dependency:nested undeclared_dependency:org.evil:lib undeclared_dependency:quick-json undeclared_index:index:pkgs.evil.example undeclared_install_script:scripts.postinstall';
if (summary('fail.json') !== want) fail(`blocking set differs: ${summary('fail.json')}`);
let v = validate([T('fail.json'), '--table']);
if (v.status !== 0) fail('validator rejected the document');
let out = lines(v.out);
if (!out.includes('RESULT: FAIL')) fail('expected RESULT: FAIL');
if (!out.includes('CONFIDENCE: medium')) fail('expected CONFIDENCE: medium (audit tool unavailable)');
if (out.filter((l) => l.includes('| blocking |')).length !== 12) fail('expected 12 blocking rows');
if (!v.out.includes('known vulnerabilities not checked')) fail('tool-unavailable is not stated');
// decoys: declared / flagged-but-declared / lockfile-only are notes, never blocking
{
  const d = load('fail.json');
  /** @param {string} file @param {string} name */
  const by = (file, name) => d.changes.find((/** @type {any} */ c) => c.file === file && c.name === name);
  const bad = (/** @type {string} */ m) => { console.error(m); return fail('decoy classification differs'); };
  /** @param {string} file @param {string} name */
  const note = (file, name) => { const c = by(file, name); if (!c || c.class !== 'note') bad(`not a note: ${file} ${name}`); return c; };
  note('package.json', 'uuid-lite');
  note('pyproject.toml', 'foo');          // extras in the name: "foo[bar]>=1.0" is read, and evilpy after it is not hidden
  note('Cargo.toml', 'unixcrate');        // target table form, declared
  note('build.gradle', 'org.acme:bom');   // platform(...) notation, declared
  const ren = by('Cargo.toml', 'evil-crate');            // renamed crate: the real name, alias kept
  if (!ren || ren.alias !== 'renamed' || !ren.flags.includes('alias')) bad('cargo rename not recorded under the real name');
  const al = by('package.json', 'evilnpm');               // npm alias
  if (!al || al.alias !== 'al' || !al.flags.includes('alias')) bad('npm alias not recorded under the real name');
  if (!by('deps/extra.pip', 'evilreq')) bad('include target with any file name not read');
  if (d.changes.some((/** @type {any} */ c) => c.name === 'index:pypi.org')) bad('the default index was reported');
  const mk = by('requirements.txt', 'markerpkg');        // env marker without a space is not part of the version
  if (!mk || mk.to[0] !== '>=1.0' || !mk.flags.includes('unpinned')) bad(`env marker handling: ${JSON.stringify(mk)}`);
  const ne = by('requirements.txt', 'nested');            // nested extras
  if (!ne || ne.to[0] !== '==2.0') bad(`nested extras: ${JSON.stringify(ne)}`);
  note('package.json', 'date-utils');
  if (!note('package.json', 'git-tool').flags.includes('git_url')) fail('decoy classification differs');
  if (!note('package.json', 'fmt-lite').flags.includes('unpinned')) fail('decoy classification differs');
  const ms = note('package-lock.json', 'ms'); if (ms.direct) fail('decoy classification differs');
  const ih = note('package-lock.json', 'inner-helper'); if (ih.direct || !ih.flags.includes('install_script')) fail('decoy classification differs');
}

// --- the same change without a license policy: not configured, never a PASS ------------------
diff(['--base', 'main', '--plan', '.agents/runs/DA-1/PLAN-fail.md', '--config', devNull, '--out', T('nopolicy.raw.json')]);
recordAudit('nopolicy.raw.json', 'nopolicy.json');
if (summary('nopolicy.json') !== 'undeclared_dependency:evil-crate undeclared_dependency:evilcrate undeclared_dependency:evilnpm undeclared_dependency:evilpy undeclared_dependency:evilreq undeclared_dependency:markerpkg undeclared_dependency:nested undeclared_dependency:org.evil:lib undeclared_dependency:quick-json undeclared_index:index:pkgs.evil.example undeclared_install_script:scripts.postinstall') fail('no-policy blocking set differs');
if (!validate([T('nopolicy.json'), '--table']).out.includes('license policy not configured')) fail('not-configured license check is not stated');

// --- an audit tool detected and not run is rejected (silence is not a result) ---------------
{
  const d = load('fail.json');
  if (d.audit_candidates.length === 0) d.audit_candidates.push({ tool: 'npm', command: 'npm audit --json', source: 'selfcheck' });
  d.audit = { status: 'not_run' }; save('silent.json', d);
}
if (validate([T('silent.json')]).status === 0) fail('a silent audit was accepted');

// --- a fresh run must reproduce the document (a hand-removed change is caught) -----------------
if (validate([T('fail.json'), '--repo', '.', '--base', 'main', '--plan', '.agents/runs/DA-1/PLAN-fail.md']).status !== 0) fail('re-derivation rejected the real document');
{ const d = load('fail.json'); d.changes = d.changes.filter((/** @type {any} */ c) => c.name !== 'quick-json'); save('edited.json', d); }
if (validate([T('edited.json'), '--repo', '.', '--base', 'main', '--plan', '.agents/runs/DA-1/PLAN-fail.md']).status === 0) fail('a document with a removed change was accepted');

// --- measured audit: output, exit code and vulnerabilities must agree ---------------------------
/** A document with the given audit and vulnerabilities, written to <file>. @param {string} file @param {object} auditObj @param {object[]} vulns */
function audit(file, auditObj, vulns) { const d = load('fail.json'); d.audit = auditObj; d.vulnerabilities = vulns; save(file, d); }
const OUT1 = 'found 1 vulnerabilities\\nquick-json  <1.4.2  GHSA-fake-0001-demo  high';   // the shell's literal "\n" is JSON-decoded to a newline
const vuln = [{ id: 'GHSA-fake-0001-demo', package: 'quick-json', severity: 'high', source: 'audit_tool_output' }];
// listed vulnerability with its id in the output: accepted, FAIL, never high (exit 1)
audit('vuln.json', JSON.parse(`{"status":"measured","command":"npm audit --json","exit_code":1,"output_excerpt":"${OUT1}"}`), vuln);
v = validate([T('vuln.json'), '--table']);
if (v.status !== 0) fail('measured vulnerability document rejected');
out = lines(v.out);
if (!out.includes('CONFIDENCE: medium')) fail('a non-zero audit exit must cap confidence at medium');
if (!v.out.includes('known vulnerability GHSA-fake-0001-demo in quick-json')) fail('vulnerability row missing');
// exit code 1 and an output that reports vulnerabilities, but none recorded: rejected
audit('mismatch.json', JSON.parse(`{"status":"measured","command":"npm audit --json","exit_code":1,"output_excerpt":"${OUT1}"}`), []);
if (validate([T('mismatch.json')]).status === 0) fail('empty vulnerabilities with a non-zero audit exit was accepted');
// a prefix of the id is not the id
audit('prefix.json', { status: 'measured', command: 'npm audit --json', exit_code: 1, output_excerpt: 'GHSA-fake-0001-demo-extra high' }, vuln);
if (validate([T('prefix.json')]).status === 0) fail('a partial id match was accepted');
// non-zero exit with an explained empty list: accepted, medium
audit('explained.json', { status: 'measured', command: 'npm audit --json', exit_code: 1, output_excerpt: 'npm ERR! audit endpoint returned an error', no_findings_reason: 'the tool failed to reach the registry; its output lists no advisories' }, []);
if (!lines(validate([T('explained.json')]).out).includes('CONFIDENCE: medium')) fail('explained empty list must be accepted at medium');

// --- feature/dep-ok: everything declared -> PASS ------------------------------------------------
git('checkout', '-q', 'feature/dep-ok');
diff(['--base', 'main', '--plan', '.agents/runs/DA-1/PLAN-ok.md', '--out', T('ok.raw.json')]);
recordAudit('ok.raw.json', 'ok.json');
if (summary('ok.json') !== '') fail('dep-ok has blocking changes');
v = validate([T('ok.json'), '--repo', '.', '--base', 'main', '--plan', '.agents/runs/DA-1/PLAN-ok.md']);
if (v.status !== 0) fail('validator rejected dep-ok');
if (!lines(v.out).includes('RESULT: PASS')) fail('expected RESULT: PASS on dep-ok');
// a clean measurement (exit 0, none found) on the clean change is the one path to confidence high
{ const d = load('ok.json'); d.audit = { status: 'measured', command: 'npm audit --json', exit_code: 0, output_excerpt: 'found 0 vulnerabilities' }; save('ok-measured.json', d); }
if (!lines(validate([T('ok-measured.json')]).out).includes('CONFIDENCE: high')) fail('a clean measured audit on dep-ok must be confidence high');
git('checkout', '-q', 'feature/dep-update');
console.log('selfcheck: dependency-audit facts ok');
