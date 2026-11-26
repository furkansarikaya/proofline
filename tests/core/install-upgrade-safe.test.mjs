// @ts-check
// The safe upgrade path (A371, issue 338 item U6): `proofline upgrade` with runs, a batch and worktrees in flight. `--check` reports without writing; the real upgrade
// refuses while a specialist runs, a write window is open or a command holds the lock; it refuses a newer state format; it backs up what it replaces (the last 2 are
// kept), writes an `upgrade` ledger row per run, runs the cheap self-checks and lists the runs whose gate results came from the older core; `--rollback` restores.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { cfgv, sandbox, sig, upstream } from './frontend-lib.mjs';
import { join } from 'node:path';
import { Config } from '../../control-plane/agents/scripts/core/config.mjs';
import { agentsSrc } from '../lib/harness.mjs';

const sb = sandbox();
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const edit = (/** @type {string} */ f, /** @type {(t: string) => string} */ fn) => writeFileSync(f, fn(read(f)));
const put = (/** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(f.slice(0, f.lastIndexOf('/')), { recursive: true }); writeFileSync(f, t); };

/** An upstream release at VERSION, with one changed shipped file (so something is replaced) and one new config key. @param {string} v */
function release(v) {
  return upstream(sb.T, (h) => {
    edit(`${h}/control-plane/agents/scripts/core/proflinecli.mjs`, (t) => t.replace(/PROOFLINE_VERSION = '[^']*'/, `PROOFLINE_VERSION = '${v}'`));
    appendFileSync(`${h}/control-plane/agents/GATES.md`, `change in ${v}\n`);
    writeFileSync(`${h}/control-plane/agents/NEW-${v}.md`, `new in ${v}\n`);
    edit(`${h}/control-plane/agents/config.yaml`, (t) => t.replace(/^budgets:\n/m, 'budgets:\n  new_budget: 7\n').replace(/^ {2}COMPLEX:\n/m, '  COMPLEX:\n    zzz_new_key: 1\n'));
  });
}
const homes = /** @type {Record<string, string>} */ ({});
const rel = (/** @type {string} */ v) => (homes[v] ??= release(v));
const up = (/** @type {string} */ d, /** @type {string} */ v, /** @type {string[]} */ args = []) => sb.pl(d, ['upgrade', ...args], {}, `${rel(v)}/bin/proofline`);
/** A run folder of a project: RUN.yaml with the lifecycle ledger on, a first ledger row, and optionally gate records. @param {string} d @param {string} id @param {{ state?: string, gates?: boolean, ledger?: boolean, tree?: string }} [o] */
function mkRun(d, id, o = {}) {
  const dir = `${o.tree ?? d}/.agents/runs/${id}`;
  put(`${dir}/RUN.yaml`, `execution:\n  state: ${o.state ?? 'PLANNING'}\nhandoff:\n  state: IMPLEMENTING\nfreeze:\n  plan_sha256: PENDING\n${o.ledger === false ? '' : 'lifecycle_gates:\n  required: true\n'}`);
  if (o.ledger !== false) ledgerAppend(dir, 'lead', 'handoff', 'PLANNED', 'IMPLEMENTING', 'seed');
  if (o.gates) put(`${dir}/gates/VERIFY.yaml`, 'gate: VERIFY\nresult: PASS\n');
  return dir;
}
const ledgerRows = (/** @type {string} */ dir) => read(`${dir}/LEDGER.log`).split('\n').filter((l) => l !== '');
const backups = (/** @type {string} */ d) => { try { return readdirSync(`${d}/.agents/local/upgrade-backup`).sort(); } catch { return []; } };

test('--check writes nothing and reports the versions, the state format, the files and config keys, the open runs and what would refuse', () => {
  const d = sb.copy('chk');
  mkRun(d, 'LC', { state: 'IMPLEMENTING', gates: true });
  put(`${d}/.agents/local/batch/SUMMARY.md`, '# batch\n');
  put(`${d}/.agents/local/worktrees/W1/.agents/runs/WT/RUN.yaml`, 'execution:\n  state: PLANNING\n');
  const before = sig(d);
  const r = up(d, '0.0.901', ['--check']);
  assert.equal(r.status, 0, r.text);
  assert.equal(sig(d), before, '--check wrote files');
  assert.match(r.out, /upgrade --check: 0\.0\.\d+ -> 0\.0\.901/);
  assert.match(r.out, /state format: installed 1, this version 1 \(compatible\)/);
  assert.match(r.out, /updated   \.agents\/GATES\.md/);
  assert.match(r.out, /config keys that would be added: \d+: .*budgets\.new_budget.*pipelines\.COMPLEX\.zzz_new_key/);
  assert.match(r.out, /open runs: LC \(IMPLEMENTING\)/);
  assert.match(r.out, /batch: active; worktrees: W1/);
  assert.match(r.out, /gate results recorded by the installed core: LC/);
  assert.match(r.out, /nothing is running: the upgrade would go ahead/);
});

test('--check exits 1 and says what to wait for when a specialist runs', () => {
  const d = sb.copy('chk-busy');
  mkRun(d, 'LC');
  put(`${d}/.agents/local/submissions/tok1.run`, 'LC implementer\n');
  put(`${d}/.agents/local/submissions/tok1.started`, 'x\n1000\n');
  const r = up(d, '0.0.901', ['--check']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.text, /would be refused/);
  assert.match(r.text, /specialist running: implementer of run LC \(tok1\)/);
});

test('the real upgrade refuses while a specialist runs, a write window is open, or a command holds the lock; nothing is written', () => {
  const d = sb.copy('busy');
  mkRun(d, 'LC');
  const before = sig(d);
  put(`${d}/.agents/local/submissions/tok1.run`, 'LC implementer\n');
  put(`${d}/.agents/local/submissions/tok1.started`, 'x\n1000\n');
  let r = up(d, '0.0.901');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /upgrade refused/);
  assert.match(r.err, /specialist running: implementer of run LC \(tok1\)/);
  assert.match(r.err, /wait for/i);
  rmFiles(d, ['submissions/tok1.started', 'submissions/tok1.run']);
  put(`${d}/.agents/local/windows/tok2`, 'f'.repeat(64));
  put(`${d}/.agents/local/submissions/tok2.run`, 'LC implementer\n');
  r = up(d, '0.0.901');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /write window open: tok2 \(run LC\)/);
  rmFiles(d, ['windows/tok2', 'submissions/tok2.run']);
  // a specialist of a batch worktree counts too
  put(`${d}/.agents/local/worktrees/W1/.agents/local/submissions/tok3.started`, 'x\n1000\n');
  put(`${d}/.agents/local/worktrees/W1/.agents/local/submissions/tok3.run`, 'WT reviewer\n');
  r = up(d, '0.0.901');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /specialist running: reviewer of run WT \(tok3\)/);
  rmFiles(d, ['worktrees/W1/.agents/local/submissions/tok3.started', 'worktrees/W1/.agents/local/submissions/tok3.run']);
  // a lock held by a live process (this test's own pid is alive)
  put(`${d}/.agents/local/locks/shared.lock/pid`, `${process.pid}\n`);
  r = up(d, '0.0.901');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, new RegExp(`a control-plane command holds the lock \\(pid ${process.pid}\\): \\.agents/local/locks/shared\\.lock`));
  assert.equal(read(`${d}/.agents/GATES.md`).includes('change in 0.0.901'), false);
  assert.equal(backups(d).length, 0);
  rmFiles(d, ['locks/shared.lock/pid']);
  // a stale lock (its holder is gone) does not block
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  put(`${d}/.agents/local/locks/shared.lock/pid`, `${gone}\n`);
  r = up(d, '0.0.901');
  assert.equal(r.status, 0, r.text);
  assert.ok(read(`${d}/.agents/GATES.md`).includes('change in 0.0.901'));
  assert.equal(existsSync(`${d}/.agents/local/locks/shared.lock`), false, 'the lock is released');
  assert.notEqual(sig(d), before);
});
/** Remove files or empty lock folders under .agents/local of a project. @param {string} d @param {string[]} names */
function rmFiles(d, names) { for (const n of names) rmSync(`${d}/.agents/local/${n}`, { recursive: true, force: true }); }

test('parked runs and an open batch do not block; the backup holds the replaced files, the ledger gets one upgrade row per run, the output names the runs with older gate results and the next steps', () => {
  const d = sb.copy('ok');
  const run = mkRun(d, 'LC', { state: 'IMPLEMENTING', gates: true });
  const wt = mkRun(d, 'WT', { tree: `${d}/.agents/local/worktrees/W1`, state: 'PLANNING' });
  const noLedger = mkRun(d, 'NL', { ledger: false });
  put(`${d}/.agents/local/batch/SUMMARY.md`, '# batch\n');
  const oldGates = read(`${d}/.agents/GATES.md`);
  const from = /^# version: (.*)$/m.exec(read(`${d}/.agents/.proofline-manifest`))?.[1] ?? '';
  const last = ledgerRows(run).at(-1) ?? '';
  const r = up(d, '0.0.902');
  assert.equal(r.status, 0, r.text);
  const bdir = `${d}/.agents/local/upgrade-backup/${from}-to-0.0.902`;
  assert.equal(read(`${bdir}/files/.agents/GATES.md`), oldGates);
  assert.match(read(`${bdir}/UPGRADE.tsv`), /^replaced\t\.agents\/GATES\.md\t[0-9a-f]{64}\t[0-9a-f]{64}$/m);
  assert.match(read(`${bdir}/UPGRADE.tsv`), /^new\t\.agents\/NEW-0\.0\.902\.md\t[0-9a-f]{64}\t-$/m);
  const row = ledgerRows(run).at(-1) ?? '';
  assert.match(row, new RegExp(`^seq=2 prev=${sha(last)} event=upgrade role=user .* detail=old=${from.replace(/\./g, '\\.')} new=0\\.0\\.902 state_format=1$`));
  assert.match(ledgerRows(wt).at(-1) ?? '', / event=upgrade /);
  assert.equal(existsSync(`${noLedger}/LEDGER.log`), false, 'a run without a ledger gets none');
  assert.match(r.out, /backup: \.agents\/local\/upgrade-backup\/.*-to-0\.0\.902\/ \(\d+ files?; proofline upgrade --rollback restores them\)/);
  assert.match(r.out, /ledger: upgrade row written for 2 run\(s\)/);
  assert.match(r.out, new RegExp(`gate results of these runs were recorded by core ${from.replace(/\./g, '\\.')}: LC \\(informational: nothing is re-run; gates stay bound to the plan hash and the tree\\)`));
  assert.match(r.out, /next: parked runs resume with \/proofline resume/);
  assert.match(r.out, /self-check: config valid/);
  assert.match(r.out, /self-check: \d+ passed, \d+ FAIL, \d+ WARN/);
});

test('the last two backups are kept', () => {
  const d = sb.copy('keep2');
  for (const v of ['0.0.911', '0.0.912', '0.0.913']) { const r = up(d, v); assert.equal(r.status, 0, r.text); }
  const b = backups(d);
  assert.equal(b.length, 2, b.join(' '));
  assert.ok(b[0].endsWith('-to-0.0.912') && b[1].endsWith('-to-0.0.913'), b.join(' '));
});

test('a manifest with a newer state format is refused, with or without runs; the installed version newer than this one is refused while runs are open', () => {
  const d = sb.copy('newer');
  edit(`${d}/.agents/.proofline-manifest`, (t) => t.replace(/^# version:.*$/m, (m) => `${m}\n# state_format: 9`));
  let r = up(d, '0.0.901');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /state format 9 is newer than the 1 this version reads: this would be a downgrade/);
  assert.equal(read(`${d}/.agents/GATES.md`).includes('change in 0.0.901'), false);
  r = up(d, '0.0.901', ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.text, /state format: installed 9, this version 1/);
  const e = sb.copy('older');
  mkRun(e, 'LC');
  edit(`${e}/.agents/.proofline-manifest`, (t) => t.replace(/^# version:.*$/m, '# version: 0.0.999'));
  r = up(e, '0.0.901');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /installed version 0\.0\.999 is newer than 0\.0\.901/);
  // without open runs a version downgrade is allowed (as before)
  const f = sb.copy('older2');
  edit(`${f}/.agents/.proofline-manifest`, (t) => t.replace(/^# version:.*$/m, '# version: 0.0.999'));
  assert.equal(up(f, '0.0.901').status, 0);
});

test('the manifest records the state format; an installed version before the first format is refused only while runs are open', () => {
  const d = sb.copy('fmt');
  assert.equal(up(d, '0.0.921').status, 0);
  assert.match(read(`${d}/.agents/.proofline-manifest`), /^# state_format: 1$/m);
  const e = sb.copy('pre');
  mkRun(e, 'LC');
  edit(`${e}/.agents/.proofline-manifest`, (t) => t.replace(/^# version:.*$/m, '# version: 0.0.100').replace(/^# state_format:.*\n/m, ''));
  const r = up(e, '0.0.921');
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /before the state format table starts \(0\.0\.173\)/);
  const f = sb.copy('pre2');
  edit(`${f}/.agents/.proofline-manifest`, (t) => t.replace(/^# version:.*$/m, '# version: 0.0.100').replace(/^# state_format:.*\n/m, ''));
  assert.equal(up(f, '0.0.921').status, 0, 'no open run: nothing to read');
});

test('--rollback restores the replaced files and removes the new ones; it refuses when a run was started after the upgrade or no backup exists', () => {
  const d = sb.copy('rb');
  assert.match(up(d, '0.0.931', ['--rollback']).err, /no upgrade backup/);
  mkRun(d, 'LC');
  const oldGates = read(`${d}/.agents/GATES.md`);
  const oldManifest = read(`${d}/.agents/.proofline-manifest`);
  assert.equal(up(d, '0.0.931').status, 0);
  assert.ok(existsSync(`${d}/.agents/NEW-0.0.931.md`));
  mkRun(d, 'LATER');
  let r = up(d, '0.0.931', ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /run LATER was started after the upgrade/);
  assert.ok(existsSync(`${d}/.agents/NEW-0.0.931.md`), 'nothing changed');
  rmSync(`${d}/.agents/runs/LATER`, { recursive: true, force: true });
  appendFileSync(`${d}/.agents/ENGINEERING.md`, 'edited after the upgrade\n');   // not part of the upgrade: stays
  r = up(d, '0.0.931', ['--rollback']);
  assert.equal(r.status, 0, r.text);
  assert.equal(read(`${d}/.agents/GATES.md`), oldGates);
  assert.equal(read(`${d}/.agents/.proofline-manifest`), oldManifest);
  assert.equal(existsSync(`${d}/.agents/NEW-0.0.931.md`), false);
  assert.ok(read(`${d}/.agents/ENGINEERING.md`).includes('edited after the upgrade'));
  assert.match(ledgerRows(`${d}/.agents/runs/LC`).at(-1) ?? '', / event=upgrade .* rollback=yes$/);
  assert.match(up(d, '0.0.931', ['--rollback']).err, /already restored/);
});

test('--rollback keeps a file you changed after the upgrade and says so', () => {
  const d = sb.copy('rb2');
  assert.equal(up(d, '0.0.932').status, 0);
  appendFileSync(`${d}/.agents/GATES.md`, 'my note\n');
  const r = up(d, '0.0.932', ['--rollback']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /kept \(changed since the upgrade\): \.agents\/GATES\.md/);
  assert.ok(read(`${d}/.agents/GATES.md`).includes('my note'));
});

test('--rollback and --check do not combine; --dry-run keeps its output', () => {
  const d = sb.copy('args');
  assert.match(up(d, '0.0.901', ['--rollback', '--check']).err, /upgrade: --rollback cannot be combined with --check or --dry-run/);
  const r = up(d, '0.0.901', ['--dry-run']);
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('proofline upgrade (dry run, nothing written):'));
  assert.equal(backups(d).length, 0);
});

test('with local_state: off the upgrade takes no lock and makes no backup (nothing is written under .agents/local)', () => {
  const d = sb.copy('off');
  edit(`${d}/.agents/config.yaml`, (t) => t.replace(/^local_state: on$/m, 'local_state: off'));
  const r = up(d, '0.0.941');
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /backup: none \(local_state is off/);
  assert.equal(existsSync(`${d}/.agents/local/upgrade-backup`), false);
  assert.equal(existsSync(`${d}/.agents/local/locks`), false);
});

test("an upgrade from the 0.0.173 config adds every missing key at any depth, keeps the project's own values and is idempotent (A371)", () => {
  const d = sb.copy('deep');
  const cf = `${d}/.agents/config.yaml`;
  writeFileSync(cf, read(new URL('../fixtures/upgrade/config-v0.0.173.cfg', import.meta.url).pathname)
    .replace(/^ {2}max_fix_rounds:.*$/m, '  max_fix_rounds: 1').replace(/^ {2}worker:.*$/m, '  worker: claude'));
  const own = { 'review.max_fix_rounds': '1', 'runtime.worker': 'claude', 'test_trust.mutation_budget': cfgv(d, 'test_trust.mutation_budget') };
  const r = sb.pl(d, ['upgrade']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /config keys added: \d+: .*pipelines\.COMPLEX\.max_fix_rounds/);
  const shipped = Config.load(join(agentsSrc, 'config.yaml'));
  for (const k of ['pipelines.COMPLEX.max_fix_rounds', 'pipelines.COMPLEX.mutation_budget', 'pipelines.CRITICAL.max_fix_rounds', 'profiles.light.types', 'profiles.light.content_globs',
    'test_trust.review_rounds', 'test_trust.review_minutes', 'execution_policy.repeat_model_cap.claude', 'output_cap_bytes']) assert.equal(cfgv(d, k), shipped.get(k, ''), k);
  assert.equal(cfgv(d, 'pipelines.COMPLEX.max_fix_rounds'), '3');
  for (const [k, v] of Object.entries(own)) assert.equal(cfgv(d, k), v, `${k} is the project's own value`);
  assert.equal(spawnSync('sh', ['.agents/scripts/agent.sh', 'config-check'], { cwd: d, env: sb.env, encoding: 'utf8' }).status, 0, 'config-check passes');
  const once = read(cf);
  const r2 = sb.pl(d, ['upgrade']);
  assert.equal(r2.status, 0, r2.text);
  assert.equal(read(cf), once, 'a second upgrade changes nothing in the config');
  assert.doesNotMatch(r2.out, /config keys added/);
});
