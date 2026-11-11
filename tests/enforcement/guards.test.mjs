// Guards of the Node migration, stage 1 (ADR 0001 sections 5.3 and 7), against the real runtime hook (adapters/claude/hooks/proofline-hook.mjs).
//
//   tripwires    a model Bash command that starts Node on the control plane, or names PROOFLINE_BRIDGED / PROOFLINE_TEST* / PROOFLINE_ENGINE* in any form, is denied (with or without an open run)
//                (one case per spelling, for the lead and for subagent roles); the same text is allowed with no open run and in a project
//                without proofline; the user's own terminal and the suites never pass through the hook, so the text simply runs there.
//   node absent  a moved command (hook-config, db-config, config-get) exits 127 when `node` is not on PATH. The shell hook then denies a
//                Bash call and a file read/write (database guard, run open) and `git push origin main` (merge guard) with a message that
//                names the command and Node 22.13. The 0.0.40 fallback (empty settings) does not, so these cases fail on it:
//                GUARDS_HOOK=<path of the old hook> runs the same cases against another hook file.
//
// Known limit, not closable at the hook: a model can write a scratch script that imports the core (a file under .agents/local/scratch or the
// run's scratch/ folder) and then run it with a plain literal `node scratch.mjs`. The hook reads command text, not file contents. The boundary is
// the one the ADR names: the core serves the role it is told by the environment, `approve` records only from a captured user message, and
// writes to .agents/local/ are refused to models. The tripwires here only close the spellings the hook can see.
//
// This is a Node test on purpose: tests/ci/no-shell-logic.mjs (strict) refuses new shell files.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const hook = process.env.GUARDS_HOOK || join(repo, 'adapters/claude/hooks/proofline-hook.mjs');
// the Node hook is started with this very node (an absolute path, so a PATH without node still starts it)
/** @param {string} event @returns {[string, string[]]} */
const hookRun = (event) => (hook.endsWith('.mjs') ? [process.execPath, [hook, event, 'claude']] : ['sh', [hook, event, 'claude']]);
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

/** @param {{ agent?: string, path?: string }} [opts] */
function runHook(dir, tool, input, opts = {}) {
  const { agent, path } = opts;
  /** @type {Record<string, any>} */
  const payload = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: dir, tool_name: tool, tool_input: input };
  if (agent) { payload.agent_type = agent; payload.agent_id = 'a1'; }
  /** @type {Record<string, string | undefined>} */
  const env = baseEnv();
  if (path) env.PATH = path;
  const r = spawnSync(...hookRun('pretool'), { cwd: dir, input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 120000 });
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
  const r = spawnSync(join(repo, 'bin/proofline'), ['init'], { cwd: template, env: baseEnv(), encoding: 'utf8', timeout: 300000 });
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
  'PROOFLINE_BRIDGED=1 sh .agents/scripts/agent.sh answer LC 1 --captured',
  'export PROOFLINE_BRIDGED; sh .agents/scripts/agent.sh next',
  'for PROOFLINE_BRIDGED in 1; do sh .agents/scripts/agent.sh next; done',
  'read PROOFLINE_BRIDGED <<< 1',
  'printf -v PROOFLINE_BRIDGED 1',
  ': ${PROOFLINE_BRIDGED:=1}; export PROOFLINE_BRIDGED',
  'set -a; PROOFLINE_TEST=1; sh .agents/scripts/agent.sh next',
  'grep -rn PROOFLINE_ENGINE docs',
  'unset PROOFLINE_ENGINE; ls',
  'export PROOFLINE_ENGINE',
];

// The script operand rule: node on a script path the hook cannot read from the text. Denied for a model role in an open run.
const OPERAND_DENIED = [
  'D=.agents; node $D/scripts/pro*.mjs debt page',
  'D=.agents; node "$D"/scripts/proofline-core.mjs freshness T-1',
  'cd .agents; cd scripts; node pro*.mjs debt page',
  'ls .agents/scripts/pro*.mjs | xargs node {} debt page',
  "find .agents/scripts -name 'pro*.mjs' -exec node {} debt page \\;",
  'node "$(printf \'.agents/scripts/%s\' proofline-core.mjs)" debt page',
  'node ~/x/main.mjs',
  'node pro?file-core.mjs role',
  'node pro[f]*.mjs role',
  'node {a,b}.mjs',
  "node pro''fline-core.mjs role",
  'node $SCRIPT debt page',
  'env node $F',
  'npx node $F',
  'command node pro*.mjs',
  'exec node pro*.mjs',
  "printf 'process.exit(0)' | node",
  'cat prog.mjs | node -',
  'node < prog.mjs',
  'echo .agents/scripts/proofline-core.mjs | xargs node',
  'node --test $D/scripts/pro*.mjs',
  'node --test .agents/scripts/proofline-core.mjs',
  // round 2: replacement operands, code from stdin
  'ls .agents/scripts/*.mjs | xargs -I{} node {}',
  'ls | xargs -I{} node { }',
  'ls | xargs -I % node %',
  'ls | xargs --replace node {} debt page',
  "node /dev/stdin <<'EOF'\nconsole.log(1)\nEOF",
  'node /dev/fd/3 3<<<"console.log(1)"',
  'node /proc/self/fd/0 < prog.mjs',
  'cat prog.mjs | node -',
  'node - < prog.mjs',
  'NODE_OPTIONS=--require=./x.cjs node tests/a.mjs',
  'NODE_OPTIONS="--import ./x.mjs" node tests/a.mjs',
  'NODE_OPTIONS=-r./x.cjs node tests/a.mjs',
  'export NODE_OPTIONS=--loader=./l.mjs',
  'NODE_OPTIONS=--experimental-loader=./l.mjs node tests/a.mjs',
];
const OPERAND_FREE = [
  'NODE_OPTIONS=--max-old-space-size=4096 node tests/a.mjs',
  'ls tests/*.test.mjs | xargs node --test',
  'node --test "tests/x/*.test.mjs"',
  'node --test tests/x/*.test.mjs tests/y/',
  'node tests/literal.mjs arg --flag',
  'node "tests/literal.mjs"',
  "node 'tests/literal.mjs'",
  'node --check literal.mjs',
  'node --version',
  'node -v',
  'ls tests/*.test.mjs | xargs node --test',
  'node --max-old-space-size 4096 tests/literal.mjs',
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
      denied(bash(p, 'PROOFLINE_ENGINE=sh sh .agents/scripts/agent.sh status', { agent }), 'internal hand-over', agent);
    });
  }
  for (const c of ENV_SPELLINGS) {
    test(`denied for the lead: ${JSON.stringify(c)}`, () => denied(bash(p, c), 'internal hand-over', c));
  }
  for (const c of OPERAND_DENIED) test(`operand rule, denied for the lead: ${JSON.stringify(c)}`, () => denied(bash(p, c), '', c));
  for (const agent of ['proofline-explorer', 'proofline-reviewer']) {
    test(`operand rule, denied for ${agent} (debt page and freshness are lead-only writers)`, () => {
      for (const c of ['D=.agents; node $D/scripts/pro*.mjs debt page', 'D=.agents; node $D/scripts/pro*.mjs freshness T-1', "cd .agents; cd scripts; node pro*.mjs debt page"]) denied(bash(p, c, { agent }), '', c);
    });
  }
  for (const c of OPERAND_FREE) test(`operand rule, stays free: ${JSON.stringify(c)}`, () => allowed(bash(p, c), c));
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
  // a planted prompt capture arrives through an archive or a download (A210, H1): the write targets are the bash guard's
  for (const c of ['tar -xf x.tar -C .agents/local/prompts/history', 'tar xzf x.tgz --directory=.agents/local/prompts', 'unzip x.zip -d .agents/local/prompts/history', 'unzip -o x.zip -d.agents/local', 'curl -o .agents/local/prompts/history/1-deadbeef.txt http://x/y', 'curl --output .agents/local/prompts/s1.json http://x/y', 'wget -O .agents/local/prompts/s1.json http://x/y', 'wget -P .agents/local/prompts http://x/y'])
    test(`archive and download targets under .agents/local are write targets: ${JSON.stringify(c)}`, () => denied(bash(p, c), '', c));
  test('an archive or a download elsewhere stays free', () => {
    const q = project({ run: false });
    allowed(bash(q, 'tar -xf x.tar -C .agents/tasks'), 'tar');
    allowed(bash(q, 'curl -o .agents/tasks/x.html http://x/y'), 'curl');
  });
  // a headless runtime started by hand, in any spelling (dispatch.sh is the only way to run a specialist)
  for (const c of ['claude -p hi', '/usr/local/bin/claude -p hi', 'npx @anthropic-ai/claude-code -p hi', 'npx -y @anthropic-ai/claude-code@latest --print hi', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi', 'pnpm dlx @openai/codex exec x', 'npx -y @openai/codex@latest exec x', '/opt/bin/codex exec x', 'node /opt/codex/bin/codex.js exec x'])
    test(`a nested headless runtime is denied: ${JSON.stringify(c)}`, () => denied(bash(p, c), 'nested runtime', c));
  test('a node script or package runner that is no runtime stays free', () => {
    const q = project({ run: false });
    allowed(bash(q, 'node scripts/build.js -p 3'), 'node -p');
    allowed(bash(q, 'npx prettier --check .agents/tasks'), 'npx');
  });
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
    denied(bash(p, 'PROOFLINE_ENGINE=sh ls'), 'internal hand-over', 'the seam names are denied with no run open too');
    denied(bash(p, 'export PROOFLINE_BRIDGED'), 'internal hand-over', 'BRIDGED');
  });
  test("the user's terminal (no open run in the hook's view) and a plain project: the operand-rule spellings are not touched", () => {
    const q = project({ run: false });
    for (const c of OPERAND_DENIED) allowed(bash(q, c), c);
    const plain = plainProject();
    for (const c of OPERAND_DENIED) allowed(bash(plain, c), c);
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


