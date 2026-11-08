// @ts-check
// The logic of the inline steps of .github/workflows/ci.yml, as one-line `node` steps.
//   node tests/ci/ci-steps.mjs classify [--event NAME] [--base SHA --head SHA]   (defaults: $GITHUB_EVENT_NAME, $BASE_SHA, $GITHUB_SHA)
//       writes `code=true|false` to $GITHUB_OUTPUT and prints it: false for a pull request that changes only plain documentation (tests/ci/classify.mjs)
//   node tests/ci/ci-steps.mjs windows-timing
//       the hook benchmark (tests/bench/hook-procs.sh, `sh` of Git Bash) with its table fenced in the job summary ($GITHUB_STEP_SUMMARY); the fence is closed
//       whatever the benchmark does, and its exit status is the step's
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify } from './classify.mjs';

const root = path.resolve(import.meta.dirname, '../..');

/** @param {string[]} argv @returns {Record<string, string>} */
function options(argv) {
  /** @type {Record<string, string>} */ const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    o[argv[i].slice(2)] = argv[i + 1];
  }
  return o;
}

/** @param {string[]} argv @param {{ env?: NodeJS.ProcessEnv, write?: (s: string) => void, changed?: (base: string, head: string) => string[], bench?: [string, string[]] }} [io] @returns {number} */
export function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const write = io.write ?? ((s) => process.stdout.write(s));
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'classify') {
      const o = options(rest);
      o.event ??= env.GITHUB_EVENT_NAME; o.base ??= env.BASE_SHA; o.head ??= env.GITHUB_SHA;   // the defaults are what Actions sets
      let code = 'true';
      if (o.event === 'pull_request') {
        if (!o.base || !o.head) throw new Error('classify: --base and --head are needed for a pull request');
        const names = (io.changed ?? ((b, h) => execFileSync('git', ['diff', '--name-only', '--no-renames', b, h], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')))(o.base, o.head);
        code = classify(names).replace(/^code=/, '');
      }
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `code=${code}\n`);
      write(`code=${code}\n`);
      return 0;
    }
    if (cmd === 'windows-timing') {
      const sum = env.GITHUB_STEP_SUMMARY;
      const out = (/** @type {string} */ s) => { if (sum) appendFileSync(sum, s); else write(s); };
      out('### Node hook per event (Windows, Git Bash fixtures)\n```\n');
      const [bcmd, bargs] = io.bench ?? ['sh', ['tests/bench/hook-procs.sh', 'adapters/claude/hooks/proofline-hook.mjs']];
      const r = spawnSync(bcmd, bargs, { cwd: root, env: { ...env, REPEAT: '5' }, encoding: 'utf8', maxBuffer: 1 << 26 });
      out(r.stdout ?? '');
      if (r.error) out(`${r.error.message}\n`);
      out('```\n');
      if (r.stderr) process.stderr.write(r.stderr);
      return r.status === 0 ? 0 : 1;
    }
    console.error('usage: ci-steps.mjs classify --event NAME [--base SHA --head SHA] | windows-timing');
    return 2;
  } catch (e) {
    console.error(`ci-steps: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
