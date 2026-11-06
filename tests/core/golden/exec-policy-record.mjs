// @ts-check
// Recorder of tests/core/golden/exec-policy/cases.json.gz (A222): the answers of the shell resolver scripts/exec-policy.sh of 0.0.52 for a corpus of
// calls, against a few config variants. The shell file is gone from the repository; recover it with
//   git show 910a96c9:control-plane/agents/scripts/exec-policy.sh > /tmp/exec-policy.sh
// and record with   node tests/core/golden/exec-policy-record.mjs /tmp/exec-policy.sh
// Re-record only for a reviewed change of the policy specification (an A entry); the Node resolver is held to this file by exec-policy.test.mjs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const here = import.meta.dirname;
const repo = path.resolve(here, '../../..');
const out = path.join(here, 'exec-policy');
const shellScript = process.argv[2];
if (!shellScript) { console.error('usage: node exec-policy-record.mjs <path of the old exec-policy.sh>'); process.exit(2); }

/** The blocks of the real config the resolver reads. */
function base() {
  const text = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'utf8');
  const keep = new Set(['profile', 'runtime', 'budgets', 'execution_policy', 'capabilities']);
  /** @type {string[]} */ const lines = [];
  let on = false;
  for (const l of text.split('\n')) {
    const m = /^([a-z_]+):/.exec(l);
    if (m) on = keep.has(m[1]);
    if (on || (/^(#|\s*$)/.test(l) && on)) lines.push(l);
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}
const b = base();
/** @type {Record<string, string>} */
const CONFIGS = {
  base: b,
  'profile-max': b.replace('profile: balanced', 'profile: max'),
  'profile-bad': b.replace('profile: balanced', 'profile: zzz'),
  'profile-none': b.replace('profile: balanced\n', ''),
  'role-codex': b.replace('  roles:\n', '  roles:\n    implementer: codex\n    qa: "codex"  # a quoted value with a comment\n'),
  'no-capabilities': b.replace(/capabilities:[\s\S]*$/, ''),
  'capability-bad': b.replace('    haiku: 1', '    haiku: x'),
  'no-lead-base': b.replace(/ {2}lead_base_model:\n {4}codex: [^\n]*\n/, ''),
  'esc-0': b.replace('max_escalations: 2', 'max_escalations: 0'),
  'quoted-cap': b.replace('max_context_bytes: 262144', 'max_context_bytes: "30000"   # a low cap'),
};
const roles = (() => {
  const t = readFileSync(path.join(repo, 'control-plane/agents/roles.conf'), 'utf8');
  return t;
})();
mkdirSync(out, { recursive: true });
for (const [n, t] of Object.entries(CONFIGS)) writeFileSync(path.join(out, `config-${n}.yaml`), t);
writeFileSync(path.join(out, 'roles.conf'), roles);

const ALL_ROLES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier', 'bogus', 'full_lifecycle'];
const extras = [[], ['--profile', 'max'], ['--profile', 'economy'], ['--profile', 'zzz'], ['--runtime', 'codex'], ['--runtime', 'claude', '--runtime-reason', 'AUTOMATIC_FAILOVER'], ['--runtime-reason', 'AUTOMATIC_FAILOVER'],
  ['--runtime-reason', 'X'], ['--signal', 'large_diff'], ['--signal', 'large_diff', '--signal', 'fix_round_2'], ['--signal', 'ui_persuade'], ['--signal', 'bogus'],
  ['--escalations-used', '2', '--signal', 'large_diff'], ['--escalations-used', 'x'], ['--model', 'opus'], ['--model', 'haiku'], ['--model', 'nope'],
  ['--model', 'gpt-6-luna', '--runtime', 'codex'], ['--effort', 'max'], ['--effort', 'ultra'], ['--effort', 'zz'], ['--effort', 'low', '--signal', 'large_diff'],
  ['--context-bytes', '100'], ['--context-bytes', '0'], ['--context-bytes', '99999999'], ['--bogus', 'x'], ['--role'], ['--runtime', 'zzz'],
  ['--runtime', 'codex', '--model', 'gpt-6-sol', '--signal', 'critical_class', '--signal', 'low_confidence_pass']];
/** @type {Array<{ config: string, args: string[], stdin?: string }>} */ const corpus = [];
for (const r of ALL_ROLES) for (const c of ['TRIVIAL', 'STANDARD', 'COMPLEX', 'CRITICAL', 'NOPE']) for (const t of ['docs', 'full', 'x']) corpus.push({ config: 'base', args: ['resolve', '--role', r, '--class', c, '--tier', t] });
for (const r of ['implementer', 'designer', 'lead', 'security_reviewer', 'explorer', 'qa']) for (const c of ['STANDARD', 'CRITICAL']) for (const x of extras) corpus.push({ config: 'base', args: ['resolve', '--role', r, '--class', c, '--tier', 'small', ...x] });
for (const rt of ['claude', 'codex', 'zzz']) corpus.push({ config: 'base', args: ['lead-base', rt] });
for (const r of ALL_ROLES) corpus.push({ config: 'base', args: ['runtime', r] });
for (const x of [['--runtime', 'codex', '--model', 'gpt-6-luna'], ['--runtime', 'codex', '--model', 'gpt-6-sol'], ['--runtime', 'codex'], ['--runtime', 'claude'], ['--runtime', 'codex', '--model', 'zzz'], [], ['--bogus', '1']]) corpus.push({ config: 'base', args: ['check-lead', ...x] });
// (the usage text of an unknown operation names the script file and is not recorded)
corpus.push({ config: 'base', args: ['resolve', '--role', 'lead', '--class', 'STANDARD', '--tier', 'full', '--model'] });
for (const [n] of Object.entries(CONFIGS).filter(([k]) => k !== 'base')) {
  for (const r of ['implementer', 'designer', 'lead', 'qa', 'security_reviewer']) for (const c of ['STANDARD', 'CRITICAL']) corpus.push({ config: n, args: ['resolve', '--role', r, '--class', c, '--tier', 'full', '--signal', 'large_diff'] });
  for (const rt of ['codex', 'claude']) { corpus.push({ config: n, args: ['lead-base', rt] }); corpus.push({ config: n, args: ['check-lead', '--runtime', rt, '--model', rt === 'codex' ? 'gpt-6-luna' : 'opus'] }); }
  for (const r of ['implementer', 'qa', 'lead']) corpus.push({ config: n, args: ['runtime', r] });
}
corpus.push({ config: 'base', args: ['explain'], stdin: 'role=lead\nmodel_reason=ROLE_PROFILE,ESCALATED\nruntime_reason=AUTOMATIC_FAILOVER\ncontext_reason=CLASS_BUDGET,TIER_DOCS,ZZZ\nx=1\n' });
// a missing config and a missing roles file
corpus.push({ config: '(missing)', args: ['resolve', '--role', 'lead', '--class', 'STANDARD', '--tier', 'full'] });

const rolesFile = path.join(out, 'roles.conf');
const recorded = corpus.map((c) => {
  const cfg = c.config === '(missing)' ? path.join(out, 'no-such-config.yaml') : path.join(out, `config-${c.config}.yaml`);
  const r = spawnSync('sh', [shellScript, ...c.args], { env: { PATH: process.env.PATH, LC_ALL: 'C', EXEC_POLICY_CONFIG: cfg, EXEC_POLICY_ROLES: rolesFile }, input: c.stdin ?? '', encoding: 'utf8' });
  // the file name of the config is the recorder's own: the replay uses the same fixture folder, so it is written relative
  const rel = (/** @type {string} */ s) => s.split(out).join('<DIR>');
  return { ...c, status: r.status, stdout: rel(r.stdout), stderr: rel(r.stderr) };
});
writeFileSync(path.join(out, 'cases.json.gz'), gzipSync(JSON.stringify(recorded)));
console.log(`${recorded.length} cases recorded`);
