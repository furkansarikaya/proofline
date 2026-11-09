// @ts-check
// Helpers of tests/core/lifecycle-s1.test.mjs (lifecycle-test.sh scenarios standalone .. amendment_fresh_budget). Only what harness.mjs does not have.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, AS, gateOwner, resultFor, useLiveCore } from '../lib/harness.mjs';
useLiveCore();   // every command of these tests runs in the Node core, as in an installed project (A242)

/** @typedef {import('../lib/harness.mjs').Result} Result */

export const RUN = '.agents/runs/LC';

/** File names in a project folder (sorted; empty when it does not exist). @param {string} dir @param {string} rel */
export function lsDir(dir, rel) { const p = path.join(dir, rel); return existsSync(p) ? readdirSync(p).sort() : []; }

/** Text of a project file. @param {string} dir @param {string} rel */
export const rd = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
/** Write a project file. @param {string} dir @param {string} rel @param {string} text */
export const wr = (dir, rel, text) => writeFileSync(path.join(dir, rel), text);

/** `gpass`/`gfail` that do not throw: the gate result recorded as its owner, the answer of `record` returned (the shell `expect_fail ... gpass X`). @param {string} dir @param {string} gate @param {string} res @param {string[]} [rows] */
export function recTry(dir, gate, res, rows = []) {
  return AS(dir, gateOwner(gate), ['record', 'LC', '--file', resultFor(dir, gate, res, rows)]);
}

/** The text of every gate record of a gate (what `grep ... gates/*-GATE.yaml` looked at). @param {string} dir @param {string} gate */
export function gateText(dir, gate) {
  return lsDir(dir, `${RUN}/gates`).filter((n) => n.endsWith(`-${gate}.yaml`)).map((n) => rd(dir, `${RUN}/gates/${n}`)).join('\n');
}

/** `sed 's/RE/TO/'` over every line (first match per line). @param {string} text @param {RegExp} re @param {string} to */
export const sedLines = (text, re, to) => text.split('\n').map((l) => l.replace(re, to)).join('\n');

/** `sed '/^SECTION:$/,/^[^ ]/ s/RE/TO/'`: the replacement only inside a top-level section of RUN.yaml. @param {string} text @param {string} section @param {RegExp} re @param {string} to */
export function sedSection(text, section, re, to) {
  let inside = false;
  return text.split('\n').map((l) => {
    if (!inside) { if (l === `${section}:`) inside = true; else return l; } else if (/^[^ ]/.test(l)) { inside = false; return l.replace(re, to); }
    return l.replace(re, to);
  }).join('\n');
}

/** `amend` as a role with the four fields on stdin. @param {string} dir @param {string} role @param {string} reason @param {string} scope @param {string} instruction @param {string} by */
export function amendAs(dir, role, reason, scope, instruction, by) {
  return AS(dir, role, ['amend', 'LC'], { input: `reason: ${reason}\nfix_scope: ${scope}\nfix_instruction: ${instruction}\nauthorized_by: ${by}\n` });
}

/** `worker-evidence` without touching the tree (the evidence-order scenario's `ev`); stdout and stderr together. @param {string} dir @param {string} phase @param {string} target @param {string} res */
export function evidence(dir, phase, target, res = 'pass') {
  const ef = phase === 'RED' ? 'expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet' : '';
  return A(dir, ['worker-evidence', 'LC', phase, res], { input: `command: go test ./...\ntarget: ${target}\n${ef}\n` });
}

/** `next LC` output. @param {string} dir */
export const nextOut = (dir) => A(dir, ['next', 'LC']).out;
/** The `fix_path=` lines of a `next` output. @param {string} out */
export const fixPaths = (out) => out.split('\n').filter((l) => l.startsWith('fix_path='));
