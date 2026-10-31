// The no-shell-logic rule (ADR 0001 section 9). Node built-ins only.
//
//   node tests/ci/no-shell-logic.mjs                  ratchet mode (stages 1-14): the repository against two snapshots of 0.0.40
//   node tests/ci/no-shell-logic.mjs --base REF       also: no snapshot entry may exist that REF's snapshot did not have (entries only disappear)
//   node tests/ci/no-shell-logic.mjs --strict         strict mode (stage 15): no snapshot, every shell file a launcher, every step and hook string strict
//   --root DIR                                        the repository to check (default: the one this file lives in); the files are `git ls-files` of it
//   --print-allowlist | --print-snapshot              print the current state in snapshot form (used once to record 0.0.40, and by the tests)
//
// Snapshots (both in tests/ci/):
//   shell-allowlist.txt        one tracked shell file per line (path). Shell file: .sh or .bash extension, a shell shebang
//                              (sh bash dash ash zsh), or any file under a `githooks` folder.
//   inline-shell-snapshot.txt  one line per `run:` step of .github/workflows/*.yml and per hook command string of the three wiring files:
//                              <sha256> <location>. Location: <file>::<job>::step<N> for a step, <file>::<event>::<N> for a hook string.
//
// Known gaps (a tripwire, not the boundary; the security review F4 rest): content is not hashed, so a command appended to an allowlisted shell
// file passes (stages 2-14 move such files by review); YAML is read by a line scanner (flow-style `steps: [...]`, anchors and `run:` values built
// by an expression are not seen); a shell file with an unusual shebang interpreter outside the list above, or a script without shebang and
// extension outside githooks/.githooks/.husky, is not recognised. Covered: any `run:` key at any indentation, composite actions, workflows.
//
// Ratchet rules: a shell file that is not in the allowlist fails; an allowlist entry whose file is gone or no longer a shell file fails (remove
// it); a step or hook string whose SHA-256 is not in the snapshot (same file and job/event) is new or changed and must already meet the
// strict rule; a snapshot entry that no step or string matches fails (remove it). The ratchet never accepts an addition.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export const ALLOWLIST = 'tests/ci/shell-allowlist.txt';
export const SNAPSHOT = 'tests/ci/inline-shell-snapshot.txt';
export const HOOK_TEMPLATES = 'tests/ci/hook-templates.txt';
export const WIRING_FILES = ['adapters/claude/hooks/hooks.json', 'adapters/claude/settings.fragment.json', 'adapters/codex/hooks.json'];
// The launcher list of ADR section 9 (strict mode only; in ratchet mode every shell file of 0.0.40 is allowlisted).
export const LAUNCHERS = new Set([
  'control-plane/agents/scripts/agent.sh',
  'control-plane/agents/scripts/dispatch.sh',
  'control-plane/agents/githooks/pre-commit',
  'control-plane/agents/githooks/pre-push',
  'bin/proofline',
  'adapters/claude/hooks/proofline-hook.sh',
]);

/** @typedef {{ kind: string, file: string, job: string, index: number, text: string, location: string, group: string, sha?: string, line?: number }} Item */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

const SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-S\s+)?)?(?:[a-z]*sh|busybox)(?:\s|$)/;   // sh bash dash ash zsh ksh mksh csh tcsh fish busybox
export function isShellFile(root, rel) {
  if (/\.(sh|bash)$/.test(rel)) return true;
  if (rel.split('/').some((d) => d === 'githooks' || d === '.githooks' || d === '.husky')) return true;
  const abs = join(root, rel);
  try { if (!statSync(abs).isFile()) return false; } catch { return false; }
  return SHEBANG.test(firstLine(abs));
}

// A launcher's text: a shebang, comment lines, blank lines, and at most one `exec node "$(dirname "$0")/<file>" "$@"` line.
export function launcherOk(text) {
  const lines = text.split('\n').map((l) => l.trimEnd());
  let exec = 0;
  for (const [i, l] of lines.entries()) {
    if (l === '' || (i > 0 && l.startsWith('#'))) continue;
    if (i === 0 && SHEBANG.test(l)) continue;
    if (/^exec node "\$\(dirname "\$0"\)\/[A-Za-z0-9_.-]+(?:\.mjs)?"(?: [a-z-]+)* "\$@"$/.test(l)) { exec++; continue; }
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

// ---- snapshots -------------------------------------------------------------------------------------------------------------------------
const readLines = (text) => text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
export function parseSnapshot(text) {
  return readLines(text).map((l) => {
    const m = /^([0-9a-f]{64}) (\S+)$/.exec(l);
    if (!m) throw new Error(`snapshot line is not "<sha256> <location>": ${l}`);
    const loc = m[2].split('::');
    return { sha: m[1], location: m[2], group: loc.slice(0, 2).join('::') };
  });
}

export function currentInline(root) {
  /** @type {Item[]} */
  const items = [];
  const files = trackedFiles(root);
  for (const rel of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^\.github\/actions\/.+\.ya?ml$/.test(f) || /(^|\/)action\.ya?ml$/.test(f))) items.push(...runSteps(rel, readFileSync(join(root, rel), 'utf8')));
  for (const rel of WIRING_FILES) if (files.includes(rel)) items.push(...hookStrings(rel, readFileSync(join(root, rel), 'utf8')));
  for (const it of items) it.sha = sha256(it.kind === 'run' ? it.text.replace(/\s+$/, '') : it.text);
  return items;
}
export function currentShellFiles(root) {
  return trackedFiles(root).filter((f) => isShellFile(root, f)).sort();
}
export const formatSnapshot = (items) => items.map((i) => `${i.sha} ${i.location}`).join('\n') + '\n';

// ---- the check -------------------------------------------------------------------------------------------------------------------------
export function check(root, { strict = false, base = '' } = {}) {
  const problems = [];
  const shell = currentShellFiles(root);
  const items = currentInline(root);
  const templates = hookTemplates(root);
  /** @param {Item} it */
  const strictProblem = (it) => (it.kind === 'run' ? stepStrictProblem(it.text) : hookStrictProblem(it.text, templates));

  if (strict) {
    for (const f of shell) {
      if (!LAUNCHERS.has(f)) problems.push(`${f}: a shell file that is not in the launcher list`);
      else if (!launcherOk(readFileSync(join(root, f), 'utf8'))) problems.push(`${f}: a launcher must be a shebang and one exec node line only`);
    }
    for (const it of items) { const p = strictProblem(it); if (p) problems.push(`${it.location}: ${p}`); }
    return problems;
  }

  const readSnap = (rel) => { const f = join(root, rel); return existsSync(f) ? readFileSync(f, 'utf8') : null; };
  const allowText = readSnap(ALLOWLIST);
  const snapText = readSnap(SNAPSHOT);
  if (allowText === null) problems.push(`${ALLOWLIST} is missing`);
  if (snapText === null) problems.push(`${SNAPSHOT} is missing`);
  if (allowText === null || snapText === null) return problems;

  const allow = new Set(readLines(allowText));
  const shellSet = new Set(shell);
  for (const f of shell) if (!allow.has(f)) problems.push(`${f}: a new shell file (the ratchet never accepts one; write it in Node, or if it is a launcher it belongs to stage 15)`);
  for (const f of allow) if (!shellSet.has(f)) problems.push(`${ALLOWLIST}: "${f}" is no longer a shell file; remove the entry`);

  // inline snapshot: match by (group, sha) as a multiset, so moving a step inside its job or event is not a change
  const snap = parseSnapshot(snapText);
  const pool = new Map();
  for (const e of snap) pool.set(`${e.group}\0${e.sha}`, (pool.get(`${e.group}\0${e.sha}`) ?? 0) + 1);
  for (const it of items) {
    const k = `${it.group}\0${it.sha}`;
    const n = pool.get(k) ?? 0;
    if (n > 0) { pool.set(k, n - 1); continue; }
    const p = strictProblem(it);
    if (p) problems.push(`${it.location}${it.line ? ` (line ${it.line})` : ''}: a new or changed ${it.kind === 'run' ? 'run: step' : 'hook command string'} must meet the strict rule: ${p}`);
  }
  for (const e of snap) {
    const k = `${e.group}\0${e.sha}`;
    const n = pool.get(k) ?? 0;
    if (n > 0) { pool.set(k, n - 1); problems.push(`${SNAPSHOT}: "${e.location}" matches no step or string any more; remove the entry`); }
  }

  if (base) {
    const show = (rel) => { try { return execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); } catch { return null; } };
    const baseAllow = show(ALLOWLIST);
    if (baseAllow !== null) {
      const b = new Set(readLines(baseAllow));
      for (const f of allow) if (!b.has(f)) problems.push(`${ALLOWLIST}: "${f}" was added since ${base}; entries may only disappear`);
    }
    const baseSnap = show(SNAPSHOT);
    if (baseSnap !== null) {
      const b = new Set(parseSnapshot(baseSnap).map((e) => `${e.sha} ${e.group}`));
      for (const e of snap) if (!b.has(`${e.sha} ${e.group}`)) problems.push(`${SNAPSHOT}: "${e.location}" was added or changed since ${base}; entries may only disappear`);
    }
  }
  return problems;
}

function main(argv) {
  let root = resolve(import.meta.dirname, '../..');
  let strict = false;
  let base = '';
  let mode = 'check';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') strict = true;
    else if (a === '--root') root = resolve(argv[++i]);
    else if (a === '--base') base = argv[++i] ?? '';
    else if (a === '--print-allowlist') mode = 'allow';
    else if (a === '--print-snapshot') mode = 'snap';
    else { process.stderr.write(`no-shell-logic: unknown argument ${a}\n`); return 2; }
  }
  if (mode === 'allow') { process.stdout.write(currentShellFiles(root).join('\n') + '\n'); return 0; }
  if (mode === 'snap') { process.stdout.write(formatSnapshot(currentInline(root))); return 0; }
  const problems = check(root, { strict, base });
  if (problems.length === 0) {
    process.stdout.write(`no-shell-logic: ok (${strict ? 'strict' : 'ratchet'})\n`);
    return 0;
  }
  for (const p of problems) process.stderr.write(`no-shell-logic: ${p}\n`);
  process.stderr.write(`no-shell-logic: ${problems.length} problem(s) (${basename(root)})\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exitCode = main(process.argv.slice(2));
