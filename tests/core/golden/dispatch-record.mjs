// @ts-check
// Recorder of tests/core/golden/dispatch/cases.json (A226): what the SHELL dispatcher dispatch.sh of 0.0.57 hands to a runtime for a set of cases: the argument
// list of the runtime, the prompt it reads on stdin (byte for byte, as base64), and the variables it gets. The shell file is gone from the repository; recover it with
//   git show 56f84948:control-plane/agents/scripts/dispatch.sh > /tmp/dispatch-old.sh
// and record with   node tests/core/golden/dispatch-record.mjs /tmp/dispatch-old.sh
// The layout is the one of the old dispatch-test.sh: a stub agent.sh (its `decide` calls the real resolver of the Node core with class STANDARD and tier full) and fake
// runtimes. Re-record only for a reviewed change of what a runtime receives (an A entry); tests/core/dispatch-golden.test.mjs holds the Node dispatcher to this file.
// Paths are written as <ROOT> (the project) and <TMP> (the fixture folder), whatever the machine.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeRuntime, fixtureRoles } from './dispatch-fakes.mjs';

const here = import.meta.dirname;
const repo = path.resolve(here, '../../..');
const scripts = path.join(repo, 'control-plane/agents/scripts');
const oldScript = process.argv[2];
if (!oldScript) { console.error('usage: node dispatch-record.mjs <path of the old dispatch.sh>'); process.exit(2); }

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dispatch-record-')));
try {
  const p = path.join(tmp, 'proj'); const a = path.join(p, '.agents'); const loc = path.join(a, 'local'); const bin = path.join(tmp, 'bin');
  mkdirSync(path.join(a, 'scripts'), { recursive: true }); mkdirSync(path.join(a, 'roles'), { recursive: true }); mkdirSync(path.join(a, 'runs/LC'), { recursive: true }); mkdirSync(loc, { recursive: true }); mkdirSync(bin);
  copyFileSync(oldScript, path.join(a, 'scripts/dispatch.sh'));
  copyFileSync(path.join(scripts, 'proofline-core.mjs'), path.join(a, 'scripts/proofline-core.mjs')); cpSync(path.join(scripts, 'core'), path.join(a, 'scripts/core'), { recursive: true });
  writeFileSync(path.join(a, 'roles.conf'), fixtureRoles());
  const env0 = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object} */ o = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: env0, ...o });
  sh('git', ['init', '-q', p]);
  writeFileSync(path.join(p, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n.agents/local/\n.agents/scripts/dispatch.sh\n.agents/scripts/agent.sh\n');
  for (const r of ['implementer', 'reviewer', 'security_reviewer', 'designer', 'explorer']) writeFileSync(path.join(a, 'roles', `${r}.md`), `You are the proofline ${r}. STABLE-PREFIX-${r}\n`);
  writeFileSync(path.join(a, 'scripts/agent.sh'), `#!/bin/sh
loc=$(dirname "$0")/../local
echo "$*" >> "$loc/calls.log"
case "$1" in
  decide) id=$2 role=$3; shift 3; args=''
    while [ $# -gt 0 ]; do case "$1" in --focus) ;; *) args="$args $1 $2" ;; esac; shift 2; done
    exec node "$(dirname "$0")/proofline-core.mjs" cli exec-policy resolve --role "$role" --class STANDARD --tier full $args ;;
  window-open) echo FP-BEFORE ;;
  fingerprint) cat "$loc/../../product.txt" ;;
  window-close) ;;
  ledger-note) shift 2; echo "$*" >> "$loc/ledger.log" ;;
  metrics-dispatch) ;;
  ask) cp "$4" "$loc/asked.md" ;;
esac
`);
  chmodSync(path.join(a, 'scripts/agent.sh'), 0o755);
  writeFileSync(path.join(p, 'product.txt'), 'original\n');
  mkdirSync(path.join(a, 'hooks')); mkdirSync(path.join(p, '.claude'));
  writeFileSync(path.join(a, 'hooks/proofline-hook.mjs'), '0;\n');
  writeFileSync(path.join(p, '.claude/settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node .agents/hooks/proofline-hook.mjs pretool claude"}]}]}}\n');
  for (const n of /** @type {const} */ (['codex', 'claude', 'cli'])) { writeFileSync(path.join(bin, `fake-${n}`), fakeRuntime(n)); chmodSync(path.join(bin, `fake-${n}`), 0o755); }
  const baseConfig = () => {
    const text = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'utf8');
    const keep = new Set(['execution_policy', 'capabilities', 'dispatch']);
    /** @type {string[]} */ const lines = []; let on = false;
    for (const l of text.split('\n')) { const m = /^([a-z_]+):/.exec(l); if (m) on = keep.has(m[1]); if (on) lines.push(l); }
    return `${lines.join('\n').replace(/\n+$/, '')}\nprofile: balanced\nfailover: auto\nruntime:\n  lead: claude\n  worker: codex\n  reviewers: claude\nbudgets:\n  max_escalations: 2\n`
      .replace(/^ {2}command_template:\n/m, `  command_template:\n    mycli: ${bin}/fake-cli {prompt_file} {output_file} {model}\n`)
      .replace(/^ {4}codex:\n {6}models: .*\n {6}efforts: .*\n/m, (m) => `${m}    mycli:\n      models: m1 m2 m3\n      efforts: low medium high\n`);
  };
  writeFileSync(path.join(a, 'config.yaml'), baseConfig());
  const e = { ...env0, FAKE_LOC: loc, FAKE_ROOT: p, PROOFLINE_CODEX_BIN: path.join(bin, 'fake-codex'), PROOFLINE_CLAUDE_BIN: path.join(bin, 'fake-claude') };
  const norm = (/** @type {string} */ s) => s.replace(/[^\s'"]*\/dispatch\.[A-Za-z0-9]+\//g, '<WORK>/').split(p).join('<ROOT>').split(tmp).join('<TMP>');
  /** @type {Record<string, object>} */ const out = {};
  const clear = () => { rmSync(loc, { recursive: true, force: true }); mkdirSync(loc, { recursive: true }); rmSync(path.join(a, 'runs/LC/dispatch'), { recursive: true, force: true }); rmSync(path.join(a, 'runs/LC/results'), { recursive: true, force: true }); };
  /** @param {string} name @param {string[]} args @param {Record<string, string>} [extra] @param {string} [runtime] which fake runtime's files to record */
  const rec = (name, args, extra = {}, runtime = 'codex') => {
    clear();
    const r = spawnSync('sh', [path.join(a, 'scripts/dispatch.sh'), ...args], { cwd: p, env: { ...e, ...extra }, encoding: 'utf8' });
    const rd = (/** @type {string} */ f) => { try { return readFileSync(path.join(loc, f)); } catch { return null; } };
    const argv = rd(`${runtime}.argv`); const stdin = rd(`${runtime}.stdin`); const envv = rd(`${runtime}.env`);
    out[name] = {
      args: args.map(norm), status: r.status, stdout: norm(r.stdout),
      argv: argv === null ? null : norm(argv.toString('utf8')).split('\n').slice(0, -1),
      stdinBase64: stdin === null ? null : Buffer.from(norm(stdin.toString('latin1')), 'latin1').toString('base64'),
      env: envv === null ? null : norm(envv.toString('utf8')).replace(/\n$/, ''),
    };
  };
  writeFileSync(path.join(tmp, 'assignment.txt'), 'Assignment line one.\nLine two with | pipes and "quotes".\n');
  rec('codex-implementer', ['LC', 'implementer', '--prompt-file', path.join(tmp, 'assignment.txt')]);
  rec('claude-reviewer-focus', ['LC', 'reviewer', '--focus', 'rules'], {}, 'claude');
  writeFileSync(path.join(a, 'tools.conf'), 'reviewer Read,Grep,Agent,Task(x),Bash\n');
  rec('claude-tools-conf', ['LC', 'reviewer', '--focus', 'rules'], {}, 'claude');
  rmSync(path.join(a, 'tools.conf'));
  mkdirSync(path.join(p, '.claude/agents'));
  writeFileSync(path.join(p, '.claude/agents/proofline-security-reviewer.md'), '---\nname: proofline-security-reviewer\ntools: Read, Grep, Glob, Bash\n---\nbody\n');
  rec('claude-generated-agent', ['LC', 'security_reviewer'], {}, 'claude');
  rmSync(path.join(p, '.claude/agents'), { recursive: true });
  const cfg = readFileSync(path.join(a, 'config.yaml'), 'utf8');
  writeFileSync(path.join(a, 'config.yaml'), cfg.replace(/^ {2}claude_permission_mode: .*$/m, '  claude_permission_mode: acceptEdits'));
  rec('claude-accept-edits', ['LC', 'reviewer', '--focus', 'rules'], {}, 'claude');
  writeFileSync(path.join(a, 'config.yaml'), cfg);
  rec('explorer-claude', ['LC', 'explorer', '--runtime', 'claude'], {}, 'claude');
  rec('explorer-codex-assignment', ['LC', 'explorer', '--runtime', 'codex', '--prompt-file', path.join(tmp, 'assignment.txt')]);
  rec('template-mycli', ['LC', 'reviewer', '--runtime', 'mycli'], {}, 'cli');
  writeFileSync(path.join(a, 'runs/LC/RUN.yaml'), 'handoff:\n  state: IMPLEMENTING\n');
  rec('designer-implementing', ['LC', 'designer', '--runtime', 'claude'], {}, 'claude');
  rmSync(path.join(a, 'runs/LC/RUN.yaml'));
  rec('retry-note', ['LC', 'reviewer', '--runtime', 'codex'], { FAKE_LATE: '1' });
  const resumeBody = 'timed_out_at: 2026-01-01T00:00:00Z (after 1s, attempt 1, runtime codex)\nlog: .agents/runs/LC/dispatch/001-implementer-codex.log\nproduct_tree_changes (git status --short):\n  ?? partial-work.txt\n';
  // the resume note is part of the case: it is written before the dispatch, so the recorder does not clear it
  clear(); mkdirSync(path.join(a, 'runs/LC/dispatch'), { recursive: true }); writeFileSync(path.join(a, 'runs/LC/dispatch/RESUME-implementer.md'), resumeBody);
  { const r = spawnSync('sh', [path.join(a, 'scripts/dispatch.sh'), 'LC', 'implementer'], { cwd: p, env: e, encoding: 'utf8' });
    const rd = (/** @type {string} */ f) => readFileSync(path.join(loc, f));
    out['resume-note'] = { args: ['LC', 'implementer'], status: r.status, stdout: norm(r.stdout), argv: norm(rd('codex.argv').toString('utf8')).split('\n').slice(0, -1), stdinBase64: Buffer.from(norm(rd('codex.stdin').toString('latin1')), 'latin1').toString('base64'), env: norm(rd('codex.env').toString('utf8')).replace(/\n$/, ''), resumeKept: false, resumeBody }; }
  writeFileSync(path.join(tmp, 'utf8.txt'), 'Çalışma ortamı: ğüşiöç İ — \u2713 done\n');
  rec('utf8-assignment', ['LC', 'reviewer', '--runtime', 'codex', '--prompt-file', path.join(tmp, 'utf8.txt')]);
  writeFileSync(path.join(a, 'roles/reviewer.md'), 'You are the reviewer.\tTab, "quotes", back\\slash, CR\r\nline two\n\nlast line without newline');
  rec('json-escapes', ['LC', 'reviewer', '--focus', 'rules'], {}, 'claude');
  writeFileSync(path.join(a, 'roles/reviewer.md'), 'You are the proofline reviewer. STABLE-PREFIX-reviewer\n');
  rec('isolated-homes', ['LC', 'implementer'], { PROOFLINE_CODEX_HOME_DIR: path.join(tmp, 'isolated-home') });
  rec('isolated-homes-claude', ['LC', 'reviewer', '--focus', 'rules'], { HOME: path.join(tmp, 'isolated-home'), PROOFLINE_REAL_HOME: path.join(tmp, 'real-home') }, 'claude');
  // codex-profile: the main tree, and a run worktree
  /** @type {Record<string, string[]>} */ const profiles = {};
  const prof = (/** @type {string} */ name, /** @type {string} */ script, /** @type {string} */ cwd) => { const r = spawnSync('sh', [script, 'codex-profile', 'LC'], { cwd, env: e, encoding: 'utf8' }); profiles[name] = norm(r.stdout).split('\n').slice(0, -1); };
  prof('main', path.join(a, 'scripts/dispatch.sh'), p);
  sh('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(path.join(loc, 'worktrees'), { recursive: true });
  sh('git', ['-C', p, 'worktree', 'add', '-q', '--detach', path.join(loc, 'worktrees/LC'), 'HEAD']);
  const wt = realpathSync(path.join(loc, 'worktrees/LC'));
  mkdirSync(path.join(wt, '.agents/runs/LC'), { recursive: true }); cpSync(path.join(a, 'scripts'), path.join(wt, '.agents/scripts'), { recursive: true });
  prof('worktree', path.join(wt, '.agents/scripts/dispatch.sh'), wt);
  out['_profiles'] = profiles;
  mkdirSync(path.join(here, 'dispatch'), { recursive: true });
  writeFileSync(path.join(here, 'dispatch/cases.json'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`recorded ${Object.keys(out).length - 1} cases and ${Object.keys(profiles).length} profiles`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
