// @ts-check
// A376 (issue 338 U5): `proofline config <key> <value>` changes .agents/config.yaml. The PreToolUse hook does not parse the arguments by position: a command that names
// `proofline` and `config` as words is allowed only in the one plain form, `proofline config [<key>]` (a read, every session) or, for the lead's own session,
// `proofline config <agent key> <digits>`; everything else is refused (security review round 1 reproduced redirections, `!`, `if`, `xargs` and continuation lines that the
// positional reader missed). The hook only judges the command text; nothing is executed. The lead and specialist tables are exhaustive over the keys of the shipped config.
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
const { AGENT_CONFIG_KEYS, configCommandVerdict } = await import(pathToFileURL(join(hookDir, 'guards/bash.mjs')).href);

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

/** the spellings of one set, KEY and VALUE in place: wrappers, quotes, and the forms the security review reproduced (redirections, `!`, `if`, `xargs`, continuation lines) */
const SPELLINGS = (/** @type {string} */ k, /** @type {string} */ v) => [
  `proofline config ${k} ${v}`, `bin/proofline config ${k} ${v}`, `/opt/p/bin/proofline config ${k} "${v}"`, `proofline config "${k}" '${v}'`, `cd . && proofline config ${k} ${v}`,
  `echo ok; proofline config ${k} ${v}`, `env PL_HOME=/x proofline config ${k} ${v}`, `FOO=1 proofline config ${k} ${v}`, `sudo proofline config ${k} ${v}`, `sh -c 'proofline config ${k} ${v}'`,
  `(proofline config ${k} ${v})`, `true | proofline config ${k} ${v}`, `npx proofline config ${k} ${v}`, `node ./bin/proofline.mjs config ${k} ${v}`, `timeout 9 proofline config ${k} ${v}`,
  `proofline "config" ${k} ${v}`, `pro"of"line config ${k} ${v}`, `proofline config ${k} ${v} extra words`,
  // security review round 1: each of these set the key end to end before
  `proofline 2>/dev/null config ${k} ${v}`, `proofline >x config ${k} ${v}`, `proofline config 2>&1 ${k} ${v}`, `! proofline config ${k} ${v}`, `if true; then proofline config ${k} ${v}; fi`,
  `[ 1 ] && proofline config ${k} ${v}`, `echo ${k} ${v} | xargs proofline config`, `echo ${k} ${v} | env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID xargs proofline config`,
  `proofline config \\\n ${k} ${v}`, `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u AGENT_ROLE proofline config ${k} ${v}`,
  `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT proofline config \\\n ${k} ${v}`, `proofline config ${k}\t${v}`, `proofline config <<<"" ${k} ${v}`, `proofline config $'${k}' ${v}`,
  `proofline config ${k} ${v} # x`, `nice -n 5 proofline config ${k} ${v}`, `node node_modules/.bin/proofline config ${k} ${v}`, `node .agents/scripts/proofline.mjs config ${k} ${v}`,
  `exec -a x proofline config ${k} ${v}`, `proofline  config ${k} ${v}`, `proofline config ${k} ${v};`, `proofline config ${k} ${v}\necho done`, `pro\\\nofline config ${k} ${v}`,
];
/** reads in the one plain form: allowed for every session */
const READS = ['proofline config', 'proofline config codex.sandbox.network', 'bin/proofline config commands.test', '/opt/p/bin/proofline config git.push_requires_approval', ' proofline config output_cap_bytes '];
/** commands that do not name both words as words: never this rule's business */
const OTHERS = ['proofline status', 'proofline doctor --config', 'git config user.name', 'cat .git/config && proofline status', 'cat .agents/config.yaml', 'ls /work/proofline/ && git config -l', 'grep -rn configuration docs', 'cat proofline-config.md'];
const DENIED = /names proofline and config/;

test('configCommandVerdict: every set spelling is refused for a specialist and for the lead; the plain reads and agent-key sets pass; other commands are not judged', () => {
  for (const c of SPELLINGS('codex.sandbox.network', 'on')) {
    assert.equal(configCommandVerdict(c, true), 'read-only', c);
    assert.equal(configCommandVerdict(c, false), 'user-key', c);
  }
  for (const c of SPELLINGS('output_cap_bytes', '8000')) assert.equal(configCommandVerdict(c, true), 'read-only', c);
  for (const c of SPELLINGS('output_cap_bytes', '8000').slice(1)) if (!c.startsWith('bin/') && !c.startsWith('/opt/')) assert.equal(configCommandVerdict(c, false), 'user-key', c);
  for (const c of READS) { assert.equal(configCommandVerdict(c, true), '', c); assert.equal(configCommandVerdict(c, false), '', c); }
  for (const c of OTHERS) { assert.equal(configCommandVerdict(c, true), '', c); assert.equal(configCommandVerdict(c, false), '', c); }
  for (const k of AGENT_CONFIG_KEYS) {
    assert.equal(configCommandVerdict(`proofline config ${k} 70`, false), '', k);
    assert.equal(configCommandVerdict(`bin/proofline config ${k} 70`, false), '', k);
    for (const c of [`proofline config ${k} 70 x`, `proofline config ${k} on`, `proofline config ${k} 70; true`, `proofline 2>&1 config ${k} 70`, `proofline config ${k} -1`, `proofline config ${k} "70"`]) assert.equal(configCommandVerdict(c, false), 'user-key', c);
  }
  // a mention of both words outside the plain form fails closed too
  for (const c of ['echo proofline config codex.sandbox.network on', 'git commit -m "proofline config notes"']) assert.equal(configCommandVerdict(c, false), 'user-key', c);
});

for (const [name, who, env] of SPECIALISTS) {
  test(`${name}: every spelling of a config set is refused, an agent key included; a plain read is not`, async () => {
    for (const [k, v] of [['codex.sandbox.network', 'on'], ['commands.test', 'x'], ['output_cap_bytes', '8000']]) {
      for (const c of SPELLINGS(k, v)) {
        const r = await pre(c, who, env);
        assert.ok(r !== null, `${c} was allowed`);   // refused by this rule, or earlier by another (node on .agents/scripts)
      }
    }
    for (const c of [...READS, ...OTHERS]) { const r = await pre(c, who, env); assert.ok(r === null || !DENIED.test(r), `${c}: ${r}`); }
  });
}

test("BOUNDARY: every key of the shipped config: the lead sets only the agent keys with a number, a specialist none; the refusal says \"edit .agents/config.yaml yourself or run this in your own terminal\" (exhaustive)", async () => {
  // the dotted keys of the shipped file that hold a value (no key below them); read here, not through the core, so this hook test imports no core module
  /** @type {string[]} */ const all = []; /** @type {string[]} */ const P = [];
  for (const l of readFileSync(join(repo, 'control-plane/agents/config.yaml'), 'latin1').split('\n')) {
    if (/^\s*(#|$)/.test(l) || /^\s*-(\s|$)/.test(l) || !l.includes(':')) continue;
    const ind = l.search(/[^ ]/); P.length = Math.floor(ind / 2); P.push(l.slice(ind, l.indexOf(':', ind)));
    all.push(P.join('.'));
  }
  const keys = [...new Set(all)].filter((k) => !all.some((x) => x.startsWith(`${k}.`)));
  assert.ok(keys.length > 150 && keys.includes('codex.sandbox.network') && keys.includes('commands.test') && !keys.includes('codex.sandbox'), String(keys.length));
  const [, sWho, sEnv] = SPECIALISTS[0];
  for (const k of keys) {
    for (const v of ['1', 'on']) {
      const r = await pre(`proofline config ${k} ${v}`, {}, {});
      if (AGENT_CONFIG_KEYS.includes(k) && v === '1') assert.ok(r === null || !DENIED.test(r), `${k}: ${r}`);
      else assert.ok(r !== null && DENIED.test(r) && r.includes("is the user's setting") && r.includes('edit .agents/config.yaml yourself or run this in your own terminal'), `${k} ${v}: ${r}`);
    }
    const s = await pre(`proofline config ${k} 1`, sWho, sEnv);
    assert.ok(s !== null && /a specialist only reads the config/.test(s), `specialist ${k}: ${s}`);
    const read = await pre(`proofline config ${k}`, sWho, sEnv);
    assert.ok(read === null || !DENIED.test(read), `specialist read ${k}: ${read}`);
  }
  for (const c of [...SPELLINGS('codex.sandbox.failover', 'claude'), ...SPELLINGS('commands.lint', 'none'), ...SPELLINGS('timeouts.warn_percent', '70').slice(3)]) {
    const r = await pre(c, {}, {});
    assert.ok(r !== null, `${c} was allowed`);
  }
  for (const c of [...READS, ...OTHERS, 'proofline config timeouts.warn_percent 70', 'bin/proofline config output_cap_bytes 9000']) { const r = await pre(c, {}, {}); assert.ok(r === null || !DENIED.test(r), `${c}: ${r}`); }
});
