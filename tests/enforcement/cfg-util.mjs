// @ts-check
// Small helpers shared by timeouts.test.mjs and approval-load.test.mjs (176-C): config edits the shell suites did with awk/sed, a blocking sleep, a PATH shim.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A } from '../lib/harness.mjs';

/** Blocking sleep. @param {number} ms */
export function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** The newline-stripped text, as `$(...)` gives it. @param {string} s */
export const strip = (s) => s.replace(/\n+$/, '');

/** Rewrite .agents/config.yaml of the project. @param {string} dir @param {(t: string) => string} f */
export function editConfig(dir, f) { const c = path.join(dir, '.agents/config.yaml'); writeFileSync(c, f(readFileSync(c, 'utf8'))); }

/** `setcfg SECTION KEY VALUE`: set an existing nested key of .agents/config.yaml (the awk of the shell suite: a line `  KEY...` inside the section). @param {string} dir @param {string} sec @param {string} key @param {string} val */
export function setcfg(dir, sec, key, val) {
  editConfig(dir, (t) => {
    let insec = false;
    return t.split('\n').map((l) => {
      if (/^[^ #]/.test(l)) insec = l === `${sec}:`;
      return insec && l.startsWith(`  ${key}:`) ? `  ${key}: ${val}` : l;
    }).join('\n');
  });
}

/** `tv KEY`: a value of `agent.sh timeouts`. @param {string} dir @param {string} key */
export function tv(dir, key) {
  const m = new RegExp(`^${key.replace(/[.]/g, '\\.')}=(.*)$`, 'm').exec(A(dir, ['timeouts']).out);
  return m ? m[1] : '';
}

/** `A CMD | sed -n 's/^KEY=//p'`. @param {string} dir @param {string} cmd @param {string} key */
export function kv(dir, cmd, key) {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(A(dir, [cmd]).out);
  return m ? m[1] : '';
}

/** A shim executable in a new folder in front of PATH. @param {string} shimDir @param {string} name @param {string} script the script text including its shebang @returns {string} the PATH to use */
export function shim(shimDir, name, script) {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(path.join(shimDir, name), script); chmodSync(path.join(shimDir, name), 0o755);
  return `${shimDir}${path.delimiter}${process.env.PATH}`;
}
