// The shellcheck step of the CI `static` job: every tracked shell file (tests/ci/no-shell-logic.mjs decides what a shell file is), `-x -s sh -S warning`: warnings and errors fail,
// info notes (SC2015 `A && B || C` on guard lines) are style. A step of one command line (the strict rule for `run:` steps), so the discovery lives here and not in the workflow.
// Usage: node tests/ci/shellcheck.mjs [--list]
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { currentShellFiles } from './no-shell-logic.mjs';

const root = resolve(import.meta.dirname, '../..');
const files = currentShellFiles(root);
if (process.argv.includes('--list')) { process.stdout.write(`${files.join('\n')}\n`); process.exit(0); }
const r = spawnSync('shellcheck', ['-x', '-s', 'sh', '-S', 'warning', ...files], { cwd: root, stdio: 'inherit' });
if (r.error) { process.stderr.write(`shellcheck: cannot run shellcheck (${r.error.message})\n`); process.exit(127); }
process.exit(r.status ?? 1);
