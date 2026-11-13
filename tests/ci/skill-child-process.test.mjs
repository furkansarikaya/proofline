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

/** The first argument of each child-process call of a source text. @param {string} src @returns {string[]} */
export function spawnFirstArgs(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\s\/\/ .*$/, '')).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return [...code.matchAll(/(?<![.\w])(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\(\s*((?:[^,()]|\([^()]*\))*)/g)].map((m) => m[1].trim()).filter((a) => a !== '');
}
/** A name other than programOf(...) that a script may start, and the line that must stand in its source for that name. */
const OTHER = {
  'skills/performance-proof/scripts/run-bench.mjs': { program: /program = programOf\(argv\[0\], cwd\)/, abs: /const abs = resolveProgram\(program\)/ },
  'skills/verify-proof/scripts/runtime-versions.mjs': { abs: /const abs = resolveProgram\(program\)/ },
  'skills/visual-proof/scripts/native.mjs': { program: /program = programOf\(usable\.argv\[0\], repo\)/ },
};
/** The scripts with their own PATH search: on Windows it must be the helper's. */
const OWN_SEARCH = ['skills/performance-proof/scripts/run-bench.mjs', 'skills/verify-proof/scripts/runtime-versions.mjs'];

test('A270: each listed script imports its winprog.mjs and starts every program through it (a call that does not is noticed)', () => {
  for (const f of LIST) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /import \{ programOf(?:, resolveProgram as winResolve)? \} from "\.\/winprog\.mjs";/, f);
    const args = spawnFirstArgs(src);
    assert.ok(args.length > 0, `${f}: no child-process call found: the parser lost it`);
    // helper calls inside the script that are not child processes (`.exec(` of a regular expression, `exec` default parameter) are told apart by their argument
    for (const a of args) {
      assert.ok(a.startsWith('programOf(') || OTHER[f]?.[a]?.test(src), `${f}: starts ${a} without programOf`);
    }
    if (OWN_SEARCH.includes(f)) assert.match(src, /process\.platform === "win32"\) \{ const r = winResolve\(name, process\.env\)/, `${f}: its own PATH search must go through winResolve on Windows`);
  }
  // premise of the pin: the parser sees an unwrapped call, a wrapped one, and not a comment
  assert.deepEqual(spawnFirstArgs('const r = spawnSync("git", ["-C", x]); execFileSync(programOf("git"), []); // spawn(nope)\n// spawnSync(abs)'), ['"git"', 'programOf("git")']);
});

test('A270: the skills\' resolver gives the same answer as the core resolveProgram for every row of the table (platform and file system injected)', () => {
  const files = new Set(['C:\\bin\\git.exe', 'C:\\bin\\tool.cmd', 'C:\\old\\sh.cmd', 'C:\\new\\sh.exe', 'C:\\proj\\git.exe', 'C:\\tools\\py.com', 'C:\\tools\\py.exe', 'C:\\bin\\odd.exe', 'C:\\tmp\\x.exe']);
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
