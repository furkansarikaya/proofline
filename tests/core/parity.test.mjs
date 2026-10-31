// @ts-check
// The moved commands give the same stdout, stderr and exit status through the Node core and through the shell code (the engine switch
// PROOFLINE_ENGINE=sh), on many argument shapes and config shapes, including the error paths. The shell is the specification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = mkdtempSync(path.join(tmpdir(), 'pl-parity-'));
mkdirSync(path.join(fx, '.agents'), { recursive: true });
cpSync(path.join(repo, 'control-plane', 'agents'), path.join(fx, '.agents'), { recursive: true });
spawnSync('git', ['init', '-q', fx]);
const agent = path.join(fx, '.agents', 'scripts', 'agent.sh');
const cfgPath = path.join(fx, '.agents', 'config.yaml');
const realConfig = readFileSync(cfgPath);
after(() => rmSync(fx, { recursive: true, force: true }));

/** @param {string[]} args @param {Record<string, string>} [env] @param {string} [engine] */
function exec(args, env = {}, engine = 'node') {
  const e = { ...process.env, ...env };
  delete e.PROOFLINE_ENGINE; delete e.PROOFLINE_ENGINE_SH; delete e.AGENT_ROLE;
  Object.assign(e, env);
  if (engine === 'sh') e.PROOFLINE_ENGINE = 'sh';
  const r = spawnSync('sh', [agent, ...args], { cwd: fx, env: e, encoding: 'latin1' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

/** @param {string[]} args @param {Record<string, string>} [env] */
function same(args, env = {}) {
  const a = exec(args, env, 'node');
  const b = exec(args, env, 'sh');
  assert.deepEqual(a, b, `agent.sh ${args.join(' ')} ${JSON.stringify(env)}`);
}

/** @param {string | null} text */
function setConfig(text) {
  if (text === null) rmSync(cfgPath, { force: true });
  else writeFileSync(cfgPath, text, 'latin1');
}

const ROLES = ['', 'lead', 'reviewer', 'implementer', 'independent_qa', 'bogus'];
const MOVED = ['role', 'config-get', 'config-check', 'timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled', 'db-config', 'hook-config', 'help'];

describe('parity with the shell code', () => {
  test('every role against every moved command', () => {
    setConfig(realConfig.toString('latin1'));
    for (const role of ROLES) for (const c of MOVED) same([c, 'canonical_branch'], role === '' ? {} : { AGENT_ROLE: role });
    for (const role of ROLES) same(['hook-config'], { AGENT_ROLE: role });
    same(['role']); same(['role', 'extra', 'args']);
  });

  test('config-get on the shipped config and on shapes', () => {
    setConfig(realConfig.toString('latin1'));
    for (const k of ['canonical_branch', 'git.branch_prefix', 'commands.test', 'commands.build', 'commands', 'review', 'nope', 'a.b.c', 'timeouts.scale', 'hook', 'hook.approve_budget_seconds', 'dispatch', 'runtime.lead', 'x y', '=', '.', 'canonical_branch=', 'git.'])
      same(['config-get', k]);
    same(['config-get']); same(['config-get', '']); same(['config-get', 'a\\tb']); same(['config-get', 'git.branch_prefix', 'extra']);
    setConfig(null);
    same(['config-get', 'canonical_branch']); same(['timeouts']); same(['hook-config']); same(['config-check']); same(['db-config']);
  });

  test('config parser edge cases: block lists, quotes, comments, octal-looking numbers, CRLF, tabs, indentation', () => {
    const cfg = [
      '# comment', '', 'canonical_branch: "main"   # trailing', "git:", '  branch_prefix: "t/"', "  commit_format: 'conventional'",
      'commands:', '  build:', '    - make all', '    - "make test"   # c', "    - 'x y'", '    -', '  test: npm test', '  lint:', '  - lint1', '  - lint1',
      'timeouts:', '  scale: 08', '  warn_percent: 080', 'hook:', '  approve_budget_seconds: 009', '  prompt_timeout_seconds: "40"', '  lock_wait_seconds: 5x',
      'dispatch:', '  timeout_seconds: 0100', 'verification:', '  command_timeout_seconds: 00061',
      'batch:', '  ci_wait_minutes: 007', 'tasks:', '  status_block_seconds: 0030', '  dir:   .agents/tasks   ',
      'database:', '  paths: "a.db b.db"', '  clients: sqlite3 psql # note', 'weird: "a # b"', 'single: \'q\'', 'only: "', 'colon: a: b: c', 'url: http://x.y/z', '   odd: 1', '\ttab: 2',
      'deep:', '  l1:', '    l2:', '      l3: v', '    sib: s', '        jump: j', 'last: no newline at end',
    ].join('\n');
    for (const nl of ['\n', '\r\n']) {
      setConfig(cfg.split('\n').join(nl));
      for (const k of ['canonical_branch', 'git.branch_prefix', 'git.commit_format', 'commands.build', 'commands.test', 'commands.lint', 'commands', 'timeouts.scale', 'weird', 'single', 'only', 'colon', 'url', 'odd', 'deep.l1.l2.l3', 'deep.l1.sib', 'deep.l1.sib.jump', 'tab', '\ttab', 'last', 'database.clients', 'tasks.dir'])
        same(['config-get', k]);
      for (const c of ['timeouts', 'hook-timeouts', 'verify-timeout', 'db-config', 'hook-config', 'config-check']) same([c]);
      for (const a of ['paths', 'clients', 'migrate_commands', 'all', 'bad', '']) same(['db-config', a]);
    }
  });

  test('timeouts family over scale and bound values', () => {
    for (const scale of ['1', '0.5', '0.49', '10', '10.1', '2.345', '1.5.2', 'abc', '', '.5', '5.', '08', '010', '0010.0500', '1e2', '-1', '99999999999999999999', '3.99999', '1,5']) {
      setConfig(`canonical_branch: main\ngit:\n  branch_prefix: t/\ntimeouts:\n  scale: ${scale}\n`);
      for (const c of ['timeouts', 'hook-timeouts', 'verify-timeout']) same([c]);
      same(['tm-scaled', '7']);
    }
    for (const v of ['0', '1', '9', '10', '599', '600', '601', '08', 'x', '', '99999999999999999999', '-3']) {
      setConfig(`canonical_branch: main\nhook:\n  approve_budget_seconds: ${v}\n  prompt_timeout_seconds: ${v}\n  session_timeout_seconds: ${v}\n  stop_timeout_seconds: ${v}\n  next_budget_seconds: ${v}\ndispatch:\n  timeout_seconds: ${v}\nverification:\n  command_timeout_seconds: ${v}\ntasks:\n  status_block_seconds: ${v}\nbatch:\n  ci_wait_minutes: ${v}\ntimeouts:\n  warn_percent: ${v}\npipelines:\n  CRITICAL:\n    dispatch_timeout_seconds: ${v}\n`);
      for (const c of ['timeouts', 'hook-timeouts', 'verify-timeout', 'hook-config']) same([c]);
    }
  });

  test('tm-scaled argument shapes', () => {
    setConfig('canonical_branch: main\ntimeouts:\n  scale: 1.7\n');
    const shapes = [['0'], ['1'], ['7'], ['120', '1', '3600'], ['5', '10'], ['5', '10', '7'], ['5', '', '3'], ['99', '1', '50'], ['08'], ['0008', '0003', '0100'], ['000000000000'], ['999999999999'], ['9999999999999'], ['1000000000000', '1', '999999999999'],
      ['abc'], ['-5'], ['+5'], ['5', 'x'], ['5', '1', 'y'], ['5.5'], [''], ['5', '', ''], ['0x10'], [' 5'], ['5 '], ['1e3'], ['5', '9', '3'], ['5', '0', '0']];
    for (const s of shapes) same(['tm-scaled', ...s]);
    same(['tm-scaled']);
    same(['tm-scaled', '5', '1', '3', 'extra']);
  });

  test('config-check: valid, invalid and rare shapes', () => {
    const base = 'canonical_branch: main\ngit:\n  branch_prefix: t/\n';
    const variants = [
      '', 'bogus: 1\n', 'profile: wrong\n', 'review:\n  max_fix_rounds: x\n', 'commands:\n  build:\n    - a\n    - a\n', 'commands:\n  build: x\n  build2:\n    - y\n', 'commands:\n  deploy:\n    - y\n',
      'commands:\n  test: [a, b]\n', 'commands:\n  test: x\n    - y\n', 'commands:\n  build:\n    - ""\n',
      'timeouts:\n  scale: 11\n', 'timeouts:\n  scale: x\n', 'timeouts:\n  warn_percent: 10\n  other: 1\n', 'hook:\n  prompt_timeout_seconds: 10\n  approve_budget_seconds: 20\n', 'hook:\n  prompt_timeout_seconds: 10\n',
      'hook:\n  bogus: 1\n  stop_timeout_seconds: 5\n', 'dispatch:\n  timeout_seconds: 10\n  network_retries: 9\n', 'batch:\n  ci_wait_minutes: 0\n  ci_appear_minutes: 999\n',
      'validation:\n  entry_words: "("\n', 'validation:\n  entry_words: "a|b"\n  code_patterns: "["\n', 'validation:\n  bogus: 1\n', 'risk:\n  log_sensitive:\n    content: "("\n    words: x\n    check: logging\n',
      'risk:\n  sig:\n    paths: a\n', 'risk:\n  sig:\n    words: a\n', 'risk:\n  Bad:\n    check: logging\n  sig:\n    flag: nope\n',
      'design_docs:\n  design:\n    shared: /abs\n', 'design_docs:\n  design:\n    surfaces:\n      web:\n        doc: d.md\n', 'design_docs:\n  design:\n    shared: ok.md\n',
      'design_docs:\n  design:\n    surfaces:\n      web:\n        doc: ../d.md\n        paths: "a/**/b/**/c|d"\n        mode: Bad\n',
      'git:\n  platform_host: gitlab.x.com\n', 'git:\n  platform_host: http://x\n  platform: github\n', 'worktree:\n  copy_files: /x\n', 'verification:\n  env_files: "*.env"\n  doc_paths: "a|b"\n',
      'capabilities:\n  a:\n    b: 9\n', 'autonomy:\n  WRONG: autonomous\n  STANDARD: x\n', 'rules:\n  budget_bytes: x\n  other: 1\n', 'visual:\n  ascii_turkish_words: "a, b c"\n', 'visual:\n  ascii_turkish_words: "a1"\n',
      'product:\n  stale_days: 0\n  dir: ../x\n', 'unknown_top:\n  a: 1\n', 'pipelines:\n  CRITICAL:\n    review: maybe\n    dispatch_timeout_seconds: 5\n',
    ];
    for (const v of variants) {
      setConfig(base + v);
      same(['config-check']);
    }
    setConfig('git:\n  branch_prefix: t/\n'); same(['config-check']);
    setConfig(''); same(['config-check']);
    setConfig(base);
    same(['config-check', cfgPath]); same(['config-check', '.agents/config.yaml']); same(['config-check', 'nope.yaml']); same(['config-check', '.agents']); same(['config-check', '']);
    writeFileSync(path.join(fx, 'other.yaml'), 'canonical_branch: main\ngit:\n  branch_prefix: x\n'); same(['config-check', 'other.yaml']);
    writeFileSync(path.join(fx, 'bad.yaml'), 'nothing: 1\n'); same(['config-check', 'bad.yaml']); same(['config-check', path.join(fx, 'bad.yaml')]);
    setConfig(realConfig.toString('latin1')); same(['config-check']);
  });

  test('help, role gate messages and unmoved commands', () => {
    for (const r of ['', 'reviewer', 'verifier', 'implementer', 'explorer', 'architect']) {
      same(['help'], r ? { AGENT_ROLE: r } : {});
      for (const c of ['db-config', 'hook-config', 'status', 'next', 'record', 'bogus', 'start', 'worktree-root']) same([c], r ? { AGENT_ROLE: r } : {});
    }
    same([]); same(['']);
  });

  test('the engine switch: env, file, either forcing sh wins', () => {
    setConfig(realConfig.toString('latin1'));
    const file = path.join(fx, '.agents', 'local', 'engine');
    mkdirSync(path.dirname(file), { recursive: true });
    const probe = (/** @type {Record<string,string>} */ env) => spawnSync('sh', [agent, 'hook-timeouts'], { cwd: fx, env: { ...process.env, PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    // node is not on this PATH: a moved command that is delegated fails with 127, one that is forced to sh runs
    const nodeless = (/** @type {Record<string,string>} */ env) => probe(env).status;
    rmSync(file, { force: true });
    if (spawnSync('sh', ['-c', 'PATH=/usr/bin:/bin command -v node']).status !== 0) {
      assert.equal(nodeless({}), 127);
      assert.equal(nodeless({ PROOFLINE_ENGINE: 'sh' }), 0);
      assert.equal(nodeless({ PROOFLINE_ENGINE_SH: 'hook-timeouts,role' }), 0);
      assert.equal(nodeless({ PROOFLINE_ENGINE_SH: 'role' }), 127);
      writeFileSync(file, 'sh\n'); assert.equal(nodeless({}), 0);
      writeFileSync(file, 'sh:hook-timeouts,role\n'); assert.equal(nodeless({}), 0);
      writeFileSync(file, 'sh:role\n'); assert.equal(nodeless({}), 127);
      writeFileSync(file, 'sh:role\n'); assert.equal(nodeless({ PROOFLINE_ENGINE: 'sh' }), 0);
      writeFileSync(file, 'node\n'); assert.equal(nodeless({}), 127);
      writeFileSync(file, ''); assert.equal(nodeless({}), 127);
      writeFileSync(file, 'sh'); assert.equal(nodeless({}), 0);
    }
    rmSync(file, { force: true });
  });
});
