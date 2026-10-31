// @ts-check
// The ten commands moved in stage 1: role, config-get, config-check, timeouts, hook-timeouts, verify-timeout, tm-scaled, db-config,
// hook-config, help. Each one keeps its arguments, stdout, stderr, exit code and files exactly as in agent.sh 0.0.40. An input whose
// shell behaviour is an implementation-specific error text throws BridgeToShell before any output; the entry then runs the shell code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bytes, configGetFrom } from '../config.mjs';
import { configLines, dec0 } from '../config.mjs';
import { BridgeToShell, fail } from '../errors.mjs';
import { isFile } from '../paths.mjs';
import * as proc from '../proc.mjs';
import { hookKnob, hookTimeouts, timeoutsInfo, tmScaled, verifyCommandTimeout } from '../timeouts.mjs';
import { checkConfigLines } from './config-check.mjs';
import { DB_CLIENTS_DEFAULT, DB_MIGRATE_DEFAULT, DB_PATHS_DEFAULT, USAGE_LINES } from './data.mjs';

/** @typedef {import('../context.mjs').Context} Context */

const DIGITS = /^[0-9]+$/;

/** The text of a byte string as an argument for a child (the bytes must be UTF-8, else the shell code decides). @param {string} s */
function toArg(s) {
  const back = Buffer.from(s, 'latin1').toString('utf8');
  if (bytes(back) !== s) throw new BridgeToShell('argument is not UTF-8');
  return back;
}

/** @param {Context} ctx */
function role(ctx) {
  ctx.out(`role=${ctx.role}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function configGet(ctx, args) {
  const raw = args[0] ?? '';
  // `${2:?usage}` prints a shell-specific error for a missing key; awk -v reads backslash escapes in the key
  if (raw === '' || raw.includes('\\') || !isFile(ctx.configFile)) throw new BridgeToShell('config-get shape');
  const key = bytes(raw);
  const v = ctx.config().getRaw(key);
  if (v === null) fail(`config key not found: ${key}`);
  ctx.out(`${v}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function configCheck(ctx, args) {
  const config = bytes(ctx.configFile);
  const file = bytes(args[0] ?? '') || config;
  const rel = file.startsWith(`${bytes(ctx.root)}/`) ? file.slice(bytes(ctx.root).length + 1) : file;
  const disk = path.resolve(ctx.cwd, Buffer.from(file, 'latin1').toString('utf8'));
  if (!isFile(disk)) fail(`config missing: ${file}`);
  let text;
  try { text = readFileSync(disk, 'latin1'); } catch { throw new BridgeToShell('config unreadable'); }
  const lines = configLines(text);
  const checked = checkConfigLines(lines);
  if (checked.ambiguous) throw new BridgeToShell('message order of an awk loop');
  let messages = checked.messages;
  if (messages.length === 0) {
    // The regular expressions are validated by the platform's own grep -E and awk, exactly as the shell does (a spawn each, counted)
    for (const key of ['validation.entry_words', 'validation.entry_candidates', 'validation.entry_input', 'validation.entry_new', 'validation.entry_output', 'validation.entry_skip', 'validation.code_patterns']) {
      const v = (configGetFrom(lines, key) ?? '').replace(/\n+$/, '');
      if (v === '') continue;
      const r = proc.run('grep', ['-Eq', '--', toArg(v)], { cwd: ctx.cwd, env: ctx.childEnv(), input: '', stdio: ['pipe', 'ignore', 'ignore'] });
      if (r.status >= 2) messages.push(`invalid regular expression for ${key}`);
    }
    // A162: risk.log_sensitive.content is matched by awk (risk_words_match), so awk is the one that must accept it
    const re = (configGetFrom(lines, 'risk.log_sensitive.content') ?? '').replace(/\n+$/, '');
    if (re !== '') {
      const r = proc.run('awk', ['BEGIN { "" ~ ENVIRON["RISK_RE"] }'], { cwd: ctx.cwd, env: { ...ctx.childEnv(), RISK_RE: toArg(re) }, stdio: ['ignore', 'ignore', 'ignore'] });
      if (r.status !== 0) messages.push('invalid regular expression for risk.log_sensitive.content');
    }
  }
  if (messages.length === 0) {
    ctx.out(`config valid: ${rel}\n`);
    const platform = `${ctx.scripts}/platform.sh`;
    if (file === config && isFile(platform)) {
      // the warning is the platform script's stdout, shown on stderr; its own stderr is dropped
      const r = proc.run('sh', [platform, 'warn', '-C', ctx.root], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      ctx.err(r.stdout.toString('latin1'));
    }
    return 0;
  }
  ctx.err(`${messages.join('\n')}\n`);
  fail(`config invalid: ${rel}`);
}

/** @param {Context} ctx */
function timeouts(ctx) { ctx.out(`${timeoutsInfo(ctx.config()).join('\n')}\n`); return 0; }

/** @param {Context} ctx */
function hookTimeoutsCommand(ctx) { ctx.out(`${hookTimeouts(ctx.config()).join('\n')}\n`); return 0; }

/** @param {Context} ctx */
function verifyTimeout(ctx) { ctx.out(`${verifyCommandTimeout(ctx.config())}\n`); return 0; }

/** @param {Context} ctx @param {string[]} args */
function tmScaledCommand(ctx, args) {
  const [n = '', lo = '', hi = ''] = args;
  const num = (/** @type {string} */ s) => DIGITS.test(s) && s.length <= 12;
  if (!num(n) || (lo !== '' && !num(lo)) || (hi !== '' && !num(hi))) throw new BridgeToShell('tm-scaled shape');
  ctx.out(`${tmScaled(ctx.config(), n, lo === '' ? 1 : Number(dec0(lo)), hi === '' ? 28800 : Number(dec0(hi)))}\n`);
  return 0;
}

/** `db_config SUB` @param {Context} ctx @param {string} sub */
function dbValue(ctx, sub) {
  const cfg = ctx.config();
  switch (sub) {
    case 'paths': return cfg.get('database.paths', DB_PATHS_DEFAULT);
    case 'clients': return cfg.get('database.clients', DB_CLIENTS_DEFAULT);
    case 'migrate_commands': return cfg.get('database.migrate_commands', DB_MIGRATE_DEFAULT);
    default: return fail('usage: agent.sh db-config <paths|clients|migrate_commands|all>');
  }
}

/** @param {Context} ctx @param {string} sub */
function dbAll(ctx, sub) {
  if (sub !== 'all') return `${dbValue(ctx, sub)}\n`;
  const t = (/** @type {string} */ s) => dbValue(ctx, s).replace(/\n+$/, '');
  return `paths=${t('paths')}\nclients=${t('clients')}\nmigrate_commands=${t('migrate_commands')}\n`;
}

/** @param {Context} ctx @param {string[]} args */
function dbConfig(ctx, args) {
  ctx.out(dbAll(ctx, args[0] === undefined || args[0] === '' ? 'all' : bytes(args[0])));
  return 0;
}

/** @param {Context} ctx */
function hookConfig(ctx) {
  const cfg = ctx.config();
  const t = (/** @type {string} */ k) => cfg.get(k, '').replace(/\n+$/, '');
  ctx.out(dbAll(ctx, 'all'));
  ctx.out(`tasks_dir=${t('tasks.dir')}\ncanonical_branch=${t('canonical_branch')}\nproduct_dir=${t('product.dir')}\n`);
  ctx.out(`approve_budget_seconds=${hookKnob(cfg, 'approve_budget_seconds', 20, 5, 25)}\nnext_budget_seconds=${hookKnob(cfg, 'next_budget_seconds', 10, 2, 20)}\nlock_wait_seconds=${hookKnob(cfg, 'lock_wait_seconds', 8, 1, 20)}\n`);
  return 0;
}

/** The usage text on stderr, exit 0 (`help`). @param {Context} ctx */
function help(ctx) {
  ctx.err(`${USAGE_LINES.join('\n')}\n`);
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const HANDLERS = {
  role,
  'config-get': configGet,
  'config-check': configCheck,
  timeouts,
  'hook-timeouts': hookTimeoutsCommand,
  'verify-timeout': verifyTimeout,
  'tm-scaled': tmScaledCommand,
  'db-config': dbConfig,
  'hook-config': hookConfig,
  help,
};
