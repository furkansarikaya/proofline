#!/usr/bin/env node
// Renders docs/reference/skills.md from skills/*/SKILL.md frontmatter (name, description, metadata.version). Node since A234.
// Usage: node docs/reference/generate-skills.mjs [--check] [--root DIR]
import { lstatSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER = [
  '<!-- Generated from skills/*/SKILL.md - do not edit. Run docs/reference/generate-skills.mjs. -->',
  '',
  '# Skills reference',
  '',
  'Generated from `skills/*/SKILL.md` frontmatter. Each skill works on its own (`npx skills add furkansarikaya/proofline --skill <name>`).',
  '',
  '| Skill | Description | Version |',
  '|---|---|---|',
].join('\n');

/** One table row from the frontmatter of a SKILL.md (same reading as the awk of the shell generator). @param {string} text */
export function row(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let name = '', desc = '', v = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (i === 0 && l !== '---') break;
    if (i > 0 && l === '---') break;
    if (l.startsWith('name: ')) name = l.slice(6);
    if (l.startsWith('description: ')) desc = l.slice(13);
    if (l.startsWith('  version: ')) v = l.slice(11).replace(/"/g, '');
  }
  if (/^".*"$/.test(desc)) desc = desc.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  desc = desc.replace(/\|/g, '\\|');
  return `| \`${name}\` | ${desc} | ${v} |`;
}

/** The whole generated file. @param {string} root */
export function render(root) {
  const dir = join(root, 'skills');
  const files = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n, 'SKILL.md');
    try { if (statSync(f).isFile()) files.push([`skills/${n}/SKILL.md`, f]); } catch { /* no SKILL.md */ }
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // the order of the shell glob over the paths
  return `${HEADER}\n${files.map(([, f]) => row(readFileSync(f, 'utf8'))).join('\n')}\n`;
}

/** @param {string[]} argv @returns {{ code: number, out: string, err: string }} */
export function main(argv) {
  let root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--root' && i + 1 < argv.length) root = resolve(argv[++i]);
    else return { code: 2, out: '', err: `generate-skills.mjs: unknown argument: ${argv[i]}\n` };
  }
  const outFile = join(root, 'docs/reference/skills.md');
  const text = render(root);
  if (check) {
    let cur = null; try { cur = readFileSync(outFile, 'utf8'); } catch { /* missing */ }
    return cur === text ? { code: 0, out: 'skills.md in sync\n', err: '' } : { code: 1, out: '', err: 'docs/reference/skills.md is stale: run node docs/reference/generate-skills.mjs\n' };
  }
  try { if (lstatSync(outFile).isSymbolicLink()) unlinkSync(outFile); } catch { /* new file */ }
  writeFileSync(outFile, text);
  return { code: 0, out: '', err: '' };
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const r = main(process.argv.slice(2));
  process.stdout.write(r.out); process.stderr.write(r.err);
  process.exitCode = r.code;
}
