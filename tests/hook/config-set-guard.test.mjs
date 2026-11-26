// @ts-check
// A376 (issue 338 U5): `proofline config <key> <value>` changes .agents/config.yaml. The PreToolUse hook refuses it for every dispatched specialist, whatever the key, and lets the
// lead's own session set only the keys of AGENT_CONFIG_KEYS: codex.*, commands.* and every other key are the user's ("edit .agents/config.yaml yourself"). Reading
// (`proofline config`, `proofline config <key>`) stays allowed for everyone. The hook only judges the command text; nothing is executed. The lead table is exhaustive over the
// keys of the shipped config (a security boundary).
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, rmSync, nodeHook, cleanEnv, repo } from './harness.mjs';

const hookDir = dirname(nodeHook);
const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);
const { AGENT_CONFIG_KEYS, configSetKeys } = await import(pathToFileURL(join(hookDir, 'guards/bash.mjs')).href);

let template = '';
let base = '';
let dir = '';
before(() => { template = buildTemplate(); base = tempDir('hook-cfgset-'); dir = copyProject(template, base); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @type {Array<[string, Record<string, string>, Record<string, string>]>} */
const SPECIALISTS = [
  ['implementer', { agent_type: 'proofline-implementer', agent_id: 'u1' }, { AGENT_ROLE: 'implementer' }],
  ['designer', { agent_type: 'proofline-designer', agent_id: 'u1' }, { AGENT_ROLE: 'designer' }],
  ['reviewer', { agent_type: 'proofline-reviewer', agent_id: 'u1' }, { AGENT_ROLE: 'reviewer' }],
  ['security_reviewer', { agent_type: 'proofline-security-reviewer', agent_id: 'u1' }, { AGENT_ROLE: 'security_reviewer' }],
  ['qa', { agent_type: 'proofline-qa', agent_id: 'u1' }, { AGENT_ROLE: 'qa' }],
  ['verifier', { agent_type: 'proofline-verifier', agent_id: 'u1' }, { AGENT_ROLE: 'verifier' }],
  ['explorer', { agent_type: 'proofline-explorer', agent_id: 'u1' }, { AGENT_ROLE: 'explorer' }],
  ['a dispatched worker session (role only, no subagent id)', {}, { AGENT_ROLE: 'implementer' }],
];

/** @param {string} command @param {Record<string, string>} who @param {Record<string, string>} env @returns {Promise<string | null>} the refusal text, or null when allowed */
async function pre(command, who, env) {
  const raw = Buffer.from(JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }));
  const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: dir, TMPDIR: '/var/proofline-cfgset-tmp', ...env }));
  assert.ok(c, 'no hook context');
  try {
    const out = await handle(c);
    if (typeof out !== 'string' || out === '') return null;
    return /** @type {string} */ (JSON.parse(out).hookSpecificOutput.permissionDecisionReason);
  } finally { finish(c); }
}

/** the spellings of one set, KEY and VALUE in place */
const SPELLINGS = (/** @type {string} */ k, /** @type {string} */ v) => [
  `proofline config ${k} ${v}`, `bin/proofline config ${k} ${v}`, `/opt/p/bin/proofline config ${k} "${v}"`, `proofline config "${k}" '${v}'`, `cd . && proofline config ${k} ${v}`,
  `echo ok; proofline config ${k} ${v}`, `env PL_HOME=/x proofline config ${k} ${v}`, `FOO=1 proofline config ${k} ${v}`, `sudo proofline config ${k} ${v}`, `sh -c 'proofline config ${k} ${v}'`,
  `(proofline config ${k} ${v})`, `true | proofline config ${k} ${v}`, `npx proofline config ${k} ${v}`, `node ./bin/proofline.mjs config ${k} ${v}`, `timeout 9 proofline config ${k} ${v}`,
  `proofline "config" ${k} ${v}`, `pro"of"line config ${k} ${v}`, `proofline config ${k} ${v} extra words`,
];
const READS = ['proofline config', 'proofline config codex.sandbox.network', 'proofline config commands.test', 'echo proofline config codex.sandbox.network on', 'grep -rn "config codex" docs', 'git commit -m "proofline config notes"', 'proofline doctor --config', 'cat proofline-config.md'];
const DENIED = /proofline config|config key/;

test('configSetKeys: the key of each set spelling; reads give nothing', () => {
  for (const c of SPELLINGS('codex.sandbox.network', 'on')) assert.deepEqual(configSetKeys(c.replace(/['"\\]/g, '')), ['codex.sandbox.network'], c);
  for (const c of READS) assert.deepEqual(configSetKeys(c), [], c);
  assert.deepEqual(configSetKeys('proofline config --x codex.sandbox.network on'), ['?']);
});

for (const [name, who, env] of SPECIALISTS) {
  test(`${name}: every spelling of a config set is refused, an agent key included; reading is not`, async () => {
    for (const [k, v] of [['codex.sandbox.network', 'on'], ['commands.test', 'x'], ['output_cap_bytes', '8000']]) {
      for (const c of SPELLINGS(k, v)) {
        const r = await pre(c, who, env);
        assert.ok(r !== null && /a specialist never sets a config key/.test(r), `${c}: ${r}`);
      }
    }
    for (const c of READS) { const r = await pre(c, who, env); assert.ok(r === null || !DENIED.test(r), `${c}: ${r}`); }
  });
}

test("BOUNDARY: the lead's session sets only the agent keys; every other key of the shipped config is refused with \"edit .agents/config.yaml yourself\" (exhaustive)", async () => {
  // the dotted keys of the shipped file that hold a value (no key below them); read here, not through the core, so this hook test imports no core module
  /** @type {string[]} */ const all = []; /** @type {string[]} */ const P = [];
  for (const l of readFileSync(join(repo, 'control-plane/agents/config.yaml'), 'latin1').split('\n')) {
    if (/^\s*(#|$)/.test(l) || /^\s*-(\s|$)/.test(l) || !l.includes(':')) continue;
    const ind = l.search(/[^ ]/); P.length = Math.floor(ind / 2); P.push(l.slice(ind, l.indexOf(':', ind)));
    all.push(P.join('.'));
  }
  const keys = [...new Set(all)].filter((k) => !all.some((x) => x.startsWith(`${k}.`)));
  assert.ok(keys.length > 150 && keys.includes('codex.sandbox.network') && keys.includes('commands.test') && !keys.includes('codex.sandbox'), String(keys.length));
  for (const k of keys) {
    const r = await pre(`proofline config ${k} 1`, {}, {});
    if (AGENT_CONFIG_KEYS.includes(k)) assert.ok(r === null || !DENIED.test(r), `${k}: ${r}`);
    else assert.ok(r !== null && r.includes(`${k} is the user's setting`) && r.includes('edit .agents/config.yaml yourself'), `${k}: ${r}`);
  }
  for (const c of [...SPELLINGS('codex.sandbox.failover', 'claude'), ...SPELLINGS('commands.lint', 'none'), 'proofline config --x codex.sandbox.network on']) {
    const r = await pre(c, {}, {});
    assert.ok(r !== null && /the user's setting/.test(r), `${c}: ${r}`);
  }
  for (const c of [...READS, ...SPELLINGS('timeouts.warn_percent', '70')]) { const r = await pre(c, {}, {}); assert.ok(r === null || !DENIED.test(r), `${c}: ${r}`); }
});
