// @ts-check
// The logic of the inline steps of .github/workflows/ci.yml, as one-line `node` steps.
//   node tests/ci/ci-steps.mjs classify [--event NAME] [--base SHA --head SHA]   (defaults: $GITHUB_EVENT_NAME, $BASE_SHA, $GITHUB_SHA)
//       writes `code=true|false` to $GITHUB_OUTPUT and prints it: false for a pull request that changes only plain documentation (tests/ci/classify.mjs)
//   node tests/ci/ci-steps.mjs skill-tests
//       the `skill tests` step of the static job: tests/skills/ when it holds test files (else a SKIPPED line), then the benchmark's own tests; the first failing status ends it
//   node tests/ci/ci-steps.mjs gate
//       the `checks` gate: reads the `needs` context as JSON from $NEEDS_JSON; a failed or cancelled job (or a context it cannot read) fails, skipped and successful jobs pass
//   node tests/ci/ci-steps.mjs windows-timing
//       the hook benchmark (tests/bench/hook-procs.mjs) with its table fenced in the job summary ($GITHUB_STEP_SUMMARY); the fence is closed
//       whatever the benchmark does, and its exit status is the step's
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
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

/** The jobs of a `needs` context that failed or were cancelled; an unreadable context is one problem (fail closed). @param {string | undefined} json @returns {string[]} */
export function gateFailures(json) {
  let needs;
  try { needs = JSON.parse(json ?? ''); } catch { return ['the needs context is not JSON']; }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs) || Object.keys(needs).length === 0) return ['the needs context is empty'];
  return Object.entries(needs).filter(([, v]) => ['failure', 'cancelled'].includes(/** @type {{ result?: string }} */ (v)?.result ?? 'failure')).map(([k]) => k);
}

/** @param {string[]} argv @param {{ env?: NodeJS.ProcessEnv, write?: (s: string) => void, changed?: (base: string, head: string) => string[], bench?: [string, string[]], exec?: (program: string, args: string[]) => number, list?: (dir: string) => string[] }} [io] @returns {number} */
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
        const names = (io.changed ?? ((b, h) => execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--no-renames', b, h], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0')))(o.base, o.head);
        code = classify(names).replace(/^code=/, '');
      }
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `code=${code}\n`);
      write(`code=${code}\n`);
      return 0;
    }
    if (cmd === 'skill-tests') {
      const exec = io.exec ?? ((p, a) => spawnSync(p, a, { cwd: root, stdio: 'inherit' }).status ?? 1);
      const list = io.list ?? ((d) => readdirSync(path.join(root, d)));
      let has = false;
      try { has = list('tests/skills').some((n) => n.endsWith('.test.mjs')); } catch { has = false; }
      if (has) { const st = exec('node', ['--test', 'tests/skills/']); if (st !== 0) return st; } else write('SKIPPED: no tests/skills/*.test.mjs yet\n');
      return exec('node', ['--test', 'tests/benchmark/benchmark.test.mjs']);
    }
    if (cmd === 'gate') {
      const failed = gateFailures(env.NEEDS_JSON);
      if (failed.length > 0) { console.error(`a CI job failed or was cancelled: ${failed.join(', ')}`); return 1; }
      write('all jobs passed or were skipped\n');
      return 0;
    }
    if (cmd === 'windows-timing') {
      const sum = env.GITHUB_STEP_SUMMARY;
      const out = (/** @type {string} */ s) => { if (sum) appendFileSync(sum, s); else write(s); };
      out('### Node hook per event (Windows, Node harness fixtures)\n```\n');
      const [bcmd, bargs] = io.bench ?? ['node', ['tests/bench/hook-procs.mjs', 'adapters/claude/hooks/proofline-hook.mjs']];
      const r = spawnSync(bcmd, bargs, { cwd: root, env: { ...env, REPEAT: '5' }, encoding: 'utf8', maxBuffer: 1 << 26 });
      out(r.stdout ?? '');
      if (r.error) out(`${r.error.message}\n`);
      out('```\n');
      if (r.stderr) process.stderr.write(r.stderr);
      return r.status === 0 ? 0 : 1;
    }
    console.error('usage: ci-steps.mjs classify --event NAME [--base SHA --head SHA] | skill-tests | gate | windows-timing');
    return 2;
  } catch (e) {
    console.error(`ci-steps: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
