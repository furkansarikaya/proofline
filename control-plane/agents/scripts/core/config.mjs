// @ts-check
// The one config reader (agent.sh lines 124-180): .agents/config.yaml, indented YAML of scalars, read like the awk program of
// `config_lines`. Text is kept as byte strings (one char per byte, latin1) because agent.sh runs with LC_ALL=C: lengths, comparisons and
// output are in bytes. `bytes()` converts an argument or an environment value; `Buffer.from(text, 'latin1')` converts back.
import { readFileSync } from 'node:fs';
import { BridgeToShell } from './errors.mjs';
import { isFile } from './paths.mjs';

/** A JavaScript string as the byte string the shell would hold (UTF-8 bytes, one char each). @param {string} s */
export function bytes(s) { return Buffer.from(s, 'utf8').toString('latin1'); }

const WS = '[ \\t\\n\\v\\f\\r]'; // POSIX [[:space:]] in the C locale
const reLeadWs = new RegExp(`^${WS}+`);
const reTrailWs = new RegExp(`${WS}+$`);
const reCommentTail = new RegExp(`${WS}+#[^]*$`);
const reDashItem = new RegExp(`^-(${WS}|$)`);
const reDashPrefix = new RegExp(`^-${WS}*`);
const reBlank = new RegExp(`^${WS}*$`);
const reComment = new RegExp(`^${WS}*#`);

/** @param {string} s */
function trim(s) { return s.replace(reLeadWs, '').replace(reTrailWs, ''); }

/**
 * `config_lines`: "dotted.key=value" for every key; comments and surrounding quotes are stripped. A block list (A173) gives
 * `key.0=...`, `key.1=...`.
 * @param {string} text the file as a byte string
 * @returns {string[]}
 */
export function configLines(text) {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const path = [];
  /** @type {Map<string, number>} */ const cnt = new Map();
  let lastfull = '';
  let lastind = 0;
  for (const line of rows) {
    if (reComment.test(line) || reBlank.test(line)) continue;
    const m = /[^ ]/.exec(line);
    const ind = (m ? m.index + 1 : 0) - 1;
    const lvl = Math.floor(ind / 2);
    const body = line.slice(ind);
    if (reDashItem.test(body)) {
      if (lastfull === '' || ind < lastind) continue;
      let it = body.replace(reDashPrefix, '').replace(reCommentTail, '');
      it = trim(it);
      if (/^".*"$/s.test(it) || /^'.*'$/s.test(it)) it = it.slice(1, it.length - 1);
      const n = cnt.get(lastfull) ?? 0;
      cnt.set(lastfull, n + 1);
      out.push(`${lastfull}.${n}=${it}`);
      continue;
    }
    if (!line.includes(':')) continue;
    const colon = body.indexOf(':');
    // sub(/:.*/, "", k) removes from the FIRST colon of the body; sub(/^[^:]*:/, "", v) removes up to it
    const k = colon < 0 ? body : body.slice(0, colon);
    let v = colon < 0 ? body : body.slice(colon + 1);
    v = trim(v.replace(reCommentTail, ''));
    if (/^".*"$/s.test(v)) v = v.slice(1, v.length - 1);
    path[lvl] = k;
    let full = path[0] ?? '';
    for (let i = 1; i <= lvl; i++) full = `${full}.${path[i] ?? ''}`;
    lastfull = full;
    lastind = ind;
    out.push(`${full}=${v}`);
  }
  return out;
}

/**
 * `config_get`: the value of a dotted key, the items one per line for a block list; null when the key is absent (exit 1).
 * @param {string[]} lines the output of configLines @param {string} k
 * @returns {string | null}
 */
export function configGetFrom(lines, k) {
  /** @type {string | null} */ let v = null;
  /** @type {string[]} */ const it = [];
  for (const line of lines) {
    if (v === null && line.startsWith(`${k}=`)) v = line.slice(k.length + 1);
    if (line.startsWith(`${k}.`)) {
      const r = line.slice(k.length + 1);
      const n = r.indexOf('=');
      if (n > 0 && /^[0-9]+$/.test(r.slice(0, n))) it.push(r.slice(n + 1));
    }
  }
  if (v === null && it.length === 0) return null;
  if ((v === null || v === '') && it.length > 0) return it.join('\n');
  return v ?? '';
}

/** `config_items`: the items of a block list. @param {string[]} lines @param {string} k */
export function configItems(lines, k) {
  /** @type {string[]} */ const it = [];
  for (const line of lines) {
    if (!line.startsWith(`${k}.`)) continue;
    const r = line.slice(k.length + 1);
    const n = r.indexOf('=');
    if (n > 0 && /^[0-9]+$/.test(r.slice(0, n))) it.push(r.slice(n + 1));
  }
  return it;
}

/** `dec0`: a number without leading zeros (08 is the number 8). @param {string} s */
export function dec0(s) { return s.replace(/^0+(?=[^])/, ''); }

/**
 * A config number that feeds arithmetic. The shell compares 64-bit integers; a longer digit string would be read differently by each
 * shell, so such a value leaves the command to the shell code.
 * @param {string} digits only [0-9] @returns {number}
 */
export function smallInt(digits) {
  if (digits.length > 15) throw new BridgeToShell(`number too long: ${digits}`);
  return Number(digits);
}

/** One config file, parsed once per invocation (`cfg_cache`). */
export class Config {
  /**
   * @param {string} file
   * @param {string[] | null} lines null when the file does not exist
   */
  constructor(file, lines) {
    this.file = file;
    this.exists = lines !== null;
    this.lines = lines ?? [];
    /** @type {Map<string, string>} */ this.index = new Map();
    for (const l of this.lines) {
      const eq = l.indexOf('=');
      // `cfg` finds "\n<key>=" in the cache: the first line that starts with the whole key and "=" ; keys may contain "=" only via the value
      // side, so index every prefix up to an "=" (first occurrence wins)
      let at = eq;
      while (at >= 0) {
        const key = l.slice(0, at);
        if (!this.index.has(key)) this.index.set(key, l.slice(at + 1));
        at = l.indexOf('=', at + 1);
      }
    }
  }

  /**
   * Read the file once. A missing file is an empty config; a file that exists but cannot be read is a shell-side error (awk's message).
   * @param {string} file
   */
  static load(file) {
    if (!isFile(file)) return new Config(file, null);
    let text;
    try { text = readFileSync(file, 'latin1'); } catch { throw new BridgeToShell(`config unreadable: ${file}`); }
    return new Config(file, configLines(text));
  }

  /** `cfg KEY [DEFAULT]`: the value, or the default when absent or empty. @param {string} key @param {string} [def] */
  get(key, def = '') {
    const v = this.index.get(key);
    return v === undefined || v === '' ? def : v;
  }

  /** `config_get` over this file. @param {string} key */
  getRaw(key) { return configGetFrom(this.lines, key); }

  /** `cfg_cmds`: one command per line, the scalar or every block-list item. @param {string} key */
  cmds(key) {
    const v = this.get(key, '');
    return v !== '' ? [v] : configItems(this.lines, key);
  }
}
