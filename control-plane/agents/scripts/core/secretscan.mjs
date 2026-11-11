// @ts-check
// Stage 4, package 4C: the secret scan of the SECRETS gate (scripts/secret-scan.sh of 0.0.47, moved into the core). Never prints a secret value:
// a finding is `path:line:rule`. Config `commands.secret_scan` (a project command) decides when set; otherwise the built-in rules below run over the
// files (directories recursively, `.git` skipped, symbolic links skipped, binary files skipped). A line with `proofline:allow-secret` is never reported.
// While the project has `.agents/scripts/secret-scan.sh` (only a fixture that writes one), the core runs it as the shell always did (D14: no
// environment seam; the installer does not ship the file any more).
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WS = ' \\t\\n\\v\\f\\r';
const ALLOW = 'proofline:allow-secret';

/** The built-in rules: name and ERE (as a JS expression over latin1 bytes). @type {Array<[string, RegExp]>} */
const RULES = [
  ['aws_access_key_id', new RegExp('(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}')],
  ['aws_secret_access_key', new RegExp(`aws_?secret_?access_?key[^=:]{0,20}[=:][${WS}]*["']?[A-Za-z0-9/+=]{40}`, 'i')],
  ['github_token', new RegExp('(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})')],
  ['gitlab_token', new RegExp('glpat-[A-Za-z0-9_-]{20,}')],
  ['slack_token', new RegExp('(xox[abposr]-[A-Za-z0-9-]{10,}|hooks\\.slack\\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+)')],
  ['private_key', new RegExp('-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----')],
  ['jwt', new RegExp('eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}')],
];
/** The generic assignment: the quoted value must look random. */
const GENERIC = new RegExp(`(api[_-]?key|secret|passw(or)?d|token|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["']?[${WS}]*(:=|=|:)[${WS}]*["'][^"'${WS}]{16,}["']`, 'i');
/** The value of an assignment as the awk step reads it (leftmost match). */
const ASSIGN = new RegExp(`(:=|=|:)[ \\t]*["'][^"' \\t]+["']`);
const ENV_LINE = new RegExp(`^[${WS}]*(export[${WS}]+)?[A-Za-z_][A-Za-z0-9_]*=[^${WS}#]`);

/** Shannon entropy in bits per character of a string. @param {string} v */
function entropy(v) {
  /** @type {Map<string, number>} */ const cnt = new Map();
  for (const c of v) cnt.set(c, (cnt.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of cnt.values()) { const q = n / v.length; h -= q * Math.log(q) / Math.log(2); }
  return h;
}

/** Whether a generic-assignment line holds a random-looking value (the awk step of secret-scan.sh). @param {string} content */
function genericHit(content) {
  const m = ASSIGN.exec(content);
  if (m === null) return false;
  let v = m[0].replace(/^[^"']*["']/, '').replace(/["']$/, '');
  if (v.length < 16 || /^[$<{%]/.test(v) || !/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return entropy(v) >= 3.5;
}

/**
 * Does one line of text hold a secret by the built-in rules (a known token shape, or a quoted random-looking value)? For text that is about to be shown or recorded.
 * @param {string} line
 */
export function lineHoldsSecret(line) {
  return RULES.some(([, re]) => re.test(line)) || (GENERIC.test(line) && genericHit(line));
}

/**
 * Every regular file below the given path (a symbolic link is neither followed nor listed), `.git` pruned.
 * @param {string} root @param {string} rel @param {string[]} out @param {string[]} errors the paths that could not be read (the scan then fails)
 */
function walk(root, rel, out, errors) {
  const base = rel.replace(/\/+$/, '').split('/').pop() ?? '';
  if (base === '.git') return;
  let st;
  try { st = lstatSync(`${root}/${rel}`); } catch { errors.push(rel); return; }
  if (st.isFile()) { out.push(rel); return; }
  if (!st.isDirectory()) return;
  let names = [];
  try { names = readdirSync(`${root}/${rel}`); } catch { errors.push(rel); return; }
  const pre = rel.endsWith('/') ? rel : `${rel}/`;
  for (const n of names) walk(root, `${pre}${n}`, out, errors);
}

/** The project's `commands.secret_scan` of `.agents/config.yaml` under the root (the awk step of secret-scan.sh). @param {string} root */
function configuredCommand(root) {
  const file = `${root}/.agents/config.yaml`;
  if (!isFile(file)) return '';
  let inCommands = false;
  for (const l of readFileSync(file, 'latin1').split('\n')) {
    if (l.startsWith('commands:')) { inCommands = true; continue; }
    if (/^[^ #]/.test(l)) inCommands = false;
    if (inCommands && l.startsWith('  secret_scan:')) return l.replace(/^ {2}secret_scan:[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r]+#.*$/, '');
  }
  return '';
}

/**
 * The scan: `secret-scan.sh [--root DIR] <path>...` as a function. Paths are relative to the root. Status 0 clean, 1 found, 2 error.
 * @param {Context} ctx @param {string} root @param {string[]} paths @returns {{ status: number, stdout: string, stderr: string }}
 */
export function builtinScan(ctx, root, paths) {
  let rootOk = false;
  try { rootOk = statSync(root).isDirectory(); } catch { /* none */ }
  if (!rootOk) return { status: 2, stdout: '', stderr: `secret-scan: no such directory: ${root}\n` };
  const cmd = configuredCommand(root);
  if (cmd !== '') {
    // the configured command is the user's own string (runUserCommand); the paths follow it as quoted words, what `"$@"` expanded to
    const r = proc.runUserCommand(`${cmd}${paths.map((p) => ` '${p.replace(/'/g, "'\\''")}'`).join('')}`, { cwd: root, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0 || r.status === 1) return { status: r.status, stdout: r.stdout.toString('latin1'), stderr: r.stderr.toString('latin1') };
    return { status: 2, stdout: '', stderr: `${r.stderr.toString('latin1')}secret-scan: commands.secret_scan failed (exit ${r.status})\n` };
  }
  for (const p of paths) {
    let there = false;
    try { statSync(`${root}/${p}`); there = true; } catch { /* missing */ }
    if (!there) return { status: 2, stdout: '', stderr: `secret-scan: no such path: ${p}\n` };
  }
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const unreadable = [];
  for (const p of paths) walk(root, p, files, unreadable);
  const found = new Set();
  for (const f of files) {
    let buf;
    try { buf = readFileSync(`${root}/${f}`); } catch { unreadable.push(f); continue; }
    const base = f.split('/').pop() ?? '';
    const env = (base === '.env' || base.startsWith('.env.')) && !/\.(example|sample|template)$/.test(base);
    // as grep -I: the head of the file decides, a NUL further in does not hide a secret before it
    const binary = buf.subarray(0, 8192).includes(0);
    if (binary && !env) continue;
    const text = buf.toString('latin1');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (binary) { found.add(`${f}:1:env_file`); continue; } // a binary .env file cannot be read: the safe side
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rec = (/** @type {string} */ rule) => { if (!`${f}:${i + 1}:${line}`.includes(ALLOW)) found.add(`${f}:${i + 1}:${rule}`); };
      for (const [name, re] of RULES) if (re.test(line)) rec(name);
      if (GENERIC.test(line) && genericHit(line)) rec('generic_secret');
      if (env && ENV_LINE.test(line)) rec('env_file');
    }
  }
  // an in-scope file that cannot be read is never skipped: the scan fails closed and names it
  if (unreadable.length > 0) return { status: 2, stdout: '', stderr: `secret-scan: cannot read: ${unreadable.join(' ')}\n` };
  if (found.size === 0) return { status: 0, stdout: '', stderr: '' };
  const out = [...found].map((l) => l.replace(/^\.\//, '')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { status: 1, stdout: [...new Set(out)].map((l) => `${l}\n`).join(''), stderr: '' };
}

/**
 * The scanner of this project over paths of THIS tree. A project script `.agents/scripts/secret-scan.sh` (the main tree's copy, the trusted one)
 * runs as it always did; without one the built-in scan runs in process.
 * @param {Context} ctx @param {string[]} paths @returns {{ status: number, stdout: Buffer, stderr: Buffer }}
 */
export function runSecretScan(ctx, paths) {
  const script = `${ctx.trustedScripts}/secret-scan.sh`;
  if (isFile(script)) {
    const r = proc.runScript([script, '--root', ctx.root, ...paths], { cwd: ctx.root, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const r = builtinScan(ctx, ctx.root, paths);
  return { status: r.status, stdout: Buffer.from(r.stdout, 'latin1'), stderr: Buffer.from(r.stderr, 'latin1') };
}
