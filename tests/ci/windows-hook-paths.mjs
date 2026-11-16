// @ts-check
// Which changed paths of a pull request make the Windows hook leg (`hook-windows`: the hook tests on windows-latest) run (A290). Everything else on Windows stays nightly and manual.
// The list is what the hook tests and the Windows path tests load or exercise (read from their imports), nothing wider:
//   - the hooks and their guards: adapters/claude/hooks/ (command-scan, guards, events, lib), adapters/codex/hooks.json and install.mjs (the Codex hook wiring);
//   - the core modules the hooks import or load at run time, or that the hook tests import: path handling (paths, pathin, pathkind, shellglob), process spawning (proc, platform, wintool), capture, budget, and the core entry proofline-core.mjs;
//   - the hook tests and what they import: tests/hook/, tests/lib/, tests/golden/capture/, tests/bench/hook-procs.mjs, three helpers of tests/core/;
//   - the Windows CI itself: tests/ci/windows-*.mjs, ci-steps.mjs (the windows-timing step), this file, and .github/workflows/ci.yml.
// A path that ends in `/` or `-` is a prefix; any other entry is one exact file. Paths are repository-relative with `/`.
import { pathToFileURL } from 'node:url';

export const PREFIXES = [
  'adapters/claude/hooks/',
  'tests/hook/',
  'tests/lib/',
  'tests/golden/capture/',
  'tests/ci/windows-',
];

export const FILES = [
  'adapters/codex/hooks.json',
  'adapters/codex/install.mjs',
  'control-plane/agents/scripts/proofline-core.mjs',
  ...['paths', 'pathin', 'pathkind', 'shellglob', 'proc', 'platform', 'wintool', 'capture', 'budget'].map((n) => `control-plane/agents/scripts/core/${n}.mjs`),
  'tests/bench/hook-procs.mjs',
  'tests/core/lib/fixture.mjs',
  'tests/core/fake-time.mjs',
  'tests/core/event-lib.mjs',
  'tests/ci/ci-steps.mjs',
  'tests/ci/ci-steps.test.mjs',
  'tests/ci/ci-workflow.test.mjs',
  '.github/workflows/ci.yml',
];

/** @param {string} p one repository-relative path @returns {boolean} */
export function matchesWindowsHook(p) {
  return FILES.includes(p) || PREFIXES.some((x) => p.startsWith(x));
}

/** `true` when any changed path is on the list (a deleted or renamed path counts: a rename lists both names); an empty list is `false`. @param {string[]} paths @returns {boolean} */
export function windowsHook(paths) {
  return paths.some((p) => p !== '' && matchesWindowsHook(p));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`windows_hook=${windowsHook(process.argv.slice(2))}`);
}
