// @ts-check
// A376 (issue 338 U5, the deferred part of A374): `proofline config [<key> [<value>]]` lists, shows and sets a setting of .agents/config.yaml, keeping the comments, the order
// and every other value; it refuses unknown keys, sections, values of the wrong type and unsafe parents. WHO SETS WHAT is a security boundary, so it is tested exhaustively:
// every key of the shipped config is set once by the user, once by the lead and once by a specialist. `config-check` warns on an unknown key (a typo) without failing.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../lib/tempdir.mjs';
import { configGetFrom, configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { AGENT_KEYS, caller, configCli, setInText, settable, whyUserOnly } from '../../control-plane/agents/scripts/core/configcmd.mjs';
import { KNOWN_KEYS, baseKey, closestKey, knownKey, unknownKeyWarnings } from '../../control-plane/agents/scripts/core/configkeys.mjs';
import { run as coreRun } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { USAGE_LINES } from '../../control-plane/agents/scripts/core/cliusage.mjs';
import { sandbox } from './frontend-lib.mjs';
import { AGENT_CONFIG_KEYS } from '../../adapters/claude/hooks/guards/bash.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const shipped = readFileSync(path.join(root, 'control-plane/agents/config.yaml'), 'latin1');
const DEF = configLines(shipped);
const LEAD = { CLAUDECODE: '1' };
const SPECIALIST = { CLAUDECODE: '1', AGENT_ROLE: 'implementer' };

/** A project folder with CFG as its config. @param {string} cfg */
function project(cfg) {
  const d = tempDir('cfgcmd');
  mkdirSync(path.join(d, '.agents/scripts'), { recursive: true });
  writeFileSync(path.join(d, '.agents/config.yaml'), cfg, 'latin1');
  writeFileSync(path.join(d, '.agents/scripts/agent.sh'), '');
  return d;
}

/** `proofline config ARGS` in D as ENV's caller; TTY: standard input and output are a terminal. @param {string} d @param {string[]} args @param {Record<string, string>} [env] @param {string} [home] @param {boolean} [tty] */
function cli(d, args, env = {}, home = root, tty = true) {
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const io = { env: { PL_HOME: home, PATH: process.env.PATH ?? '', ...env }, cwd: d, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) } };
  const ctx = new Context(/** @type {any} */ (io), path.join(d, '.agents/scripts/agent.sh'));
  const status = configCli(ctx, args, { tty });
  ctx.flush();
  return { status, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString('latin1'), file: readFileSync(path.join(d, '.agents/config.yaml'), 'latin1') };
}

/** A value of the right type for KEY: a number for a number, the other word of a pair, else a word config-check accepts. @param {string} key */
function otherValue(key) {
  const d = configGetFrom(DEF, key) ?? '';
  const words = { on: 'off', off: 'on', true: 'false', false: 'true', claude: 'codex', codex: 'claude', ask: 'off', markdown: 'github', conventional: 'plain', balanced: 'max', low: 'medium', none: 'task', auto: 'plain', relaxed: 'strict', orchestrated: 'standalone', unit: 'e2e', bypassPermissions: 'default' };
  if (/^[0-9]+$/.test(d)) return String(Number(d) + 1);
  if (/^[0-9]+\.[0-9]+$/.test(d)) return '2.0';
  return Object.hasOwn(words, d) ? words[/** @type {keyof typeof words} */ (d)] : d;
}

/** Every leaf key of the shipped config (a key with one value, not a section). */
const LEAVES = [...new Set(DEF.map((l) => baseKey(l.slice(0, l.indexOf('=')))))].filter((k) => settable(DEF, k) === '');

test('the agent keys are the same in the core and in the hook, and none is a codex, commands, git, approval, security, safety, runtime or review key', () => {
  assert.deepEqual([...AGENT_KEYS], [...AGENT_CONFIG_KEYS]);
  for (const k of AGENT_KEYS) {
    assert.ok(LEAVES.includes(k), `${k} is a shipped setting`);
    assert.ok(!/^(codex|commands|git|approval|security|safety|runtime|review|test_trust|pipelines|risk|profile|failover|timeouts\.scale)\b/.test(k), k);
  }
});

test('BOUNDARY: every setting of the shipped config, set by the user, by the lead and by a specialist (exhaustive)', () => {
  assert.ok(LEAVES.length > 150, `only ${LEAVES.length} leaves`);
  const d = project(shipped);
  let userSet = 0;
  for (const key of LEAVES) {
    const v = otherValue(key);
    // a specialist sets nothing, an agent key included
    const s = cli(d, [key, v], SPECIALIST);
    assert.equal(s.status, 1, `specialist ${key}`);
    assert.match(s.err, /a specialist never changes the config/);
    assert.equal(s.file, shipped, `specialist ${key} wrote`);
    // the lead: exactly the agent keys; every other key is refused with "edit .agents/config.yaml yourself" and the file is untouched
    const l = cli(d, [key, v], LEAD);
    if (AGENT_KEYS.includes(key)) {
      assert.equal(l.status, 0, `lead ${key}: ${l.err}`);
      writeFileSync(path.join(d, '.agents/config.yaml'), shipped, 'latin1');
    } else {
      assert.equal(l.status, 1, `lead ${key} was allowed`);
      assert.match(l.err, /is the user's setting: .+edit \.agents\/config\.yaml yourself or run this in your own terminal/, key);
      assert.equal(l.file, shipped, `lead ${key} wrote`);
      assert.ok(whyUserOnly(key) !== '', key);
    }
    // the user's shell without a terminal (an agent shell that cleared the markers, `env -u CLAUDECODE ...`): only the agent keys
    const n = cli(d, [key, v], {}, root, false);
    if (AGENT_KEYS.includes(key)) { assert.equal(n.status, 0, `no tty ${key}: ${n.err}`); writeFileSync(path.join(d, '.agents/config.yaml'), shipped, 'latin1'); } else {
      assert.equal(n.status, 1, `no tty ${key} was allowed`);
      assert.match(n.err, /set only from an interactive terminal.+edit \.agents\/config\.yaml yourself or run this in your own terminal/, key);
      assert.equal(n.file, shipped, `no tty ${key} wrote`);
    }
    // the user in a terminal: a value of the right type is written and is the only change, or the refusal names why (a list or a value config-check refuses)
    const u = cli(d, [key, v]);
    if (u.status === 0) {
      userSet++;
      if (v !== (configGetFrom(DEF, key) ?? '')) {
        assert.equal(configGetFrom(configLines(u.file), key), v, key);
        const rest = (/** @type {string} */ t) => configLines(t).filter((x) => !x.startsWith(`${key}=`) && !x.startsWith(`${key}.`));
        assert.deepEqual(rest(u.file), rest(shipped), `${key}: another key changed`);
        assert.equal(u.file.split('\n').length, shipped.split('\n').length, `${key}: lines added or removed`);
      }
      writeFileSync(path.join(d, '.agents/config.yaml'), shipped, 'latin1');
    } else {
      assert.match(u.err, /nothing was written|Nothing was written/i, key);
      assert.equal(u.file, shipped, `user ${key} wrote on a refusal`);
    }
  }
  assert.ok(userSet > 140, `the user set only ${userSet} keys`);
});

test('the user sets codex and commands keys; the lead and a specialist are refused for each, in a lead session of Codex too', () => {
  for (const [key, v] of [['codex.sandbox.network', 'on'], ['codex.sandbox.local_server', 'on'], ['codex.sandbox.failover', 'claude'], ['commands.test', 'npm test'], ['commands.build', 'make'], ['commands.lint', 'none'], ['git.push_requires_approval', 'false'], ['security.advisory_check', 'on'], ['timeouts.scale', '3.0'], ['approval.phrases', 'yes']]) {
    const d = project(shipped);
    for (const env of [LEAD, { CODEX_THREAD_ID: 't1' }, { CODEX_SANDBOX: 'seatbelt' }, { CLAUDE_CODE_SESSION_ID: 's' }, { PROOFLINE_NO_TTY: '1' }, SPECIALIST]) {
      const r = cli(d, [key, v], env);
      assert.equal(r.status, 1, `${key} ${JSON.stringify(env)}`);
      assert.equal(r.file, shipped);
    }
    const u = cli(d, [key, v]);
    assert.equal(u.status, 0, `${key}: ${u.err}`);
    assert.equal(configGetFrom(configLines(u.file), key), v);
  }
});

test('caller: no marker is the user, a marker is the lead, AGENT_ROLE other than lead is a specialist', () => {
  assert.equal(caller({}), 'user');
  assert.equal(caller({ CLAUDECODE: '1' }), 'lead');
  assert.equal(caller({ AGENT_ROLE: 'lead' }), 'lead');
  assert.equal(caller({ AGENT_ROLE: 'reviewer' }), 'specialist');
  assert.equal(caller({ PROOFLINE_NO_TTY: '1' }), 'lead');
});

test('a set keeps the comments, the order, the trailing comment of the line and the CRLF line ends', () => {
  const cfg = '# top comment\ncanonical_branch: main\n# about git\ngit:\n  branch_prefix: t/ # the prefix\n  push_requires_approval: true   # keep me\nreview:\n  max_fix_rounds: 2\n';
  const d = project(cfg);
  const r = cli(d, ['git.push_requires_approval', 'false']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.file, cfg.replace('push_requires_approval: true   # keep me', 'push_requires_approval: false   # keep me'));
  assert.match(r.out, /^set git\.push_requires_approval: true -> false/);
  const c = project(cfg.replace(/\n/g, '\r\n'));
  assert.equal(cli(c, ['review.max_fix_rounds', '3']).file, cfg.replace('max_fix_rounds: 2', 'max_fix_rounds: 3').replace(/\n/g, '\r\n'));
  // a quoted value stays quoted
  const q = project('canonical_branch: main\ngit:\n  branch_prefix: "t/"\n');
  assert.equal(cli(q, ['git.branch_prefix', 'u/']).file, 'canonical_branch: main\ngit:\n  branch_prefix: "u/"\n');
});

test('a missing key goes under its parent (created when missing), never under a parent with a value', () => {
  const cfg = 'canonical_branch: main\ngit:\n  branch_prefix: t/\n# tail\nreview:\n  max_fix_rounds: 2\n';
  const a = setInText(cfg, 'git.platform', 'gitlab');
  assert.equal(a.why, '');
  assert.equal(a.text, 'canonical_branch: main\ngit:\n  branch_prefix: t/\n  platform: gitlab\n# tail\nreview:\n  max_fix_rounds: 2\n');
  const b = setInText(cfg, 'codex.sandbox.network', 'on');
  assert.equal(b.text, `${cfg}codex:\n  sandbox:\n    network: on\n`);
  assert.match(setInText('canonical_branch: main\ngit:\n  branch_prefix: t/\ncodex: off\n', 'codex.sandbox.network', 'on').why, /codex has a value \(off\)/);
  assert.match(setInText('canonical_branch: main\ngit:\n  branch_prefix: t/\nreview: {a: 1}\n', 'review.max_fix_rounds', '3').why, /review has a value/);
  assert.match(setInText('canonical_branch: main\ngit:\n\tbranch_prefix: t/\n', 'git.platform', 'github').why, /tabs/);
  assert.match(setInText('canonical_branch: main\ngit:\n  branch_prefix: t/\nreview:\n  risky_paths: |\n    a\n    b\n', 'review.max_fix_rounds', '3').why, /multi-line/);
  assert.match(setInText('canonical_branch: main\ngit:\n  branch_prefix: t/\ncommands:\n  test:\n    - a\n    - b\n', 'commands.test', 'c').why, /a list or keys below it/);
});

test('refused: unknown keys (with the closest key), sections, list items, wrong types, YAML syntax, line breaks and values config-check refuses', () => {
  const d = project(shipped);
  const cases = [
    [['review.max_fix_round', '3'], /unknown config key: review\.max_fix_round \(closest known key: review\.max_fix_rounds\)/],
    [['git', 'x'], /git is a section, not a setting/],
    [['codex.sandbox', 'on'], /codex\.sandbox is a section/],
    [['runtime.roles', 'x'], /runtime\.roles is a section/],
    [['commands.build.0', 'x'], /is not a config key/],
    [['review.max_fix_rounds', 'many'], /takes a whole number \(the default is 2\), not many/],
    [['timeouts.scale', 'fast'], /takes a number/],
    [['git.push_requires_approval', 'yes'], /takes true or false/],
    [['profile', 'cheap'], /invalid value for profile: cheap/],
    [['codex.sandbox.network', 'maybe'], /invalid value for codex\.sandbox\.network: maybe/],
    [['git.branch_prefix', '{a: 1}'], /read as YAML syntax/],
    [['git.branch_prefix', 'a #b'], /would be cut there/],
    [['git.branch_prefix', 'a\nb'], /line break/],
    [['git.branch_prefix', ' a'], /starts or ends with a space/],
    [['timeouts.scale', '99'], /timeouts\.scale must be a number from 0\.5 to 10: 99/],
  ];
  for (const [args, re] of cases) {
    const r = cli(d, /** @type {string[]} */ (args));
    assert.equal(r.status, 1, `${args}: ${r.out}`);
    assert.match(r.err, /** @type {RegExp} */ (re), String(args));
    assert.equal(r.file, shipped);
  }
  assert.equal(cli(d, ['a', 'b', 'c']).status, 2);
  assert.equal(cli(d, ['--set', 'x']).status, 2);
  // without the shipped copy nothing can be checked, so nothing is written
  const n = cli(d, ['review.max_fix_rounds', '3'], {}, '');
  assert.equal(n.status, 1);
  assert.match(n.err, /shipped config was not found/);
});

test('show and list: the value, the default and who sets it; showing a user key is fine for the lead', () => {
  const d = project('canonical_branch: main\ngit:\n  branch_prefix: t/\ncodex:\n  sandbox:\n    network: on\ncommands:\n  test:\n    - a\n    - b\n');
  const s = cli(d, ['codex.sandbox.network'], LEAD);
  assert.equal(s.status, 0, s.err);
  assert.equal(s.out, 'codex.sandbox.network: on\ndefault: off\nset by: you only (the Codex sandbox permissions (network, local server, failover) are your decision (A372))\n');
  assert.match(cli(d, ['output_cap_bytes']).out, /^output_cap_bytes: not in your file, the default applies\ndefault: 6000\nset by: you, or the lead through proofline config\n$/);
  assert.match(cli(d, ['commands.test']).out, /^commands\.test: a; b\n/);
  assert.equal(cli(d, ['nope.key']).status, 1);
  const l = cli(d, [], LEAD);
  assert.equal(l.status, 0);
  assert.match(l.out, /^codex\.sandbox\.network: on$/m);
  assert.match(l.out, /^commands\.test: a; b$/m);
  assert.ok(!/^codex:/m.test(l.out) && !/^codex\.sandbox:/m.test(l.out), 'sections are not listed');
  assert.match(l.out, /An agent session may set only output_cap_bytes, tasks\.status_block_seconds, timeouts\.warn_percent/);
});

test('the known keys equal the keys of the shipped config; every shipped key is known', () => {
  const have = new Set(DEF.map((l) => baseKey(l.slice(0, l.indexOf('=')))));
  for (const k of have) assert.ok(knownKey(k), `${k} is shipped but not known`);
  const legacy = ['contract', 'contract.paths', 'contract.ignore', 'batch.task_timeout', 'batch.runtimes'];
  for (const k of KNOWN_KEYS) assert.ok(have.has(k) || legacy.includes(k), `${k} is known but not shipped`);
  assert.equal(closestKey('review.max_fix_round'), 'review.max_fix_rounds');
  assert.equal(closestKey('comands.test'), 'commands.test');
});

test('unknownKeyWarnings: a typo is named with the closest key; known keys, open maps, list items and keys config-check already rejects are not', () => {
  const lines = configLines('canonical_branch: main\ngit:\n  branch_prefix: t/\n  protected_branch: main\nreview:\n  max_fix_round: 3\nrisk:\n  mine:\n    check: config\nruntime:\n  roles:\n    implementer: codex\ncommands:\n  test:\n    - a\ncodex:\n  sandbox:\n    netwrk: on\n');
  const w = unknownKeyWarnings(lines, ['unknown codex key: codex.sandbox.netwrk (want ...)']);
  assert.deepEqual(w, [
    'warning: unknown config key git.protected_branch (closest known key: git.protected_branches); proofline ignores it',
    'warning: unknown config key review.max_fix_round (closest known key: review.max_fix_rounds); proofline ignores it',
  ]);
  assert.deepEqual(unknownKeyWarnings(DEF, []), []);
});

test('config-check: an unknown key warns on standard error and the check still passes; with an error the warning is listed after it', () => {
  /** @param {string} cfg */
  const check = (cfg) => {
    const d = project(cfg);
    /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
    const status = coreRun(['config-check'], /** @type {any} */ ({ env: { PATH: process.env.PATH ?? '', HOME: d }, cwd: d, scriptPath: path.join(d, '.agents/scripts/agent.sh'), stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) } }));
    return { status, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() };
  };
  const ok = check('canonical_branch: main\ngit:\n  branch_prefix: t/\nreview:\n  max_fix_round: 3\n');
  assert.equal(ok.status, 0, ok.err);
  assert.equal(ok.out, 'config valid: .agents/config.yaml\n');
  assert.match(ok.err, /^warning: unknown config key review\.max_fix_round \(closest known key: review\.max_fix_rounds\); proofline ignores it$/m);
  const bad = check('canonical_branch: main\ngit:\n  branch_prefix: t/\nprofile: wrong\nreview:\n  max_fix_round: 3\n');
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /invalid value for profile: wrong[^]*warning: unknown config key review\.max_fix_round/);
  const clean = check(shipped);
  assert.equal(clean.status, 0, clean.err);
  assert.ok(!clean.err.includes('unknown config key'), clean.err);
});

test('proofline help names the config command', () => {
  assert.ok(USAGE_LINES.some((l) => l.startsWith('  config [<key> [<value>]]')));
});

test('bin/proofline config in an installed project: no terminal (an agent shell, markers cleared or not) sets no user key but sets an agent key; a project without proofline is told to init', () => {
  const sb = sandbox();
  const d = sb.copy('cfg');
  const cleared = { PROOFLINE_NO_TTY: '0' };   // the sandbox has no agent marker: the `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u AGENT_ROLE` case
  const before = readFileSync(path.join(d, '.agents/config.yaml'), 'latin1');
  for (const env of [{ CLAUDECODE: '1' }, cleared]) {
    const r = sb.pl(d, ['config', 'codex.sandbox.network', 'on'], env);
    assert.equal(r.status, 1, r.text);
    assert.match(r.err, /codex\.sandbox\.network is the user's setting.+edit \.agents\/config\.yaml yourself or run this in your own terminal/);
    assert.equal(readFileSync(path.join(d, '.agents/config.yaml'), 'latin1'), before);
  }
  const r = sb.pl(d, ['config', 'output_cap_bytes', '8000'], { CLAUDECODE: '1' });
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^set output_cap_bytes: 6000 -> 8000 /m);
  assert.match(r.out, /Next step: .*\/proofline doctor/);
  const after = readFileSync(path.join(d, '.agents/config.yaml'), 'latin1');
  assert.equal(configGetFrom(configLines(after), 'output_cap_bytes'), '8000');
  assert.equal(after.split('\n').length, before.split('\n').length);
  assert.match(sb.pl(d, ['config', 'codex.sandbox.network'], { CLAUDECODE: '1' }).out, /^codex\.sandbox\.network: off\ndefault: off\n/);
  const none = sb.pl(sb.mkrepo('bare'), ['config'], cleared);
  assert.equal(none.status, 1);
  assert.match(none.err, /not installed/);
});

test('review findings: another indentation, an empty key, a duplicate key or section and mixed line ends are refused; a nested open map with a hyphen is known', () => {
  const base = 'canonical_branch: main\ngit:\n  branch_prefix: t/\n';
  for (const [cfg, key, re] of [
    [`${base}review:\n   max_fix_rounds: 3\n`, 'review.max_fix_rounds', /indented by 3 spaces/],
    [`${base}review:\n    max_fix_rounds: 3\n`, 'review.max_fix_rounds', /indented deeper than one level/],
    [`${base}review:\n  max_fix_rounds: 3\n  max_fix_rounds: 4\n`, 'review.max_fix_rounds', /duplicate key review\.max_fix_rounds/],
    [`${base}review:\n  max_fix_rounds: 3\nreview:\n  small_max_files: 4\n`, 'review.max_fix_rounds', /duplicate section review/],
    [`${base}review:\n  max_fix_rounds: 3\nreview:\n  small_max_files: 4\n`, 'review.small_max_lines', /duplicate section review/],
    [`${base}  : 3\n`, 'git.platform', /empty key/],
  ]) {
    const r = setInText(/** @type {string} */ (cfg), /** @type {string} */ (key), '5');
    assert.match(r.why, /** @type {RegExp} */ (re), String(cfg));
    const c = cli(project(/** @type {string} */ (cfg)), [/** @type {string} */ (key), '5']);
    assert.equal(c.status, 1, String(cfg));
    assert.equal(c.file, cfg);
  }
  const mixed = `canonical_branch: main\r\ngit:\n  branch_prefix: t/\r\nreview:\n  max_fix_rounds: 2\n`;
  const m = cli(project(mixed), ['review.max_fix_rounds', '3']);
  assert.equal(m.status, 1);
  assert.match(m.err, /mixes CRLF and LF/);
  assert.equal(m.file, mixed);
  for (const k of ['execution_policy.providers.claude-code', 'execution_policy.providers.claude-code.models', 'execution_policy.repeat_model_cap.codex2', 'execution_policy.lead_base_model.claude-code']) assert.ok(knownKey(k), k);
  assert.ok(!knownKey('execution_policy.providers.claude.model'));
});
