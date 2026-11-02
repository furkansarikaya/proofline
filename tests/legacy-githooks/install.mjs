// @ts-check
// Installs the PRE-STAGE-3 shell git hooks (the specification the core's `cli pre-commit|pre-push` replace; ADR 0001 section 5.4) into a directory:
//   node tests/legacy-githooks/install.mjs <dir> [pre-commit|pre-push|human.sh ...]     (no names: all three)
// The legacy shell suites (githooks-test.sh, the delivery and batch scenarios) keep testing the old code with it until stage 10; the shipped
// hooks (control-plane/agents/githooks) are launchers of the core. The spec files carry no shebang (they are not shell files of the tree); this writes it.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const dest = process.argv[2];
if (!dest) { process.stderr.write('usage: install.mjs <dir> [names]\n'); process.exit(2); }
const names = process.argv.length > 3 ? process.argv.slice(3) : ['pre-commit', 'pre-push', 'human.sh'];
mkdirSync(dest, { recursive: true });
for (const n of names) {
  if (n === 'human.sh') { writeFileSync(join(dest, n), readFileSync(join(here, 'human.legacy'))); continue; }
  const f = join(dest, n);
  writeFileSync(f, `#!/bin/sh\n${readFileSync(join(here, `${n}.legacy`), 'utf8')}`);
  chmodSync(f, 0o755);
}
