// @ts-check
// Scenario cases of the ten commands that move to Node in stage 1: role, config-get, config-check, timeouts, hook-timeouts, verify-timeout,
// tm-scaled, db-config, hook-config, help. Each case is a fixture plus a list of calls; the rig runs it on both engines and compares.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedFixture } from '../fixture.mjs';

/** @typedef {import('../rig.mjs').Case} Case */
/** @typedef {import('../rig.mjs').Step} Step */

export const MOVED = Object.freeze(['role', 'config-get', 'config-check', 'timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled', 'db-config', 'hook-config', 'help']);
const baseConfig = () => readFileSync(join(installedFixture().dir, '.agents/config.yaml'), 'utf8');

/** A config.yaml step: each [from, to] replaces its first occurrence; extra text is appended. */
const config = (/** @type {[string, string][]} */ edits, extra = '') => {
  let t = baseConfig(); for (const [a, b] of edits) { if (!t.includes(a)) throw new Error(`config.yaml has no ${JSON.stringify(a)}`); t = t.replace(a, b); }
  return /** @type {Step} */ ({ write: { path: '.agents/config.yaml', content: t + extra } });
};
const A = (/** @type {string[]} */ args, /** @type {Partial<Step>} */ o = {}) => /** @type {Step} */ ({ args, ...o });
const fx = () => installedFixture();
/** @param {string} name @param {Step[]} steps @returns {Case} */
const mk = (name, steps) => ({ name, fixture: fx(), steps });

const ROLES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier',
  'full_lifecycle', 'implementation_worker', 'independent_reviewer', 'independent_qa', 'independent_verifier', 'bogus', 'Lead', 'lead ', '../lead'];
const BLOCK_LIST = 'commands:\n  build:\n    - npm run build\n    - "dotnet build App.slnx"\n  test: go test ./...\n  lint:\n    - eslint .\n    - eslint .\n';

/** @returns {Case[]} */
export function movedCommandCases() {
  return [
    mk('role: default, every role, aliases, invalid, empty', [A(['role']), ...ROLES.map((r) => A(['role'], { role: r })), A(['role'], { env: { AGENT_ROLE: '' } }), A(['role', 'extra', 'args'])]),
    mk('role: the gate on a role denies a command before it runs', [
      A(['role'], { role: 'bogus' }), A(['config-get', 'profile'], { role: 'bogus' }), A(['start', 'X1'], { role: 'reviewer' }), A(['start', 'X1'], { role: 'implementer' }),
      A(['next'], { role: 'explorer' }), A(['bogus-command'], { role: 'lead' }), A([], { role: 'lead' }), A([''], { role: 'lead' })]),
    mk('config-get: keys, nesting, missing key, no argument, quotes, empty values', [
      A(['config-get', 'profile']), A(['config-get', 'timeouts.scale']), A(['config-get', 'hook.lock_wait_seconds']), A(['config-get', 'database.paths']),
      A(['config-get', 'nope']), A(['config-get', 'timeouts']), A(['config-get', 'timeouts.nope']), A(['config-get']), A(['config-get', '']), A(['config-get', 'a', 'b']),
      A(['config-get', 'profile'], { role: 'verifier' }), A(['config-get', 'profile'], { role: 'bogus' }), A(['config-get', '.profile']), A(['config-get', 'profile.'])]),
    mk('config-get: block lists under commands.*, quotes, comments, octal-looking numbers', [
      config([], BLOCK_LIST.replace(/^commands:\n/, '').replace(/^/, '')),
      A(['config-get', 'commands.build.0']), A(['config-get', 'commands.build.1']), A(['config-get', 'commands.build.2']), A(['config-get', 'commands.build']), A(['config-get', 'commands.test']),
      A(['config-get', 'commands.lint.1'])]),
    mk('config-get: a config with CRLF, tabs, trailing comments, single and double quotes, 08 and 010', [
      { write: { path: '.agents/config.yaml', content: 'profile: "max"   # comment\r\ncanonical_branch: \'trunk\'\ntimeouts:\n  scale: 010\n  warn_percent: 08\nhook:\n  lock_wait_seconds: "0012"\n\tbad: tab\ntasks:\n  dir: "tasks # not a comment"\n  status_block_seconds: 007\n' } },
      A(['config-get', 'profile']), A(['config-get', 'canonical_branch']), A(['config-get', 'timeouts.scale']), A(['config-get', 'timeouts.warn_percent']), A(['config-get', 'hook.lock_wait_seconds']),
      A(['config-get', 'tasks.dir']), A(['config-check']), A(['timeouts']), A(['hook-config']), A(['tm-scaled', '0010', '1', '9999'])]),
    mk('config-get: config.yaml absent or empty', [
      { exec: ['rm', '-f', '.agents/config.yaml'] }, A(['config-get', 'profile']), A(['config-check']), A(['timeouts']), A(['hook-timeouts']), A(['verify-timeout']), A(['tm-scaled', '30']), A(['db-config']), A(['hook-config']),
      { write: { path: '.agents/config.yaml', content: '' } }, A(['config-get', 'profile']), A(['config-check']), A(['timeouts']), A(['db-config', 'paths']), A(['hook-config'])]),
    mk('config-check: the shipped file, an explicit file, a missing file, no argument forms', [
      A(['config-check']), A(['config-check', '.agents/config.yaml']), A(['config-check', '/nonexistent/config.yaml']), A(['config-check', '']), A(['config-check', 'a', 'b']), A(['config-check'], { role: 'qa' })]),
    mk('config-check: every kind of invalid value and key', [
      config([['profile: balanced', 'profile: huge']]), A(['config-check']),
      config([['  scale: 1.0', '  scale: x']]), A(['config-check']),
      config([['  warn_percent: 80', '  warn_percent: 20']]), A(['config-check']),
      config([], 'zzz_unknown: 1\n'), A(['config-check']),
      config([], 'commands:\n  build: [a, b]\n'), A(['config-check']),
      config([], 'commands:\n  lint:\n    - eslint .\n    - eslint .\n'), A(['config-check']),
      config([], 'risk:\n  Bad Name:\n    check: contract\n'), A(['config-check']),
      config([], 'default_topology: weird\nfailover: sometimes\n'), A(['config-check']),
      config([], 'review:\n  max_fix_rounds: many\n  waiver_followup: maybe\n'), A(['config-check']),
      config([], 'git:\n  platform_host: "http://x:80/y"\n  push_requires_approval: sure\n'), A(['config-check']),
      config([], 'design_docs:\n  design: a.md\n  design.surfaces.ui: b.md\n'), A(['config-check']),
      A(['config-check', '.agents/config.yaml'])]),
    mk('timeouts: default, scale, bad scale, warn_percent, octal-looking knob, role, extra argument', [
      A(['timeouts']), config([['  scale: 1.0', '  scale: 2.5']]), A(['timeouts']), config([['  scale: 1.0', '  scale: abc']]), A(['timeouts']),
      config([['  warn_percent: 80', '  warn_percent: 099'], ['  lock_wait_seconds: 8', '  lock_wait_seconds: 08']]), A(['timeouts']), A(['timeouts', 'extra'], { role: 'designer' }),
      A(['timeouts'], { env: { PROOFLINE_LOCK_TIMEOUT: '7' } })]),
    mk('hook-timeouts: default, scaled, out of bounds, the prompt floor, a bad value', [
      A(['hook-timeouts']), config([['  scale: 1.0', '  scale: 3'], ['  session_timeout_seconds: 30', '  session_timeout_seconds: 5']]), A(['hook-timeouts']),
      config([['  prompt_timeout_seconds: 30', '  prompt_timeout_seconds: 9999'], ['  approve_budget_seconds: 20', '  approve_budget_seconds: 25']]), A(['hook-timeouts']),
      config([['  stop_timeout_seconds: 30', '  stop_timeout_seconds: abc'], ['  subagent_stop_timeout_seconds: 120', '  subagent_stop_timeout_seconds: 0120']]), A(['hook-timeouts', 'x'])]),
    mk('verify-timeout: default, scaled, bounds, a bad value', [
      A(['verify-timeout']), config([['  scale: 1.0', '  scale: 2']]), A(['verify-timeout']), config([], 'verification:\n  command_timeout_seconds: 30\n'), A(['verify-timeout']),
      config([], 'verification:\n  command_timeout_seconds: 999999\n'), A(['verify-timeout']), config([], 'verification:\n  command_timeout_seconds: soon\n'), A(['verify-timeout']),
      config([], 'verification:\n  command_timeout_seconds: 0060\n'), A(['verify-timeout']), A(['verify-timeout', '1'])]),
    mk('tm-scaled: arguments, bounds, octal-looking numbers, scales, bad input', [
      A(['tm-scaled', '10']), A(['tm-scaled', '10', '2', '5']), A(['tm-scaled', '1', '7']), A(['tm-scaled', '0010']), A(['tm-scaled', '08']), A(['tm-scaled', '09', '1', '100']), A(['tm-scaled', '0']),
      A(['tm-scaled', '99999']), A(['tm-scaled', '99999', '1', '70000']), A(['tm-scaled']), A(['tm-scaled', 'x']), A(['tm-scaled', '-3']), A(['tm-scaled', '1.5']), A(['tm-scaled', '']),
      A(['tm-scaled', '5', 'a']), A(['tm-scaled', '5', '1', 'b']), A(['tm-scaled', '5', '9', '3']), A(['tm-scaled', '120', '1', '3600']), A(['tm-scaled', '10'], { role: 'reviewer' }),
      config([['  scale: 1.0', '  scale: 1.5']]), A(['tm-scaled', '7']), A(['tm-scaled', '7', '1', '8']), config([['  scale: 1.0', '  scale: 0.5']]), A(['tm-scaled', '7']), A(['tm-scaled', '1']),
      config([['  scale: 1.0', '  scale: 0.333']]), A(['tm-scaled', '1000']), config([['  scale: 1.0', '  scale: bad']]), A(['tm-scaled', '7'])]),
    mk('db-config: each key, all, default, overrides, bad key, no argument', [
      A(['db-config']), A(['db-config', 'all']), A(['db-config', 'paths']), A(['db-config', 'clients']), A(['db-config', 'migrate_commands']), A(['db-config', 'nope']), A(['db-config', '']), A(['db-config', 'paths', 'extra']),
      config([['  paths: "*.db', '  paths: "*.x *.db']]), A(['db-config', 'paths']), A(['db-config']),
      config([], 'database:\n  clients: ""\n'), A(['db-config', 'clients']), config([], 'database:\n  migrate_commands: \'a, b\'\n'), A(['db-config']), A(['db-config'], { role: 'security_reviewer' })]),
    mk('hook-config: default, with tasks.dir, canonical_branch, product.dir and knobs, an empty file', [
      A(['hook-config']), config([['  approve_budget_seconds: 20', '  approve_budget_seconds: 99']]), A(['hook-config']),
      config([['  next_budget_seconds: 10', '  next_budget_seconds: 0']]), A(['hook-config']), config([['  lock_wait_seconds: 8', '  lock_wait_seconds: x']]), A(['hook-config']),
      config([], 'tasks:\n  dir: work/tasks\nproduct:\n  dir: docs/product\ncanonical_branch: trunk\n'), A(['hook-config']), A(['hook-config', 'ignored']), A(['hook-config'], { role: 'reviewer' }),
      { write: { path: '.agents/config.yaml', content: '' } }, A(['hook-config'])]),
    mk('help: help, no command, unknown command, flags', [
      A(['help']), A([]), A(['bogus']), A(['--help']), A(['-h']), A(['help', 'role']), A(['help'], { role: 'explorer' }), A(['help'], { role: 'bogus' }), A(['Help']), A(['HELP'])]),
  ];
}
