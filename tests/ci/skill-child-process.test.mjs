// A252 (review round 2): a census of the shipped scripts that import node:child_process outside core/proc.mjs. On Windows libuv searches the working folder before PATH for a
// program given by bare name, so such a script (`git`, `sh`, `python3`, ...) would run a planted `git.exe` of a cloned project. core/proc.mjs resolves bare names
// (`resolveProgram`); the skill scripts are standalone installs and do not use it. They are NOT covered: not tried (denenmedi), kararını bekliyor (A252 has the
// alternatives). This test fixes the list, so a new script that starts a program is noticed: it fails when the tree and LIST differ, and says what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
