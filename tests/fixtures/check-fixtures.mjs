// @ts-check
// Builds every fixtures/*/setup.mjs into a temporary directory and runs the fixture's selfcheck.mjs (if any). Prints PASS/FAIL per fixture; exits non-zero
// when any fixture fails. Offline; installs nothing. (The builders and selfchecks are Node since issue #176 package B; this is their driver.)
// Also builds the proof-review and test-trust fixtures (setup.mjs, plan-setup.mjs, diff-setup.mjs; go and ts). Their tests and
// the PLAN check run when the toolchain exists (go, node 22.18+/23.6+, vitest for test-trust ts), else a SKIP line with the reason is printed (SKIP is never
// counted as a pass and never omitted).
// Usage: node tests/fixtures/check-fixtures.mjs [fixture-name ...]
import { tempDir } from '../lib/tempdir.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGroup } from '../lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const has = (/** @type {string} */ c) => spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [c] : ['-c', `command -v ${c}`], { stdio: 'ignore' }).status === 0;
/** Node can run TypeScript by type stripping: 22.18+, 23.6+ or 24+. @param {string} [v] */
export function nodeTsOk(v = process.versions.node) { const [a, b] = v.split('.').map(Number); return a >= 24 || (a === 23 && b >= 6) || (a === 22 && b >= 18); }
const indent = (/** @type {string} */ t) => t.replace(/\n$/, '').split('\n').map((l) => `  ${l}`).join('\n');

/**
 * @param {string[]} names the fixtures to build (none: all) @param {{ write?: (s: string) => void, timeoutMs?: number }} [o] @returns {Promise<number>} the exit status
 */
export async function main(names, o = {}) {
  const write = o.write ?? ((s) => process.stdout.write(s));
  const timeoutMs = o.timeoutMs ?? 900000;
  let work;
  try { work = tempDir('proofline-fixtures-'); } catch { console.error(`TMPDIR must be an existing directory: ${process.env.TMPDIR || os.tmpdir()}`); return 2; }
  try {
    const explicit = names.length > 0;
    if (!explicit) names = readdirSync(path.join(root, 'fixtures')).sort().filter((n) => existsSync(path.join(root, 'fixtures', n, 'setup.mjs')));
    let pass = 0; let total = 0; let skips = 0;
    for (const name of names) {
      const dir = path.join(root, 'fixtures', name);
      if (!existsSync(path.join(dir, 'setup.mjs'))) continue;   // proof-review, test-trust: built by the steps below
      total++;
      const out = path.join(work, name);
      let r = await runGroup(process.execPath, [path.join(dir, 'setup.mjs'), out], { timeoutMs });
      if (r.status !== 0) { write(`FAIL ${name} (setup.mjs)\n${indent(r.text)}\n`); continue; }
      let log = r.text;
      if (existsSync(path.join(dir, 'selfcheck.mjs'))) {
        r = await runGroup(process.execPath, [path.join(dir, 'selfcheck.mjs'), out], { timeoutMs });
        log += r.text;
        if (r.status !== 0) { write(`FAIL ${name} (selfcheck.mjs)\n${indent(log)}\n`); continue; }
      }
      write(`PASS ${name}\n`); pass++;
    }
    // --- ported proof-review / test-trust fixtures ---------------------------------------------------
    const skip = (/** @type {string} */ what, /** @type {string} */ why) => { write(`SKIP ${what}: ${why}\n`); skips++; };
    /** One PASS/FAIL line, counted in the totals. @param {string} sn @param {string} cmd @param {string[]} args @param {string} [cwd] */
    const step = async (sn, cmd, args, cwd) => {
      total++;
      const r = await runGroup(cmd, args, { cwd, timeoutMs });
      if (r.status === 0) { write(`PASS ${sn}\n`); pass++; } else write(`FAIL ${sn}\n${indent(r.text)}\n`);
    };
    const runExtra = !explicit || names.some((a) => a === 'proof-review' || a === 'test-trust');
    if (runExtra) {
      const fx = path.join(root, 'fixtures');
      {
        for (const lang of ['go', 'ts']) {
          await step(`proof-review/${lang} setup.mjs`, process.execPath, [path.join(fx, 'proof-review', lang, 'setup.mjs'), path.join(work, `pr-${lang}`)]);
          await step(`proof-review/${lang} setup.mjs --working-tree`, process.execPath, [path.join(fx, 'proof-review', lang, 'setup.mjs'), path.join(work, `pr-${lang}-wt`), '--working-tree']);
          await step(`proof-review/${lang} plan-setup.mjs`, process.execPath, [path.join(fx, 'proof-review/plan-setup.mjs'), lang, path.join(work, `pr-${lang}-run`)]);
          const run = path.join(work, `pr-${lang}-run`);
          await step(`proof-review/${lang} plan-setup.mjs PLAN passes validate-plan.mjs`, process.execPath,
            [path.join(root, 'skills/plan-contract/scripts/validate-plan.mjs'), path.join(run, '.agents/runs/FIX-1/PLAN.md'), path.join(run, '.agents/runs/FIX-1/TASK.md'), '--class', 'STANDARD', '--repo', run]);
          for (const sc of ['fail', 'pass']) await step(`test-trust/${lang} diff-setup.mjs ${sc}`, process.execPath, [path.join(fx, 'test-trust/diff-setup.mjs'), lang, path.join(work, `tt-${lang}-${sc}`), sc]);
        }
        if (has('go')) {
          await step('proof-review/go branch fixture: go test', 'go', ['test', './...'], path.join(work, 'pr-go'));
          await step('proof-review/go run fixture: go test', 'go', ['test', './...'], path.join(work, 'pr-go-run'));
          await step('test-trust/go diff-setup pass: go test', 'go', ['test', './...'], path.join(work, 'tt-go-pass'));
        } else skip('proof-review/go and test-trust/go tests', 'go not available');
        if (nodeTsOk()) {
          await step('proof-review/ts branch fixture: node --test', process.execPath, ['--test'], path.join(work, 'pr-ts'));
          await step('proof-review/ts run fixture: node --test', process.execPath, ['--test'], path.join(work, 'pr-ts-run'));
        } else skip('proof-review/ts tests', 'node 22.18+/23.6+ with type stripping not available');
        if (has('vitest')) await step('test-trust/ts diff-setup pass: vitest', 'vitest', ['run'], path.join(work, 'tt-ts-pass'));
        else skip('test-trust/ts tests', 'vitest not installed (fixtures never install anything)');
      }
    }
    write(`fixtures: ${pass}/${total} passed, ${skips} skipped\n`);
    return pass === total ? 0 : 1;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
