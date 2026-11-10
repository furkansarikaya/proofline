// @ts-check
// Static repository rules that need no test run (A162). CI's static job runs it, also for documentation-only pull requests.
//
// usage: node check-static.mjs [--root DIR]
//
// 1. Shortcut comments use proofline's own label. A code comment marks a deliberate shortcut as
//    `shortcut: <limit>, <when to improve>` (read by `proofline debt`); a comment that carries another tool's label
//    (FOREIGN_TAGS) anywhere in its comment part is a failure. Markdown (docs, decisions, CHANGELOG), tests/ and .claude/ are not scanned: they
//    may quote a tag. To forbid one more label, add it to FOREIGN_TAGS.
// 2. README.md says what proofline is and how to use it; detail belongs in docs/concepts. It may not grow past
//    README_MAX_LINES lines or README_MAX_BYTES bytes (the slimmed size plus about 10 percent). Raise a bound only
//    together with a decision that says why the README needs the room.
// 3. No third-party project name outside the notices file (A170). The names are read from the header list of
//    skills/ui-design/library/THIRD_PARTY_NOTICES.md (lines `- <id> | <name> | <url>`), never hardcoded here. Every tracked
//    or untracked file except that notices file and .claude/ is scanned, case-insensitively. Without a notices file the rule passes.
// 4. Captured tool output in tests/skills/fixtures/tdd-proof-output holds no personal path: /Users/, /home/<name>/... (a
//    bare /home/user is allowed), /private/var, /var/folders, /opt/homebrew or C:\Users. Redact such a path to /work/... when a fixture is added.
// 5. No ecosystem branching in shared shell scripts (A187). proofline writes no ecosystem-specific code: what an ecosystem
//    is and how it builds, tests, lints and lists workspace members is data in control-plane/agents/ecosystems.json. A line of
//    bin/, control-plane/agents/ (scripts, githooks, task-integrations), adapters/ or skills/*/scripts shell scripts that
//    branches on an ecosystem id (a case label such as `go)` or `npm|pnpm)`, or a comparison such as `[ "$x" = dotnet ]`) fails.
//    The ids are read from ecosystems.json, never hardcoded here. Excluded: the self-tests (*-test.sh, tests/) and comment lines. A line that names an interpreter or
//    a tool and not an ecosystem (a process-group method, an interpreter whose inline code a safety hook reads) may be marked
//    by a comment line directly above it: `# eco-ok: <why this is not ecosystem knowledge>`. A line that names a plain manifest, project
//    or lock file of an ecosystem (`package.json`, `go.mod`, `Cargo.lock`, ... read from ecosystems.json) is the same kind of knowledge and fails too.
//
// Prints PASS or FAIL per rule. Exit 0 when every rule passes, 1 on a failure, 2 on a usage error.
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flatten } from '../../control-plane/agents/ecosystems.mjs';

export const FOREIGN_TAGS = 'ponytail';
export const README_MAX_LINES = 158;
export const README_MAX_BYTES = 12340;

/** @param {string} root @param {string[]} [specs] the tracked and untracked files, or null when the root is not a git repository */
function gitFiles(root, specs = ['.']) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs], { encoding: 'latin1', maxBuffer: 1 << 28 });
    return [...new Set(out.split('\0').filter(Boolean))].filter((f) => existsSync(path.join(root, f)));
  } catch { return null; }
}
/** Every file below a directory (relative paths), skipping .git. @param {string} root @param {string} [rel] @returns {string[]} */
function walk(root, rel = '') {
  /** @type {string[]} */ const out = [];
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r)); else if (e.isFile()) out.push(r);
  }
  return out.sort();
}
const isBinary = (/** @type {Buffer} */ b) => b.subarray(0, 8000).includes(0);

/**
 * Lines of the files that match, as `git grep -n` prints them (path:line:text); binary files are skipped (-I).
 * @param {string} root @param {string[]} files @param {RegExp} rx
 */
function grepFiles(root, files, rx) {
  /** @type {string[]} */ const hits = [];
  for (const f of files) {
    let buf;
    try { buf = readFileSync(path.join(root, f)); } catch { continue; }
    if (isBinary(buf)) continue;
    const lines = buf.toString('latin1').split('\n');
    lines.forEach((l, i) => { if (rx.test(l)) hits.push(`${f}:${i + 1}:${l.replace(/\r$/, '')}`); });
  }
  return hits;
}
const clip = (/** @type {string[]} */ hits) => hits.map((h) => `  ${h.slice(0, 200)}`);

/** A glob like the shell `case` patterns used by rule 5's exclusions. @param {string} f */
function excludedFromRule5(f) {
  return /\/fixtures\//.test(f) || /\/templates\//.test(f) || /\/library\//.test(f) || /-test\.sh$/.test(f)
    || /\.(md|json|toml|tsv|mjs|yaml|yml|conf)$/.test(f);
}
const firstLine = (/** @type {string} */ file) => {
  let fd;
  try { fd = openSync(file, 'r'); const b = Buffer.alloc(256); const n = readSync(fd, b, 0, 256, 0); return b.subarray(0, n).toString('latin1').split('\n')[0]; } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
};

/**
 * Run the rules on a root. @param {string} root @param {{ foreignTags?: string }} [o] @returns {{ lines: string[], status: number }}
 */
export function check(root, o = {}) {
  /** @type {string[]} */ const out = [];
  let status = 0;
  const gitList = gitFiles(root);
  const isGit = gitList !== null;
  const all = gitList ?? walk(root);

  // 1. foreign shortcut labels in code comments
  const tags = o.foreignTags ?? FOREIGN_TAGS;
  const alt = tags.split(/[ ,]+/).filter(Boolean).join('|');
  // A comment prefix (# // -- /* <!-- ; % (* or a line that starts with ' or *) followed by the tag anywhere after other comment text (`# TODO ponytail: x`), or a bare line that starts with the tag (a block comment's continuation line).
  const pat = new RegExp(`(#|//|--|/\\*|<!--|;|%|\\(\\*|^\\s*['*]).*(^|[^A-Za-z0-9_])(${alt}):|^\\s*(${alt}):`, 'i');
  const scanned1 = all.filter((f) => (isGit ? !/\.md$/.test(f) && !/^(tests|\.claude|\.agents)(\/|$)/.test(f) : !/\.md$/.test(f) && !f.split('/').slice(0, -1).some((d) => ['tests', '.claude', '.agents'].includes(d))));
  const hits1 = grepFiles(root, scanned1, pat).map((h) => (isGit ? h : `./${h}`));
  if (hits1.length === 0) out.push(`PASS shortcut labels (none of: ${tags})`);
  else {
    out.push(`FAIL shortcut labels: write \`shortcut: <limit>, <when to improve>\` instead of a foreign label (${tags})`, ...clip(hits1));
    status = 1;
  }

  // 2. README size
  const readme = path.join(root, 'README.md');
  if (existsSync(readme)) {
    const b = readFileSync(readme);
    const lines = b.filter((x) => x === 10).length;   // wc -l
    const bytes = b.length;
    if (lines <= README_MAX_LINES && bytes <= README_MAX_BYTES) out.push(`PASS README size (${lines} lines of ${README_MAX_LINES}, ${bytes} bytes of ${README_MAX_BYTES})`);
    else { out.push(`FAIL README size: ${lines} lines (max ${README_MAX_LINES}), ${bytes} bytes (max ${README_MAX_BYTES}); move detail to docs/concepts and link it`); status = 1; }
  } else { out.push('FAIL README size: README.md is missing'); status = 1; }

  // 3. third-party names
  const nf = 'skills/ui-design/library/THIRD_PARTY_NOTICES.md';
  /** @type {string[]} */ let names = [];
  /** @type {string[]} */ let copies = [];
  if (existsSync(path.join(root, nf))) {
    const text = readFileSync(path.join(root, nf), 'utf8');
    names = text.split('\n').flatMap((l) => { const m = /^- source-[0-9]+ \| ([^|]*[^ |]) *\|.*/.exec(l); return m ? [m[1]] : []; });
    copies = text.split('\n').flatMap((l) => { const m = /^ {2}- `([^`]*)` sha256 .*/.exec(l); return m ? [m[1]] : []; });
  }
  if (names.length === 0) out.push('PASS third-party names (no notices file or no names listed)');
  else {
    // variants: case, hyphens, underscores and spaces are ignored (a hyphenated name also matches its joined spelling)
    const variants = names.join(' ').split(/\s+/).filter(Boolean).map((n) => n.replace(/[ _-]/g, '').replace(/./g, '$&[-_ ]*').replace(/\[-_ \]\*$/, ''));
    const rx = new RegExp(variants.join('|'), 'i');
    const skip = new Set([nf, ...copies.map((c) => `skills/ui-design/library/${c}`)]);
    const files3 = all.filter((f) => !skip.has(f) && !/^\.claude(\/|$)/.test(f));
    const hits3 = grepFiles(root, files3, rx).map((h) => (isGit ? h : `./${h}`));
    if (hits3.length === 0) out.push('PASS third-party names (none outside the notices file and its listed copies)');
    else { out.push("FAIL third-party names: a source name (any spelling) from the notices file appears outside it; refer to 'source N' instead", ...clip(hits3)); status = 1; }
  }

  // 4. personal paths in captured tool output
  const fx = 'tests/skills/fixtures/tdd-proof-output';
  if (existsSync(path.join(root, fx)) && statSync(path.join(root, fx)).isDirectory()) {
    const hits4 = grepFiles(root, walk(root, fx), /\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/var|\/var\/folders|\/opt\/homebrew|C:\\Users/);
    if (hits4.length === 0) out.push(`PASS no personal paths in ${fx}`);
    else { out.push(`FAIL personal paths in ${fx}: write /work/... instead of a real home directory, checkout or Homebrew path`, ...clip(hits4)); status = 1; }
  }

  // 5. ecosystem branching in shared shell scripts
  const ejson = path.join(root, 'control-plane/agents/ecosystems.json');
  /** @type {string[][]} */ let rows = [];
  try { rows = flatten(JSON.parse(readFileSync(ejson, 'utf8'))); } catch { rows = []; }
  const ids = rows.filter((r) => r[0] !== '*' && r[1] === 'id' && r[2] !== undefined).map((r) => r[2]).join('|');
  if (!ids) {
    // the rule needs the ecosystem definition to know the ids: a missing or empty table is a failure, never a pass
    out.push('FAIL ecosystem branching: no ecosystem ids (control-plane/agents/ecosystems.json is missing, invalid or lists none), so the rule can not run');
    status = 1;
  } else {
    // a case arm: the line, `;;` or ` in ` starts a pattern list (no spaces inside) in which one pattern is exactly an id
    const lbl = new RegExp(`(^\\s*|;;\\s*|\\sin\\s+)\\(?([^\\]\\s()|]+\\|)*["']?(${ids})["']?(\\|[^\\]\\s()|]+)*\\)`);
    // a test: `[ "$x" = go ]`, `[ x != go ] && ...`
    const cmp = new RegExp(`\\s(=|==|!=)\\s+["']?(${ids})["']?(\\s*(\\]|;|&|\\||\\))|\\s*$)`);
    // a plain file name (no glob, no /) that ecosystems.json lists as a manifest, project file or lock: a word in code, not part of a longer name
    const ftoks = [...new Set(rows.filter((r) => r[0] !== '*' && ['manifests', 'project_files', 'locks'].includes(r[1]) && r[2] !== undefined && !/[*?/]/.test(r[2])).map((r) => r[2]))].sort().map((x) => x.replace(/[.]/g, '[.]')).join('|');
    const tok = ftoks ? new RegExp(`(^|[^A-Za-z0-9_.-])(${ftoks})([^A-Za-z0-9_.-]|$)`) : null;
    const list = (isGit ? gitFiles(root, ['bin', 'control-plane', 'adapters', 'skills']) ?? [] : ['bin', 'control-plane', 'adapters', 'skills'].flatMap((d) => walk(root, d)));
    /** @type {string[]} */ const hits5 = [];
    for (const f of list) {
      if (excludedFromRule5(f)) continue;
      if (f.startsWith('skills/') && !/^skills\/[^/]*\/scripts\//.test(f)) continue;
      if (!existsSync(path.join(root, f)) || !statSync(path.join(root, f)).isFile()) continue;
      if (!f.endsWith('.sh') && !/^#!.*(sh|bash)/.test(firstLine(path.join(root, f)))) continue;
      let ok = false;
      readFileSync(path.join(root, f), 'latin1').split('\n').forEach((line, i, arr) => {
        if (i === arr.length - 1 && line === '') return;
        const l = line.replace(/^[ \t]+/, '');
        if (l.startsWith('#')) { ok = l.startsWith('# eco-ok:'); return; }
        if (!ok && (lbl.test(line) || cmp.test(line) || (tok !== null && tok.test(line)))) hits5.push(`${f}:${i + 1}: ${line}`);
        ok = false;
      });
    }
    if (hits5.length === 0) out.push(`PASS no ecosystem branching in shared shell scripts (ids: ${ids})`);
    else { out.push('FAIL ecosystem branching in shared scripts: move the knowledge into control-plane/agents/ecosystems.json as data (A187)', ...clip(hits5)); status = 1; }
  }
  return { lines: out, status };
}

/** @param {string[]} argv @param {{ write?: (s: string) => void }} [o] @returns {number} */
export function main(argv, o = {}) {
  const write = o.write ?? ((s) => process.stdout.write(s));
  let root = path.resolve(import.meta.dirname, '../..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      if (i + 1 >= argv.length) { console.error('check-static: --root needs a directory'); return 2; }
      const d = path.resolve(argv[++i]);
      if (!existsSync(d) || !statSync(d).isDirectory()) { console.error(`check-static: no such directory: ${argv[i]}`); return 2; }
      root = d;
    } else if (a === '-h' || a === '--help') { write('usage: node check-static.mjs [--root DIR]\n'); return 0; }
    else { console.error(`check-static: unknown argument: ${a}`); return 2; }
  }
  const r = check(root);
  write(r.lines.map((l) => `${l}\n`).join(''));
  return r.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
