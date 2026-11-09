// @ts-check
// Run one proofline scenario in a disposable, isolated playground copy (the Node form of the former run.sh, 176-C2). It drives real agents (claude, codex)
// and is never part of CI; the dry run is what the self-tests use.
//   node tests/e2e/run.mjs <TRIVIAL|STANDARD|STANDARD.tr|COMPLEX|CRITICAL|FAILOVER> <claude|codex|mixed> [--dry-run] [--keep]
// Environment: E2E_ROOT, E2E_PROFILE, E2E_LEAD_MODEL, E2E_CODEX_MODEL, E2E_CODEX_EFFORT, E2E_MAX_TURNS, E2E_MAX_REPLIES, E2E_TIMEOUT, E2E_PROBE_NODE.
// Exit codes: 2 wrong call or a refused model, 127 a runtime CLI is missing, 130 interrupted.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pendingKind, questionOpen, replyDecision } from './lib.mjs';

const here = import.meta.dirname;
const repo = path.resolve(here, '../..');
const SCENARIOS = ['TRIVIAL', 'STANDARD', 'STANDARD.tr', 'COMPLEX', 'CRITICAL', 'FAILOVER'];
/** `${NAME:-def}`: an unset or empty variable gives the default. @param {string} name @param {string} def */
const env = (name, def) => (process.env[name] ? /** @type {string} */ (process.env[name]) : def);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (/** @type {number} */ ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const sha256 = (/** @type {string | Buffer} */ x) => createHash('sha256').update(x).digest('hex');
const bytes = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/** The harness; resolves with the exit status. @param {string[]} argv */
export async function main(argv) {
  const usage = () => { console.error('usage: node tests/e2e/run.mjs <TRIVIAL|STANDARD|STANDARD.tr|COMPLEX|CRITICAL|FAILOVER> <claude|codex|mixed> [--dry-run] [--keep]'); return 2; };
  if (argv.length < 2) return usage();
  const scenario = /** @type {string} */ (argv[0]); const config = /** @type {string} */ (argv[1]);
  if (!SCENARIOS.includes(scenario)) return usage();
  /** @type {Record<string, { lead: string, worker: string, reviewers: string, runtimes: string }>} */
  const configs = {
    claude: { lead: 'claude', worker: 'claude', reviewers: 'claude', runtimes: 'claude' },
    codex: { lead: 'codex', worker: 'codex', reviewers: 'codex', runtimes: 'codex' },
    mixed: { lead: 'claude', worker: 'codex', reviewers: 'claude', runtimes: 'claude,codex' },
  };
  const cfg = configs[config];
  if (!cfg) return usage();
  if (scenario === 'FAILOVER' && config !== 'mixed') { console.error('FAILOVER requires mixed'); return 2; }
  let dry = false; let keep = false;
  for (const a of argv.slice(2)) { if (a === '--dry-run') dry = true; else if (a === '--keep') keep = true; else return usage(); }
  let lead = cfg.lead;
  const task = scenario === 'FAILOVER' ? 'STANDARD' : scenario;
  // Reference profile (D5): balanced with an Opus lead for COMPLEX, CRITICAL and FAILOVER; economy with a Sonnet lead for the rest. E2E_PROFILE / E2E_LEAD_MODEL override.
  const heavy = ['COMPLEX', 'CRITICAL', 'FAILOVER'].includes(scenario);
  const profile = env('E2E_PROFILE', heavy ? 'balanced' : 'economy'); const leadModel = env('E2E_LEAD_MODEL', heavy ? 'opus' : 'sonnet');
  const replyFile = path.join(here, 'replies', `${scenario}.txt`);
  // A131: a scenario may carry its own question reply; else line 1 of the generic file.
  let qreplyFile = path.join(here, 'replies', `question.${scenario}.txt`); if (!existsSync(qreplyFile)) qreplyFile = replyFile;
  if (!(existsSync(path.join(here, 'tasks', `${task}.md`)) && existsSync(replyFile))) { console.error('task or reply file missing'); return 2; }
  const rootDir = env('E2E_ROOT', path.join(process.env.TMPDIR || '/tmp', 'proofline-e2e'));
  mkdirSync(rootDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let run = path.join(rootDir, `${scenario}-${config}-${stamp}`);
  if (existsSync(run)) run = `${run}-${process.pid}`;
  const project = path.join(run, 'project'); const out = path.join(run, 'out');
  mkdirSync(project, { recursive: true }); mkdirSync(out, { recursive: true }); mkdirSync(path.join(run, 'codexhome', '.codex'), { recursive: true });

  // A117: whatever the exit status, stop a lead still running and remove the project copy and the isolated Codex home; out/ stays, and so does the whole run directory with --keep.
  /** @type {number | null} */ let leadPid = null;
  const cleanup = () => {
    if (leadPid !== null) {
      const pid = leadPid;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
      // Bounded wait for the lead to exit, then KILL, so rm never races a live process.
      for (let i = 0; i < 50; i++) {
        const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        if (ps === '' || ps.startsWith('Z')) break;
        sleepSync(100);
      }
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
    if (!keep) { rmSync(project, { recursive: true, force: true }); rmSync(path.join(run, 'codexhome'), { recursive: true, force: true }); }
  };
  process.on('exit', cleanup);
  for (const s of /** @type {const} */ (['SIGHUP', 'SIGINT', 'SIGTERM'])) process.on(s, () => process.exit(130));

  const w = (/** @type {string} */ name, /** @type {string} */ text) => writeFileSync(path.join(out, name), text);
  const ap = (/** @type {string} */ name, /** @type {string} */ text) => appendFileSync(path.join(out, name), text);
  /** Run a command with stdout and stderr to a file (or stdout only). @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnSyncOptions} o @param {string} file @param {boolean} [both] */
  const toFile = (cmd, args, o, file, both = true) => {
    const fd = openSync(file, 'a');
    try { return spawnSync(cmd, args, { ...o, stdio: ['ignore', fd, both ? fd : 'ignore'] }); } finally { closeSync(fd); }
  };
  const capture = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {import('node:child_process').SpawnSyncOptions} */ o = {}) => spawnSync(cmd, args, { ...o, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const agent = (/** @type {string[]} */ args) => (capture('sh', ['.agents/scripts/agent.sh', ...args], { cwd: project }).stdout ?? '');

  // C-18 evidence: the user's global git config, recorded (never written) before and after the run.
  const globalGit = (/** @type {string} */ file) => {
    const home = process.env.HOME || '/nonexistent';
    const lines = [];
    for (const f of [path.join(home, '.gitconfig'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git/config')]) {
      lines.push(existsSync(f) && statSync(f).isFile() ? `file=${f} sha256=${sha256(readFileSync(f))}` : `file=${f} absent`);
    }
    const list = (capture('git', ['config', '--global', '--list']).stdout ?? '').replace(/\n+$/, '');
    lines.push(list !== '' ? `list_sha256=${sha256(`${list}\n`)}` : 'list=absent');
    w(file, `${lines.join('\n')}\n`);
  };
  globalGit('git-global-before.txt');
  cpSync(path.join(repo, 'playground'), project, { recursive: true });
  // Write identity only into this throwaway repository's own config. Git plumbing avoids hooks.
  const git = (/** @type {string[]} */ args, /** @type {import('node:child_process').SpawnSyncOptions} */ o = {}) => capture('git', ['-C', project, ...args], o);
  git(['init', '-q', '-b', 'main']);
  appendFileSync(path.join(project, '.git/config'), '\n[user]\n\tname = E2E Runner\n\temail = e2e@example.invalid\n');
  const prepare = path.join(out, 'prepare.txt'); writeFileSync(prepare, '');
  for (const f of ['src/migrate.js', 'src/seed.js']) {
    const r = toFile(process.execPath, [f], { cwd: project }, prepare);
    if (r.status !== 0) return r.status ?? 1;
  }
  const baseline = (/** @type {string} */ message) => {
    git(['add', '-A']);
    const tree = (git(['write-tree']).stdout ?? '').trim();
    const parent = (git(['rev-parse', '-q', '--verify', 'HEAD']).stdout ?? '').trim();
    const ident = { GIT_AUTHOR_NAME: 'E2E Runner', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'E2E Runner', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' };
    const sha = (spawnSync('git', ['-C', project, 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: `${message}\n`, encoding: 'utf8', env: { ...process.env, ...ident } }).stdout ?? '').trim();
    git(['update-ref', 'refs/heads/main', sha]);
  };
  baseline('chore: baseline');
  const proofline = path.join(repo, 'bin/proofline');
  const install = path.join(out, 'install.txt'); writeFileSync(install, '');
  const ir = toFile(proofline, ['init', '--yes', '--runtimes', cfg.runtimes, '--lead', cfg.lead, '--worker', cfg.worker, '--reviewers', cfg.reviewers, '--profile', profile, '--task-adapter', 'markdown'], { cwd: project }, install);
  if (ir.status !== 0) return ir.status ?? 1;
  baseline('chore: install proofline');
  const doctor = path.join(out, 'doctor.txt'); writeFileSync(doctor, '');
  toFile(proofline, ['doctor'], { cwd: project }, doctor);

  // A121: read-only database probe (db-probe.mjs probes a copy of the file bytes); `no database` when there is none. A failed probe leaves `probe failed: <reason>`.
  const onPath = (/** @type {string} */ cmd) => {
    const ok = (/** @type {string} */ f) => { try { return statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0; } catch { return false; } };
    return cmd.includes('/') ? ok(cmd) : (process.env.PATH ?? '').split(path.delimiter).some((d) => d && ok(path.join(d, cmd)));
  };
  const dbProbe = (/** @type {string} */ name) => {
    const pnode = env('E2E_PROBE_NODE', 'node'); const file = path.join(out, name);
    if (!onPath(pnode)) { writeFileSync(file, `probe failed: ${pnode} not found\n`); return; }
    writeFileSync(file, '');
    const r = toFile(pnode, ['--no-warnings', path.join(here, 'db-probe.mjs'), project], {}, file);
    if ((r.status ?? 1) !== 0) writeFileSync(file, `probe failed: exit ${r.status ?? 1}\n${readFileSync(file, 'utf8')}`);
    if (statSync(file).size === 0) writeFileSync(file, 'no database\n');
  };
  /** db-probe-diff.txt and the db_unchanged= line (yes|no|unknown), from before vs after. */
  const dbVerdict = () => {
    const a = path.join(out, 'db-probe-before.txt'); const b = path.join(out, 'db-probe.txt'); const d = path.join(out, 'db-probe-diff.txt');
    const diff = () => { const r = spawnSync('diff', [a, b], { encoding: 'utf8' }); return { same: r.status === 0, text: (r.stdout ?? '') + (r.stderr ?? '') }; };
    if (/^probe failed:/m.test(readFileSync(a, 'utf8')) || /^probe failed:/m.test(readFileSync(b, 'utf8'))) {
      writeFileSync(d, diff().text);
      if (statSync(d).size === 0) writeFileSync(d, 'probe failed: no verdict\n');
      return 'db_unchanged=unknown\n';
    }
    const r = diff();
    if (r.same) { writeFileSync(d, 'no difference\n'); return 'db_unchanged=yes\n'; }
    writeFileSync(d, r.text); return 'db_unchanged=no\n';
  };
  dbProbe('db-probe-before.txt');
  const home = process.env.HOME ?? '';
  if (existsSync(path.join(home, '.codex/auth.json'))) { try { spawnSync('ln', ['-s', path.join(home, '.codex/auth.json'), path.join(run, 'codexhome/.codex/auth.json')]); } catch { /* none */ } }
  writeFileSync(path.join(run, 'codexhome/.codex/config.toml'), `[projects."${project}"]\ntrust_level = "trusted"\n`);
  process.env.PROOFLINE_CODEX_HOME_DIR = path.join(run, 'codexhome');
  // The Codex lead runs with HOME=<run>/codexhome; a Claude specialist it dispatches (failover, mixed teams) must get the operator's own HOME back.
  process.env.PROOFLINE_REAL_HOME = home;
  // Cheapest Codex lead (A100): both empty keeps the runtime default; -m and -c work on exec and exec resume.
  let cxM = process.env.E2E_CODEX_MODEL ?? ''; const cxE = process.env.E2E_CODEX_EFFORT ?? ''; let codexCheap = '';
  // A135: a Codex lead needs the base model; E2E_CODEX_MODEL feeds both the first exec and every resume.
  if (lead === 'codex' || scenario === 'FAILOVER') {
    const ep = path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs'); const pol = path.join(repo, 'control-plane/agents/config.yaml');
    // Never the runtime default: -m is always passed, on the first exec, every resume and the FAILOVER resume.
    if (cxM === '') {
      const r = spawnSync(process.execPath, [ep, 'cli', 'exec-policy', '--config', pol, 'lead-base', 'codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      if (r.status !== 0) return 2;
      cxM = (r.stdout ?? '').replace(/\n+$/, '');
    }
    const c = spawnSync(process.execPath, [ep, 'cli', 'exec-policy', '--config', pol, 'check-lead', '--runtime', 'codex', '--model', cxM], { stdio: 'inherit' });
    if (c.status !== 0) return 2;
  }
  if (cxM !== '') codexCheap = ` -m '${cxM}'`;
  if (cxE !== '') codexCheap += ` -c 'model_reasoning_effort="${cxE}"'`;
  const request = readFileSync(path.join(here, 'tasks', `${task}.md`), 'utf8');
  const maxTurns = env('E2E_MAX_TURNS', '250');
  const line = (/** @type {string} */ f, /** @type {number} */ n) => (readFileSync(f, 'utf8').split('\n')[n - 1] ?? '');
  if (dry) {
    const say = (/** @type {string} */ s) => console.log(s);
    say(`run_dir=${run}`); say(`project=${project}`); say(`scenario=${scenario} config=${config} task=${task}`); say('prepared=baseline,install,doctor,codex-isolation');
    say(`setup: cp -R '${repo}/playground/.' '${project}/'; git init -q -b main; node src/migrate.js; node src/seed.js; baseline 'chore: baseline'; '${repo}/bin/proofline' init --yes --runtimes '${cfg.runtimes}' --lead '${cfg.lead}' --worker '${cfg.worker}' --reviewers '${cfg.reviewers}' --profile ${profile} --task-adapter markdown; baseline 'chore: install proofline'; '${repo}/bin/proofline' doctor`);
    if (lead === 'claude') say(`lead: (cd '${project}' && claude -p '<whole ${task} task file>' --setting-sources project,local --permission-mode bypassPermissions --model '${leadModel}' --output-format stream-json --verbose --max-turns '${maxTurns}') > '${out}/lead-1.jsonl' 2> '${out}/lead-1.err'`);
    else {
      say(`lead: HOME='${run}/codexhome' CODEX_HOME='${run}/codexhome/.codex' codex exec${codexCheap} --dangerously-bypass-hook-trust -C '${project}' -s danger-full-access -c 'approval_policy="never"' --json -o '${out}/lead-1.last.txt' '<whole ${task} task file>' > '${out}/lead-1.jsonl'`);
      say(`lead resume: codex exec resume${codexCheap} -c 'sandbox_mode="danger-full-access"' -c 'approval_policy="never"' <thread> <reply>`);
    }
    if (scenario === 'FAILOVER') say('failover: poll implementer ledger every 10s; terminate Claude process group; resume under Codex with proofline resume');
    say(`replies: up to ${env('E2E_MAX_REPLIES', '6')} lines from '${replyFile}' (question reply from '${qreplyFile}') when a plan or question stop is pending`);
    say('collect: git log/status/diff/branches, runs, metrics, agent status/next/pipeline, final messages, durations, exit codes, database probe');
    say('collect (A95): git-global-before/after.txt, replies-log.txt, agent-pipeline.txt, insights.txt, metrics/*, visual-artifacts.txt');
    say(`doctor=${out}/doctor.txt`);
    // The dry run records the global config twice and creates placeholders for the collected files, so the layout is testable.
    globalGit('git-global-after.txt');
    for (const f of ['agent-pipeline.txt', 'insights.txt', 'visual-artifacts.txt', 'replies-log.txt']) w(f, 'not collected (dry run)\n');
    mkdirSync(path.join(out, 'metrics'), { recursive: true }); w('metrics/note.txt', 'not collected (dry run)\n');
    dbProbe('db-probe.txt'); w('summary.txt', dbVerdict());
    return 0;
  }
  if (lead === 'claude') { if (!onPath('claude')) { console.error('claude unavailable'); return 127; } } else if (!onPath('codex')) { console.error('codex unavailable'); return 127; }
  if (scenario === 'FAILOVER' && !onPath('codex')) { console.error('codex unavailable'); return 127; }

  let session = ''; let thread = ''; let timedOut = false; let killed = false;
  /** One lead call in its own process group (a new session lets the failover watchdog stop the lead and all its children). @param {string} runtime @param {number} number @param {string} message @param {boolean} resumed */
  const runLead = async (runtime, number, message, resumed) => {
    const started = Math.floor(Date.now() / 1000);
    const jsonl = openSync(path.join(out, `lead-${number}.jsonl`), 'w'); const err = openSync(path.join(out, `lead-${number}.err`), 'w');
    /** @type {string[]} */ let args; let cwd = process.cwd(); /** @type {NodeJS.ProcessEnv} */ let cenv = process.env; let cmd;
    if (runtime === 'claude') {
      cmd = 'claude'; cwd = project; cenv = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' };
      args = ['-p', message, ...(resumed ? ['--resume', session] : []), '--setting-sources', 'project,local', '--permission-mode', 'bypassPermissions', '--model', leadModel, '--output-format', 'stream-json', '--verbose', '--max-turns', maxTurns];
    } else {
      cmd = 'codex'; cenv = { ...process.env, HOME: path.join(run, 'codexhome'), CODEX_HOME: path.join(run, 'codexhome/.codex') };
      const m = [...(cxM ? ['-m', cxM] : []), ...(cxE ? ['-c', `model_reasoning_effort="${cxE}"`] : [])];
      const last = path.join(out, `lead-${number}.last.txt`);
      args = resumed ? ['exec', 'resume', ...m, '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '--json', '-o', last, thread, message]
        : ['exec', ...m, '--dangerously-bypass-hook-trust', '-C', project, '-s', 'danger-full-access', '-c', 'approval_policy="never"', '--json', '-o', last, message];
    }
    const child = spawn(cmd, args, { cwd, env: cenv, detached: true, stdio: ['ignore', jsonl, err] });
    closeSync(jsonl); closeSync(err);
    leadPid = child.pid ?? null;
    /** @type {number} */ let rc = 0; let exited = false;
    const done = new Promise((resolve) => {
      child.on('error', () => { rc = 127; exited = true; resolve(null); });
      child.on('close', (code, sig) => { rc = code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1); exited = true; resolve(null); });
    });
    let elapsed = 0; timedOut = false; killed = false;
    const killGroup = () => { try { process.kill(-(/** @type {number} */ (child.pid)), 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } };
    while (!exited) {
      if (scenario === 'FAILOVER' && runtime === 'claude' && elapsed > 0 && elapsed % 10 === 0) {
        // the implementer step has started: the ledger of any run has a freeze and then an implementer window, decision or dispatch note
        let frozen = false; let found = false;
        const runsDir = path.join(project, '.agents/runs');
        const ledgers = existsSync(runsDir) ? readdirSync(runsDir).sort(bytes).map((d) => path.join(runsDir, d, 'LEDGER.log')).filter((f) => existsSync(f)) : [];
        for (const f of ledgers) for (const l of readFileSync(f, 'utf8').split('\n')) {
          if (l.includes('event=freeze ')) frozen = true;
          if (frozen && /event=window-open.*implementer|event=decide.*implementer|event=note.*dispatch.*implementer/.test(l)) found = true;
        }
        if (found) { w('failover.txt', `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n`); killed = true; killGroup(); break; }
      }
      if (elapsed >= Number(env('E2E_TIMEOUT', '5400'))) { timedOut = true; killGroup(); break; }
      await Promise.race([done, sleep(1000).then(() => { elapsed++; })]);
    }
    await done;
    leadPid = null;
    ap('summary.txt', `lead_${number}_runtime=${runtime}\nlead_${number}_exit=${rc}\nlead_${number}_duration=${Math.floor(Date.now() / 1000) - started}\nlead_${number}_timeout=${timedOut ? 'yes' : 'no'}\nlead_${number}_killed=${killed ? 'yes' : 'no'}\n`);
    const events = readFileSync(path.join(out, `lead-${number}.jsonl`), 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    if (runtime === 'claude') {
      let id = ''; let last = '';
      for (const e of events) { if (!id && e.type === 'system' && e.subtype === 'init') id = e.session_id || ''; if (e.type === 'result') last = e.result || ''; }
      writeFileSync(path.join(out, `lead-${number}.final.txt`), last);
      writeFileSync(path.join(out, `lead-${number}.session`), id ? `${id}\n` : '');
      session = id;
    } else {
      let id = '';
      for (const e of events) id ||= e.thread_id || e.threadId || e.session_id || '';
      writeFileSync(path.join(out, `lead-${number}.session`), id ? `${id}\n` : '');
      thread = id;
      const lastTxt = path.join(out, `lead-${number}.last.txt`);
      writeFileSync(path.join(out, `lead-${number}.final.txt`), existsSync(lastTxt) ? readFileSync(lastTxt) : '');
    }
  };
  await runLead(lead, 1, request, false);
  let number = 1;
  if (scenario === 'FAILOVER' && killed) { number = 2; await runLead('codex', number, 'proofline resume', false); }
  const max = Number(env('E2E_MAX_REPLIES', '6')); let replies = 0; let planReplies = 0; let questionReplies = 0; let stopped = ''; let stopState = '';
  w('replies-log.txt', '');
  const stateLines = (/** @type {string} */ s) => s.split('\n').filter((l) => /^(next|reason)=/.test(l)).map((l) => `${l} `).join('');
  for (;;) {
    let id = agent(['status']).split('\n').find((l) => l.startsWith('active_task='))?.slice('active_task='.length) ?? '';
    if (id === '' || id === 'none') id = 'none';
    const state = agent(['next', id]).replace(/\n+$/, '');
    if (/state=(DONE|FAILED|TERMINATED)|run DONE|terminated/i.test(state)) break;
    const pending = agent(['questions', id]).replace(/\n+$/, '');
    const lastFile = path.join(out, `lead-${number}.final.txt`);
    // Which approval is the run waiting for? `agent.sh next` names it. A plan approval is answered every time it is asked (a refreeze asks again); a destructive, single_step,
    // scope, budget, commit, push or waive request is never answered by the harness. Any other stop of the lead (a question) gets the scripted question reply.
    const kind = pendingKind(state, path.join(project, `.agents/runs/${id}/approvals`));
    const qline = line(qreplyFile, 1); const pline = line(replyFile, 2);
    const decision = replyDecision(kind, `${state}\n${pending}\n${existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : ''}`);
    let reply;
    if (decision === 'plan') reply = pline;
    else if (decision === 'stop') break;
    else {
      // A120: no open question, no reply (the lead waits for something a reply cannot give).
      if (!questionOpen(state, lastFile, id)) { stopped = 'no-open-question'; stopState = stateLines(state); break; }
      reply = qline;
    }
    if (reply === '') break;
    // The cap is a safety stop, reported when it (and not the run) ends the loop.
    if (replies >= max) { stopped = 'max-replies'; stopState = stateLines(state); break; }
    replies++; ap('replies.txt', `${reply}\n`);
    // plan = an approval (the user's reply is the approval); question = a scripted question reply.
    let rkind = 'question';
    if (kind === 'plan') { rkind = 'plan-approval'; planReplies++; } else questionReplies++;
    const request1 = state.split('\n').find((l) => l.startsWith('next='))?.slice('next='.length) ?? '';
    ap('replies-log.txt', `reply=${replies} kind=${rkind} task=${id} request=${request1} | ${reply}\n`);
    number++;
    if (scenario === 'FAILOVER') lead = 'codex';
    await runLead(lead, number, reply, true);
    if (timedOut) break;
  }
  ap('summary.txt', `scenario=${scenario}\nconfig=${config}\nrun_dir=${run}\nreplies=${replies}\nplan_approval_replies=${planReplies}\nquestion_replies=${questionReplies}\n`);
  if (stopped !== '') ap('summary.txt', `stopped=${stopped}\nstopped_state=${stopState}\n`);
  const gitOut = (/** @type {string} */ name, /** @type {string[]} */ args) => { const fd = openSync(path.join(out, name), 'w'); try { spawnSync('git', ['-C', project, ...args], { stdio: ['ignore', fd, 'inherit'] }); } finally { closeSync(fd); } };
  gitOut('git-log.txt', ['log', '--oneline', '--all']);
  gitOut('git-status.txt', ['status', '--short']);
  gitOut('git-diff-main-head.patch', ['diff', 'main...HEAD']);
  gitOut('git-diff-working.patch', ['diff']);
  gitOut('git-diff-staged.patch', ['diff', '--cached']);
  gitOut('git-branches.txt', ['branch', '--list']);
  gitOut('git-untracked.txt', ['ls-files', '--others', '--exclude-standard']);
  if (existsSync(path.join(project, '.agents/runs'))) cpSync(path.join(project, '.agents/runs'), path.join(out, 'runs'), { recursive: true }); else w('runs-note.txt', 'runs cleaned\n');
  if (existsSync(path.join(project, '.agents/local/metrics'))) cpSync(path.join(project, '.agents/local/metrics'), path.join(out, 'metrics'), { recursive: true }); else w('metrics-note.txt', 'metrics absent\n');
  const agentTo = (/** @type {string} */ name, /** @type {string[]} */ args) => toFile('sh', ['.agents/scripts/agent.sh', ...args], { cwd: project }, path.join(out, name));
  agentTo('agent-status.txt', ['status']);
  const id = (readFileSync(path.join(out, 'agent-status.txt'), 'utf8').split('\n').find((l) => l.startsWith('active_task=')) ?? '').slice('active_task='.length);
  if (id !== '' && id !== 'none') { agentTo('agent-next.txt', ['next', id]); agentTo('agent-pipeline.txt', ['pipeline', id]); }
  if (!existsSync(path.join(out, 'agent-pipeline.txt'))) w('agent-pipeline.txt', 'no active task id: pipeline not collected\n');
  // N-6: insights is read-only; the hash of .agents is taken around the call and recorded.
  /** @param {string} dir @param {string} base @returns {string[]} */
  const filesUnder = (dir, base) => {
    if (!existsSync(dir)) return [];
    /** @type {string[]} */ const acc = [];
    for (const n of readdirSync(dir)) { const p = path.join(dir, n); const st = lstatSync(p); if (st.isDirectory()) acc.push(...filesUnder(p, `${base}/${n}`)); else if (st.isFile()) acc.push(`${base}/${n}`); }
    return acc;
  };
  const hashed = (/** @type {string[]} */ rels) => rels.sort(bytes).map((f) => `${sha256(readFileSync(path.join(project, f)))} ${f}\n`).join('');
  const agentsHash = () => sha256(hashed(filesUnder(path.join(project, '.agents'), '.agents')));
  const beforeIns = agentsHash();
  const insights = path.join(out, 'insights.txt'); writeFileSync(insights, '');
  const insRc = toFile(proofline, ['insights'], { cwd: project }, insights).status ?? 1;
  const afterIns = agentsHash();
  ap('summary.txt', `insights_exit=${insRc}\nagents_hash_before_insights=${beforeIns}\nagents_hash_after_insights=${afterIns}\n`);
  // N-4: screenshots and other visual-proof artifacts of the runs, hashed.
  const visual = hashed(filesUnder(path.join(project, '.agents/runs'), '.agents/runs').filter((f) => /screenshot|visual/i.test(f)));
  w('visual-artifacts.txt', visual === '' ? 'none\n' : visual);
  globalGit('git-global-after.txt');
  dbProbe('db-probe.txt');
  ap('summary.txt', dbVerdict());
  console.log(`run_dir=${run}`);
  console.log(`summary=${out}/summary.txt`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
