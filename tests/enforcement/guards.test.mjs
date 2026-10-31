// Guards of the Node migration, stage 1 (ADR 0001 sections 5.3 and 7), against the real runtime hook (adapters/claude/hooks/proofline-hook.sh).
//
//   tripwires    a model Bash command that starts Node on the control plane, or assigns PROOFLINE_ENGINE* / PROOFLINE_TEST*, is denied
//                (one case per spelling, for the lead and for subagent roles); the same text is allowed with no open run and in a project
//                without proofline; the user's own terminal and the suites never pass through the hook, so the text simply runs there.
//   node absent  a moved command (hook-config, db-config, config-get) exits 127 when `node` is not on PATH. The shell hook then denies a
//                Bash call and a file read/write (database guard, run open) and `git push origin main` (merge guard) with a message that
//                names the command and Node 22.13. The 0.0.40 fallback (empty settings) does not, so these cases fail on it:
//                GUARDS_HOOK=<path of the old hook> runs the same cases against another hook file.
//
// This is a Node test on purpose: tests/ci/no-shell-logic.mjs (ratchet) refuses new shell files.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const hook = process.env.GUARDS_HOOK || join(repo, 'adapters/claude/hooks/proofline-hook.sh');
const haveJq = spawnSync('jq', ['--version']).status === 0;
const haveGit = spawnSync('git', ['--version']).status === 0;

const root = mkdtempSync(join(tmpdir(), 'proofline-guards-'));
let template = '';
let counter = 0;

/** @returns {Record<string, string | undefined>} */
const baseEnv = () => {
  const e = { ...process.env, PROOFLINE_NO_TTY: '1' };
  for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'PROOFLINE_JSON', 'AGENT_ROLE', 'PROOFLINE_ENGINE', 'PROOFLINE_ENGINE_SH']) delete e[k];
  return e;
};

// A project with proofline installed (the real installer) and, unless run === false, an open run.
function project({ run = true } = {}) {
  const dir = join(root, `p${++counter}`);
  cpSync(template, dir, { recursive: true });
  const active = join(dir, '.agents/local/ACTIVE_RUN');
  if (run) {
    mkdirSync(join(dir, '.agents/runs/LC'), { recursive: true });
    mkdirSync(join(dir, '.agents/local'), { recursive: true });
    writeFileSync(active, 'LC\n');
  } else rmSync(active, { force: true });
  return dir;
}
function plainProject() {
  const dir = join(root, `plain${++counter}`);
  mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

// PATH without node: a directory that holds node is replaced by a symlink farm of its other entries.
function nonodePath() {
  const farm = join(root, 'nonode');
  rmSync(farm, { recursive: true, force: true });
  mkdirSync(farm);
  const out = [];
  let used = false;
  for (const d of (process.env.PATH || '').split(delimiter)) {
    if (!d || !existsSync(d)) continue;
    if (existsSync(join(d, 'node')) || existsSync(join(d, 'nodejs'))) {
      for (const f of readdirSync(d)) {
        if (f === 'node' || f === 'nodejs') continue;
        try { symlinkSync(join(d, f), join(farm, f)); } catch { /* first entry wins */ }
      }
      if (!used) out.push(farm);
      used = true;
    } else out.push(d);
  }
  return out.join(delimiter);
}

/** @param {{ agent?: string, path?: string }} [opts] */
function runHook(dir, tool, input, opts = {}) {
  const { agent, path } = opts;
  /** @type {Record<string, any>} */
  const payload = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: dir, tool_name: tool, tool_input: input };
  if (agent) { payload.agent_type = agent; payload.agent_id = 'a1'; }
  /** @type {Record<string, string | undefined>} */
  const env = baseEnv();
  if (path) env.PATH = path;
  const r = spawnSync('sh', [hook, 'pretool', 'claude'], { cwd: dir, input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 120000 });
  let decision = 'allow';
  let reason = '';
  try {
    const j = JSON.parse(r.stdout || '{}');
    if (j.hookSpecificOutput?.permissionDecision === 'deny') { decision = 'deny'; reason = j.hookSpecificOutput.permissionDecisionReason; }
  } catch { /* no output: allowed */ }
  return { decision, reason, stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const bash = (dir, command, opts) => runHook(dir, 'Bash', { command }, opts);
function denied(r, fragment, what) {
  assert.equal(r.decision, 'deny', `${what}: not denied (stdout ${r.stdout}, stderr ${r.stderr})`);
  if (fragment) assert.ok(r.reason.includes(fragment), `${what}: denied for another reason: ${r.reason}`);
}
function allowed(r, what) {
  assert.equal(r.decision, 'allow', `${what}: denied: ${r.reason}`);
}

before(() => {
  template = join(root, 'template');
  mkdirSync(template);
  const g = (...a) => spawnSync('git', a, { cwd: template, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  const r = spawnSync('sh', [join(repo, 'bin/proofline'), 'init'], { cwd: template, env: baseEnv(), encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, `proofline init failed: ${r.stdout}${r.stderr}`);
  mkdirSync(join(template, 'src'), { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

const skip = !haveJq || !haveGit ? 'jq and git are required' : false;

const NODE_SPELLINGS = [
  'node .agents/scripts/proofline-core.mjs role',
  'node ./control-plane/agents/scripts/proofline-core.mjs help',
  'node .agents/scripts/core/proc.mjs',
  '/usr/local/bin/node .agents/scripts/proofline-core.mjs role',
  `node -e "import('./.agents/scripts/proofline-core.mjs')"`,
  `node --eval "import('./.agents/scripts/core/paths.mjs')"`,
  `node -p "require('fs').readdirSync('.agents/scripts')"`,
  'node --print ".agents/scripts"',
  'node -pe ".agents/scripts/core"',
  `echo "import '/p/.agents/scripts/proofline-core.mjs'" | node --input-type=module`,
  'node --input-type=module < .agents/local/scratch/x.mjs; echo .agents/scripts',
  "node --input-type=module <<'EOF'\nimport './.agents/scripts/proofline-core.mjs'\nEOF",
  "node - <<'X'\nimport '/p/.agents/scripts/proofline-core.mjs'\nX",
  'node --import ./.agents/scripts/core/hook.mjs app.js',
  'node --require ./.agents/scripts/core/x.cjs app.js',
  'node -r ./.agents/scripts/core/x.cjs app.js',
  'node --loader ./.agents/scripts/core/l.mjs app.js',
  'node --experimental-loader=./.agents/scripts/core/l.mjs app.js',
  'env node .agents/scripts/proofline-core.mjs role',
  'npx node .agents/scripts/proofline-core.mjs role',
  'N=$(node -p process.execPath); "$N" .agents/scripts/proofline-core.mjs role',
  `"$(command -v node)" -e "import('.agents/scripts/proofline-core.mjs')"`,
  'nodejs .agents/scripts/proofline-core.mjs role',
  "no''de .agents/scripts/proofline-core.mjs role",
  'node "$(printf .agents)/scripts/proofline-core.mjs" role',
  './.agents/scripts/proofline-core.mjs role',
  'cd /tmp && node proofline-core.mjs role',
];

const ENV_SPELLINGS = [
  'PROOFLINE_ENGINE=sh sh .agents/scripts/agent.sh role',
  'export PROOFLINE_ENGINE_SH=hook-config; sh .agents/scripts/agent.sh next',
  'env PROOFLINE_TEST=1 sh .agents/scripts/agent.sh help',
  'PROOFLINE_TEST_NOW=1 sh .agents/scripts/agent.sh next',
  'PROOFLINE_""ENGINE=sh sh .agents/scripts/agent.sh role',
  'PROOFLINE_TESTX+=1',
];

const FREE = [
  'node --test tests/skills/',
  'node -e "console.log(1)"',
  'node -p "process.version"',
  'sh .agents/scripts/agent.sh next; node --test x.test.mjs',
  'sh .agents/scripts/agent.sh status | node -e "process.stdin.resume()"',
  'sh .agents/scripts/agent.sh status',
  'ls .agents/scripts',
  'node --test tests/equivalence/proofline-core.test.mjs',
  'grep -rn PROOFLINE_ENGINE docs',
  'unset PROOFLINE_ENGINE; ls',
  'ls node_modules/.bin; node_modules/.bin/jest --version',
  'node --check src/a.mjs',
  'node --check .agents/scripts/proofline-core.mjs',
  'node -c .agents/scripts/proofline-core.mjs',
  'node tests/bench/agent-procs.mjs --agent .agents/scripts/agent.sh',
];

// Over-blocks that stay on purpose: the issue lists them as tripwire spellings (any node -e/-p text that names .agents/scripts, any
// node operand under .agents/scripts). They are kept as denied cases so a later narrowing is a visible decision.
// --check/-c is exempt only as one of node's own options before the script path; after it, it is an argument of the program.
const CHECK_AFTER_OPERAND = [
  'node .agents/scripts/proofline-core.mjs role -c',
  'node .agents/scripts/proofline-core.mjs role --check',
  'node ./.agents/scripts/core/proc.mjs -c',
];
// Quote- and backslash-split words must reach the merge guard exactly like the plain words (it loads its list at the point of use).
const SPLIT_PUSHES = [
  "g''it p''ush origin main",
  '"g""it" "pu""sh" origin HEAD:main',
  'g\\it p\\ush origin main',
  "g''it up''date-ref refs/heads/main HEAD",
  "g''it me''rge feature",
  "g''it br''anch -f main HEAD",
];
const KNOWN_OVERBLOCK = [
  `node -e "console.log(require('fs').readdirSync('.agents/scripts'))"`,
  'node .agents/scripts/anything.mjs',
];

describe('tripwires (open run, installed project)', { skip }, () => {
  let p;
  before(() => { p = project(); });
  for (const c of NODE_SPELLINGS) {
    test(`denied for the lead: ${JSON.stringify(c)}`, () => denied(bash(p, c), 'never starts Node on the control plane', c));
  }
  for (const agent of ['proofline-implementer', 'proofline-explorer', 'proofline-reviewer']) {
    test(`denied for ${agent}`, () => {
      denied(bash(p, 'node .agents/scripts/proofline-core.mjs role', { agent }), 'never starts Node', agent);
      denied(bash(p, `node -e "import('.agents/scripts/proofline-core.mjs')"`, { agent }), 'never starts Node', agent);
      denied(bash(p, 'PROOFLINE_ENGINE=sh sh .agents/scripts/agent.sh status', { agent }), 'PROOFLINE_ENGINE* or PROOFLINE_TEST*', agent);
    });
  }
  for (const c of ENV_SPELLINGS) {
    test(`denied for the lead: ${JSON.stringify(c)}`, () => denied(bash(p, c), 'PROOFLINE_ENGINE* or PROOFLINE_TEST*', c));
  }
  for (const c of FREE) test(`stays free: ${JSON.stringify(c)}`, () => allowed(bash(p, c), c));
  for (const c of CHECK_AFTER_OPERAND) test(`--check/-c after the script is an argument, denied: ${JSON.stringify(c)}`, () => denied(bash(p, c), 'never starts Node', c));
  for (const c of KNOWN_OVERBLOCK) test(`known over-block, kept (the issue lists the spelling): ${JSON.stringify(c)}`, () => denied(bash(p, c), 'never starts Node', c));
  // the engine switch file is the user's: a model cannot write it (ADR 5.3 relies on .agents/local being protected)
  for (const c of ['echo sh > .agents/local/engine', 'printf sh >> .agents/local/engine', 'echo sh | tee .agents/local/engine', 'cp /dev/null .agents/local/engine', 'rm .agents/local/engine'])
    test(`engine file: Bash ${JSON.stringify(c)} is denied`, () => denied(bash(p, c), '', c));
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    test(`engine file: ${tool} on .agents/local/engine is denied (lead and subagent)`, () => {
      denied(runHook(p, tool, { file_path: '.agents/local/engine' }), '', tool);
      denied(runHook(p, tool, { file_path: join(p, '.agents/local/engine') }, { agent: 'proofline-implementer' }), '', tool);
    });
  }
  test('agent.sh approve keeps its deny', () => {
    denied(bash(p, 'sh .agents/scripts/agent.sh approve LC plan'), "an approval is the user's", 'approve');
    denied(bash(p, 'sh .agents/scripts/agent.sh approve-pending LC'), "an approval is the user's", 'approve-pending');
    denied(bash(p, 'PROOFLINE_ENGINE=sh sh .agents/scripts/agent.sh approve LC plan'), '', 'approve behind an engine switch');
  });
});

describe('tripwire scope', { skip }, () => {
  test('no open run: the tripwires do not apply', () => {
    const p = project({ run: false });
    allowed(bash(p, 'node .agents/scripts/proofline-core.mjs role'), 'node on the core');
    allowed(bash(p, 'PROOFLINE_ENGINE=sh ls'), 'engine assignment');
  });
  test('a project without proofline: the tripwires do not apply', () => {
    const p = plainProject();
    allowed(bash(p, 'node .agents/scripts/proofline-core.mjs role'), 'node on the core');
    allowed(bash(p, 'PROOFLINE_ENGINE=sh ls'), 'engine assignment');
  });
  test("the user's own terminal and suites set the seams themselves (no hook in between)", () => {
    const r = spawnSync('sh', ['-c', 'test "$PROOFLINE_ENGINE" = sh && test "$PROOFLINE_TEST" = 1'], { env: { ...baseEnv(), PROOFLINE_ENGINE: 'sh', PROOFLINE_TEST: '1' } });
    assert.equal(r.status, 0);
  });
});

// The launcher preamble of the real agent.sh (ADR 5.3) as a wrapper in front of the shell code: a moved command needs node on PATH.
const MOVED = 'role|config-get|config-check|timeouts|hook-timeouts|verify-timeout|tm-scaled|db-config|hook-config|help';
function wrapMoved(dir, code) {
  const s = join(dir, '.agents/scripts');
  renameSync(join(s, 'agent.sh'), join(s, 'agent-real.sh'));
  const body = code === undefined
    ? `case "\${1:-}" in\n  ${MOVED})\n    command -v node >/dev/null 2>&1 || { echo "agent.sh: node: not found" >&2; exit 127; } ;;\nesac\n`
    : `case "\${1:-}" in hook-config|db-config|config-get) echo boom >&2; exit ${code} ;; esac\n`;
  writeFileSync(join(s, 'agent.sh'), `#!/bin/sh\n${body}exec sh "$(dirname "$0")/agent-real.sh" "$@"\n`);
}

describe('node absent (C2)', { skip }, () => {
  let np = '';
  before(() => { np = nonodePath(); });
  test('the harness really takes node off PATH', () => {
    assert.notEqual(spawnSync('sh', ['-c', 'command -v node'], { env: { ...baseEnv(), PATH: np } }).status, 0);
  });

  test('control: with node on PATH the wrapped project behaves as before', () => {
    const p = project(); wrapMoved(p);
    allowed(bash(p, 'ls'), 'a plain Bash call');
    allowed(runHook(p, 'Read', { file_path: 'src/a.txt' }), 'a file read');
  });

  test('run open: a Bash call is denied by the database guard path, naming the command and Node 22.13', () => {
    const p = project(); wrapMoved(p);
    const r = bash(p, 'ls', { path: np });
    denied(r, 'Node 22.13', 'Bash call');
    assert.match(r.reason, /db-config|config-get/);
    assert.ok(!r.reason.includes('node --version'), 'the message must not tell the model to run a command the hook then denies');
    assert.match(r.reason, /the user must check/);
  });
  test('run open: a file write is denied (database guard)', () => {
    const p = project(); wrapMoved(p);
    const r = runHook(p, 'Write', { file_path: 'src/a.txt' }, { path: np });
    denied(r, 'Node 22.13', 'file write');
    assert.match(r.reason, /db-config/);
  });
  test('run open: a file read is denied (database guard)', () => {
    const p = project(); wrapMoved(p);
    denied(runHook(p, 'Read', { file_path: 'src/a.txt' }, { path: np }), 'Node 22.13', 'file read');
  });
  test('run open: git push origin main is denied (merge guard)', () => {
    const p = project(); wrapMoved(p);
    const r = bash(p, 'git push origin main', { path: np });
    denied(r, 'Node 22.13', 'git push origin main');
    assert.match(r.reason, /config-get|db-config/);
  });
  test('run open: a subagent Bash call is denied too', () => {
    const p = project(); wrapMoved(p);
    denied(bash(p, 'ls', { path: np, agent: 'proofline-explorer' }), 'Node 22.13', 'subagent Bash call');
  });
  test('a moved command that exits with another non-zero code denies the same way (run open)', () => {
    const p = project(); wrapMoved(p, 3);
    denied(bash(p, 'ls'), 'exited 3', 'exit 3');
  });
  test('no run: the database guard keeps its fallback, the merge guard of an installed project denies', () => {
    const p = project({ run: false }); wrapMoved(p);
    allowed(runHook(p, 'Read', { file_path: 'src/a.txt' }, { path: np }), 'a file read without a run');
    denied(bash(p, 'git push origin main', { path: np }), 'Node 22.13', 'git push origin main without a run');
    denied(bash(p, 'git status', { path: np }), 'Node 22.13', 'a git command without a run (merge guard)');
    denied(bash(p, 'gh pr ' + 'merge 7 --squash', { path: np }), 'Node 22.13', 'a PR merge command without a run');
    // the branch list is loaded lazily: a command that cannot merge or push is not denied merely because node is absent
    allowed(bash(p, 'ls', { path: np }), 'ls without a run');
    allowed(bash(p, 'node --version', { path: np }), 'node --version without a run');
  });
  test('only PreToolUse denies: a PostToolUse event never does', () => {
    const p = project(); wrapMoved(p);
    /** @type {Record<string, any>} */
  const payload = { hook_event_name: 'PostToolUse', session_id: 's1', cwd: p, tool_name: 'Agent', tool_input: {}, tool_response: {} };
    const r = spawnSync('sh', [hook, 'posttool', 'claude'], { cwd: p, input: JSON.stringify(payload), env: { ...baseEnv(), PATH: np }, encoding: 'utf8' });
    assert.ok(!(r.stdout || '').includes('"permissionDecision":"deny"'), r.stdout);
  });
  test('a dispatched specialist (AGENT_ROLE in the hook environment) is not mistaken for a missing node', () => {
    const p = project();
    const payload = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: p, tool_name: 'Bash', tool_input: { command: 'ls' } };
    const r = spawnSync('sh', [hook, 'pretool', 'claude'], { cwd: p, input: JSON.stringify(payload), env: { ...baseEnv(), AGENT_ROLE: 'implementer' }, encoding: 'utf8' });
    assert.ok(!(r.stdout || '').includes('Node 22.13'), r.stdout);
  });
  for (const c of SPLIT_PUSHES) {
    test(`split spelling ${JSON.stringify(c)}: denied with node present (as on 0.0.40) and with node absent (list unavailable)`, () => {
      const p = project({ run: false });
      // node present: the 0.0.40 deny of the merge guard, no Node message
      const r1 = bash(p, c);
      denied(r1, 'proofline merge', c);
      // node absent (wrapped project): fail closed
      const q = project({ run: false }); wrapMoved(q);
      denied(bash(q, c, { path: np }), '', c);
    });
  }
  test('a project without proofline asks no moved command: nothing changes', () => {
    allowed(bash(plainProject(), 'ls', { path: np }), 'a Bash call in a plain project');
  });
});
