// @ts-check
// The shell and awk census of a git ref: the numbers of the epic's before/after table (issue #165 exit criteria, A251). Deterministic: only `git ls-tree` and blob contents of the
// refs named, no working tree, no clock.
//
//   node tests/ci/shell-census.mjs [--json] [--root DIR] REF [REF...]     (a ref is a tag, a commit or HEAD; 0.0.40 is the commit af2b1a4b, `chore(release): 0.0.40`)
//
// Per ref: tracked shell files (the definition of tests/ci/no-shell-logic.mjs: .sh/.bash, a shell shebang, a githooks folder) and their lines (all, and code lines: not blank,
// not a comment), `.awk` files, non-comment lines of shell files that MENTION the word awk, gawk or sed (an upper bound of invocations: a reviewer counting invocation-shaped lines got 1,210 of the 1,392 at 0.0.40), `run:` steps of the workflows (and how many have more than one command line), hook command strings of the wiring files,
// and the lines of the Node control plane (control-plane/, adapters/, bin/, `*.mjs` files).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHEBANG, WIRING_FILES, hookStrings, runSteps } from './no-shell-logic.mjs';

/** @param {string} root @param {string[]} args @param {Buffer | string} [input] @returns {Buffer} */
function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], { input, maxBuffer: 1 << 29, stdio: ['pipe', 'pipe', 'ignore'] });
}

/** @param {string} text */
const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
/** @param {string} text */
const codeLines = (text) => text.split('\n').filter((l, i) => l.trim() !== '' && !(l.trimStart().startsWith('#') && !(i === 0 && l.startsWith('#!')))).length;

/**
 * @param {string} root @param {string} ref
 * @returns {{ ref: string, commit: string, shellFiles: number, shellLines: number, shellCodeLines: number, awkFiles: number, awkLines: number, awkSedLines: number, ciSteps: number, ciMultiLineSteps: number, hookStrings: number, nodeFiles: number, nodeLines: number }}
 */
export function census(root, ref) {
  const commit = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
  /** @type {{ sha: string, size: number, path: string }[]} */ const entries = [];
  for (const rec of git(root, ['ls-tree', '-r', '-l', '-z', commit]).toString('latin1').split('\0').filter(Boolean)) {
    const m = /^(\d+) blob ([0-9a-f]+)\s+(\d+|-)\t([^]*)$/.exec(rec);
    if (m) entries.push({ sha: m[2], size: Number(m[3]), path: Buffer.from(m[4], 'latin1').toString('utf8') });
  }
  // blobs worth reading: shell candidates (an extension of sh/bash, no extension, a hook folder), the Node files, the workflow and wiring files
  const wanted = (/** @type {string} */ p) => /\.(sh|bash|awk|mjs)$/.test(p) || !/\.[^/]*$/.test(p.split('/').pop() ?? '') || /(^|\/)(githooks|\.githooks|\.husky)\//.test(p) || /^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(p) || WIRING_FILES.includes(p);
  const read = entries.filter((e) => wanted(e.path));
  /** @type {Map<string, string>} */ const text = new Map();
  if (read.length > 0) {
    const out = git(root, ['cat-file', '--batch'], `${[...new Set(read.map((e) => e.sha))].join('\n')}\n`);
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(10, at);
      const head = out.subarray(at, nl).toString().split(' ');
      const size = Number(head[2]);
      text.set(head[0], out.subarray(nl + 1, nl + 1 + size).toString('utf8'));
      at = nl + 1 + size + 1;
    }
  }
  const r = { ref, commit: commit.slice(0, 8), shellFiles: 0, shellLines: 0, shellCodeLines: 0, awkFiles: 0, awkLines: 0, awkSedLines: 0, ciSteps: 0, ciMultiLineSteps: 0, hookStrings: 0, nodeFiles: 0, nodeLines: 0 };
  for (const e of read) {
    const t = text.get(e.sha) ?? '';
    const p = e.path;
    if (p.endsWith('.awk')) { r.awkFiles++; r.awkLines += lineCount(t); }
    const isShell = /\.(sh|bash)$/.test(p) || /(^|\/)(githooks|\.githooks|\.husky)\//.test(p) || SHEBANG.test(t.split('\n')[0] ?? '');
    if (isShell && !p.endsWith('.mjs')) {
      r.shellFiles++; r.shellLines += lineCount(t); r.shellCodeLines += codeLines(t);
      r.awkSedLines += t.split('\n').filter((l) => /(^|[^A-Za-z0-9_.-])(awk|gawk|sed)(\s|$)/.test(l) && !l.trimStart().startsWith('#')).length;
    }
    if (/\.mjs$/.test(p) && /^(control-plane|adapters|bin)\//.test(p)) { r.nodeFiles++; r.nodeLines += lineCount(t); }
    if (/^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(p)) {
      for (const s of runSteps(p, t)) { r.ciSteps++; if (s.text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length > 1) r.ciMultiLineSteps++; }
    }
    if (WIRING_FILES.includes(p)) { try { r.hookStrings += hookStrings(p, t).length; } catch { /* not JSON at that ref */ } }
  }
  // bin/proofline is a Node program from A233: it carries a node shebang and is counted as Node (no extension, not .mjs)
  const bin = entries.find((e) => e.path === 'bin/proofline');
  if (bin && /^#!.*\bnode\b/.test(text.get(bin.sha) ?? '')) { r.nodeFiles++; r.nodeLines += lineCount(text.get(bin.sha) ?? ''); }
  return r;
}

/** @param {ReturnType<typeof census>[]} rows @returns {string} a Markdown table, one column per ref */
export function table(rows) {
  const defs = /** @type {[string, keyof ReturnType<typeof census>][]} */ ([
    ['shell files', 'shellFiles'], ['shell lines (all)', 'shellLines'], ['shell lines (code: no blank, no comment)', 'shellCodeLines'], ['`.awk` files', 'awkFiles'], ['`.awk` lines', 'awkLines'],
    ['shell lines mentioning awk or sed', 'awkSedLines'], ['CI `run:` steps', 'ciSteps'], ['CI steps of more than one command line', 'ciMultiLineSteps'], ['hook command strings', 'hookStrings'],
    ['Node files (control-plane, adapters, bin)', 'nodeFiles'], ['Node lines (control-plane, adapters, bin)', 'nodeLines'],
  ]);
  const head = `| count | ${rows.map((r) => (r.ref === r.commit ? r.ref : `${r.ref} (${r.commit})`)).join(' | ')} |\n|---|${rows.map(() => '---:').join('|')}|`;
  return `${head}\n${defs.map(([label, k]) => `| ${label} | ${rows.map((r) => String(r[k])).join(' | ')} |`).join('\n')}\n`;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let root = resolve(import.meta.dirname, '../..');
  let json = false;
  /** @type {string[]} */ const refs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--root') root = resolve(argv[++i] ?? '.');
    else if (argv[i].startsWith('--')) { process.stderr.write(`shell-census: unknown argument ${argv[i]}\n`); return 2; }
    else refs.push(argv[i]);
  }
  if (refs.length === 0) { process.stderr.write('usage: node tests/ci/shell-census.mjs [--json] [--root DIR] REF [REF...]\n'); return 2; }
  try {
    const rows = refs.map((r) => census(root, r));
    process.stdout.write(json ? `${JSON.stringify(rows, null, 2)}\n` : table(rows));
    return 0;
  } catch (e) {
    process.stderr.write(`shell-census: ${/** @type {Error} */ (e).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
