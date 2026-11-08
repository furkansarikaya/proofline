// @ts-check
// Release version bump (A168): rewrites ONLY the version-holding sites listed in CONTRIBUTING.md, each by an anchored
// pattern, never a global replace (a global replace rewrote history comments in 0.0.25).
// Usage: node tests/ci/bump-version.mjs <new-version>   bump every site, move CHANGELOG Unreleased, run the generators
//        node tests/ci/bump-version.mjs --check         fail when a site disagrees with .claude-plugin/plugin.json
// BUMP_DATE=YYYY-MM-DD overrides today's date in the CHANGELOG heading.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = '[0-9]+\\.[0-9]+\\.[0-9]+';
const SEMVER_RE = new RegExp(`^${SEMVER}$`);
class Fail extends Error {}
/** @param {string} m */
const die = (m) => { throw new Fail(`bump-version: ${m}`); };
/** A version with its dots escaped for a regular expression. @param {string} v */
const re = (v) => v.replace(/\./g, '\\.');
/** A version as a regular-expression LITERAL spells it inside a JavaScript test (0\.0\.25 in the file). @param {string} v */
const jsLit = (v) => v.replace(/\./g, '\\.');

/**
 * @typedef {{ file: string, pre: string, post: string, js: boolean, range?: 'frontmatter' }} Site
 * file: the file; pre and post: ERE anchoring the version; js: the file spells the version as a regex literal; range: confine the rewrite to the
 * front matter of a SKILL.md (lines 1 up to the second `---`).
 */
/** The version-holding sites (listed in CONTRIBUTING.md). @param {string} root @returns {Site[]} */
export function sites(root) {
  /** @type {Site[]} */ const s = [
    { file: 'control-plane/agents/scripts/core/proflinecli.mjs', pre: "^export const PROOFLINE_VERSION = '", post: "';$", js: false },
    { file: '.claude-plugin/plugin.json', pre: '^  "version": "', post: '",$', js: false },
    { file: '.claude-plugin/marketplace.json', pre: '^ *"version": "', post: '"$', js: false },
    { file: 'control-plane/agents/config.yaml', pre: '^proofline_version: ', post: '$', js: false },
    { file: 'playground/package.json', pre: '^  "version": "', post: '",?$', js: false },
  ];
  const skills = path.join(root, 'skills');
  if (existsSync(skills)) {
    for (const n of readdirSync(skills).sort()) if (existsSync(path.join(skills, n, 'SKILL.md'))) s.push({ file: `skills/${n}/SKILL.md`, pre: '^  version: "', post: '"$', js: false, range: 'frontmatter' });
  }
  s.push(
    { file: 'skills/exploit-proof/scripts/diff-manifests.mjs', pre: '^export const SKILL_VERSION = "', post: '";$', js: false },
    { file: 'skills/proof-review/scripts/check-config.mjs', pre: '^export const SKILL_VERSION = "', post: '";$', js: false },
    { file: 'skills/proof-review/references/REPORTING.md', pre: '^  "skill_version": "', post: '",$', js: false },
    { file: 'README.md', pre: '^Version ', post: ' is an early release\\.$', js: false },
    { file: 'README.md', pre: '^Version \\*\\*', post: '\\*\\*: full scope', js: false },
    { file: 'adapters/README.md', pre: '^## Support status \\(', post: '\\)$', js: false },
    { file: 'fixtures/concurrency-proof/selfcheck.mjs', pre: 'skill_version: "', post: '"', js: false },
    { file: 'fixtures/insights/setup.mjs', pre: 'proofline_version: ', post: '\\\\nmetrics', js: false },
    { file: 'tests/skills/concurrency-proof.test.mjs', pre: 'schema_version: 1, skill_version: "', post: '"', js: false },
    { file: 'tests/skills/proof-review.test.mjs', pre: 'schema_version: 1, skill_version: "', post: '"', js: false },
    { file: 'tests/skills/data-design.test.mjs', pre: '\\\\n  version: "', post: '"\\\\n---', js: true },
    { file: 'tests/skills/proofline-lead.test.mjs', pre: '\\^ \\{2\\}version: "', post: '"\\$/m', js: true },
  );
  return s;
}

/** @param {string} root @returns {string} the current version, from plugin.json */
function currentVersion(root) {
  const text = readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8');
  const m = /^ {2}"version": "([0-9][0-9.]*)",$/m.exec(text);
  if (!m || !SEMVER_RE.test(m[1])) die('cannot read the current version from .claude-plugin/plugin.json');
  return m[1];
}

/** Which lines of a file a site may rewrite. @param {string[]} lines @param {Site} s @returns {boolean[]} */
function inRange(lines, s) {
  if (s.range !== 'frontmatter') return lines.map(() => true);
  const out = lines.map(() => false);
  let end = lines.length - 1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  for (let i = 0; i <= end; i++) out[i] = true;
  return out;
}

/**
 * Probe, check or bump one site.
 * @param {string} root @param {Site} s @param {'probe' | 'check' | 'bump'} mode @param {string} cur @param {string} next
 * @returns {string[]} the problems found (check mode)
 */
function site(root, s, mode, cur, next) {
  const f = path.join(root, s.file);
  if (!existsSync(f)) die(`missing site file ${s.file}`);
  const anyv = s.js ? '[0-9]+\\\\\\.[0-9]+\\\\\\.[0-9]+' : SEMVER;
  const oldv = s.js ? cur.replace(/\./g, '\\\\\\.') : re(cur);
  const newv = s.js ? jsLit(next) : next;
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const grep = (/** @type {string} */ v) => lines.some((l) => new RegExp(`${s.pre}${v}${s.post}`).test(l));
  if (mode === 'probe') { if (!grep(oldv)) die(`site not found in ${s.file}: ${s.pre}`); return []; }
  if (mode === 'check') {
    if (grep(anyv)) return grep(oldv) ? [] : [`mismatch: ${s.file} (${s.pre}) is not ${cur}`];
    return [`missing: ${s.file} (${s.pre})`];
  }
  const rx = new RegExp(`(${s.pre})${oldv}(${s.post})`);
  const ok = inRange(lines, s);
  writeFileSync(f, lines.map((l, i) => (ok[i] ? l.replace(rx, (_m, a, b) => `${a}${newv}${b}`) : l)).join('\n'));
  return [];
}

/**
 * @param {string[]} argv @param {{ root?: string, env?: NodeJS.ProcessEnv, write?: (s: string) => void, generators?: boolean }} [o] @returns {number} the exit status
 */
export function main(argv, o = {}) {
  const root = o.root ?? path.resolve(import.meta.dirname, '../..');
  const write = o.write ?? ((s) => process.stdout.write(s));
  try {
    const cur = currentVersion(root);
    if (argv.length !== 1) die('usage: bump-version.mjs <new-version> | --check');
    const check = argv[0] === '--check';
    const next = check ? cur : argv[0];
    if (!check) {
      if (!SEMVER_RE.test(next)) die(`invalid version '${next}' (want MAJOR.MINOR.PATCH)`);
      if (next === cur) die(`new version equals the current version ${cur}`);
    }
    const all = sites(root);
    if (check) {
      const bad = all.flatMap((s) => site(root, s, 'check', cur, cur));
      for (const b of bad) write(`${b}\n`);
      if (bad.length) die(`version sites disagree with plugin.json (${cur})`);
      write(`bump-version: every version site is ${cur}\n`);
      return 0;
    }
    // CHANGELOG: the Unreleased section must have entries to move
    const cl = path.join(root, 'CHANGELOG.md');
    const clLines = readFileSync(cl, 'utf8').split('\n');
    let u = false; let n = 0;
    for (const l of clLines) { if (l === '## Unreleased') { u = true; continue; } if (u && l.startsWith('## ')) break; if (u && l.trim() !== '') n++; }
    if (n === 0) die('CHANGELOG.md has no Unreleased entries to move');
    for (const s of all) site(root, s, 'probe', cur, next);
    for (const s of all) site(root, s, 'bump', cur, next);
    const date = o.env?.BUMP_DATE ?? process.env.BUMP_DATE ?? new Date().toLocaleDateString('sv-SE');
    writeFileSync(cl, clLines.flatMap((l) => (l === '## Unreleased' ? [l, '', `## ${next} — ${date}`] : [l])).join('\n'));
    if (o.generators !== false) {
      for (const g of ['adapters/generate.mjs', 'docs/reference/generate-skills.mjs']) {
        const r = spawnSync(process.execPath, [g], { cwd: root, encoding: 'utf8' });
        if (r.status !== 0) die(`${g} failed: ${r.stderr}${r.stdout}`);
      }
    }
    write(`bump-version: ${cur} -> ${next}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Fail) { console.error(e.message); return 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
