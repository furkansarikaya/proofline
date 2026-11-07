// @ts-check
// Writing .agents/config.yaml (A230; the former cfg_set and cfg_cmds of bin/lib/config.sh, for the commands and scale proposals): flat indented YAML of scalars, two
// spaces per level; commands.build|test|lint may also be a block list of commands (A173).
import { readFileSync, writeFileSync } from 'node:fs';
import { Config } from './config.mjs';

const item = (/** @type {string} */ l) => /^[ \t\n\v\f\r]*-([ \t\n\v\f\r]|$)/.test(l);
const content = (/** @type {string} */ l) => !/^[ \t\n\v\f\r]*#/.test(l) && !/^[ \t\n\v\f\r]*$/.test(l) && !item(l) && l.includes(':');

/**
 * `cfg_cmds FILE KEY`: a configured command, one per line: the scalar or every item of the block list; nothing when the key is empty, absent or the file is missing.
 * @param {string} file @param {string} key @returns {string[]}
 */
export function cfgCmds(file, key) { return Config.load(file).cmds(key); }

/**
 * `cfg_set FILE KEY VALUE`: replaces the value of a 1-, 2- or 3-level key; a missing key is added under its section (the section is created when missing; a 3-level key
 * needs its 2-level parent). Comments on the replaced line are dropped. A VALUE of several lines writes a block list (`- ` lines under the key); replacing a key also
 * removes the `- ` lines it had. Returns false (and writes nothing) for a 3-level key without its parent.
 * @param {string} file @param {string} key @param {string} value
 */
export function cfgSet(file, key, value) {
  const src = readFileSync(file, 'latin1');
  const rows = src.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const kp = key.split('.');
  const n = kp.length;
  const sec = kp[0];
  /** @type {string[]} */ const P = [];
  let L = 0; let K = ''; let IND = 0;
  const pth = (/** @type {string} */ l) => {
    IND = l.search(/[^ ]/);
    L = Math.floor(IND / 2);
    K = l.slice(IND);
    const c = K.indexOf(':');
    if (c >= 0) K = K.slice(0, c);
    P[L] = K;
    let f = P[0] ?? '';
    for (let i = 1; i <= L; i++) f += `.${P[i] ?? ''}`;
    return f;
  };
  /** @type {string[]} */ const out = [];
  const emit = (/** @type {number} */ ind, /** @type {string} */ k, /** @type {string} */ v) => {
    const s = ' '.repeat(ind);
    if (v === '') out.push(`${s}${k}:`);
    else if (v.includes('\n')) { out.push(`${s}${k}:`); for (const a of v.split('\n')) if (a !== '') out.push(`${s}  - ${a}`); } else out.push(`${s}${k}: ${v}`);
  };
  let found = false;
  for (const l of rows) if (content(l) && pth(l) === key) found = true;
  let skip = false; let done = false;
  for (const l of rows) {
    if (skip && item(l)) continue;
    if (!content(l)) { if (!/^[ \t\n\v\f\r]*(#|$)/.test(l)) skip = false; out.push(l); continue; }
    skip = false;
    const p = pth(l);
    if (found && p === key) { emit(IND, K, value); skip = true; continue; }
    out.push(l);
    if (!found && n === 2 && L === 0 && p === sec && !done) { emit(2, kp[1], value); done = true; }
    if (!found && n === 3 && L === 1 && p === `${kp[0]}.${kp[1]}` && !done) { emit(4, kp[2], value); done = true; }
  }
  if (!found && !done) {
    if (n === 1) emit(0, key, value);
    else if (n === 2) { out.push(`${sec}:`); emit(2, kp[1], value); } else return false;
  }
  writeFileSync(file, out.length === 0 ? '' : `${out.join('\n')}\n`, 'latin1');
  return true;
}
