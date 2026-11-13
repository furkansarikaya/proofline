// A252 (review round 2), A270 (Windows port W11): a census of the shipped scripts that import node:child_process outside core/proc.mjs. On Windows libuv searches the working folder before PATH for a
// program given by bare name, so such a script (`git`, `sh`, `python3`, ...) would run a planted `git.exe` of a cloned project. W11 routes every one of them through `programOf` of the skill's own
// `scripts/winprog.mjs` (a copy per skill, byte-identical, same rules as `resolveProgram` in core/proc.mjs: A270). This test fixes the list, so a new script that starts a program is noticed, checks that the
// copies are identical, that every spawn call of a listed script starts `programOf(...)`, and runs the copy against the core's resolver over a table.
// The census reads `git ls-files`, so it needs a git checkout (.git) and sees only tracked files: a NEW importer is invisible until it is staged (`git add`).
// `runtime-versions.mjs` and `run-bench.mjs` (the version probe) start the absolute path of their own PATH search; on Windows that search is the helper (W11). `measure.mjs` starts the browser it was given through `programOf` too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
export const LIST = [
  'skills/concurrency-proof/scripts/find-shared-state.mjs',
  'skills/concurrency-proof/scripts/validate-concurrency.mjs',
  'skills/contract-proof/scripts/diff-contract.mjs',
  'skills/contract-proof/scripts/validate-contract.mjs',
  'skills/evidence-map/scripts/impact.mjs',
  'skills/exploit-proof/scripts/diff-manifests.mjs',
  'skills/performance-proof/scripts/run-bench.mjs',
  'skills/product-assess/scripts/check-outcome.mjs',
  'skills/product-assess/scripts/lib.mjs',
  'skills/product-discovery/scripts/check-quotes.mjs',
  'skills/product-spec/scripts/trace.mjs',
  'skills/proof-review/scripts/check-config.mjs',
  'skills/ui-design/scripts/scope-check.mjs',
  'skills/verify-proof/scripts/runtime-versions.mjs',
  'skills/visual-proof/scripts/measure.mjs',
  'skills/visual-proof/scripts/native.mjs',
];
const IMPORT = /from ['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)|import\(\s*['"](?:node:)?child_process['"]/;

/** The tracked source files outside core/proc.mjs, tests/, docs/ and fixtures/ that import child_process. @returns {string[]} */
export function importers() {
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter((f) => /\.(mjs|js|cjs|ts|mts|cts)$/.test(f) || f === 'bin/proofline');
  return files.filter((f) => !/^(tests|docs|fixtures)\//.test(f) && f !== 'control-plane/agents/scripts/core/proc.mjs' && IMPORT.test(readFileSync(path.join(root, f), 'utf8'))).sort();
}

test('A252: the scripts that import node:child_process are exactly the listed skill scripts (a new one must be added here and to A252 NOT COVERED)', () => {
  assert.deepEqual(importers(), [...LIST].sort(), 'a script that starts programs by itself changed the list: add it (or its removal) to LIST and to the NOT COVERED list of A252, or route it through core/proc.mjs');
});

test('A252: the census sees an import, a require and a dynamic import, and nothing else', () => {
  for (const yes of ["import { spawn } from 'node:child_process';", 'import cp from "child_process"', "const c = require('node:child_process')", "await import('child_process')"]) assert.equal(IMPORT.test(yes), true, yes);
  for (const no of ["// child_process is not used here", "const name = 'child_process'", 'import { x } from "./child_process-helper.mjs"']) assert.equal(IMPORT.test(no), false, no);
});

// ---- A270 (Windows port W11): the program is started through the skill's winprog.mjs -------------------------------------------------------------------------------------------------------------
import { resolveProgram as coreResolve } from '../../control-plane/agents/scripts/core/proc.mjs';
import { makeRefusedDir } from '../../control-plane/agents/scripts/core/wintool.mjs';

const skillDirs = [...new Set(LIST.map((f) => path.dirname(f)))].sort();
const helper = (dir) => path.join(root, dir, 'winprog.mjs');
const { resolveProgram: skillResolve, refusedIn } = await import(pathToFileURL(helper(skillDirs[0])).href);

test('A270: every skill that has a listed script carries the same winprog.mjs, byte for byte (twelve copies, no shared library)', () => {
  assert.equal(skillDirs.length, 12, skillDirs.join(' '));
  const first = readFileSync(helper(skillDirs[0]), 'utf8');
  for (const d of skillDirs) assert.equal(readFileSync(helper(d), 'utf8'), first, `${d}/winprog.mjs differs from the others`);
  // no other skill carries a stray copy that would drift
  const tracked = execFileSync('git', ['-C', root, 'ls-files', 'skills'], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('/winprog.mjs'));
  assert.deepEqual(tracked.sort(), skillDirs.map((d) => `${d}/winprog.mjs`).sort());
});

/**
 * SRC without comments, as two strings of the same length: CODE keeps strings and regular expressions, MASKED has their bodies blanked (so a name inside a string or a regular
 * expression is never taken for code). String-, template- and regex-aware, so `"a // b"; spawnSync("git")` does not lose the call. @param {string} src
 */
export function strip(src) {
  let code = '', masked = '', i = 0, last = '';
  const put = (/** @type {string} */ text, /** @type {boolean} */ blank) => { code += text; masked += blank ? text.replace(/[^\n]/g, ' ') : text; };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { let j = i; while (j < src.length && src[j] !== '\n') j++; put(src.slice(i, j).replace(/[^\n]/g, ' '), false); i = j; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; put(src.slice(i, j).replace(/[^\n]/g, ' '), false); i = j; continue; }
    if (c === '`') {   // a template: the text is blanked, the ${...} parts are code
      let j = i + 1;
      put('`', false);
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { put(src.slice(j, j + 2), true); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let d = 1, k = j + 2;
          for (; k < src.length && d > 0; k++) { if (src[k] === '{') d++; else if (src[k] === '}') d--; }
          const inner = strip(src.slice(j + 2, k - 1));
          put('${', false); code += inner.code; masked += inner.masked; put('}', false); j = k; continue;
        }
        put(src[j], true); j++;
      }
      put(src[j] ?? '', false); i = j + 1; last = '`'; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      put(c, false); put(src.slice(i + 1, j), true); put(src[j] ?? '', false); i = j + 1; last = c; continue;
    }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};]/.test(last))) {
      let j = i + 1, cls = false;
      for (; j < src.length; j++) { const ch = src[j]; if (ch === '\\') j++; else if (ch === '[') cls = true; else if (ch === ']') cls = false; else if ((ch === '/' && !cls) || ch === '\n') break; }
      put('/', false); put(src.slice(i + 1, j), true); put(src[j] ?? '', false); i = j + 1; last = '/'; continue;
    }
    put(c, false); if (!/\s/.test(c)) last = c; i++;
  }
  return { code, masked };
}

/**
 * Everything that lets a script start a program other than through `programOf(...)` (A270, security round 1): a child_process import that is not exactly
 * `import { a, b } from "node:child_process"` without `as` (namespace, default, require, dynamic import), a member use `x.spawnSync`, a re-binding (`go = spawnSync`, `(0, spawnSync)(`: any
 * use of an imported name that is not a call), a call whose first argument is not `programOf(...)` or one of OTHER's pinned variables (checked against SRC), and a script with no call at all.
 * ALIASES are names a script may call besides the imported ones; ALLOW are the exact re-bindings it may have. @param {string} src
 * @param {{ other?: Record<string, RegExp>, aliases?: string[], allow?: RegExp[] }} [o] @returns {string[]}
 */
export function censusViolations(src, { other = {}, aliases = [], allow = [] } = {}) {
  const { code, masked } = strip(src);
  const bad = /** @type {string[]} */ ([]);
  const mention = /["'`](?:node:)?child_process["'`]/g;
  const ok = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  for (const w of masked.matchAll(/\b(?:getBuiltinModule|createRequire|binding)\b/g)) bad.push(`a way to load a module that the census cannot follow: ${w[0]}`);
  for (const m of masked.matchAll(/\w+\s*\.\s*(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/g)) bad.push(`member call ${m[0].trim()}`);
  const found = [...code.matchAll(mention)].length, good = [...code.matchAll(ok)];
  if (found !== good.length) bad.push('a child_process import that is not a braced named import (namespace, default, require or dynamic import)');
  const names = good.flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
  for (const nm of names) if (!/^[A-Za-z_$][\w$]*$/.test(nm)) bad.push(`aliased or odd import: ${nm}`);
  let scan = masked;
  for (const m of good) scan = scan.slice(0, m.index) + ' '.repeat(m[0].length) + scan.slice((m.index ?? 0) + m[0].length);
  for (const a of allow) scan = scan.replace(new RegExp(a.source, a.flags.replace('g', '') + 'g'), (x) => ' '.repeat(x.length));
  let calls = 0;
  for (const nm of [...names.filter((x) => /^[A-Za-z_$][\w$]*$/.test(x)), ...aliases]) {
    const imported = names.includes(nm);
    for (const m of scan.matchAll(new RegExp(`(?<![\\w$])${nm.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
      const at = m.index ?? 0, before = scan.slice(0, at).trimEnd().slice(-1), after = scan.slice(at + nm.length).trimStart()[0];
      if (before === '.') { if (imported) bad.push(`member use .${nm}`); continue; }
      if (after !== '(') { if (imported) bad.push(`${nm} used as a value (re-binding)`); continue; }
      calls++;
      let depth = 0, j = scan.indexOf('(', at + nm.length) + 1;
      const from = j;
      for (; j < scan.length; j++) { const ch = scan[j]; if (ch === '(' || ch === '[' || ch === '{') depth++; else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; } else if (ch === ',' && depth === 0) break; }
      const arg = code.slice(from, j).trim();
      let end = from, d2 = 1;   // the whole call: a child started in another working folder must say so to programOf
      for (; end < scan.length && d2 > 0; end++) { if (scan[end] === '(') d2++; else if (scan[end] === ')') d2--; }
      const callText = masked.slice(from, end), cwdSet = /\bcwd\b/.test(callText);
      const maskedArg = masked.slice(from, j).trim();
      const wrapped = arg.startsWith('programOf(') && closeOf(maskedArg, maskedArg.indexOf('(')) === maskedArg.length - 1;
      if (!wrapped && !other[arg]?.test(src)) bad.push(`${nm}(${arg}...) is not exactly one programOf(...)`);
      if (wrapped && cwdSet && !/,/.test(maskedArg.slice(maskedArg.indexOf('(') + 1, -1).replace(/\([^()]*\)/g, ''))) bad.push(`${nm}(${arg}...) sets cwd but programOf does not get it`);
    }
  }
  if (calls === 0) bad.push('no child-process call found: the parser lost it');
  return bad;
}
/** The index of the parenthesis that closes the one at OPEN in TEXT (-1 when none); TEXT is masked. */
function closeOf(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) { if (text[i] === '(') d++; else if (text[i] === ')' && --d === 0) return i; }
  return -1;
}
/** A variable other than programOf(...) that a script may start, and the line that must stand in its source for that name. */
const OTHER = {
  'skills/performance-proof/scripts/run-bench.mjs': { program: /program = programOf\(argv\[0\], cwd\)/, abs: /const abs = resolveProgram\(program\)/ },
  'skills/verify-proof/scripts/runtime-versions.mjs': { abs: /const abs = resolveProgram\(program\)/ },
  'skills/visual-proof/scripts/native.mjs': { program: /program = programOf\(usable\.argv\[0\], repo\)/ },
};
/** The scripts with a call name of their own (the injectable `exec` of native.mjs is `spawnSync` by default). */
const EXTRA = { 'skills/visual-proof/scripts/native.mjs': { aliases: ['exec'], allow: [/\bexec = spawnSync\b/] } };
/** The scripts with their own PATH search: on Windows it must be the helper's. */
const OWN_SEARCH = ['skills/performance-proof/scripts/run-bench.mjs', 'skills/verify-proof/scripts/runtime-versions.mjs'];

test('A270: each listed script imports its winprog.mjs and starts every program through it (a call that does not is noticed)', () => {
  for (const f of LIST) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /import \{ programOf(?:, resolveProgram as winResolve)? \} from "\.\/winprog\.mjs";/, f);
    assert.deepEqual(censusViolations(src, { other: OTHER[f] ?? {}, ...EXTRA[f] }), [], f);
    if (OWN_SEARCH.includes(f)) assert.match(src, /process\.platform === "win32"\) \{ const r = winResolve\(name, process\.env\)/, `${f}: its own PATH search must go through winResolve on Windows`);
  }
});

test('A270 security round 1: the census flags every way round programOf (member use, alias, re-binding, namespace, require, a comment marker in a string) and passes the clean forms', () => {
  const imp = 'import { spawnSync, execFileSync } from "node:child_process";\n';
  const wrapped = `${imp}const a = execFileSync(programOf("git"), ["-C", x]);\n`;
  assert.deepEqual(censusViolations(wrapped), [], 'premise: the clean form passes');
  assert.deepEqual(censusViolations(`${wrapped}// spawnSync("git")\n/* spawn("sh") */ const s = "spawnSync(x)";`), [], 'names in comments and strings are not code');
  const evasions = {
    'a call that is not wrapped': `${wrapped}spawnSync("git", []);`,
    'member use on a namespace import': `import * as cp from "node:child_process";\nconst a = cp.spawnSync("git"); execFileSync(programOf("git"), []);`,
    'member use of a named import': `${wrapped}const k = globalThis.spawnSync; k("git");`,
    'aliased import': `import { spawnSync as run } from "node:child_process";\nrun("git"); const a = programOf("git");`,
    'default import': `import cp from "child_process";\ncp.execSync("git"); const a = programOf("git");`,
    'require': `const cp = require("node:child_process");\ncp.execSync("git"); const a = programOf("git");`,
    'dynamic import': `const cp = await import("node:child_process");\ncp.execSync("git"); const a = programOf("git");`,
    're-binding': `${wrapped}const go = spawnSync; go("git");`,
    'comma operator': `${wrapped}(0, spawnSync)("git");`,
    'a comment marker inside a string earlier on the line': `${wrapped}const u = "a // b"; spawnSync("git");`,
    'a comment marker inside a template and a regex': `${wrapped}const u = \`http://x\`, r = /\\/\\//; spawnSync("git");`,
    'a call hidden after a block comment opener in a string': `${wrapped}const u = "/*"; spawnSync("git"); const v = "*/";`,
    'a space before the parenthesis': `${wrapped}spawnSync ("git");`,
    'programOf only as the start of an expression': `${wrapped}spawnSync(programOf("x") && "git", []);`,
    'getBuiltinModule': `const cp = process.getBuiltinModule("child_process");\ncp.execFileSync("git"); const a = programOf("git");`,
    'createRequire': `${wrapped}createRequire(import.meta.url)("child_process").execFileSync("git");`,
    'a backtick dynamic import': `const cp = await import(\`node:child_process\`);\ncp.execFileSync("git"); const a = programOf("git");`,
    'a child started in another folder without telling programOf': `${imp}spawnSync(programOf("sh"), [], { cwd: root });`,
    'no call at all': `${imp}const a = programOf("git");`,
  };
  for (const [name, src] of Object.entries(evasions)) assert.notDeepEqual(censusViolations(src), [], name);
  // clean forms the census must not flag: a nested call in the argument, the working folder handed over, two spaces in the import
  assert.deepEqual(censusViolations(`${imp}spawnSync(programOf(path.join(a, b)), [], {});`), []);
  assert.deepEqual(censusViolations(`${imp}spawnSync(programOf(cmd[0], root), [], { cwd: root });`), []);
  assert.deepEqual(censusViolations(`import { spawnSync }  from  "node:child_process";\nspawnSync(programOf("g"), []);`), []);
  // the pinned variable is accepted only with its pinned line, and the exact alias only as declared
  assert.notDeepEqual(censusViolations(`${imp}spawnSync(abs, []);`, { other: {} }), []);
  assert.deepEqual(censusViolations(`${imp}spawnSync(abs, []);`, { other: { abs: /spawnSync\(abs/ } }), []);
  const nat = `import { spawnSync } from "node:child_process";\nfunction f({ exec = spawnSync } = {}) { exec(programOf("x"), []); /a/.exec(s); }`;
  assert.deepEqual(censusViolations(nat, { aliases: ['exec'], allow: [/\bexec = spawnSync\b/] }), []);
  assert.notDeepEqual(censusViolations(nat), [], 'without the declared alias the same source is flagged');
  assert.notDeepEqual(censusViolations(nat.replace('exec(programOf("x")', 'exec("x"'), { aliases: ['exec'], allow: [/\bexec = spawnSync\b/] }), [], 'the alias call is held to the same rule');
});

test('A270: the skills\' resolver gives the same answer as the core resolveProgram for every row of the table (platform and file system injected)', () => {
  const files = new Set(['C:\\bin\\git.exe', 'C:\\bin\\tool.cmd', 'C:\\old\\sh.cmd', 'C:\\new\\sh.exe', 'C:\\proj\\git.exe', 'C:\\tools\\py.com', 'C:\\tools\\py.exe', 'C:\\bin\\odd.exe', 'C:\\tmp\\x.exe',
    // planted so that a refusal below is the rule and not "nothing there": a program exists in every place the resolver must not search or accept
    '\\\\srv\\share\\git.exe', 'bin\\git.exe', 'git.exe', '\\bin\\git.exe', 'C:bin\\git.exe', 'C:\\bin\\git;calc.exe', 'C:\\bin\\a b.exe', 'C:\\bin\\a..b.exe', 'C:\\root\\sh.exe']);
  /** @param {string} cwd */
  const fsx = (cwd) => ({ isFile: (f) => files.has(f), real: (f) => (f === 'C:\\bin\\odd.exe' ? 'C:\\bin\\odd.bat' : f), refusedDir: makeRefusedDir([cwd], (x) => x) });
  const rows = [
    ['git', 'C:\\bin;C:\\tools', 'C:\\proj', undefined, 'C:\\bin\\git.exe'],
    ['git', 'C:\\proj;C:\\bin', 'C:\\proj', undefined, null],                  // the working folder on PATH: refused, not skipped to the next
    ['git', '.;bin;;C:\\bin', 'C:\\proj', undefined, 'C:\\bin\\git.exe'],      // relative and empty entries are never searched
    ['git', '\\\\srv\\share;C:\\bin', 'C:\\proj', undefined, 'C:\\bin\\git.exe'],
    ['tool', 'C:\\bin', 'C:\\proj', undefined, null],                          // only a .cmd shim
    ['sh', 'C:\\old;C:\\new', 'C:\\proj', undefined, null],                    // the first folder with any form decides
    ['sh', 'C:\\new;C:\\old', 'C:\\proj', undefined, 'C:\\new\\sh.exe'],
    ['py', 'C:\\tools', 'C:\\proj', '.EXE;.COM', 'C:\\tools\\py.exe'],
    ['py', 'C:\\tools', 'C:\\proj', '.COM;.EXE', 'C:\\tools\\py.com'],
    ['py', '"C:\\tools"', 'C:\\proj', undefined, 'C:\\tools\\py.com'],
    ['odd', 'C:\\bin', 'C:\\proj', undefined, null],                           // the real path is not an .exe
    ['nothing', 'C:\\bin', 'C:\\proj', undefined, null],
    ['git;calc', 'C:\\bin', 'C:\\proj', undefined, null],
    ['a b', 'C:\\bin', 'C:\\proj', undefined, null],
    ['git', '\\\\srv\\share', 'C:\\proj', undefined, null],               // UNC entry alone, git.exe is there
    ['git', 'bin', 'C:\\proj', undefined, null],                        // relative entry alone
    ['git', '', 'C:\\proj', undefined, null],                           // empty entry (the current folder) alone
    ['git', '.', 'C:\\proj', undefined, null],
    ['git', '\\bin', 'C:\\proj', undefined, null],                      // rooted entry without a drive
    ['git', 'C:bin', 'C:\\proj', undefined, null],                      // drive-relative entry
    ['git;calc', 'C:\\bin', 'C:\\proj', undefined, null],               // the file exists: the name is what is refused
    ['a b', 'C:\\bin', 'C:\\proj', undefined, null],
    ['a..b', 'C:\\bin', 'C:\\proj', undefined, null],
    ['git', 'C:\\bin', 'c:\\BIN', undefined, null],                            // the working folder, other case
    ['C:\\x\\git.exe', 'C:\\bin', 'C:\\proj', undefined, 'C:\\x\\git.exe'],    // a path is the caller's choice
    ['.\\git', 'C:\\bin', 'C:\\proj', undefined, '.\\git'],
  ];
  for (const [name, PATH, cwd, PATHEXT, want] of rows) {
    const env = { PATH, ...(PATHEXT ? { PATHEXT } : {}) };
    const a = skillResolve(name, env, cwd, 'win32', fsx(cwd));
    const b = /** @type {any} */ (coreResolve(name, env, cwd, 'win32', fsx(cwd)));
    assert.equal('program' in a, 'program' in b, `${name} on ${PATH}: ${JSON.stringify([a, b])}`);
    assert.equal('program' in a, want !== null, `${name} on ${PATH}: premise ${JSON.stringify(a)}`);
    if ('program' in a) { assert.equal(a.program, b.program, name); assert.equal(a.program, want, name); } else assert.match(a.refused, /not found|shim/, name);
  }
  // a file system that throws: the answer is a refusal, never "found" (premise: the same row resolves with a working one)
  const env = { PATH: 'C:\\bin' };
  for (const { what, broken } of [{ what: 'isFile', broken: { isFile: () => { throw new Error('io'); } } }, { what: 'real', broken: { real: () => { throw new Error('io'); } } }]) {
    const f = { ...fsx('C:\\proj'), ...broken };
    assert.equal('program' in skillResolve('git', env, 'C:\\proj', 'win32', fsx('C:\\proj')), true, `premise ${what}`);
    assert.equal('program' in skillResolve('git', env, 'C:\\proj', 'win32', f), false, what);
    assert.equal('program' in coreResolve('git', env, 'C:\\proj', 'win32', f), false, `core ${what}`);
  }
  // the Windows spelling Path is read too
  assert.equal(/** @type {any} */ (skillResolve('git', { Path: 'C:\\bin' }, 'C:\\proj', 'win32', fsx('C:\\proj'))).program, 'C:\\bin\\git.exe');
});

test('A270: POSIX returns the name unchanged and never looks at the file system', () => {
  const boom = { isFile: () => { throw new Error('touched'); }, real: () => { throw new Error('touched'); }, refusedDir: () => { throw new Error('touched'); } };
  for (const p of ['linux', 'darwin']) for (const n of ['git', 'sh', 'python3', 'a/b', 'C:\\x\\git.exe', '..', '']) assert.deepEqual(skillResolve(n, { PATH: '/bin' }, '/proj', p, boom), { program: n }, `${p} ${n}`);
});

test('A270: the skills\' refused-folder test is the core one (case, slashes, trailing slash, sibling prefix, the real spelling)', () => {
  const expand = (x) => (x === 'C:\\PROJ~1' ? 'C:\\Project' : x);
  for (const dirs of [['C:\\Project'], ['C:\\PROJ~1'], ['C:\\a', 'D:/b/'], []]) {
    const mine = refusedIn(dirs, expand), theirs = makeRefusedDir(dirs, expand);
    for (const d of ['C:\\Project', 'c:/project/', 'C:\\Project\\sub', 'C:\\Projects', 'C:\\PROJ~1\\x', 'C:\\Proj', 'D:\\B', 'D:\\b\\c', 'C:\\ab', '']) assert.equal(mine(d), theirs(d), `${dirs} ${d}`);
  }
  assert.equal(refusedIn(['C:\\Project'], expand)('C:\\Project\\sub'), true);
  assert.equal(refusedIn(['C:\\Project'], expand)('C:\\Projects'), false);
});

test('A270 security round 1: programOf hands the working folder of the child to the resolver, throws on a refusal and is the identity off Windows', async () => {
  const { programOf } = await import(pathToFileURL(helper(skillDirs[0])).href);
  const files = new Set(['C:\\root\\sh.exe', 'C:\\bin\\git.exe', 'C:\\bin\\tool.cmd']);
  const f = { isFile: (x) => files.has(x), real: (x) => x };   // no refusedDir: the helper builds it from the cwd it was given
  // a program planted in the child's working folder (not the current one) is refused; the same PATH from another working folder finds it
  assert.throws(() => programOf('sh', 'C:\\root', { PATH: 'C:\\root' }, 'win32', f), /not found/);
  assert.equal(programOf('sh', 'C:\\elsewhere', { PATH: 'C:\\root' }, 'win32', f), 'C:\\root\\sh.exe', 'premise: the program is findable');
  assert.equal(programOf('git', undefined, { PATH: 'C:\\bin' }, 'win32', f), 'C:\\bin\\git.exe');
  assert.throws(() => programOf('tool', undefined, { PATH: 'C:\\bin' }, 'win32', f), /shim/);
  assert.throws(() => programOf('nothing', undefined, { PATH: 'C:\\bin' }, 'win32', f), /not found/);
  for (const platform of ['linux', 'darwin']) assert.equal(programOf('git', '/x', { PATH: '' }, platform, f), 'git');
});
