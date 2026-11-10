// @ts-check
// `proofline doctor` (A232, the former bin/lib/doctor.sh and the doctor scenarios of tests/cli/cli-test.sh): a fresh install, the hook wiring, the ecosystem definition,
// the version and tool lines, the CI line, the toolchain line and the foreign context sources. Absolute expectations on the printed lines and the exit status; the project is
// made by the real `proofline init` with fake claude and codex binaries.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { sandbox, verdicts } from './frontend-lib.mjs';

const sb = sandbox();
const edit = (/** @type {string} */ file, /** @type {(t: string) => string} */ fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));

test('a fresh install passes: every check line, the 7 events of both runtimes, the probes, and a summary that counts the WARN lines', () => {
  const d = sb.copy('d1');
  const r = sb.pl(d, ['doctor']);
  assert.equal(r.status, 0, r.text);
  const lines = verdicts(r.out);
  assert.equal(lines.filter((l) => l.startsWith('FAIL ')).length, 0, r.out);
  const has = (/** @type {string|RegExp} */ x) => assert.ok(typeof x === 'string' ? r.out.includes(x) : x.test(r.out), `missing ${x}\n${r.out}`);
  has(/^PASS installed: proofline [0-9.]+ in .* \(runtimes: claude codex, profile economy\)$/m);
  has(/^PASS node: v[0-9.]+ \(Node 22\.13 or newer is a runtime requirement\)$/m);
  has('PASS engine: the commands run in Node\n');
  has('PASS manifest: every installed file matches\n');
  has('PASS git hooks: core.hooksPath = .agents/githooks, pre-commit and pre-push executable\n');
  has('PASS config: config valid: .agents/config.yaml\n');
  has(/^PASS approval path: [0-9]+ ms \(hook budget 20000 ms\)$/m);
  has('PASS time limits: timeouts.scale 1.0, a dispatched step may take up to 7200 s (CRITICAL); the approval budget is never scaled. This machine\'s speed: proofline doctor --scale\n');
  has('PASS ecosystems: .agents/ecosystems.json is a valid definition\n');
  has('PASS runtime claude: 9.9.9 (Claude Code, fake) (');
  has('PASS runtime codex: codex-cli 9.9.9 (fake) (');
  has('PASS hooks: .agents/hooks/proofline-hook.mjs present\n');
  has('PASS claude hooks: .claude/settings.json wires all 7 proofline events\n');
  has('PASS codex hooks: .codex/hooks.json wires all 7 proofline events\n');
  has('WARN codex trust: Codex loads project hooks only once the project is trusted');
  has(/^PASS context loaded without being asked \(estimated tokens = bytes \/ 4\):\n {6}AGENTS\.md proofline block +[0-9]+ bytes/m);
  has(/^PASS version: plugin and project install are both [0-9.]+$/m);
  has(/^PASS tools: ast-grep /m);
  has('PASS identity: commits use Dev <dev@example.test> from repository-local config; no git.forbidden_identities match\n');
  has('PASS probe: pre-commit blocks a forbidden identity (names git.forbidden_identities)\n');
  has('PASS probe: pre-commit lets other identities commit\n');
  has('PASS probe: pre-push blocks a protected branch and allows others\n');
  has('PASS probe: pre-push blocks a push without approval\n');
  has('PASS probe: a push without a terminal or agent markers passes as a human; one with agent markers is blocked\n');
  has('PASS probe: the Claude PreToolUse hook denies a lead edit of product code during a run\n');
  has('PASS probe: the Codex PreToolUse hook denies a lead shell write during a run\n');
  has('PASS probe: without an active run the PreToolUse hook denies a lead product edit and lets a task file through\n');
  for (const nope of ['forbidden-zz', 'WARN commands', 'WARN foreign hook', 'WARN overlapping', 'WARN load', 'WARN ci:']) assert.ok(!r.out.includes(nope), `unexpected ${nope}`);
  // the platform line of a repository without an origin, and the summary counts exactly the WARN lines
  has('WARN platform: the project has no origin remote yet');
  const warns = lines.filter((l) => l.startsWith('WARN ')).length;
  assert.equal(warns, 2);
  assert.equal(r.out.trimEnd().split('\n').slice(-2).join('\n'), `doctor: 0 FAIL, ${warns} WARN\nNext step: /proofline task --grill`);
});

test('a settings file without the Stop event is a FAIL for each runtime, naming Stop, with a non-zero exit', async () => {
  const run = async (/** @type {string} */ rt) => {
    const d = sb.copy(`dstop-${rt}`);
    const file = rt === 'claude' ? `${d}/.claude/settings.json` : `${d}/.codex/hooks.json`;
    const j = JSON.parse(readFileSync(file, 'utf8')); delete j.hooks.Stop; writeFileSync(file, JSON.stringify(j));
    return sb.plAsync(d, ['doctor']);
  };
  const [c, x] = await Promise.all([run('claude'), run('codex')]);
  for (const [rt, r] of /** @type {const} */ ([['claude', c], ['codex', x]])) {
    assert.ok(r.out.includes(`FAIL ${rt} hooks: `), r.out);
    assert.ok(r.out.includes('lacks proofline hooks for: Stop (run: proofline init)'), r.out);
    assert.notEqual(r.status, 0, `${rt} Stop`);
  }
  assert.ok(c.out.includes('FAIL claude hooks: .claude/settings.json lacks proofline hooks for: Stop (run: proofline init)\n'));
  assert.ok(x.out.includes('FAIL codex hooks: .codex/hooks.json lacks proofline hooks for: Stop (run: proofline init)\n'));
});

test('a missing hook file is a FAIL; a missing events/ folder is a FAIL naming the folders; empty commands and an older install are WARN lines with the next step', async () => {
  const dmj = sb.copy('dmj'); rmSync(`${dmj}/.agents/hooks/proofline-hook.mjs`);
  const dev = sb.copy('dev'); rmSync(`${dev}/.agents/hooks/events`, { recursive: true });
  const dz = sb.copy('dz');
  edit(`${dz}/.agents/config.yaml`, (t) => t.replace(/^ {2}build:.*$/m, '  build:').replace(/^ {2}lint:.*$/m, '  lint:').replace(/^proofline_version:.*$/m, 'proofline_version: 0.0.1'));
  mkdirSync(`${sb.T}/rtkbin`, { recursive: true }); writeFileSync(`${sb.T}/rtkbin/rtk`, '#!/bin/sh\nexit 0\n'); chmodSync(`${sb.T}/rtkbin/rtk`, 0o755);
  const [a, b, c] = await Promise.all([sb.plAsync(dmj, ['doctor']), sb.plAsync(dev, ['doctor']), sb.plAsync(dz, ['doctor'], { PATH: `${sb.T}/rtkbin:${sb.env.PATH}` })]);
  assert.ok(a.out.includes('FAIL hooks: .agents/hooks/proofline-hook.mjs missing (run: proofline upgrade)\n'), a.out);
  assert.notEqual(a.status, 0);
  assert.ok(b.out.includes('FAIL hooks: .agents/hooks/ lacks events/, guards/, lib/ or command-scan.mjs of the Node hook (run: proofline upgrade)\n'), b.out);
  assert.ok(c.out.includes('WARN commands: empty in .agents/config.yaml: build lint (the verify gate has nothing to run for them and no build record can be made). Fix: proofline doctor --commands finds the commands, proves each by one run and asks you once (A200)\n'), c.out);
  assert.match(c.out, /^WARN version: plugin [0-9.]+, project install 0\.0\.1; the project is older\. Next step: \/proofline upgrade$/m);
  assert.match(c.out, /^PASS tools: ast-grep .*; rtk installed \(.*\/rtkbin\/rtk\); evidence commands run with RTK_DISABLED=1 \(rtk configuration docs\)$/m);
  assert.equal(c.status, 0, 'WARN lines never fail the run');
  edit(`${dz}/.agents/config.yaml`, (t) => t.replace(/^proofline_version:.*$/m, 'proofline_version: 99.0.0'));
  const n = sb.pl(dz, ['doctor']);
  assert.match(n.out, /^WARN version: plugin [0-9.]+, project install 99\.0\.0; the project is newer than the plugin\. Next step: update the plugin$/m);
});

test('the ecosystem definition: a missing, invalid or unreadable .agents/ecosystems.json is a FAIL with a non-zero exit; the shell reader and the tsv are not needed (A245)', async () => {
  const miss = sb.copy('dec'); rmSync(`${miss}/.agents/ecosystems.json`);
  const bad = sb.copy('dec2'); writeFileSync(`${bad}/.agents/ecosystems.json`, '{"global":{},"ecosystems":[]}\n');
  const nomjs = sb.copy('dec3'); rmSync(`${nomjs}/.agents/ecosystems.mjs`);
  const [a, b, c] = await Promise.all([sb.plAsync(miss, ['doctor']), sb.plAsync(bad, ['doctor']), sb.plAsync(nomjs, ['doctor'])]);
  assert.ok(a.out.includes('FAIL ecosystems: .agents/ecosystems.json is missing or empty, so the risky-path and dependency sets are empty (run: proofline upgrade)\n'), a.out);
  assert.notEqual(a.status, 0);
  assert.match(b.out, /^FAIL ecosystems: .* \(run: proofline upgrade\)$/m);
  assert.notEqual(b.status, 0);
  assert.ok(c.out.includes('FAIL ecosystems: .agents/ecosystems.mjs is missing, so the definition cannot be read (run: proofline upgrade)\n'), c.out);
  assert.notEqual(c.status, 0);
});

test('the CI line: a GitHub project without a pull_request workflow warns with the exact fix line, with one it passes', () => {
  const d = sb.copy('dci');
  spawnSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://github.com/acme/app.git'], { env: sb.env });
  const r = sb.pl(d, ['doctor']);
  assert.ok(r.out.includes('WARN ci: no CI check runs on pull requests here. proofline merge verifies the commit locally instead'), r.out);
  const fix = spawnSync('sh', [`${d}/.agents/scripts/agent.sh`, 'ci-task-command'], { cwd: d, env: { ...sb.env, PROOFLINE_CI_BUILD: 'npm run build', PROOFLINE_CI_TEST: 'npm test' }, encoding: 'utf8' });
  assert.ok(r.out.includes(`Fix: ${fix.stdout.trimEnd()}`), `${fix.stdout}\n${r.out}`);
  assert.ok(r.out.includes('Fix: /proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: tsc; test: jest (the workflow must trigger on pull_request)\n') || /Fix: \/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: .*; test: .* \(the workflow must trigger on pull_request\)/.test(r.out), r.out);
  mkdirSync(`${d}/.github/workflows`, { recursive: true });
  writeFileSync(`${d}/.github/workflows/ci.yml`, 'on:\n  pull_request:\njobs: {}\n');
  const ok = sb.pl(d, ['doctor']);
  assert.ok(ok.out.includes('PASS ci: present (.github/workflows/ci.yml)\n'), ok.out);
  assert.ok(!ok.out.includes('WARN ci:'));
});

test('the toolchain line: a different Node major is a WARN that keeps the exit 0; the same major passes; a project without a runtime marker prints nothing', async () => {
  const dtc = sb.copy('dtc'); mkdirSync(`${dtc}/.github/workflows`, { recursive: true });
  writeFileSync(`${dtc}/.github/workflows/ci.yml`, 'on:\n  pull_request:\njobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n');
  const fakenode = (/** @type {string} */ v) => { const f = `${sb.T}/fakenode-${v}`; mkdirSync(f, { recursive: true }); writeFileSync(`${f}/node`, `#!/bin/sh\ncase "\${1:-}" in --version) echo v${v} ;; *) exec "${process.execPath}" "$@" ;; esac\n`); chmodSync(`${f}/node`, 0o755); return `${f}:${sb.env.PATH}`; };
  const dnr = sb.copy('dnr'); rmSync(`${dnr}/package.json`);
  const [mis, same, none] = await Promise.all([sb.plAsync(dtc, ['doctor'], { PATH: fakenode('22.1.0') }), sb.plAsync(dtc, ['doctor'], { PATH: fakenode('20.5.0') }), sb.plAsync(dnr, ['doctor'])]);
  assert.ok(mis.out.includes('WARN toolchain node: local 22.1.0, CI specifies 20 (.github/workflows/ci.yml); the major version differs, so a green local run may not hold in CI\n'), mis.out);
  assert.ok(mis.out.includes('WARN node: v22.1.0 is older than 22.13;'), 'the fake node is also older than the requirement');
  assert.equal(mis.status, 0, 'a toolchain mismatch is a WARN');
  assert.ok(same.out.includes('PASS toolchain node: local 20.5.0 matches CI 20 (.github/workflows/ci.yml)\n'), same.out);
  assert.ok(!same.out.includes('WARN toolchain'));
  assert.ok(none.out.includes('toolchain') === false, none.out);
  assert.match(sb.pl(sb.copy('dtn'), ['doctor']).out, /^(PASS|WARN) toolchain node: /m);
});

test('foreign context hooks and overlapping skills are WARN lines with the exit 0; ecosystem skills and other events are left alone', () => {
  const d = sb.copy('dfor');
  mkdirSync(`${sb.T}/home/.claude/skills/test-driven-dev`, { recursive: true }); mkdirSync(`${sb.T}/home/.claude/skills/rust-lint`, { recursive: true });
  writeFileSync(`${sb.T}/home/.claude/settings.json`, '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo foreign-ctx"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"echo not-listed"}]}]}}\n');
  mkdirSync(`${sb.T}/home/.claude/plugins/cache/mk/pl/1.0/hooks`, { recursive: true });
  writeFileSync(`${sb.T}/home/.claude/plugins/cache/mk/pl/1.0/hooks/hooks.json`, `{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"${'x'.repeat(100)}"},{"command":"node ~/.x/proofline-hook.mjs"}]}]}}`);
  try {
    const r = sb.pl(d, ['doctor']);
    assert.equal(r.status, 0, r.text);
    assert.ok(r.out.includes('WARN foreign hook: SessionStart in .claude/settings.json may add context to the prompt: echo foreign-ctx\n'), r.out);
    assert.ok(r.out.includes(`WARN foreign hook: UserPromptSubmit in .claude/plugins/cache/mk/pl/1.0/hooks/hooks.json may add context to the prompt: ${'x'.repeat(80)}\n`), 'the command is cut at 80 characters, and proofline\'s own hook is not listed');
    assert.ok(r.out.includes(`WARN overlapping skill: test-driven-dev (${sb.T}/home/.claude) overlaps a proofline method skill; during a run proofline's own skill is used\n`), r.out);
    for (const nope of ['rust-lint', 'not-listed', 'proofline-hook.mjs may']) assert.ok(!r.out.includes(nope), nope);
    assert.ok(r.out.includes('\ndoctor: 0 FAIL, 5 WARN\n'), 'the summary counts the foreign lines');
  } finally { rmSync(`${sb.T}/home/.claude`, { recursive: true, force: true }); }
});
