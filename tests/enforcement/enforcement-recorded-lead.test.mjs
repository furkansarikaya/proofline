// @ts-check
// Absolute Node tests for the enforcement scenarios lead_no_run (A169), lead_edits, knowledge_surfaces and link_writes (H1, E1, E2): the recorded
// corpora (tests/enforcement/recorded/) replayed against the Node hook. Verdicts and reason texts are literals recorded once from the shell hook.
// The recorded calls with PROOFLINE_JSON=node / none (the shell hook's parser switch) are replayed unchanged: the Node hook has one parser and no switch (D14).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project } from '../core/legacy-lib.mjs';
import { corpus, replay } from './recorded.mjs';
import { fixtureRecipe } from './recorded-fixture.mjs';

const base = mkdtempSync(join(tmpdir(), 'enf-rec-'));
after(() => rmSync(base, { recursive: true, force: true }));
/** @param {string} dir @param {string[]} a */
const git = (dir, a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
/** @param {string} dir @param {string} rel @param {string} text */
const put = (dir, rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
/** @param {string} dir @param {(t: string) => string} f */
const editConfig = (dir, f) => { const c = join(dir, '.agents/config.yaml'); writeFileSync(c, f(readFileSync(c, 'utf8'))); };
const underTmp = (() => { const t = process.env.TMPDIR ?? ''; return t === '' || /^(\/private)?\/tmp(\/|$)/.test(base); })();

test('lead_no_run (A169): the lead\'s ban on product files also holds while no run is active; state only agent.sh writes stays protected', async () => {
  const dir = project(fixtureRecipe());
  rmSync(join(dir, '.agents/local/ACTIVE_RUN'), { force: true });
  appendFileSync(join(dir, '.git/info/exclude'), 'dist/\n');
  await replay({
    steps: corpus('lead_no_run'), dir, base,
    mutations: {
      26: () => appendFileSync(join(dir, '.git/info/exclude'), '.claude/settings.local.json\n'),
      41: () => editConfig(dir, (t) => (/^  dir: docs\/product/m.test(t) ? t.replace(/^  dir: docs\/product.*$/m, '  dir: specs/prd') : `${t}product:\n  dir: specs/prd\n`)),
      43: () => writeFileSync(join(dir, '.agents/local/ACTIVE_RUN'), 'LC\n'),
    },
  });
});

test('lead_edits: during a run the lead writes only run artifacts; the verdict, hook-bypass, self-test and runtime-state guards hold', async () => {
  const dir = project(fixtureRecipe());
  const steps = corpus('lead_edits');
  mkdirSync(join(dir, 'src'), { recursive: true });
  await replay({
    steps, dir, base,
    // the sh suite skips the /tmp rule when its own TMPDIR is /tmp: the same condition here
    skip: underTmp ? [50] : [],
    mutations: {
      69: () => writeFileSync(join(dir, '.agents/local/ACTIVE_RUN'), ''),
      73: () => writeFileSync(join(dir, '.agents/local/ACTIVE_RUN'), 'LC\nOTHER\n'),
    },
  });
});

test('knowledge_surfaces: the shared design document and every surface document are knowledge-step paths, written by the lead from CODE_DONE only', async () => {
  const surfaces = (/** @type {string} */ t) => t.replace(/^  design: .*$/m, [
    '  design:', '    shared: docs/design/BASE.md', '    surfaces:', '      site:', '        doc: docs/design/SITE.md', '        paths: apps/web/**', '        mode: persuade',
    '      app:', '        doc: ops/APP-DESIGN.md', '        paths: apps/dashboard/**', '        mode: operate'].join('\n'));
  const steps = corpus('knowledge_surfaces');
  const impl = project(fixtureRecipe());
  editConfig(impl, surfaces);
  await replay({ steps, dir: impl, base, only: [0, 2] });
  const done = project(fixtureRecipe('code_done'));
  editConfig(done, surfaces);
  await replay({ steps, dir: done, base, only: [2, steps.length] });
});

test('link_writes (H1, E1, E2): links, hard links, file-changing shell commands and removals of strays are judged on the real target', async () => {
  const dir = project(fixtureRecipe());
  mkdirSync(join(dir, '.agents/runs/LC/amendments'), { recursive: true }); mkdirSync(join(dir, '.agents/local/prompts'), { recursive: true });
  // the user's untracked work (quoted names too), there before the run's first hook event
  for (const n of ['user-wip.txt', 'wip-é.txt', 'wip\tt.txt']) writeFileSync(join(dir, n), 'x');
  symlinkSync('../../../local/prompts/f.json', join(dir, '.agents/runs/LC/amendments/f.json'));
  await replay({
    steps: corpus('link_writes'), dir, base,
    mutations: {
      2: () => {
        if (!existsSync(join(dir, '.agents/runs/LC/LEDGER.log')) || readFileSync(join(dir, '.agents/runs/LC/LEDGER.log')).length === 0) writeFileSync(join(dir, '.agents/runs/LC/LEDGER.log'), 'seq=1 epoch=1\n');
        // the baseline of the untracked files was taken by the first hook event, before the stray below exists
        const lines = readFileSync(join(dir, '.agents/local/baseline/LC'), 'utf8').split('\n');
        for (const n of ['user-wip.txt', 'wip-é.txt', 'wip\tt.txt']) assert.ok(lines.includes(n), `E1 the run's untracked baseline lacks ${JSON.stringify(n)}`);
        assert.ok(!lines.some((l) => l.includes('premium-audit')), 'E1 the stray is in the baseline');
        mkdirSync(join(dir, '.agents/runs/LC/scratch'), { recursive: true });
        writeFileSync(join(dir, 'premium-audit.json'), '{}'); appendFileSync(join(dir, 'user-wip.txt'), 'y');
        writeFileSync(join(dir, 'tracked.txt'), 'x'); git(dir, ['add', 'tracked.txt']);
        symlinkSync('../../../../impl.txt', join(dir, '.agents/runs/LC/scratch/cur'));
      },
      16: () => symlinkSync(join(dir, 'impl.txt'), join(base, 'out.txt')),
      17: () => { symlinkSync('../../../local', join(dir, '.agents/runs/LC/amendments/dl')); symlinkSync('../../nowhere', join(dir, '.agents/runs/LC/amendments/dangling')); },
      19: () => linkSync(join(dir, 'impl.txt'), join(dir, '.agents/runs/LC/amendments/h.md')),
    },
  });
  // put() is used by the knowledge corpus below
  void put;
});
