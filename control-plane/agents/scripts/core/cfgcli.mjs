// @ts-check
// `proofline-core.mjs cli config ...` (A232; the former bin/lib/config.sh): the config helpers of the CLI. `init` and `upgrade` (core/install.mjs, A233) now call the reader, `cfgSet` and `cfgMergeNew` in process; this closed command stays for the tests and scripts. Reading is core/config.mjs, writing one key is core/configset.mjs; this module adds the merge of the keys a new default
// config has and the user's file lacks (`merge-new`), and the closed command that exposes all of them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Config, bytes, configLines } from './config.mjs';
import { cfgSet } from './configset.mjs';
import { ProoflineError } from './errors.mjs';
import { checkConfigLines } from './commands/config-check.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const item = (/** @type {string} */ l) => /^[ \t\n\v\f\r]*-([ \t\n\v\f\r]|$)/.test(l);
const content = (/** @type {string} */ l) => !/^[ \t\n\v\f\r]*#/.test(l) && !/^[ \t\n\v\f\r]*$/.test(l) && !item(l) && l.includes(':');

/** @param {string} text the lines of a file @returns {string[]} */
function rowsOf(text) {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** The value on a key line, without a trailing comment: `risk: off # x` -> `off`; `risk: # x` -> ''. @param {string} line */
function lineValue(line) { return line.slice(line.indexOf(':') + 1).replace(/(^|[ \t])#.*$/, '').trim(); }

/**
 * The multi-line scalars of a config: a key whose value is a block scalar (`|` or `>`, the body is every following blank or deeper-indented line) or a quoted string that is not closed on its line (the body
 * runs to the closing quote). `body` holds the line numbers of the bodies (not keys, not list items, whatever they look like), `runs` the opener with its body as text, `anc` the paths of the opener key and
 * of every key above it. @param {string[]} U @returns {{ body: Set<number>, runs: string[], anc: Set<string> }}
 */
function scanScalars(U) {
  /** @type {Set<number>} */ const body = new Set(); /** @type {string[]} */ const runs = []; /** @type {Set<string>} */ const anc = new Set();
  /** @type {string[]} */ const P = [];
  /** @type {{ kind: 'block' | 'q', indent: number, q: string, from: number } | null} */ let open = null;
  const indentOf = (/** @type {string} */ l) => l.search(/[^ ]/);
  /** the index of the first unescaped closing quote Q in S from FROM, or -1 */
  const closeAt = (/** @type {string} */ s, /** @type {string} */ q, /** @type {number} */ from) => {
    for (let i = from; i < s.length; i++) {
      if (q === '"' && s[i] === '\\') { i++; continue; }
      if (q === "'" && s[i] === "'" && s[i + 1] === "'") { i++; continue; }
      if (s[i] === q) return i;
    }
    return -1;
  };
  const endRun = (/** @type {number} */ last) => { if (open) { runs.push(U.slice(open.from, last + 1).join('\n')); open = null; } };
  for (let i = 0; i < U.length; i++) {
    const l = U[i];
    if (open !== null) {
      if (open.kind === 'block') {
        if (l.trim() === '' || indentOf(l) > open.indent) { body.add(i); continue; }
        let last = i - 1; while (last > open.from && U[last].trim() === '') last--;
        endRun(last);
      } else {
        body.add(i);
        if (closeAt(l, open.q, 0) >= 0) endRun(i);
        continue;
      }
    }
    if (!content(l)) continue;
    const ind = indentOf(l); const lvl = Math.floor(ind / 2);
    P[lvl] = l.slice(ind, l.indexOf(':', ind) < 0 ? undefined : l.indexOf(':', ind));
    const v = lineValue(l);
    const chain = () => { for (let k = 0; k <= lvl; k++) anc.add(P.slice(0, k + 1).join('.')); };
    if (/^[|>]/.test(v)) { open = { kind: 'block', indent: ind, q: '', from: i }; chain(); } else if (/^["']/.test(v)) {
      const raw = l.slice(l.indexOf(':', ind) + 1).trimStart();
      if (closeAt(raw, v[0], 1) < 0) { open = { kind: 'q', indent: ind, q: v[0], from: i }; chain(); }
    }
  }
  if (open !== null) { let last = U.length - 1; while (last > /** @type {{ from: number }} */ (open).from && U[last].trim() === '') last--; endRun(last); }
  return { body, runs, anc };
}

/**
 * `cfg_merge_new USER DEFAULT`: USER with every key missing from it added from DEFAULT, at any depth (A371). A missing top-level block is appended whole; any other missing key
 * (with its deeper lines and the comment lines before it) is inserted after the last line of its parent's block in USER, with the indentation of DEFAULT. User values, comments and
 * order are never touched; nothing is removed. A key is NOT added (and listed in `skipped` with the reason) when its parent line has a value (a scalar, `{`, `[`, `|`, `>`, an anchor or an
 * alias: block keys under it would corrupt the file or change its meaning), when the file is indented with tabs or when the parent's block holds a multi-line value (a block scalar or a quoted string over several lines). USER and DEFAULT use `\n`; the text has one newline after every line.
 * shortcut: a new deep key under an existing 2-level key is not added when its parent line holds a value or the file uses tabs; improve when a project config written that way must receive new defaults.
 * @param {string} userText @param {string} defaultText @returns {{ text: string, skipped: Array<{ path: string, reason: string }> }}
 */
function mergeCore(userText, defaultText) {
  let U = rowsOf(userText);
  // the awk program told the two files apart by FNR == NR: with an empty user file the default file's lines were read as the user's
  const def = U.length === 0 ? [] : rowsOf(defaultText);
  if (U.length === 0) U = rowsOf(defaultText);
  /** @type {Array<{ path: string, reason: string }>} */ const skipped = [];
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
  /** @type {Map<string, string>} the line of each key */ const lines = new Map();
  /** @param {number} nr */
  const mark = (nr) => { for (let i = 0; i <= L; i++) ends.set(P.slice(0, i + 1).join('.'), nr); };
  const tabbed = U.some((l) => /^ *\t/.test(l));
  const sc = scanScalars(U);
  U.forEach((l, idx) => {
    const nr = idx + 1;
    if (sc.body.has(idx)) return;   // the body of a multi-line value is text, whatever it looks like
    if (content(l)) { const p = pth(l); have.add(p); lines.set(p, l); mark(nr); } else if (item(l) && P.length > 0) mark(nr);
  });
  if (def.length === 0 && U.length > 0) {
    // (the empty-user case above): nothing is left to merge
    return { text: `${U.join('\n')}\n`, skipped };
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
      else if (ends.has(parent)) {
        const v = lineValue(/** @type {string} */ (lines.get(parent)));
        const why = tabbed ? 'the file is indented with tabs' : sc.anc.has(parent) ? 'multi-line value in the block' : v !== '' ? `${parent} has a value (${/^[{[]/.test(v) ? 'a flow collection' : /^[|>]/.test(v) ? 'a block scalar' : /^[&*]/.test(v) ? 'an anchor or alias' : 'a scalar'}), block keys cannot go under it` : '';
        if (why !== '') skipped.push({ path: p, reason: why });
        else act = { level: L, at: /** @type {number} */ (ends.get(parent)), buf: `${cm}${l}\n` };
      }
    }
    cm = '';
  }
  finish();
  let out = '';
  U.forEach((l, idx) => { out += `${l}\n`; const add = ins.get(idx + 1); if (add !== undefined) out += add; });
  return { text: out + tail, skipped };
}

/** @param {string} l the `key=value` line of configLines */
const keyOf = (l) => l.slice(0, l.indexOf('='));

/**
 * Is MERGED still the user's config? Every key the user had has the same line, in the same order, no key is duplicated, and `config-check` has no message it did not already have for the user's text.
 * @param {string} user @param {string} merged @returns {string} '' when it is, else why not
 */
export function mergeProblem(user, merged) {
  // every multi-line value of the user's text is still in one piece (its opener and body, line for line)
  const mj = merged.split('\n').join('\n');
  for (const run of scanScalars(rowsOf(user)).runs) if (!mj.includes(run)) return `a multi-line value of your config would be cut: ${run.split('\n')[0].trim()}`;
  const ul = configLines(user); const ml = configLines(merged);
  const had = new Set(ul.map(keyOf));
  const kept = ml.filter((l) => had.has(keyOf(l)));
  if (kept.length !== ul.length || kept.some((l, i) => l !== ul[i])) return 'a value or the order of a key you have would change';
  /** @type {Map<string, number>} */ const seen = new Map();
  for (const l of ml) { const k = keyOf(l); seen.set(k, (seen.get(k) ?? 0) + 1); }
  const before = new Map(); for (const l of ul) before.set(keyOf(l), (before.get(keyOf(l)) ?? 0) + 1);
  for (const [k, n] of seen) if (n > (before.get(k) ?? 1)) return `the key ${k} would appear twice`;
  const old = new Set(checkConfigLines(ul).messages);
  const fresh = checkConfigLines(ml).messages.find((m) => !old.has(m));
  return fresh === undefined ? '' : `config-check would report: ${fresh}`;
}

/**
 * The safe merge of `upgrade` (A371): the line ends of USER are kept (CRLF stays CRLF), keys that cannot be added safely are listed, and the result is parsed again: when it changes a key you
 * have, duplicates one, or `config-check` would report something new, the whole merge is discarded (`discarded` says why) and USER is returned as it was.
 * @param {string} userText @param {string} defaultText @returns {{ text: string, skipped: Array<{ path: string, reason: string }>, discarded: string }}
 */
export function cfgMergeSafe(userText, defaultText) {
  const crlf = userText.includes('\r\n');
  const u = userText.replace(/\r\n/g, '\n');
  if (u.trim() === '') return { text: defaultText, skipped: [], discarded: '' };   // nothing of the user's to protect: the default is the file
  const r = mergeCore(u, defaultText.replace(/\r\n/g, '\n'));
  const why = mergeProblem(u, r.text);
  if (why !== '') return { text: userText, skipped: [], discarded: why };
  return { text: crlf ? r.text.replace(/\n/g, '\r\n') : r.text, skipped: r.skipped, discarded: '' };
}

/** `cfg_merge_new USER DEFAULT` as the text alone (the closed command and the tests). @param {string} userText @param {string} defaultText */
export function cfgMergeNew(userText, defaultText) { return cfgMergeSafe(userText, defaultText).text; }

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
