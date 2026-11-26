// @ts-check
// `proofline-core.mjs cli config ...` (A232; the former bin/lib/config.sh): the config helpers of the CLI. `init` and `upgrade` (core/install.mjs, A233) now call the reader, `cfgSet` and `cfgMergeNew` in process; this closed command stays for the tests and scripts. Reading is core/config.mjs, writing one key is core/configset.mjs; this module adds the merge of the keys a new default
// config has and the user's file lacks (`merge-new`), and the closed command that exposes all of them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Config, bytes, configLines } from './config.mjs';
import { cfgSet } from './configset.mjs';
import { ProoflineError } from './errors.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const item = (/** @type {string} */ l) => /^[ \t\n\v\f\r]*-([ \t\n\v\f\r]|$)/.test(l);
const content = (/** @type {string} */ l) => !/^[ \t\n\v\f\r]*#/.test(l) && !/^[ \t\n\v\f\r]*$/.test(l) && !item(l) && l.includes(':');

/** @param {string} text the lines of a file @returns {string[]} */
function rowsOf(text) {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * `cfg_merge_new USER DEFAULT`: USER with every key missing from it added from DEFAULT, at any depth (A371). A missing top-level block is appended whole; any other missing key
 * (with its deeper lines and the comment lines before it) is inserted after the last line of its parent's block in USER, with the indentation of DEFAULT. User values, comments and
 * order are never touched; nothing is removed. The text is a byte string; the result has one newline after every line.
 * @param {string} userText @param {string} defaultText @returns {string}
 */
export function cfgMergeNew(userText, defaultText) {
  let U = rowsOf(userText);
  // the awk program told the two files apart by FNR == NR: with an empty user file the default file's lines were read as the user's
  const def = U.length === 0 ? [] : rowsOf(defaultText);
  if (U.length === 0) U = rowsOf(defaultText);
  /** @type {string[]} */ const P = [];
  let L = 0;
  /** @param {string} l */
  const pth = (l) => {
    const ind = l.search(/[^ ]/);
    L = Math.floor(ind / 2);
    let k = l.slice(ind);
    const c = k.indexOf(':');
    if (c >= 0) k = k.slice(0, c);
    P[L] = k;
    return P.slice(0, L + 1).join('.');
  };
  const have = new Set();
  /** @type {Map<string, number>} the line number of the last line of each key's block */ const ends = new Map();
  /** @param {number} nr */
  const mark = (nr) => { for (let i = 0; i <= L; i++) ends.set(P.slice(0, i + 1).join('.'), nr); };
  U.forEach((l, idx) => {
    const nr = idx + 1;
    if (content(l)) { have.add(pth(l)); mark(nr); } else if (item(l) && P.length > 0) mark(nr);
  });
  if (def.length === 0 && U.length > 0) {
    // (the empty-user case above): nothing is left to merge
    return `${U.join('\n')}\n`;
  }
  /** @type {Map<number, string>} */ const ins = new Map();
  let tail = '';
  /** @type {{ level: number, at: number, buf: string } | null} the missing key being copied: its level, where it goes (0: the end of the file) */ let act = null;
  let cm = '';
  const finish = () => {
    if (act !== null) { if (act.at === 0) tail += act.buf; else ins.set(act.at, (ins.get(act.at) ?? '') + act.buf); }
    act = null;
  };
  for (const l of def) {
    if (!content(l)) {
      if (item(l)) { if (act !== null) act.buf += `${cm}${l}\n`; cm = ''; } else cm += `${l}\n`;
      continue;
    }
    const p = pth(l);
    if (act !== null && L > act.level) { act.buf += `${cm}${l}\n`; cm = ''; continue; }
    finish();
    if (!have.has(p)) {
      const parent = P.slice(0, L).join('.');
      if (L === 0) act = { level: 0, at: 0, buf: `${cm}${l}\n` };
      else if (ends.has(parent)) act = { level: L, at: /** @type {number} */ (ends.get(parent)), buf: `${cm}${l}\n` };
    }
    cm = '';
  }
  finish();
  let out = '';
  U.forEach((l, idx) => { out += `${l}\n`; const add = ins.get(idx + 1); if (add !== undefined) out += add; });
  return out + tail;
}

/** @param {string} name */
const usage = (name) => new ProoflineError(`proofline-core cli config: ${name}`, 2, 'USAGE');

/**
 * `cli config val FILE KEY [DEFAULT]` (the value, or DEFAULT when absent or empty), `get FILE KEY` (the value; status 1 when the key is absent), `lines FILE`
 * (`dotted.key=value`, one per line), `cmds FILE KEY` (the configured command, one per line), `set FILE KEY VALUE` (status 1 and nothing written when the key cannot be
 * added), `merge-new USER DEFAULT` (the merged text). Text arguments are UTF-8 on the command line and bytes in the file.
 * @param {Context} ctx @param {string[]} args
 */
export function configCommand(ctx, args) {
  const [op = '', file = '', ...rest] = args;
  const at = (/** @type {string} */ f) => path.resolve(ctx.cwd, f);
  if (op === 'val' && file !== '' && (rest.length === 1 || rest.length === 2)) {
    const v = Config.load(at(file)).get(bytes(rest[0]), bytes(rest[1] ?? ''));
    ctx.out(`${v}\n`);
    return 0;
  }
  if (op === 'get' && file !== '' && rest.length === 1) {
    // the first `key=` line, as the awk reader of the shell found it: a list key has an empty value of its own
    const key = `${bytes(rest[0])}=`;
    let line;
    try { line = Config.load(at(file)).lines.find((l) => l.startsWith(key)); } catch { return 1; }
    if (line === undefined) return 1;
    ctx.out(`${line.slice(key.length)}\n`);
    return 0;
  }
  if (op === 'lines' && file !== '' && rest.length === 0) {
    let text;
    try { text = readFileSync(at(file), 'latin1'); } catch { return 1; }
    for (const l of configLines(text)) ctx.out(`${l}\n`);
    return 0;
  }
  if (op === 'cmds' && file !== '' && rest.length === 1) {
    for (const c of Config.load(at(file)).cmds(bytes(rest[0]))) ctx.out(`${c}\n`);
    return 0;
  }
  if (op === 'set' && file !== '' && rest.length === 2) {
    try { return cfgSet(at(file), bytes(rest[0]), bytes(rest[1])) ? 0 : 1; } catch { return 1; }
  }
  if (op === 'merge-new' && file !== '' && rest.length === 1) {
    let user; let def;
    try { user = readFileSync(at(file), 'latin1'); def = readFileSync(at(rest[0]), 'latin1'); } catch { return 1; }
    ctx.out(cfgMergeNew(user, def));
    return 0;
  }
  throw usage('val FILE KEY [DEFAULT] | get FILE KEY | lines FILE | cmds FILE KEY | set FILE KEY VALUE | merge-new USER DEFAULT');
}
