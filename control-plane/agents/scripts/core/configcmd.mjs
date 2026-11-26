// @ts-check
// `proofline config [<key> [<value>]]` (A376, issue 338 U5): list the settings of this project's .agents/config.yaml, show one, or set one. Setting a key keeps the file's
// comments, order and every other value (the line of the key is changed in place, its trailing comment kept; a missing key is inserted under its parent), accepts only a key
// of the shipped config that holds one value, checks the value's type against the shipped default and refuses a value `config-check` would report. The result is parsed again
// and written only when nothing but that key changed (the check of the upgrade merge, A371), through a temporary file and a rename.
//
// WHO SETS WHAT. Every key is the user's, except the three in AGENT_KEYS (they shape what the lead sees and when it is told, not a gate, an approval, a role, a model or a
// command). From an agent session (an agent marker in the environment, the `human` test of the git hooks) every other key is refused with "edit .agents/config.yaml
// yourself", and a specialist (AGENT_ROLE other than lead) sets nothing. This is a tripwire like the PreToolUse rule that refuses the same command text
// (adapters/claude/hooks/guards/bash.mjs, configSetDenial): an environment can be cleared, so the boundary is the user's review of the config change (A372).
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { configGetFrom, configLines } from './config.mjs';
import { mergeProblem, scanScalars } from './cfgcli.mjs';
import { checkConfigLines } from './commands/config-check.mjs';
import { closestKey } from './configkeys.mjs';
import { human } from './githooks.mjs';
import { isFile } from './paths.mjs';
import { latin1Buf } from './wirebytes.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The keys an agent session may set: output size and timing of what the lead is shown. Kept equal to AGENT_CONFIG_KEYS of the hook guard by a test. */
export const AGENT_KEYS = Object.freeze(['output_cap_bytes', 'tasks.status_block_seconds', 'timeouts.warn_percent']);

/** Why a key is the user's alone, by its first matching prefix; the rest of the file is the user's too (`default`). The doctor --config basics and A376 list the same. */
export const USER_ONLY_WHY = Object.freeze([
  ['codex.', 'the Codex sandbox permissions (network, local server, failover) are your decision (A372)'],
  ['commands.', 'the build, test, lint, install and secret-scan commands run on your machine; you write them (or approve the doctor --commands proposal)'],
  ['git.', 'pushes, protected branches, identities and commit rules are your decision'],
  ['approval.', 'the approval words are yours (Core invariant 3)'],
  ['safety.', 'the safety switches are yours'],
  ['security.', 'the security scans and the registry consent are yours (A373)'],
  ['runtime.', 'which runtime runs each role is your decision'],
  ['profile', 'the model profile decides the strength of every role'],
  ['failover', 'handing work to another runtime is your decision'],
  ['review.', 'the review bounds decide when a task stops and asks you'],
  ['test_trust.', 'the test review bounds decide how hard the tests are checked'],
  ['timeouts.scale', 'a new scale is written only after your "approve scale" (doctor --apply-scale)'],
  ['', 'it changes how the control plane checks, decides or records work; only you change it'],
]);

/** @param {string} key */
export const agentMay = (key) => AGENT_KEYS.includes(key);
/** @param {string} key */
export const whyUserOnly = (key) => (USER_ONLY_WHY.find(([p]) => key === p || (p !== '' && p.endsWith('.') && key.startsWith(p)) || p === '') ?? ['', ''])[1];

/** Who runs this command: `user` (no agent marker), `lead` (an agent session, the lead) or `specialist`. @param {NodeJS.ProcessEnv} env @returns {'user' | 'lead' | 'specialist'} */
export function caller(env) {
  if (human(env)) return 'user';
  const r = env.AGENT_ROLE ?? '';
  return r === '' || r === 'lead' ? 'lead' : 'specialist';
}

/** Keys of the shipped config that are maps with no entry yet (a role name goes below it). */
const MAPS = Object.freeze(['runtime.roles']);

/** @param {string} text @returns {string[]} */
function rowsOf(text) { const r = text.split('\n'); if (r[r.length - 1] === '') r.pop(); return r; }

/** The value for display: the scalar, or the items of a block list joined by `; `. @param {string[]} lines @param {string} key */
function shown(lines, key) { const v = configGetFrom(lines, key); return v === null ? null : v.split('\n').join('; '); }

/**
 * Is KEY a setting of the shipped config that holds one value (not a section, not a list item)? '' when it is, else why not.
 * @param {string[]} def configLines of the shipped config @param {string} key
 */
export function settable(def, key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/.test(key) || /\.[0-9]+(\.|$)/.test(key)) return `${key} is not a config key (dotted names such as review.max_fix_rounds)`;
  if (!def.some((l) => l.startsWith(`${key}=`))) return `unknown config key: ${key} (closest known key: ${closestKey(key)})`;
  if (MAPS.includes(key) || def.some((l) => l.startsWith(`${key}.`) && !/^[0-9]+=/.test(l.slice(key.length + 1)))) return `${key} is a section, not a setting: set one of its keys (proofline config lists them)`;
  return '';
}

/** The value is one line of plain text the reader gives back unchanged. '' when it is, else why not. @param {string} v */
function valueProblem(v) {
  if (/[\u0000-\u001f\u007f]/.test(v)) return 'the value has a control character or a line break; a list of commands is written in the file itself';
  if (v !== v.trim()) return 'the value starts or ends with a space';
  if (/^[-"'{[|>&*!%@`#?,]/.test(v)) return `a value that starts with ${v[0]} is read as YAML syntax; edit .agents/config.yaml yourself`;
  if (/[ \t]#/.test(v)) return 'a value with " #" would be cut there (the rest reads as a comment)';
  if (v.length > 2000) return 'the value is longer than 2000 bytes';
  return '';
}

/** The type of the shipped default decides the type of the value. @param {string} def @param {string} v */
function typeProblem(def, v) {
  if (/^[0-9]+$/.test(def) && !/^[0-9]+$/.test(v)) return `a whole number (the default is ${def})`;
  if (/^[0-9]+\.[0-9]+$/.test(def) && !/^[0-9]+(\.[0-9]+)?$/.test(v)) return `a number (the default is ${def})`;
  if ((def === 'true' || def === 'false') && v !== 'true' && v !== 'false') return 'true or false';
  return '';
}

/**
 * The text with KEY set to VALUE, or the reason it cannot be set safely. U uses `\n`.
 * @param {string} u @param {string} key @param {string} value @returns {{ text: string, why: string }}
 */
export function setInText(u, key, value) {
  const U = rowsOf(u);
  if (U.some((l) => /^ *\t/.test(l))) return { text: u, why: 'the file is indented with tabs; edit it yourself' };
  const sc = scanScalars(U);
  const item = (/** @type {string} */ l) => /^[ \t]*-([ \t]|$)/.test(l);
  const content = (/** @type {string} */ l) => !/^[ \t]*#/.test(l) && l.trim() !== '' && !item(l) && l.includes(':');
  /** @type {string[]} */ const P = [];
  /** @type {Map<string, number>} */ const at = new Map(); /** @type {Map<string, number>} */ const ends = new Map();
  let L = 0;
  /** @type {Set<string>} */ const dup = new Set();
  let shape = '';
  U.forEach((l, i) => {
    if (sc.body.has(i) || shape !== '') return;
    if (content(l)) {
      const ind = l.search(/[^ ]/);
      // the reader and this edit count two spaces per level: another indentation would put the key at another path (review finding 1)
      if (ind % 2 !== 0) { shape = `line ${i + 1} is indented by ${ind} spaces, not a multiple of two`; return; }
      L = ind / 2;
      if (L > P.length) { shape = `line ${i + 1} is indented deeper than one level below its parent`; return; }
      P.length = L; P[L] = l.slice(ind, l.indexOf(':', ind));
      if (P.some((s) => s === undefined || s.trim() === '')) { shape = `line ${i + 1} has an empty key`; return; }
      const p = P.join('.'); if (at.has(p)) dup.add(p); else at.set(p, i);
      for (let k = 0; k <= L; k++) ends.set(P.slice(0, k + 1).join('.'), i);
    } else if (item(l) && P.length > 0) for (let k = 0; k <= L; k++) ends.set(P.slice(0, k + 1).join('.'), i);
  });
  if (shape !== '') return { text: u, why: `${shape}; edit the file yourself` };
  const kp = key.split('.');
  // a key or a section that appears twice is read by its first occurrence: which one to change is the user's call (review finding 2)
  for (let k = 1; k <= kp.length; k++) {
    const p = kp.slice(0, k).join('.');
    if (dup.has(p)) return { text: u, why: `duplicate ${k === kp.length ? 'key' : 'section'} ${p} in the file (it appears more than once); edit the file yourself` };
  }
  const line = at.get(key);
  const out = [...U];
  if (line !== undefined) {
    const l = U[line];
    if (sc.anc.has(key)) return { text: u, why: `${key} holds a multi-line value; edit it in the file yourself` };
    if ((ends.get(key) ?? line) !== line) return { text: u, why: `${key} holds a list or keys below it; edit it in the file yourself` };
    const c = l.indexOf(':', l.search(/[^ ]/));
    const rest = l.slice(c + 1);
    const m = /^([ \t]*)(.*?)((?:[ \t]+#.*)?)$/.exec(rest);
    const old = m === null ? '' : m[2];
    const q = /^"/.test(old) ? '"' : /^'/.test(old) ? "'" : '';
    out[line] = `${l.slice(0, c + 1)}${value === '' && q === '' ? '' : ' '}${q}${value}${q}${m === null ? '' : m[3]}`;
  } else {
    let d = kp.length - 1;
    while (d > 0 && !at.has(kp.slice(0, d).join('.'))) d--;
    const parent = kp.slice(0, d).join('.');
    if (d > 0) {
      const pl = U[/** @type {number} */ (at.get(parent))];
      const pv = pl.slice(pl.indexOf(':', pl.search(/[^ ]/)) + 1).replace(/(^|[ \t])#.*$/, '').trim();
      if (pv !== '') return { text: u, why: `${parent} has a value (${pv}), so ${key} cannot go under it; edit the file yourself` };
      if (sc.anc.has(parent)) return { text: u, why: `the block ${parent} holds a multi-line value; edit the file yourself` };
    }
    /** @type {string[]} */ const add = [];
    for (let k = d; k < kp.length; k++) add.push(`${'  '.repeat(k)}${kp[k]}:${k === kp.length - 1 && value !== '' ? ` ${value}` : ''}`);
    if (d === 0) out.push(...add); else out.splice(/** @type {number} */ (ends.get(parent)) + 1, 0, ...add);
  }
  const text = `${out.join('\n')}\n`;
  const got = configGetFrom(configLines(text), key);
  if (got !== value) return { text: u, why: `the file would read ${key} as ${got === null ? 'absent' : `"${got}"`}, not "${value}"; edit it yourself` };
  // nothing else changed: the keys of before, minus the one set, are the same lines in the same order, and config-check reports nothing new
  const strip = (/** @type {string} */ t) => configLines(t).filter((l) => { const k = l.slice(0, l.indexOf('=')); return k !== key && !key.startsWith(`${k}.`); }).join('\n');
  if (strip(u) !== strip(text)) return { text: u, why: 'another key of the file would change; edit it yourself' };
  const fresh = checkConfigLines(configLines(text)).messages.filter((x) => !checkConfigLines(configLines(u)).messages.includes(x));
  if (fresh.length > 0) return { text: u, why: fresh[0] };
  const mp = mergeProblem(u, text);
  if (mp !== '' && !mp.startsWith('a value or the order')) return { text: u, why: mp };
  return { text, why: '' };
}

/** Write TEXT to FILE through a temporary file beside it and a rename (the mode is kept). @param {string} file @param {string} text */
function writeAtomic(file, text) {
  const tmp = `${file}.pl-${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, latin1Buf(text), { flag: 'wx' });
    try { chmodSync(tmp, statSync(file).mode & 0o7777); } catch { /* the default mode */ }
    renameSync(tmp, file);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/**
 * `proofline config [<key> [<value>]]`. TTY says whether standard input and standard output are a terminal: a user key is set only then (security review round 1: an agent
 * shell has no terminal, so clearing the agent markers of the environment is not enough; a pty wrapper such as `script` is the accepted limit of this tripwire, A376.1).
 * @param {Context} ctx @param {string[]} args @param {{ tty?: boolean }} [opt]
 */
export function configCli(ctx, args, opt = {}) {
  const tty = opt.tty === true;
  if (args.length > 2 || args.some((a) => a.startsWith('-'))) { ctx.err('usage: proofline config | proofline config <key> | proofline config <key> <value>\n'); return 2; }
  const file = ctx.configFile;
  const raw = readFileSync(file, 'latin1');
  const crlf = raw.includes('\r\n');
  // a file with CRLF and LF lines both: one ending would be imposed on every line (review finding 5), so a set is refused below
  const mixed = crlf && /(^|[^\r])\n/.test(raw);
  const u = raw.replace(/\r\n/g, '\n');
  const lines = configLines(u);
  const home = ctx.env.PL_HOME ?? '';
  const shipped = home === '' ? '' : `${home}/control-plane/agents/config.yaml`;
  const def = shipped !== '' && isFile(shipped) ? configLines(readFileSync(shipped, 'latin1')) : null;
  const who = (/** @type {string} */ k) => (agentMay(k) ? 'you, or the lead through proofline config' : `you only (${whyUserOnly(k)})`);
  if (args.length === 0) {
    ctx.out('the settings of this project (.agents/config.yaml); `proofline config <key>` shows one, `proofline config <key> <value>` sets one:\n');
    const seen = new Set();
    for (const l of lines) {
      const k = l.slice(0, l.indexOf('=')).replace(/(\.[0-9]+)+$/, '');
      if (seen.has(k) || lines.some((x) => x.startsWith(`${k}.`) && !/^[0-9]+=/.test(x.slice(k.length + 1)))) continue;
      seen.add(k);
      ctx.out(`${k}: ${shown(lines, k) || 'empty'}\n`);
    }
    ctx.out(`An agent session may set only ${AGENT_KEYS.join(', ')}; every other key is yours: set it here in your terminal or edit .agents/config.yaml yourself.\n`);
    return 0;
  }
  const key = args[0];
  if (def === null) { ctx.err('proofline config: the shipped config was not found (PL_HOME), so keys and types cannot be checked; nothing was read or written\n'); return 1; }
  const bad = settable(def, key);
  if (args.length === 1) {
    if (bad !== '' && !bad.endsWith('proofline config lists them')) { ctx.err(`proofline config: ${bad}\n`); return 1; }
    const now = shown(lines, key); const d = shown(def, key);
    ctx.out(`${key}: ${now === null ? 'not in your file, the default applies' : now || 'empty'}\n`);
    ctx.out(`default: ${d === null ? 'none' : d || 'empty'}\n`);
    ctx.out(`set by: ${who(key)}\n`);
    return 0;
  }
  const value = args[1];
  if (bad !== '') { ctx.err(`proofline config: ${bad}; nothing was written\n`); return 1; }
  const c = caller(ctx.env);
  if (c === 'specialist') { ctx.err(`proofline config: a specialist never changes the config (${ctx.env.AGENT_ROLE}); report it to the lead. Nothing was written\n`); return 1; }
  if (c === 'lead' && !agentMay(key)) { ctx.err(`proofline config: ${key} is the user's setting: ${whyUserOnly(key)}. An agent does not set it: edit .agents/config.yaml yourself or run this in your own terminal. Nothing was written\n`); return 1; }
  if (!agentMay(key) && !tty) { ctx.err(`proofline config: ${key} is the user's setting and is set only from an interactive terminal (standard input and output are not a terminal here): edit .agents/config.yaml yourself or run this in your own terminal. Nothing was written\n`); return 1; }
  if (mixed) { ctx.err(`proofline config: ${key} not set: the file mixes CRLF and LF line ends; edit it yourself. Nothing was written\n`); return 1; }
  const vp = valueProblem(value);
  if (vp !== '') { ctx.err(`proofline config: ${key}: ${vp}; nothing was written\n`); return 1; }
  const tp = typeProblem(configGetFrom(def, key) ?? '', value);
  if (tp !== '') { ctx.err(`proofline config: ${key} takes ${tp}, not ${value}; nothing was written\n`); return 1; }
  const before = shown(lines, key);
  const r = setInText(u, key, value);
  if (r.why !== '') { ctx.err(`proofline config: ${key} not set: ${r.why}. Nothing was written\n`); return 1; }
  if (r.text === u) { ctx.out(`${key} is already ${value || 'empty'}; nothing was written\n`); return 0; }
  writeAtomic(file, crlf ? r.text.replace(/\n/g, '\r\n') : r.text);
  ctx.out(`set ${key}: ${before === null ? 'not in the file' : before || 'empty'} -> ${value || 'empty'} (.agents/config.yaml; comments and the other keys unchanged)\n`);
  return 0;
}
