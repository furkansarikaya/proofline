// @ts-check
// Static guard for A248 (rounds 7 and 8, Part of #165): no source of the control plane starts a RAW git that reads the index or the work tree. Those commands (`ls-files`,
// `check-ignore`, `status`, `diff`, `add`, `checkout`, `reset`, `worktree add`, ...) can start a program the repository's configuration names (`core.fsmonitor`) or a
// filter, so they go through `hgit()` or `git()` (hgit.mjs, git.mjs), which blank both. A raw spawn is allowed for a command that reads refs, objects or configuration
// only (ALLOWED below). The scan reads text; it starts no process. A new exception needs an entry with its reason, here, and a line in decision A248.
//
// WHAT IS SCANNED: every `.mjs` source (tests excluded) under `control-plane/` (the core, its commands/ and adapters/ folders, the scripts, ecosystems.mjs) and the launcher
// `bin/proofline`. WHAT IS NOT (A248 accepted limits): the top-level `adapters/` (hooks and installers that run in the agent's own session or at the owner's own install),
// the scripts of `skills/*/scripts` (they run raw git inside an agent's own tool call, not launched by the core's commands), the shell scripts (`agent.sh`, `dispatch.sh`,
// `githooks/*`, the adapters' `.sh` hooks), `tests/`, and whatever a configured command or a hook starts.
//
// HOW A SPAWN IS SEEN: only through `import * as proc from './proc.mjs'` and `proc.<fn>(`; any other way to import proc.mjs, any use of `proc` that is not a member call, and
// any `proc.*` spawn function other than `run` must be registered with a reason. A call that cannot be read (a spread before the subcommand, a template literal, a variable list) is
// never accepted for what it might be: its text and the definition of its variable are searched for a denied subcommand, and the number of dynamic raw spawns of a file must equal
// the number the file registers (its forwarding wrappers), so a new local forwarding function is found. A spawn of any program other than git must be listed with its reason; a
// listed `sh`/`timeout`/`env` call must not name git in its text.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { listable } from '../../control-plane/agents/scripts/core/kirules.mjs';
import { git, makeFixture } from './fixture.mjs';
import { repo } from './helpers.mjs';
import { posix } from '../lib/winpath.mjs';

/** The files that ARE the hermetic helpers: they start git on purpose and add the blanking. */
const HELPERS = new Set(['hgit.mjs', 'git.mjs']);

/** Subcommands that read refs, objects or configuration only: they open no index and no work tree file, so no fsmonitor program and no filter can start. `log` is NOT here: it can run
 * gpg (`log.showSignature`), a textconv or the work tree; the few `log` calls go through git() or run in the private proof repository (deliver.mjs, EXCEPT_SUBS). */
export const ALLOWED = new Set([
  'rev-parse', 'cat-file', 'rev-list', 'show-ref', 'symbolic-ref', 'for-each-ref', 'merge-base', 'ls-remote', 'config', 'ls-tree', 'diff-tree', 'branch', 'remote', 'var',
  'pack-objects', 'worktree', // `worktree` only with `list` as its first argument (checked below)
]);
/** `diff-tree` is raw only with these options (a WHITELIST: a patch, a stat, a summary, a check, a word diff, a signature, an external diff or a textconv all read file content). */
const DIFF_TREE_OK = /^(-r|-z|-t|--root|--name-only|--name-status|--no-commit-id|--no-renames|--no-ext-diff|--no-textconv|--)$/;
/** Arguments no raw call may carry: they apply a filter or a textconv, read the index (a leading `:`), or run gpg. */
const BAD_ARG = /^(--textconv|--filters|--indexed-objects|--path(=.*)?|--show-signature|--verify-signatures|--gpg-sign.*|-S.*)$|%G|%\(signature/;
/** Subcommands that read or write the index or the work tree, found anywhere in the text of a call that cannot be read. */
const DENY = ['ls-files', 'check-ignore', 'status', 'diff', 'diff-index', 'diff-files', 'add', 'update-index', 'read-tree', 'checkout', 'checkout-index', 'reset', 'stash', 'rm', 'mv', 'clean', 'grep', 'merge', 'switch', 'restore', 'commit', 'apply', 'write-tree', 'submodule', 'log', 'show', 'blame', 'archive', 'bisect', 'cherry-pick', 'rebase', 'revert', 'pull', 'sparse-checkout', 'maintenance', 'gc', 'fsck', 'repack', 'am', 'format-patch', 'describe', 'range-diff', 'whatchanged', 'difftool', 'mergetool', 'shortlog'];
/** The global options that take their value as the NEXT argument. */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);

/** Whole files outside the guard for their git calls, each with the reason (A248 (d)). */
export const EXCEPT_FILES = /** @type {Record<string, string>} */ ({
  'githooks.mjs': 'runs inside the user\'s own `git commit` or `git push`, where the repository\'s configuration is already running (A211/A217/A218)',
  'buildrecord.mjs': 'the build record key and its export need the repository\'s own clean and smudge filters (A248 round 6); it passes core.fsmonitor=false itself (round 7)',
});
/** Single subcommands allowed in one file, each with the reason. */
export const EXCEPT_SUBS = /** @type {Record<string, Record<string, string>>} */ ({
  'deliver.mjs': {
    init: 'a bare scratch repository the proof fetch makes in its own temporary folder, `--template=`',
    push: 'the delivery\'s own push of the proven tip with `core.hooksPath=/dev/null`: a remote operation (the transport programs of the repository configuration apply, the user\'s approved push, the old behaviour), no index and no work tree',
    'update-ref': 'in the private bare proof repository (`--git-dir` a temporary folder, global and system configuration nulled): no index, no work tree',
    fetch: 'the hermetic fetch into that private bare proof repository (the project itself stays transport-free, A248 S3)',
    diff: 'the `gps` reader of the private bare proof repository (`--git-dir` a temporary folder, global and system configuration nulled, a configuration we wrote): no index, no work tree, `--no-ext-diff --no-textconv`',
    log: 'the same private bare proof repository, whose configuration is ours (no `log.showSignature`, no gpg program)',
  },
  'doctor.mjs': {
    init: 'the probe repositories in doctor\'s own temporary folder, with a cleaned environment',
    commit: 'the probe commit in that scratch repository: it exists to run the project\'s hook',
    push: 'the probe push from that scratch repository to its own bare remote',
  },
  'proflinecli.mjs': { status: 'the local `git` wrapper sends `status` to hgit (the `a[0] === \'status\'` branch); the other subcommands are refs only' },
});
/** Single subcommands whose exception holds only for calls through these wrappers (the private proof repository's `gp`/`gps`): a raw `proc.run('git', [..., 'diff'])` in the same file is not covered. */
export const EXCEPT_VIA = /** @type {Record<string, Record<string, string[]>>} */ ({ 'deliver.mjs': { diff: ['gp', 'gps'], log: ['gp', 'gps'] } });
/** The local functions (per file) that forward their argument list to a raw git spawn: their calls are checked too. Regular expression sources. */
export const WRAPPERS = /** @type {Record<string, string[]>} */ ({
  'merge.mjs': ['gitOut'],
  'gitstate.mjs': ['git'],
  'install.mjs': ['g', 'this\\.git'],
  'doctor.mjs': ['git', 'this\\.gitOut', 'pg', 'init'],
  'platform.mjs': ['g'],
  'proflinecli.mjs': ['git'],
  'worktree.mjs': ['git'],
  'deliver.mjs': ['gp', 'gps'],
});
/** How many raw git spawns per file take a list that is not a literal (the forwarding functions). A new local forwarding function changes the count and is found. */
export const DYN_SPAWNS = /** @type {Record<string, number>} */ ({
  'deliver.mjs': 1, 'doctor.mjs': 3, 'gitstate.mjs': 1, 'install.mjs': 2, 'merge.mjs': 1, 'platform.mjs': 1, 'proflinecli.mjs': 1, 'worktree.mjs': 1,
});
/** Programs other than git that a file may start by name (`proc.run('ps', ...)`), with the reason. No shell or awk is listed: since A251 only core/proc.mjs names them (tests/ci/no-shell-logic.mjs). A call that names git inside its text is refused whatever the program. */
export const BIN_ALLOW = /** @type {Record<string, Record<string, string>>} */ ({
  'batch.mjs': { ps: 'the state of a process id' },
  'buildrecord.mjs': { timeout: 'the time limit around the configured build command (`/bin/sh -c command`, the owner\'s command in the owner\'s run, round 6)' },
  'grepfile.mjs': { grep: 'the pattern match, the pattern in a file (A250)' },
  'commands/moved.mjs': { grep: 'the risk pattern match' },
  'decide.mjs': { ps: 'the parent of a process id' },
  'doctor.mjs': { node: 'the node version probe and the hook probe', ps: 'the process list probe' },
  'friction.mjs': { gh: 'the issue creation of the friction report' },
  'proflinecli.mjs': { find: 'the listing of the local folder' },
  'runend.mjs': { tar: 'the evidence archive of a run' },
});
/** Files that start a program held in a variable (not git), with the reason. The text of every such call is searched for a denied git subcommand. */
export const DYN_BIN = /** @type {Record<string, string>} */ ({
  'adapters/index.mjs': 'the platform tool (gh or glab) found by the tool lookup',
  'commands/verify.mjs': 'the program of a configured verification command',
  'discover.mjs': 'the program of a configured discovery command',
  'doctor.mjs': 'the version probes of the programs doctor reports on',
  'merge.mjs': 'the platform tool (gh or glab)',
  'platform.mjs': 'the platform tool (gh or glab)',
  'runtimedetect.mjs': 'the version probe of an agent command line tool',
});
/** `proc.*` spawn functions other than `run`, per file, with the reason. */
export const SPAWN_REG = /** @type {Record<string, Record<string, string>>} */ ({
  'batch.mjs': { spawnDetached: 'caffeinate / systemd-inhibit, named in the source' },
  'dispatcher.mjs': { startLeader: 'the dispatched worker (an agent command line)' },
  'doctor.mjs': { runMerged: 'the doctor probes (node, the launcher) with standard error merged into the output' },
  'proflinecli.mjs': { runMerged: 'the launcher of the project, standard error merged into the output (`all`)' },
  'resultutil.mjs': { runUserCommand: 'the owner\'s own recorded command, re-run to compare (the reproduced-evidence check)' },
  'secretscan.mjs': { runUserCommand: 'the configured secret scanner command, the owner\'s own command' },
  'buildrecord.mjs': { runUserCommand: 'the configured build command, the owner\'s own command (round 6)' },
});
/** Files that import something other than the namespace from proc.mjs, per name, with the reason. */
export const NAMED_IMPORTS = /** @type {Record<string, Record<string, string>>} */ ({
  'budget.mjs': { runAsync: 'runWithBudget runs the program its caller names; the only caller is the Claude adapter (`sh`), outside the scan' },
  'guardian.mjs': { runCloser: 'the guardian of a dispatched worker (A226)', runGuardian: 'the guardian of a dispatched worker (A226)' },
});
/** The members of `proc` that start nothing. */
const PROC_NO_SPAWN = new Set(['spawnLog', 'spawnCounts', 'resetSpawnCounts', 'killTree', 'runScript', 'userShellArgv']);   // runScript starts `sh <script file>` and userShellArgv only builds an argument vector (A251): neither names git
const TABLES = { EXCEPT_VIA, WRAPPERS, EXCEPT_SUBS, EXCEPT_FILES, DYN_SPAWNS, BIN_ALLOW, DYN_BIN, SPAWN_REG, NAMED_IMPORTS };

/** Index of the end of the string, template or comment-free literal that starts at I (a quote), or -1. @param {string} s @param {number} i */
function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') { j = skipBalanced(s, j + 1) - 1; continue; }
    if (s[j] === q) return j + 1;
  }
  return -1;
}
/** Index just after the bracket group that opens at I. @param {string} s @param {number} i */
function skipBalanced(s, i) {
  const pairs = /** @type {Record<string, string>} */ ({ '(': ')', '[': ']', '{': '}' });
  const stack = [pairs[s[i]]];
  let j = i + 1;
  while (j < s.length && stack.length > 0) {
    const c = s[j];
    if (c === '\'' || c === '"' || c === '`') { const e = skipString(s, j); if (e < 0) return s.length; j = e; continue; }
    if (c in pairs) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    j++;
  }
  return j;
}
/** The top level elements of the array or argument list whose opening bracket is at I (text of each, trimmed). @param {string} s @param {number} i */
function elements(s, i) {
  const end = skipBalanced(s, i) - 1;
  /** @type {string[]} */ const out = [];
  let start = i + 1; let j = i + 1;
  while (j < end) {
    const c = s[j];
    if (c === '\'' || c === '"' || c === '`') { j = skipString(s, j); continue; }
    if (c === '(' || c === '[' || c === '{') { j = skipBalanced(s, j); continue; }
    if (c === ',') { out.push(s.slice(start, j).trim()); start = j + 1; }
    j++;
  }
  const last = s.slice(start, end).trim();
  if (last !== '') out.push(last);
  return out;
}
const lit = (/** @type {string} */ e) => { const m = /^'([^'\\]*)'$|^"([^"\\]*)"$/.exec(e); return m === null ? null : (m[1] ?? m[2] ?? ''); };

/**
 * The git subcommand of an argument list: leading options (and the value of `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--config-env`, `--attr-source`)
 * are skipped. null when it is not a literal (a spread, a template or a variable).
 * @param {string[]} els @returns {{ sub: string, rest: string[] } | null}
 */
export function subcommand(els) {
  let k = 0;
  while (k < els.length) {
    const l = lit(els[k]);
    if (l === null) return null;
    if (GLOBAL_WITH_VALUE.has(l)) { k += 2; continue; }
    if (l.startsWith('-')) { k++; continue; }
    return { sub: l, rest: els.slice(k + 1) };
  }
  return null;
}

/** Whether TEXT holds a denied subcommand as a quoted string or as the start of a template; the names found. @param {string} text @returns {string[]} */
export function denyHits(text) {
  return DENY.filter((d) => new RegExp(`(['"\`])${d}\\1|\`${d}[\\s$\`]`).test(text));
}
/** The text where the variable ID gets its elements (`ID = [...]`, `ID.push(...)`), for the search of denied subcommands. @param {string} src @param {string} id */
function definitionText(src, id) {
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = '';
  for (const m of src.matchAll(new RegExp(`(?<![\\w.])${e}\\s*=(?!=)\\s*`, 'g'))) {
    const from = (m.index ?? 0) + m[0].length;
    out += `${src[from] === '[' ? src.slice(from, skipBalanced(src, from)) : src.slice(from, from + 240)}\n`;
  }
  for (const m of src.matchAll(new RegExp(`(?<![\\w.])${e}\\.(?:push|unshift|splice|concat)\\(`, 'g'))) out += `${src.slice(m.index ?? 0, skipBalanced(src, (m.index ?? 0) + m[0].length - 1))}\n`;
  return out;
}

/**
 * @typedef {{ sub: string, rest: string[], line: number, dyn: boolean, via: string, scan: string, varList?: boolean }} Call
 * Every raw git call of one source: its subcommand (or '?' when the list is not literal, `dyn` true for the spawn itself), its line, the text that was searched when it cannot be read
 * (`scan`: the call and the definition of its variable list), and the wrapper calls. Comments are not removed: a line comment that looks like a call is a false alarm that shows up as a
 * failure with its line, which is the safe direction.
 * @param {string} src @param {string[]} wrappers @returns {Call[]}
 */
export function rawGitCalls(src, wrappers) {
  /** @type {Call[]} */ const out = [];
  const lineOf = (/** @type {number} */ i) => src.slice(0, i).split('\n').length;
  /** @param {number} at @param {string[]} els @param {string} via @param {boolean} spawn @param {string} extra */
  const add = (at, els, via, spawn, extra) => {
    const sc = subcommand(els);
    if (sc === null) out.push({ sub: '?', rest: els, line: lineOf(at), dyn: spawn, via, scan: `${els.join(',')}\n${extra}` });
    else out.push({ sub: sc.sub, rest: sc.rest, line: lineOf(at), dyn: false, via, scan: '' });
  };
  // 1. a spawn that names git (a literal, a path ending in /git, or a binary variable of the delivery)
  for (const m of src.matchAll(/proc\.run\(\s*(?:'(?:[^'\n]*\/)?git'|"(?:[^"\n]*\/)?git"|gitBin|gitPath|gtp\.path|gt\.path)\s*,\s*(\[)?/g)) {
    const at = m.index ?? 0;
    if (m[1] === undefined) {
      const arg = (elements(src, at + 'proc.run'.length)[1] ?? '').trim();
      out.push({ sub: '?', rest: [], line: lineOf(at), dyn: true, via: 'proc.run', scan: `${arg}\n${/^[\w$.]+$/.test(arg) ? definitionText(src, arg) : ''}` }); // the list is a variable
    } else add(at, elements(src, at + m[0].length - 1), 'proc.run', true, '');
  }
  // 2. the calls of the local functions that forward their list to a raw spawn
  for (const w of wrappers) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.])${w}\\(\\s*(?:ctx\\s*,\\s*)?(\\[)?`, 'g'))) {
      const at = m.index ?? 0;
      const via = w.replace(/\\/g, '');
      if (m[1] !== undefined) { add(at, elements(src, at + m[0].length - 1), via, false, ''); continue; }
      const before = src.slice(src.lastIndexOf('\n', at) + 1, at);
      if (/^\s*(\/\/|\*|\/\*)/.test(before) || /\bfunction\s+$/.test(before)) continue; // a comment or the definition itself
      const open = at + m[0].indexOf('(');
      if (/^\s*\{/.test(src.slice(skipBalanced(src, open), skipBalanced(src, open) + 8))) continue; // a method definition
      const args = elements(src, open); // the list is a variable or a spread
      const arg = (/^ctx$/.test(args[0] ?? '') ? args[1] : args[0]) ?? '';
      if (arg === '') continue; // a call with no list is not a git call
      out.push({ sub: '?', rest: [], line: lineOf(at), dyn: false, via, varList: true, scan: `${args.join(',')}\n${/^[\w$.]+$/.test(arg) ? definitionText(src, arg) : ''}` });
    }
  }
  return out;
}

/** The problems of one call, or ''. @param {string} file @param {Pick<Call, 'sub' | 'rest' | 'via' | 'scan'>} c @param {typeof TABLES} [T] */
export function problem(file, c, T = TABLES) {
  if (c.sub === '?') {
    const hits = denyHits(c.scan);
    return hits.length > 0 ? `raw git call that cannot be read (${c.via}) holds ${hits.map((h) => `'${h}'`).join(', ')}` : '';
  }
  if (T.EXCEPT_SUBS[file]?.[c.sub] !== undefined && (T.EXCEPT_VIA?.[file]?.[c.sub] ?? [c.via]).includes(c.via)) return '';
  if (!ALLOWED.has(c.sub)) return `raw git ${c.sub} (${c.via})`;
  if (c.sub === 'worktree' && lit(c.rest[0] ?? '') !== 'list') return `raw git worktree ${lit(c.rest[0] ?? '') ?? '<not literal>'} (${c.via}): only \`worktree list\` may be raw`;
  if (c.sub === 'diff-tree' && c.rest.some((e) => { const l = lit(e); return l !== null && l.startsWith('-') && !DIFF_TREE_OK.test(l); })) return `raw git diff-tree with an option that is not on the whitelist (${c.via})`;
  const bad = c.rest.find((e) => { const l = lit(e); return (l !== null && BAD_ARG.test(l)) || /^(['"`]):/.test(e) || (l === null && /%G|%\(signature/.test(e)); });
  if (bad !== undefined) return `raw git ${c.sub} with ${bad} (${c.via}): a filter, a textconv, an index lookup or a signature check`;
  return '';
}

/**
 * Everything the guard checks in one source. `bad` are the problems (with the line); `used` the table entries the source made use of (to find stale ones).
 * @param {string} base file name @param {string} src @param {typeof TABLES} [T] @returns {{ bad: string[], used: Set<string>, dyn: number }}
 */
export function scanSource(base, src, T = TABLES) {
  /** @type {string[]} */ const bad = [];
  /** @type {Set<string>} */ const used = new Set();
  const lineOf = (/** @type {number} */ i) => src.slice(0, i).split('\n').length;
  if (/child_process/.test(src) && base !== 'proc.mjs') bad.push(`${base}: starts processes without proc.mjs (the guard cannot see what it runs)`);
  if (base === 'proc.mjs') return { bad, used, dyn: 0 };
  // how proc.mjs comes in: only `import * as proc`; a name import is listed with its reason
  for (const m of src.matchAll(/^[ \t]*(?:import|export)\b([^;'"]*?)\bfrom\s*['"]([^'"]*\/proc\.mjs|\.\/proc\.mjs)['"]/gm)) {
    if (/^\s*\*\s+as\s+proc\s*$/.test(m[1])) continue;
    const names = [...m[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]).filter((n) => n !== 'as' && n !== 'type');
    const listed = T.NAMED_IMPORTS[base] ?? {};
    for (const n of names) { if (listed[n] === undefined) bad.push(`${base}:${lineOf(m.index ?? 0)}: imports ${n} from proc.mjs; only \`import * as proc\` is allowed (or list it in NAMED_IMPORTS)`); else used.add(`import:${base}:${n}`); }
  }
  for (const m of src.matchAll(/(?:await\s+|=\s*|\breturn\s+)import\(\s*['"][^'"]*proc\.mjs/g)) bad.push(`${base}:${lineOf(m.index ?? 0)}: a dynamic import of proc.mjs`);
  // every use of `proc` is a member call: no alias, no destructuring, no property that is not called
  for (const m of src.matchAll(/(?<![\w$.'"/-])proc\b(?!\.mjs)(?!\.[A-Z])(?!\.[A-Za-z_]\w*\()/g)) {
    const before = src.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/\*\s+as\s+$/.test(before)) continue; // the namespace import itself
    if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(src.lastIndexOf('\n', m.index ?? 0) + 1, m.index ?? 0))) continue; // prose in a comment
    bad.push(`${base}:${lineOf(m.index ?? 0)}: \`proc\` is used other than as \`proc.<function>(\` (an alias or a destructured spawn function hides the call)`);
  }
  // the spawn functions other than run
  for (const m of src.matchAll(/(?<![\w$.])proc\.([A-Za-z_]\w*)\(/g)) {
    const fn = m[1];
    if (fn === 'run' || PROC_NO_SPAWN.has(fn)) continue;
    if (T.SPAWN_REG[base]?.[fn] === undefined) bad.push(`${base}:${lineOf(m.index ?? 0)}: proc.${fn}( starts a process and is not listed in SPAWN_REG`);
    else used.add(`spawn:${base}:${fn}`);
  }
  // every proc.run: its program
  for (const m of src.matchAll(/(?<![\w$.])proc\.run\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const first = elements(src, open)[0] ?? '';
    const l = lit(first);
    const body = src.slice(m.index ?? 0, skipBalanced(src, open));
    if ((l !== null && /(^|\/)git$/.test(l)) || /^(gitBin|gitPath|gtp\.path|gt\.path)$/.test(first)) continue; // a git spawn: read below
    if (l !== null || first === 'process.execPath') {
      const bin = l ?? 'node';
      if (l !== null && T.BIN_ALLOW[base]?.[bin] === undefined) bad.push(`${base}:${lineOf(m.index ?? 0)}: spawns '${bin}', which is not listed in BIN_ALLOW`);
      else if (l !== null) used.add(`bin:${base}:${bin}`);
      if (/(?<![\w.$/-])git(?![\w-])/.test(body)) bad.push(`${base}:${lineOf(m.index ?? 0)}: a spawn of '${bin}' names git in its text`);
      continue;
    }
    if (T.DYN_BIN[base] === undefined) bad.push(`${base}:${lineOf(m.index ?? 0)}: spawns a program held in \`${first}\`, and the file is not listed in DYN_BIN`);
    else used.add(`dynbin:${base}`);
    const arg = (elements(src, open)[1] ?? '').trim();
    const hits = denyHits(`${body}\n${/^[\w$.]+$/.test(arg) ? definitionText(src, arg) : ''}`);
    if (hits.length > 0) bad.push(`${base}:${lineOf(m.index ?? 0)}: a spawn of \`${first}\` holds ${hits.map((h) => `'${h}'`).join(', ')}`);
  }
  // the raw git calls
  const wr = T.WRAPPERS[base] ?? [];
  const calls = rawGitCalls(src, wr);
  const dyn = calls.filter((c) => c.dyn).length;
  if (T.EXCEPT_FILES[base] !== undefined) { if (calls.length > 0) used.add(`file:${base}`); return { bad, used, dyn }; }
  if (dyn !== (T.DYN_SPAWNS[base] ?? 0)) bad.push(`${base}: ${dyn} raw git spawns take a list that is not a literal, ${T.DYN_SPAWNS[base] ?? 0} are registered (a new local forwarding function must be registered in WRAPPERS and DYN_SPAWNS)`);
  if ((T.DYN_SPAWNS[base] ?? 0) > 0 && wr.length === 0) bad.push(`${base}: dynamic raw git spawns are registered but no wrapper is`);
  for (const c of calls) {
    if (c.via !== 'proc.run') used.add(`wrapper:${base}:${c.via}`);
    const p = problem(base, c, T);
    if (p !== '') bad.push(`${base}:${c.line}: ${p}`);
    else if (c.sub === '?') { if (!c.dyn && c.varList !== true) bad.push(`${base}:${c.line}: a call of ${c.via} whose subcommand is not a literal`); } else if (T.EXCEPT_SUBS[base]?.[c.sub] !== undefined) used.add(`sub:${base}:${c.sub}`);
  }
  return { bad, used, dyn };
}

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p)); else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out.sort();
}
/** The key of a file in the tables: its path inside the core folder, or from the repository root for a file outside it. @param {string} f */
function keyOf(f) {
  const core = path.join(repo, 'control-plane/agents/scripts/core') + path.sep;
  return posix(f.startsWith(core) ? f.slice(core.length) : path.relative(repo, f));   // the tables are keyed with forward slashes (A261)
}
/** Every file the guard reads: the sources of control-plane/ and the launcher in bin/. */
function scanned() {
  const bin = readdirSync(path.join(repo, 'bin'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(repo, 'bin', e.name));
  return [...sources(path.join(repo, 'control-plane')), ...bin].sort();
}

test('A248 guard: no raw git in the control plane reads the index or the work tree (only refs, objects and configuration readers are raw; the rest goes through hgit/git)', () => {
  /** @type {string[]} */ const bad = [];
  /** @type {Set<string>} */ const used = new Set();
  const files = scanned();
  const names = files.map(keyOf);
  assert.ok(files.length > 50, 'the scan found the control plane sources');
  for (const must of ['worktree.mjs', 'deliver.mjs', 'commands/approve.mjs', 'adapters/index.mjs', 'proc.mjs', 'bin/proofline', 'control-plane/agents/scripts/proofline-core.mjs', 'control-plane/agents/ecosystems.mjs']) assert.ok(names.includes(must), `the scan did not reach ${must}`);
  for (const f of files) {
    const base = keyOf(f);
    if (HELPERS.has(base)) continue;
    const r = scanSource(base, readFileSync(f, 'utf8'));
    bad.push(...r.bad);
    for (const u of r.used) used.add(u);
  }
  for (const [f, subs] of Object.entries(EXCEPT_SUBS)) for (const s of Object.keys(subs)) if (!used.has(`sub:${f}:${s}`)) bad.push(`stale exception ${f}:${s} (nothing uses it)`);
  for (const f of Object.keys(EXCEPT_FILES)) if (!used.has(`file:${f}`)) bad.push(`stale file exception ${f} (it spawns no git)`);
  for (const [f, ws] of Object.entries(WRAPPERS)) for (const w of ws) if (!used.has(`wrapper:${f}:${w.replace(/\\/g, '')}`)) bad.push(`stale wrapper ${f}:${w} (no call of it found)`);
  for (const [f, bins] of Object.entries(BIN_ALLOW)) for (const b of Object.keys(bins)) if (!used.has(`bin:${f}:${b}`)) bad.push(`stale BIN_ALLOW ${f}:${b} (nothing spawns it)`);
  for (const f of Object.keys(DYN_BIN)) if (!used.has(`dynbin:${f}`)) bad.push(`stale DYN_BIN ${f}`);
  for (const [f, fns] of Object.entries(SPAWN_REG)) for (const fn of Object.keys(fns)) if (!used.has(`spawn:${f}:${fn}`)) bad.push(`stale SPAWN_REG ${f}:${fn}`);
  for (const [f, ns] of Object.entries(NAMED_IMPORTS)) for (const n of Object.keys(ns)) if (!used.has(`import:${f}:${n}`)) bad.push(`stale NAMED_IMPORTS ${f}:${n}`);
  assert.deepEqual(bad, [], `index or work tree readers must go through hgit()/git() (hgit.mjs, git.mjs), or be listed with a reason:\n${bad.join('\n')}`);
});

// ---- the scanner itself: every evasion shape the reviews found, each proven caught ----------------------------------------------------------------------------------------
const IMPORT = "import * as proc from './proc.mjs';\n";
/** The forwarding function a file with one registered wrapper has. */
const FWD = "const g = (a) => proc.run('git', ['-C', r, ...a], {});\n";
/** Tables of the fixture file x.mjs: one wrapper `g`, one dynamic spawn, `sh` and a binary variable allowed. */
const T0 = { EXCEPT_VIA: {}, WRAPPERS: { 'x.mjs': ['g'] }, DYN_SPAWNS: { 'x.mjs': 1 }, BIN_ALLOW: { 'x.mjs': { sh: 'r' } }, DYN_BIN: { 'x.mjs': 'r' }, EXCEPT_SUBS: {}, EXCEPT_FILES: {}, SPAWN_REG: {}, NAMED_IMPORTS: {} };
/** @param {string} src @param {Partial<typeof T0>} [over] @param {string} [head] */
const scan = (src, over = {}, head = IMPORT + FWD) => scanSource('x.mjs', head + src, { ...T0, ...over }).bad;

test('A248 guard (scanner): the first shapes (a raw ls-files, check-ignore, status, a wrapper call) are found; refs readers, the helpers and the whitelisted diff-tree pass', () => {
  const probs = (/** @type {string} */ src, /** @type {string[]} */ w = []) => rawGitCalls(src, w).map((c) => problem('x.mjs', c)).filter((p) => p !== '');
  assert.deepEqual(rawGitCalls("const h = (a) => proc.run('git', ['-C', r, ...a], {});", []).map((c) => [c.sub, c.dyn]), [['?', true]], 'a spawn with a spread list is reported as dynamic');
  assert.deepEqual(probs("proc.run('git', ['-C', root, 'ls-files', '--', p], {})"), ['raw git ls-files (proc.run)']);
  assert.deepEqual(probs("proc.run('git', ['-c', 'a=b', '-C', `${a}/x`, '--no-optional-locks', 'check-ignore', '-q'], {})"), ['raw git check-ignore (proc.run)']);
  assert.deepEqual(probs("proc.run(gitBin, ['--no-replace-objects', '--git-dir', tmp, 'status'], {})"), ['raw git status (proc.run)']);
  assert.deepEqual(probs("const git = (a) => proc.run('git', ['-C', r, ...a], {}); git(['add', '-A']); git(['rev-parse', 'HEAD']);", ['git']), ['raw git add (git)']);
  assert.deepEqual(probs("g(ctx, ['status'], main)", ['g']), ['raw git status (g)']);
  assert.deepEqual(probs("this.git(['diff', '--cached'])", ['this\\.git']), ['raw git diff (this.git)']);
  assert.deepEqual(probs("proc.run('git', ['worktree', 'add', d], {})"), ['raw git worktree add (proc.run): only `worktree list` may be raw']);
  assert.deepEqual(probs("proc.run('git', ['diff-tree', '-r', '--name-only', a, b], {}); proc.run('git', ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', a], {})"), []);
  assert.deepEqual(probs("proc.run('git', ['-C', r, 'worktree', 'list', '--porcelain'], {}); proc.run('git', ['cat-file', '-e', `${s}^{commit}`], {}); proc.run('git', ['config', k], {})"), []);
  assert.deepEqual(rawGitCalls("proc.run('git', ['-C', kiPlaces(ctx, [1, 2]).main, 'ls-files'], {})", []).map((c) => c.sub), ['ls-files'], 'a string that holds brackets, commas and quotes does not confuse the list reader');
  assert.deepEqual(scan("g(['rev-parse', 'HEAD']); proc.run('git', ['cat-file', '-p', x], {}); proc.run('sh', ['-c', 'true'], {}); proc.run(process.execPath, ['s.mjs'], {}); proc.run(tool, ['--version'], {});"), [], 'the control file is clean');
});

test('A248 guard (scanner): an unreadable git call is never accepted for what it might be (finding 1)', () => {
  const cases = /** @type {Array<[string, string, Partial<typeof T0>, RegExp]>} */ ([
    ['a spread before the subcommand', "proc.run('git', ['-C', d, ...opts, 'ls-files'], {});", { DYN_SPAWNS: { 'x.mjs': 2 } }, /holds 'ls-files'/],
    ['a template literal subcommand', "proc.run('git', [`ls-files`], {});", { DYN_SPAWNS: { 'x.mjs': 2 } }, /holds 'ls-files'/],
    ['a template literal subcommand with text after it', "proc.run('git', [`status ${x}`], {});", { DYN_SPAWNS: { 'x.mjs': 2 } }, /holds 'status'/],
    ['a variable list with the subcommand defined elsewhere', "const args = ['-C', d, 'ls-files']; proc.run('git', args, {});", { DYN_SPAWNS: { 'x.mjs': 2 } }, /holds 'ls-files'/],
    ['a variable list that is pushed to', "const args = ['-C', d]; args.push('check-ignore'); proc.run('git', args, {});", { DYN_SPAWNS: { 'x.mjs': 2 } }, /holds 'check-ignore'/],
    ['a variable binary and a variable list', "const args = ['ls-files']; proc.run(gitBin, args, {});", { DYN_SPAWNS: { 'x.mjs': 2 } }, /holds 'ls-files'/],
    ['a variable binary that is not git and a variable list', "const args = ['ls-files']; proc.run(bin, args, {});", {}, /holds 'ls-files'/],
    ['a wrapper called with a variable list', "const args = ['status']; g(args);", {}, /holds 'status'/],
    ['a wrapper called with a spread', "g(['-C', d, ...o, 'diff']);", {}, /holds 'diff'/],
    ['a new local forwarding function (function declaration)', "function x(a) { return proc.run('git', a); } x(['ls-files']);", {}, /2 raw git spawns take a list that is not a literal, 1 are registered/],
    ['a new local forwarding function (arrow)', "const x = (a) => proc.run('git', a, {}); x(['ls-files']);", {}, /2 raw git spawns take a list/],
    ['a registered wrapper that is gone (fewer than registered)', '', { DYN_SPAWNS: { 'x.mjs': 2 } }, /1 raw git spawns take a list that is not a literal, 2 are registered/],
    ['a forwarding function that is registered as a wrapper still has its calls read', "function x(a) { return proc.run('git', a); } x(['ls-files']);", { WRAPPERS: { 'x.mjs': ['g', 'x'] }, DYN_SPAWNS: { 'x.mjs': 2 } }, /raw git ls-files \(x\)/],
  ]);
  for (const [name, src, over, re] of cases) assert.ok(scan(src, over).some((b) => re.test(b)), `${name}: not caught: ${JSON.stringify(scan(src, over))}`);
  assert.deepEqual(scan(''), [], 'the baseline has no problem');
  // every denied subcommand is caught, in a spread list and in a variable list
  /** Written out here on purpose: a name dropped from DENY must turn this test red, so the loop does not read DENY. */
  const EVERY = ['ls-files', 'check-ignore', 'status', 'diff', 'diff-index', 'diff-files', 'add', 'update-index', 'read-tree', 'checkout', 'checkout-index', 'reset', 'stash', 'rm', 'mv', 'clean', 'grep', 'merge', 'switch', 'restore', 'commit', 'apply', 'write-tree', 'submodule', 'log', 'show', 'blame', 'archive', 'bisect', 'cherry-pick', 'rebase', 'revert', 'pull', 'sparse-checkout', 'maintenance', 'gc', 'fsck', 'repack', 'am', 'format-patch', 'describe', 'range-diff', 'whatchanged', 'difftool', 'mergetool', 'shortlog'];
  assert.deepEqual([...EVERY].sort(), [...DENY].sort(), 'DENY and the pinned list differ');
  for (const d of EVERY) {
    assert.ok(scan(`proc.run('git', ['-C', d, ...o, '${d}'], {});`, { DYN_SPAWNS: { 'x.mjs': 2 } }).some((b) => b.includes(`'${d}'`)), `${d}: not caught in a spread list`);
    assert.ok(scan(`const a = ['${d}']; g(a);`).some((b) => b.includes(`'${d}'`)), `${d}: not caught in a variable list`);
    assert.ok(scan(`g(['${d}']);`).some((b) => b.includes(d)), `${d}: not caught as a literal call`);
  }
});

test('A248 guard (scanner): spawn shapes the first guard could not see (finding 2)', () => {
  const cases = /** @type {Array<[string, string, Partial<typeof T0>, string, RegExp]>} */ ([
    ['an alias of proc', "const p = proc; p.run('git', ['ls-files'], {});", {}, IMPORT + FWD, /`proc` is used other than/],
    ['a destructured run', "const { run } = proc; run('git', ['ls-files'], {});", {}, IMPORT + FWD, /`proc` is used other than/],
    ['a property read, not called', "const r = proc.run; r('git', ['ls-files'], {});", {}, IMPORT + FWD, /`proc` is used other than/],
    ['a name import of run', "run('git', ['ls-files'], {});", {}, "import { run } from './proc.mjs';\n" + FWD, /imports run from proc\.mjs/],
    ['a renamed namespace', "p.run('git', ['ls-files'], {});", {}, "import * as p from './proc.mjs';\n" + FWD, /imports p from proc\.mjs/],
    ['a name import in another path form', "x();", {}, "import { runAsync as ra } from '../proc.mjs';\n" + FWD, /imports runAsync from proc\.mjs/],
    ['a dynamic import', "const q = await import('./proc.mjs');", {}, IMPORT + FWD, /a dynamic import of proc\.mjs/],
    ['sh -c with git in the text (sh listed)', "proc.run('sh', ['-c', 'git ls-files'], {});", {}, IMPORT + FWD, /names git in its text/],
    ['sh -c with git in a template (sh listed)', "proc.run('sh', ['-c', `cd ${d} && git status`], {});", {}, IMPORT + FWD, /names git in its text/],
    ['sh when sh is not listed', "proc.run('sh', ['-c', 'git ls-files'], {});", { BIN_ALLOW: {} }, IMPORT + FWD, /spawns 'sh', which is not listed/],
    ['bash', "proc.run('bash', ['-c', 'git ls-files'], {});", {}, IMPORT + FWD, /spawns 'bash', which is not listed/],
    ['env', "proc.run('env', ['git', 'ls-files'], {});", {}, IMPORT + FWD, /spawns 'env', which is not listed/],
    ['a path to git', "proc.run('/usr/bin/git', ['ls-files'], {});", { DYN_SPAWNS: { 'x.mjs': 1 } }, IMPORT + FWD, /raw git ls-files \(proc\.run\)/],
    ['a variable binary in a file that is not listed', "proc.run(bin, args, {});", { DYN_BIN: {} }, IMPORT + FWD, /not listed in DYN_BIN/],
    ['runAsync', "proc.runAsync('git', ['ls-files'], {});", {}, IMPORT + FWD, /proc\.runAsync\( starts a process and is not listed in SPAWN_REG/],
    ['spawnDetached', "proc.spawnDetached('git', ['ls-files'], env);", {}, IMPORT + FWD, /proc\.spawnDetached\( starts a process/],
    ['startLeader', "proc.startLeader('git', ['ls-files'], {});", {}, IMPORT + FWD, /proc\.startLeader\( starts a process/],
    ['runUserCommand', "proc.runUserCommand('git ls-files', {});", {}, IMPORT + FWD, /proc\.runUserCommand\( starts a process/],
    ['child_process', "import { spawnSync } from 'node:child_process';", {}, IMPORT + FWD, /starts processes without proc\.mjs/],
  ]);
  for (const [name, src, over, head, re] of cases) assert.ok(scan(src, over, head).some((b) => re.test(b)), `${name}: not caught: ${JSON.stringify(scan(src, over, head))}`);
  // listed spawn functions and name imports pass, and an unlisted entry would be stale
  assert.deepEqual(scan("proc.runUserCommand('make', {});", { SPAWN_REG: { 'x.mjs': { runUserCommand: 'r' } } }), []);
  assert.deepEqual(scan('x();', { NAMED_IMPORTS: { 'x.mjs': { runAsync: 'r' } } }, "import { runAsync } from './proc.mjs';\n" + FWD), []);
  assert.deepEqual([...scanSource('x.mjs', IMPORT + FWD + "proc.run('sh', ['-c', 'true'], {});", T0).used], ['bin:x.mjs:sh'], 'the used set names the sh entry');
});

test('A248 guard (scanner): raw log, the diff-tree whitelist, the filter, textconv, index and signature arguments, and global options with a value (findings 3, 4, 5)', () => {
  const raw = (/** @type {string} */ args) => scan(`proc.run('git', [${args}], {});`, { DYN_SPAWNS: { 'x.mjs': 1 } }, IMPORT + FWD);
  const caught = (/** @type {string} */ args, /** @type {RegExp} */ re) => assert.ok(raw(args).some((b) => re.test(b)), `${args}: not caught: ${JSON.stringify(raw(args))}`);
  caught("'log', '-1', '--format=%H'", /raw git log \(proc\.run\)/);
  caught("'-C', r, 'log', '--show-signature'", /raw git log/);
  for (const f of ['-p', '-u', '-p3', '--patch', '--patch-with-stat', '--patch-with-raw', '--stat', '--stat=40', '--numstat', '--shortstat', '--dirstat', '--dirstat=files', '--raw', '-U', '-U5', '--unified=3', '--textconv', '--ext-diff', '--cc', '-c', '-m', '--follow',
    '-S', '-Sfoo', '-G', '-Gfoo', '--pickaxe-all', '--pickaxe-regex', '--binary', '--summary', '--check', '--word-diff', '--color-words', '-W', '--function-context', '--full-diff', '--show-signature', '-M', '-C', '--find-renames', '--diff-filter=A', '--output=x']) {
    caught(`'diff-tree', '${f}', a, b`, /diff-tree with an option that is not on the whitelist/);
  }
  assert.deepEqual(raw("'diff-tree', '-r', '--name-only', '--no-renames', '-z', a, b"), [], 'the whitelisted options pass');
  caught("'rev-list', '--format=%G?', 'HEAD'", /%G\?|signature/);
  caught("'for-each-ref', '--format=%(signature:grade)'", /signature/);
  caught("'rev-list', '--show-signature', 'HEAD'", /signature/);
  caught("'rev-list', `--format=%G${q}`, 'HEAD'", /signature/);
  for (const f of ['--textconv', '--filters', '--indexed-objects']) caught(`'cat-file', '${f}', x`, /a filter, a textconv, an index lookup or a signature check/);
  caught("'cat-file', '--path=a.txt', '--filters', x", /cat-file with/);
  caught("'cat-file', '-p', ':README.md'", /an index lookup/);
  caught("'rev-parse', ':README.md'", /an index lookup/);
  caught("'rev-parse', `:${p}`", /an index lookup/);
  caught("'rev-list', '--objects', ':x'", /an index lookup/);
  assert.deepEqual(raw("'rev-parse', '--verify', `refs/heads/${b}`, '--'"), [], 'an ordinary ref passes');
  // global options with a separate value are skipped, so the subcommand behind them is the real one
  assert.deepEqual(subcommand(["'--namespace'", "'rev-parse'", "'ls-files'"]), { sub: 'ls-files', rest: [] });
  assert.deepEqual(subcommand(["'--super-prefix'", "'a/'", "'status'"]), { sub: 'status', rest: [] });
  assert.deepEqual(subcommand(["'--config-env'", "'a=B'", "'status'"]), { sub: 'status', rest: [] });
  assert.deepEqual(subcommand(["'--attr-source'", "'HEAD'", "'ls-files'"]), { sub: 'ls-files', rest: [] });
  assert.deepEqual(subcommand(["'-C'", 'r', "'-c'", "'a=b'", "'--git-dir'", 'd', "'--no-optional-locks'", "'rev-parse'"]), { sub: 'rev-parse', rest: [] });
  caught("'--namespace', 'rev-parse', 'ls-files'", /raw git ls-files/);
});

test('A248 guard (scanner): the exceptions are matched per file and per subcommand, and the proof repository reader is the only raw log and diff', () => {
  const T1 = { ...T0, EXCEPT_SUBS: { 'x.mjs': { log: 'r' } } };
  assert.deepEqual(scanSource('x.mjs', IMPORT + FWD + "g(['log', '-1']);", T1).bad, []);
  assert.ok(scanSource('y.mjs', IMPORT + "const g = (a) => proc.run('git', a, {}); g(['log', '-1']);", { ...T1, WRAPPERS: { 'y.mjs': ['g'] }, DYN_SPAWNS: { 'y.mjs': 1 } }).bad.some((b) => /raw git log/.test(b)), 'an exception of another file does not apply');
  assert.ok(EXCEPT_SUBS['deliver.mjs'].log !== undefined && !ALLOWED.has('log'));
  // the deliver.mjs diff and log exceptions cover the proof repository wrappers only, not a raw spawn in the same file
  const T2 = { ...T0, EXCEPT_SUBS: { 'x.mjs': { diff: 'r', log: 'r' } }, EXCEPT_VIA: { 'x.mjs': { diff: ['g'], log: ['g'] } } };
  assert.deepEqual(scanSource('x.mjs', IMPORT + FWD + "g(['diff', '--name-only']); g(['log', '-1']);", T2).bad, []);
  assert.ok(scanSource('x.mjs', IMPORT + FWD + "proc.run('git', ['-C', root, 'diff', '--cached'], {});", T2).bad.some((b) => /raw git diff \(proc\.run\)/.test(b)));
  assert.ok(scanSource('x.mjs', IMPORT + FWD + "proc.run('git', ['-C', root, 'log'], {});", T2).bad.some((b) => /raw git log \(proc\.run\)/.test(b)));
  assert.deepEqual(EXCEPT_VIA['deliver.mjs'], { diff: ['gp', 'gps'], log: ['gp', 'gps'] });
});

test('A248 round 7: a known-issue place check (kirules listable, ls-files --error-unmatch) never runs the repository\'s core.fsmonitor program', () => {
  const fx = makeFixture();
  const mark = posix(`${fx.root}-FSM`); const prog = posix(`${fx.root}-fsm.sh`);
  try {
    writeFileSync(prog, `#!/bin/sh\ntouch ${mark}\nprintf '\\0'\n`);
    chmodSync(prog, 0o755);
    git(fx.root, ['config', 'core.fsmonitor', prog]);
    git(fx.root, ['ls-files', '--error-unmatch', '--', 'README.md']);
    assert.ok(existsSync(mark), 'test premise: plain ls-files runs the core.fsmonitor program');
    rmSync(mark, { force: true });
    const ctx = fx.ctx();
    assert.equal(listable(ctx, 'QUALITY', 'README.md'), null, 'a tracked file is listable');
    assert.ok(listable(ctx, 'QUALITY', 'nope.txt')?.includes('not a tracked file'), 'an untracked one is not');
    assert.ok(!existsSync(mark), 'listable ran the core.fsmonitor program of the repository configuration');
  } finally { rmSync(prog, { force: true }); rmSync(mark, { force: true }); }
});
