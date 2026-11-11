// The no-shell-logic rule (ADR 0001 section 9), strict since stage 15 (A251). Node built-ins only. There is one mode; the ratchet of stages 1-14 (two snapshots of
// 0.0.40) is gone.
//
//   node tests/ci/no-shell-logic.mjs [--root DIR]     the repository (default: the one this file lives in); the files are `git ls-files` of it
//
// The rules (every one has a planted-violation test in tests/ci/no-shell-logic.test.mjs):
//   1. A *shell file* is a tracked file with a .sh or .bash extension, a shell shebang (sh bash dash ash zsh ksh mksh csh tcsh fish busybox), or any file under a
//      `githooks`, `.githooks` or `.husky` folder. Every shell file must be in LAUNCHERS, and no .awk file may exist.
//   2. Every launcher is BYTE-EQUAL to its section of tests/ci/launcher-templates.txt (the epic criterion "launchers equal to their templates"). Nothing is loosened:
//      the three plain launchers must also be a shebang and one `exec node "$(dirname "$0")/..."` line (launcherOk); agent.sh, whose A207/A245 redirect needs an
//      `if`/`case` and `git`, is the one launcher whose template carries logic, and the template is what pins it.
//   3. Every `command` of the three hook wiring files equals a pinned template of tests/ci/hook-templates.txt.
//   4. Every `run:` step of .github/workflows/*.yml, composite actions included, is one command line (no `if`, loops, `&&`, `||`, pipes, `;`, `$(...)`).
//   5. No `sh`, `bash`, `awk`, `sed` (or a sibling) program is started from Node outside core/proc.mjs (runUserCommand, userShellArgv, runScript): see nodeSpawnProblems.
//
// Known gaps (a tripwire, not the boundary): YAML is read by a line scanner (flow-style `steps: [...]`, anchors and `run:` values built by an expression are not seen);
// a shell file with an unusual shebang interpreter outside the list above, or a script without shebang and extension outside the hook folders, is not recognised;
// the Node scan reads source text (a program name built at run time, or started through a variable, is not seen); the template and the launcher change together in one
// pull request, so review (and the A entry) is the gate for a change of a launcher, never this script alone.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export const LAUNCHER_TEMPLATES = 'tests/ci/launcher-templates.txt';
export const HOOK_TEMPLATES = 'tests/ci/hook-templates.txt';
export const WIRING_FILES = ['adapters/claude/hooks/hooks.json', 'adapters/claude/settings.fragment.json', 'adapters/codex/hooks.json'];
// The launcher list of ADR section 9. bin/proofline is a Node program since A233 (`#!/usr/bin/env node`), not a shell launcher.
export const LAUNCHERS = new Set([
  'control-plane/agents/scripts/agent.sh',
  'control-plane/agents/scripts/dispatch.sh',
  'control-plane/agents/githooks/pre-commit',
  'control-plane/agents/githooks/pre-push',
]);

/** @typedef {{ kind: string, file: string, job: string, index: number, text: string, location: string, group: string, sha?: string, line?: number }} Item */

export function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\0').filter(Boolean);
}

function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const b = Buffer.alloc(256);
    const n = readSync(fd, b, 0, 256, 0);
    return b.subarray(0, n).toString('latin1').split('\n')[0];
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

export const SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-S\s+)?)?(?:[a-z]*sh|busybox)(?:\s|$)/;   // sh bash dash ash zsh ksh mksh csh tcsh fish busybox
export function isShellFile(root, rel) {
  if (/\.(sh|bash)$/.test(rel)) return true;
  if (rel.split('/').some((d) => d === 'githooks' || d === '.githooks' || d === '.husky')) return true;
  const abs = join(root, rel);
  try { if (!statSync(abs).isFile()) return false; } catch { return false; }
  return SHEBANG.test(firstLine(abs));
}

// A launcher's text: a shebang, comment lines, blank lines, and at most one `exec node "$(dirname "$0")/<file>" [words] ["$@"]` line (a git hook launcher reaches the core in ../scripts/ and passes no arguments: git hands pre-push the remote name and URL, which the core does not take).
export function launcherOk(text) {
  const lines = text.split('\n').map((l) => l.trimEnd());
  let exec = 0;
  for (const [i, l] of lines.entries()) {
    if (l === '' || (i > 0 && l.startsWith('#'))) continue;
    if (i === 0 && SHEBANG.test(l)) continue;
    if (/^exec node "\$\(dirname "\$0"\)\/(?:\.\.\/scripts\/)?[A-Za-z0-9_.-]+(?:\.mjs)?"(?: [a-z-]+)*(?: "\$@")?$/.test(l)) { exec++; continue; }
    return false;
  }
  return exec <= 1;
}

// ---- workflow `run:` steps: a line scanner, because Node ships no YAML parser -----------------------------------------------------------
export function runSteps(file, text) {
  const lines = text.split('\n');
  /** @type {Item[]} */
  const out = [];
  const workflow = /^\.github\/workflows\//.test(file);
  let job = workflow ? '' : 'composite';
  let inJobs = !workflow;
  let jobsIndent = -1;
  let stepDash = -1;
  let stepNo = 0;
  const indentOf = (t) => t.length - t.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
    const ind = indentOf(l);
    if (workflow) {
      if (/^jobs:\s*$/.test(l)) { inJobs = true; jobsIndent = -1; continue; }
      if (inJobs && ind === 0) inJobs = false;
      if (!inJobs) continue;
      if (jobsIndent < 0) jobsIndent = ind;
      const jm = ind === jobsIndent ? /^\s*([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(l) : null;
      if (jm) { job = jm[1]; stepNo = 0; stepDash = -1; continue; }
    }
    if (/^\s*steps:\s*(?:#.*)?$/.test(l)) { stepDash = -2; continue; }   // the next list item sets the step indentation
    if (stepDash === -2 && /^\s*- /.test(l)) stepDash = ind;
    if (stepDash >= 0 && ind === stepDash && /^\s*- /.test(l)) stepNo++;
    // any `run:` key with a value is a step command, whatever the indentation (the empty `defaults: run:` mapping is not)
    const m = /^(\s*)(- )?run:\s*(.*)$/.exec(l);
    if (!m || m[3].trim() === '' || m[3].trim().startsWith('#')) continue;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    const startLine = i + 1;
    let body = m[3];
    let text1;
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(body)) {
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j];
        if (t.trim() === '') { block.push(''); continue; }
        if (indentOf(t) <= keyIndent) break;
        block.push(t);
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      const strip = Math.min(...block.filter((x) => x !== '').map(indentOf));
      text1 = block.map((x) => (x === '' ? '' : x.slice(strip))).join('\n');
      i = j - 1;
    } else {
      body = body.trim();
      if ((body.startsWith('"') && body.endsWith('"') && body.length > 1) || (body.startsWith("'") && body.endsWith("'") && body.length > 1)) body = body.slice(1, -1);
      text1 = body;
    }
    out.push({ kind: 'run', file, job, index: stepNo, line: startLine, text: text1, location: `${file}::${job}::step${stepNo}`, group: `${file}::${job}` });
  }
  return out;
}

// The strict rule for a `run:` step: one command line. GitHub ${{ }} expressions are not shell. A trailing backslash continues the line.
export function stepStrictProblem(text) {
  const t = text.replace(/\$\{\{[\s\S]*?\}\}/g, 'X').replace(/\\\n/g, ' ').trim();
  if (t === '') return 'empty step';
  const logical = t.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (logical.length !== 1) return `${logical.length} command lines (a step is one command line)`;
  const line = logical[0].trim();
  if (/^(if|for|while|until|case|select|function)\b|^[{(]/.test(line)) return `starts with shell syntax (${line.split(/\s/)[0]})`;
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const two = line.slice(i, i + 2);
    if (q === "'") { if (c === "'") q = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"') { if (c === '"') q = ''; else if (two === '$(' || c === '`') return `command substitution at column ${i + 1}`; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (two === '$(' || c === '`') return `command substitution at column ${i + 1}`;
    if (two === '&&' || two === '||') return `${two} at column ${i + 1}`;
    if (c === ';') return `; at column ${i + 1}`;
    if (c === '|') return `pipe at column ${i + 1}`;
    if (c === '&' && line[i - 1] !== '>' && line[i + 1] !== '>') return `& at column ${i + 1}`;
  }
  return '';
}

// ---- hook command strings ------------------------------------------------------------------------------------------------------------
export function hookStrings(file, text) {
  /** @type {Item[]} */
  const out = [];
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${file}: not JSON: ${e.message}`); }
  const hooks = j.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    let n = 0;
    for (const g of groups ?? []) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command !== 'string') continue;
        out.push({ kind: 'hook', file, job: event, index: n, text: h.command, location: `${file}::${event}::${n}`, group: `${file}::${event}` });
        n++;
      }
    }
  }
  return out;
}

export function hookTemplates(root) {
  const f = join(root, HOOK_TEMPLATES);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
}
// The pinned template of a hook event: `<event>` and `<runtime>` stand for the event argument and the runtime. Stage 3 fixes the strings.
export function hookStrictProblem(text, templates) {
  for (const t of templates) {
    const re = new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<event>/g, '[a-z-]+').replace(/<runtime>/g, '(?:claude|codex)')}$`);
    if (re.test(text)) return '';
  }
  return templates.length ? 'does not equal a pinned hook template' : `no pinned hook template exists yet (${HOOK_TEMPLATES}); a new or changed hook string cannot pass`;
}

// ---- launcher templates ----------------------------------------------------------------------------------------------------------------
/** The sections of tests/ci/launcher-templates.txt: `@@ <path>` starts one, its text runs to the next `@@ ` line (the lines before the first section are comments). @param {string} text @returns {Map<string, string>} */
export function parseLauncherTemplates(text) {
  /** @type {Map<string, string>} */ const out = new Map();
  const parts = text.split(/^@@ (.+)\n/m);   // [comments, path1, text1, path2, text2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    if (out.has(parts[i])) throw new Error(`${LAUNCHER_TEMPLATES}: two sections for ${parts[i]}`);
    out.set(parts[i], parts[i + 1]);
  }
  return out;
}

/** The launchers whose template may carry logic (the A207/A245 redirect: which core runs is decided there). The others must also pass launcherOk. */
export const LOGIC_LAUNCHERS = new Set(['control-plane/agents/scripts/agent.sh']);

/** @param {string} root @returns {string[]} */
export function launcherProblems(root) {
  /** @type {string[]} */ const problems = [];
  const f = join(root, LAUNCHER_TEMPLATES);
  if (!existsSync(f)) return [`${LAUNCHER_TEMPLATES} is missing`];
  /** @type {Map<string, string>} */ let templates;
  try { templates = parseLauncherTemplates(readFileSync(f, 'utf8')); } catch (e) { return [/** @type {Error} */ (e).message]; }
  for (const t of templates.keys()) if (!LAUNCHERS.has(t)) problems.push(`${LAUNCHER_TEMPLATES}: a template for ${t}, which is not in the launcher list`);
  const tracked = new Set(trackedFiles(root));
  for (const l of [...LAUNCHERS].sort()) {
    const t = templates.get(l);
    if (t === undefined) { problems.push(`${l}: no template in ${LAUNCHER_TEMPLATES}`); continue; }
    if (!LOGIC_LAUNCHERS.has(l) && !launcherOk(t)) problems.push(`${LAUNCHER_TEMPLATES}: the template of ${l} is not a shebang and one exec node line`);
    if (!tracked.has(l) || !existsSync(join(root, l))) { problems.push(`${l}: the launcher is missing`); continue; }
    if (readFileSync(join(root, l), 'utf8') !== t) problems.push(`${l}: a launcher must be byte-equal to its template in ${LAUNCHER_TEMPLATES}`);
  }
  return problems;
}

// ---- programs started from Node ----------------------------------------------------------------------------------------------------------
const SHELL_PROGRAMS = 'sh|bash|dash|zsh|ksh|mksh|ash|busybox';
const TEXT_PROGRAMS = 'awk|gawk|mawk|nawk|sed|gsed';
const Q = '([\'"`])(?:/(?:usr/)?bin/)?';
// a text tool named as a string anywhere in code; a shell named as the program of a spawn-like call (its first or second argument, alone or first in an array),
// or as the head of a `[sh, '-c', ...]` vector
const TEXT_TOOL = new RegExp(`${Q}(?:${TEXT_PROGRAMS})\\1`);
const SHELL_SPAWN = new RegExp(`\\b[A-Za-z_.]*(?:spawn|exec|run|fork)[A-Za-z]*\\(\\s*(?:[^()\\n]*?,\\s*)?\\[?\\s*${Q}(?:${SHELL_PROGRAMS})\\1\\s*[,)\\]]`, 'i');
const SHELL_VECTOR = new RegExp(`\\[\\s*${Q}(?:${SHELL_PROGRAMS})\\1\\s*,\\s*(['"\`])-c\\2`);
/** The only module that may name a shell or text tool as a program (runUserCommand, userShellArgv, runScript). */
export const PROC_MODULE = 'control-plane/agents/scripts/core/proc.mjs';
/** Hook guards and the command scanner read command TEXT and name awk, sed and the shells as data (lists of words to recognise); only the text-tool rule skips them, a spawn of a shell is refused there too. */
export const TEXT_ONLY = (/** @type {string} */ f) => f === 'adapters/claude/hooks/command-scan.mjs' || f.startsWith('adapters/claude/hooks/guards/');
/** Node sources the rule covers: product code, not the tests, not the docs. */
export const nodeSourceFile = (/** @type {string} */ f) => /\.(mjs|js|cjs)$/.test(f) && !/^(tests|docs|fixtures)\//.test(f) && f !== PROC_MODULE;

/** @param {string} root @returns {string[]} */
export function nodeSpawnProblems(root) {
  /** @type {string[]} */ const problems = [];
  for (const f of trackedFiles(root).filter(nodeSourceFile)) {
    let text;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (const [i, raw] of lines.entries()) {
      const l = raw.trim();
      if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')) continue;
      const where = `${f}:${i + 1}`;
      if (!TEXT_ONLY(f) && TEXT_TOOL.test(l)) problems.push(`${where}: a text tool (awk or sed) is named as a string; its work is Node code`);
      if (SHELL_SPAWN.test(l) || SHELL_VECTOR.test(l)) problems.push(`${where}: a shell is started from Node outside core/proc.mjs (use runUserCommand for a user's command string, runScript for a script file)`);
    }
  }
  return problems;
}

// ---- inline items and shell files -------------------------------------------------------------------------------------------------------
export function currentInline(root) {
  /** @type {Item[]} */
  const items = [];
  const files = trackedFiles(root);
  for (const rel of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^\.github\/actions\/.+\.ya?ml$/.test(f) || /(^|\/)action\.ya?ml$/.test(f))) items.push(...runSteps(rel, readFileSync(join(root, rel), 'utf8')));
  for (const rel of WIRING_FILES) if (files.includes(rel)) items.push(...hookStrings(rel, readFileSync(join(root, rel), 'utf8')));
  return items;
}
export function currentShellFiles(root) {
  return trackedFiles(root).filter((f) => isShellFile(root, f)).sort();
}

// ---- the check -------------------------------------------------------------------------------------------------------------------------
/** @param {string} root @returns {string[]} the problems; none means the repository is clean */
export function check(root) {
  /** @type {string[]} */ const problems = [];
  const templates = hookTemplates(root);
  for (const f of trackedFiles(root)) if (f.endsWith('.awk')) problems.push(`${f}: an .awk file (no awk anywhere)`);
  for (const f of currentShellFiles(root)) if (!LAUNCHERS.has(f)) problems.push(`${f}: a shell file that is not in the launcher list`);
  problems.push(...launcherProblems(root));
  for (const it of currentInline(root)) {
    const p = it.kind === 'run' ? stepStrictProblem(it.text) : hookStrictProblem(it.text, templates);
    if (p) problems.push(`${it.location}${it.line ? ` (line ${it.line})` : ''}: ${p}`);
  }
  problems.push(...nodeSpawnProblems(root));
  return problems;
}

function main(argv) {
  let root = resolve(import.meta.dirname, '../..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = resolve(argv[++i]);
    else if (a === '--strict') continue;   // the one mode; the flag of stages 1-14 is still accepted
    else { process.stderr.write(`no-shell-logic: unknown argument ${a}\n`); return 2; }
  }
  const problems = check(root);
  if (problems.length === 0) {
    process.stdout.write('no-shell-logic: ok (strict)\n');
    return 0;
  }
  for (const p of problems) process.stderr.write(`no-shell-logic: ${p}\n`);
  process.stderr.write(`no-shell-logic: ${problems.length} problem(s) (${basename(root)})\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exitCode = main(process.argv.slice(2));
