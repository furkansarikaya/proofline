// @ts-check
// Verifies that the shared-rules block of every skill is byte-identical to tests/shared/shared-rules.md (D29: no file sharing between skills; a CI
// check keeps the duplicated section from drifting).
//
// usage: node check-shared.mjs [--root DIR] [skill-name ...]
//   --root DIR   repository root (default: two directories above this script)
//   skill-name   check only these skills; default: every skills/*/SKILL.md that exists
//
// Also: skills/<name>/scripts/ecosystems.{sh,mjs} and references/ecosystems.{json,tsv}, when present, equal control-plane/agents/ (A173).
// Also: skills/<name>/references/WRITING.md and scripts/check-writing.mjs, when present, equal tests/shared/writing-profile.md and check-writing.mjs.
//
// Block = from the line starting with `<!-- proofline:shared-rules:begin` through the line `<!-- proofline:shared-rules:end -->`, both included.
// Prints PASS or FAIL per skill. Exit 0 when every checked skill passes, 1 on drift, a missing block or a missing SKILL.md, 2 on a usage error or
// when there is nothing to check.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BEGIN = '<!-- proofline:shared-rules:begin';
const END = '<!-- proofline:shared-rules:end -->';

/** The shared-rules block(s) of a text, as `sed -n '/begin/,/end$/p'` prints them. @param {string} text */
export function blockOf(text) {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  /** @type {string[]} */ const out = []; let on = false;
  for (const l of lines) {
    if (!on && l.startsWith(BEGIN)) on = true;
    if (on) { out.push(l); if (l === END) on = false; }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** The order a shell glob over the skill folders gives: by the whole path, so `proofline-lead/` sorts before `proofline/`. @param {string} a @param {string} b */
const globOrder = (a, b) => { const x = `${a}/`; const y = `${b}/`; return x < y ? -1 : x > y ? 1 : 0; };
const same = (/** @type {string} */ a, /** @type {string} */ b) => existsSync(b) && readFileSync(a).equals(readFileSync(b));

/**
 * @param {string[]} argv @param {{ write?: (s: string) => void }} [o] @returns {number}
 */
export function main(argv, o = {}) {
  const write = o.write ?? ((s) => process.stdout.write(s));
  let root = path.resolve(import.meta.dirname, '../..');
  /** @type {string[]} */ let names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      if (i + 1 >= argv.length) { console.error('check-shared: --root needs a directory'); return 2; }
      const d = path.resolve(argv[++i]);
      if (!existsSync(d) || !statSync(d).isDirectory()) { console.error(`check-shared: no such directory: ${argv[i]}`); return 2; }
      root = d;
    } else if (a === '-h' || a === '--help') { write('usage: node check-shared.mjs [--root DIR] [skill-name ...]\n'); return 0; }
    else if (a.startsWith('-')) { console.error(`check-shared: unknown option: ${a}`); return 2; }
    else names.push(a);
  }
  const canon = path.join(root, 'tests/shared/shared-rules.md');
  if (!existsSync(canon)) { console.error(`check-shared: missing ${canon}`); return 2; }
  const sk = path.join(root, 'skills');
  if (names.length === 0 && existsSync(sk)) names = readdirSync(sk).sort(globOrder).filter((n) => existsSync(path.join(sk, n, 'SKILL.md')));
  if (names.length === 0) { console.error(`check-shared: no skills to check under ${root}/skills`); return 2; }

  let status = 0;
  const pass = (/** @type {string} */ m) => write(`PASS ${m}\n`);
  const fail = (/** @type {string} */ m) => { write(`FAIL ${m}\n`); status = 1; };
  const canonText = readFileSync(canon, 'utf8');
  for (const name of names) {
    const skill = path.join(sk, name, 'SKILL.md');
    if (!existsSync(skill)) { fail(`${name} (SKILL.md not found)`); continue; }
    const text = readFileSync(skill, 'utf8');
    if (!text.split('\n').some((l) => l.startsWith(BEGIN))) { fail(`${name} (shared-rules block missing)`); continue; }
    if (blockOf(text) === canonText) pass(name); else fail(`${name} (shared-rules block differs from tests/shared/shared-rules.md)`);
  }
  // Writing-profile copies (A138): a skill that carries the reference or the length check carries the canonical bytes.
  for (const name of names) {
    for (const [rel, canonName] of [['references/WRITING.md', 'writing-profile.md'], ['scripts/check-writing.mjs', 'check-writing.mjs']]) {
      const f = path.join(sk, name, rel);
      if (!existsSync(f)) continue;
      if (same(f, path.join(root, 'tests/shared', canonName))) pass(`${name} ${rel}`); else fail(`${name} (${rel} differs from tests/shared/${canonName})`);
    }
  }
  // Evidence validator copies: every skill that carries validate-product-claims.mjs carries product-spec's bytes.
  const specCopy = path.join(sk, 'product-spec/scripts/validate-product-claims.mjs');
  if (existsSync(sk)) {
    for (const name of readdirSync(sk).sort(globOrder)) {
      const f = path.join(sk, name, 'scripts/validate-product-claims.mjs');
      if (!existsSync(f) || name === 'product-spec') continue;
      if (same(f, specCopy)) pass(`${name} scripts/validate-product-claims.mjs`);
      else fail(`${name} (scripts/validate-product-claims.mjs differs from skills/product-spec/scripts/validate-product-claims.mjs)`);
    }
  }
  // Product reference copies: the quality bar is the same in the three product skills, the evidence model in the two that carry it.
  for (const name of ['product-discovery', 'product-assess']) {
    for (const ref of ['QUALITY-BAR.md', 'EVIDENCE.md']) {
      const f = path.join(sk, name, 'references', ref);
      if (!existsSync(f)) continue;
      if (same(f, path.join(sk, 'product-spec/references', ref))) pass(`${name} references/${ref}`);
      else fail(`${name} (references/${ref} differs from skills/product-spec/references/${ref})`);
    }
  }
  // Ecosystem definition copies (A173): control-plane/agents holds the canonical ecosystems.json, ecosystems.tsv (generated), ecosystems.mjs and
  // scripts/ecosystems.sh; a skill that carries one carries the same bytes (it is installable alone). The canonical flat file must also be what
  // `node ecosystems.mjs write` produces, and the definition must pass its schema.
  const eco = path.join(root, 'control-plane/agents');
  if (existsSync(path.join(eco, 'ecosystems.json'))) {
    const r = spawnSync(process.execPath, [path.join(eco, 'ecosystems.mjs'), 'check'], { encoding: 'utf8' });
    if (r.status === 0) pass('control-plane ecosystems.json and ecosystems.tsv');
    else fail(`control-plane ecosystems definition (${(r.stderr ?? '').replace(/\n/g, ' ')})`);
    for (const name of names) {
      for (const [rel, canonRel] of [['scripts/ecosystems.sh', 'scripts/ecosystems.sh'], ['scripts/ecosystems.mjs', 'ecosystems.mjs'], ['references/ecosystems.json', 'ecosystems.json'], ['references/ecosystems.tsv', 'ecosystems.tsv']]) {
        const f = path.join(sk, name, rel);
        if (!existsSync(f)) {
          // a skill whose own scripts import the definition must carry the copy it imports (it is installable alone): a missing copy fails
          const imp = rel === 'scripts/ecosystems.sh' || rel === 'references/ecosystems.tsv' ? 'ecosystems.sh' : 'ecosystems.mjs';
          const dir = path.join(sk, name, 'scripts');
          const users = existsSync(dir) ? readdirSync(dir).filter((n) => !/^ecosystems\.(mjs|sh)$/.test(n) && statSync(path.join(dir, n)).isFile() && new RegExp(imp).test(readFileSync(path.join(dir, n), 'latin1'))) : [];
          if (users.length) fail(`${name} (${rel} is missing: a script of the skill uses ${imp}, and a skill is installable alone)`);
          continue;
        }
        if (same(f, path.join(eco, canonRel))) pass(`${name} ${rel}`); else fail(`${name} (${rel} differs from control-plane/agents/${canonRel})`);
      }
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
