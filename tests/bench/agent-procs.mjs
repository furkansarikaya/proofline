// @ts-check
// Command benchmark of agent.sh (ADR 0001 inventory and section 8.3): for each command on its fixtures, the number of external processes (a PATH shim
// logs every common tool the command starts), the wall time, the exit code and the BYTES OF STDOUT. The stdout bytes are the basis of the output
// budgets: from the stage that moves a read-oriented command its output may not grow past the 0.0.40 size on the same fixture (8.3).
//
//   node tests/bench/agent-procs.mjs [--only cmd,cmd] [--fixture small,perf,scale-0,scale-20,scale-60] [--repeat N] [--engine sh|default]
//        [--out FILE] [--compare tests/bench/agent-procs-baseline-0.0.40.json] [--max-seconds N]
//   writes JSON to --out (default: print). --compare prints, per command, processes and stdout bytes against the baseline and exits 1 when a
//   moved command's stdout grew (stdout may shrink only if the rig shows the move is a pure rewrite; so growth is the failure).
// The baseline is committed as tests/bench/agent-procs-baseline-0.0.40.json (data file, measured on the 0.0.40 code, shell engine).
// Not run by CI's default job: measurements, like tests/bench/hook-procs.sh.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const scripts = join(repo, 'control-plane/agents/scripts');
const argv = process.argv.slice(2);
const opt = (/** @type {string} */ n, /** @type {string|undefined} */ d = undefined) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
// the small fixture is measured once per command (it is the 132-command sweep); the others REPEAT times
const REPEAT = Number(opt('repeat', '2')); const ENGINE = opt('engine', 'sh'); const MAX_S = Number(opt('max-seconds', '120'));
const only = opt('only')?.split(','); const fixtureNames = (opt('fixture', 'small,perf,scale-0,scale-20,scale-60') ?? '').split(',');

const ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1', TMPDIR: process.env.TMPDIR ?? tmpdir(),
};
const sh = (/** @type {string} */ script, /** @type {Record<string,string>} */ env = {}) => spawnSync('sh', ['-c', script, join(scripts, 'x.sh')], { env: { ...ENV, EQ_LIB: join(scripts, 'test-lib.sh'), ...env }, encoding: 'utf8', timeout: 900000 });

// ---- fixtures (all built with the self-test helpers; the frozen COMPLEX run of perf-test.sh is ported below) ----
const PERF = `
h() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi; }
scaffold orchestrated no COMPLEX
worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null
pf_n=0; for pf_g in $(required); do case "$pf_g" in SECRETS|VERIFY) continue ;; esac; pf_n=$((pf_n + 1)); [ "$pf_n" -le 3 ] || break; gpass "$pf_g"; done
pf_i=0; while [ "$pf_i" -lt 12 ]; do for pf_e in pretool posttool prompt stop session; do printf '1|%s|12|ok|\\n' "$pf_e" >> .agents/local/hook-times; done; A hook-time LC >/dev/null; pf_i=$((pf_i + 1)); done
pf_l=.agents/runs/LC/LEDGER.log; pf_last=$(tail -n 1 "$pf_l"); pf_seq=\${pf_last#seq=}; pf_seq=\${pf_seq%% *}; pf_dg=\${pf_last#* digest=}; pf_dg=\${pf_dg%% *}
pf_i=0; while [ "$pf_i" -lt 120 ]; do pf_prev=$(printf '%s' "$pf_last" | h); pf_seq=$((pf_seq + 1)); pf_last="seq=$pf_seq prev=$pf_prev event=note role=lead from=IMPLEMENTED to=IMPLEMENTED digest=$pf_dg ts=2026-01-01T00:00:00Z epoch=1 detail=perf fixture note $pf_i"; printf '%s\\n' "$pf_last" >> "$pf_l"; pf_i=$((pf_i + 1)); done
mkdir -p .agents/runs/LC/results; pf_i=0; while [ "$pf_i" -lt 30 ]; do printf 'ROLE: explorer\\nTASK: LC\\nRESULT: DONE\\n' > ".agents/runs/LC/results/9$(printf '%02d' "$pf_i")-explorer.result.md"; pf_i=$((pf_i + 1)); done
`;
const FIXTURES = /** @type {Record<string,string>} */ ({
  small: 'scaffold orchestrated no COMPLEX',
  perf: PERF,
  'scale-0': 'scaffold orchestrated no COMPLEX',
  'scale-20': 'scaffold orchestrated no COMPLEX; mkdir -p src; i=0; while [ "$i" -lt 20 ]; do printf "line %s\\n" "$i" > "src/f$i.txt"; i=$((i + 1)); done',
  'scale-60': 'scaffold orchestrated no COMPLEX; mkdir -p src; i=0; while [ "$i" -lt 60 ]; do printf "line %s\\n" "$i" > "src/f$i.txt"; i=$((i + 1)); done',
});
// the commands that read on every hook event or step and grow with the run: measured on the larger fixtures too
const PERF_COMMANDS = ['next', 'summary', 'digest', 'pipeline', 'status', 'effective', 'verify-gates', 'verify-seal', 'verify-handoff', 'verify-freeze', 'verify-scope', 'fingerprint', 'validate', 'questions', 'open-runs', 'report-facts', 'report-execution', 'human-checks', 'delivery-check', 'hook-config', 'config-get', 'role', 'tier', 'status-block', 'record', 'secret-scan', 'handoff', 'publish-completion-report'];
const SCALE_COMMANDS = ['fingerprint', 'baseline', 'summary', 'next', 'pipeline', 'digest', 'verify-scope', 'validate', 'secret-scan', 'status-block'];

export function buildFixture(/** @type {string} */ name) {
  const out = mkdtempSync(join(tmpdir(), `bench-${name}.`));
  const r = sh(`. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${FIXTURES[name]}\ncp -R "$PWD/." "$EQ_OUT/"`, { EQ_OUT: out });
  if (r.status !== 0) throw new Error(`fixture ${name} failed: ${r.stderr}${r.stdout}`);
  // an installed-like tree: the core beside agent.sh (test-lib fixtures hold only agent.sh, and without the core agent.sh runs the shell)
  if (existsSync(join(scripts, 'proofline-core.mjs'))) {
    cpSync(join(scripts, 'proofline-core.mjs'), join(out, '.agents/scripts/proofline-core.mjs'));
    cpSync(join(scripts, 'core'), join(out, '.agents/scripts/core'), { recursive: true });
  }
  return out;
}

// ---- the 132 commands with arguments that give each a meaningful run on the fixtures (an error exit is recorded as it is) ----
const ID = 'LC';
/** @type {Record<string, string>} */
const ARGS = {
  amend: ID, answer: `${ID} 1`, 'approval-consume': `${ID} push`, approve: `${ID} push`, 'approve-pending': ID, ask: `${ID}`, baseline: ID, 'batch-answer': '', 'batch-answers': '', 'batch-awake': '', 'batch-check': '', 'batch-ci': ID,
  'batch-cover': `${ID} plan`, 'batch-next': '', 'batch-park': `${ID} reason`, 'batch-plan': ID, 'batch-status': '', branch: ID, 'build-record': `${ID} show`, calibrate: '', 'ci-check': '', 'ci-task-command': '', classify: `${ID} COMPLEX`,
  cleanup: ID, 'commands-check': '', 'config-check': '', 'config-get': 'profile', 'db-check': ID, 'db-config': 'all', debt: '', decide: `${ID} reviewer --dry --focus rules`, 'deliver-merged': `${ID} --check`, 'deliver-plan': ID,
  'deliver-step': `${ID} commit`, 'delivery-check': ID, 'design-rationales': ID, 'design-surface': 'src/a.txt', digest: ID, 'discard-stray': `${ID} x.txt`, effective: ID, 'entry-tier': 'a contract bullet', fingerprint: ID, freeze: ID,
  freshness: ID, friction: 'show', 'friction-note': `${ID} proofline_bug`, gate: `${ID} QA pass`, handoff: `${ID} IMPLEMENTED`, help: '', 'hook-config': '', 'hook-time': ID, 'hook-timeouts': '', 'human-checks': ID, 'in-knowledge-scope': 'docs/a.md',
  'knowledge-done': `${ID} not_applicable reason`, 'known-issue-apply': '', 'known-issue-candidates': '', 'known-issue-list': '', 'known-issue-propose': `${ID} F1 --followup T`, 'language-check': '', 'ledger-note': `${ID} note`, lessons: 'count',
  'metrics-dispatch': `${ID} reviewer rules claude sonnet 1 1 1 2 1 0 DONE`, next: ID, 'next-user': '', 'open-runs': '', 'patch-fingerprint': ID, 'path-kind': 'src/a.txt docs/b.md', pipeline: ID, 'plan-section': `${ID} Architecture`,
  platform: '', 'platform-warn': '', 'pr-state': '1', 'publish-completion-report': `${ID} markdown`, questions: ID, 'raise-budget': `${ID} 5`, record: `${ID} --file missing.md`, refreeze: `${ID} 001.md`, reopen: ID,
  'report-execution': ID, 'report-facts': ID, 'report-tokens': ID, 'repro-normalize': '', 'request-approval': `${ID} push`, role: '', rules: 'list', 'run-language': '', 'scale-check': '', 'scope-covers': 'src/ src/a.txt',
  'scope-kinds': ID, 'secret-scan': ID, start: 'B1', status: '', 'status-block': ID, submit: `${ID} --result DONE --confidence high`, summary: ID, 'task-rename-apply': '', 'task-rename-plan': '', 'task-scope-entries': `tasks/LC.md Scope`,
  'task-source-done': ID, 'task-source-relocate': `${ID} tasks/other.md`, 'task-source-status': ID, 'task-type': `.agents/runs/${ID}/TASK.md`, terminate: `${ID} FAILED`, test: '', 'test-path': 'src/a_test.go src/a.go', tier: ID,
  timeouts: '', 'tm-scaled': '30', 'tree-accept': ID, 'tree-inspect': ID, validate: ID, 'verify-assumptions': ID, 'verify-completion-report': ID, 'verify-freeze': ID, 'verify-gates': ID, 'verify-handoff': ID, 'verify-knowledge-scope': ID,
  'verify-qa-plan': ID, 'verify-scope': ID, 'verify-seal': ID, 'verify-timeout': '', 'verify-worker-evidence': ID, 'wait-line': ID, waive: `${ID} F1 --reason r`, 'window-close': `${ID} 0 0`, 'window-open': ID,
  'worker-evidence': `${ID} RED fail`, 'worktree-add': ID, 'worktree-path': ID, 'worktree-remove': ID, 'worktree-root': '/nonexistent',
};
// `test` runs every suite (about an hour): measured by nobody here. Its stdout size is not an output budget.
const SKIP = new Set(['test']);
const SHIMMED = 'jq awk sed tr cat dirname basename date mkdir find git grep cut shasum sha256sum head tail wc mv rm cp sort mktemp node perl sleep kill ps ls readlink uname id touch chmod ln xargs expr rmdir stat uniq od tee comm diff du'.split(' ');

function makeShim() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-shim.')); const log = join(dir, 'procs.log'); writeFileSync(log, '');
  for (const c of SHIMMED) {
    const r = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim(); if (!r.startsWith('/')) continue;
    writeFileSync(join(dir, c), `#!/bin/sh\nprintf '%s\\n' '${c}' >> "$EQ_PROCS_LOG"\nexec ${r} "$@"\n`); chmodSync(join(dir, c), 0o755);
  }
  return { dir, log };
}

const median = (/** @type {number[]} */ a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
function measure(/** @type {string} */ fx, /** @type {string} */ cmd, /** @type {{ dir: string, log: string }} */ shim, /** @type {number} */ repeat) {
  const args = (ARGS[cmd] ?? '').split(' ').filter(Boolean); const procs = []; const times = []; let out = { code: /** @type {number|null} */ (0), bytes: 0, err: '' };
  for (let i = 0; i < repeat; i++) {
    const work = mkdtempSync(join(tmpdir(), 'bench-run.')); cpSync(fx, work, { recursive: true, verbatimSymlinks: true });
    writeFileSync(shim.log, '');
    const t0 = process.hrtime.bigint();
    const r = spawnSync('sh', ['./.agents/scripts/agent.sh', cmd, ...args], { cwd: work, env: { ...ENV, ...(ENGINE === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), PATH: `${shim.dir}:${ENV.PATH}`, EQ_PROCS_LOG: shim.log }, input: '', timeout: MAX_S * 1000, maxBuffer: 1 << 28 });
    const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
    procs.push(readFileSync(shim.log, 'utf8').split('\n').filter(Boolean).length); times.push(ms);
    out = { code: r.status, bytes: Buffer.byteLength(r.stdout ?? ''), err: String(r.stderr ?? '').split('\n')[0].slice(0, 160) };
    rmSync(work, { recursive: true, force: true });
    if (ms > 8000) break; // an expensive command is measured once or twice, not REPEAT times
  }
  return { args: args.join(' '), execs: median(procs), ms: median(times), stdout_bytes: out.bytes, exit: out.code, ...(out.code ? { stderr_first: out.err } : {}) };
}

function nodeStart() {
  const t = []; for (let i = 0; i < 10; i++) { const t0 = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); t.push(Number((process.hrtime.bigint() - t0) / 10000n) / 100); }
  return { node: process.version, platform: process.platform, arch: process.arch, median_ms: median(t) };
}

const commands = readFileSync(join(repo, 'tests/equivalence/commands.txt'), 'utf8').split('\n').filter(Boolean);
for (const c of commands) if (!(c in ARGS) && !SKIP.has(c)) throw new Error(`no benchmark arguments for ${c}`);
if (import.meta.url === `file://${process.argv[1]}`) {
  const shim = makeShim(); const result = { schema: 'proofline.agent-procs/1', engine: ENGINE, repeat: { small: Math.min(REPEAT, 1), others: REPEAT }, node_start: nodeStart(), fixtures: /** @type {Record<string, Record<string, any>>} */ ({}) };
  for (const name of fixtureNames) {
    const fx = buildFixture(name); const list = (name.startsWith('scale-') ? SCALE_COMMANDS : name === 'perf' ? PERF_COMMANDS : commands).filter((c) => !SKIP.has(c) && (!only || only.includes(c)));
    result.fixtures[name] = {};
    for (const c of list) { result.fixtures[name][c] = measure(fx, c, shim, name === 'small' ? Math.min(REPEAT, 1) : REPEAT); process.stderr.write(`${name} ${c} ${JSON.stringify(result.fixtures[name][c])}\n`); }
    rmSync(fx, { recursive: true, force: true });
  }
  rmSync(shim.dir, { recursive: true, force: true });
  const json = JSON.stringify(result, null, 1) + '\n';
  const out = opt('out'); if (out) writeFileSync(out, json); else process.stdout.write(json);
  const cmp = opt('compare');
  if (cmp && existsSync(cmp)) {
    const base = JSON.parse(readFileSync(cmp, 'utf8')); let grew = 0;
    for (const [fxn, cs] of Object.entries(result.fixtures)) for (const [c, m] of Object.entries(cs)) {
      const b = base.fixtures?.[fxn]?.[c]; if (!b) continue;
      const flag = m.stdout_bytes > b.stdout_bytes ? ' STDOUT GREW' : ''; if (flag) grew++;
      process.stderr.write(`${fxn} ${c}: execs ${b.execs} -> ${m.execs}, ms ${b.ms} -> ${m.ms}, stdout ${b.stdout_bytes} -> ${m.stdout_bytes}${flag}\n`);
    }
    if (grew) process.exitCode = 1;
  }
}
