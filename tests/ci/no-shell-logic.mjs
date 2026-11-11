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
// Known gaps (a tripwire against honest mistakes, not a boundary; A251 lists them so nobody reads more into a green run than it says):
//   - YAML is read by a line scanner: anchors and `run:` values built by an expression are not seen; flow-style `steps: [...]` and a `run:` inside braces are refused (not read);
//     JS inside a workflow (`actions/github-script`) is refused (`script:` key), a custom `shell:` template is refused.
//   - A one-line step that hands a shell program to a program (`run: bash -c 'if x; then y; fi'`) is one command line and passes.
//   - A shell file with an unusual shebang interpreter outside the list above, or a script without shebang and extension outside the hook folders, is not recognised.
//   - Comments are blanked only when they are a whole line (`//`, or a block comment opening a line); a trailing comment stays visible and may be a false positive (reword it).
//   - ACCEPTED LIMIT (A251, A252): a line-leading unclosed block-comment opener inside a multi-line template literal or string continuation opens a block that runs to the
//     next block-comment closer anywhere and can hide later real code. No such file is in the tree (a differential check over 249 files shows zero hidden code characters);
//     the false-positive direction is preferred; the independent TypeScript-scanner differential run is the check.
//   - The Node scan reads source text of .mjs .js .cjs .ts .mts .cts files outside tests/, docs/ and fixtures/: a program name built at run time or started through a variable
//     or a destructured alias, and `sh tools/x` where the script has no shebang and no extension, are not seen; a call head is joined across lines, but only up to the first
//     parenthesis; `execSync`, `exec` (imported from child_process), `{ shell: true }` and powershell/cmd are refused.
//   - The template and the launcher change together in one pull request: review is the gate for a launcher change (CODEOWNERS, the `Launcher-change:` line that
//     tests/ci/change-reason.mjs asks for, and the A entry), never this script alone. The mode (100755) of the launchers and hooks is checked.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export const LAUNCHER_TEMPLATES = 'tests/ci/launcher-templates.txt';
export const HOOK_TEMPLATES = 'tests/ci/hook-templates.txt';
export const WIRING_FILES = ['adapters/claude/hooks/hooks.json', 'adapters/claude/settings.fragment.json', 'adapters/codex/hooks.json'];   // the three files of 0.0.40 (the census reads old refs with it)
/** Every tracked hooks*.json or settings*.json is a hook wiring file, whatever its folder (a fourth file cannot hide a string). @param {string} rel */
export const isWiringFile = (rel) => /(^|\/)(hooks|settings)[^/]*\.json$/i.test(rel);
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
  const lines = text.replace(/\r/g, '').split('\n');   // CRLF files: a trailing CR would make the step regexes miss
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
      const dq = body.startsWith('"') && body.endsWith('"') && body.length > 1;
      if (dq || (body.startsWith("'") && body.endsWith("'") && body.length > 1)) body = body.slice(1, -1);
      if (dq) body = body.replace(/\\n/g, '\n');   // a double-quoted YAML scalar: \n is a line end
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
export function launcherProblems(root, files = trackedFiles(root)) {
  /** @type {string[]} */ const problems = [];
  const f = join(root, LAUNCHER_TEMPLATES);
  if (!existsSync(f)) return [`${LAUNCHER_TEMPLATES} is missing`];
  /** @type {Map<string, string>} */ let templates;
  try { templates = parseLauncherTemplates(readFileSync(f, 'utf8')); } catch (e) { return [/** @type {Error} */ (e).message]; }
  for (const t of templates.keys()) if (!LAUNCHERS.has(t)) problems.push(`${LAUNCHER_TEMPLATES}: a template for ${t}, which is not in the launcher list`);
  const tracked = new Set(files);
  /** @type {Map<string, string>} */ const modes = new Map();
  for (const rec of execFileSync('git', ['-C', root, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)) {
    const m = /^(\d+) [0-9a-f]+ \d\t([^]*)$/.exec(rec);
    if (m) modes.set(m[2], m[1]);
  }
  for (const l of [...LAUNCHERS].sort()) {
    const t = templates.get(l);
    if (t === undefined) { problems.push(`${l}: no template in ${LAUNCHER_TEMPLATES}`); continue; }
    if (!LOGIC_LAUNCHERS.has(l) && !launcherOk(t)) problems.push(`${LAUNCHER_TEMPLATES}: the template of ${l} is not a shebang and one exec node line`);
    if (!tracked.has(l) || !existsSync(join(root, l))) { problems.push(`${l}: the launcher is missing`); continue; }
    if (readFileSync(join(root, l), 'utf8') !== t) problems.push(`${l}: a launcher must be byte-equal to its template in ${LAUNCHER_TEMPLATES}`);
    if (modes.get(l) !== '100755') problems.push(`${l}: a launcher must be executable in the index (mode 100755, found ${modes.get(l) ?? 'none'}); git skips a git hook that is not executable`);
  }
  return problems;
}

// ---- programs started from Node ----------------------------------------------------------------------------------------------------------
const SHELL_PROGRAMS = 'sh|bash|dash|zsh|ksh|mksh|ash|busybox|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|cmd(?:\\.exe)?';
const TEXT_PROGRAMS = 'awk|gawk|mawk|nawk|sed|gsed';
const Q = '([\'"`])(?:/(?:usr/)?bin/)?';
// a text tool named as a string anywhere in code; a shell named as the program of a spawn-like call (its first or second argument, alone or first in an array),
// or as the head of a `[sh, '-c', ...]` vector
const TEXT_TOOL = new RegExp(`${Q}(?:${TEXT_PROGRAMS})\\1`);
const SHELL_SPAWN = new RegExp(`\\b[A-Za-z_.]*(?:spawn|exec|run|fork)[A-Za-z]*\\(\\s*(?:[^()]*?,\\s*)?\\[?\\s*${Q}(?:${SHELL_PROGRAMS})\\1\\s*[,)\\]]`, 'i');   // [^()]: the head may span lines, never a parenthesis
/** Implicit shells: execSync and exec (when imported from child_process) take a command STRING, and `shell: true` or a shell name makes any spawn one. */
const SHELL_OPTION = /\bshell\s*:\s*(?:true\b|['"`])/;
const EXEC_CALL = /(?:\bexecSync|\b(?:cp|child_process|childProcess)\.exec)\s*\(/;
const EXEC_IMPORT = /import\s*\{[^}]*(?<!as\s)\bexec\b(?!\s+as)[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/;
const SHELL_VECTOR = new RegExp(`\\[\\s*${Q}(?:${SHELL_PROGRAMS})\\1\\s*,\\s*(['"\`])-c\\2`);
/** The only module that may name a shell or text tool as a program (runUserCommand, userShellArgv, runScript). */
export const PROC_MODULE = 'control-plane/agents/scripts/core/proc.mjs';
/** Hook guards and the command scanner read command TEXT and name awk, sed and the shells as data (lists of words to recognise); only the text-tool rule skips them, a spawn of a shell is refused there too. */
export const TEXT_ONLY = (/** @type {string} */ f) => f === 'adapters/claude/hooks/command-scan.mjs' || f.startsWith('adapters/claude/hooks/guards/');
/** Node sources the rule covers: product code, not the tests, not the docs. */
export const nodeSourceFile = (/** @type {string} */ f) => (/\.(mjs|js|cjs|mts|cts|ts)$/.test(f) || f === 'bin/proofline') && !/^(tests|docs|fixtures)\//.test(f) && f !== PROC_MODULE;

/**
 * The source with the UNAMBIGUOUS comments blanked (every character but the line breaks becomes a space, so offsets and line numbers hold). The gate errs toward
 * visibility: a false positive (a comment that mentions execSync) is fixed by rewording the comment, hidden real code is the failure. A JS tokenizer written by hand
 * is wrong somewhere (a regex after `=>`, `return` or `+`, a nested template, a backtick in a regex each hid real code from the scan), so none is attempted. Only two
 * things are blanked: (a) a line whose first non-space characters are `//`; (b) a block comment whose `/*` is the first non-space token of a line, through its `*` + `/`
 * (code after the closing `*` + `/` on the same line stays visible). A trailing `//` comment and a `/*` in mid-line stay visible: that is the documented false-positive direction.
 * @param {string} text
 */
export function stripComments(text) {
  let inBlock = false;
  return text.split('\n').map((line) => {
    if (inBlock) {
      const e = line.indexOf('*/');
      if (e < 0) return line.replace(/[^\r]/g, ' ');
      inBlock = false;
      return line.slice(0, e + 2).replace(/[^\r]/g, ' ') + line.slice(e + 2);
    }
    const t = line.trimStart();
    if (t.startsWith('//')) return line.replace(/[^\r]/g, ' ');
    if (t.startsWith('/*')) {
      const from = line.length - t.length;
      const e = line.indexOf('*/', from + 2);
      if (e < 0) { inBlock = true; return line.replace(/[^\r]/g, ' '); }
      return line.slice(0, e + 2).replace(/[^\r]/g, ' ') + line.slice(e + 2);
    }
    return line;
  }).join('\n');
}

/** @param {string} root @returns {string[]} */
export function nodeSpawnProblems(root, files = trackedFiles(root)) {
  /** @type {string[]} */ const problems = [];
  for (const f of files.filter(nodeSourceFile)) {
    let text;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const code = stripComments(text);
    const lineOf = (/** @type {number} */ at) => code.slice(0, at).split('\n').length;
    /** @param {RegExp} re @param {string} msg */
    const flag = (re, msg) => { for (const m of code.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) problems.push(`${f}:${lineOf(m.index ?? 0)}: ${msg}`); };
    if (!TEXT_ONLY(f)) flag(TEXT_TOOL, 'a text tool (awk or sed) is named as a string; its work is Node code');
    flag(SHELL_SPAWN, "a shell is started from Node outside core/proc.mjs (use runUserCommand for a user's command string, runScript for a script file)");
    flag(SHELL_VECTOR, "a shell is started from Node outside core/proc.mjs (use runUserCommand for a user's command string, runScript for a script file)");
    flag(SHELL_OPTION, 'an option `shell:` hands a command string to a shell; use runUserCommand (core/proc.mjs) for a user command');
    flag(EXEC_CALL, 'exec / execSync hand a command string to a shell; use runUserCommand (core/proc.mjs) for a user command');
    if (EXEC_IMPORT.test(code)) flag(/(?<![.\w])exec\s*\(/, 'exec (child_process) hands a command string to a shell; use runUserCommand (core/proc.mjs) for a user command');
  }
  return problems;
}

// ---- workflow constructs the line scanner cannot read: refused, not guessed ----------------------------------------------------------------
/** @param {string} file @param {string} text @returns {string[]} */
export function workflowTextProblems(file, text) {
  /** @type {string[]} */ const out = [];
  for (const [i, raw] of text.replace(/\r/g, '').split('\n').entries()) {
    const l = raw.trim();
    if (l.startsWith('#')) continue;
    const at = `${file}:${i + 1}`;
    if (/^steps:\s*\[/.test(l)) out.push(`${at}: a flow-style steps list is not read by the check; write the steps as a block`);
    else if (/[{,]\s*["']?run["']?\s*:/.test(l) && !/^\s*-?\s*run\s*:/.test(raw)) out.push(`${at}: a run: inside a flow mapping is not read by the check; write it as a block key`);
    if (/^-?\s*["']?script["']?\s*:/.test(l)) out.push(`${at}: a script: key (JS of github-script) is logic in a workflow; move it to a Node script under tests/ci`);
    const sh = /^-?\s*shell\s*:\s*(.*)$/.exec(l);
    if (sh && !/^(bash|sh|pwsh|powershell|cmd|python)$/.test(sh[1].trim().replace(/\s+#.*$/, ''))) out.push(`${at}: a shell: template runs a command line the check does not read`);
  }
  return out;
}

// ---- inline items and shell files -------------------------------------------------------------------------------------------------------
export function currentInline(root, files = trackedFiles(root)) {
  /** @type {Item[]} */
  const items = [];
  for (const rel of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^\.github\/actions\/.+\.ya?ml$/.test(f) || /(^|\/)action\.ya?ml$/.test(f))) items.push(...runSteps(rel, readFileSync(join(root, rel), 'utf8')));
  for (const rel of files.filter(isWiringFile)) {
    try { items.push(...hookStrings(rel, readFileSync(join(root, rel), 'utf8'))); } catch { items.push({ kind: 'hook', file: rel, job: 'file', index: 0, text: '(not JSON)', location: `${rel}::file::0`, group: `${rel}::file` }); }
  }
  return items;
}
export function currentShellFiles(root, files = trackedFiles(root)) {
  return files.filter((f) => isShellFile(root, f)).sort();
}

// ---- the check -------------------------------------------------------------------------------------------------------------------------
/** @param {string} root @returns {string[]} the problems; none means the repository is clean */
export function check(root) {
  /** @type {string[]} */ const problems = [];
  const templates = hookTemplates(root);
  const files = trackedFiles(root);   // listed once: every git start costs a few ms and check() runs once per planted case in the tests
  for (const f of files) if (f.endsWith('.awk')) problems.push(`${f}: an .awk file (no awk anywhere)`);
  for (const f of currentShellFiles(root, files)) if (!LAUNCHERS.has(f)) problems.push(`${f}: a shell file that is not in the launcher list`);
  problems.push(...launcherProblems(root, files));
  for (const rel of files.filter((f) => /^\.github\/(workflows|actions)\/.+\.ya?ml$/.test(f) || /(^|\/)action\.ya?ml$/.test(f))) problems.push(...workflowTextProblems(rel, readFileSync(join(root, rel), 'utf8')));
  for (const it of currentInline(root, files)) {
    const p = it.kind === 'run' ? stepStrictProblem(it.text) : hookStrictProblem(it.text, templates);
    if (p) problems.push(`${it.location}${it.line ? ` (line ${it.line})` : ''}: ${p}`);
  }
  problems.push(...nodeSpawnProblems(root, files));
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
