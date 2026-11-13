// @ts-check
// Stage 4, package 4C: `secret-scan` (the scanner moved into the core), `worker-evidence`, `raise-budget`, `waive`, `knowledge-done` and `run-language` as
// absolute Node tests (A214). They replace secret-scan-test.sh and the scenarios of gates-test.sh / lifecycle-test.sh named in tests/legacy-port-map.tsv; the
// shell scenarios that remain run against the Node commands as black-box tests through the fixture prologue.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posix } from '../lib/winpath.mjs';
import { test } from 'node:test';
import { BLOCKING_RULE_VERSION } from '../../control-plane/agents/scripts/core/gatewrite.mjs';
import { builtinScan } from '../../control-plane/agents/scripts/core/secretscan.mjs';
import { A, IMPLEMENTED, accepted, project, read, refused, existsSync, readdirSync } from './legacy-lib.mjs';

test('the blocking rule version of a gate record is the one GATES.md states (golden: recorded from agent.sh 0.0.47, "1")', () => {
  assert.equal(BLOCKING_RULE_VERSION, '1');
  const gates = readFileSync(new URL('../../control-plane/agents/GATES.md', import.meta.url), 'utf8');
  assert.equal(/^Blocking rule version: (.*)$/m.exec(gates)?.[1], BLOCKING_RULE_VERSION, 'GATES.md and the core state different blocking rule versions');
});

const ctx = /** @type {any} */ ({ childEnv: () => ({ ...process.env, LC_ALL: 'C' }) });
/** Fake secrets are assembled at run time so this repository never holds a realistic secret literal. */
const up = 'ABCDEFGHIJKLMNOP';
const al = 'q8Zr2Lm9Xc4Vb7Nk1Pw6Ty3Hs5Jd0FgE';

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const d = tempDir('ss4c-');
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), text); }
  return d;
}

test('the built-in scan finds each rule, reports path:line:rule, never prints a value and honours the allow marker', () => {
  const d = tree({
    'src/app.py': [
      `aws_key = '${'AKI'}${'A'}${up}'`, `gh = "${'ghp'}_${al}Ab12"`, `gl = "${'glp'}at-${al}"`, `slack = "${'xox'}b-1234567890-${al}"`,
      `${'-----BEGIN RSA PRIV'}${'ATE KEY-----'}`, `jwt = "eyJ${al}.eyJ${al}.${al}"`, `db_password = "Xk9${al}"`, `token = "Zz8${al}"   # proofline:allow-secret`,
    ].join('\n') + '\n',
  });
  try {
    const r = builtinScan(ctx, d, ['src/app.py']);
    assert.equal(r.status, 1);
    const lines = r.stdout.split('\n').filter(Boolean);
    for (const x of ['1:aws_access_key_id', '2:github_token', '3:gitlab_token', '4:slack_token', '5:private_key', '6:jwt', '7:generic_secret']) assert.ok(lines.includes(`src/app.py:${x}`), x);
    assert.ok(!lines.some((l) => l.startsWith('src/app.py:8:')), 'the allow marker is not honoured');
    assert.ok(!r.stdout.includes(al) && !r.stdout.includes('ABCDEFGH'), 'a secret value was printed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the built-in scan: decoys are clean, .env files and a directory are scanned, .git, templates, symbolic links and binary files are skipped, a missing path is an error', () => {
  const d = tree({
    'src/decoys.py': 'password = "changeme-changeme-changeme"\napi_key = "${API_KEY_FROM_ENV_VARIABLE}"\ntoken = "aaaaaaaaaaaaaaaaaaaa1"\ndescription = "a long harmless string value 12345"\naws = "AKIAEXAMPLE"\n',
    '.env': 'DB_HOST=localhost\n', '.env.example': 'DB_HOST=\n', '.git/config': `GH=${'ghp'}_${al}Ab12\n`,
    'bin.dat': Buffer.from(`\0 gh=${'ghp'}_${al}Ab12`, 'latin1').toString('latin1'),
  });
  try {
    symlinkSync('/etc/passwd', join(d, 'link'));
    let r = builtinScan(ctx, d, ['src/decoys.py']);
    assert.deepEqual([r.status, r.stdout], [0, ''], 'decoys were reported');
    r = builtinScan(ctx, d, ['.']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '.env:1:env_file\n', 'only the .env with a value is a finding');
    r = builtinScan(ctx, d, ['missing.txt']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no such path: missing\.txt/);
    assert.equal(builtinScan(ctx, `${d}/nope`, ['x']).status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the built-in scan: commands.secret_scan decides (0 clean, 1 found, anything else an error)', () => {
  const d = tree({ 'src/x.txt': 'LEAK\n', 'src/y.txt': 'fine\n', '.agents/config.yaml': 'commands:\n  secret_scan: ! grep -q LEAK  # project tool\n' });
  try {
    assert.equal(builtinScan(ctx, d, ['src/y.txt']).status, 0);
    assert.equal(builtinScan(ctx, d, ['src/x.txt']).status, 1);
    writeFileSync(join(d, 'tool.sh'), 'exit 3\n');
    writeFileSync(join(d, '.agents/config.yaml'), `commands:\n  secret_scan: sh ${posix(join(d, 'tool.sh'))}\n`);
    const r = builtinScan(ctx, d, ['src/x.txt']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /commands\.secret_scan failed \(exit 3\)/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const GATED = `scaffold orchestrated no COMPLEX; ${IMPLEMENTED}`;
const PLANTED = "scaffold orchestrated no COMPLEX; worker RED fail impl_test.txt 'test: lookup'; worker GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null";

test('secret-scan: a clean tree records a passing SECRETS gate, a planted secret a failing one with a row per finding, a scanner error records nothing', () => {
  const d = project(GATED);
  const r = accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
  assert.match(r.out, /^gate recorded: LC 001-SECRETS \(pass\)$/m);
  const g = read(d, '.agents/runs/LC/gates/001-SECRETS.yaml');
  assert.match(g, /gate: "SECRETS"\nresult: "pass"\nrole: "secret-scan"\nconfidence: "high"\nfocus: ""\n/);
  assert.match(g, /result: "pass"/);
  assert.match(g, /blocking_rule: "1"/);
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /event=gate:SECRETS:pass .* detail=gates\/001-SECRETS\.yaml@[0-9a-f]{64} by secret-scan$/m);

  const p = project(PLANTED);
  const f = accepted(A(p, ['secret-scan', 'LC']), 'secret-scan on a planted secret');
  assert.match(f.out, /^gate recorded: LC 001-SECRETS \(fail\)$/m);
  assert.match(f.out, /^ {2}SECRETS-1\|blocking\|impl\.txt:\d+\|secret pattern planted-secret\|secret-scan\.sh$/m);
  const pg = read(p, '.agents/runs/LC/gates/001-SECRETS.yaml');
  assert.match(pg, /result: "fail"/);
  assert.match(pg, /^fix_scope: impl\.txt$/m);
  assert.match(pg, /^finding: SECRETS-1\|blocking\|impl\.txt:\d+\|secret pattern planted-secret\|secret-scan\.sh$/m);

  const e = project(GATED);
  refused(A(e, ['secret-scan', 'LC'], { env: { STUB_SCAN_ERROR: '1' } }), 'a scanner error', /secret scan error \(exit 2\).*nothing recorded \(BLOCKED\)/);
  assert.ok(!existsSync(`${e}/.agents/runs/LC/gates/001-SECRETS.yaml`), 'a scanner error recorded a gate');
});

test('secret-scan: only the lead, only while IMPLEMENTED, not twice for a stale tree', () => {
  const d = project(GATED);
  refused(A(d, ['secret-scan', 'LC'], { role: 'implementer' }), 'the implementer', /denied|lead only/);
  refused(A(d, ['secret-scan', 'LC'], { role: 'reviewer' }), 'a reviewer', /denied|lead only/);
  writeFileSync(`${d}/impl.txt`, 'changed after IMPLEMENTED\n', { flag: 'a' });
  refused(A(d, ['secret-scan', 'LC']), 'a tree that changed since IMPLEMENTED', /application tree changed since IMPLEMENTED|stale|fingerprint|scope/);
  const n = project('scaffold orchestrated no COMPLEX');
  refused(A(n, ['secret-scan', 'LC']), 'a run that is not IMPLEMENTED', /only be recorded while handoff state is IMPLEMENTED|freeze|not frozen|stale/);
});

const WORK = 'scaffold orchestrated no COMPLEX; A handoff LC IMPLEMENTING >/dev/null';
const ev = (/** @type {string} */ cmd, /** @type {string} */ target, /** @type {string} */ extra = '') => `command: ${cmd}\ntarget: ${target}\n${extra}`;
const RED_WHY = 'expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet\n';

test('worker-evidence: the owner role records RED fail then GREEN pass; every other shape is refused with the shell texts', () => {
  const d = project(WORK);
  const w = (/** @type {string[]} */ a, /** @type {string} */ input, /** @type {string} */ role = 'implementer') => A(d, ['worker-evidence', 'LC', ...a], { input, role });
  refused(w(['RED', 'fail'], ev('go test', 'impl.txt', RED_WHY), 'lead'), 'the lead under orchestrated', 'command requires AGENT_ROLE=implementer for this run\'s execution topology (orchestrated)');
  refused(w(['BOGUS', 'fail'], ev('go test', 'impl.txt')), 'a phase', 'invalid worker-evidence phase: BOGUS');
  refused(w(['RED', 'maybe'], ev('go test', 'impl.txt')), 'a result', 'invalid worker-evidence result: maybe (want pass|fail)');
  refused(w(['RED', 'fail'], ev('', 'impl.txt', RED_WHY)), 'no command', 'worker evidence requires a non-empty command');
  refused(w(['RED', 'fail'], 'command: go test\n'), 'no target', 'worker evidence requires a non-empty target');
  refused(w(['RED', 'fail'], ev('go test', 'other.txt', RED_WHY)), 'a target outside the scope', 'worker evidence rejected: target outside frozen scope: other.txt');
  refused(w(['RED', 'pass'], ev('go test', 'impl.txt', RED_WHY)), 'RED pass', 'RED evidence must record result: fail');
  refused(w(['RED', 'fail'], ev('go test', 'impl.txt', 'expected_failure: not needed\n')), 'a stock expected_failure', 'RED evidence requires a specific, non-generic expected_failure');
  refused(w(['GREEN', 'pass'], ev('go test', 'impl.txt')), 'GREEN before RED', 'GREEN evidence rejected: no RED evidence for impl.txt yet');
  refused(w(['GREEN', 'fail'], ev('go test', 'impl.txt')), 'GREEN fail', 'GREEN evidence must record result: pass');
  const red = accepted(w(['RED', 'fail'], ev('go test ./...', 'impl.txt,impl_test.txt', RED_WHY)), 'RED');
  assert.equal(red.out, 'freeze verified: LC\nworker evidence recorded: LC RED-1 (fail)\n');
  const body = read(d, '.agents/runs/LC/worker-evidence/RED-1.yaml');
  assert.match(body, /^task_id: "LC"\nphase: "RED"\nresult: "fail"\nrole: "implementer"\ntopology: "orchestrated"\ncommand: go test \.\/\.\.\.\ntarget: impl\.txt,impl_test\.txt\nexpected_failure: TestImpl fails: lookup is not implemented in impl\.txt yet\nscope_snapshot: impl\.txt=[0-9a-f]{64};impl_test\.txt=[0-9a-f]{64};|scope_snapshot: impl\.txt=(missing|[0-9a-f]{64});/);
  assert.match(body, /base_sha: "[0-9a-f]{40}"/);
  refused(w(['GREEN', 'pass'], ev('go test', 'impl.txt,impl_test.txt')), 'GREEN with no implementation change since RED', 'no implementation file changed since the RED record');
  writeFileSync(`${d}/impl.txt`, 'impl: lookup returns the stored value\n', { flag: 'a' });
  accepted(w(['GREEN', 'pass'], ev('go test ./...', 'impl.txt,impl_test.txt')), 'GREEN');
  accepted(w(['REFACTOR', 'pass'], ev('go test ./...', 'impl.txt,impl_test.txt')), 'REFACTOR');
  assert.deepEqual(readdirSync(`${d}/.agents/runs/LC/worker-evidence`).filter((n) => /^(RED|GREEN|REFACTOR)-/.test(n)).sort(), ['GREEN-1.yaml', 'RED-1.yaml', 'REFACTOR-1.yaml']);
});

test('worker-evidence: only while IMPLEMENTING', () => {
  const d = project(GATED);
  refused(A(d, ['worker-evidence', 'LC', 'RED', 'fail'], { input: ev('go test', 'impl.txt', RED_WHY), role: 'implementer' }), 'after IMPLEMENTED', 'worker evidence may only be recorded while handoff state is IMPLEMENTING');
});

test('raise-budget: lead only, a larger number, covering the PLAN criteria, with the user\'s approval; the approval is consumed and the ledger names it', () => {
  const d = project('scaffold orchestrated no COMPLEX');
  refused(A(d, ['raise-budget', 'LC', '40'], { role: 'implementer' }), 'a non-lead', /denied|lead only/);
  refused(A(d, ['raise-budget', 'LC', 'abc']), 'a non-number', 'usage: agent.sh raise-budget <ID> <N>');
  refused(A(d, ['raise-budget', 'LC', '5']), 'not above the budget', /the mutation budget is already \d+; nothing to raise/);
  refused(A(d, ['raise-budget', 'LC', '40']), 'no approval', "raising the mutation budget needs the user's approval: 'agent.sh request-approval LC mutation_budget'");
});

test('waive: lead only, a specific reason, an open blocking finding, never SECRETS, and the user\'s approval naming the finding', () => {
  const d = project(PLANTED);
  accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
  refused(A(d, ['waive', 'LC', 'SECRETS-1', '--reason', 'accepted by the user for this run'], { role: 'implementer' }), 'a non-lead', /denied|lead only/);
  refused(A(d, ['waive', 'LC', 'SECRETS-1', '--reason', 'short']), 'a generic reason', 'waive requires a specific --reason (>=20 chars)');
  refused(A(d, ['waive', 'LC', 'SECRETS-1', '--bogus', 'x']), 'an unknown argument', 'unknown waive argument: --bogus');
  refused(A(d, ['waive', 'LC', 'SECRETS-1', '--reason', 'the user accepted this secret as a test value']), 'SECRETS', 'SECRETS findings are never waivable');
  refused(A(d, ['waive', 'LC', 'NOPE-1', '--reason', 'the user accepted this secret as a test value']), 'an unknown finding', 'no open blocking finding NOPE-1 on the current content of LC');
});

test('knowledge-done: lead only, a known state, CODE_DONE or a terminal run, a reason only for not_applicable', () => {
  const d = project(GATED);
  refused(A(d, ['knowledge-done', 'LC'], { role: 'implementer' }), 'a non-lead', /denied|lead only/);
  refused(A(d, ['knowledge-done', 'LC', 'BOGUS']), 'a state', 'invalid knowledge state: BOGUS');
  refused(A(d, ['knowledge-done', 'LC']), 'a run that is not CODE_DONE', 'knowledge-done requires CODE_DONE (or a FAILED/BLOCKED run) first');
});

test('run-language: the TASK.md Language line, the quoted user text, else en', () => {
  const d = project('scaffold standalone');
  assert.equal(A(d, ['run-language']).out, 'en\n');
  assert.equal(A(d, ['run-language', '-']).out, 'en\n');
  assert.equal(A(d, ['run-language', 'LC']).out, 'en\n');
  writeFileSync(`${d}/.agents/runs/LC/TASK.md`, 'Language: Turkish\n\n# Task: LC\n');
  assert.equal(A(d, ['run-language', 'LC']).out, 'tr\n');
  writeFileSync(`${d}/.agents/runs/LC/TASK.md`, 'language: en\n# Task: LC\n');
  assert.equal(A(d, ['run-language', 'LC']).out, 'en\n');
});

const SUMMARY = 'summary: ran the full verification command set on the whole tree\n';

test('gate (the compatibility form): the owner role only, one Verdict line that matches, a specific summary; the lead and SECRETS are refused', () => {
  const d = project(GATED);
  const g = (/** @type {string[]} */ a, /** @type {string} */ input, /** @type {string} */ role) => A(d, ['gate', 'LC', ...a], { input, role });
  refused(g(['VERIFY', 'pass'], SUMMARY, 'lead'), 'the lead', 'the lead can never record a gate verdict');
  refused(g(['SECRETS', 'pass'], SUMMARY, 'verifier'), 'SECRETS', "invalid gate: SECRETS (SECRETS is recorded by 'agent.sh secret-scan')");
  refused(g(['BOGUS', 'pass'], SUMMARY, 'verifier'), 'an unknown gate', 'invalid gate: BOGUS');
  refused(g(['VERIFY', 'maybe'], SUMMARY, 'verifier'), 'a result', 'invalid gate result: maybe (want pass|fail)');
  refused(g(['VERIFY', 'pass'], SUMMARY, 'qa'), 'another role', 'role qa may not record a VERIFY gate');
  refused(g(['VERIFY', 'pass', '/etc/passwd'], SUMMARY, 'verifier'), 'an absolute artifact', /artifact path must be run-relative|VERIFY gate may only|not a required gate/);
  refused(g(['VERIFY', 'pass'], SUMMARY, 'verifier'), 'the gates before it are missing or the report is', /requires the role's report VERIFY\.md|not a required gate|may only be recorded/);
});

const CODE_DONE = `scaffold orchestrated no COMPLEX; ${IMPLEMENTED}; pass_all; A handoff LC CODE_DONE >/dev/null`;

test('knowledge-done: not_applicable needs one specific sentence; a page is needed for KNOWLEDGE_DONE; the wiki lint report the step writes is a ledgered knowledge path', () => {
  const d = project(CODE_DONE);
  const k = (/** @type {string[]} */ ...a) => A(d, ['knowledge-done', 'LC', ...a]);
  refused(k('KNOWLEDGE_DONE', 'a reason'), 'a reason for KNOWLEDGE_DONE', 'a reason is only for not_applicable');
  refused(k('not_applicable', 'nope'), 'a stock reason', 'not_applicable needs a reason');
  refused(k('not_applicable', 'nothing durable changed "here" in this run at all'), 'a quote', 'must not contain a double quote, a backslash or a #');
  refused(k('not_applicable', 'nothing durable changed. Really nothing at all here'), 'two sentences', 'must be one sentence on one line');
  refused(k(), 'no page written', 'no knowledge page was written');
  // a page under the wiki, the lint installed: the step runs the lint itself and ledgers every knowledge file it owns, the lint report included
  mkdirSync(`${d}/docs/wiki`, { recursive: true });
  mkdirSync(`${d}/.agents/skills/llm-wiki/scripts`, { recursive: true });
  writeFileSync(`${d}/.agents/skills/llm-wiki/scripts/validate-wiki.mjs`, readFileSync(new URL('../../skills/llm-wiki/scripts/validate-wiki.mjs', import.meta.url)));
  writeFileSync(`${d}/docs/wiki/lookup.md`, '---\ntitle: lookup\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Lookup\n\nThe lookup returns the stored value.\n');
  const r = accepted(k(), 'knowledge-done with a page');
  assert.equal(r.out, 'knowledge state recorded: LC KNOWLEDGE_DONE\n');
  const ledger = read(d, '.agents/runs/LC/LEDGER.log');
  assert.match(ledger, /event=knowledge-done .* to=KNOWLEDGE_DONE /);
  const paths = /event=knowledge-paths .* detail=(.*)$/m.exec(ledger)?.[1] ?? '';
  assert.match(paths, /docs\/wiki\/lookup\.md@[0-9a-f]{64}/);
  assert.match(paths, /docs\/wiki\/lint-report\.md@[0-9a-f]{64}/, 'the lint report written by the step is not among the ledgered knowledge paths');
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /knowledge_state: "KNOWLEDGE_DONE"/);
});

test('knowledge-done: a secret in a knowledge file written after CODE_DONE is refused', () => {
  const d = project(CODE_DONE);
  mkdirSync(`${d}/docs/wiki`, { recursive: true });
  writeFileSync(`${d}/docs/wiki/leak.md`, `notes\nAKIA${'ABCDEFGHIJKLMNOP'}\nPLANTED_SECRET=abc\n`);
  refused(A(d, ['knowledge-done', 'LC']), 'a secret in the page', /secret scan of the knowledge-scope files written after CODE_DONE found secrets/);
});
